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
// **After a write (cat-confirm-cm, 2026-10-03).** A click that finished (a
// task) calls `invalidate()`: the stored state counts as stale (`fresh:false`,
// reason "a write finished since the build"), the next build starts WITHOUT the
// minimum gap, and a build that began before the call does not make it fresh
// (it may have read before the write). Without it a reload right after a click
// got the old state back for up to max(20 s, 4 x build time).
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
// `ttlMs` catches: older than that is always rebuilt. The age counts from
// the END of the build (board-tempo-cm): counted from its start, a build
// that takes longer than the TTL would be "too old" the moment it finishes,
// never fresh, and the next rebuild would follow at once.
//
// **Cold start (board-tempo-cm, 2026-10-02).** After a restart the memory
// is empty, and the first request used to wait for the WHOLE build (35 s
// at 100k entries, growing with the store). Now:
//   - a head from the last run lies on disk (`fromDisk`, see
//     dashboard-head.mjs) -> answer at once with it, `fresh:false`,
//     `source:'disk'`, and rebuild in the background;
//   - otherwise, with a small store (`syncAllowed`: drawers under
//     `SYNC_UP_TO_BYTES`) -> synchronously as before (probes, fresh installs);
//   - otherwise -> a placeholder (`source:'placeholder'`, state unknown with
//     a reason) and the build in the background: first the quick head
//     (`buildHead`, seconds, `source:'head'`), then the full build.
// A head from disk, a quick head and a placeholder are NEVER fresh.
//
// invariant: three-states-never-two

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frozenSet } from './frozenset.mjs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as backlinks from './backlinks.mjs';
import * as memory from './memory.mjs';
import * as archive from './archive.mjs';

/** How often the parent checks the build worker's heap against its cap (ms). */
const GUARD_MS = 100;

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

/**
 * Up to this size of the drawers (bytes) a cold start WITHOUT a stored head
 * may build synchronously. A real store (a few MB of drawers, seconds of
 * build) lies above it and gets the placeholder; probes (a few KB) stay
 * synchronous and at once fresh.
 */
export const SYNC_UP_TO_BYTES = 1024 * 1024;

/**
 * Highest heap of the build worker (MB). The full build keeps the whole
 * store in memory; without a cap a store that is too large would take the
 * WHOLE server down (OOM in the process). With the cap only the worker
 * fails — the server keeps answering with the last head and says why.
 *
 * **Measured 2026-10-02 (Node 22.22): `resourceLimits.maxOldGenerationSizeMb`
 * alone does NOT hold here.** A worker with a 64 MB limit that allocates
 * objects ran on to 2 GB and more, until the process-wide limit (8 GB) — the
 * limit it was handed is not enforced for object-heavy work. So the cap is
 * ALSO enforced by the parent: it asks the worker for its heap every
 * `GUARD_MS` (`worker.getHeapStatistics()` answers even while the worker
 * computes) and terminates it over the cap. The `resourceLimits` stay as a
 * second line for runtimes that do honour them.
 */
export const WORKER_HEAP_MB = Math.max(512, Math.min(4096, Math.floor(os.totalmem() / 1024 / 1024 / 2)));

/** Machine-local sources of the dashboard outside the drawers (relative to the root). */
export const PLACES = Object.freeze(['.mem', 'inbox', 'agents']);

/**
 * What the stamp does NOT see: derived caches that the build itself (or a
 * read) writes — measured 2026-09-28 on an empty root: a single
 * `collectDashboard()` creates the search index. If the stamp saw them,
 * every build would count as stale at once. `ttlMs` covers them.
 */
export const DERIVED = frozenSet([
  'search-index', 'search-index.json', 'backlinks.json', 'langbridge', 'console.json', 'answer-patterns.json',
  // board-tempo-cm: the head the server itself lays down after every build.
  'dashboard-head.json',
]);
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

/**
 * Bytes of the store, by `stat` only: the drawers, the archive manifest and
 * the archived shard files (`shardarchive.mjs`). `null` for a part = not
 * measurable. NOT through `backlinks.stamp`: that sees the drawers only, and
 * an archived store would read as small.
 *
 * `build` is what the full build reads (drawers + manifest): the archived
 * shards cost it nothing, so they count into `total` (what the head reports)
 * but NOT into the decision whether the full build still runs.
 */
export function storeBytes(root, { env = process.env } = {}) {
  const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  try {
    let drawers = 0;
    for (const project of [null, ...memory.listProjects(root)]) {
      for (const type of Object.keys(memory.TYPES)) {
        try { drawers += size(memory.logPath(root, type, project)); } catch { /* unknown project name */ }
      }
    }
    const manifest = size(path.join(root, 'archive-manifest.jsonl'));
    let shards = 0;
    try {
      const dir = path.join(archive.readConfig(env, root).location, 'shards');
      for (const name of fs.readdirSync(dir)) shards += size(path.join(dir, name));
    } catch { /* no archive: no shards */ }
    return { drawers, manifest, shards, build: drawers + manifest, total: drawers + manifest + shards };
  } catch { return null; }
}

/**
 * Run the build in a worker thread — the same call (`collectDashboard`),
 * without blocking the server. `options.kind === 'head'` builds only the
 * light head (dashboard-head.mjs). The heap is capped (`WORKER_HEAP_MB`).
 */
export async function buildInWorker(root, options = {}, { heapMb = WORKER_HEAP_MB, guardMs = GUARD_MS } = {}) {
  // The worker imports the data module fresh; without this it would
  // measure ITS OWN start as "the code at start" and `stale` could never
  // be true. This (server) process's start head goes along.
  const { codeHeadAtStart } = await import('./dashboard-data.mjs');
  const headAtStart = codeHeadAtStart();
  return new Promise((resolve, reject) => {
    // The worker runs THIS module (the branch at the end of the file) —
    // no second module, so nothing here is out of the CLI's reach.
    const w = new Worker(new URL(import.meta.url), {
      workerData: { dashboardCacheBuild: true, root, options, codeHeadAtStart: headAtStart },
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    });
    w.unref();
    let done = false;
    // The parent's guard (see WORKER_HEAP_MB): over the cap -> terminate, reject.
    // It starts only when the worker reports `ready` (the modules are loaded):
    // `terminate()` in the middle of the evaluation of an ES module crashed V8
    // on Node 22.22 ("Check failed: (location_) != nullptr", measured
    // 2026-10-02). The worker starts its build one turn later (see the end of
    // this file), so the guard never meets a module that is still being evaluated.
    let guard = null;
    const startGuard = () => {
      if (guard || done || typeof w.getHeapStatistics !== 'function') return;
      guard = setInterval(async () => {
        try {
          const h = await w.getHeapStatistics();
          if (!done && h.used_heap_size > heapMb * 1024 * 1024) {
            done = true;
            clearInterval(guard);
            reject(new Error(`the build used more than its ${heapMb} MB memory cap (worker stopped)`));
            w.terminate();
          }
        } catch { /* the worker is gone: its exit/error event reports it */ }
      }, guardMs);
      guard.unref();
    };
    w.on('message', (m) => {
      if (m?.ready) { startGuard(); return; }
      if (done) return;
      done = true;
      clearInterval(guard);
      if (m?.ok) resolve(m.data); else reject(new Error(m?.reason || 'worker without a result'));
    });
    w.once('error', (e) => { clearInterval(guard); if (!done) { done = true; reject(e); } });
    w.once('exit', (code) => { clearInterval(guard); if (!done) { done = true; reject(new Error(`worker exited (${code}) without a result`)); } });
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
 *   fromDisk()            optional, the head of the last run
 *                         ({data, stamp, builtMs, durationMs}) or null — cold start only
 *   syncAllowed()         optional, may a cold start without a stored head build synchronously
 *   placeholder()         optional, the data for "nothing built yet"
 *   buildHead()           optional, a Promise: a quick partial build (the head)
 *                         that runs BEFORE the full build while only the
 *                         placeholder stands — counts as `source:'head'`, never fresh
 */
export function createCache({
  build, buildInBackground, stamp, afterBackgroundBuild = null,
  fromDisk = () => null, syncAllowed = () => true,
  placeholder = () => ({ state: 'unknown', reasons: ['not built yet'] }), buildHead = null,
  ttlMs = TTL_MS, syncUpToMs = SYNC_UP_TO_MS, minGapMs = MIN_GAP_MS, now = () => Date.now(),
} = {}) {
  let current = null; // { id, data, stamp, builtMs, durationMs, source: 'build'|'disk'|'placeholder'|'head' }
  let running = null; // Promise of the background build
  let failure = null; // reason of the last failed background build
  let lastStart = -Infinity;
  let counter = 0;
  // cat-confirm-cm: a write finished since the last build that the stamp does not see (a click on "confirm
  // project": projects/<p>/facts.yaml lies in no stamped place). Holds until a build STARTS after the write.
  let invalidSince = null;
  let invalidCounter = 0;

  const store = (data, s, start, durationMs, source = 'build') => {
    counter += 1;
    current = { id: counter, data, stamp: s, builtMs: start, durationMs, source };
    if (source === 'build') failure = null;
  };
  const synchronous = (s) => {
    const start = now();
    const data = build();
    store(data, s, start, Math.max(0, Math.round(now() - start)));
    invalidSince = null; // built synchronously, so after every write
  };
  const background = (s) => {
    if (running) return;
    const start = now();
    // A build that takes longer than the TTL (100k entries: ~35 s, 1M: much
    // more) would otherwise follow itself without a pause. So at most a
    // quarter of the time is spent building. 0 (probes only) stays 0.
    // After a write a person waits for the answer: no gap then.
    const gap = minGapMs > 0 && invalidSince === null ? Math.max(minGapMs, (current?.durationMs ?? 0) * 4) : 0;
    if (start - lastStart < gap) return;
    lastStart = start;
    const startedAt = invalidCounter;
    running = Promise.resolve()
      .then(async () => {
        // Only the placeholder stands: first the quick head (seconds), then
        // the full build (minutes for a large store).
        if (buildHead && current?.source === 'placeholder') {
          const t1 = now();
          try {
            // `null`: no quick head needed (a store the compact build serves is built at once).
            const h = await buildHead();
            if (h) {
              store(h, s, start, Math.max(0, Math.round(now() - t1)), 'head');
              if (afterBackgroundBuild) { try { afterBackgroundBuild(); } catch { /* pre-work only */ } }
            }
          } catch { /* the full build follows anyway */ }
        }
        return buildInBackground();
      })
      .then((data) => {
        store(data, s, start, Math.max(0, Math.round(now() - start)));
        // Only a build that BEGAN after the last write lifts the mark (an earlier one may have read before the write).
        if (invalidSince !== null && startedAt >= invalidSince) invalidSince = null;
      })
      .catch((e) => { failure = `rebuild failed: ${e?.message || e}`; })
      .finally(() => {
        running = null;
        if (afterBackgroundBuild) { try { afterBackgroundBuild(); } catch { /* pre-work only */ } }
      });
  };

  // The age counts from the END of the build (see the header).
  const age = () => now() - current.builtMs - (current.durationMs || 0);
  return {
    /** The state for ONE answer. Throws only when the synchronous build throws. */
    get() {
      const s = stamp();
      if (!current) {
        // Cold start (header): the stored head first, then synchronous only
        // for a small store, otherwise the placeholder.
        let stored = null;
        try { stored = fromDisk(); } catch { stored = null; }
        if (stored) store(stored.data, stored.stamp, stored.builtMs, stored.durationMs, 'disk');
        else if (syncAllowed()) synchronous(s);
        else store(placeholder(), null, now(), 0, 'placeholder');
        if (current.source !== 'build') background(s);
      } else {
        const tooOld = age() > ttlMs;
        if ((current.source !== 'build' || current.stamp !== s || tooOld || invalidSince !== null) && !running) {
          if (current.source === 'build' && current.durationMs <= syncUpToMs) synchronous(s);
          else background(s);
        }
      }
      const tooOld = age() > ttlMs;
      // A head from disk or a placeholder is NEVER fresh: it lacks the
      // deferred lists, and this process did not build it.
      const fresh = current.source === 'build' && current.stamp === s && !tooOld && !failure && invalidSince === null;
      let reason = null;
      if (failure) reason = failure;
      else if (current.source === 'disk') reason = 'state of the last run (from disk), rebuild running';
      else if (current.source === 'placeholder') reason = 'first build since the start is running, no stored state yet';
      else if (current.source === 'head') reason = 'head only (counters, newest entries), full build running';
      else if (current.stamp !== s) reason = 'store changed since the build';
      else if (invalidSince !== null) reason = 'a write finished since the build';
      else if (tooOld) reason = `older than ${Math.round(ttlMs / 1000)} s`;
      return {
        id: current.id,
        data: current.data,
        stamp: current.stamp,
        source: current.source,
        meta: {
          built_at: new Date(current.builtMs).toISOString(),
          build_ms: current.durationMs,
          fresh,
          refreshing: Boolean(running),
          reason,
          source: current.source,
        },
      };
    },
    /**
     * A write (a finished task) is done: the stored state counts as stale, the next build starts
     * without the minimum gap, and a build that began before this call does not make it fresh.
     */
    invalidate() { invalidCounter += 1; invalidSince = invalidCounter; lastStart = -Infinity; },
    /** For probes only: wait for a running background build. */
    async waitForRebuild() { if (running) await running; },
  };
}

// --- the worker thread: the background build of `/dashboard.json` ----------
// The same call as in the server (`collectDashboard`), no second version of
// the data. Runs only inside a worker started by `buildInWorker()`.
//
// `options.kind`: 'head' (the light head), 'compact' (the compact build,
// src/dashboard-compact.mjs), 'atlasPage' (one page of the condensed atlas,
// src/dashboard-pass.mjs), otherwise the full build.
//
// The build starts one turn AFTER the modules are loaded and `ready` is
// reported (`setImmediate`), not inside the evaluation of this module: the
// parent stops a worker over its memory cap, and `terminate()` in the middle
// of an ES module's evaluation crashed V8 on Node 22.22 (see buildInWorker).
if (!isMainThread && workerData?.dashboardCacheBuild) {
  const { root, options } = workerData;
  const { kind } = options;
  Promise.all([
    import('./dashboard-data.mjs'),
    import('./dashboard-head.mjs'),
    kind === 'compact' ? import('./dashboard-compact.mjs') : null,
    kind === 'atlasPage' ? Promise.all([import('./dashboard-pass.mjs'), import('./injection.mjs')]) : null,
  ])
    .then(([dashboardData, dashboardHead, compact, atlas]) => {
      parentPort.postMessage({ ready: true });
      setImmediate(() => {
        try {
          const { kind: _kind, ...rest } = options;
          let data;
          if (kind === 'head') data = dashboardHead.lightHead(root, rest);
          else if (kind === 'compact') data = compact.collectCompact(root, { ...rest, env: rest.env ?? process.env });
          else if (kind === 'atlasPage') {
            const [pass, injection] = atlas;
            const recall = dashboardData.recallCount(root, { read: injection.read });
            data = pass.atlasSearch(root, { ...rest, recall });
          } else data = dashboardData.collectDashboard(root, { ...rest, env: rest.env ?? process.env });
          parentPort.postMessage({ ok: true, data });
        } catch (e) {
          parentPort.postMessage({ ok: false, reason: e?.message || String(e) });
        }
      });
    })
    .catch((e) => parentPort.postMessage({ ok: false, reason: e?.message || String(e) }));
}
