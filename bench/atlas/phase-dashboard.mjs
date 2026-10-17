// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-dashboard.mjs — what the dashboard server READS and what a
// page load ASKS, counted instead of timed.
//
// **The phase id.** `dashboard`, the same id the sister house (lucky-mem) uses;
// the state of the sister phase is recorded in test/atlas-phase-parity.json.
// The 3D network of the page has its own phase, `net-tempo`.
//
// **Why a counter and not a clock.** How long the page takes to its first
// display is bench/board-tempo.mjs's question, and it depends on who else is
// running. What the server READS from the memory to answer it, and how often
// the page asks for the same thing, do not. So this phase leads with:
//
//   - lines of the entry logs the server reads per build, as passes over the
//     store (lines read / lines on disk), with bench/atlas/io-counter.mjs
//     inside the real `bin/mem-serve` child (bench/atlas/serve-world.mjs). The
//     full build runs in a worker thread; the counter adds up every row.
//   - the same for a second page load (the cache is warm), for a rebuild after
//     ONE new entry, and for the route `/desk.json` (called twice).
//   - requests of a real page load in Chromium, per route, and which route was
//     asked for more than once.
//
// **How the server rows are driven.** No browser: a replay of the page's own
// protocol over HTTP (`/dashboard`, `/dashboard.json` until the build is in,
// each deferred part once, the entries page by page), the way
// assets/dashboard/dashboard.js asks. Each scenario has its OWN server and its
// own freshly made memory (the counter writes when the child ends), so two
// scenarios are compared as differences of two deterministic counts.
// The rebuild scenario sets the cache's test switches (sync window 0, gap 0) so
// it does not wait the 20 seconds the viewer waits between two builds; the build
// is the same code.
//
// **What the expectations are.** Bounds of the design, ratchets, never wishes:
//   - a full build reads each line at most `BUILD_PASSES_MAX` times (today's
//     figure, about 29, plus a tenth); the count is the same at 300 and at 1000
//     entries, which is why it is a pass count and not a byte count;
//   - a warm page load reads nothing from the entry logs;
//   - a rebuild after one new entry costs no more than a cold build (it is a
//     full rebuild, not an incremental one: the record prints the figure);
//   - a route that rebuilds everything on each call (`/desk.json`, no page asks
//     for it) is judged against the cache the page's own data route has: a second
//     call must read less than half of the first. It does not today, which is a
//     finding (plan item TB1's counterpart in this house);
//   - a page load asks for no resource twice.
//
// **A red here is a finding, not a bug of the phase.** The two reds when the
// phase was written, `dashboard.desk` and `dashboard.requests`, are in the
// records with the line of the source behind them. The phase measures; it does
// not fix.
/* global D, entriesLoad, document -- these run inside the page (browser), not in Node */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  VERDICT, SEVERITY, REPO, mem, tempRoot, buildCorpus,
} from './core.mjs';
import {
  startServer, startBrowser, sumReads, sleep,
} from './serve-world.mjs';
import * as memory from '../../src/memory.mjs';
import { warmView } from '../../test/fixture/browser.mjs';

/** Passes over the entry logs a full build may read: today's measured 28.5 to 29.4 (300 and 1000 entries, 2026-10-17) plus a tenth. */
export const BUILD_PASSES_MAX = 32;
/** A second call of a route with a cache reads less than this share of the first. */
export const CACHED_SHARE_MAX = 0.5;

const IDS = ['build-reads', 'warm-load', 'write-rebuild', 'desk', 'requests'];
const TITLES = {
  'build-reads': 'A full build reads each line of the entry logs at most as often as the ratchet says',
  'warm-load': 'A second page load, with the cache warm, reads nothing from the entry logs',
  'write-rebuild': 'A rebuild after one new entry costs no more than a cold build',
  desk: 'A second call of /desk.json is served from a cache (reads less than half of the first)',
  requests: 'A page load asks for no resource twice',
};
const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const where = (rel, needle) => {
  try {
    const at = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').findIndex((l) => l.includes(needle));
    return at === -1 ? rel : `${rel}:${at + 1}`;
  } catch { return rel; }
};

function rec(atlas, {
  id, ok, expected, actual, evidence, measured = null, severity = SEVERITY.MAJOR, verdict = null,
}) {
  return atlas.record({
    id: `dashboard.${id}`, title: TITLES[id], verdict: verdict ?? (ok ? VERDICT.PASS : VERDICT.FAIL), expected, actual: String(actual), evidence: String(evidence), measured, severity,
  });
}
function notMeasured(atlas, ids, why) {
  for (const id of ids) {
    atlas.record({
      id: `dashboard.${id}`, title: TITLES[id], verdict: VERDICT.NOT_MEASURED, expected: 'a count', actual: 'not asked', evidence: why,
    });
  }
}

/** Lines of the entry logs on disk (`global/` and `projects/`): the unit passes are counted in. */
export function linesOnDisk(root) {
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) n += fs.readFileSync(p, 'utf8').split('\n').length - 1;
    }
  };
  for (const top of ['global', 'projects']) if (fs.existsSync(path.join(root, top))) walk(path.join(root, top));
  return n;
}

/** GET over node:http (fetch would unpack a gzip answer for us and hide the wire size). */
function httpGet(base, route) {
  return new Promise((ok, no) => {
    http.get(`${base}${route}`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const wire = Buffer.concat(parts);
        let text = '';
        try { text = (res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(wire) : wire).toString('utf8'); } catch { /* not unpackable: no text */ }
        ok({
          status: res.statusCode, wire: wire.length, text, json() { try { return JSON.parse(text); } catch { return null; } },
        });
      });
    }).on('error', no);
  });
}

/**
 * The page's own protocol over HTTP, as assets/dashboard/dashboard.js asks: the page, the data route until the full
 * build is in, each deferred part once, the entries page by page. Returns what the data route said last.
 */
export async function replayPageLoad(base) {
  await httpGet(base, '/dashboard');
  let d = null;
  for (let i = 0; i < 480; i += 1) {
    d = (await httpGet(base, '/dashboard.json')).json();
    if (d && d.cache?.source === 'build' && d.cache.fresh !== false) break;
    await sleep(250);
  }
  if (!d) return null;
  const parts = Object.keys(d.parts || {}).filter((n) => n !== 'entries' && n !== 'atlas');
  for (const n of parts) await httpGet(base, `/dashboard/part.json?part=${encodeURIComponent(n)}`);
  if (d.parts?.entries && !d.parts.entries.head_only) {
    let from = 0;
    while (from !== null && from !== undefined) {
      const j = (await httpGet(base, `/dashboard/part.json?part=entries&from=${from}&n=${d.parts.entries.page || 5000}`)).json();
      from = j?.next ?? null;
    }
  }
  return d;
}

/** Wait until the data route reports a fresh build that counts more entries than `before`. */
async function waitForWrite(base, before) {
  for (let i = 0; i < 480; i += 1) {
    const j = (await httpGet(base, '/dashboard.json')).json();
    if (j?.cache?.source === 'build' && j.cache.fresh && (j.overview?.count ?? 0) > before) return true;
    await sleep(250);
  }
  return false;
}

const TEST_SWITCHES = { CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0', CHEAP_MEM_SERVE_CACHE_GAP_TEST_MS: '0' };

/** One scenario: a fresh memory and server, `fn` drives it, the counters come back when the server ends. */
async function scenario(entries, fn, { env = {} } = {}) {
  const root = tempRoot('atlas-dashboard-');
  const init = mem(['init'], { root });
  if (init.status !== 0) throw new Error(`mem init failed: ${short(init.stderr)}`);
  buildCorpus(root, entries);
  const disk = linesOnDisk(root);
  const server = await startServer(root, { reads: true, env, outDir: root });
  let out;
  try { out = await fn({ base: server.base, root }); } finally { out = { ...(out ?? {}), stopped: await server.stop() }; }
  const reads = sumReads(out.stopped.rows);
  return {
    disk, reads, lines: reads ? reads.lines : null, passes: reads ? reads.lines / disk : null, out,
  };
}

export async function run(atlas, opt = {}) {
  const quick = opt.quick === true;
  const entries = quick ? 600 : 2000;
  atlas.phase('dashboard', 'What the dashboard server reads per build and what a page load asks for: passes over the entry logs, warm and after a write, /desk.json, requests per route (counters, no clock)',
    `bin/mem-serve as a child process on a scratch memory of ${entries} entries, read counters inside it (bench/atlas/io-counter.mjs), the page's protocol replayed over HTTP; the requests of a real page load counted in Chromium. No duration is judged.`);

  let cold; let twice; let warmBase; let rebuilt; let desk1; let desk2;
  try {
    cold = await scenario(entries, async ({ base }) => ({ d: await replayPageLoad(base) }));
    twice = await scenario(entries, async ({ base }) => { await replayPageLoad(base); await replayPageLoad(base); });
    warmBase = await scenario(entries, async ({ base }) => ({ d: await replayPageLoad(base) }), { env: TEST_SWITCHES });
    rebuilt = await scenario(entries, async ({ base, root }) => {
      const d = await replayPageLoad(base);
      memory.logEntry(root, 'learning', { title: 'dashboard phase: one new entry', text: 'x', tags: ['atlas-probe'] });
      return { waited: await waitForWrite(base, d?.overview?.count ?? 0) };
    }, { env: TEST_SWITCHES });
    desk1 = await scenario(entries, async ({ base }) => { await replayPageLoad(base); return { status: (await httpGet(base, '/desk.json')).status }; });
    desk2 = await scenario(entries, async ({ base }) => { await replayPageLoad(base); const a = await httpGet(base, '/desk.json'); const b = await httpGet(base, '/desk.json'); return { status: Math.max(a.status, b.status) }; });
  } catch (e) {
    notMeasured(atlas, IDS.filter((i) => i !== 'requests'), `a scenario could not run: ${short(e?.message)}`);
    atlas.blind('dashboard: the server rows', `a scenario could not run (${short(e?.message)}); nothing was counted`);
    await requestsRow(atlas, entries);
    namedBlindSpots(atlas, entries);
    return;
  }

  const counted = [cold, twice, warmBase, rebuilt, desk1, desk2].every((s) => s.reads !== null);
  if (!counted) {
    const why = 'the server ended without writing its counters (a platform that kills a process outright, as Windows does, never runs the exit hook); a missing counter is not a zero';
    notMeasured(atlas, IDS.filter((i) => i !== 'requests'), why);
    atlas.blind('dashboard: the server rows', why);
  } else {
    const passes = cold.passes;
    rec(atlas, {
      id: 'build-reads', ok: cold.lines > 0 && passes <= BUILD_PASSES_MAX && cold.disk >= entries,
      expected: `more than 0 lines read (positive control: the counter sees the build) and at most ${BUILD_PASSES_MAX} passes over the ${cold.disk} lines on disk`,
      actual: `${cold.lines} lines read = ${passes.toFixed(1)} passes over ${cold.disk} lines (${(cold.reads.corpusBytes / 1e6).toFixed(1)} MB), ${cold.reads.rows} counter row(s) (main thread and workers)`,
      evidence: `bench/atlas/io-counter.mjs inside bin/mem-serve, one cold page load replayed; the build is ${where('src/dashboard-cache.mjs', 'new Worker')} and ${where('src/dashboard.mjs', 'export function collect')}. 29 reads of every line is the figure the ratchet holds, not a statement that it is right`,
      measured: { lines: cold.lines, disk: cold.disk, passes: +passes.toFixed(2), corpusBytes: cold.reads.corpusBytes, rows: cold.reads.rows, limit: BUILD_PASSES_MAX },
    });
    const warmLines = twice.lines - cold.lines;
    rec(atlas, {
      id: 'warm-load', ok: cold.lines > 0 && twice.lines >= cold.lines && warmLines === 0,
      expected: 'the second of two page loads reads 0 lines of the entry logs (the difference of two scenarios on the same code; positive control: the first load read lines)',
      actual: `one load: ${cold.lines} lines, two loads: ${twice.lines} lines, the second load: ${warmLines} lines`,
      evidence: 'two scenarios, each with its own server and memory: [load] and [load, load]; the data route is answered from the cache of the first build',
      measured: { first: cold.lines, both: twice.lines, second: warmLines },
    });
    const rebuildLines = rebuilt.lines - warmBase.lines;
    const rebuildPasses = rebuildLines / rebuilt.disk;
    rec(atlas, {
      id: 'write-rebuild', ok: rebuilt.out.waited === true && rebuildLines > 0 && rebuildPasses <= BUILD_PASSES_MAX,
      expected: `the new entry shows up in a fresh build (control), and that rebuild reads at most ${BUILD_PASSES_MAX} passes (a cold build's bound); fewer than 1 pass would be an incremental rebuild`,
      actual: rebuilt.out.waited ? `${rebuildLines} lines = ${rebuildPasses.toFixed(1)} passes for one new entry (a cold build reads ${(warmBase.lines / warmBase.disk).toFixed(1)})` : 'the build never showed the new entry',
      evidence: `[load] against [load, write one entry, wait for the fresh build], both with the cache's test switches (sync window 0, gap 0) so the scenario does not wait the viewer's 20 s; ${where('bin/mem-serve', 'CHEAP_MEM_SERVE_CACHE_GAP_TEST_MS ?? 0')}`,
      measured: { rebuildLines, rebuildPasses: +rebuildPasses.toFixed(2), coldPasses: +(warmBase.lines / warmBase.disk).toFixed(2), waited: rebuilt.out.waited, limit: BUILD_PASSES_MAX },
    });
    const first = desk1.lines - cold.lines;
    const second = desk2.lines - desk1.lines;
    const share = first > 0 ? second / first : null;
    rec(atlas, {
      id: 'desk', ok: first > 0 && share !== null && share < CACHED_SHARE_MAX, severity: SEVERITY.MINOR,
      expected: `the first call reads lines (control); the second reads less than ${CACHED_SHARE_MAX * 100} % of the first (a cache, as /dashboard.json has)`,
      actual: first > 0 ? `first call ${first} lines (${(first / desk1.disk).toFixed(1)} passes), second call ${second} lines (${(share * 100).toFixed(0)} % of the first)` : 'the first call read nothing: the counter or the route is broken',
      evidence: `[load, desk] against [load] and [load, desk, desk]; ${where('bin/mem-serve', "url.pathname === '/desk.json'")} collects on every call, no page asks for the route (assets/dashboard/dashboard.js has no reference to it)`,
      measured: { first, second, share: share === null ? null : +share.toFixed(3), statuses: [desk1.out.status, desk2.out.status] },
    });
  }
  await requestsRow(atlas, entries);
  namedBlindSpots(atlas, entries);
}

// --- requests of a real page load -------------------------------------------------------------------------------

const ROUTES = ['#home', '#knowledge/entries'];

/** The route a request belongs to: the path, and the part name of a deferred part. */
export function routeOf(url, base) {
  const rest = url.startsWith(base) ? url.slice(base.length) : url;
  const [p, q = ''] = rest.split('?');
  const part = /(?:^|&)part=([a-z-]+)/.exec(q);
  return part ? `${p}?part=${part[1]}` : p;
}

/** Routes asked for more than once, from a list of request routes. */
export function duplicatesOf(routes) {
  const count = {};
  for (const r of routes) count[r] = (count[r] ?? 0) + 1;
  return Object.entries(count).filter(([, n]) => n > 1).map(([r, n]) => ({ route: r, times: n }));
}

async function requestsRow(atlas, entries) {
  const { browser, reason } = await startBrowser();
  if (!browser) {
    notMeasured(atlas, ['requests'], `no browser: ${reason}`);
    atlas.blind('dashboard: requests', `no Chromium: ${reason}; the page's own requests are not counted`);
    return;
  }
  const root = tempRoot('atlas-dashboard-b-');
  let server = null;
  try {
    mem(['init'], { root });
    buildCorpus(root, Math.min(entries, 600));
    server = await startServer(root, { outDir: root });
    // The first page must not pay the cold start of the server inside its deadline (test/browser-cold-start.test.mjs):
    // ask once for what the page asks for, over Node fetch, before the first context opens. Counts nothing of the page.
    await warmView(server.base);
    const seen = {};
    for (const hash of ROUTES) {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(120000);
        const routes = [];
        let last = Date.now();
        const failed = [];
        page.on('request', (q) => { routes.push(routeOf(q.url(), server.base)); last = Date.now(); });
        page.on('requestfinished', () => { last = Date.now(); });
        page.on('requestfailed', (q) => { failed.push(routeOf(q.url(), server.base)); last = Date.now(); });
        await page.goto(`${server.base}/dashboard${hash}`, { waitUntil: 'commit' });
        await page.waitForFunction(() => typeof D === 'object' && D?.cache?.source === 'build' && typeof entriesLoad === 'object' && entriesLoad.full && !document.querySelector('#screen .loading'), null, { timeout: 120000, polling: 100 });
        // the page is settled when nothing has been asked for during 2 seconds
        while (Date.now() - last < 2000) await sleep(100);
        seen[hash] = { total: routes.length, duplicates: duplicatesOf(routes), failed, routes: [...new Set(routes)].length };
      } finally { await context.close(); }
    }
    const dups = ROUTES.flatMap((h) => seen[h].duplicates.map((d) => `${h}: ${d.route} x${d.times}`));
    const fails = ROUTES.flatMap((h) => seen[h].failed.map((r) => `${h}: ${r}`));
    rec(atlas, {
      id: 'requests', ok: ROUTES.every((h) => seen[h].total >= 5) && !dups.length && !fails.length, severity: SEVERITY.MINOR,
      expected: 'in Chromium, each view of the page opens with at least 5 requests (control: the page was watched), none twice, none failed',
      actual: ROUTES.map((h) => `${h}: ${seen[h].total} requests for ${seen[h].routes} routes`).join('; ') + (dups.length ? `; asked twice: ${dups.join(', ')}` : '') + (fails.length ? `; failed: ${fails.join(', ')}` : ''),
      evidence: `Playwright page.on('request') from the first byte to 2 s of quiet, ${Math.min(entries, 600)} entries; the page draws once with the head and once with the full list, and ${where('assets/dashboard/dashboard.js', "if ($('#calendarView') || $('#homeDay')) calendarLoad();")} asks again at every draw`,
      measured: { views: seen },
    });
  } catch (e) {
    notMeasured(atlas, ['requests'], `the page could not be watched: ${short(e?.message)}`);
    atlas.blind('dashboard: requests', `the page could not be watched: ${short(e?.message)}`);
  } finally {
    try { await browser.close(); } catch { /* already closed */ }
    if (server) await server.stop();
  }
}

function namedBlindSpots(atlas, entries) {
  atlas.blind('dashboard: the replay is a model of the page', 'the server rows replay the page\'s protocol over HTTP; a request the real page makes and the replay does not (the appointments, the search, the entry cards) is not read-counted. The requests row watches the real page, but only the two opening views.');
  atlas.blind('dashboard: time', 'the time to the first display and to "done" is bench/board-tempo.mjs; no duration is judged here, and none is a companion value.');
  atlas.blind('dashboard: size', `${entries} entries; the pass counts are the same at 300 and 1000 (measured 2026-10-17), but the compact build and the light head the viewer switches to above its size limit (CHEAP_MEM_SERVE_FULL_BUILD_MB) are not entered.`);
  atlas.blind('dashboard: writes and sessions', 'the viewer ran without a login and without a token (loopback only), read-only; the write routes, the login and a second client are not driven.');
  atlas.blind('dashboard: workers', 'the counter adds the rows of the main thread and of the build worker; a read inside a process the server starts that did not load the counter is not seen (none is known).');
}
