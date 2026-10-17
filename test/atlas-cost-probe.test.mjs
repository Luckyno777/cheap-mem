// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-cost-probe.test.mjs — the `cost` atlas phase (atlas-neue-phasen-cm): what one call costs,
// counted (node starts per hook, modules per CLI start, opens per log, probe threads, stat calls,
// journal bytes). The counters themselves are held by test/atlas-counters-probe.test.mjs.
//
// What it proves. The phase returns its eleven records with the four fields. On a platform with bash and
// a time-cap program the ten ratchet and bound rows read `pass` and the eleventh, `cost.today-journal`,
// reads `fail` — a FINDING, pinned here as it stands (`mem today` reads the injection journal twice per
// call: 2.0 bytes per journal byte, once for the card, once through the doctor it runs). When that is
// fixed the pin goes red on purpose: change the expectation to `pass` in the same commit as the fix.
// Without bash or without a cap program the six hook rows are `not-measured` and name why (asserted,
// not skipped).
//
// Controls pinned: the hook rows count at least one process (the counter sees the hook run); the doctor
// row sees workers WITH --full; the stat-class count moves when the memory gets more project folders;
// the retrieve row sees the logs open.
//
// Red proof (bench/mutation.mjs, "ATLAS-COST ..."): a second node start in the before-edit hook
// (`hook.before-edit` red), the undone TB6 fix (`retrieve-opens` red), the doctor probe started by default
// (`doctor-probe` red), a start counter, a call counter and a module counter that count nothing
// (`hook.*`, `doctor-probe`, `cli-start` red). Against the base commit of this change the phase is a stub:
// one `cost.not-built` row, `not-measured`, exit code 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';
import * as phase from '../bench/atlas/phase-cost.mjs';

const VERDICTS = Object.values(VERDICT);
const HOOKS = Object.keys(phase.HOOK_STARTS);
const IDS = [
  'cost.cli-start', ...HOOKS.map((h) => `cost.hook.${h}`), 'cost.retrieve-opens', 'cost.doctor-probe', 'cost.doctor-fs', 'cost.today-journal',
];

let cached = null;
const runOnce = () => (cached ??= (async () => {
  const atlas = new Atlas({ label: 'cost-probe' });
  await phase.run(atlas, { quick: true });
  return atlas;
})());
const records = (atlas) => atlas.phases.find((p) => p.id === 'cost').records;
const hooksRun = () => phase.bashStarts() && phase.capIsProgram();

test('the phase records its eleven rows, each with the four fields, and names what it cannot see', async () => {
  const atlas = await runOnce();
  const rs = records(atlas);
  assert.deepEqual(rs.map((r) => r.id).sort(), [...IDS].sort());
  for (const r of rs) {
    assert.ok(VERDICTS.includes(r.verdict), `${r.id}: ${r.verdict}`);
    assert.ok(r.expected && r.actual && r.evidence, `${r.id}: a field is empty`);
    if (r.verdict !== VERDICT.NOT_MEASURED) assert.ok(r.measured && typeof r.measured === 'object', `${r.id}: nothing measured is carried`);
  }
  assert.ok(atlas.blindSpots.length >= 5);
  assert.ok(atlas.blindSpots.every((b) => b.what && b.why));
});

test('the ratchet and bound rows pass; the hook rows say not-measured with the reason where there is no bash or no cap program', async () => {
  const rs = records(await runOnce());
  const by = Object.fromEntries(rs.map((r) => [r.id, r]));
  for (const id of IDS.filter((i) => i !== 'cost.today-journal' && !i.startsWith('cost.hook.'))) {
    assert.equal(by[id].verdict, VERDICT.PASS, `${id}: ${by[id].actual}`);
  }
  for (const h of HOOKS) {
    const r = by[`cost.hook.${h}`];
    if (hooksRun()) assert.equal(r.verdict, VERDICT.PASS, `${r.id}: ${r.actual}`);
    else {
      assert.equal(r.verdict, VERDICT.NOT_MEASURED);
      assert.match(r.evidence, /no bash|no timeout, gtimeout or perl/);
    }
  }
});

test('FINDING (pinned): `mem today` reads each byte of the injection journal twice per call', async () => {
  const r = records(await runOnce()).find((x) => x.id === 'cost.today-journal');
  assert.equal(r.verdict, VERDICT.FAIL, `fixed? then change this pin: ${r.actual}`);
  assert.ok(Math.abs(r.measured.slope - 2) < 0.05, `slope ${r.measured.slope}`);
  assert.ok(r.measured.readHi > r.measured.readLo, 'positive control: the counter saw the journal being read');
  assert.match(r.evidence, /src\/today\.mjs:\d+/);
  assert.match(r.evidence, /src\/doctor\.mjs:\d+/);
});

test('the measured values: one process per CLI start, the hooks within their ratchets, retrieve opens each log at most three times, no probe thread without --full', async () => {
  const m = Object.fromEntries(records(await runOnce()).map((r) => [r.id, r.measured]));
  for (const [k, s] of Object.entries(m['cost.cli-start'].seen)) {
    assert.equal(s.starts, 1, k);
    assert.ok(s.groups.length <= 1, k);
  }
  assert.deepEqual(m['cost.cli-start'].seen.help.groups, []);
  if (hooksRun()) {
    for (const h of HOOKS) {
      const x = m[`cost.hook.${h}`];
      assert.ok(x.starts >= 1 && x.starts <= phase.HOOK_STARTS[h], `${h}: ${x.starts}`);
    }
    assert.equal(m['cost.hook.before-edit'].starts, 1, 'TB5: the before-edit hook is ONE node start');
  }
  assert.ok(m['cost.retrieve-opens'].logs >= 3 && m['cost.retrieve-opens'].mostOpened <= phase.OPENS_PER_LOG);
  assert.equal(m['cost.doctor-probe'].default, 0);
  assert.ok(m['cost.doctor-probe'].full >= 2);
  assert.ok(m['cost.doctor-fs'].wide > m['cost.doctor-fs'].small, 'positive control: more project folders, more stat-class calls');
  assert.ok(m['cost.doctor-fs'].perEntry <= phase.DOCTOR_CALLS_PER_ENTRY);
});
