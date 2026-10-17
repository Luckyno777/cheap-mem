// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-gaps-bridge-cm.test.mjs — the gap groups sdk, bidi and card of the atlas phase `bridge` (bench/atlas/bridge-gaps.mjs)
// on the live tree: every record is there, every one reads pass, and the numbers behind the verdicts are the numbers the
// title promises. The red proof (one guarantee removed at its shared source, the record turns red) is
// test/atlas-gaps-mutants-cm.test.mjs; the mutants of this suite are in `GAP_MUTANTS` in bench/mutation.mjs and in the catalogue of
// bench/mutation.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VERDICT } from '../bench/atlas/core.mjs';
import { sdkFloor, bidiExits, cardFields } from '../bench/atlas/bridge-gaps.mjs';
import { runGroup, assertRecords, assertAllPass } from './fixture/atlas-gap-run.mjs';

test('A8: the SDK peer range and the installed SDK', async () => {
  const records = await runGroup(sdkFloor);
  assertRecords(records, ['bridge.sdk.range', 'bridge.sdk.installed']);
  assert.equal(records.get('bridge.sdk.range').verdict, VERDICT.PASS, records.get('bridge.sdk.range').actual);
  // the SDK is a dev dependency here, so it is installed in the suite's tree; if it ever is not, the record says so and is not a pass
  const installed = records.get('bridge.sdk.installed');
  assert.ok([VERDICT.PASS, VERDICT.NOT_MEASURED].includes(installed.verdict), installed.actual);
  if (installed.verdict === VERDICT.NOT_MEASURED) assert.match(installed.evidence, /not installed/);
});

test('A9: the nine bidi controls are masked at every MCP exit, in both halves, and nothing else is touched', { timeout: 120000 }, async () => {
  const records = await runGroup(bidiExits);
  assertRecords(records, ['bridge.bidi.world', 'bridge.bidi.exits', 'bridge.bidi.structured', 'bridge.bidi.roundtrip', 'bridge.bidi.all-nine', 'bridge.bidi.clean']);
  assertAllPass(records);
  // the count control is honest: the store carries 16 raw controls (3 + 4 in the first entry, nine in the second)
  assert.match(records.get('bridge.bidi.world').actual, /16 in the file, 16 in the reader/);
  assert.match(records.get('bridge.bidi.exits').actual, /mem_show: answered, 0 raw/);
  assert.match(records.get('bridge.bidi.all-nine').actual, /9 of 9 marks present/);
});

test('H11: the card over the bridge, both roads, limits at the number, shapes, rank, the person rule in two stages', { timeout: 120000 }, async () => {
  const records = await runGroup(cardFields);
  assertRecords(records, ['bridge.card.control', 'bridge.card.limits-edge', 'bridge.card.limits', 'bridge.card.shape', 'bridge.card.rank', 'bridge.card.person-stage1', 'bridge.card.person-stage2']);
  assertAllPass(records);
  assert.equal(records.get('bridge.card.limits').measured.asked, 14, 'seven limits on two roads');
  assert.equal(records.get('bridge.card.limits').measured.written, 0);
  assert.equal(records.get('bridge.card.shape').measured.written, 0);
  assert.equal(records.get('bridge.card.rank').measured.forgedWritten, 0);
});

test('a group whose control fails says not-measured and never pass: a tree with no bridge at all', { timeout: 120000 }, async () => {
  // The tree has no bin/mem-mcp; the group cannot even connect. Its records must not read pass.
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-gap-empty-'));
  try {
    const { Atlas } = await import('../bench/atlas/core.mjs');
    const { guard } = await import('../bench/atlas/gap-records.mjs');
    const atlas = new Atlas({ label: 'probe' });
    atlas.phase('probe', 'probe');
    const ids = ['bridge.bidi.world', 'bridge.bidi.exits', 'bridge.bidi.structured', 'bridge.bidi.roundtrip', 'bridge.bidi.all-nine', 'bridge.bidi.clean'];
    await guard(atlas, ids, () => bidiExits(atlas, { tree: dir }));
    const got = new Map(atlas.current.records.map((r) => [r.id, r]));
    // the world is built in this process and its count control holds whatever the tree is; every record that needs the bridge is not-measured
    assert.equal(got.get('bridge.bidi.world')?.verdict, VERDICT.PASS);
    for (const id of ids.slice(1)) {
      assert.equal(got.get(id)?.verdict, VERDICT.NOT_MEASURED, `${id} must not pass in a tree without a bridge: ${got.get(id)?.actual}`);
      assert.match(got.get(id).evidence, /group stopped before it/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
