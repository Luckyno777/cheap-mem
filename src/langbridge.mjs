// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * langbridge — optional starter dictionaries from the language a person
 * ASKS in to the language the memory is WRITTEN in.
 *
 * **The gap.** cheap-mem's entries are mostly written by agents, and
 * agents write English. The person asking may not: a German or Spanish
 * question against an English memory shares almost no word with the
 * entry it wants. Measured 2026-09-27 on the retrieval bench corpus
 * (bench/lang-bridge.mjs): 14 German questions found their entry in the
 * top 3 in 3 cases, 14 Spanish questions in 1.
 *
 * **The main road is NOT this file.** It is the learned query words in
 * src/askedlearn.mjs: words taken from a real missed question and
 * appended to the entry the session then went and fetched by id. That
 * works for every language pair without anyone writing a dictionary,
 * because the bridge is built out of the user's own questions. This
 * module is the optional head start for the first days, before any
 * miss has been learned from.
 *
 * **What it is, in four rules** (ported from lucky-mem M18, where the
 * same shape moved English questions against a German corpus from 4/14
 * to 9/14 in the top 3 with German questions and precision unchanged):
 *
 *   1. A FILE, not code: `src/langbridge/<asked>-<written>.tsv`, one
 *      line per concept, every line naming its evidence. A user may add
 *      `.mem/langbridge/<asked>-<written>.tsv` for their own terms.
 *   2. OFF by default. `.mem/config.json` → `"languageBridges":
 *      ["de-en"]` switches a pair on. A memory that never asks for one
 *      searches exactly as before.
 *   3. ONE direction: asked language → written language. The reverse
 *      (an English word pulling in German entries) was measured in
 *      lucky-mem and rejected: the bridged words are the corpus's most
 *      common ones, so the reverse direction only diluted.
 *   4. WEAKER than the original: {@link BRIDGE_WEIGHT} 0.8 against 1.0
 *      for a typed word, above the thesaurus's 0.6 — a thesaurus word
 *      stands next to an original that may match on its own; a bridged
 *      word is the only carrier its typed word has in the corpus.
 *
 * A line whose written side is `-` is a query-only stop word of the
 * asked language ("dónde", "warum"): dropped from the question, never
 * from the index. Without it a Spanish question — no language pack, no
 * stop list — spends its coverage on "por", "la" and "el".
 */
import fs from 'node:fs';
import path from 'node:path';
import { pack } from './language.mjs';

/** Where the shipped dictionaries live. */
export const BRIDGE_DIR = new URL('./langbridge/', import.meta.url);

/** Where a memory keeps its own additions. */
export const USER_BRIDGE_DIR = path.join('.mem', 'langbridge');

/** The config key that switches pairs on. */
export const CONFIG_KEY = 'languageBridges';

/**
 * Weight of a bridged term in the query. Taken over from lucky-mem M18,
 * where it sat mid-plateau (0.7-1.0 equal, 0.5 and below lost). Swept
 * here with bench/lang-bridge.mjs on 2026-09-27: 0.5 to 1.0 give the
 * same top 3 in every arm (top 1 of learned+bridge es-en 10 below 0.9,
 * 11 at 0.9/1.0) — flat on this corpus, so the measured house value
 * stays, under the typed word on purpose.
 */
export const BRIDGE_WEIGHT = 0.8;

/** Marker in the written column for a query-only stop word. */
export const STOP_MARK = '-';

const PAIR = /^([a-z]{2,3})-([a-z]{2,3})$/;

/** Split a question into the same raw words the tokenizer sees. */
export function rawWords(text) {
  return String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

/**
 * The lookup key of an asked-language word: lower case, the language's
 * own normalisation, accents stripped, and — where the language has a
 * stemmer — stemmed. A language without a pack gets no stemming, so its
 * file lists the forms it wants matched (`pago,pagos`).
 */
export function askedKey(word, lang) {
  const p = pack(lang);
  const n = p.normalize(String(word).toLowerCase()).normalize('NFD').replace(/\p{M}+/gu, '');
  return p.stem(n);
}

/** The index term of a written-language word. */
export function writtenTerm(word, lang) {
  const p = pack(lang);
  return p.stem(p.normalize(String(word).toLowerCase()));
}

/** TSV text → rows `{ asked: [...], written: [...] | null, evidence, line }`. */
export function parseBridge(text) {
  const out = [];
  String(text ?? '').split('\n').forEach((rawLine, i) => {
    const l = rawLine.trim();
    if (!l || l.startsWith('#')) return;
    const [a, w, evidence] = rawLine.split('\t');
    const forms = (s) => String(s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const written = String(w ?? '').trim() === STOP_MARK ? null : forms(w);
    out.push({ asked: forms(a), written, evidence: String(evidence ?? '').trim(), line: i + 1 });
  });
  return out;
}

/**
 * Rows of ONE pair → `{ from, to, map: Map(askedKey → Set(term)), stop: Set(askedKey) }`.
 */
export function buildBridge(rows, pair) {
  const m = PAIR.exec(String(pair));
  if (!m) throw new Error(`language bridge '${pair}' is not <asked>-<written>, e.g. de-en`);
  const [, from, to] = m;
  const map = new Map();
  const stop = new Set();
  for (const r of rows) {
    const keys = r.asked.map((w) => askedKey(w, from));
    if (r.written === null) { for (const k of keys) stop.add(k); continue; }
    const terms = r.written.map((w) => writtenTerm(w, to));
    for (const k of keys) {
      if (!map.has(k)) map.set(k, new Set());
      for (const t of terms) if (t !== k) map.get(k).add(t);
    }
  }
  return { pair, from, to, map, stop };
}

/**
 * The switched-on pairs of a memory, or `null` when none is. Missing,
 * unreadable or broken config reads as "none" — this is an optional
 * boost, and a search must never fail over it. An UNKNOWN pair name,
 * however, throws: a typo in the config that silently switched nothing
 * on would look exactly like a bridge that does not help.
 */
export function loadBridges(root, { pairs = null } = {}) {
  let wanted = pairs;
  if (!wanted) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, '.mem', 'config.json'), 'utf8'));
      wanted = cfg?.[CONFIG_KEY];
    } catch { return null; }
  }
  if (!Array.isArray(wanted) || !wanted.length) return null;
  const bridges = [];
  for (const pair of wanted) {
    const shipped = new URL(`${pair}.tsv`, BRIDGE_DIR);
    const own = root ? path.join(root, USER_BRIDGE_DIR, `${pair}.tsv`) : null;
    let text = '';
    let found = false;
    try { text += fs.readFileSync(shipped, 'utf8') + '\n'; found = true; } catch { /* not shipped */ }
    try { if (own) { text += fs.readFileSync(own, 'utf8'); found = true; } } catch { /* none of its own */ }
    if (!found) {
      throw new Error(`language bridge '${pair}' named in .mem/config.json ${CONFIG_KEY} has no file `
        + `(looked in src/langbridge/ and ${USER_BRIDGE_DIR}/)`);
    }
    bridges.push(buildBridge(parseBridge(text), pair));
  }
  return bridges;
}

/** Is this raw word a query-only stop word of any switched-on pair? */
export function isQueryStop(bridges, word) {
  if (!bridges) return false;
  return bridges.some((b) => b.stop.has(askedKey(word, b.from)));
}

/** The written-language index terms for one typed word (may be empty). */
export function lookup(bridges, word) {
  if (!bridges) return [];
  const out = new Set();
  for (const b of bridges) for (const t of b.map.get(askedKey(word, b.from)) ?? []) out.add(t);
  return [...out];
}

/**
 * The question without the switched-on pairs' query stop words. When
 * every word is one, the question stays as typed — a vague search beats
 * none.
 */
export function stripQueryStops(bridges, query) {
  if (!bridges || typeof query !== 'string') return query;
  const words = query.split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !rawWords(w).every((x) => isQueryStop(bridges, x)));
  return kept.length ? kept.join(' ') : query;
}
