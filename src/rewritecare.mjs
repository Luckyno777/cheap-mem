// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * rewritecare — WRITE SIDE of the rewrite table (src/rewrites.mjs).
 * Deterministic, no model, never on the recall path: it runs only when
 * someone calls `mem rewrites care`. Port of lucky-mem's
 * `src/umschreibpflege.mjs`.
 *
 * **Where the evidence comes from — only from cases the house already
 * vets.** `mem asked-learn` (src/askedlearn.mjs, M18b) finds a miss
 * the SAME session then resolved by naming an entry by id, and only if
 * the memory had NOT shown that entry itself (the latch against
 * self-reinforcement stays there). For each learned question word `a`
 * and each characteristic stem `b` of the fetched entry a pair `a -> b`
 * is formed. lucky-mem has a second source (a missed question followed
 * within two minutes by a question that hit); cheap-mem's journal does
 * not record that pairing yet, so it is not ported — one source, not a
 * guessed second one.
 *
 * Both need the session's raw capture; without it there is no evidence
 * ("rather nothing than something wrong"). Question text never leaves
 * this file — only stems, session ids, timestamps and places.
 *
 * **Merging.** New evidence is UNITED with what is stored (sessions,
 * places), so a pair does not lose what the journal has since archived.
 * A line is appended only when something changed; no line is rewritten.
 */
import * as search from './search.mjs';
import * as rewrites from './rewrites.mjs';
import * as askedlearn from './askedlearn.mjs';
import { editDistance } from './switches.mjs';
import { pack } from './language.mjs';

/** How many characteristic stems of a fetched entry each question word points at. */
export const TARGETS_PER_ENTRY = 2;

/** At most this many evidence places per pair stay on the line (the newest). */
const EVIDENCE_MAX = 20;

/** Only stems as the tokenizer emits them — never free text. */
const validStem = (w) => typeof w === 'string' && /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/.test(w);

/**
 * A stemmer split, not a rewrite: one contains the other, two edits
 * apart, or the typed word and the target share all but one letter of
 * the shorter one as a prefix. The last rule catches what the stemmer
 * itself bends out of shape: `pays` stems to `pai`, which neither
 * contains `payment` nor lies two edits from it.
 */
function morphological(a, b, typed = a) {
  if (a.includes(b) || b.includes(a) || editDistance(a, b) <= 2) return true;
  let p = 0;
  while (p < typed.length && p < b.length && typed[p] === b[p]) p += 1;
  return p >= 3 && p >= Math.min(typed.length, b.length) - 1;
}

/**
 * The characteristic stems of an entry: field weight times rarity
 * (idf), the top {@link TARGETS_PER_ENTRY}. These are the words the
 * entry itself is found by — that is what a question word should point at.
 */
export function entryStems(index, doc, { max = TARGETS_PER_ENTRY } = {}) {
  if (!doc?.weights) return [];
  const n = index.statsN ?? index.N ?? 1;
  const df = index.statsDocFreq ?? index.docFreq;
  const list = [];
  for (const [t, g] of doc.weights) {
    if (!validStem(t) || t.length < 4) continue;
    const d = df?.get?.(t) ?? 1;
    list.push({ t, value: g * Math.log(1 + n / Math.max(1, d)) });
  }
  list.sort((x, y) => y.value - x.value || x.t.localeCompare(y.t));
  return list.slice(0, max).map((x) => x.t);
}

const newPair = (from, to) => ({ from, to, sessions: new Set(), evidence: [], last: null });

function take(map, from, to) {
  const k = `${from}\u0000${to}`;
  if (!map.has(k)) map.set(k, newPair(from, to));
  return map.get(k);
}

/**
 * asked-learn cases -> pairs. Pure: needs only the index. The question
 * word is stemmed the way search stems the typed word (English pack,
 * like the thesaurus leg), so the table key is what search looks up.
 */
export function pairsFromCases(index, list) {
  const map = new Map();
  const en = pack('en');
  const byId = new Map();
  for (const d of index.documents ?? []) if (d?.entry?.id && d.type !== 'raw' && !d.retired) byId.set(d.entry.id, d);
  for (const c of list) {
    const doc = byId.get(c.entry?.id);
    if (!doc) continue;
    const targets = entryStems(index, doc);
    for (const w of c.words ?? []) {
      const from = search.tokenizeGroupsMulti(w, { langs: [en] }).flat()[0];
      if (!validStem(from)) continue;
      for (const to of targets) {
        if (from === to || morphological(from, to, String(w).toLowerCase())) continue;
        const p = take(map, from, to);
        p.sessions.add(c.session);
        const ts = String(c.use?.ts ?? c.ts ?? '');
        if (!p.last || ts > p.last) p.last = ts;
        if (!p.evidence.some((x) => x.place === c.journal)) {
          p.evidence.push({ kind: 'asked-learn', place: c.journal, entry: c.entry.id, ts });
        }
      }
    }
  }
  return map;
}

/** Unite pair maps (sessions, evidence, newest evidence). */
function unite(...maps) {
  const out = new Map();
  for (const m of maps) {
    for (const e of m.values()) {
      const r = take(out, e.from, e.to);
      for (const s of e.sessions) r.sessions.add(s);
      for (const b of e.evidence) if (!r.evidence.some((x) => x.kind === b.kind && x.place === b.place)) r.evidence.push(b);
      if (e.last && (!r.last || e.last > r.last)) r.last = e.last;
    }
  }
  return out;
}

/** What is stored, as a pair map (lock state stays in the file). */
function stored(root) {
  const map = new Map();
  for (const e of rewrites.folded(root).values()) {
    if (!e.sessions.length && !e.evidence.length) continue;
    const p = take(map, e.from, e.to);
    for (const s of e.sessions) p.sessions.add(s);
    p.evidence = [...e.evidence];
    p.last = e.last;
  }
  return map;
}

/**
 * Collect evidence and (with `write`) append every changed pair as a
 * `pair` line carrying the union of stored and new evidence. Returns
 * `{ counts, changed, fresh, written }`; `counts` is asked-learn's
 * denominator, so "0 pairs" reads as a measurement, not as silence.
 */
export function care(root, { index = null, write = false, now = new Date(), cases = null } = {}) {
  const idx = index ?? search.loadIndex(root);
  const found = cases ? { cases, counts: null } : askedlearn.cases(root, { index: idx });
  const old = stored(root);
  const merged = unite(old, pairsFromCases(idx, found.cases));
  const changes = [];
  for (const [k, e] of merged) {
    const v = old.get(k);
    const same = v && v.sessions.size === e.sessions.size && v.last === e.last && v.evidence.length === e.evidence.length;
    if (!same) changes.push({ fresh: !v, e });
  }
  changes.sort((x, y) => x.e.from.localeCompare(y.e.from) || x.e.to.localeCompare(y.e.to));
  if (write) {
    for (const { e } of changes) {
      const evidence = [...e.evidence].sort((x, y) => String(x.ts).localeCompare(String(y.ts))).slice(-EVIDENCE_MAX);
      rewrites.append(root, {
        kind: 'pair', ts: now.toISOString(), from: e.from, to: e.to,
        sessions: [...e.sessions].sort(), evidence, last: e.last,
      });
    }
  }
  return {
    counts: found.counts,
    changed: changes.length,
    fresh: changes.filter((x) => x.fresh).length,
    written: write ? changes.length : 0,
    pairs: changes.map(({ fresh, e }) => ({ from: e.from, to: e.to, sessions: e.sessions.size, fresh })),
  };
}
