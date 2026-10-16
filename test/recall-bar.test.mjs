// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// abruf-stamm-cm, step 2: what the hook SHOWS is decided in one place (src/recallrender.mjs `clears`, `RECALL_MIN`),
// and the measurements call it instead of keeping a mirror.
//
// The finding. "Score at or over the bar, or an exact hit" was written out in seven places: the renderer, the H5 path of
// the hook, the journal line of `mem find --journal-session`, `bench/recall-levers.mjs` (twice, with its own `BAR = 5.0`),
// `bench/coverage-floor-sweep.mjs`, and, as a number, in the SubagentStart block and the two shell hooks. A measurement that re-implements the selection measures its own copy; the sibling house
// had a gold check that disagreed with the hook on echoes and on the byte budget. Here the copies are fewer and the
// bench was the one that could drift.
//
//   A. the predicate (table, with the cases where a copy would differ);
//   B. EQUALITY: the hook's block (`recallhook.recall`) over many hit lists, bars and lever settings is byte for byte
//      the base's;
//   C. the number: every default in the repository is RECALL_MIN;
//   D. the guard: no file of the selection path or of the measurement writes the comparison again (RED at the base).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import { clears, RECALL_MIN, renderHits } from '../src/recallrender.mjs';
import * as recallhook from '../src/recallhook.mjs';
import { REGISTER as ENV_REGISTER } from '../src/envregister.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '9ee34416b4bc8ac452ec39bcac8ce3c1c56e96f6';
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// --- A. the predicate ---------------------------------------------------------

test('A: clears() is "score at or over the bar, or an exact hit"', () => {
  assert.equal(RECALL_MIN, 5);
  assert.equal(clears({ score: 5 }), true, 'at the bar');
  assert.equal(clears({ score: 4.99 }), false);
  assert.equal(clears({ score: 0.1, exact: ['src/a.mjs'] }), true, 'an exact hit needs no score');
  assert.equal(clears({ score: 0.1, exact: [] }), false, 'an empty exact list is not exact');
  assert.equal(clears({ score: 0.1, exact: true }), false, 'a boolean is no list (the bench once mapped it to one)');
  assert.equal(clears({ score: '7.5' }), true, 'a score read from JSON text');
  assert.equal(clears({}), false);
  assert.equal(clears(null), false);
  assert.equal(clears({ score: 3 }, 2), true, 'another bar');
  assert.equal(clears({ score: 3 }, NaN), false, 'a bar that is no number lets only exact hits through');
  assert.equal(clears({ score: 3, exact: ['x'] }, NaN), true);
});

// --- B. equality against the base -------------------------------------------------

function hit(i, score, exact, source = 'global/decisions.jsonl') {
  return { score, ...(exact ? { exact: ['x'] } : {}), source, line: i + 1, entry: {
    id: `bar-${i}`, ts: '2026-09-01T00:00:00Z', topic: `topic ${i}`, choice: `choice ${i} `.repeat(3), why: `why ${i}` } };
}
const LISTS = [
  [],
  [hit(0, 9), hit(1, 6), hit(2, 5)],
  [hit(0, 4.9), hit(1, 4.8)],
  [hit(0, 0.1, true), hit(1, 9), hit(2, 0.2, true), hit(3, 3)],
  [hit(0, 12), hit(1, 11), hit(2, 10), hit(3, 9), hit(4, 8), hit(5, 7), hit(6, 6)],
  [hit(0, 5), hit(1, 5), hit(2, 5.0000001)],
];
const ENVS = [
  {}, { MEM_RH_MIN: '0' }, { MEM_RH_MIN: '8' }, { MEM_RH_MIN: 'not a number' },
  { MEM_SEARCH_LEVERS: 'h5' }, { MEM_SEARCH_LEVERS: 'h5', MEM_RH_MIN: '8' }, { MEM_SEARCH_LEVERS: 'h2,h5', MEM_RH_MIN: '6' },
];

test('B: the hook\'s block is byte for byte the base\'s over hit lists x bars x lever settings', async (t) => {
  const old = tempDir('cm-bar-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], old);
  const before = await import(pathToFileURL(path.join(old, 'src', 'recallhook.mjs')).href);
  let n = 0;
  let shownSomething = 0;
  for (const list of LISTS) {
    for (const env of ENVS) {
      // no session, no turns directory: nothing is claimed, nothing is booked (`recall` only builds the answer)
      const e = { ...env };
      const want = before.recall('/nonexistent-root', JSON.stringify({ hits: list }), e);
      const got = recallhook.recall('/nonexistent-root', JSON.stringify({ hits: list }), e);
      assert.deepEqual(got.out, want.out, `${JSON.stringify(env)} on ${list.map((h) => h.score).join(',')}`);
      n += 1;
      if (got.out) shownSomething += 1;
    }
  }
  assert.ok(n >= 40 && shownSomething >= 15, `${n} cases, ${shownSomething} showed something: the equality would prove little`);
});

test('B2: renderHits is unchanged for an NaN bar and for the default bar', async (t) => {
  const old = tempDir('cm-bar-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], old);
  const before = await import(pathToFileURL(path.join(old, 'src', 'recallrender.mjs')).href);
  for (const list of LISTS) {
    for (const min of [0, 5, 5.5, 100, NaN]) assert.deepEqual(renderHits(list, { min }), before.renderHits(list, { min }));
  }
});

// --- C. the number -----------------------------------------------------------------

test('C: every default of the bar in the repository is RECALL_MIN', () => {
  const sh = /MIN="\$\{MEM_RETRIEVE_MIN:-([0-9.]+)\}"/.exec(read('bin/mem-retrieve'));
  assert.ok(sh, 'bin/mem-retrieve keeps its default where this guard looks');
  assert.equal(Number(sh[1]), RECALL_MIN, 'bin/mem-retrieve');
  const ps = /\$Min = if \(\$env:MEM_RETRIEVE_MIN\) \{ \$env:MEM_RETRIEVE_MIN \} else \{ '([0-9.]+)' \}/.exec(read('bin/mem-retrieve.ps1'));
  assert.ok(ps, 'bin/mem-retrieve.ps1 keeps its default where this guard looks');
  assert.equal(Number(ps[1]), RECALL_MIN, 'bin/mem-retrieve.ps1');
  const reg = ENV_REGISTER.find((e) => e.name === 'MEM_RETRIEVE_MIN');
  assert.ok(reg, 'registered');
  assert.equal(Number(reg.default), RECALL_MIN, 'src/envregister.mjs');
  assert.match(read('src/recallhook.mjs'), /num\(env\.MEM_RH_MIN, RECALL_MIN\)/);
  assert.match(read('src/subagenttask.mjs'), /const MIN_SCORE = RECALL_MIN;/);
});

// --- D. the guard (red at the base) -----------------------------------------------------

const COPY = /score\)?\s*>=\s*(?:min|bar|BAR|MIN|RETRIEVE_MIN)\b/;
const GUARDED = ['src/recallhook.mjs', 'src/cli/commands/search.mjs', 'bench/recall-levers.mjs', 'bench/coverage-floor-sweep.mjs'];

test('D: no file of the selection or of the measurement writes the comparison again', () => {
  for (const rel of GUARDED) {
    const code = read(rel).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, COPY, `${rel} compares the score with the bar itself`);
  }
  assert.match(read('bench/recall-levers.mjs'), /clears\(h, BAR\)/);
  assert.match(read('src/cli/commands/search.mjs'), /hits\.filter\(\(h\) => clears\(h, min\)\)/);
  assert.match(read('bench/coverage-floor-sweep.mjs'), /clears\(h, RETRIEVE_MIN\)/);
  assert.match(read('src/recallrender.mjs'), /if \(!clears\(h, min\)\) continue;/);
});

test('D2: the guard is red on the base (positive control)', (t) => {
  const old = tempDir('cm-bar-base-', t);
  exportCommit(REPO, BASE, ['src', 'bench', 'package.json'], old);
  const code = (rel) => fs.readFileSync(path.join(old, rel), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(code('bench/recall-levers.mjs'), COPY, 'the base bench wrote the comparison itself');
  assert.match(code('src/recallhook.mjs'), /score\) >= min/, 'the base H5 path wrote it too');
  assert.match(code('src/cli/commands/search.mjs'), COPY, 'the base journal line of `find` wrote it too');
  assert.match(code('bench/coverage-floor-sweep.mjs'), COPY, 'the base sweep wrote it too');
});
