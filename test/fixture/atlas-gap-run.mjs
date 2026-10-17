// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Shared by test/atlas-gaps-bridge-cm.test.mjs, test/atlas-gaps-http-cm.test.mjs and test/atlas-gaps-silent-cm.test.mjs:
// run one gap group of the atlas on the live tree and look at its records.
import assert from 'node:assert/strict';
import { Atlas, VERDICT } from '../../bench/atlas/core.mjs';

/** Run `group(atlas, opts)` on a fresh atlas; the records by id. */
export async function runGroup(group, opts = {}) {
  const atlas = new Atlas({ label: 'gap-probe' });
  atlas.phase('probe', 'probe');
  await group(atlas, opts);
  return new Map(atlas.current.records.map((r) => [r.id, r]));
}

/** The four fields are there, the reason of a `not-measured` is said, and the ids are exactly the expected ones. */
export function assertRecords(records, ids) {
  assert.deepEqual([...records.keys()].sort(), [...ids].sort(), 'the group writes exactly its records');
  for (const [id, r] of records) {
    assert.ok(typeof r.title === 'string' && r.title.length > 20, `${id}: no title`);
    assert.ok(Object.values(VERDICT).includes(r.verdict), `${id}: verdict ${r.verdict}`);
    assert.ok(r.expected !== null && String(r.expected).length > 0, `${id}: a verdict without an expectation`);
    assert.ok(typeof r.actual === 'string' && r.actual.length > 0, `${id}: nothing measured, nothing said`);
    assert.ok(r.evidence && String(r.evidence).length > 10, `${id}: a verdict without evidence`);
  }
}

/** Every record passes: a pass is the only verdict a live tree may carry here (a `not-measured` would be an empty green). */
export function assertAllPass(records) {
  for (const [id, r] of records) assert.equal(r.verdict, VERDICT.PASS, `${id}: ${r.verdict}: ${r.actual} (${String(r.evidence).slice(0, 200)})`);
}
