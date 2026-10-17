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

test('todayProbeVerdict: a counter that never ran, or saw nothing, is not "0 workers"; a real zero passes; workers fail', () => {
  const row = (calls, workers = 0) => ({ pid: 1, calls: { existsSync: 0, statSync: 0, lstatSync: 0, accessSync: 0, readdirSync: 0, realpathSync: 0, openSync: 0, ...calls }, workers, opens: {} });
  const v = phase.todayProbeVerdict;
  assert.equal(v({ rows: null, status: 0 }).ok, false, 'null: the preload never ran');
  assert.match(v({ rows: null, status: 0 }).why, /counter did not run/);
  assert.equal(v({ rows: [], status: 0 }).ok, false, 'an empty list: no row');
  assert.match(v({ rows: [], status: 0 }).why, /counter did not run/);
  assert.equal(v({ rows: [row({})], status: 0 }).ok, false, 'a row with no file-system call at all cannot be a node that ran the CLI');
  assert.equal(v({ rows: [row({ statSync: 3 })], status: 0 }).ok, true, 'positive control: a live counter and no workers passes');
  assert.equal(v({ rows: [row({ statSync: 3 }, 6)], status: 0 }).ok, false);
  assert.equal(v({ rows: [row({ statSync: 3 }, 6)], status: 0 }).workers, 6);
  assert.equal(v({ rows: [row({ statSync: 3 })], status: 1 }).ok, false, 'a failed call is not a pass');
  assert.equal(v(({ rows: [row({ statSync: 3 })], status: null })).ok, false);
});
