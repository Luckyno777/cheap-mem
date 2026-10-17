// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-dashboard-probe.test.mjs — the `dashboard` atlas phase (atlas-neue-phasen-cm): what the
// dashboard server READS per build and what a page load ASKS, counted.
//
// What it proves. The phase returns its five records with the four fields. On this tree:
//   build-reads, warm-load, write-rebuild   pass (a full build reads each line about 29 times, the same at
//                                          300 and 1000 entries; a warm load reads none; one new entry costs
//                                          a full rebuild, not more)
//   desk                                    FAIL, a finding pinned as it stands: /desk.json rebuilds on every
//                                          call (the second call reads 100 % of the first; no page asks for it)
//   requests                                FAIL, a finding pinned as it stands: with Chromium, the home view
//                                          asks /dashboard/appointments.json twice (the page draws once from
//                                          the head and once from the full list, and each draw asks again).
//                                          Without Chromium the row is `not-measured` and names why.
// When one of the two findings is fixed its pin goes red on purpose: change it to `pass` in the same commit.
//
// Controls: the counter sees the build (more than 0 lines read); the rebuild scenario sees the new entry
// (`waited`); the first /desk.json call reads lines. The pure helpers (`routeOf`, `duplicatesOf`, `linesOnDisk`)
// are held on planted input in test/atlas-dashboard-logic.test.mjs.
//
// Red proof (bench/mutation.mjs, "ATLAS-DASHBOARD ..."): a cache that rebuilds on every request (`warm-load`
// and `build-reads` red) and an io-counter that counts nothing (`build-reads` red). Against the base commit of
// this change the phase is a stub: one `dashboard.not-built` row, `not-measured`, exit code 3.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';
import * as phase from '../bench/atlas/phase-dashboard.mjs';
import { startBrowser } from '../bench/atlas/serve-world.mjs';
import { takeLock } from './fixture/browser.mjs';

const VERDICTS = Object.values(VERDICT);
const IDS = ['build-reads', 'warm-load', 'write-rebuild', 'desk', 'requests'].map((i) => `dashboard.${i}`);

// The phase watches a page in Chromium once: one browser file at a time (the lock the other browser probes take).
let lock = null;
after(() => { if (lock) lock(); });
let cached = null;
const runOnce = () => (cached ??= (async () => {
  lock = await takeLock();
  const atlas = new Atlas({ label: 'dashboard-probe' });
  await phase.run(atlas, { quick: true });
  return atlas;
})());
const records = (atlas) => atlas.phases.find((p) => p.id === 'dashboard').records;

test('the phase records its five rows, each with the four fields, and names what it cannot see', async () => {
  const atlas = await runOnce();
  const rs = records(atlas);
  assert.deepEqual(rs.map((r) => r.id), IDS);
  for (const r of rs) {
    assert.ok(VERDICTS.includes(r.verdict), `${r.id}: ${r.verdict}`);
    assert.ok(r.expected && r.actual && r.evidence, `${r.id}: a field is empty`);
  }
  assert.ok(atlas.blindSpots.length >= 5);
  assert.ok(atlas.blindSpots.every((b) => b.what && b.why));
});

test('the server rows: a build reads each line a bounded number of times, a warm load reads none, one new entry costs a rebuild', async () => {
  const by = Object.fromEntries(records(await runOnce()).map((r) => [r.id, r]));
  for (const id of ['dashboard.build-reads', 'dashboard.warm-load', 'dashboard.write-rebuild']) assert.equal(by[id].verdict, VERDICT.PASS, `${id}: ${by[id].actual}`);
  const b = by['dashboard.build-reads'].measured;
  assert.ok(b.lines > 0, 'positive control: the counter saw the build');
  assert.ok(b.passes > 20 && b.passes <= phase.BUILD_PASSES_MAX, `passes ${b.passes}`);
  assert.equal(by['dashboard.warm-load'].measured.second, 0);
  assert.ok(by['dashboard.warm-load'].measured.first > 0);
  const w = by['dashboard.write-rebuild'].measured;
  assert.equal(w.waited, true, 'the build showed the new entry');
  assert.ok(w.rebuildPasses > 1, 'one new entry is NOT an incremental rebuild: it reads the store again, pinned as it stands');
});

test('FINDING (pinned): /desk.json rebuilds on every call — the second call reads as much as the first', async () => {
  const r = records(await runOnce()).find((x) => x.id === 'dashboard.desk');
  assert.equal(r.verdict, VERDICT.FAIL, `fixed? then change this pin: ${r.actual}`);
  assert.ok(r.measured.first > 0, 'positive control: the first call read lines');
  assert.ok(r.measured.share >= 0.95 && r.measured.share <= 1.05, `share ${r.measured.share}`);
  assert.deepEqual(r.measured.statuses, [200, 200]);
  assert.match(r.evidence, /bin\/mem-serve:\d+/);
  const page = fs.readFileSync(new URL('../assets/dashboard/dashboard.js', import.meta.url), 'utf8');
  assert.ok(!page.includes('/desk.json'), 'no page asks for /desk.json (if one does, the evidence text of the row is wrong)');
});

test('requests: with Chromium the home view asks appointments.json twice (pinned finding); without, the row says not-measured and why', async () => {
  const r = records(await runOnce()).find((x) => x.id === 'dashboard.requests');
  const { browser, reason } = await startBrowser();
  if (browser) await browser.close();
  if (!browser) {
    assert.equal(r.verdict, VERDICT.NOT_MEASURED);
    assert.match(r.evidence, /no browser/);
    return;
  }
  assert.equal(reason, null);
  assert.equal(r.verdict, VERDICT.FAIL, `fixed? then change this pin: ${r.actual}`);
  const views = r.measured.views;
  // The home view draws once from the head and once from the full list, so twice (a third draw under load would still be this finding).
  assert.deepEqual(views['#home'].duplicates.map((d) => d.route), ['/dashboard/appointments.json']);
  assert.ok(views['#home'].duplicates[0].times >= 2);
  assert.deepEqual(views['#knowledge/entries'].duplicates, []);
  assert.deepEqual(views['#home'].failed, []);
  assert.ok(views['#home'].total >= 10 && views['#knowledge/entries'].total >= 10, 'positive control: the page was watched');
});
