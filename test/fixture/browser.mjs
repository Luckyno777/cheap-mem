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
export function lazyBrowser({ launch = launchBrowser, ...opts } = {}) {
  let started = null;
  const get = () => (started ??= Promise.resolve().then(() => launch(opts)));
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
      return h.browser;
    },
  };
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
export async function warmView(base) {
  if (process.env.MEM_PROBE_NO_WARMUP) return;
  const html = await (await fetch(base + '/dashboard')).text();
  const ways = [...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]);
  const first = await fetch(base + '/dashboard.json', { headers: { 'accept-encoding': 'gzip' } });
  let parts = [];
  try { parts = Object.values((await first.json()).parts || {}).map((p) => p.path).filter(Boolean); } catch { /* no parts: warm the rest */ }
  for (const way of [...ways, ...parts, '/dashboard/appointments.json']) {
    try { const r = await fetch(base + way, { headers: { 'accept-encoding': 'gzip' } }); await r.arrayBuffer(); } catch { /* a warm-up is never a probe */ }
  }
}
