// Code symbols an entry names, and finding them again.
//
// **The measured finding (2026-09-09).** An entry was always allowed to
// carry a `symbols` field — free fields are accepted — and `--literal`
// found it. Ranked search did not:
//
//     symbol in the TITLE          1 hit    (ordinary BM25 tokens)
//     symbol only in `symbols`     0 hits
//     the same, with --literal     1 hit
//
// Two causes, both measured rather than reasoned about:
//
//  1. `symbols` had no entry in FIELD_WEIGHTS, so BM25 never saw it.
//  2. None of the five identifier patterns recognised a dotted name.
//     `bezeichner("… TokenStore.write …")` returned an EMPTY set. The
//     exact lane — the lane built for precisely this kind of question —
//     was blind to code symbols.
//
// Stored, and reachable only by a detour. `built-but-out-of-reach`.
//
// **Sabotage showed that EITHER fix alone repairs the reported
// symptom** — with only the field weight, BM25 finds it; with only the
// pattern, the exact lane does. Both were built anyway, and for
// different reasons: the weight because a field somebody fills in
// should be searchable as text, the pattern because a dotted symbol
// should match exactly WHEREVER it stands — in a title, in a body, in
// a raw capture — not only in the one field that now has a weight.
//
// **What the new pattern costs, measured on 1153 real entries:**
// 7469 identifiers before, 8610 after (+15.3 %), 488 distinct new ones,
// 416 of them (85 %) occurring in at most three entries — those are the
// ones that actually identify. The frequent ones (`fehler.jsonl`,
// `settings.json`) are removed by the existing `platz` bound, which is
// why the pattern did not need a stop list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as entity from '../src/entity.mjs';
import * as search from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sym-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const run = (r, ...a) =>
  spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });

test('THE CASE: a symbol only in `symbols` is found by ranked search', () => {
  // The exact probe that returned "Nothing for …" before.
  const r = memory();
  try {
    run(r, 'log', 'error', '--title', 'an error whose title never names it',
      '--class', 'concurrency', '--symbols', 'TokenStore.write');
    run(r, 'log', 'decision', '--topic', 'unrelated', '--choice', 'a', '--why', 'b');
    const out = run(r, 'find', 'TokenStore.write').stdout;
    assert.match(out, /1 hits/, `still not found:\n${out}`);
    assert.ok(!/Nothing for/.test(out));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('several symbols in one field are each findable', () => {
  const r = memory();
  try {
    run(r, 'log', 'learning', '--title', 'quote every path',
      '--symbols', 'AuthService.refreshToken,SessionStore.put');
    for (const s of ['AuthService.refreshToken', 'SessionStore.put']) {
      assert.match(run(r, 'find', s).stdout, /1 hits/, `${s} not found`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the pattern recognises qualified names', () => {
  for (const s of ['AuthService.refreshToken', 'store.put', 'README.md', 'ab.cd.ef']) {
    assert.ok(entity.bezeichner(s).has(s.toLowerCase()), `${s} not recognised`);
  }
  // `a.b.c` is NOT one, and the first version of this probe expected it
  // to be — the fixture was wrong, not the rule. Single-character
  // segments are exactly what keeps `z.B.` and `e.g.` out; a name whose
  // parts are one letter each cannot be told apart from an
  // abbreviation, so it stays out too.
  assert.equal(entity.bezeichner('a.b.c').size, 0);
});

test('COUNTER-PROBE: it does not eat German prose', () => {
  // The reason each segment must be at least TWO characters. Without
  // that rule `z.B.`, `u.a.`, `d.h.`, `e.g.` and `i.e.` all become
  // identifiers, and in a German corpus that floods the index with the
  // most common abbreviations there are.
  for (const s of ['z.B. ein Beispiel', 'u.a. und d.h.', 'e.g. and i.e.',
    'Satz eins. Satz zwei', 'ende.']) {
    assert.equal(entity.bezeichner(s).size, 0, `prose became an identifier: ${s}`);
  }
});

test('COUNTER-PROBE: a version stays a version, a number stays a number', () => {
  // `3.7.2` belongs to `fassung`, `1.5` is a plain number. Neither may
  // arrive through the new pattern, or the two lanes would disagree
  // about what an identifier is.
  assert.deepEqual([...entity.bezeichner('3.7.2')], ['3.7.2']);
  assert.equal(entity.bezeichner('1.5').size, 0);
  assert.equal(entity.bezeichner('12.34').size, 0);
});

test('the frequent ones are removed by the platz bound, not by a stop list', () => {
  // `README.md` in every second document identifies nothing. The rule
  // that handles it already existed; the new pattern must not need a
  // list of exceptions on top.
  const docs = Array.from({ length: 20 }, (_, i) => ({ text: `README.md and Thing${i}.method` }));
  const index = entity.baueIndex(docs, (d) => d.text);
  assert.equal(entity.treffer(index, 'README.md', 5).size, 0,
    'a name in 20 of 20 documents was treated as identifying');
  assert.equal(entity.treffer(index, 'Thing3.method', 5).size, 1);
});

test('`symbols` is a weighted field, and weighs like a deliberate access word', () => {
  // Not higher than the title: a symbol list must not override what the
  // entry is actually about.
  assert.equal(search.FIELD_WEIGHTS.symbols, 2.0);
  assert.ok(search.FIELD_WEIGHTS.symbols < search.FIELD_WEIGHTS.title);
  assert.equal(search.FIELD_WEIGHTS.symbols, search.FIELD_WEIGHTS.tags);
});

test('the cache version was raised, or an old index would stay silently blind', () => {
  // Both changes are inside the index. A cache from before them would
  // keep finding nothing, and would do it quietly — the worst of the
  // two failure modes.
  assert.ok(search.CACHE_VERSION >= 7);
});

test('a symbol in the title still works — nothing was traded away', () => {
  const r = memory();
  try {
    run(r, 'log', 'error', '--title', 'race in AuthService.refreshToken', '--class', 'concurrency');
    assert.match(run(r, 'find', 'AuthService.refreshToken').stdout, /1 hits/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
