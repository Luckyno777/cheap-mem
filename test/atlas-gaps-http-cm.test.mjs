// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-gaps-http-cm.test.mjs — the gap group http-token of the atlas phase `bridge` (bench/atlas/bridge-gaps.mjs) on the
// live tree: real `bin/mem-mcp --http` and `bin/mem-serve` processes on free ports, asked with real requests. Every record
// reads pass; the numbers behind the verdicts are the ones the titles promise. The red proof is
// test/atlas-gaps-mutants-cm.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { httpDoors } from '../bench/atlas/bridge-gaps.mjs';
import { runGroup, assertRecords, assertAllPass } from './fixture/atlas-gap-run.mjs';

test('A14: the HTTP bridge and the dashboard start only behind a credential, refuse a wrong token, and the loopback switch stays on loopback', { timeout: 240000 }, async () => {
  const records = await runGroup(httpDoors);
  assertRecords(records, [
    'bridge.http-token.start-control', 'bridge.http-token.start-refused', 'bridge.http-token.accepted', 'bridge.http-token.rejected',
    'bridge.http-token.local-switch', 'bridge.http-token.read-only-default', 'bridge.http-token.dashboard',
  ]);
  assertAllPass(records);
  const refused = records.get('bridge.http-token.start-refused').measured;
  assert.equal(refused.asked, 7);
  assert.equal(refused.up, 0, 'no process came up that should have been refused');
  const rejected = records.get('bridge.http-token.rejected').measured;
  assert.equal(rejected.unauthorized, rejected.asked);
  assert.equal(rejected.written, 0, 'a refused request writes nothing');
  assert.equal(records.get('bridge.http-token.start-control').measured.leaked, 0, 'the token value is never printed');
});
