// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/browser-fresh.test.mjs - every page navigation of the browser probes first brings the view server's state up
// to date (job fresh-cm, 2026-10-10; mirrors lucky-mem's test/browser-frisch.test.mjs; model: test/browser-cold-start.test.mjs).
//
// **Cause.** The server's cache holds a built state for 60 s; after that the next request rebuilds it, for a small
// store SYNCHRONOUSLY inside the Playwright client's process, and it is the page's request that pays for it inside
// the `waitReady` deadline (measurement and derivation: test/fresh-cache.test.mjs and `freshView` in
// test/fixture/browser.mjs). The warm-up at the start covers one minute only; files with many pages
// (palette-fulltext, no-jump, dash-run, ...) run longer. Instead of `fresh()` in every file: `launchBrowser` hangs
// it on `goto` and `reload` of EVERY page, and `startView` registers its view for that (`keepFresh`, default on).
//
// This file guards it:
//   1. The page asks for `/dashboard.json` itself BEFORE the navigation starts (goto and reload; a page without a
//      view, a stopped view, `keepFresh: false` and the probe switch stay untouched).
//   2. The same with a REAL browser, through `browser.newPage()` and `context.newPage()` (without a browser:
//      visibly skipped, with the reason).
//   3. Ratchet: every test file with `.goto(` gets its pages from the fixture; `keepFresh: false` and the probe
//      switch (the file steers the cache itself) stand only in the lists below, each with a reason. The lists may only
//      SHRINK: an entry the file no longer needs is red.
// Red proof: on the fixed state b5959ed3 (without `freshPage`) the probe "state b5959ed3 is red" asserts that nothing
// called; probe 2 is red without the hook in `launchBrowser`, probe 1 without `freshPage`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as memory from '../src/memory.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { startView, freshPage, launchBrowser } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// FIXED (never `git merge-base HEAD origin/main`): the state before this change.
const OLD_STATE = 'b5959ed38a2d859a762df7da893f6ce17b0ee0cb';
const ENV = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' };

/** Files that steer the cache with the probe switch THEMSELVES (the fixture keeps nothing fresh there). */
const STEERS_ITSELF = {
  'no-jump.test.mjs': 'needs real "not fresh" answers and background builds (SYNC_TEST_MS=0): a request before the page changes the sequence',
  'cat-confirm-cm-browser.test.mjs': 'rebuilds the state after a click with SYNC_TEST_MS=0 and a long minimum gap: a request before the page would use up the build',
  'dash-package-cm-browser.test.mjs': 'one probe forces the worker lane (SYNC_TEST_MS=0, long gap) with its own server and its own sequence of states',
  'fresh-cache.test.mjs': 'calls fresh() itself and forces the synchronous lane (one-hour threshold) to measure the rebuild',
};
/** Files with `keepFresh: false` - none. New ones only with a reason. */
const NOT_FRESH = {};
/** Files with `.goto(` whose pages do NOT come from the fixture - none. */
const NOT_FIXTURE = {};

const files = () => fs.readdirSync(HERE).filter((n) => n.endsWith('.test.mjs'));
const read = (n) => fs.readFileSync(path.join(HERE, n), 'utf8');

const roots = [];
test.after(() => { for (const r of roots) removeTree(r); });
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-browser-fresh-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'fresh', participants: { alex: { human: true } }, language: 'en' }));
  memory.logEntry(r, 'learning', { title: 'Note', text: 'Body', tags: ['x'] }, { now: new Date('2026-09-01T09:00:00Z') });
  return r;
}

/** A stand-in for a page that records the order of the events. */
function stub(events, url = 'about:blank') {
  return {
    url: () => url,
    goto: async (u) => { events.push(['goto', String(u)]); },
    reload: async () => { events.push(['reload', url]); },
  };
}
/** Every `/dashboard.json` request (Node `fetch`) during `run`, in the order of the events. */
async function withFetchSpy(events, run) {
  const real = globalThis.fetch;
  globalThis.fetch = (u, ...r) => { if (/\/dashboard\.json/.test(String(u))) events.push(['fresh', String(u)]); return real(u, ...r); };
  // eslint-disable-next-line require-atomic-updates -- puts back exactly what was there before; nobody else assigns fetch meanwhile
  try { return await run(); } finally { globalThis.fetch = real; }
}

test('goto and reload of a page to a view ask for /dashboard.json first; everything else stays untouched', async () => {
  const a = await startView(world(), ENV);
  const switchView = await startView(world(), { ...ENV, CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0' });
  const off = await startView(world(), ENV, { keepFresh: false });
  try {
    const ev = [];
    await withFetchSpy(ev, async () => {
      await freshPage(stub(ev)).goto(a.base + '/dashboard#knowledge/network');
      await freshPage(stub(ev, a.base + '/dashboard')).reload();
    });
    assert.deepEqual(ev.map((e) => e[0]), ['fresh', 'goto', 'fresh', 'reload'], 'first the request, then the navigation (goto and reload)');
    for (const [name, url] of [['another address', 'http://127.0.0.1:1/x'], ['about:blank', 'about:blank'], ['probe switch', switchView.base + '/dashboard'], ['keepFresh: false', off.base + '/dashboard']]) {
      const e2 = [];
      await withFetchSpy(e2, () => freshPage(stub(e2)).goto(url));
      assert.deepEqual(e2.map((e) => e[0]), ['goto'], `${name}: no request before the navigation`);
    }
    await a.stop();
    const e3 = [];
    await withFetchSpy(e3, () => freshPage(stub(e3)).goto(a.base + '/dashboard'));
    assert.deepEqual(e3.map((e) => e[0]), ['goto'], 'stopped view: no request');
  } finally { await a.stop(); await switchView.stop(); await off.stop(); }
});

test('REAL browser: browser.newPage() and context.newPage() bring the state up to date before goto', async (t) => {
  const h = await launchBrowser();
  if (!h.browser) { t.skip(h.reason); return; }
  const a = await startView(world(), ENV);
  try {
    const context = await h.browser.newContext();
    for (const [name, make] of [['browser.newPage', () => h.browser.newPage()], ['context.newPage', () => context.newPage()]]) {
      const page = await make();
      const ev = [];
      page.on('request', (q) => { if (/\/dashboard$/.test(q.url())) ev.push(['page', q.url()]); });
      await withFetchSpy(ev, () => page.goto(a.base + '/dashboard', { waitUntil: 'commit' }));
      assert.deepEqual(ev.map((e) => e[0]).slice(0, 2), ['fresh', 'page'], `${name}: the request comes before the page's request`);
      await page.close();
    }
  } finally { await a.stop(); await h.close(); }
});

test(`state ${OLD_STATE.slice(0, 8)} is red: the fixture did not know freshPage yet`, () => {
  const old = execFileSync('git', ['-C', REPO, 'show', `${OLD_STATE}:test/fixture/browser.mjs`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.ok(!/export function freshPage/.test(old));
  assert.ok(/export function freshPage/.test(read('fixture/browser.mjs')));
});

/** The violations of one file against the ratchet (pure: name + source + lists). */
export function violationsOf(n, q, { itself = STEERS_ITSELF, notFresh = NOT_FRESH, notFixture = NOT_FIXTURE } = {}) {
  const v = [];
  if (/\.goto\(/.test(q) && !/fixture\/browser\.mjs/.test(q) && !notFixture[n]) v.push(`${n}: .goto( without pages from test/fixture/browser.mjs (list NOT_FIXTURE, with a reason)`);
  if (/keepFresh:\s*false/.test(q) && !notFresh[n]) v.push(`${n}: keepFresh: false without an entry in NOT_FRESH (with a reason)`);
  if (/CACHE_SYNC_TEST_MS/.test(q) && /startView\(/.test(q) && !itself[n]) v.push(`${n}: steers the cache itself (SYNC_TEST_MS) without an entry in STEERS_ITSELF (with a reason)`);
  return v;
}

test('Ratchet: pages come from the fixture; keepFresh: false and the probe switch only with a reason in the lists', () => {
  const own = path.basename(fileURLToPath(import.meta.url)); // it names the markers in its text
  const violations = files().filter((n) => n !== own).flatMap((n) => violationsOf(n, read(n)));
  assert.deepEqual(violations, []);
  // The lists only shrink: no entry without a reason, none the file no longer needs.
  const stale = [];
  for (const [list, name, needs] of [[STEERS_ITSELF, 'STEERS_ITSELF', (q) => /CACHE_SYNC_TEST_MS/.test(q) && /startView\(/.test(q)], [NOT_FRESH, 'NOT_FRESH', (q) => /keepFresh:\s*false/.test(q)], [NOT_FIXTURE, 'NOT_FIXTURE', (q) => /\.goto\(/.test(q)]]) {
    for (const [n, why] of Object.entries(list)) {
      if (!String(why).trim()) stale.push(`${name}: ${n} without a reason`);
      else if (!files().includes(n) || !needs(read(n))) stale.push(`${name}: ${n} does not need the entry any more - remove it`);
    }
  }
  assert.deepEqual(stale, []);
});

test('Ratchet bites (positive control): each of the violations in a stand-in is red, with an entry green', () => {
  const q = "import { x } from './fixture/browser.mjs';\nawait startView(r, { CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0' }, { keepFresh: false });";
  assert.equal(violationsOf('new.test.mjs', q).length, 2);
  assert.equal(violationsOf('new.test.mjs', q, { itself: { 'new.test.mjs': 'r' }, notFresh: { 'new.test.mjs': 'r' } }).length, 0);
  assert.equal(violationsOf('new.test.mjs', 'await page.goto(url);').length, 1);
});
