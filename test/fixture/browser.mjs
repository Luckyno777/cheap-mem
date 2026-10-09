// test/fixture/browser.mjs — a readiness helper for browser probes
// (Bauplan W3, 2026-09-29; mirrors lucky-mem's test/fixture/browser.mjs).
//
// The Chromium startup logic (incl. the /opt/pw-browsers fallback) used to
// live, word for word, in more than five test files and the doc-image
// script. Every copy had to remember `after()`/`test.after()` on its own —
// one file did not, and a partial suite run hung for more than 10 minutes
// on 2026-09-29, every probe green, the process never ending.
// `startBrowser()` now registers the close itself, in exactly one place.
//
// `waitReady()` is the goto-agnostic readiness probe: NOT 'networkidle' —
// since tempo the dashboard loads parts afterwards (raw capture/post, MCP
// live probe) and polls regularly; the network never goes quiet for 30 s
// (see test/sphere-visible.test.mjs, the same reasoning repeated several
// times).
//
// `args` (2026-09-29, orchestrator finding): the fixture must NOT change
// rendering versus the pre-W3 state. Four of the five migrated cm test
// files (+ bench/docs-images.mjs) already launched with exactly the
// swiftshader args below before this change -- that stays the default.
// test/dash-fix4-tabs-visible.test.mjs launched with NO args before
// (`pw.chromium.launch()`), and with the unified swiftshader args the
// IntersectionObserver fired measurably differently: the probe went red
// (2 of 9, reproducible, orchestrator-confirmed). So: whoever calls the
// fixture picks the args -- `startBrowser({ args: [] })` for dash-fix4,
// every other caller unchanged (no argument = default).
/* global document -- these run inside the page (browser), not in Node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

// **One browser file at a time (2026-10-01).** In the full suite test files
// run in parallel; several Chromium instances plus the rest of the suite
// made browser probes miss their 30 s deadline in turn (green when run
// alone; seen in both houses). So a lock in TMPDIR (the full suite gives
// every file the same TMPDIR): whoever starts a browser waits until no other
// file holds one. A dead holder's lock is taken over; after LOCK_MAX_MS the
// file goes on without the lock (never hang).
const LOCK = path.join(os.tmpdir(), 'cheap-mem-browser.lock');
const LOCK_MAX_MS = 15 * 60 * 1000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function takeLock() {
  const until = Date.now() + LOCK_MAX_MS;
  while (Date.now() < until) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      const release = () => {
        try {
          if (fs.readFileSync(path.join(LOCK, 'pid'), 'utf8') === String(process.pid)) fs.rmSync(LOCK, { recursive: true, force: true });
        } catch { /* already gone */ }
      };
      process.once('exit', release);
      return release;
    } catch {
      let holder = NaN;
      try { holder = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8')); } catch { /* being created */ }
      if (Number.isFinite(holder) && holder > 0 && !alive(holder)) {
        try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* someone was faster */ }
        continue;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return () => {};
}

const DEFAULT_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

function loadPlaywright() {
  for (const base of [import.meta.url, '/opt/node22/lib/node_modules/']) {
    try { return createRequire(base)('playwright'); } catch { /* next place */ }
  }
  return null;
}

/**
 * The launch itself, without registering anything: `{ browser, reason, close }`.
 * `browser` is null (never an exception) when no Chromium starts; `close()` closes the browser
 * and releases the file lock. `startBrowser()` and `lazyBrowser()` build on this.
 */
export async function launchBrowser({ args = DEFAULT_ARGS } = {}) {
  const pw = loadPlaywright();
  if (!pw) return { browser: null, reason: 'playwright not installed', close: async () => {} };
  const release = await takeLock();
  let browser = null;
  try { browser = await pw.chromium.launch({ args }); } catch { /* fall through */ }
  if (!browser) {
    const p = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(p)) {
      // eslint-disable-next-line require-atomic-updates -- `browser` is local to this call, nobody else writes it
      try { browser = await pw.chromium.launch({ executablePath: p, args }); } catch { /* fall through */ }
    }
  }
  if (!browser) { release(); return { browser: null, reason: 'no startable Chromium', close: async () => {} }; }
  // `reason: false`, NOT `null` -- `test(name, { skip: null }, fn)` on
  // node:test 22.22.2 wrongly tags the TAP line "# SKIP" even though the
  // test body really runs (found 2026-09-29: "31 screens" in the log, yet
  // "ok … # SKIP", 0 pass/0 skip accounting). `false` is the only falsy
  // value that truly turns `skip` off.
  return { browser, reason: false, close: async () => { try { await browser.close(); } finally { release(); } } };
}

/**
 * Starts a real Chromium (Playwright), with a fallback to
 * /opt/pw-browsers. Returns `{ browser: null, reason }` when no instance
 * starts — never an exception that would turn the file red instead of
 * skipped. On success, registers `after(() => browser.close())` itself.
 *
 * NOT for a test file's top level: `const x = await startBrowser()` between the tests turns a
 * failing start into an anonymous "test failed" for the whole file. Use `lazyBrowser()` there
 * (test/no-top-level-await-after-test.test.mjs keeps it so).
 *
 * `args` (optional): launch WITHOUT the default swiftshader args when a
 * file launched with none before W3 (see file header) -- default
 * `undefined` means "as before", an empty array `[]` means "like
 * dash-fix4 before W3: chromium.launch() with no arguments at all".
 */
export async function startBrowser(opts = {}) {
  const h = await launchBrowser(opts);
  // Without this the browser keeps the process alive -- see file header.
  if (h.browser) after(h.close);
  return { browser: h.browser, reason: h.reason };
}

/**
 * The browser of a test file, started on first use instead of by a top-level await.
 * Call it at the top of the file (it registers its own `after()` there, synchronously).
 *
 *   const B = lazyBrowser();
 *   browserStartProbe(B);                      // one named probe that starts it (and is the red one)
 *   test('...', async (t) => { const browser = await B.need(t); if (!browser) return; ... });
 *
 * - A start that THROWS is not swallowed: the promise stays rejected, so the probe that first
 *   needs it fails with the error text and every later dependent probe fails with the same text.
 *   Nothing outside the browser probes goes red.
 * - No Chromium (`browser: null`): `need(t)` calls `t.skip(reason)` and returns null — the probe is
 *   SKIPPED with the reason visible, never green.
 * - The close (and the lock release) happens in `after()` if, and only if, a start ran.
 * `launch` is injectable for the probe in test/lazy-browser.test.mjs; real files never pass it.
 */
export function lazyBrowser({ launch = launchBrowser, pageerror = false, ...opts } = {}) {
  let started = null;
  const get = () => (started ??= Promise.resolve().then(() => launch(opts)).then((h) => { if (pageerror && h.browser) watchPageErrors(h.browser); return h; }));
  after(async () => {
    if (!started) return;
    let h;
    try { h = await started; } catch { return; }       // a failed start has nothing to close
    await h.close();
  });
  return {
    get,
    /** The browser, or null after `t.skip(reason)`; throws the start error. */
    async need(t) {
      const h = await get();
      if (!h.browser) { t.skip(h.reason || 'no browser'); return null; }
      if (pageerror) guardPageErrors(h.browser, t);
      return h.browser;
    },
    /**
     * Opt out for ONE probe, with a reason (a call without `reason` throws). Only errors that match
     * `allowed` are let through; every other uncaught page exception still turns the probe red.
     */
    allow(t, { allowed, reason }) {
      if (!(allowed instanceof RegExp) || !String(reason || '').trim()) throw new Error('allow(t, { allowed: /pattern/, reason }) needs both');
      t.diagnostic(`pageerror allowed: ${allowed} -- ${reason}`);
      (t[ALLOWED] ??= []).push(allowed);
    },
  };
}

// --- uncaught page exceptions turn the probe red (opt-in: lazyBrowser({ pageerror: true })) ---
// Cause (2026-10-09, palette-typeerror-cm): the quick search threw a TypeError in an async step after the
// ranked answer came in; the page kept running and only that block never appeared. A probe that checks
// "the hit is there" stays green next to a thrown TypeError, so the exception itself is a failure.
// Playwright's context event `weberror` carries every uncaught exception and unhandled rejection of every
// page of a context -- also for pages made by `browser.newPage()` (which makes a context itself), so the
// hook sits on `browser.newContext`. If a future Playwright built pages without it the list would stay
// empty and silent: test/fixture-pageerror.test.mjs holds a probe that a thrown error is seen.
const ERRORS = Symbol('pageErrors');
const ALLOWED = Symbol('pageErrorAllowed');
export function watchPageErrors(browser) {
  if (browser[ERRORS]) return browser[ERRORS];
  const list = (browser[ERRORS] = []);
  const make = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const ctx = await make(...a);
    ctx.on('weberror', (we) => list.push(String(we.error()?.stack || we.error()?.message || we.error()).split('\n').slice(0, 2).join(' | ')));
    return ctx;
  };
  return list;
}
/** Empties the list now and checks it when the probe `t` ends (a `t.after` hook: a throw there fails the probe). */
export function guardPageErrors(browser, t) {
  const list = watchPageErrors(browser);
  list.length = 0;
  t.after(() => {
    const allowed = t[ALLOWED] || [];
    const bad = list.filter((m) => !allowed.some((re) => re.test(m)));
    list.length = 0;
    if (bad.length) throw new Error(`pageerror: ${bad.length} uncaught exception(s) in the page: ${bad.join(' || ')}`);
  });
}

/**
 * The one test that pays the start (lock wait included) under a generous timeout of its own,
 * so the dependent probes keep their short deadlines. It is the NAMED red probe when the start throws.
 */
export function browserStartProbe(lazy, name = 'browser: Chromium starts (dependent probes are skipped with the reason when it cannot)') {
  return test(name, { timeout: LOCK_MAX_MS + 5 * 60 * 1000 }, async (t) => { await lazy.need(t); });
}

/**
 * Goto-agnostic readiness: `sections` (the tab list) exists and the
 * loading tile (`#screen .loading`) is gone. 30-second timeout.
 */
export async function waitReady(page) {
  await page.waitForFunction(
    () => typeof sections === 'object' && !document.querySelector('#screen .loading'),
    null,
    { timeout: 30000 },
  );
}

/**
 * Pay the cold start of the view server BEFORE the browser opens the page
 * (chain, 2026-10-07; mirrors lucky-mem commit 748f4b1e `waermeAnsicht`).
 *
 * **Cause.** Server and Playwright client (with the `page.route` handlers)
 * live in ONE process. The first page pays the whole cold start of the server
 * synchronously on that event loop: the first `/dashboard.json` build, the
 * part routes (raw, inbox, experiences, appointments), the gzip of the page
 * files. Everything inside the browser deadlines (`waitReady` 30 s, the
 * probe's own waits) -- and under load the cost scales 10 to 20 fold, while
 * the mocked answers wait on the same blocked loop.
 *
 * **Fix.** Make the same requests once with Node `fetch` before the page is
 * opened: caches and gzip marks are warm, the deadlines measure only the
 * page. No deadline was widened, nothing is repeated. Do NOT use it in a
 * probe that tests the cold start itself (board-tempo, dash-later).
 * `MEM_PROBE_NO_WARMUP` skips it -- only for the red proof.
 */
export async function warmView(base, { cookie = '' } = {}) {
  if (process.env.MEM_PROBE_NO_WARMUP) return;
  const head = cookie ? { cookie } : {};
  const html = await (await fetch(base + '/dashboard', { headers: head })).text();
  const ways = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]);
  const first = await fetch(base + '/dashboard.json', { headers: { 'accept-encoding': 'gzip', ...head } });
  let parts = [];
  try { parts = Object.values((await first.json()).parts || {}).map((p) => p.path).filter(Boolean); } catch { /* no parts: warm the rest */ }
  for (const way of [...ways, ...parts, '/dashboard/appointments.json']) {
    try { const r = await fetch(base + way, { headers: { 'accept-encoding': 'gzip', ...head } }); await r.arrayBuffer(); } catch { /* a warm-up is never a probe */ }
  }
}

/**
 * The view server for browser probes -- warm, ALWAYS (job browser-warm-cm, 2026-10-09; port of lucky-mem's
 * `starteAnsicht`).
 *
 * **Cause (chain 2026-10-09 16:33Z, x3c "RED on the fixed old state ...": "page.waitForFunction: Timeout
 * 30000ms exceeded." = `waitReady`).** Before this, every browser file built its server itself
 * (`mod.serve(...)`) and only four of them remembered `warmView` afterwards. The others paid the cold
 * start (first `/dashboard.json` build, the part routes, the gzip of the page files) on the first browser
 * page, inside the browser's own deadlines -- and server and Playwright client share ONE event loop, so
 * under load the whole cost lands there. Not a readiness race: `waitReady` waits for the loading tile to
 * go (a timeout, not a wrong value), and the probe's own waits for the panel are real conditions with
 * their own 15 s / 10 s text. Whoever starts the server here gets it warmed back; no probe has to
 * remember. No deadline widened, nothing repeated.
 *
 * `env`: the server's environment EXACTLY as given (no process.env, no defaults added -- pass
 * `...process.env` yourself if the file did). `serveOpts`: third argument of `serve()` (e.g.
 * `{ allowWrites: true }`). `repo`: the tree whose `bin/mem-serve` runs (default: this one). `cookie`:
 * a ready cookie header (`login.COOKIE=session`) when login is on, so the warm-up sees the dashboard and
 * not the sign-in page. `afterFile`: close at the end of the file (else the caller closes per probe).
 * `MEM_PROBE_NO_WARMUP=1` switches the warm-up off -- only for the red proof (test/browser-cold-start.test.mjs).
 * Returns `{ base, server, mod, stop }`; `stop()` can be called repeatedly.
 * Do NOT use it in a probe that measures the cold or stale state itself (board-tempo, dash-later,
 * atlas-pass, cat-confirm: see the list in test/browser-cold-start.test.mjs).
 */
export async function startView(root, env, { serveOpts, repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), cookie = '', afterFile = false } = {}) {
  const mod = await import(`${pathToFileURL(path.join(repo, 'bin', 'mem-serve')).href}?view=${Math.random()}`);
  const { server } = await (serveOpts === undefined ? mod.serve(root, env) : mod.serve(root, env, serveOpts));
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = null;
  const stop = () => (closed ??= new Promise((res) => { server.closeAllConnections?.(); server.close(res); }));
  if (afterFile) after(stop);
  try {
    await warmView(base, { cookie });
  } catch (e) {
    await stop();
    throw e;
  }
  return { base, server, mod, stop };
}
