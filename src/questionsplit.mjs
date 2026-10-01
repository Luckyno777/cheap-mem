// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * questionsplit — the query-side lever of Block H (h1), ported from
 * lucky-mem (`src/suchhebel.mjs`). The switch, h2, h3 and h5 live in
 * `src/searchlevers.mjs`, which stays light for the recall hook; this one
 * needs the search module itself (document frequencies, tokenizer).
 */
import * as search from './search.mjs';
import * as entity from './entity.mjs';

// --- H1: split the question -----------------------------------------------
//
// **Why this moves the score although BM25 already weights rare words
// higher.** Coverage (`search()`, the coordination factor) counts EVERY
// typed word the same: a hit that lacks an everyday word ("one",
// "because") loses as much as one that lacks the technical term. The
// common words therefore go in as damped extra terms (`extraTerms`): they
// still add to the score, but they do not count in coverage.

/** A word is a core word when at most this share of the corpus carries it. */
export const CORE_DF_SHARE = 0.01;
/** Floor, so a small memory (40 entries) does not make every word common. */
export const CORE_DF_MIN = 3;
/** Weight of a by-catch word against a typed word (1.0). */
export const BYCATCH_WEIGHT = 0.3;
/** Core words per question, the same cap as `retrievalQuery()`. */
export const CORE_MAX = search.RETRIEVE_WORDS_MAX;

function dfOf(index) {
  return index?.statsDocFreq ?? index?.docFreq ?? null;
}

/** Smallest document frequency over the tokens of one word (0 = unknown). */
function rarity(df, word) {
  let lowest = Infinity;
  for (const t of search.tokenize(word)) lowest = Math.min(lowest, df.get(t) ?? 0);
  return Number.isFinite(lowest) ? lowest : 0;
}

const PROJECTS = new WeakMap();
/** The project names the index knows (lower case), once per index. */
export function projectNames(index) {
  if (!index || typeof index !== 'object') return [];
  if (PROJECTS.has(index)) return PROJECTS.get(index);
  const names = new Set();
  for (const d of index.documents ?? []) {
    const p = d?.project;
    if (typeof p === 'string' && p) names.add(p.toLowerCase());
  }
  const list = [...names];
  PROJECTS.set(index, list);
  return list;
}

function plainWords(text) {
  return String(text ?? '').toLowerCase()
    .replace(/\u00e4/g, 'ae').replace(/\u00f6/g, 'oe').replace(/\u00fc/g, 'ue').replace(/\u00df/g, 'ss')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The question in its parts.
 *
 * - `marks`     machine-shaped identifiers (paths, versions, ...), verbatim
 * - `projects`  words that name a project the memory knows — also when
 *               spoken ("cheap mem" names `cheap-mem`)
 * - `core`      content words in at most {@link CORE_DF_SHARE} of the
 *               corpus, rarest first, capped
 * - `unknown`   content words the corpus does not carry at all
 * - `bycatch`   everything else: common content words, filler, short words
 *
 * **One difference from the sibling house.** lucky-mem drops filler and
 * short words from the question entirely. Here they go to the by-catch:
 * "two" in "billed two times" or "csv" in "csv import" is a short word
 * the old path searched, and dropping it lost a hit on the value report's
 * gold set (measured while porting). "Never search less than before."
 *
 * `null` without an index — then the old path holds.
 */
export function splitQuestion(question, index, { projects = null } = {}) {
  const df = dfOf(index);
  const n = index?.statsN ?? index?.N;
  if (!df || !n) return null;
  const text = String(question ?? '');
  const marks = [...entity.identifiers(text)];
  const fromMarks = new Set();
  for (const m of marks) for (const t of m.split(/[^\p{L}\p{N}]+/u)) if (t) fromMarks.add(t);

  const known = projects ?? projectNames(index);
  const flat = ` ${plainWords(text).join(' ')} `;
  const named = new Set();
  for (const p of known) {
    const name = String(p).toLowerCase();
    const seq = plainWords(name).join(' ');
    if (!seq) continue;
    if (seq === name) named.add(name);
    else if (flat.includes(` ${seq} `)) for (const t of seq.split(' ')) named.add(t);
  }

  const content = new Set(search.contentWords(text));
  const words = [...new Set(plainWords(text))].filter((w) => !fromMarks.has(w));
  const bar = Math.max(CORE_DF_MIN, Math.floor(CORE_DF_SHARE * n));
  const projectsHit = [];
  const core = [];
  const unknown = [];
  const bycatch = [];
  for (const w of words) {
    if (named.has(w)) { projectsHit.push(w); continue; }
    if (!content.has(w)) { bycatch.push(w); continue; }
    // df 0: the word is nowhere in the memory (an inflection, a typo, a
    // word from elsewhere). It stays in the query — it lowers coverage
    // for everybody alike and so says the question holds something new —
    // but it is NOT a core word: alone it would let the search run dry.
    const d = rarity(df, w);
    if (d === 0) unknown.push(w);
    else (d <= bar ? core : bycatch).push(w);
  }
  core.sort((a, b) => rarity(df, a) - rarity(df, b));
  const room = Math.max(0, CORE_MAX - marks.length - projectsHit.length);
  for (const w of core.splice(room)) bycatch.push(w);
  return { marks, projects: projectsHit, core, unknown, bycatch };
}

/**
 * The query `search()` gets: `{ query, extraTerms, split }`, or `null`
 * for "not like this" (no index; no mark, no project and no core word —
 * a question of nothing but everyday words, "go on"). The caller then
 * keeps the question as it was, so never less is searched than before.
 */
export function buildQuery(question, index, opt = {}) {
  const z = splitQuestion(question, index, opt);
  if (!z) return null;
  if (!z.marks.length && !z.projects.length && !z.core.length) return null;
  const query = [...z.marks, ...z.projects, ...z.core, ...z.unknown].join(' ');
  const extraTerms = new Map();
  for (const w of z.bycatch) {
    for (const t of search.tokenize(w)) {
      if ((extraTerms.get(t) ?? 0) < BYCATCH_WEIGHT) extraTerms.set(t, BYCATCH_WEIGHT);
    }
  }
  return { query, extraTerms: extraTerms.size ? extraTerms : null, split: z };
}
