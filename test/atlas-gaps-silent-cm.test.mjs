// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-gaps-silent-cm.test.mjs — the gap groups of the atlas phase `silent-errors` (bench/atlas/silent-errors-gaps.mjs and
// the duties surfaces of bench/atlas/phase-silent-errors.mjs) on the live tree: every record is there and the controls hold.
// The red proof is test/atlas-gaps-mutants-cm.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT } from '../bench/atlas/core.mjs';
import { visibilityStates, visibilityBridge, doctorStates, taskLaneReal } from '../bench/atlas/silent-errors-gaps.mjs';
import { surfacesGroup } from '../bench/atlas/phase-silent-errors.mjs';
import { runGroup, assertRecords, assertAllPass } from './fixture/atlas-gap-run.mjs';

test('E1: the visibility journal has five read states, and the bridge keeps answering when its journal cannot be read', { timeout: 120000 }, async () => {
  const states = await runGroup(visibilityStates);
  assertRecords(states, ['silent-errors.visibility.states']);
  assertAllPass(states);
  assert.equal(new Set(Object.values(states.get('silent-errors.visibility.states').measured).map((x) => x.state)).size, 5);
  const bridge = await runGroup(visibilityBridge);
  assertRecords(bridge, ['silent-errors.visibility.bridge-control', 'silent-errors.visibility.bridge-unreadable']);
  assertAllPass(bridge);
});

test('E2: the doctor tells the five states of a drawer apart', { timeout: 120000 }, async () => {
  const records = await runGroup(doctorStates);
  assertRecords(records, ['ok', 'missing', 'empty', 'broken', 'unreadable'].map((s) => `silent-errors.doctor.${s}`));
  assertAllPass(records);
  // unreadable and broken are told apart by their words, not only by their level
  assert.match(records.get('silent-errors.doctor.unreadable').actual, /unreadable/);
  assert.match(records.get('silent-errors.doctor.broken').actual, /not JSON/);
});

test('E3: the subagent block names a lane that failed for real, and is null only when nothing was searched wrongly', { timeout: 120000 }, async () => {
  const records = await runGroup(taskLaneReal);
  assertRecords(records, ['silent-errors.task-lane.real-control', 'silent-errors.task-lane.real-unreadable']);
  assertAllPass(records);
});

test('the duties surfaces: what is still owed is not "nothing" after a failed read (CLI and bridge, five states)', { timeout: 120000 }, async () => {
  const records = await runGroup(surfacesGroup);
  const duties = [...records.entries()].filter(([id]) => /-duties\./.test(id));
  assert.equal(duties.length, 10, 'two surfaces, five states');
  for (const [id, r] of duties) {
    assert.notEqual(r.verdict, VERDICT.NOT_MEASURED, `${id}: ${r.evidence}`);
    assert.notEqual(r.verdict, VERDICT.FAIL, `${id}: ${r.actual}`);
  }
  // the controls
  assert.equal(records.get('silent-errors.cli-duties.ok').verdict, VERDICT.PASS);
  assert.equal(records.get('silent-errors.bridge-duties.ok').verdict, VERDICT.PASS);
  // an unreadable drawer is an error, never an empty list; naming the file is the part that may be degraded
  for (const id of ['silent-errors.cli-duties.unreadable', 'silent-errors.bridge-duties.unreadable']) {
    assert.match(records.get(id).actual, /^error/, id);
  }
});
