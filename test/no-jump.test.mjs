// test/no-jump.test.mjs — the dashboard no longer jumps back while it
// quietly refetches in the background (task no-jump, 2026-09-29; mirrors
// lucky-mem's test/kein-springen.test.mjs).
//
// **The finding.** `loadData()` hangs its own quiet refetch timer: when the
// server's cache is not fresh (practically always on the VM — the store is
// written every few minutes), it calls `loadData({quiet:true})` every
// 5-20 s and ALWAYS `render()` afterwards. render() replaces #screen
// entirely: scroll, open <details>, inputs, selection and the 3-D
// knowledge-space scene were thrown away on every quiet refetch.
//
// **The fix.** loadData() never draws by itself any more. Only direct
// user actions (which still do it explicitly) draw; the background timer
// and the new visibilitychange call do not. A quiet change instead shows
// an unobtrusive marker in the header ("New data · refresh") — only when
// the content REALLY changed (a content key that excludes cache metadata,
// the build timestamp, the MCP live probe and the bridge tile's relative
// line). Clicking it draws and hides it; any navigation hides it anyway
// (render() shows the newest state regardless).
//
// **How this probe ever sees a non-fresh answer.** With a tiny test store
// the cache always builds synchronously and is therefore immediately
// fresh on every answer (see the "small store" positive control in
// test/dashboard-cache.test.mjs) — a real "not fresh" cycle would
// otherwise need thousands of entries or minutes of waiting. Two TEST-ONLY
// switches (no effect in normal operation, since bin/mem-serve only reads
// them when set):
//   CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS=0  -> forces the cache's background
//     path (otherwise syncUpToMs=1000 ms) and removes the minimum gap
//     between two background builds (otherwise 20 s).
//   CHEAP_MEM_SERVE_TEMPO_TEST_MS=<ms>     -> shortens the dashboard
//     script's 5000/20000 ms intervals.
//
// Red proof against the FIXED commit dc155d0 (cheap-mem main before this
// change): its `assets/dashboard/dashboard.js` literally contains, inside
// loadData()'s refetch timer, `if (await loadData({ quiet: true }))
// render();` — EXACTLY the line that causes the jump (refetchTimer/
// render() with no condition). Proven twice below: structurally (the line
// is present at the pinned commit, gone at the current state) and
// behaviourally (the very same call, run against the CURRENT global
// functions, throws away scroll/details/the 3-D marker — see GREEN below).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startBrowser, waitReady } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD_STATE = 'dc155d0';

const { browser, reason: REASON } = await startBrowser();

let memory;
async function root(prefix) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
  if (!memory) memory = await import(pathToFileURL(path.join(REPO, 'src', 'memory.mjs')).href);
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  for (let i = 0; i < 10; i++) {
    memory.logEntry(r, 'learning', { agent: 'builder', title: 'Entry ' + (i + 1), text: 'A short note number ' + i + '.' }, { now: new Date(t0 + i * 3600e3) });
  }
  return r;
}
async function withServer(r, env, run) {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?t=${Math.random()}`);
  const { server } = await mod.serve(r, {
    ...process.env, CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0',
    CHEAP_MEM_SERVE_TOKEN: '', ...env,
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((res) => { server.closeAllConnections?.(); server.close(res); });
  }
}
async function pageReady(page, base) {
  await page.goto(base + '/dashboard', { waitUntil: 'load' });
  // 'load' + the loading marker gone, NOT 'networkidle' (same reasoning as
  // test/sphere-visible.test.mjs: deferred parts and the quiet probe keep
  // the network busy otherwise).
  await waitReady(page);
}
// The VERY FIRST call to the cache is always synchronous and therefore
// always fresh (there is no prior state yet to compare a stamp against) —
// independent of the test switch. Without this "warm-up", the page would
// see its own first /dashboard.json as fresh despite SYNC_TEST_MS=0, and
// the quiet refetch timer would never be triggered at all. One fetch
// BEFORE the page's own first load, plus a write in between, makes sure
// the page's first /dashboard.json already sees "not fresh".
async function primeNotFresh(base, r) {
  await fetch(base + '/dashboard.json');
  memory.logEntry(r, 'learning', { agent: 'builder', title: 'Before the first load', text: 'invalidates the stamp before the page loads.' });
}

// --- GREEN: the actual fix -------------------------------------------------

test('no-jump: scroll, an open <details> and the 3-D canvas survive several real quiet background refetches', { skip: REASON }, async () => {
  const r = await root('cm-no-jump-green-');
  await withServer(r, {
    CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0', // forces "not fresh" instead of instant sync (tiny store)
    CHEAP_MEM_SERVE_TEMPO_TEST_MS: '250', // otherwise 5000/20000 ms — the probe does not wait 20 s
  }, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let dashboardFetches = 0;
    page.on('request', (req) => { if (req.url().includes('/dashboard.json')) dashboardFetches += 1; });
    let running = true;
    // Must start BEFORE the page's first load (see the reasoning above):
    // only a response that is already non-fresh gets a refetch timer
    // scheduled at all, and once a response comes back fresh, nothing
    // automatically polls again — the writer has to keep the store
    // changing while the probe waits, like the real VM's continuous
    // writes, only faster.
    const writer = (async () => {
      let n = 0;
      while (running) {
        memory.logEntry(r, 'learning', { agent: 'builder', title: 'Follow-up ' + (n += 1), text: 'While the probe waits.' });
        await new Promise((res) => setTimeout(res, 80));
      }
    })();
    try {
      await primeNotFresh(base, r);
      await pageReady(page, base);
      await page.evaluate(() => { location.hash = 'knowledge/network'; });
      await page.waitForSelector('#brain');
      await page.waitForSelector('.edge-inventory summary');
      // State a background refetch must NOT touch: scroll, an open
      // <details>, and the 3-D canvas stays the same DOM element (render()
      // would replace #screen completely).
      await page.click('.edge-inventory summary');
      await page.evaluate(() => { document.querySelector('#brain').dataset.probeMark = 'unchanged'; });
      await page.evaluate(() => window.scrollTo(0, 520));
      await page.waitForTimeout(50);
      const beforeScroll = await page.evaluate(() => window.scrollY);
      assert.ok(beforeScroll > 400, `positive control: the page really scrolls (${beforeScroll})`);
      const fetchesBefore = dashboardFetches;

      // Wait for at least two MORE quiet fetches (the task requires "at
      // least 2 refetch cycles").
      const until = Date.now() + 15000;
      while (dashboardFetches < fetchesBefore + 2 && Date.now() < until) await page.waitForTimeout(100);

      assert.ok(dashboardFetches >= fetchesBefore + 2, `at least 2 quiet background cycles (seen: ${dashboardFetches - fetchesBefore})`);
      assert.equal(await page.evaluate(() => window.scrollY), beforeScroll, 'the scroll is the same as before the background refetch');
      assert.equal(await page.evaluate(() => document.querySelector('.edge-inventory')?.open), true, 'the <details> is still open');
      assert.equal(await page.evaluate(() => document.querySelector('#brain')?.dataset.probeMark), 'unchanged', 'the same 3-D canvas — no render() replaced #screen');
      assert.deepEqual(errors, [], 'no page errors');
      // There were real changes (the writer loop above) -> the quiet
      // marker must appear.
      assert.equal(await page.evaluate(() => ((e) => !!e && getComputedStyle(e).display !== 'none')(document.getElementById('newDataMark'))), true, 'the "New data" marker appears on a real change');

      // Stop the writer now: otherwise a background cycle between the
      // click and the check below could show a new (correct) marker
      // again, which would mask this different guarantee (click hides
      // it). Wait a moment so the client has really caught up with the
      // very last write (the server still finishes building for a
      // moment with minGapMs=0 in the test) — otherwise the next,
      // already-scheduled cycle could show a real change right after the
      // click.
      running = false;
      await writer;
      await page.waitForTimeout(1500);

      // Clicking the marker draws (a user action) — afterwards it is
      // hidden again, and the canvas really was rebuilt (render()
      // replaced #screen: the same test marker is gone).
      await page.click('#newDataMark');
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => ((e) => !!e && getComputedStyle(e).display !== 'none')(document.getElementById('newDataMark'))), false, 'a click on the marker hides it again');
      assert.notEqual(await page.evaluate(() => document.querySelector('#brain')?.dataset.probeMark), 'unchanged', 'the click on the marker really draws (render()) — the old canvas is gone');
    } finally {
      running = false;
      await page.close();
    }
  });
});

test('no-jump: text typed into the search field survives while the background keeps refetching', { skip: REASON }, async () => {
  const r = await root('cm-no-jump-input-');
  await withServer(r, {
    CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0',
    CHEAP_MEM_SERVE_TEMPO_TEST_MS: '200',
  }, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let running = true;
    const writer = (async () => {
      let n = 0;
      while (running) {
        memory.logEntry(r, 'learning', { agent: 'builder', title: 'Follow-up ' + (n += 1), text: 'x' }, {});
        await new Promise((res) => setTimeout(res, 80));
      }
    })();
    try {
      await primeNotFresh(base, r);
      await pageReady(page, base);
      await page.evaluate(() => { location.hash = 'knowledge/entries'; });
      await page.waitForSelector('#entrySearch');
      await page.fill('#entrySearch', 'not submitted yet');
      await page.waitForTimeout(2500);
      running = false;
      await writer;
      assert.equal(await page.inputValue('#entrySearch'), 'not submitted yet', 'the typed text survived — no background render() replaced #screen');
    } finally {
      running = false;
      await page.close();
    }
  });
});

// --- The marker: only on a real change, never otherwise --------------------

test('no-jump: the "New data" marker appears ONLY when the content really changed', { skip: REASON }, async () => {
  const r = await root('cm-no-jump-mark-');
  await withServer(r, {}, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await pageReady(page, base);
      assert.equal(await page.evaluate(() => typeof window.loadData), 'function', 'loadData is a global function name of a classic <script> — positive control that this setup even applies');
      // No write between the calls -> the same content -> no marker.
      await page.evaluate(() => window.loadData({ quiet: true }));
      assert.equal(await page.evaluate(() => ((e) => !!e && getComputedStyle(e).display !== 'none')(document.getElementById('newDataMark'))), false, 'without a change the marker stays hidden');
      // Now a real change -> the marker must show.
      memory.logEntry(r, 'learning', { agent: 'builder', title: 'Really new', text: 'y' }, {});
      // The server's dashboard cache may still answer with the previous
      // build for a moment (it rebuilds in the background) — under a full
      // suite that moment is long enough to fail a single refetch (seen
      // 2026-09-29). The guarantee is "the marker appears once the served
      // content changed", so refetch quietly until it does, bounded.
      let shown = false;
      for (const until = Date.now() + 20000; Date.now() < until && !shown;) {
        await page.evaluate(() => window.loadData({ quiet: true }));
        shown = await page.evaluate(() => ((e) => !!e && getComputedStyle(e).display !== 'none')(document.getElementById('newDataMark')));
        if (!shown) await page.waitForTimeout(250);
      }
      assert.equal(shown, true, 'after a real change the marker appears');
    } finally {
      await page.close();
    }
  });
});

test('no-jump: a quiet refetch alone (without render()) does not replace #screen', { skip: REASON }, async () => {
  const r = await root('cm-no-jump-alone-');
  await withServer(r, {}, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await pageReady(page, base);
      await page.evaluate(() => { document.querySelector('#screen').dataset.probeMark = 'unchanged'; });
      memory.logEntry(r, 'learning', { agent: 'builder', title: 'Really new 2', text: 'z' }, {});
      await page.evaluate(() => window.loadData({ quiet: true }));
      assert.equal(await page.evaluate(() => document.querySelector('#screen')?.dataset.probeMark), 'unchanged', 'loadData({quiet:true}) alone does not draw — exactly the old bug');
    } finally {
      await page.close();
    }
  });
});

// --- Point 4: paused while the tab is not visible ---------------------------

test('no-jump: no quiet refetch timer while the tab is not visible; exactly one call on becoming visible', { skip: REASON }, async () => {
  const r = await root('cm-no-jump-visible-');
  await withServer(r, {
    CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0',
    CHEAP_MEM_SERVE_TEMPO_TEST_MS: '150',
  }, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let dashboardFetches = 0;
    page.on('request', (req) => { if (req.url().includes('/dashboard.json')) dashboardFetches += 1; });
    try {
      await primeNotFresh(base, r);
      await pageReady(page, base);
      // Let one cycle get going, then simulate "not visible".
      memory.logEntry(r, 'learning', { agent: 'builder', title: 'Before hidden', text: 'a' }, {});
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // Hide first, then count: a tick that started BEFORE hiding (150 ms
      // test interval) is allowed and must not count as "fetch while
      // hidden" (cm suite red 2026-09-29, 5 instead of 4). If the product
      // keeps scheduling after that answer, the 700 ms check below still
      // catches it.
      await page.waitForTimeout(300);
      const fetchesBeforePause = dashboardFetches;
      memory.logEntry(r, 'learning', { agent: 'builder', title: 'While hidden', text: 'b' }, {});
      await page.waitForTimeout(700); // well beyond the test interval (150 ms)
      assert.equal(dashboardFetches, fetchesBeforePause, 'no fetch while the tab is not visible');
      // Becoming visible -> EXACTLY ONE immediate, quiet fetch (the normal
      // interval may keep going afterwards if that answer is still not
      // fresh — that is not a second "immediate" call, just the usual
      // cadence; check shortly AFTER the immediate call but BEFORE the
      // next tick, 150 ms later).
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(60);
      assert.equal(dashboardFetches, fetchesBeforePause + 1, 'exactly one fetch immediately on becoming visible');
    } finally {
      await page.close();
    }
  });
});

// --- RED: structural proof against the pinned old state --------------------

test(`RED on the old state (${OLD_STATE}): the refetch timer calls render() unconditionally after every quiet reload`, (t) => {
  let oldScript;
  try {
    oldScript = execFileSync('git', ['show', `${OLD_STATE}:assets/dashboard/dashboard.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    t.skip(`Commit ${OLD_STATE} not reachable (shallow clone?) — red proof unknown, not green`);
    return;
  }
  assert.match(oldScript, /if \(await loadData\(\{ quiet: true \}\)\) render\(\);/, 'the old state calls render() after EVERY quiet reload — including from the background timer');
  // Positive control: the same text no longer exists at the CURRENT state
  // (it was replaced by the unconditional call without render()).
  const newScript = fs.readFileSync(path.join(REPO, 'assets/dashboard/dashboard.js'), 'utf8');
  assert.doesNotMatch(newScript, /refetchTimer = 0;\s*\n\s*if \(await loadData\(\{ quiet: true \}\)\) render\(\);/, 'at the current state the background timer no longer calls render() unconditionally');
});

test('RED behaviour, run directly: exactly the old line (reconstructed) throws away scroll/details/the 3-D marker', { skip: REASON }, async () => {
  // This probe does NOT run the old dashboard.js (the server/assets are at
  // the current state) — it runs, word for word, the same statement
  // sequence that stood in the pinned old state's refetch timer (see the
  // test above: `if (await loadData({ quiet: true })) render();`), against
  // the CURRENT global functions `loadData`/`render`. It shows: EXACTLY
  // this construction (the old code's condition/order) destroys
  // scroll/details/the 3-D marker — the fix above addresses that by no
  // longer running this line from the timer (see the render() calls in
  // the current script, which the timer no longer touches).
  const r = await root('cm-no-jump-redbehaviour-');
  await withServer(r, {}, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await pageReady(page, base);
      await page.evaluate(() => { location.hash = 'knowledge/network'; });
      await page.waitForSelector('#brain');
      await page.waitForSelector('.edge-inventory summary');
      await page.click('.edge-inventory summary');
      await page.evaluate(() => { document.querySelector('#brain').dataset.probeMark = 'unchanged'; });
      // The old line, word for word:
      await page.evaluate(async () => { if (await window.loadData({ quiet: true })) window.render(); });
      // render() replaces #screen entirely — the <details> is FRESHLY
      // built afterwards (edgeInventory-equivalent sets no `open`), the
      // old 3-D canvas is a different DOM element. Both are the visible
      // jump.
      assert.equal(await page.evaluate(() => document.querySelector('.edge-inventory')?.open), false, 'red proof: the open <details> was thrown away and freshly (closed) rebuilt');
      assert.notEqual(await page.evaluate(() => document.querySelector('#brain')?.dataset.probeMark), 'unchanged', 'red proof: the 3-D canvas was replaced');
    } finally {
      await page.close();
    }
  });
});

