// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The Today card with the part "Deadlines" and the due chip, in a real browser (Chromium via Playwright), 1920 and 390,
// dark and light (Q7, today-due-cm): the content is there, the chips are readable (WCAG AA contrast), nothing scrolls
// sideways, no write request leaves the page.
//
// RED on the fixed old state (6390925, its dashboard.js through page.route): no part "Deadlines" and no chip.
/* global document, location, localStorage, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lazyBrowser, browserStartProbe, waitReady, startView } from './fixture/browser.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '6390925';
const B = lazyBrowser();
browserStartProbe(B);
const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function startServer() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-today-due-browser-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    participants: { alex: { human: true }, 'vm-admin': 'agent' }, language: 'en', timezone: 'UTC',
  }));
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  const rows = [
    { id: 'bd000001', title: 'Send the tax papers to the accountant before the office closes for the winter break', owner: 'alex', due: day(-9) },
    { id: 'bd000002', title: 'Renew the domain', owner: 'alex', due: day(0) },
    { id: 'bd000003', title: 'Book the flights', owner: 'alex', due: day(30) },
    { id: 'bd000004', title: 'Agent task, late', owner: 'vm-admin', due: day(-3) },
    { id: 'bd000005', title: 'Agent task, due', owner: 'vm-admin', due: day(0) },
  ].map((o) => ({ ts: '2026-09-01T00:00:00Z', agent: 'human:alex', ...o }));
  fs.writeFileSync(path.join(r, 'global', 'duties.jsonl'), rows.map((o) => `${JSON.stringify(o)}\n`).join(''));
  return startView(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
}

async function open(browser, base, { width, light, oldScript = null }) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 1000 : 800 } });
  await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* none */ } }, light);
  const page = await ctx.newPage();
  const writes = [];
  page.on('request', (rq) => { if (!['GET', 'HEAD'].includes(rq.method())) writes.push(`${rq.method()} ${rq.url()}`); });
  if (oldScript) await page.route(/\/dashboard\/app\.js(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
  await page.goto(`${base}/dashboard`, { waitUntil: 'load', timeout: 60000 });
  await waitReady(page);
  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForSelector('.today-card', { timeout: 20000 });
  return { ctx, page, writes };
}

test('the Today card shows the part Deadlines and the chips, at 1920 and 390, dark and light: readable, no sideways scroll, no write request', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const srv = await startServer();
  try {
    for (const width of [1920, 390]) {
      for (const light of [false, true]) {
        const label = `${width}/${light ? 'light' : 'dark'}`;
        const { ctx, page, writes } = await open(browser, srv.base, { width, light });
        const card = await page.textContent('.today-card');
        assert.match(card, /Deadlines/, label);
        assert.match(card, /Send the tax papers/, label);
        assert.match(card, /Renew the domain/, label);
        assert.match(card, /Not addressed to you \(agents, nobody\): 2 with a due date · 1 overdue · 1 due today/, label);
        assert.doesNotMatch(card, /Agent task/, `${label}: no agent title in the card`);
        // the chips next to the decisions for the human: the words of the states
        const chips = await page.$$eval('.today-card .badge', (els) => els.map((e) => e.textContent.trim()));
        assert.ok(chips.includes('overdue'), `${label}: ${chips.join(', ')}`);
        assert.ok(chips.includes('due today'), `${label}: ${chips.join(', ')}`);
        // a due DAY is shown as written, whatever the browser's zone
        assert.match(card, new RegExp(`due ${day(-9)}`), label);
        // WCAG AA: the text of each chip against the background it sits on (alpha composited up the tree)
        const contrast = await page.evaluate(() => {
          const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lum = ({ r, g, b }) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const under = (el) => {
            const layers = [];
            for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) layers.push(c); }
            let base = { r: 255, g: 255, b: 255 };
            for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
            return base;
          };
          const out = [];
          for (const el of document.querySelectorAll('.today-card .badge')) {
            const fg = parse(getComputedStyle(el).color);
            const bg = under(el);
            const a = lum({ r: fg.r, g: fg.g, b: fg.b }); const b = lum(bg);
            out.push({ text: el.textContent.trim(), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) });
          }
          return out;
        });
        assert.ok(contrast.length >= 2, label);
        // the chips are small text (10px): AA asks 4.5
        for (const c of contrast) assert.ok(c.ratio >= 4.5, `${label}: chip "${c.text}" contrast ${c.ratio.toFixed(2)} < 4.5`);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(over <= 0, `horizontal scroll of ${over}px at ${label}`);
        assert.equal(await page.evaluate(() => document.body.classList.contains('light')), light, label);
        assert.deepEqual(writes, [], `${label}: the page made no write request`);
        await ctx.close();
      }
    }
  } finally { await srv.stop(); }
});

test(`RED on the fixed old state (${OLD}): no part Deadlines and no chip (positive control: the old page draws its Today card)`, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  let old;
  try { old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { return; }
  const srv = await startServer();
  try {
    const { ctx, page } = await open(browser, srv.base, { width: 1440, light: false, oldScript: old });
    const card = await page.textContent('.today-card');
    assert.match(card, /Decisions for you|Nothing pressing today/, 'positive control: the old card is there');
    assert.doesNotMatch(card, /Deadlines/);
    assert.deepEqual(await page.$$eval('.today-card .badge', (els) => els.map((e) => e.textContent.trim()).filter((x) => /overdue|due today/.test(x))), []);
    await ctx.close();
  } finally { await srv.stop(); }
});
