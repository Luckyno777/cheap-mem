// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-gaps-mutants-cm.test.mjs — the RED PROOF of the new atlas records (atlas-luecken-cm, 2026-10-17).
//
// What this proves, record by record. Each gap group of the phases `bridge` and `silent-errors`
// (bench/atlas/bridge-gaps.mjs, bench/atlas/silent-errors-gaps.mjs) is asked twice: of an untouched scratch copy of the
// code tree (every record `pass`: the positive control of the copy), and of the same copy with ONE guarantee removed at its
// shared source (bench/atlas/gap-mutants.mjs). The table says which records must turn `fail`, which must stay `pass` (the
// controls, and what the mutant does not touch) and which must read `not-measured` (their control fell, so they say so
// instead of passing). A record no mutant turns red would be a record that cannot fail; the last test counts that.
//
// **Why the mutants sit where they do.** The sister house learned that a mutant at the FIRST layer left four records
// green, because a second layer stood behind it. Here the mutants sit at the source every road runs through (the limits of
// the card rules, the nine-control mask, the one start rule of src/webauth.mjs), or remove both layers (`edits` with two
// entries). The proof lives in a scratch copy under os.tmpdir(); the working tree is never touched.
//
// **Red on the base** (fixed commits, measured 2026-10-17 by asking the same groups of a `git archive` of the commit; a fixed hash,
// never a merge-base, which moves): A9 bidi at 1e1a738 (parent of 202ed9c, before the bridge masked anything): `exits`, `structured`,
// `roundtrip`, `all-nine` fail (7 to 14 raw controls per answer), `world` and `clean` pass. A14 at 870788f (parent of f6f77ec, before a
// service refused to start without a token): `start-refused` (4 of 7 came up) and `dashboard` fail, `start-control`, `accepted`,
// `rejected`, `local-switch` pass. H11 at 2bb9889 (before the card core): `card.control` fails (no `mem_card_add`) and the six records
// behind it read not-measured; at 6e81ce3 (the card core, before the person rule): `person-stage1` and `person-stage2` fail, the
// other five pass. A8 at e6c1dc7 (peer range `^1.0.0`): `sdk.range` fails. E1 at f4a3540 (before the journal had states): `visibility.states`
// fails. E3 at 04f7fcc (before a failed lane was told): `task-lane.real-unreadable` fails (null), `real-control` passes.
//
// Slow on purpose (about three minutes: one door per mutant, real processes). The live-tree halves are in
// test/atlas-gaps-bridge-cm.test.mjs, test/atlas-gaps-http-cm.test.mjs and test/atlas-gaps-silent-cm.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';
import * as bridgeGaps from '../bench/atlas/bridge-gaps.mjs';
import * as silentGaps from '../bench/atlas/silent-errors-gaps.mjs';
import * as silent from '../bench/atlas/phase-silent-errors.mjs';
import { GAP_MUTANTS } from '../bench/atlas/gap-mutants.mjs';
import { makeScratchTree } from './fixture/atlas-gap-tree.mjs';

const GROUPS = {
  sdk: bridgeGaps.sdkFloor,
  bidi: bridgeGaps.bidiExits,
  card: bridgeGaps.cardFields,
  http: bridgeGaps.httpDoors,
  'vis-states': silentGaps.visibilityStates,
  'vis-bridge': silentGaps.visibilityBridge,
  doctor: silentGaps.doctorStates,
  task: silentGaps.taskLaneReal,
  surfaces: silent.surfacesGroup,
};

async function ask(group, tree) {
  const atlas = new Atlas({ label: 'proof' });
  atlas.phase('proof', 'proof');
  await GROUPS[group](atlas, { tree });
  return new Map(atlas.current.records.map((r) => [r.id, r]));
}
const say = (records, id) => (records.has(id) ? `${records.get(id).verdict}: ${records.get(id).actual}` : 'no such record');

test('every mutant of the table names records that the groups really write, and every group has a mutant', { timeout: 60000 }, () => {
  for (const m of GAP_MUTANTS) {
    assert.ok(GROUPS[m.group], `${m.id}: unknown group ${m.group}`);
    assert.ok(m.edits.length >= 1 && m.edits.every((e) => e.file && e.from && e.to !== undefined && e.from !== e.to), `${m.id}: edits are malformed`);
    assert.ok(m.red.length >= 1, `${m.id}: a mutant that turns no record red proves nothing`);
  }
  const groups = new Set(GAP_MUTANTS.map((m) => m.group));
  for (const g of ['sdk', 'bidi', 'card', 'http', 'vis-states', 'vis-bridge', 'doctor', 'task', 'surfaces']) assert.ok(groups.has(g), `group ${g} has no mutant`);
});

test('the untouched scratch copy: every record of every gap group reads pass (the control of the copy)', { timeout: 240000 }, async (t) => {
  const tree = makeScratchTree();
  t.after(() => tree.dispose());
  for (const group of Object.keys(GROUPS)) {
    const records = await ask(group, tree.dir);
    assert.ok(records.size >= 1, `${group}: no record`);
    for (const [id, r] of records) {
      // the surfaces group also holds the old degraded states of find and context; only the duties records are this change's
      if (group === 'surfaces' && !/duties/.test(id)) continue;
      if (group === 'surfaces' && r.verdict === VERDICT.DEGRADED) continue;
      assert.equal(r.verdict, VERDICT.PASS, `${group}: ${id}: ${r.actual}`);
    }
  }
});

test('each mutant turns its records red, keeps the others green and the dependents unmeasured', { timeout: 900000 }, async (t) => {
  const tree = makeScratchTree();
  t.after(() => tree.dispose());
  const turned = new Set();
  for (const m of GAP_MUTANTS) {
    await t.test(m.id, { timeout: 180000 }, async () => {
      tree.apply(m.edits);
      let records;
      try { records = await ask(m.group, tree.dir); } finally { tree.restore(); }
      for (const id of m.red) {
        assert.equal(records.get(id)?.verdict, VERDICT.FAIL, `${m.id}: ${id} must turn red; it reads ${say(records, id)}`);
        turned.add(id);
      }
      for (const id of m.green) assert.equal(records.get(id)?.verdict, VERDICT.PASS, `${m.id}: ${id} must stay green; it reads ${say(records, id)}`);
      for (const id of m.unmeasured) assert.equal(records.get(id)?.verdict, VERDICT.NOT_MEASURED, `${m.id}: ${id} must read not-measured; it reads ${say(records, id)}`);
    });
  }
  t.diagnostic(`${turned.size} records were turned red by at least one mutant`);
});

test('the control of the count: a world without the nine controls turns bridge.bidi.world red and leaves the rest unmeasured', { timeout: 60000 }, async () => {
  const atlas = new Atlas({ label: 'proof' });
  atlas.phase('proof', 'proof');
  await bridgeGaps.bidiExits(atlas, { withoutControls: true });
  const records = new Map(atlas.current.records.map((r) => [r.id, r]));
  assert.equal(records.get('bridge.bidi.world')?.verdict, VERDICT.FAIL, say(records, 'bridge.bidi.world'));
  for (const id of ['bridge.bidi.exits', 'bridge.bidi.structured', 'bridge.bidi.roundtrip', 'bridge.bidi.all-nine', 'bridge.bidi.clean']) {
    assert.equal(records.get(id)?.verdict, VERDICT.NOT_MEASURED, `${id}: ${say(records, id)}`);
  }
});

test('every new record has a mutant that turns it red', { timeout: 240000 }, async (t) => {
  const tree = makeScratchTree();
  t.after(() => tree.dispose());
  const written = new Set();
  for (const group of Object.keys(GROUPS)) {
    for (const id of (await ask(group, tree.dir)).keys()) written.add(id);
  }
  const covered = new Set(GAP_MUTANTS.flatMap((m) => m.red));
  // Exempt, each with its proof elsewhere: the control of the count (the test above), and the rows of the older surfaces
  // group (find, context, and the duties rows that share their judge: test/atlas-bridge-silent-errors-probe.test.mjs holds the judge;
  // only the `unreadable` row of the duties is a statement of this change, and a mutant turns it red).
  const exempt = (id) => id === 'bridge.bidi.world' || (/^silent-errors\.(cli|bridge)-(find|context|duties)\./.test(id) && !/-duties\.unreadable$/.test(id)) || /^silent-errors\.(readlog|visibility\.(ok|broken|unreadable)|task-lane\.(control|nothing-found|failed-lane))/.test(id);
  const uncovered = [...written].filter((id) => !covered.has(id) && !exempt(id));
  assert.deepEqual(uncovered, [], 'these records have no mutant in bench/atlas/gap-mutants.mjs that turns them red');
});
