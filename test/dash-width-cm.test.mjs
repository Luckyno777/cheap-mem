// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/dash-width-cm.test.mjs - on a desktop the dashboard uses the whole width (Lucky, 2026-10-12;
// parity with lucky-mem dash-breite-lm, commit 21c669dd2).
//
// Finding: `main{max-width:1700px;margin:0 auto}` (since the data layer, c5c7c90). At 1920 px the column next to
// the sidebar is 1696 px, so the cap did not show; at 2560 px it left 636 px empty (main 1700 of 2336). Reading
// text inside cards ran to 208 characters per line at 1920 px, and the setting inputs to 1608 px.
//
// Measure:             width of `main` in a real Chromium (1920x1080, 2560x1440) in ten views; sideways overflow;
//                      longest reading line (`.row p`) in characters; widest setting input.
// Starting value:      main 1700 px at 2560 (measured on 0bf3ae5); `.row p` up to 208 ch at 1920; inputs 1608 px.
// Expected change:     main fills the column next to the sidebar (1696 / 2336 px), no sideways overflow; reading text
//                      in cards stays at 110 characters; setting inputs at most 720 px; at 390/720/950/1280 px
//                      unchanged (main = column, no overflow).
// Abort criterion:     main narrower than the column / sideways overflow anywhere / a reading line over 110 ch /
//                      an input over 720 px / 390 px worse.
//
// Positive control: the stylesheet of the FIXED old commit 0bf3ae5 (never merge-base) is played into the same page
// through page.route; there the measuring probe (2) is red (main 1700 at 2560, inputs wider than 720) while the
// 390 px probe (3) stays green (it says what stays the same).
/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as inbox from '../src/inbox.mjs';
import { lazyBrowser, browserStartProbe, startView, waitReady } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '0bf3ae5'; // fixed stand before the change (never merge-base: that one moves along)
const CSS = path.join(REPO, 'assets/dashboard/dashboard.css');
const css = () => fs.readFileSync(CSS, 'utf8');
const mainRule = (c) => c.match(/(?:^|})main\{([^}]*)\}/)?.[1] ?? null;
const oldCss = () => execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.css`], { encoding: 'utf8', maxBuffer: 1 << 26 });

const B = lazyBrowser();
browserStartProbe(B);

const VIEWS = {
  home: 'home', inbox: 'work/inbox', tasks: 'work/tasks', entries: 'knowledge/entries', network: 'knowledge/network',
  facts: 'knowledge/facts', settings: 'settings/system', operations: 'ops/operations', projects: 'sources/projects', access: 'settings/access',
};
const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });

function world() {
  const people = { alex: { human: true }, bot: {} };
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-width-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'width', participants: people, language: 'en' }));
  const long = 'A long reading text that goes on and on about how the dashboard lays out its cards on a wide screen. '.repeat(4);
  for (let i = 0; i < 20; i += 1) memory.logEntry(r, i % 2 ? 'learning' : 'decision', { title: `Entry ${i}`, text: long, tags: [`tag${i % 3}`], topic: `t/${i % 5}`, chose: 'a', why: long });
  inbox.write(r, people, { from: 'bot', to: 'alex', subject: 'Hello with a rather long subject line', text: long });
  return r;
}

// One server, one context per size; `oldStyle` plays the stylesheet of the fixed old commit into the page.
async function measure(browser, [w, h], { oldStyle = false, light = false } = {}) {
  const s = await startView(world(), { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0' }, { serveOpts: { allowWrites: true } });
  const out = {};
  try {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
    await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* no storage */ } }, light);
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    if (oldStyle) {
      const body = oldCss();
      await page.route(/\/dashboard\/app\.css(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body }));
    }
    for (const [name, way] of Object.entries(VIEWS)) {
      await page.goto(`${s.base}/dashboard#${way}`);
      await waitReady(page);
      out[name] = await page.evaluate(() => {
        const main = document.querySelector('main').getBoundingClientRect();
        const col = document.querySelector('.content').getBoundingClientRect();
        const chPx = (el) => {
          const cs = getComputedStyle(el);
          const probe = document.createElement('span');
          probe.style.cssText = `font:${cs.font};position:absolute;visibility:hidden`;
          probe.textContent = '0'.repeat(100);
          document.body.appendChild(probe);
          const one = probe.getBoundingClientRect().width / 100;
          probe.remove();
          return one;
        };
        const lines = [...document.querySelectorAll('.row p, .row-main p')].filter((p) => p.offsetParent).map((p) => p.getBoundingClientRect().width / chPx(p));
        const inputs = [...document.querySelectorAll('.formfield input.field, .formfield select.field')].filter((p) => p.offsetParent).map((p) => p.getBoundingClientRect().width);
        // The element edges too (not only scrollWidth): a clipped overflow would not show in scrollWidth.
        const edge = Math.max(...[...document.querySelectorAll('main .panel, main .metrics, main .pageheading, main .tabs, main .scopebar')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().right)) - innerWidth;
        return {
          edge: Math.round(edge),
          main: Math.round(main.width), col: Math.round(col.width), over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          longestLine: lines.length ? Math.round(Math.max(...lines)) : null, lineCount: lines.length,
          widestInput: inputs.length ? Math.round(Math.max(...inputs)) : null, inputCount: inputs.length,
        };
      });
    }
    await ctx.close();
  } finally { await s.stop(); }
  return out;
}

test('(1) stylesheet: main has no px cap, reading text 110 ch, setting inputs 720 px (old commit 0bf3ae5: 1700 px cap)', () => {
  assert.match(mainRule(oldCss()), /max-width:1700px/, 'positive control: the old stand caps main at 1700 px');
  const now = mainRule(css());
  assert.ok(now, 'rule main{...} not found');
  assert.match(now, /max-width:none/);
  assert.doesNotMatch(now, /max-width:\d+px/, `main is capped in px: ${now}`);
  assert.doesNotMatch(now, /margin:0 auto/, 'main no longer sits centred inside a cap');
  assert.match(css(), /\.row p,\.row-main p\{max-width:110ch\}/);
  assert.match(css(), /\.formfield input\.field,\.formfield select\.field\{max-width:720px\}/);
});

test('(2) browser: at 1920 and 2560 px main fills the column, in every main view, dark and light, no overflow; reading text and inputs stay bounded', { timeout: 600000 }, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  for (const [size, light] of [[[1920, 1080], false], [[2560, 1440], false], [[2560, 1440], true], [[1920, 1080], true]]) {
    const m = await measure(browser, size, { light });
    for (const [name, x] of Object.entries(m)) {
      const at = `${name} at ${size[0]} px ${light ? 'light' : 'dark'}`;
      assert.ok(x.over <= 0 && x.edge <= 1, `${at}: ${x.over} px sideways overflow (edges ${x.edge})`);
      assert.ok(x.main >= x.col - 1, `${at}: main ${x.main} px, the column next to the sidebar ${x.col} px`);
      if (x.longestLine !== null) assert.ok(x.longestLine <= 111, `${at}: a reading line of ${x.longestLine} characters (cap 110)`);
      if (x.widestInput !== null) assert.ok(x.widestInput <= 721, `${at}: an input of ${x.widestInput} px (cap 720)`);
    }
    assert.ok(m.home.lineCount > 0 && m.settings.inputCount > 0, 'positive control: the views carry reading text and setting inputs at all');
    assert.ok(m.settings.widestInput > 600, `positive control: the inputs are still wide (${m.settings.widestInput} px)`);
  }
});

test('(3) browser: 390/720/950/1280 px stay as they were - main is the column (390: the screen), no overflow', { timeout: 600000 }, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  for (const size of [[390, 844], [720, 900], [950, 900], [1280, 900]]) {
    for (const light of [false, true]) {
      const m = await measure(browser, size, { light });
      for (const [name, x] of Object.entries(m)) {
        const at = `${name} at ${size[0]} px ${light ? 'light' : 'dark'}`;
        assert.ok(x.over <= 0 && x.edge <= 1, `${at}: ${x.over} px sideways overflow (edges ${x.edge})`);
        assert.ok(x.main >= x.col - 1, `${at}: main ${x.main} px, column ${x.col} px`);
        if (size[0] <= 720) assert.equal(x.main, size[0], `${at}: main ${x.main} px, expected the screen width`);
      }
      if (size[0] === 390) assert.ok(m.settings.widestInput >= 300, `390 px: the setting inputs still fill the card (${m.settings.widestInput} px)`);
    }
  }
});

test('(4) red proof: the stylesheet of the old commit 0bf3ae5 in the same page - main stays at 1700 px at 2560, inputs wider than 720; 390 px identical', { timeout: 600000 }, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const wide = await measure(browser, [2560, 1440], { oldStyle: true });
  assert.equal(wide.home.main, 1700, 'old stand: main is capped at 1700 px (the probe sees the fault)');
  assert.ok(wide.home.col > 2300, 'the column is 2336 px wide, so the cap leaves a gap');
  const wide1920 = await measure(browser, [1920, 1080], { oldStyle: true });
  assert.ok(wide1920.settings.widestInput > 720, `old stand: an input of ${wide1920.settings.widestInput} px at 1920`);
  assert.ok(wide1920.home.longestLine > 110, `old stand: a reading line of ${wide1920.home.longestLine} characters at 1920`);
  const small = await measure(browser, [390, 844], { oldStyle: true });
  const now = await measure(browser, [390, 844]);
  assert.deepEqual(Object.fromEntries(Object.entries(small).map(([k, v]) => [k, [v.main, v.over, v.widestInput]])),
    Object.fromEntries(Object.entries(now).map(([k, v]) => [k, [v.main, v.over, v.widestInput]])), '390 px: old and new stylesheet measure the same');
});
