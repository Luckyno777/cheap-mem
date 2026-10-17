// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/quiet-aa-cm-browser.test.mjs - job quiet-aa-cm: the small grey text of the dashboard (colour --quiet, and
// --muted next to it) reaches WCAG AA, 4.5:1, on every surface it stands on, in the light and in the dark theme.
//
// Measure:             a real Chromium over a store with every kind of card (test/fixture/card-view-world.mjs) walks the
//                      overview and every tab of every area (the page's own `sections`), light and dark, at 1920 and 390 px.
//                      For each visible text element whose computed colour is --quiet or --muted it composites every layer
//                      under it from the computed styles, each gradient with every colour stop, and takes the worst one
//                      (test/fixture/text-contrast.mjs).
// Starting value:      the state before the branch (9a10bf6): light --quiet #617869 at 2.63 (on the dark fabric stage) to
//                      3.85 (figure tile under its hover glow) and 3.32 at the page top (the dark .content tint); light
//                      --muted 4.13 at the page top; dark --quiet #91a699 at 4.30 on a figure tile.
// Expected change:     every measured element at 4.5 or more, in both themes and both widths.
// Abort criterion:     one element below 4.5, a --quiet/--muted text under an opacity that is no disabled control (it
//                      would escape the measurement), or a theme in which the walk finds no --quiet or no --muted text.
//
// Red proof: the same walk against the dashboard.css of 9a10bf6 (git show, played in through page.route) finds elements
// below 4.5 in both themes; positive control: the same pages with the current stylesheet. The measurement itself is
// checked on a page with known colours (it must find 4.48 below and 4.54 above the line, the worst gradient stop, and name a grey text under opacity .5).
/* global document, window, localStorage, route, sections */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lazyBrowser, browserStartProbe, startView } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { buildWorld } from './fixture/card-view-world.mjs';
import { AA, fadedText, measureInPage, PAGES_IN_PAGE } from './fixture/text-contrast.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '9a10bf6940634d0b249f402139dbec1fed366ba5'; // the state before this branch (fixed, never merge-base)
const VARS = ['--quiet', '--muted'];
const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });

const B = lazyBrowser();
browserStartProbe(B);

let baseCss = null;
try { baseCss = execFileSync('git', ['-C', REPO, 'show', `${BASE}:assets/dashboard/dashboard.css`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { /* no history: the red probe skips */ }
const NO_BASE = baseCss ? false : 'base state not available in this checkout';

const ENV = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1', MEM_RECALL_SERVER: '0' };
const READY = () => typeof sections === 'object' && !document.querySelector('#screen .loading');

// One store and one view for every walk (building the store is the slow part); started on first use.
let viewStarted = null;
const sharedView = () => (viewStarted ??= (async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-quiet-aa-'));
  made.push(r);
  buildWorld(r);
  return startView(r, ENV);
})());
test.after(async () => { if (viewStarted) await (await viewStarted).stop(); });

/**
 * Walks every page in one theme and width; returns one record per page with the measured rows. `css` replaces the
 * stylesheet (the red proof).
 */
async function walk(t, { light, width, css = null }) {
  const browser = await B.need(t);
  if (!browser) return null;
  const s = await sharedView();
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  try {
    await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* no storage */ } }, light);
    const page = await ctx.newPage();
    page.setDefaultTimeout(90000);
    if (css) await page.route(/\/dashboard\/app\.css(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: css }));
    await page.goto(`${s.base}/dashboard`, { waitUntil: 'load' });
    await page.waitForFunction(READY, null, { timeout: 150000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains('light')), light, 'the theme is the one asked for');
    const pages = await page.evaluate(PAGES_IN_PAGE);
    assert.ok(pages.length >= 30, `the walk covers every tab (${pages.length})`);
    const out = [];
    for (const p of pages) {
      await page.evaluate((x) => { route(x); }, p);
      await page.waitForFunction(READY, null, { timeout: 60000 });
      // Panels reveal when they scroll into view; with reduced motion they show at once.
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 20)); } window.scrollTo(0, 0); });
      const m = await page.evaluate(measureInPage, VARS);
      out.push({ page: p, ...m });
    }
    return out;
  } finally { await ctx.close().catch(() => {}); }
}

const below = (rec) => rec.flatMap((r) => r.rows.filter((x) => x.ratio < AA).map((x) => `${r.page}: ${x.variable} ${x.color} on ${x.bg} = ${x.ratio} (${x.where} "${x.text}" ${x.size})`));
const lowest = (rec, v) => Math.min(...rec.flatMap((r) => r.rows.filter((x) => x.variable === v).map((x) => x.ratio)));
const count = (rec, v) => rec.reduce((n, r) => n + r.rows.filter((x) => x.variable === v).length, 0);

test('the measurement is right on a page with known colours (below and above the line, the worst gradient stop, a faded control apart, a faded text named)', { timeout: 120000 }, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const page = await browser.newPage();
  try {
    await page.setContent(`<style>body{margin:0;background:#fff;--a:#777777;--b:#767676;--c:#595959}</style>
      <p id="x" style="color:var(--a)">just below</p><p style="color:var(--b)">just above</p>
      <div style="background:linear-gradient(90deg,#ffffff,#cccccc)"><span style="color:var(--c)">on a gradient</span></div>
      <div style="background:rgba(0,0,0,.5)"><span style="color:var(--b)">on half black</span></div>
      <button disabled style="color:var(--b);opacity:.45;background:#fff;border:0">off</button>
      <p class="quiet" style="color:var(--b);opacity:.5">faded hint</p>`);
    const m = await page.evaluate(measureInPage, ['--a', '--b', '--c']);
    const by = Object.fromEntries(m.rows.map((r) => [r.text, r]));
    assert.equal(by['just below'].ratio, 4.48, '#777 on white');
    assert.equal(by['just above'].ratio, 4.54, '#767676 on white');
    assert.equal(by['on a gradient'].bg, '#cccccc', 'the darker stop decides');
    assert.equal(by['on a gradient'].ratio, 4.36, '#595959 on #ccc (on white it would be 7.0)');
    assert.equal(by['on half black'].bg, '#808080', 'a translucent layer is composited over what is below');
    assert.equal(m.faded.length, 2, 'the disabled button and the faded hint are listed apart');
    assert.equal(m.rows.length, 4);
    // RED for the page probes below: a grey text under opacity .5 that is no disabled control is named, not dropped.
    assert.deepEqual(fadedText(m).map((x) => x.replace(/ \(.*$/, '')), [': --b under opacity 0.5']);
  } finally { await page.close(); }
});

for (const width of [1920, 390]) {
  for (const light of [false, true]) {
    const theme = light ? 'light' : 'dark';
    test(`${theme} theme at ${width} px: every --quiet and --muted text on every page reaches ${AA}:1`, { timeout: 600000 }, async (t) => {
      const rec = await walk(t, { light, width });
      if (!rec) return;
      for (const v of VARS) assert.ok(count(rec, v) > 50, `the walk found ${v} text (${count(rec, v)} elements)`);
      t.diagnostic(`lowest: --quiet ${lowest(rec, '--quiet')}, --muted ${lowest(rec, '--muted')} over ${rec.length} pages`);
      assert.deepEqual(below(rec), []);
      // A grey text under an opacity is not measured; only a disabled control may stand there.
      assert.deepEqual(fadedText(rec), [], 'a faded --quiet/--muted text that is no disabled control escapes the measurement');
    });
  }
}

test(`RED on ${BASE.slice(0, 7)}: its stylesheet leaves --quiet below ${AA}:1 in both themes (positive control: the probes above)`, { skip: NO_BASE, timeout: 600000 }, async (t) => {
  for (const light of [true, false]) {
    const rec = await walk(t, { light, width: 1920, css: baseCss });
    if (!rec) return;
    const quiet = below(rec).filter((x) => x.includes('--quiet'));
    t.diagnostic(`${light ? 'light' : 'dark'} on the base: ${quiet.length} --quiet elements below, lowest ${lowest(rec, '--quiet')}`);
    assert.ok(quiet.length > 0, `${light ? 'light' : 'dark'}: the old --quiet falls below the line somewhere`);
    if (light) {
      assert.ok(lowest(rec, '--quiet') < 3, 'light: the old --quiet on the dark fabric stage');
      assert.ok(lowest(rec, '--muted') < AA, 'light: --muted at the page top under the dark .content tint');
    }
  }
});
