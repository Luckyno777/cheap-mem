// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-net-tempo-probe.test.mjs — the `net-tempo` atlas phase (atlas-neue-phasen-cm): what the 3D
// network of the dashboard CAUSES when it is built (builds, model computations, WebGL contexts, shader
// programs), counted by bench/atlas/net-counter.mjs.
//
// The LOGIC half (`judge()` on doctored results, the page-side counter on a fake page, the red probe with a
// silent counter) is test/atlas-net-tempo-logic.test.mjs and runs everywhere. This file is the BROWSER half
// (needs Chromium; without it the four rows say `not-measured` and name why, asserted): the real page in a
// real Chromium against a real `bin/mem-serve`. On this tree the load builds the network
//   once or twice (a race between the head and the full list, both inside the bound), a quiet reload builds
//   nothing, a draw is one build, one model computation, one context, five programs, and `reuse` is
//   `degraded` (the sister house pools the canvas, this house does not): pinned as it stands. The red probe
//   against the real page: the counter switched off (`counters: false`) while the page still draws its
//   network.
//
// Red proof: the mutants of bench/mutation.mjs ("ATLAS-NET ...") are judged by the logic half (a sweep runs
// where there is no Chromium). Against the base commit of this change the phase is a stub: one
// `net-tempo.not-built` row, `not-measured`, exit code 3.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Atlas, VERDICT, mem, tempRoot, buildCorpus } from '../bench/atlas/core.mjs';
import * as phase from '../bench/atlas/phase-net-tempo.mjs';
import { measureNet } from '../bench/atlas/net-counter.mjs';
import { startBrowser, startServer } from '../bench/atlas/serve-world.mjs';
import * as memory from '../src/memory.mjs';
import { takeLock } from './fixture/browser.mjs';

const ID = (k) => `net-tempo.${k}`;
const none = { builds: 0, models: 0, contexts: 0, programs: 0 };
const judged = (m) => {
  const atlas = new Atlas({ label: 'net-judge' });
  atlas.phase('net-tempo', 't');
  phase.judge(atlas, m);
  return Object.fromEntries(atlas.phases[0].records.map((r) => [r.id, r]));
};
const verdicts = (m) => Object.fromEntries(Object.entries(judged(m)).map(([k, r]) => [k, r.verdict]));

// --- the browser half ------------------------------------------------------------------------------------

// One browser file at a time (the lock the other browser probes take), taken once for the whole file.
let release = null;
let waiting = null;
const holdLock = () => (waiting ??= takeLock().then((r) => { release = r; }));
after(() => { if (release) release(); });
let cached = null;
const runOnce = () => (cached ??= (async () => {
  await holdLock();
  const atlas = new Atlas({ label: 'net-tempo-probe' });
  await phase.run(atlas, { quick: true });
  return atlas;
})());
const records = (atlas) => atlas.phases.find((p) => p.id === 'net-tempo').records;

test('the phase records its four rows with the four fields and names what it cannot see', async () => {
  const atlas = await runOnce();
  const rs = records(atlas);
  assert.deepEqual(rs.map((r) => r.id), ['load', 'quiet', 'rebuild', 'reuse'].map(ID));
  for (const r of rs) assert.ok(Object.values(VERDICT).includes(r.verdict) && r.expected && r.actual && r.evidence, r.id);
  assert.ok(atlas.blindSpots.length >= 1 && atlas.blindSpots.every((b) => b.what && b.why));
});

test('with Chromium: the load builds once or twice, a quiet reload builds nothing, a draw is one build, `reuse` is degraded (pinned); without: four not-measured rows that name why', async () => {
  const rs = records(await runOnce());
  const by = Object.fromEntries(rs.map((r) => [r.id, r]));
  const { browser } = await startBrowser();
  if (browser) await browser.close();
  if (!browser) {
    assert.ok(rs.every((r) => r.verdict === VERDICT.NOT_MEASURED && /no browser/.test(r.evidence)));
    return;
  }
  assert.deepEqual(rs.map((r) => r.verdict), [VERDICT.PASS, VERDICT.PASS, VERDICT.PASS, VERDICT.DEGRADED], rs.map((r) => `${r.id}: ${r.actual}`).join('\n'));
  const load = by[ID('load')].measured;
  assert.ok(load.builds >= 1 && load.builds <= phase.BUILDS_ON_LOAD_MAX, `builds ${load.builds}`);
  assert.equal(load.models, load.builds);
  assert.ok(load.contexts >= 2, 'positive control: the background canvas and a network');
  assert.deepEqual(by[ID('quiet')].measured.quietSame, none);
  assert.deepEqual(by[ID('quiet')].measured.quietChanged, none);
  assert.equal(by[ID('quiet')].measured.changedSeen, true);
  for (const d of by[ID('rebuild')].measured.rebuilds) assert.deepEqual(d, { contexts: 1, programs: phase.PROGRAMS_PER_BUILD, builds: 1, models: 1 });
  assert.deepEqual([by[ID('reuse')].measured.newContexts, by[ID('reuse')].measured.newPrograms], [2, 10], 'fixed by a pool? then change this pin to pass');
});

test('RED PROBE against the real page: with the counter switched off the page still draws its network and the phase says fail, not pass', async (t) => {
  const { browser, reason } = await startBrowser();
  if (!browser) { t.skip(`no browser: ${reason}`); return; }
  await holdLock();
  const root = tempRoot('atlas-net-probe-');
  let server = null;
  try {
    mem(['init'], { root });
    buildCorpus(root, 120);
    server = await startServer(root, { outDir: root });
    const m = await measureNet({ browser, base: server.base, counters: false, writeEntry: () => memory.logEntry(root, 'learning', { title: 'probe', text: 'x' }) });
    assert.equal(m.load.drawn, 'webgl-3d', 'the page DID draw a WebGL network');
    assert.equal(m.load.counters.contexts, null);
    const v = verdicts(m);
    assert.equal(v[ID('load')], VERDICT.FAIL);
    assert.equal(v[ID('rebuild')], VERDICT.NOT_MEASURED);
  } finally {
    await browser.close();
    if (server) await server.stop();
  }
});
