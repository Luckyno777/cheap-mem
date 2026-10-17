// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/atlas-net-tempo-logic.test.mjs — the LOGIC half of the `net-tempo` atlas phase (atlas-neue-phasen-cm):
// `judge()` on doctored results, and the page-side counter run in a vm with a fake page. It needs no browser,
// so it runs everywhere and is what the mutation sweep judges (the browser half is
// test/atlas-net-tempo-probe.test.mjs and is skipped, as a whole, where there is no Chromium).
//
// The red probe lives here: a counter that saw nothing on a page that drew a WebGL network turns
// `net-tempo.load` into a `fail` and the other three rows into `not-measured`; builds above the bound, a quiet
// reload that builds, a draw that computes the model twice are each a `fail`; a pool (0 new contexts) is `pass`
// on `reuse`. The page-side wrapper and the context counter are run on a fake page and must count exactly.
//
// Red proof (bench/mutation.mjs, "ATLAS-NET ..."): the wrapper that no longer wraps `initGraph`, the context
// counter that counts a canvas twice, the bound on builds raised, a judge that reads a silent counter as a
// pass, a quiet check that looks at one counter only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';
import * as phase from '../bench/atlas/phase-net-tempo.mjs';
import { SCRIPT_WRAPPER, installContextCounter, delta } from '../bench/atlas/net-counter.mjs';

const ID = (k) => `net-tempo.${k}`;
const none = { builds: 0, models: 0, contexts: 0, programs: 0 };
const good = () => ({
  counters: true,
  load: { counters: { contexts: 2, programs: 6, builds: 1, models: 1 }, drawn: 'webgl-3d' },
  quietSame: { ...none },
  quietChanged: { ...none },
  changedSeen: true,
  changedCount: 301,
  rebuilds: [{ contexts: 1, programs: 5, builds: 1, models: 1 }, { contexts: 1, programs: 5, builds: 1, models: 1 }],
  errors: [],
});
const judged = (m) => {
  const atlas = new Atlas({ label: 'net-judge' });
  atlas.phase('net-tempo', 't');
  phase.judge(atlas, m);
  return Object.fromEntries(atlas.phases[0].records.map((r) => [r.id, r]));
};
const verdicts = (m) => Object.fromEntries(Object.entries(judged(m)).map(([k, r]) => [k, r.verdict]));

test('judge on a result like this tree\'s: load, quiet and rebuild pass; reuse is degraded (no pool here)', () => {
  assert.deepEqual(verdicts(good()), {
    [ID('load')]: VERDICT.PASS, [ID('quiet')]: VERDICT.PASS, [ID('rebuild')]: VERDICT.PASS, [ID('reuse')]: VERDICT.DEGRADED,
  });
});

test('judge: the load row says the same thing for one build and for two (a race decides which; --compare must not see a change)', () => {
  const one = good();
  one.load.counters = { contexts: 2, programs: 6, builds: 1, models: 1 };
  const two = good();
  two.load.counters = { contexts: 3, programs: 11, builds: 2, models: 2 };
  const a = judged(one)[ID('load')]; const b = judged(two)[ID('load')];
  assert.equal(a.actual, b.actual);
  assert.match(a.actual, /per build 1 model computation\(s\), 1 context\(s\), 5 program\(s\), plus 1 context and 1 program for the background canvas/);
  assert.deepEqual([a.verdict, b.verdict], [VERDICT.PASS, VERDICT.PASS]);
  assert.notDeepEqual(a.measured.builds, b.measured.builds, 'the raw counts stay in `measured`');
  // and it still tells a real change: a build that costs two contexts reads differently
  const heavy = good();
  heavy.load.counters = { contexts: 3, programs: 6, builds: 1, models: 1 };
  assert.notEqual(judged(heavy)[ID('load')].actual, a.actual);
  const three = good();
  three.load.counters = { contexts: 4, programs: 16, builds: 3, models: 3 };
  assert.match(judged(three)[ID('load')].actual, /NO \(3\)/);
});

test('judge: two builds on load are inside the bound (the head, then the full list); three are not', () => {
  const two = good();
  two.load.counters = { contexts: 3, programs: 11, builds: 2, models: 2 };
  assert.equal(verdicts(two)[ID('load')], VERDICT.PASS);
  const three = good();
  three.load.counters = { contexts: 4, programs: 16, builds: 3, models: 3 };
  assert.equal(verdicts(three)[ID('load')], VERDICT.FAIL);
  const moreModels = good();
  moreModels.load.counters = { contexts: 2, programs: 6, builds: 1, models: 2 };
  assert.equal(verdicts(moreModels)[ID('load')], VERDICT.FAIL, 'a model computed twice for one build');
  const manyContexts = good();
  manyContexts.load.counters = { contexts: 5, programs: 6, builds: 1, models: 1 };
  assert.equal(verdicts(manyContexts)[ID('load')], VERDICT.FAIL, 'more contexts than the background canvas plus one per build');
  const manyPrograms = good();
  manyPrograms.load.counters = { contexts: 2, programs: 12, builds: 1, models: 1 };
  assert.equal(verdicts(manyPrograms)[ID('load')], VERDICT.FAIL);
});

test('RED PROBE: a counter that saw nothing on a page that drew a WebGL network is a fail, and the rows that need it are not-measured', () => {
  for (const [name, load] of [
    ['switched off (nulls)', { counters: { contexts: null, programs: null, builds: null, models: null }, drawn: 'webgl-3d' }],
    ['silent (zeros)', { counters: { contexts: 0, programs: 0, builds: 0, models: 0 }, drawn: 'webgl-3d' }],
    ['no builds seen', { counters: { contexts: 2, programs: 6, builds: 0, models: 0 }, drawn: 'webgl-3d' }],
    ['no contexts seen', { counters: { contexts: 0, programs: 6, builds: 1, models: 1 }, drawn: 'webgl-3d' }],
  ]) {
    const m = good();
    m.load = load;
    assert.deepEqual(verdicts(m), {
      [ID('load')]: VERDICT.FAIL, [ID('quiet')]: VERDICT.NOT_MEASURED, [ID('rebuild')]: VERDICT.NOT_MEASURED, [ID('reuse')]: VERDICT.NOT_MEASURED,
    }, name);
  }
  const off = good();
  off.counters = false;
  off.load = { counters: { contexts: null, programs: null, builds: null, models: null }, drawn: 'webgl-3d' };
  const r = judged(off)[ID('load')];
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.match(r.actual, /webgl-3d/);
  assert.match(r.evidence, /broken counter/);
});

test('judge: a page that did not draw by WebGL does not pass', () => {
  const m = good();
  m.load.drawn = null;
  assert.equal(verdicts(m)[ID('load')], VERDICT.FAIL);
});

test('judge: a quiet reload that builds, computes or makes a context is a fail; so is one where the server never showed the new entry', () => {
  for (const key of ['builds', 'models', 'contexts', 'programs']) {
    const same = good();
    same.quietSame = { ...none, [key]: 1 };
    assert.equal(verdicts(same)[ID('quiet')], VERDICT.FAIL, `same data, ${key}`);
    const changed = good();
    changed.quietChanged = { ...none, [key]: 1 };
    assert.equal(verdicts(changed)[ID('quiet')], VERDICT.FAIL, `changed data, ${key}`);
  }
  const unseen = good();
  unseen.changedSeen = false;
  assert.equal(verdicts(unseen)[ID('quiet')], VERDICT.FAIL, 'the control: the data must really have changed');
  const missing = good();
  missing.quietSame = { builds: null, models: null, contexts: null, programs: null };
  assert.equal(verdicts(missing)[ID('quiet')], VERDICT.FAIL, 'a counter that is not there is not a zero');
});

test('judge: a draw must be ONE build and ONE model computation, at most one context and five programs', () => {
  const twice = good();
  twice.rebuilds[1] = { contexts: 1, programs: 5, builds: 1, models: 2 };
  assert.equal(verdicts(twice)[ID('rebuild')], VERDICT.FAIL, 'the model computed twice');
  const none2 = good();
  none2.rebuilds[0] = { contexts: 1, programs: 5, builds: 0, models: 0 };
  assert.equal(verdicts(none2)[ID('rebuild')], VERDICT.FAIL, 'a draw that built nothing was not seen');
  const ctx = good();
  ctx.rebuilds[0] = { contexts: 2, programs: 5, builds: 1, models: 1 };
  assert.equal(verdicts(ctx)[ID('rebuild')], VERDICT.FAIL);
  const prog = good();
  prog.rebuilds[0] = { contexts: 1, programs: 6, builds: 1, models: 1 };
  assert.equal(verdicts(prog)[ID('rebuild')], VERDICT.FAIL);
  const one = good();
  one.rebuilds = [one.rebuilds[0]];
  assert.equal(verdicts(one)[ID('rebuild')], VERDICT.FAIL, 'two draws were asked for');
});

test('judge: a pool (no new context, no new program) passes `reuse`, and is still a rebuild of one build', () => {
  const pooled = good();
  pooled.rebuilds = [{ contexts: 0, programs: 0, builds: 1, models: 1 }, { contexts: 0, programs: 0, builds: 1, models: 1 }];
  assert.deepEqual(verdicts(pooled), {
    [ID('load')]: VERDICT.PASS, [ID('quiet')]: VERDICT.PASS, [ID('rebuild')]: VERDICT.PASS, [ID('reuse')]: VERDICT.PASS,
  });
});

test('the page-side wrapper counts calls of the two functions the script declares, and passes values through', () => {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext('function initGraph(a) { return a + 1; }\nfunction graphModel(a, b) { return a * b; }', ctx);
  vm.runInContext(SCRIPT_WRAPPER, ctx);
  assert.equal(vm.runInContext('initGraph(1) + initGraph(2) + graphModel(3, 4)', ctx), 2 + 3 + 12);
  assert.deepEqual({ ...ctx.window.__netCalls }, { initGraph: 2, graphModel: 1 });
  // A script without the functions is not an error and counts nothing.
  const bare = vm.createContext({});
  bare.window = bare;
  vm.runInContext(SCRIPT_WRAPPER, bare);
  assert.deepEqual({ ...bare.window.__netCalls }, {});
});

test('the page-side context counter counts a canvas\'s first webgl context once, not 2d, and every linked program', () => {
  const ctx = vm.createContext({});
  vm.runInContext(`
    class HTMLCanvasElement { getContext(kind) { return { kind }; } }
    class WebGLRenderingContext { linkProgram() { return 'linked1'; } }
    class WebGL2RenderingContext { linkProgram() { return 'linked2'; } }
    var window = { HTMLCanvasElement, WebGLRenderingContext, WebGL2RenderingContext };
    globalThis.window = window;`, ctx);
  vm.runInContext(`(${installContextCounter.toString()})()`, ctx);
  const out = vm.runInContext(`
    const a = new HTMLCanvasElement(); const b = new HTMLCanvasElement();
    a.getContext('webgl'); a.getContext('webgl'); a.getContext('webgl2');   // one context for canvas a
    b.getContext('2d');                                                      // none
    b.getContext('webgl2');                                                  // one for b
    const r1 = new WebGLRenderingContext().linkProgram();                    // the value passes through
    new WebGLRenderingContext().linkProgram(); new WebGL2RenderingContext().linkProgram();
    ({ gl: { ...window.__netGl }, r1 });`, ctx);
  assert.deepEqual({ ...out.gl }, { contexts: 2, programs: 3 });
  assert.equal(out.r1, 'linked1');
});

test('delta: differences per counter, and a counter that is not installed stays null instead of becoming 0', () => {
  assert.deepEqual(delta({ contexts: 1, programs: 5, builds: 1, models: 1 }, { contexts: 2, programs: 10, builds: 2, models: 2 }), { contexts: 1, programs: 5, builds: 1, models: 1 });
  assert.deepEqual(delta({ contexts: null, programs: null, builds: null, models: null }, { contexts: null, programs: null, builds: null, models: null }), { contexts: null, programs: null, builds: null, models: null });
  assert.equal(delta({ contexts: 1, programs: 1, builds: null, models: 1 }, { contexts: 1, programs: 1, builds: 3, models: 1 }).builds, null);
});
