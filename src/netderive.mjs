// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * netderive — DERIVED links: pairs of entries that share rare evidence but
 * that nobody linked. The net (`net.mjs`) draws only declared links, and
 * stays that way: a derived link is a third kind, never a stored line,
 * never counted with the declared ones, drawn dashed in the atlas.
 *
 * Deterministic, no model, no write. Two kinds of evidence (port of the
 * sibling house's `vernetzung`, 2026-10-01):
 *
 *   file   both name the same file (a path in the text or in `file`/
 *          `files`). Strength = sum of the IDF of the shared files; a file
 *          in more than FILE_DF_MAX entries says nothing (README.md).
 *   terms  shared RARE words (the tokenizer of the search, document
 *          frequency <= RARE_DF), without words that carry a digit
 *          (timestamps, ids, hashes) and without path parts (`file` counts
 *          those). Strength = sum of the IDF of the shared words.
 *
 * Three tiers, the thresholds the sibling measured against its stored
 * links (2457 entries, 253 content links; random pair 0.0084 %):
 *
 *   auto        both kinds strong at once (11.6 % of such pairs carried a
 *               stored link, 1380x random) -> a dashed edge in the atlas.
 *   borderline  terms strong alone (5.8 %) -> LISTED for the human, never
 *               decided here (`mem net --derived`, the review panel).
 *   dropped     the rest (file alone: 0.65 %).
 *
 * The rates are a LOWER bound (an unlinked pair is unchecked, not wrong)
 * and were measured on the sibling's store, not on this one: here they
 * are an assumption until a store of this house has been measured.
 * Already linked pairs (any declared link, any direction) are skipped.
 */
import { tokenize } from './search.mjs';
import { linksOf } from './net.mjs';
import { BODY_FIELDS } from './bodyfields.mjs';

/** A word in more entries than this is not rare. */
export const RARE_DF = 6;
const FILE_DF_MAX = 12;
/** From this strength (sum of IDF) a kind of evidence is STRONG. */
export const STRONG = Object.freeze({ terms: 12, file: 5.5 });
/** At most this many borderline pairs are listed, strongest first. */
export const BORDERLINE_MAX = 60;
/** The drawers that carry content (not links, sources, timelines or building blocks). */
export const CONTENT_TYPES = Object.freeze(['decision', 'error', 'event', 'thought', 'learning', 'duty', 'question', 'skill', 'procedure', 'update']);
const FILE_FIELDS = ['file', 'files'];
// Longer extensions first, or `js` cuts `jsonl` short.
const FILE_RE = /(?:[\w.-]+\/)+[\w.-]+\.(?:test\.mjs|jsonl|json|mjs|cjs|html|yaml|yml|css|tsv|md|sh|ps1|js|ts|py)\b/g;

const list = (v) => (Array.isArray(v) ? v.flatMap(list) : typeof v === 'string' ? [v] : []);
const pairKey = (a, b) => (a < b ? `${a}\u001f${b}` : `${b}\u001f${a}`);

/** One entry's evidence: `{ id, ts, files:Set, words:Set }`. */
export function features(entry) {
  const text = BODY_FIELDS.flatMap((f) => list(entry[f])).join(' ');
  const files = new Set(text.match(FILE_RE) ?? []);
  for (const f of FILE_FIELDS) for (const w of list(entry[f])) for (const m of w.match(FILE_RE) ?? [w]) if (m.includes('.')) files.add(m);
  const words = new Set(tokenize(text.replace(FILE_RE, ' ')).filter((w) => w.length >= 3 && !/\d/.test(w)));
  return { id: entry.id, ts: String(entry.ts ?? ''), files, words };
}

/** Which rows go in: content drawers, held, not closing lines, not replaced. */
export function selectRows(rows) {
  const replaced = new Set();
  for (const { entry: e } of rows) if (e?.replaces_id) replaced.add(String(e.replaces_id));
  return rows.filter(({ drawer, entry: e, held }) => CONTENT_TYPES.includes(drawer) && held !== false
    && typeof e?.id === 'string' && !e.closes_id && !e.retires_id && !replaced.has(e.id));
}

function index(ms, field, dfMax, kind, pairs, N) {
  const byKey = new Map();
  for (const m of ms) for (const k of m[field]) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(m.id); }
  for (const [k, ids] of byKey) {
    if (ids.length < 2 || ids.length > dfMax) continue;
    const w = Math.log(N / ids.length);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = pairKey(ids[i], ids[j]);
      let p = pairs.get(key);
      if (!p) pairs.set(key, (p = { key, kinds: {} }));
      const e = (p.kinds[kind] ??= { strength: 0, evidence: [] });
      e.strength += w;
      e.evidence.push(k);
    }
  }
}

/** 'auto' | 'borderline' | 'dropped' for a pair's evidence. */
export function tierOf(kinds) {
  const strong = Object.keys(STRONG).filter((k) => kinds[k] && kinds[k].strength >= STRONG[k]);
  if (strong.length >= 2) return 'auto';
  if (strong.length === 1 && strong[0] === 'terms') return 'borderline';
  return 'dropped';
}

const WHAT = { terms: 'shared rare terms', file: 'same file' };
function reason(kinds) {
  return Object.keys(STRONG).filter((k) => kinds[k])
    .map((k) => `${kinds[k].strength >= STRONG[k] ? '' : '(side evidence) '}${WHAT[k]}: ${kinds[k].evidence.slice().sort().slice(0, 4).join(', ')}`)
    .join('; ');
}

/**
 * Derived links over `rows` (`[{ project, drawer, entry, held }]`, the
 * dashboard's one pass). Pure and deterministic. Returns
 * `{ entries, auto: [...], borderline: [...], borderlineTotal, dropped, linked }`;
 * each link `{ from, to, kind: 'derived', tier, reason, strength }`, from
 * the younger entry to the older (as a learning points at its error).
 */
export function derive(rows) {
  const chosen = selectRows(rows);
  const ms = chosen.map(({ entry }) => features(entry));
  const N = ms.length;
  const out = { entries: N, auto: [], borderline: [], borderlineTotal: 0, dropped: 0, linked: 0 };
  if (N < 2) return out;
  const pairs = new Map();
  index(ms, 'files', FILE_DF_MAX, 'file', pairs, N);
  index(ms, 'words', RARE_DF, 'terms', pairs, N);
  const linked = new Set();
  for (const { entry } of rows) for (const l of linksOf(entry)) linked.add(pairKey(l.from, l.to));
  const ts = new Map(ms.map((m) => [m.id, m.ts]));
  const border = [];
  for (const p of [...pairs.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (linked.has(p.key)) { out.linked += 1; continue; }
    const tier = tierOf(p.kinds);
    if (tier === 'dropped') { out.dropped += 1; continue; }
    const [a, b] = p.key.split('\u001f');
    const [from, to] = ts.get(a) >= ts.get(b) ? [a, b] : [b, a];
    const strength = Math.round(Object.values(p.kinds).reduce((s, k) => s + Math.min(k.strength, 30), 0) * 100) / 100;
    const link = { from, to, kind: 'derived', tier, reason: reason(p.kinds), strength };
    if (tier === 'auto') out.auto.push(link); else border.push(link);
  }
  border.sort((x, y) => y.strength - x.strength || (x.from + x.to < y.from + y.to ? -1 : 1));
  out.borderlineTotal = border.length;
  out.borderline = border.slice(0, BORDERLINE_MAX);
  return out;
}

/** Text for `mem net --derived`: the review list, the human decides. */
export function asText(d, titleOf = (id) => id) {
  const z = [`Derived links over ${d.entries} entries (guesses from shared evidence, drawn dashed; not stored, not decided here):`,
    `  auto ${d.auto.length} · borderline ${d.borderlineTotal}${d.borderlineTotal > d.borderline.length ? ` (${d.borderline.length} listed)` : ''} · dropped ${d.dropped} · already linked ${d.linked}`];
  for (const [head, rows] of [['Auto (both kinds strong)', d.auto], ['Borderline — for you to judge', d.borderline]]) {
    if (!rows.length) continue;
    z.push('', head + ':');
    for (const l of rows) z.push(`  ${l.from} -> ${l.to}  ${titleOf(l.from)} -> ${titleOf(l.to)}`, `      ${l.reason}`);
  }
  return z.join('\n');
}
