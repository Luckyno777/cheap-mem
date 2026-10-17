// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-cost-logic.test.mjs — the helpers and the written-down ratchets of the `cost` atlas phase
// (atlas-neue-phasen-cm), without running the phase: `counted` sees a plain node start and a child of a node,
// `countedStarts` leaves out the labelled rebuild child, and the ratchets are the numbers measured on 2026-10-17.
//
// Red proof (bench/mutation.mjs, "ATLAS-COST ..."): a ratchet raised (before-edit 1 -> 2), the start counter
// that counts nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as phase from '../bench/atlas/phase-cost.mjs';

test('POSITIVE CONTROL: `counted` sees a plain node start and a node child of a node', () => {
  const root = process.cwd();
  const one = phase.counted('starts', ['-e', '0'], { root, cwd: root });
  assert.equal(phase.countedStarts(one.rows).length, 1);
  const two = phase.counted('starts', ['-e', "require('node:child_process').spawnSync(process.execPath, ['-e', '0'])"], { root, cwd: root });
  assert.equal(phase.countedStarts(two.rows).length, 2);
  assert.equal(phase.countedStarts(null).length, 0);
});

test('countedStarts leaves out the labelled rebuild child and nothing else', () => {
  assert.deepEqual(phase.countedStarts([{ tagged: false, script: 'a' }, { tagged: true, script: 'b' }, { script: 'c' }]).map((s) => s.script), ['a', 'c']);
});

test('the ratchets are written down with the day they were measured', () => {
  assert.deepEqual(phase.HOOK_STARTS, {
    'before-edit': 1, retrieve: 4, 'after-failure': 5, 'catch-fail': 4, 'subagent-start': 1, stop: 5,
  });
  assert.deepEqual(phase.CLI_MODULES, { version: 111, help: 71, find: 102 });
  assert.equal(phase.OPENS_PER_LOG, 3);
  assert.equal(phase.JOURNAL_READS, 1);
});
