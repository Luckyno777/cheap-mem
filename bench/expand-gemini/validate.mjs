// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-gemini-cm): mechanical checks of the
// Gemini-written question file. Nothing in questions.jsonl is edited.
//   node bench/expand-gemini/validate.mjs [--json out.json]
// 1. every expected id exists in bench/expand-fair/notes.jsonl
// 2. decoys against the check-decoys definition (far: 0 content words shared
//    with the store, near: exactly 1); violators are listed and their line
//    numbers written out so the "clean" subset can be scored separately
// 3. word reuse: for every everyday/technical question, how many of its
//    content words appear literally in the target note, how many only in the
//    target's expansion (expansions.jsonl, committed before this file
//    existed). The same measure on the self-written set of expand-fair is
//    printed alongside for comparison.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeGroupsMulti, EXPAND_STOP } from '../../src/search.mjs';
import { pack } from '../../src/language.mjs';
import { overlap } from '../expand-fair/check-decoys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAIR = path.join(HERE, '..', 'expand-fair');
const jl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
export const loadQuestions = () => jl(path.join(HERE, 'questions.jsonl')).map((q, i) => ({
  line: i + 1, id: `gm-${String(i + 1).padStart(3, '0')}`, ...q,
  // Gemini left "expected" out on its decoy lines; read as [] (format note, not an edit)
  noExpectedField: !('expected' in q), expected: q.expected ?? [],
  src: q.expected?.[0]?.startsWith('g-') ? 'gold' : q.expected?.length ? 'filler' : null,
  de: Boolean(q.expected?.[0]?.startsWith('g-de-')),
}));
const tok = (t) => new Set(tokenizeGroupsMulti(String(t).split(/\s+/).filter((w) => !EXPAND_STOP.has(w.toLowerCase())).join(' '), { langs: [pack('en')] }).flat());
const notes = new Map(jl(path.join(FAIR, 'notes.jsonl')).map((n) => [n.id, n]));
const exps = new Map(jl(path.join(FAIR, 'expansions.jsonl')).map((e) => [e.id, e.asked_as]));

export function validate() {
  const qs = loadQuestions();
  const missing = qs.filter((q) => q.expected.some((id) => !notes.has(id)));
  const badShape = qs.filter((q) => (q.kind.startsWith('decoy') ? q.expected.length !== 0 : q.expected.length !== 1));
  const decoyBad = [];
  for (const q of qs.filter((x) => x.kind.startsWith('decoy'))) {
    const o = overlap(q.query);
    const ok = q.kind === 'decoy-far' ? o.length === 0 : o.length === 1;
    if (!ok) decoyBad.push({ line: q.line, kind: q.kind, shared: o, query: q.query });
  }
  const seen = new Map(); const dup = [];
  for (const q of qs) { const k = q.query.trim().toLowerCase(); if (seen.has(k)) dup.push([seen.get(k), q.line]); else seen.set(k, q.line); }
  const reuse = (list) => {
    const rows = {};
    for (const q of list) {
      const t = q.expected[0];
      const ow = tok(notes.get(t)?.text ?? ''); const ex = tok((exps.get(t) ?? []).join(' '));
      const key = `${q.kind}/${q.de ? 'de' : q.src}`;
      const r = rows[key] ?? (rows[key] = { questions: 0, words: 0, inNote: 0, expOnly: 0, noWordInNote: 0 });
      let hitNote = 0;
      for (const w of tok(q.query)) { r.words += 1; if (ow.has(w)) { r.inNote += 1; hitNote += 1; } else if (ex.has(w)) r.expOnly += 1; }
      r.questions += 1; if (!hitNote) r.noWordInNote += 1;
    }
    const all = { questions: 0, words: 0, inNote: 0, expOnly: 0, noWordInNote: 0 };
    // everyday + technical only (keyword questions copy the note on purpose)
    for (const [k0, r] of Object.entries(rows)) if (!k0.startsWith('keywords')) for (const k of Object.keys(all)) all[k] += r[k];
    rows['everyday+technical'] = all;
    for (const r of Object.values(rows)) { r.inNotePct = +(100 * r.inNote / r.words).toFixed(1); r.expOnlyPct = +(100 * r.expOnly / r.words).toFixed(1); }
    return rows;
  };
  const targets = qs.filter((q) => !q.kind.startsWith('decoy'));
  const distinct = new Set(targets.map((q) => q.expected[0]));
  return {
    counts: Object.fromEntries(['everyday', 'technical', 'decoy-far', 'decoy-near'].map((k) => [k, qs.filter((q) => q.kind === k).length])),
    missing: missing.map((q) => ({ line: q.line, expected: q.expected })),
    noExpectedField: qs.filter((q) => q.noExpectedField).map((q) => `${q.kind}:L${q.line}`).length, badShape: badShape.map((q) => q.line), duplicates: dup, decoyBad,
    distinctTargets: distinct.size, goldTargets: targets.filter((q) => q.src === 'gold').length, fillerTargets: targets.filter((q) => q.src === 'filler').length,
    germanTargets: targets.filter((q) => q.de).length,
    reuseGemini: reuse(targets.filter((q) => notes.has(q.expected[0]))),
    reuseSelfWritten: reuse(jl(path.join(FAIR, 'questions.jsonl')).map((q) => ({ ...q, de: q.expected[0].startsWith('g-de-') }))),
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const v = validate();
  const i = process.argv.indexOf('--json');
  if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(v, null, 1));
  console.log('counts', v.counts, 'distinct targets', v.distinctTargets, 'gold', v.goldTargets, 'filler', v.fillerTargets, 'german', v.germanTargets);
  console.log('missing expected ids:', v.missing.length, JSON.stringify(v.missing));
  console.log('lines without an expected field (read as []):', v.noExpectedField, 'bad shape:', v.badShape.length, 'duplicate queries:', JSON.stringify(v.duplicates));
  const far = v.decoyBad.filter((d) => d.kind === 'decoy-far'); const near = v.decoyBad.filter((d) => d.kind === 'decoy-near');
  console.log(`decoys breaking the definition: far ${far.length}/${v.counts['decoy-far']}, near ${near.length}/${v.counts['decoy-near']}`);
  for (const d of v.decoyBad) console.log(`  L${d.line} ${d.kind} shared=[${d.shared.join(',')}] ${d.query}`);
  for (const [name, rows] of [['Gemini', v.reuseGemini], ['self-written (expand-fair)', v.reuseSelfWritten]]) {
    console.log(`word reuse, ${name}:`);
    for (const [k, r] of Object.entries(rows)) console.log(`  ${k.padEnd(20)} q=${r.questions} words=${r.words} in target note ${r.inNotePct}% only in target expansion ${r.expOnlyPct}% questions with no note word ${r.noWordInNote}`);
  }
}
