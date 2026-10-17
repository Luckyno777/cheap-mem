// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-net-tempo.mjs — what the 3D network of the dashboard
// CAUSES when it is built, counted instead of timed.
//
// **The phase id.** `net-tempo`, the same id the sister house (lucky-mem) uses
// (it used to call it `netz-tempo`; names confirmed 2026-10-17). The sister
// phase counts WebGL contexts, linked shader programs and model computations at
// load and at a silent reload, because in a browser with software GL each build
// costs seconds that depend on the load of the machine, and the counts do not.
//
// **What this house had to build first: the counter.** Nothing in this tree
// counted a build. bench/atlas/net-counter.mjs is that counter (see its header:
// what it counts, how it gets into the page without a change to the shipped
// script, what it does not see). This phase drives a real Chromium against a real
// `bin/mem-serve` child on a scratch memory and reads it.
//
// **Where this house differs from the sister house, and what the records ask.**
// The sister house's page redraws its network when a quiet reload brings changed
// data, and pools the canvas so that a rebuild costs no new context. This
// house's page does not redraw on a quiet reload (the no-jump rule: only a
// marker; test/no-jump*.test.mjs), and a rebuild abandons its context and makes a
// new one. So the question is asked the way this page behaves:
//
//   load      Opening the network view builds the network at most twice (once
//             from the head, once when the full list is in); every build is one
//             model computation, one context and a bounded number of programs
//             (`PROGRAMS_PER_BUILD`, plus the page's background canvas).
//   quiet     A quiet reload, with unchanged data and with changed data, builds
//             nothing: 0 builds, 0 model computations, 0 contexts, 0 programs.
//   rebuild   A draw by the person (`render()`) is exactly one build and one model
//             computation, and costs at most one context and `PROGRAMS_PER_BUILD`
//             programs (at most: a pool, as the sister house has, would make it 0).
//   reuse     A rebuild reuses the previous context: 0 new contexts, 0 new
//             programs (the sister house's pool). It does not, so the record is
//             `degraded`, not `fail`: this house never promised it, and the cost
//             (a context and a link per draw) is in the figures.
//
// **Counters, never time.** No duration is a verdict or a companion value; the
// time a build takes depends on the software GL sharing the cores.
//
// **The red probe.** With the counter switched off (`counters: false` in
// bench/atlas/net-counter.mjs) the page still draws its network, and `load` must
// say so: a page that is drawn by WebGL and a counter that saw 0 contexts is a
// broken counter, a `fail`, never a pass; the rows that need the counter are then
// `not-measured`.
//
// **Chromium.** Without one, every row is `not-measured` with that reason.
// Quick: 300 entries; full: 1500 (the counts do not depend on the size).

import { VERDICT, SEVERITY, mem, tempRoot, buildCorpus } from './core.mjs';
import { startServer, startBrowser } from './serve-world.mjs';
import { measureNet } from './net-counter.mjs';
import * as memory from '../../src/memory.mjs';

/** Shader programs one build links (the network, the hull, the labels...): measured 2026-10-17 as the rise of the program count per `render()` (5). */
export const PROGRAMS_PER_BUILD = 5;
/** Builds the opening of the network view may cost: the head, then the full list. */
export const BUILDS_ON_LOAD_MAX = 2;

const IDS = ['load', 'quiet', 'rebuild', 'reuse'];
const TITLES = {
  load: 'Opening the network builds it at most twice, one model computation, one context and a bounded number of programs per build',
  quiet: 'A quiet reload builds nothing: 0 builds, 0 model computations, 0 contexts, 0 programs',
  rebuild: 'A draw by the person is one build and one model computation, at most one context and a bounded number of programs',
  reuse: 'A rebuild reuses the previous context: 0 new contexts, 0 new programs',
};
const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

function rec(atlas, {
  id, verdict, expected, actual, evidence, measured = null, severity = SEVERITY.MAJOR,
}) {
  return atlas.record({
    id: `net-tempo.${id}`, title: TITLES[id], verdict, expected, actual: String(actual), evidence: String(evidence), measured, severity,
  });
}
function notMeasured(atlas, ids, why) {
  for (const id of ids) {
    atlas.record({
      id: `net-tempo.${id}`, title: TITLES[id], verdict: VERDICT.NOT_MEASURED, expected: 'a count', actual: 'not asked', evidence: why,
    });
  }
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const nz = (v) => v !== null && v !== undefined;

/**
 * Turn one `measureNet` result into records. Pure: the tests feed it doctored results.
 * @returns {string[]} the ids that were recorded
 */
export function judge(atlas, m) {
  const c = m.load?.counters;
  const seen = c && nz(c.contexts) && nz(c.builds);
  // The red probe: the page drew a WebGL network, the counter saw nothing.
  if (!seen || c.builds < 1 || c.contexts < 1 || c.programs < 1) {
    rec(atlas, {
      id: 'load', verdict: VERDICT.FAIL, severity: SEVERITY.MAJOR,
      expected: 'the page draws its network by WebGL (control: `#brain[data-renderer]` is set) AND the counter sees at least 1 build, 1 context and 1 program',
      actual: `drawn by: ${m.load?.drawn ?? 'nothing'}; counter: ${seen ? JSON.stringify(c) : 'not installed or silent'}`,
      evidence: 'bench/atlas/net-counter.mjs; a counter that sees nothing on a page that drew a WebGL network is a broken counter, so this is not a pass and the rows that need it say not-measured',
      measured: { load: m.load ?? null, counters: m.counters },
    });
    notMeasured(atlas, ['quiet', 'rebuild', 'reuse'], 'the load row found the counter broken or silent; nothing can be said without it');
    return IDS;
  }
  const loadOk = m.load.drawn === 'webgl-3d' && c.builds <= BUILDS_ON_LOAD_MAX && c.models >= c.builds && c.models <= c.builds
    && c.contexts <= 1 + c.builds && c.programs <= 1 + PROGRAMS_PER_BUILD * c.builds;
  rec(atlas, {
    id: 'load', verdict: loadOk ? VERDICT.PASS : VERDICT.FAIL,
    expected: `drawn by webgl-3d; 1 to ${BUILDS_ON_LOAD_MAX} builds, one model computation each; contexts <= 1 + builds (the background canvas); programs <= 1 + ${PROGRAMS_PER_BUILD} x builds`,
    actual: `drawn by ${m.load.drawn}; ${c.builds} build(s), ${c.models} model computation(s), ${c.contexts} context(s), ${c.programs} program(s)`,
    evidence: 'bench/atlas/net-counter.mjs in Chromium (software GL) against bin/mem-serve; the view is opened at #knowledge/network and left to settle (full build, full list, 1.5 s of quiet)',
    measured: { ...c, limit: { builds: BUILDS_ON_LOAD_MAX, programsPerBuild: PROGRAMS_PER_BUILD } },
  });
  const same = m.quietSame; const changed = m.quietChanged;
  const zero = (d) => d && ['builds', 'models', 'contexts', 'programs'].every((k) => d[k] === 0);
  rec(atlas, {
    id: 'quiet', verdict: m.changedSeen === true && zero(same) && zero(changed) ? VERDICT.PASS : VERDICT.FAIL,
    expected: '0 builds, 0 model computations, 0 contexts, 0 programs after a quiet reload with the same data and after one with changed data (control: the server counted the new entry)',
    actual: `same data: ${JSON.stringify(same)}; changed data${m.changedSeen === true ? '' : ' (the server NEVER showed the new entry)'}: ${JSON.stringify(changed)}`,
    evidence: 'loadData({ quiet: true }) in the page, 1.5 s of quiet after each; the rule is the no-jump rule of assets/dashboard/dashboard.js (a quiet reload only sets a marker)',
    measured: { quietSame: same, quietChanged: changed, changedSeen: m.changedSeen, countAfter: m.changedCount },
  });
  const rb = m.rebuilds ?? [];
  const rebuildOk = rb.length === 2 && rb.every((d) => d.builds === 1 && d.models === 1 && d.contexts !== null && d.contexts <= 1 && d.programs !== null && d.programs <= PROGRAMS_PER_BUILD);
  rec(atlas, {
    id: 'rebuild', verdict: rebuildOk ? VERDICT.PASS : VERDICT.FAIL,
    expected: `per render(): exactly 1 build and 1 model computation (the counter sees the draw); at most 1 new context and at most ${PROGRAMS_PER_BUILD} new programs`,
    actual: rb.map((d, i) => `draw ${i + 1}: ${JSON.stringify(d)}`).join('; '),
    evidence: 'render() called twice in the page, each followed by waiting for the new network (graphAPI back, `#brain[data-renderer]`) and 1 s of quiet',
    measured: { rebuilds: rb, limit: { programsPerBuild: PROGRAMS_PER_BUILD } },
  });
  const newContexts = sum(rb.map((d) => d.contexts ?? 0));
  const newPrograms = sum(rb.map((d) => d.programs ?? 0));
  rec(atlas, {
    id: 'reuse', verdict: rb.length === 2 && newContexts === 0 && newPrograms === 0 ? VERDICT.PASS : VERDICT.DEGRADED, severity: SEVERITY.MINOR,
    expected: '0 new contexts and 0 new programs over two rebuilds (the sister house pools the canvas and the renderer)',
    actual: `${newContexts} new context(s) and ${newPrograms} new program(s) over ${rb.length} rebuild(s)`,
    evidence: 'the same two draws as net-tempo.rebuild; graphCleanup() in assets/dashboard/dashboard.js disposes the renderer and forces the context loss, initGraph() makes a new one. Not a broken promise of this house, a cost the sister house removed (graphPool)',
    measured: { newContexts, newPrograms, rebuilds: rb.length },
  });
  return IDS;
}

export async function run(atlas, opt = {}) {
  const quick = opt.quick === true;
  const entries = quick ? 300 : 1500;
  atlas.phase('net-tempo', 'What the 3D network causes: builds, model computations, WebGL contexts and programs at load, at a quiet reload and at a redraw (counters, time not judged)',
    `Chromium (software GL) against bin/mem-serve on a scratch memory of ${entries} entries; the counter is bench/atlas/net-counter.mjs. No duration is a verdict or a companion value.`);
  const { browser, reason } = await startBrowser();
  if (!browser) {
    notMeasured(atlas, IDS, `no browser: ${reason}`);
    atlas.blind('net-tempo: the whole phase', `no Chromium: ${reason}; the network is not counted`);
    return;
  }
  const root = tempRoot('atlas-net-tempo-');
  let server = null;
  let result = null;
  let failure = null;
  try {
    const init = mem(['init'], { root });
    if (init.status !== 0) throw new Error(`mem init failed: ${short(init.stderr)}`);
    buildCorpus(root, entries);
    server = await startServer(root, { outDir: root });
    result = await measureNet({
      browser,
      base: server.base,
      writeEntry: () => { memory.logEntry(root, 'learning', { title: 'net-tempo phase: one new entry', text: 'x', tags: ['atlas-probe'] }); },
    });
  } catch (e) {
    failure = short(e?.message, 300);
  } finally {
    try { await browser.close(); } catch { /* already closed */ }
    if (server) await server.stop();
  }
  if (!result) {
    notMeasured(atlas, IDS, `the measurement did not finish: ${failure}`);
    atlas.blind('net-tempo: the whole phase', `the measurement did not finish: ${failure}`);
    return;
  }
  judge(atlas, result);
  if (result.errors?.length) atlas.blind('net-tempo: page errors', `the page raised ${result.errors.length} script error(s) during the run: ${result.errors.slice(0, 3).join(' | ')}`);
  atlas.blind('net-tempo: time', 'the build time is not a verdict and not a companion value: software GL shares the cores with everything else on the machine; the counts do not.');
  atlas.blind('net-tempo: size', `${entries} entries; the counts do not depend on the size by design, and the network of a real memory (thousands of entries, a condensed atlas above the viewer's size limit) is not entered.`);
  atlas.blind('net-tempo: optics', 'that the network LOOKS right is test/atlas-net-cm.test.mjs; this phase only counts.');
  atlas.blind('net-tempo: mode changes and tabs', 'opening, a quiet reload and a draw by `render()` are driven; the mode selector, focusing a topic, switching project or tab (also rebuilds) are not.');
  atlas.blind('net-tempo: the counter is outside the page', 'the counts come from wrappers installed around the shipped script and patches of WebGL; a build path that does not go through initGraph() or a context made off-screen would not be seen (net-counter.mjs header).');
}
