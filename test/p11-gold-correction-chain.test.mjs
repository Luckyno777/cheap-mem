// test/p11-gold-correction-chain.test.mjs — P11, ported from lucky-mem.
//
// Finding (BAUPLAN-mem-admin_02.md, 2026-09-28, case czorxreppel ->
// 1rjpook3vead): a gold case that names a fixed id (bench/retrieval.mjs,
// or any future benchmark checking ids against a live corpus) counts as
// MISSED once that id is superseded by a correction (`replaces_id`) —
// even though the valid successor sits right there in the results,
// because `memory.holds()` stops counting the superseded line the
// moment a correction exists. `memory.correctionSuccessorMap()` /
// `correctionChainFrom()` / `expandExpectedIds()` (right next to the
// existing `predecessor`/`closedForChain` fold in `openDuties()`) fix
// that: a named id counts as hit when it OR any successor in its
// `replaces_id` chain (transitive) is returned.
//
// **Red proof.** Fixed prior state: the commit this tree branched from
// origin/main at (Rule 12: never `git merge-base HEAD origin/main` —
// that drifts after the merge and turns the proof itself red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { buildIndex, search } from '../src/search.mjs';

const ROOT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRIOR_STATE = '3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d';

test('RED PROOF: the correction-chain expansion did not exist at the prior state', () => {
  const before = execFileSync('git', ['show', `${PRIOR_STATE}:src/memory.mjs`],
    { cwd: ROOT_REPO, encoding: 'utf8' });
  for (const name of ['expandExpectedIds', 'correctionSuccessorMap', 'correctionChainFrom']) {
    assert.ok(!before.includes(name),
      `${name} already existed at the prior state (${PRIOR_STATE}) — no real red proof`);
  }
});

// --- pure chain logic, no corpus ---------------------------------------

test('correctionChainFrom: an uncorrected id stays alone in its chain', () => {
  const map = new Map();
  assert.deepEqual(memory.correctionChainFrom('x', map), ['x']);
});

test('correctionChainFrom: a multi-stage chain (like czorxreppel -> 1rjpook3vead -> wg6uax1of52f)', () => {
  const map = memory.correctionSuccessorMap([
    { id: 'b', replaces_id: 'a' },
    { id: 'c', replaces_id: 'b' },
  ]);
  assert.deepEqual(memory.correctionChainFrom('a', map), ['a', 'b', 'c']);
  assert.deepEqual(memory.correctionChainFrom('b', map), ['b', 'c']);
});

test('correctionChainFrom: a cycle stops the walk instead of spinning it', () => {
  const map = memory.correctionSuccessorMap([
    { id: 'b', replaces_id: 'a' },
    { id: 'a', replaces_id: 'b' }, // a form error in the corpus, not a crash reason
  ]);
  const chain = memory.correctionChainFrom('a', map);
  assert.ok(chain.length <= 2, `a cycle should have stopped the walk: ${chain.length} links`);
});

test('expandExpectedIds: POSITIVE CONTROL — an id with no correction stays unchanged', () => {
  const map = memory.correctionSuccessorMap([{ id: 'y', title: 'unrelated' }]);
  assert.deepEqual(memory.expandExpectedIds(['x'], map), ['x']);
});

test('expandExpectedIds: a superseded expected id is expanded with its successor', () => {
  const map = memory.correctionSuccessorMap([{ id: 'b', replaces_id: 'a' }]);
  const expanded = memory.expandExpectedIds(['a'], map);
  assert.deepEqual(new Set(expanded), new Set(['a', 'b']));
});

// --- integration: a gold case against a real corpus ---------------------

function tempRoot() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p11-gold-'));
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({ language: 'en' }));
  return w;
}

test('P11 gold case with a superseded id (integration): missed WITHOUT the chain, hit WITH it', () => {
  const w = tempRoot();
  try {
    const { entry: original } = memory.logEntry(w, 'error', {
      class: 'bug', title: 'zorbnoggle found in the dashboard', text: 'first pass',
    });
    const { entry: updated } = memory.correctionEntry(w, 'error', original.id, {
      class: 'bug', title: 'zorbnoggle found in the dashboard', text: 'more precise pass',
    });

    const idx = buildIndex(w, { language: 'en' });
    const hits = search(idx, 'zorbnoggle', { top: 10 });

    // Positive controls: the successor MUST be found (or this test
    // measures nothing), and the superseded entry must NOT be found
    // directly (memory.holds() hides it — otherwise there is nothing to
    // fix here).
    assert.ok(hits.some((h) => h.entry?.id === updated.id),
      'positive control: the successor is found at all');
    assert.ok(!hits.some((h) => h.entry?.id === original.id),
      'positive control: the superseded entry no longer surfaces directly');

    // RED (as before P11 — a plain id check with no chain, the same
    // comparison bench/retrieval.mjs and every other id-based gold
    // check used before):
    const withoutChain = hits.some((h) => [original.id].includes(h.entry?.id));
    assert.equal(withoutChain, false,
      'red proof: without the chain expansion, a gold case on the old id misses');

    // GREEN (P11):
    const map = memory.correctionSuccessorMap(idx.documents.map((d) => d.entry).filter(Boolean));
    const expected = memory.expandExpectedIds([original.id], map);
    assert.deepEqual(new Set(expected), new Set([original.id, updated.id]));
    const withChain = hits.some((h) => expected.includes(h.entry?.id));
    assert.equal(withChain, true, 'with the chain expansion, the gold case hits');
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});
