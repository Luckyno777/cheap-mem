// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/net-counter.mjs — the counter that makes the 3D network of the
// dashboard measurable, and the driver that reads it.
//
// **What was missing.** The page builds its network in `initGraph()`
// (assets/dashboard/dashboard.js), which takes a model from `graphModel()` and
// makes a new `THREE.WebGLRenderer` on the page's canvas: a new WebGL context
// and a link of the shader programs. In a browser with software GL that costs
// seconds under load (the sister house measured 4 to 15 s), and the page keeps
// no count of it. A stopwatch cannot tell "slow machine" from "built twice".
// Counts can.
//
// **What it counts, from outside the page** (nothing was added to the shipped
// file):
//
//   builds      calls of `initGraph()`                   (a function the script declares)
//   models      calls of `graphModel()`                   (the model computation per build)
//   contexts    `getContext('webgl'|'webgl2')` on a canvas that had none yet
//   programs    `WebGLRenderingContext.linkProgram` calls, WebGL 1 and 2
//
// The first two are two wrappers appended to the served script (a route
// handler in the browser context), the last two are patches installed before
// the page's own script runs (`addInitScript`). With `counters: false` neither
// is installed: that is the red probe of the phase (the page still draws its
// network, the counter sees nothing, and the phase must say so).
//
// **What it does NOT see.** Contexts created by something other than a canvas
// `getContext` (OffscreenCanvas), programs linked on a context created before
// the init script ran (none: it runs first), and everything that is not a
// count: how long a link took, how the network looks (test/atlas-net-cm.test.mjs
// holds the picture). It also does not count what the GPU does with a link.
import { sleep } from './serve-world.mjs';

/* global window, document, HTMLCanvasElement, D, entriesLoad, graphAPI, loadData, render, partsAllThere -- these run inside the page (browser), not in Node */

/** Appended to the served script: counts calls of the two functions the script declares. */
export const SCRIPT_WRAPPER = ';(() => { const P = (window.__netCalls = {});\n'
  + "  for (const name of ['graphModel', 'initGraph']) {\n"
  + '    const original = globalThis[name];\n'
  + "    if (typeof original !== 'function') continue;\n"
  + '    globalThis[name] = function counted(...args) { P[name] = (P[name] || 0) + 1; return original.apply(this, args); };\n'
  + '  }\n'
  + '})();\n';

/** Runs in the page before its own script: counts first contexts per canvas and linked programs. */
export function installContextCounter() {
  window.__netGl = { contexts: 0, programs: 0 };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function counted(kind, ...rest) {
    if (/webgl/.test(String(kind)) && !this.__netCounted) { this.__netCounted = true; window.__netGl.contexts += 1; }
    return getContext.call(this, kind, ...rest);
  };
  for (const K of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!K) continue;
    const link = K.prototype.linkProgram;
    K.prototype.linkProgram = function counted(...args) { window.__netGl.programs += 1; return link.apply(this, args); };
  }
}

/** The counters as they stand now. */
export function readCounters(page) {
  return page.evaluate(() => ({
    contexts: window.__netGl?.contexts ?? null,
    programs: window.__netGl?.programs ?? null,
    builds: window.__netCalls ? (window.__netCalls.initGraph ?? 0) : null,
    models: window.__netCalls ? (window.__netCalls.graphModel ?? 0) : null,
  }));
}

/** What changed between two readings. A counter that was not installed (`null`) stays `null`. */
export function delta(a, b) {
  const d = {};
  for (const k of ['contexts', 'programs', 'builds', 'models']) d[k] = a[k] === null || b[k] === null ? null : b[k] - a[k];
  return d;
}

/**
 * Open the network view of a running dashboard server and count what it does (see the file header).
 * @param {{ browser: object, base: string, writeEntry: () => void, counters?: boolean }} o
 *   `writeEntry` adds one entry to the memory behind `base` (the caller owns the memory). `counters: false` is the red probe.
 * @returns {Promise<object>} { load, quietSame, quietChanged, rebuilds: [..], changedSeen } or throws with the step that failed
 */
export async function measureNet({ browser, base, writeEntry, counters = true }) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const out = { counters };
  try {
    if (counters) {
      await context.route('**/dashboard/app.js*', async (route) => {
        const r = await route.fetch();
        await route.fulfill({ response: r, body: (await r.text()) + SCRIPT_WRAPPER });
      });
      await context.addInitScript(installContextCounter);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
    const step = async (name, fn) => { try { return await fn(); } catch (e) { throw new Error(`${name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`); } };

    await step('open the network view', () => page.goto(`${base}/dashboard#knowledge/network`, { waitUntil: 'commit' }));
    // Settled: the network is drawn by WebGL, the full build and the full list are in, every deferred part is in (the page draws once
    // more when the last of them arrives), and then nothing was counted for 2.5 seconds. The last condition is what makes "builds at
    // load" a count of a finished load; a snapshot taken between the first build and the second would be a race.
    const settled = async () => {
      await page.waitForFunction(() => typeof D === 'object' && D?.cache?.source === 'build' && typeof entriesLoad === 'object' && entriesLoad.full
        && (typeof partsAllThere !== 'function' || partsAllThere())
        && typeof graphAPI === 'object' && graphAPI !== null && !!document.querySelector('#brain')?.dataset.renderer && !document.querySelector('#screen .loading'), null, { timeout: 180000, polling: 100 });
      if (!counters) { await sleep(4000); return; }
      let last = JSON.stringify(await readCounters(page));
      let calm = Date.now();
      for (let i = 0; i < 240 && Date.now() - calm < 2500; i += 1) {
        await sleep(250);
        const now = JSON.stringify(await readCounters(page));
        if (now !== last) { last = now; calm = Date.now(); }
      }
    };
    await step('wait for the network', settled);
    const afterLoad = await readCounters(page);
    out.load = { counters: afterLoad, drawn: await page.evaluate(() => document.querySelector('#brain')?.dataset.renderer ?? null) };

    // A quiet reload with the same data: no draw by itself (the no-jump rule).
    await step('quiet reload, same data', () => page.evaluate(async () => { await loadData({ quiet: true }); }));
    await sleep(1500);
    const afterSame = await readCounters(page);
    out.quietSame = delta(afterLoad, afterSame);

    // A quiet reload after the memory changed.
    const before = await page.evaluate(() => D?.overview?.count ?? null);
    writeEntry();
    let seen = false;
    for (let i = 0; i < 480 && !seen; i += 1) {
      const j = await (await fetch(`${base}/dashboard.json`)).json();
      seen = j?.cache?.source === 'build' && j.cache.fresh && (j.overview?.count ?? 0) > (before ?? 0);
      if (!seen) await sleep(250);
    }
    out.changedSeen = seen;
    await step('quiet reload, changed data', () => page.evaluate(async () => { await loadData({ quiet: true }); }));
    await sleep(1500);
    const afterChanged = await readCounters(page);
    out.quietChanged = delta(afterSame, afterChanged);
    out.changedCount = await page.evaluate(() => D?.overview?.count ?? null);

    // A draw by the person (render()), twice: the cost of one rebuild.
    out.rebuilds = [];
    let prev = afterChanged;
    for (let i = 0; i < 2; i += 1) {
      const wanted = (prev.builds ?? 0) + 1;
      await step(`render ${i + 1}`, () => page.evaluate(() => { render(); }));
      if (counters) {
        await step(`wait for build ${i + 1}`, () => page.waitForFunction((n) => (window.__netCalls?.initGraph ?? 0) >= n && typeof graphAPI === 'object' && graphAPI !== null && !!document.querySelector('#brain')?.dataset.renderer, wanted, { timeout: 180000, polling: 100 }));
      } else {
        await step(`wait for the network ${i + 1}`, settled);
      }
      await sleep(1000);
      const now = await readCounters(page);
      out.rebuilds.push(delta(prev, now));
      prev = now;
    }
    out.errors = errors;
    return out;
  } finally {
    await context.close();
  }
}
