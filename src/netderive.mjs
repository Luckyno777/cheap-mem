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
const STRONG = Object.freeze({ terms: 12, file: 5.5 });
/** At most this many borderline pairs are listed, strongest first. */
const BORDERLINE_MAX = 60;
/** The drawers that carry content (not links, sources, timelines or building blocks). */
const CONTENT_TYPES = Object.freeze(['decision', 'error', 'event', 'thought', 'learning', 'duty', 'question', 'skill', 'procedure', 'update']);
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

/** Is this row one that goes in: content drawer, held, with an id, not a closing line, not replaced. */
function chosenRow({ drawer, entry: e, held }, replaced) {
  return CONTENT_TYPES.includes(drawer) && held !== false
    && typeof e?.id === 'string' && !e.closes_id && !e.retires_id && !replaced.has(e.id);
}

// --- Bounded memory ------------------------------------------------------
// The first version held every entry's feature object (two Sets), every
// index list and every pair with its evidence: ~10 KiB per entry. Now
// `derive` makes several passes over a REPEATABLE row source (an array or
// any object with `[Symbol.iterator]`, re-read per pass) and keeps only:
//   - an id -> number table (the one thing that stays linear with ids),
//   - word/file indexes whose lists stop at the document-frequency cap
//     (a word in more entries than the cap says nothing and costs no list),
//   - the pairs in typed arrays (key, strength per kind, bit mask),
//   - evidence words and timestamps only for pairs that are not dropped.
// The result is the same JSON as before, byte for byte.

const TOP = -1; // marker: the cap is broken (a singleton is >= 0)
const SHIFT = 2 ** 26; // ids < 67 M: lo * 2^26 + hi stays below 2^53
const M_FILE = 1; const M_TERMS = 2; const M_LINKED = 4;

function take(map, key, idx, max) {
  const v = map.get(key);
  if (v === undefined) { map.set(key, idx); return; }
  if (v === TOP) return;
  if (typeof v === 'number') { if (max < 2) map.set(key, TOP); else map.set(key, [v, idx]); return; }
  if (v.length >= max) map.set(key, TOP); else v.push(idx);
}

class PairTable {
  constructor() { this.n = 0; this.#alloc(1 << 15); }
  #alloc(cap) {
    this.cap = cap; this.mask = cap - 1;
    this.key = new Float64Array(cap).fill(-1);
    this.file = new Float64Array(cap);
    this.terms = new Float64Array(cap);
    this.flags = new Uint8Array(cap);
  }
  static hash(lo, hi) { return (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi + 0x7F4A7C15, 0x85EBCA6B)) >>> 0; }
  /** Slot of the pair (a, b), or -1 when `create` is false and it is absent. */
  find(a, b, create) {
    const lo = a < b ? a : b; const hi = a < b ? b : a;
    const k = lo * SHIFT + hi;
    let i = PairTable.hash(lo, hi) & this.mask;
    for (;;) {
      const cur = this.key[i];
      if (cur === k) return i;
      if (cur === -1) {
        if (!create) return -1;
        if ((this.n + 1) * 2 > this.cap) { this.#grow(); return this.find(a, b, true); }
        this.key[i] = k; this.n += 1; return i;
      }
      i = (i + 1) & this.mask;
    }
  }
  #grow() {
    const { key, file, terms, flags, cap } = this;
    this.#alloc(cap * 2); this.n = 0;
    for (let s = 0; s < cap; s++) {
      if (key[s] === -1) continue;
      const lo = Math.floor(key[s] / SHIFT); const hi = key[s] - lo * SHIFT;
      const i = this.find(lo, hi, true);
      this.file[i] = file[s]; this.terms[i] = terms[s]; this.flags[i] = flags[s];
    }
  }
  static parts(k) { const lo = Math.floor(k / SHIFT); return [lo, k - lo * SHIFT]; }
}

function strongOf(t, s) {
  const f = (t.flags[s] & M_FILE) && t.file[s] >= STRONG.file;
  const w = (t.flags[s] & M_TERMS) && t.terms[s] >= STRONG.terms;
  return f && w ? 'auto' : w ? 'borderline' : 'dropped';
}

/** Pairs of every index list (2..cap entries), in index order — the order the sums are made in. */
function eachPair(indexMap, fn) {
  for (const [k, ids] of indexMap) {
    if (!Array.isArray(ids)) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) fn(k, ids, ids[i], ids[j]);
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
 * dashboard's one pass; an array, or any repeatable iterable that is read
 * again for each pass). Pure and deterministic. Returns
 * `{ entries, auto: [...], borderline: [...], borderlineTotal, dropped, linked }`;
 * each link `{ from, to, kind: 'derived', tier, reason, strength }`, from
 * the younger entry to the older (as a learning points at its error).
 */
export function derive(rows) {
  if (rows && typeof rows[Symbol.iterator] === 'function' && rows[Symbol.iterator]() === rows) rows = Array.from(rows);
  // Pass 1: which ids are replaced.
  const replaced = new Set();
  for (const { entry: e } of rows) if (e?.replaces_id) replaced.add(String(e.replaces_id));
  // Pass 2: ids as numbers, the two indexes (the feature object is dropped at once).
  const idNum = new Map(); const idList = [];
  const fileIdx = new Map(); const wordIdx = new Map();
  let N = 0;
  for (const r of rows) {
    if (!chosenRow(r, replaced)) continue;
    const m = features(r.entry);
    let num = idNum.get(m.id);
    if (num === undefined) { num = idList.length; idNum.set(m.id, num); idList.push(m.id); }
    N += 1;
    for (const f of m.files) take(fileIdx, f, num, FILE_DF_MAX);
    for (const w of m.words) take(wordIdx, w, num, RARE_DF);
  }
  const out = { entries: N, auto: [], borderline: [], borderlineTotal: 0, dropped: 0, linked: 0 };
  if (N < 2) return out;
  if (idList.length >= SHIFT) throw new Error(`netderive: more than ${SHIFT} distinct ids`);
  // Pair table: strength per kind, summed in the order the lists were built.
  const t = new PairTable();
  eachPair(fileIdx, (k, ids, a, b) => { const s = t.find(a, b, true); t.file[s] += Math.log(N / ids.length); t.flags[s] |= M_FILE; });
  eachPair(wordIdx, (k, ids, a, b) => { const s = t.find(a, b, true); t.terms[s] += Math.log(N / ids.length); t.flags[s] |= M_TERMS; });
  // Entries that sit in a pair that is not dropped need a timestamp.
  const wanted = new Uint8Array(idList.length);
  for (let s = 0; s < t.cap; s++) {
    if (t.key[s] === -1 || strongOf(t, s) === 'dropped') continue;
    const [lo, hi] = PairTable.parts(t.key[s]); wanted[lo] = 1; wanted[hi] = 1;
  }
  // Pass 3: declared links (any row, any direction) and the timestamps (last row of an id wins).
  const tsOf = new Map();
  for (const r of rows) {
    for (const l of linksOf(r.entry)) {
      const a = idNum.get(l.from); const b = idNum.get(l.to);
      if (a === undefined || b === undefined) continue;
      const s = t.find(a, b, false);
      if (s >= 0) t.flags[s] |= M_LINKED;
    }
    if (chosenRow(r, replaced)) { const num = idNum.get(r.entry.id); if (wanted[num]) tsOf.set(num, String(r.entry.ts ?? '')); }
  }
  // Candidates: not linked, not dropped. The rest is only counted.
  const cand = [];
  for (let s = 0; s < t.cap; s++) {
    if (t.key[s] === -1) continue;
    if (t.flags[s] & M_LINKED) { out.linked += 1; continue; }
    const tier = strongOf(t, s);
    if (tier === 'dropped') { out.dropped += 1; continue; }
    const [lo, hi] = PairTable.parts(t.key[s]);
    cand.push({ slot: s, tier, key: pairKey(idList[lo], idList[hi]) });
  }
  // Evidence words, only for candidates.
  const ev = new Map(); // slot -> { file: [], terms: [] }
  for (const c of cand) ev.set(c.slot, { file: [], terms: [] });
  const gather = (idx, kind) => eachPair(idx, (k, ids, a, b) => { const e = ev.get(t.find(a, b, false)); if (e) e[kind].push(k); });
  gather(fileIdx, 'file'); gather(wordIdx, 'terms');
  const border = [];
  for (const c of cand.sort((x, y) => (x.key < y.key ? -1 : 1))) {
    const [a, b] = c.key.split('\u001f');
    const [from, to] = tsOf.get(idNum.get(a)) >= tsOf.get(idNum.get(b)) ? [a, b] : [b, a];
    const kinds = {};
    if (t.flags[c.slot] & M_FILE) kinds.file = { strength: t.file[c.slot], evidence: ev.get(c.slot).file };
    if (t.flags[c.slot] & M_TERMS) kinds.terms = { strength: t.terms[c.slot], evidence: ev.get(c.slot).terms };
    const strength = Math.round(Object.values(kinds).reduce((s, k) => s + Math.min(k.strength, 30), 0) * 100) / 100;
    const link = { from, to, kind: 'derived', tier: c.tier, reason: reason(kinds), strength };
    if (c.tier === 'auto') out.auto.push(link); else border.push(link);
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
