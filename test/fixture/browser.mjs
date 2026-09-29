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
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { after } from 'node:test';

const DEFAULT_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

function loadPlaywright() {
  for (const base of [import.meta.url, '/opt/node22/lib/node_modules/']) {
    try { return createRequire(base)('playwright'); } catch { /* next place */ }
  }
  return null;
}

/**
 * Starts a real Chromium (Playwright), with a fallback to
 * /opt/pw-browsers. Returns `{ browser: null, reason }` when no instance
 * starts — never an exception that would turn the file red instead of
 * skipped. On success, registers `after(() => browser.close())` itself.
 *
 * `args` (optional): launch WITHOUT the default swiftshader args when a
 * file launched with none before W3 (see file header) -- default
 * `undefined` means "as before", an empty array `[]` means "like
 * dash-fix4 before W3: chromium.launch() with no arguments at all".
 */
export async function startBrowser({ args = DEFAULT_ARGS } = {}) {
  const pw = loadPlaywright();
  if (!pw) return { browser: null, reason: 'playwright not installed' };
  let browser = null;
  try { browser = await pw.chromium.launch({ args }); } catch { /* fall through */ }
  if (!browser) {
    const p = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(p)) {
      try { browser = await pw.chromium.launch({ executablePath: p, args }); } catch { /* fall through */ }
    }
  }
  if (!browser) return { browser: null, reason: 'no startable Chromium' };
  // Without this the browser keeps the process alive -- see file header.
  after(async () => { await browser.close(); });
  // `reason: false`, NOT `null` -- `test(name, { skip: null }, fn)` on
  // node:test 22.22.2 wrongly tags the TAP line "# SKIP" even though the
  // test body really runs (found 2026-09-29: "31 screens" in the log, yet
  // "ok … # SKIP", 0 pass/0 skip accounting). `false` is the only falsy
  // value that truly turns `skip` off.
  return { browser, reason: false };
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
