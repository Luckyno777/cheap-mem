// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * variants — `mem find` with rewordings the CALLING agent supplies.
 *
 * **No model in the recall path.** The model is the caller (a session
 * that is a model anyway) and writes the variants itself; this module
 * only searches each wording on its own (the same `search()`, the same
 * options) and merges the hit lists by Reciprocal Rank Fusion
 * (`hybrid.rrf`). Deterministic: same input, same output.
 *
 * **Why this is not a duplicate.** `rewrites` (src/rewrites.mjs) LEARNS
 * word pairs from missed questions afterwards; H1 (src/questionsplit.mjs)
 * SPLITS one question into core words and by-catch. Neither takes
 * wordings from the caller - that is the gap (ported from the sibling
 * house, 2026-10-02).
 *
 * **Against noise.** At most {@link VARIANTS_MAX} variants, each at most
 * 300 characters; a variant that equals the question or another variant
 * after normalisation is dropped. The `score` of a merged hit stays the
 * highest REAL score it had in one of the searches - downstream bars
 * (the hook's minimum, the h3 answer gate) keep gating on a real search,
 * never on the fusion number.
 */
import { search } from './search.mjs';
import { rrf, RRF_K } from './hybrid.mjs';

export const VARIANTS_MAX = 4;
const VARIANT_MAX_CHARS = 300;

const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The usable variants: trimmed, cut, de-duplicated, at most VARIANTS_MAX. */
export function cleanVariants(variants, query) {
  const list = Array.isArray(variants) ? variants : [];
  const seen = new Set([norm(query)]);
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const t = v.replace(/\s+/g, ' ').trim().slice(0, VARIANT_MAX_CHARS);
    const n = norm(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= VARIANTS_MAX) break;
  }
  return out;
}

/** `--variants "a|b|c"` -> list (the CLI has no repeatable flag). */
export function variantsFromText(text) {
  return String(text ?? '').split('|').map((x) => x.trim()).filter(Boolean);
}

const keyOf = (h) => `${h.source}:${h.line}`;

/**
 * Like `search(index, query, opt)`, plus the hits of the variants.
 * Without variants it IS `search()` (same call, same result). Every hit
 * carries `foundBy` (`query` and/or `variant:<n>`) so the caller sees
 * WHERE a hit came from.
 */
export function searchWithVariants(index, query, variants, opt = {}) {
  const vs = cleanVariants(variants, query);
  if (!vs.length) return search(index, query, opt);
  const top = opt.top ?? 10;
  // Fetch each search a little wider: otherwise a hit of the question
  // pushes one of a variant out before the fusion ever sees it.
  const wide = { ...opt, top: Math.max(top * 2, top + 4) };
  const lists = [{ name: 'query', hits: search(index, query, wide) }];
  vs.forEach((v, i) => lists.push({ name: `variant:${i + 1}`, hits: search(index, v, wide) }));
  const fused = rrf(lists.map((l) => l.hits.map(keyOf)), { k: RRF_K });
  const byKey = new Map();
  for (const l of lists) {
    for (const h of l.hits) {
      const k = keyOf(h);
      const s = Number(h.score) || 0;
      const e = byKey.get(k);
      if (!e) byKey.set(k, { h: { ...h }, by: [l.name], best: s });
      else {
        e.by.push(l.name);
        if (s > e.best) e.best = s;
      }
    }
  }
  return [...byKey.entries()]
    .map(([k, e]) => ({ ...e.h, score: e.best, foundBy: e.by, fusion: fused.get(k) ?? 0 }))
    .sort((a, b) => b.fusion - a.fusion || b.score - a.score || keyOf(a).localeCompare(keyOf(b)))
    .slice(0, top);
}
