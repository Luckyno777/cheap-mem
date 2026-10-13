// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// card-group-cm: who a duty is OWED to decides the group, not the kind of its card. A duty of the configured human whose card is
// a replacement card (kind do-it) used to stand under "Agent work (N) - nothing for you to decide" on Today and in "Your next
// look". Real browser (Chromium via Playwright): the groups of Today, "Your next look" and the duties list, at 1920 and 390, dark
// and light; nothing scrolls sideways.
//
// RED on the fixed old state (eddad97, its dashboard.js through page.route): the human's duties with a replacement card stand
// under "Agent work". Positive control in the same probe: the old page draws both groups at all, and a duty owed to an agent
// stands under "Agent work" there as well.
/* global document, location, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lazyBrowser, browserStartProbe, waitReady, startView } from './fixture/browser.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = 'eddad97';
const B = lazyBrowser();
browserStartProbe(B);
const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const HUMAN = ['tax papers', 'Renew the domain', 'Which logo'];
const AGENT = ['Agent task, late', 'Agent task, due'];

const WORLD = [
  // two duties of the human with a REPLACEMENT card (kind do-it) ...
  { id: 'bd000001', title: 'Send the tax papers to the accountant before the office closes', owner: 'alex', due: day(-9) },
  { id: 'bd000002', title: 'Renew the domain', owner: 'alex', due: day(0) },
  // ... one with a card written on the entry (kind decide) ...
  {
    id: 'bd000003', title: 'Which logo for the release page', owner: 'alex', due: day(5),
    card_question: 'Which logo should the release page carry?', card_context: 'Two logos exist.',
    card_options: ['The round logo', 'The wide logo', 'Not now'], card_kind: 'decide',
  },
  // ... and two owed to an agent (no card is made for them).
  { id: 'bd000004', title: 'Agent task, late', owner: 'vm-admin', due: day(-3) },
  { id: 'bd000005', title: 'Agent task, due', owner: 'vm-admin', due: day(0) },
];

async function startServer(rows = WORLD) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-card-group-browser-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    participants: { alex: { human: true }, 'vm-admin': 'agent' }, language: 'en', timezone: 'UTC',
  }));
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  rows = rows.map((o, i) => ({ ts: `2026-09-01T00:0${i}:00Z`, agent: 'human:alex', ...o }));
  fs.writeFileSync(path.join(r, 'global', 'duties.jsonl'), rows.map((o) => `${JSON.stringify(o)}\n`).join(''));
  return startView(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
}

async function open(browser, base, { width, light, hash, oldScript = null, ready }) {
  const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 1000 : 800 } });
  await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* none */ } }, light);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const writes = [];
  page.on('request', (rq) => { if (!['GET', 'HEAD'].includes(rq.method())) writes.push(`${rq.method()} ${rq.url()}`); });
  if (oldScript) await page.route(/\/dashboard\/app\.js(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
  await page.goto(`${base}/dashboard`, { waitUntil: 'load', timeout: 60000 });
  await waitReady(page);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector(ready, { timeout: 20000 });
  return { ctx, page, writes };
}

/** The text of each group inside `scope`: `{ you, agent }` (empty string for a group that is not drawn). */
const groupsIn = (page, scope) => page.evaluate((sel) => {
  const g = (n) => [...document.querySelectorAll(`${sel} [data-card-group="${n}"]`)].map((e) => e.textContent).join('\n');
  return { you: g('you'), agent: g('agent') };
}, scope);

const SURFACES = [
  { name: 'Today', hash: '#home', ready: '.today-card', scope: '.today-card' },
  { name: 'duties list', hash: '#work/tasks', ready: '#screen [data-card-group]', scope: '#screen' },
];

test('the human\'s duties stand under "For you", the agents\' under "Agent work": Today, duties list and "Your next look", 1920/390, dark and light', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const srv = await startServer();
  try {
    for (const width of [1920, 390]) {
      for (const light of [false, true]) {
        for (const s of SURFACES) {
          const label = `${s.name} ${width}/${light ? 'light' : 'dark'}`;
          const { ctx, page, writes } = await open(browser, srv.base, { width, light, hash: s.hash, ready: s.ready });
          const g = await groupsIn(page, s.scope);
          for (const k of HUMAN) {
            assert.match(g.you, new RegExp(k), `${label}: "${k}" is for you`);
            assert.doesNotMatch(g.agent, new RegExp(k), `${label}: "${k}" is no agent work`);
          }
          assert.match(g.you, /for you \(3\)/i, label);
          if (s.name === 'Today') {
            // Today lists what is owed to the human only: an agent task is never drawn there
            assert.equal(g.agent, '', `${label}: no agent work on Today`);
            for (const k of AGENT) assert.doesNotMatch(g.you, new RegExp(k), label);
            // the order by deadline stays: overdue, due today, later
            const at = HUMAN.map((k) => g.you.indexOf(k));
            assert.deepEqual([...at].sort((a, b) => a - b), at, `${label}: by deadline ${at}`);
          } else {
            assert.match(g.agent, /agent work \(2\)/i, label);
            for (const k of AGENT) {
              assert.match(g.agent, new RegExp(k), `${label}: "${k}" is agent work`);
              assert.doesNotMatch(g.you, new RegExp(k), `${label}: "${k}" is not for you`);
            }
          }
          const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(over <= 0, `${label}: horizontal scroll of ${over}px`);
          assert.deepEqual(writes, [], `${label}: no write request`);
          await ctx.close();
        }
        // "Your next look": three items at most; the human's come first, and none of them is filed under Agent work
        const label = `next look ${width}/${light ? 'light' : 'dark'}`;
        const { ctx, page } = await open(browser, srv.base, { width, light, hash: '#home', ready: '.home-layout article.pad [data-card-group]' });
        const g = await groupsIn(page, '.home-layout article.pad');
        assert.match(g.you, /for you \(3\)/i, label);
        for (const k of HUMAN) assert.doesNotMatch(g.agent, new RegExp(k), `${label}: "${k}" is no agent work`);
        assert.equal(await page.locator('.home-layout article.pad .dcard').count(), 3, label);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, true, label);
        await ctx.close();
      }
    }
  } finally { await srv.stop(); }
});

test(`RED on the fixed old state (${OLD}): the human's duties with a replacement card stand under "Agent work" (positive control: the old page draws both groups, an agent task stands there too)`, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  let old;
  try { old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { return; }
  const srv = await startServer();
  try {
    for (const s of [...SURFACES, { name: 'next look', hash: '#home', ready: '.home-layout article.pad [data-card-group]', scope: '.home-layout article.pad' }]) {
      const { ctx, page } = await open(browser, srv.base, { width: 1440, light: false, hash: s.hash, ready: s.ready, oldScript: old });
      const g = await groupsIn(page, s.scope);
      // positive control: the written card (kind decide) is for you on the old page too, so the grouping IS drawn there
      assert.match(g.you, /Which logo/, `${s.name}: positive control, the old page draws the group For you`);
      // the bug: the replacement cards of the human's duties are filed as agent work
      // (the next look shows three items only, so there the proof is the COUNT: 2 duties of the human + 2 of the agent)
      assert.match(g.agent, s.name === 'next look' ? /agent work \(4\)/i : /tax papers|Renew the domain/, `${s.name}: the old page files the human's duty under Agent work`);
      if (s.name === 'duties list') assert.match(g.agent, /Agent task, late/, 'positive control: an agent task is under Agent work');
      await ctx.close();
    }
  } finally { await srv.stop(); }
});

// ---- the order inside "For you": by deadline, so "Your next look" (three items) shows the most urgent ones -----------------
// Five duties of the human, written with the urgent ones FIRST; the page lists the newest first, so the list order is the
// reverse of the deadline order and a cut at three keeps the wrong ones.
const URGENT = [
  { id: 'cd000001', title: 'Send the tax papers to the accountant', owner: 'alex', due: day(-9) },
  { id: 'cd000002', title: 'Renew the domain', owner: 'alex', due: day(0) },
  { id: 'cd000003', title: 'Book the dentist', owner: 'alex', due: day(5) },
  { id: 'cd000004', title: 'Book the flights', owner: 'alex', due: day(30) },
  { id: 'cd000005', title: 'Water the plants', owner: 'alex' },
  { id: 'cd000006', title: 'Agent task, early', owner: 'vm-admin' },
  { id: 'cd000007', title: 'Agent task, late', owner: 'vm-admin' },
];
const SHOWN = ['tax papers', 'Renew the domain', 'Book the dentist'];
const CUT = ['Book the flights', 'Water the plants'];

test('"For you" is ordered by deadline: "Your next look" shows the 3 most urgent of 5 duties, the duties list shows all 5 in that order, agent work keeps the list order', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const srv = await startServer(URGENT);
  try {
    for (const width of [1920, 390]) {
      for (const light of [false, true]) {
        const label = `${width}/${light ? 'light' : 'dark'}`;
        const next = await open(browser, srv.base, { width, light, hash: '#home', ready: '.home-layout article.pad [data-card-group]' });
        const g = await groupsIn(next.page, '.home-layout article.pad');
        assert.match(g.you, /for you \(5\)/i, label);
        const at = SHOWN.map((k) => g.you.indexOf(k));
        assert.ok(at.every((x) => x >= 0), `${label}: the three most urgent are shown: ${at}`);
        assert.deepEqual([...at].sort((a, b) => a - b), at, `${label}: overdue, due today, later: ${at}`);
        for (const k of CUT) assert.doesNotMatch(g.you, new RegExp(k), `${label}: "${k}" is cut, not an urgent one`);
        await next.ctx.close();
        const list = await open(browser, srv.base, { width, light, hash: '#work/tasks', ready: '#screen [data-card-group]' });
        const l = await groupsIn(list.page, '#screen');
        const all = [...SHOWN, ...CUT].map((k) => l.you.indexOf(k));
        assert.ok(all.every((x) => x >= 0), `${label}: all five are in the list: ${all}`);
        assert.deepEqual([...all].sort((a, b) => a - b), all, `${label}: by deadline, no date last: ${all}`);
        // agent work keeps the order of the list (the page lists the newest first)
        assert.ok(l.agent.indexOf('Agent task, late') < l.agent.indexOf('Agent task, early'), `${label}: agent work in list order`);
        await list.ctx.close();
      }
    }
  } finally { await srv.stop(); }
});

test('RED on 20ce113 (the group fixed, the order not): "Your next look" cuts the overdue duty (positive control: the old script groups right, the duties list has all five)', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  let before;
  try { before = execFileSync('git', ['-C', REPO, 'show', '20ce113:assets/dashboard/dashboard.js'], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { return; }
  const srv = await startServer(URGENT);
  try {
    const next = await open(browser, srv.base, { width: 1440, light: false, hash: '#home', ready: '.home-layout article.pad [data-card-group]', oldScript: before });
    const g = await groupsIn(next.page, '.home-layout article.pad');
    assert.match(g.you, /for you \(5\)/i, 'positive control: that script already files all five under For you');
    assert.doesNotMatch(g.you, /tax papers/, 'the overdue duty is cut from the three shown');
    assert.match(g.you, /Book the flights|Water the plants/, 'a duty without urgency took its place');
    await next.ctx.close();
    const list = await open(browser, srv.base, { width: 1440, light: false, hash: '#work/tasks', ready: '#screen [data-card-group]', oldScript: before });
    const l = await groupsIn(list.page, '#screen');
    assert.ok(l.you.indexOf('tax papers') > l.you.indexOf('Water the plants'), 'positive control: the duties list has the duty, but in list order, after the one without a date');
    await list.ctx.close();
  } finally { await srv.stop(); }
});
