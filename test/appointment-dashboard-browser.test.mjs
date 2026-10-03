// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The Calendar tab and the "Today in the calendar" card in a real browser (Chromium via Playwright), 1920 and 390,
// dark and light: the content is there, nothing scrolls sideways, no write request leaves the page.
//
// RED on the fixed old state (24cd9a9, its dashboard.js through page.route): the tab does not exist.
/* global document, location, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as A from '../src/appointments.mjs';
import * as C from '../src/appointment-clock.mjs';
import * as tm from '../src/appointment-time.mjs';
import { startBrowser, waitReady } from './fixture/browser.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const OLD = '24cd9a9';

const { browser, reason: why } = await startBrowser();
const NEEDS = why ? { skip: why } : {};
const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

async function startServer() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-appt-browser-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ participants: { alex: { human: true }, 'vm-admin': 'agent' }, language: 'en', timezone: 'Europe/Berlin' }));
  const clock = tm.clockFor('Europe/Berlin');
  const now = Date.now();
  const f = clock.fields(now);
  const t0 = clock.wallToUtc(f.year, f.month, f.day, 0, 0);
  const human = A.actorFrom({ name: 'human:alex', authority: 'user', env: {} });
  const env = {};
  A.create(r, { title: 'Call the dentist', atMs: t0 + 23 * 3600000 + 59 * 60000, beforeMin: 15, actor: human, now: now - 86400000, env });
  A.create(r, { title: 'Check the backup', atMs: t0 + 23 * 3600000 + 30 * 60000, wake: 'vm-admin', task: 't', actor: human, now: now - 86400000, env });
  A.create(r, { title: 'Rotate credentials', atMs: t0 + 3 * 86400000, wake: 'vm-admin', task: 't', actor: { name: 'vm-admin', human: false }, now, env });
  A.create(r, { title: 'Water the plants', atMs: t0 + 2 * 86400000 + 9 * 3600000, repeat: 'weekly', actor: human, now, env });
  C.tick(r, { now, env });
  const mod = await import(`${pathToFileURL(SERVE).href}?cal=${Math.random()}`);
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

async function open(base, { width, light, oldScript = null }) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 1000 : 800 } });
  await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* none */ } }, light);
  const page = await ctx.newPage();
  const writes = [];
  page.on('request', (rq) => { if (!['GET', 'HEAD'].includes(rq.method())) writes.push(`${rq.method()} ${rq.url()}`); });
  if (oldScript) await page.route(/\/dashboard\/app\.js(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
  await page.goto(`${base}/dashboard`, { waitUntil: 'load', timeout: 60000 });
  await waitReady(page);
  return { ctx, page, writes };
}

test('the Calendar tab and the overview card show the appointments, at 1920 and 390, dark and light, with no sideways scroll and no write request', NEEDS, async () => {
  const srv = await startServer();
  try {
    for (const width of [1920, 390]) {
      for (const light of [false, true]) {
        const { ctx, page, writes } = await open(srv.base, { width, light });
        await page.evaluate(() => { location.hash = '#home'; });
        await page.waitForSelector('#calendarToday .row', { timeout: 20000 });
        const card = await page.textContent('#calendarToday');
        assert.match(card, /Today in the calendar/);
        assert.match(card, /Call the dentist|Check the backup/);
        await page.evaluate(() => { location.hash = '#work/calendar'; });
        await page.waitForSelector('#calendarView .metrics', { timeout: 20000 });
        const text = await page.textContent('#calendarView');
        for (const must of ['Waiting for you', 'Rotate credentials', 'mem appointment confirm', '--authority user', 'Scheduled agent actions', 'Calendar outlet', 'Water the plants']) {
          assert.ok(text.includes(must), `${width}/${light ? 'light' : 'dark'}: '${must}' missing`);
        }
        assert.match(await page.textContent('nav.tabs button.active'), /Calendar/);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(over <= 0, `horizontal scroll of ${over}px at ${width} (${light ? 'light' : 'dark'})`);
        assert.equal(await page.evaluate(() => document.body.classList.contains('light')), light);
        assert.deepEqual(writes, [], 'the page made no write request');
        await ctx.close();
      }
    }
  } finally { await srv.stop(); }
});

test(`RED on the fixed old state (${OLD}): no Calendar tab (positive control: the old page loads and has its other tabs)`, NEEDS, async () => {
  let old;
  try { old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { return; }
  const srv = await startServer();
  try {
    const { ctx, page } = await open(srv.base, { width: 1440, light: false, oldScript: old });
    await page.evaluate(() => { location.hash = '#work/inbox'; });
    await page.waitForSelector('nav.tabs');
    const tabs = await page.$$eval('nav.tabs button', (bs) => bs.map((b) => b.textContent.trim()));
    assert.ok(tabs.includes('Inbox') && tabs.includes('Agents'), `positive control: the old page has its tabs (${tabs.join(', ')})`);
    assert.ok(!tabs.includes('Calendar'), 'the old page has no Calendar tab');
    await ctx.close();
  } finally { await srv.stop(); }
});
