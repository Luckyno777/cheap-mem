// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard-cache.mjs — `/dashboard.json` from a cache (tempo, 2026-09-28;
// the sibling's `src/dashboard-zwischenspeicher.mjs`, same design).
//
// **The finding.** `/dashboard.json` was rebuilt from scratch on EVERY
// request (`dashboardData.collectDashboard`). Measured on a synthetic
// demo store of 2015 entries: ~0.6 s warm, ~2.4 s cold per request; the
// sibling measured 5–18 s per request on its real store of ~2560 entries.
//
// **What happens here.** The server keeps the last built result and a
// GENERATION STAMP of the store it was built from. Every request only
// recomputes the stamp (stat calls, no file opened — the same pattern as
// `backlinks.stamp()`):
//
//   - stamp equal and younger than `ttlMs` -> the cached result, `fresh`.
//   - stamp different or too old           -> the cached result, BUT marked
//     not fresh and `refreshing`; the rebuild runs in the background (its
//     own worker thread, the server stays responsive).
//   - nothing cached yet (first request after start) -> wait, build
//     synchronously, as before.
//   - small store (last build under `syncUpToMs`) -> rebuild synchronously,
//     as before: waiting costs nothing there, and the answer is fresh.
//
// **Never stale as fresh.** The response carries `cache` (`built_at`,
// `build_ms`, `fresh`, `refreshing`, `reason`). A failed background build
// leaves the old result standing, but NOT as fresh: `fresh:false` with the
// failure as `reason`, and a later request tries again.
//
// **The stamp.** Three parts, each cheap:
//   1. `backlinks.stamp()` — size+mtime of EVERY drawer file of every
//      project (a new entry always changes it),
//   2. the git state: a stat on the reflog of HEAD (every commit, pull,
//      checkout appends there) — without starting `git`,
//   3. size+mtime of the machine-local sources the dashboard reads outside
//      the drawers (PLACES below, two levels deep, files only, without the
//      derived caches in DERIVED).
// What the stamp does not see (time-dependent fields such as "today"),
// `ttlMs` catches: older than that is always rebuilt.
//
// invariant: three-states-never-two

import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import * as backlinks from './backlinks.mjs';

/** Maximum age of a cached result, even without a detected change. */
export const TTL_MS = 60 * 1000;

/**
 * Up to which build time a rebuild happens synchronously. Above it (a
 * large store) in the background. Small stores (tests, fresh installs)
 * keep exactly the old behaviour: every answer fresh.
 */
export const SYNC_UP_TO_MS = 1000;

/**
 * Minimum gap between two background builds. On a machine with many
 * running sessions the retrieval journal changes constantly; without a
 * gap one build would follow the next. In between the answer stays
 * honestly `fresh:false` with a reason.
 */
export const MIN_GAP_MS = 20 * 1000;

/** Machine-local sources of the dashboard outside the drawers (relative to the root). */
export const PLACES = Object.freeze(['.mem', 'inbox', 'agents']);

/**
 * What the stamp does NOT see: derived caches that the build itself (or a
 * read) writes — measured 2026-09-28 on an empty root: a single
 * `collectDashboard()` creates the search index. If the stamp saw them,
 * every build would count as stale at once. `ttlMs` covers them.
 */
export const DERIVED = Object.freeze(new Set([
  'search-index', 'search-index.json', 'backlinks.json', 'langbridge', 'console.json', 'answer-patterns.json',
]));
const isDerived = (name) => DERIVED.has(name) || /heartbeat/.test(name);

function statPart(p, depth, acc) {
  if (isDerived(path.basename(p))) return;
  let s;
  try { s = fs.statSync(p); } catch { return; }
  // Files only: a folder's mtime changes as soon as the build creates a
  // derived cache inside it.
  if (!s.isDirectory()) { acc.n += 1; acc.bytes += s.size; if (s.mtimeMs > acc.newest) acc.newest = s.mtimeMs; return; }
  if (depth <= 0) return;
  let names;
  try { names = fs.readdirSync(p); } catch { return; }
  for (const name of names) statPart(path.join(p, name), depth - 1, acc);
}

/** The reflog of HEAD — also in a worktree (`.git` is a file there). */
function gitPart(root) {
  let gitdir = path.join(root, '.git');
  try {
    if (fs.statSync(gitdir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitdir, 'utf8'));
      if (m) gitdir = path.resolve(root, m[1].trim());
    }
    const s = fs.statSync(path.join(gitdir, 'logs', 'HEAD'));
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'no-git';
  }
}

/** The generation stamp of the store (see the header). */
export function generationStamp(root, { places = PLACES } = {}) {
  let drawers;
  try { drawers = backlinks.stamp(root); } catch (e) { drawers = `unreadable:${e?.message || e}`; }
  const acc = { n: 0, bytes: 0, newest: 0 };
  for (const p of places) statPart(path.join(root, p), 2, acc);
  return `d=${drawers}|g=${gitPart(root)}|p=${acc.n}:${acc.bytes}:${acc.newest}`;
}

/** Run the build in a worker thread — the same call (`collectDashboard`), without blocking the server. */
export function buildInWorker(root, options = {}) {
  return new Promise((resolve, reject) => {
    // The worker runs THIS module (the branch at the end of the file) —
    // no second module, so nothing here is out of the CLI's reach.
    const w = new Worker(new URL(import.meta.url), { workerData: { dashboardCacheBuild: true, root, options } });
    w.unref();
    let done = false;
    w.once('message', (m) => {
      done = true;
      if (m?.ok) resolve(m.data); else reject(new Error(m?.reason || 'worker without a result'));
    });
    w.once('error', (e) => { if (!done) { done = true; reject(e); } });
    w.once('exit', (code) => { if (!done) { done = true; reject(new Error(`worker exited (${code}) without a result`)); } });
  });
}

/**
 * The cache. Everything adjustable is passed in, so a probe can check it
 * without a real store and without a worker.
 *
 *   build()               synchronous, for the first request / small stores
 *   buildInBackground()   a Promise, for the large store
 *   stamp()               the generation stamp
 *   afterBackgroundBuild() optional, after every background build (pre-work)
 */
export function createCache({
  build, buildInBackground, stamp, afterBackgroundBuild = null,
  ttlMs = TTL_MS, syncUpToMs = SYNC_UP_TO_MS, minGapMs = MIN_GAP_MS, now = () => Date.now(),
} = {}) {
  let current = null; // { id, data, stamp, builtMs, durationMs }
  let running = null; // Promise of the background build
  let failure = null; // reason of the last failed background build
  let lastStart = -Infinity;
  let counter = 0;

  const store = (data, s, start, durationMs) => {
    counter += 1;
    current = { id: counter, data, stamp: s, builtMs: start, durationMs };
    failure = null;
  };
  const synchronous = (s) => {
    const start = now();
    const t0 = performance.now();
    const data = build();
    store(data, s, start, Math.round(performance.now() - t0));
  };
  const background = (s) => {
    if (running) return;
    const start = now();
    if (start - lastStart < minGapMs) return;
    lastStart = start;
    const t0 = performance.now();
    running = Promise.resolve()
      .then(() => buildInBackground())
      .then((data) => { store(data, s, start, Math.round(performance.now() - t0)); })
      .catch((e) => { failure = `rebuild failed: ${e?.message || e}`; })
      .finally(() => {
        running = null;
        if (afterBackgroundBuild) { try { afterBackgroundBuild(); } catch { /* pre-work only */ } }
      });
  };

  return {
    /** The state for ONE answer. Throws only when the synchronous build throws. */
    get() {
      const s = stamp();
      if (!current) synchronous(s);
      else {
        const tooOld = now() - current.builtMs > ttlMs;
        if ((current.stamp !== s || tooOld) && !running) {
          if (current.durationMs <= syncUpToMs) synchronous(s);
          else background(s);
        }
      }
      const tooOld = now() - current.builtMs > ttlMs;
      const fresh = current.stamp === s && !tooOld && !failure;
      let reason = null;
      if (failure) reason = failure;
      else if (current.stamp !== s) reason = 'store changed since the build';
      else if (tooOld) reason = `older than ${Math.round(ttlMs / 1000)} s`;
      return {
        id: current.id,
        data: current.data,
        meta: {
          built_at: new Date(current.builtMs).toISOString(),
          build_ms: current.durationMs,
          fresh,
          refreshing: Boolean(running),
          reason,
        },
      };
    },
    /** For probes only: wait for a running background build. */
    async waitForRebuild() { if (running) await running; },
  };
}

// --- the worker thread: the background build of `/dashboard.json` ----------
// The same call as in the server (`collectDashboard`), no second version of
// the data. Runs only inside a worker started by `buildInWorker()`.
if (!isMainThread && workerData?.dashboardCacheBuild) {
  const { root, options } = workerData;
  import('./dashboard-data.mjs')
    .then((dashboardData) => {
      const data = dashboardData.collectDashboard(root, { ...options, env: options.env ?? process.env });
      parentPort.postMessage({ ok: true, data });
    })
    .catch((e) => parentPort.postMessage({ ok: false, reason: e?.message || String(e) }));
}
