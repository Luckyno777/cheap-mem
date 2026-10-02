#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/board-tempo.mjs — how long the dashboard takes to its first
// display and to "done" (task board-tempo-cm, 2026-10-02; the sibling's
// bench/dash-tempo.mjs).
//
// Starts bin/mem-serve from a code tree (`--repo`) against a store
// (`--root`) as its OWN child process (cold server start, empty in-memory
// cache) and measures:
//
//   server:  time until /health answers, then GET /dashboard.json (gzip):
//            time to the answer, bytes packed/unpacked, RSS afterwards.
//   browser: (with --browser) Chromium opens /, measures until the state
//            mark shows a real state (not "Loading state") and the loading
//            tile in #screen is gone (first sensible display), and until the
//            mark shows a FRESH state and no /dashboard* request has been
//            open for 1.5 s (done). `figures_ms` = the start page shows its
//            counters (not the placeholder).
//   warm:    (with --warm N) the same page N more times, server stays up.
//
// Stores: `--root <dir>` (an existing one), or `--synthetic <N>` (cm's
// bench/scale.mjs generator, removed afterwards), or `--demo` (the
// documentation demo world of bench/docs-images.mjs).
//
// `--cold-disk` drops the kernel page cache first (only if allowed;
// otherwise `pageCacheDropped: false` is in the output — never silently "cold").
//
// Output: one JSON line on stdout. Only measures; writes into the store
// nothing but what the server itself writes (start marker, derived caches,
// the head file).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const REPO = path.resolve(arg('repo', path.join(HERE, '..')));
const WITH_BROWSER = process.argv.includes('--browser');
const WARM = Number(arg('warm', '0'));
const DEADLINE_MS = Number(arg('deadline-ms', String(20 * 60 * 1000)));

const freePort = () => new Promise((ok) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const rss = (pid) => {
  try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) * 1024; } catch { return null; }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ROOT = arg('root', null);
let cleanup = () => {};
if (!ROOT && arg('synthetic', null)) {
  const { buildCorpus } = await import(pathToFileURL(path.join(REPO, 'bench/scale.mjs')).href);
  const made = buildCorpus(Number(arg('synthetic')));
  ROOT = made.root;
  cleanup = () => fs.rmSync(made.root, { recursive: true, force: true });
} else if (!ROOT && process.argv.includes('--demo')) {
  const { world } = await import(pathToFileURL(path.join(REPO, 'bench/docs-images.mjs')).href);
  ROOT = world();
  cleanup = () => fs.rmSync(ROOT, { recursive: true, force: true });
}
if (!ROOT) { console.error('need --root <dir>, --synthetic <N> or --demo'); process.exit(2); }
ROOT = path.resolve(ROOT);

let pageCacheDropped = null;
if (process.argv.includes('--cold-disk')) {
  try { fs.writeFileSync('/proc/sys/vm/drop_caches', '3\n'); pageCacheDropped = true; } catch { pageCacheDropped = false; }
}

const port = await freePort();
const env = {
  ...process.env, CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_PORT: String(port), CHEAP_MEM_SERVE_HOST: '127.0.0.1',
  MEM_RECALL_SERVER: '0',
};
delete env.CHEAP_MEM_SERVE_TOKEN;
const t0 = performance.now();
const child = spawn(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(path.join(REPO, 'bin/mem-serve')).href)}).then((m) => m.serve(${JSON.stringify(ROOT)}, process.env))`], {
  env, stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
let rssPeak = 0;
const rssClock = setInterval(() => { const r = rss(child.pid); if (r > rssPeak) rssPeak = r; }, 100);
const base = `http://127.0.0.1:${port}`;
const result = { repo: REPO, root: ROOT, pageCacheDropped };
try {
  while (true) {
    if (performance.now() - t0 > 60000) throw new Error(`server not up: ${stderr}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not yet */ }
    await wait(50);
  }
  result.up_ms = Math.round(performance.now() - t0);
  if (!WITH_BROWSER) {
    // node:http instead of fetch: fetch gives up after 300 s without
    // headers (undici headersTimeout) — the old state needs longer at 100k.
    const t1 = performance.now();
    const { gz, head } = await new Promise((ok, no) => {
      const q = http.get(`${base}/dashboard.json`, { headers: { 'accept-encoding': 'gzip' }, timeout: DEADLINE_MS }, (r) => {
        const parts = [];
        r.on('data', (b) => parts.push(b));
        r.on('end', () => ok({ gz: Buffer.concat(parts), head: r.headers }));
        r.on('error', no);
      });
      q.on('timeout', () => q.destroy(new Error('deadline passed')));
      q.on('error', no);
    });
    result.json_ms = Math.round(performance.now() - t1);
    const raw = head['content-encoding'] === 'gzip' ? zlib.gunzipSync(gz) : gz;
    result.json_bytes = raw.length;
    result.json_gzip_bytes = head['content-encoding'] === 'gzip' ? gz.length : zlib.gzipSync(raw).length;
    const d = JSON.parse(raw.toString('utf8'));
    result.cache = d.cache ?? null;
    result.entries_in_answer = Array.isArray(d.entries) ? d.entries.length : null;
    result.parts = d.parts ?? null;
    result.overview = d.overview ? { count: d.overview.count } : null;
    result.rss_after_json = rss(child.pid);
    // Afterwards: how long until the answer carries FIGURES (the head) and
    // until the full build is in (`source: build`), measured from the same t1.
    if (!process.argv.includes('--no-follow')) {
      const get = async () => { const r = await fetch(`${base}/dashboard.json`, { headers: { 'accept-encoding': 'gzip' } }); return r.json(); };
      let cur = d;
      while (performance.now() - t1 < DEADLINE_MS) {
        if (result.figures_ms === undefined && cur.overview) { result.figures_ms = Math.round(performance.now() - t1); result.figures_source = cur.cache?.source; }
        if (cur.cache?.source === 'build' && !cur.light) { result.full_ms = Math.round(performance.now() - t1); break; }
        if (cur.light && cur.cache?.source === 'build') { result.full_ms = Math.round(performance.now() - t1); result.light_only = true; break; }
        await wait(500);
        cur = await get();
      }
      result.final = { source: cur.cache?.source, light: Boolean(cur.light), state: cur.state, count: cur.overview?.count ?? null };
      result.rss_after_follow = rss(child.pid);
    }
  } else {
    const req = createRequire(import.meta.url);
    let pw = null;
    for (const b of [import.meta.url, '/opt/node22/lib/node_modules/']) { try { pw = createRequire(b)('playwright'); break; } catch { /* next */ } }
    if (!pw) { void req; throw new Error('Playwright not found'); }
    const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const measure = async (page) => {
      let open = 0;
      let lastAnswer = 0;
      const tS = performance.now();
      const isDash = (u) => /\/dashboard[./]/.test(new URL(u).pathname);
      page.on('request', (q) => { if (isDash(q.url())) open += 1; });
      const done = (q) => { if (isDash(q.url())) { open -= 1; lastAnswer = performance.now(); } };
      page.on('requestfinished', done);
      page.on('requestfailed', done);
      await page.goto(base + '/dashboard', { waitUntil: 'commit', timeout: DEADLINE_MS });
      await page.waitForFunction(() => {
        const m = document.querySelector('#stateMark')?.textContent || '';
        return /State\s/.test(m) && !/Loading state/.test(m) && !document.querySelector('#screen .loading');
      }, null, { timeout: DEADLINE_MS, polling: 50 });
      const first = Math.round(performance.now() - tS);
      // First display WITH figures: the start page shows its metrics (not the
      // placeholder "first state is being built").
      await page.waitForFunction(() => !!document.querySelector('#screen .metrics') && !/first state is being built/.test(document.querySelector('#screen')?.textContent || ''), null, { timeout: DEADLINE_MS, polling: 50 });
      const figures = Math.round(performance.now() - tS);
      let freshSince = null;
      while (performance.now() - tS < DEADLINE_MS) {
        await wait(100);
        const m = await page.evaluate(() => document.querySelector('#stateMark')?.textContent || '').catch(() => '');
        const fresh = /State\s/.test(m) && !/refreshing|not fresh|Loading state|not built/.test(m);
        if (fresh && freshSince === null) freshSince = performance.now();
        if (fresh && open <= 0 && performance.now() - lastAnswer > 1500) break;
      }
      const finished = Math.round(Math.max(lastAnswer, freshSince ?? 0, tS + first) - tS);
      page.removeAllListeners('request');
      page.removeAllListeners('requestfinished');
      page.removeAllListeners('requestfailed');
      const mark = await page.evaluate(() => document.querySelector('#stateMark')?.textContent || '');
      return { first_ms: first, figures_ms: figures, done_ms: finished, mark: mark.trim().slice(0, 140) };
    };
    // Warm = server warm and the browser cache warm (same context), a NEW
    // page each round — a reload() would let the old page's 3D scene keep
    // computing and distort the time.
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    let page = await context.newPage();
    result.cold = await measure(page);
    result.rss_after_cold = rss(child.pid);
    result.warm = [];
    for (let i = 0; i < WARM; i += 1) {
      await page.close();
      page = await context.newPage();
      result.warm.push(await measure(page));
    }
    await browser.close();
  }
  result.rss_peak = rssPeak;
} catch (e) {
  result.error = e?.message || String(e);
  result.server_stderr = stderr.slice(-800);
} finally {
  clearInterval(rssClock);
  child.kill('SIGTERM');
  cleanup();
}
process.stdout.write(`${JSON.stringify(result)}\n`);
