// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/board-parity-agents-cm.test.mjs — Work & agents (#work/agents) is an
// overview, not a wall of cards (parity with lucky-mem's agents page,
// 2026-10-01: "must become clearer").
//
// Checked in a real browser, on computed values:
//   * summary bar: agents · active in 7 days · need attention · open mail
//   * groups in a fixed order: Needs attention, Active (7 days), Idle
//     (collapsed, with its count)
//   * an honest state rule: "unknown" never counts as good; an agent that
//     cannot be started locally (a foreign agent) gets no penalty for the
//     missing heartbeat; a human none for a missing registration; an
//     announced pause is no fault
//   * a click on a row expands every field the card used to show
//   * "Contributions" in the row leads to the entries
//   * phone width 390: no horizontal scrolling, the table head is gone
//
// The agent list is set inside the page itself (D.agents + render()): the
// fields otherwise arrive finished from the server (src/dashboard.mjs
// agentSignals); here only what the PAGE makes of them is checked.
//
// RED proof against the FIXED base commit (never merge-base): its
// dashboard.js, swapped in through page.route, shows cards without groups
// and without a summary bar; the positive control shows the probe sees the
// agents there at all.
/* global D, document, location, partState, render, window -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { startBrowser, waitReady, startView } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD = 'deca5ad713f1dc7f3ec05cf21e0d5cf1ebb22a3b';

const { browser, reason: why } = await startBrowser();
const NEEDS = why ? { skip: why } : {};

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

async function startServer() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-agents-page-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'agents', participants: { alex: { human: true } }, language: 'en' }));
  memory.logEntry(r, 'learning', { title: 'One entry so the page has data', text: 'Evidence.' });
  return startView(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
}

/** Eight agents, one per rule. Times relative to "now" in the browser. */
const WORLD = `(() => {
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const quiet = { state: 'not seen', heartbeat: { ageMin: null }, content: { ageMin: null } };
  const base = { role: '', registered: true, count: 3, activity: quiet, startable: { local: true }, pause: { state: 'active' }, channel: { state: 'unknown', reason: 'not a configured inbox participant' } };
  return {
    agents: [
      { ...base, name: 'mail-old', last: ago(20 * 1440) },
      { ...base, name: 'wild-writer', registered: false, startable: { local: false }, pause: { state: 'unknown' }, last: ago(60), activity: { ...quiet, state: 'unknown' } },
      { ...base, name: 'pause-over', last: ago(30 * 1440), pause: { state: 'expired', until: '2026-01-01' } },
      { ...base, name: 'foreign-gpt', startable: { local: false }, activity: { ...quiet, state: 'alive' }, last: ago(120) },
      { ...base, name: 'foreign-quiet', startable: { local: false }, activity: { ...quiet, state: 'unknown' }, last: ago(90) },
      { ...base, name: 'human-alex', registered: false, startable: { local: false }, pause: { state: 'unknown' }, activity: { ...quiet, state: 'unknown' }, last: ago(45) },
      { ...base, name: 'paused', last: ago(20 * 1440), pause: { state: 'paused', until: '2099-01-01', why: 'holiday' } },
      { ...base, name: 'old-quiet', last: ago(40 * 1440) },
    ],
    messages: [
      { name: 'm1', from: 'x', to: 'mail-old', subject: 'a', state: 'open', ageMin: 5000, situation: 'waiting' },
      { name: 'm2', from: 'x', to: 'mail-old', subject: 'b', state: 'open', ageMin: 4000, situation: 'waiting' },
      { name: 'm3', from: 'x', to: 'foreign-gpt', subject: 'c', state: 'open', ageMin: 30, situation: 'open' },
      { name: 'm4', from: 'x', to: 'old-quiet', subject: 'd', state: 'replied', ageMin: 9000, situation: 'done' },
    ],
  };
})()`;

async function open(base, { width = 1440, oldScript } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  if (oldScript) {
    await page.route(/\/dashboard\/app\.js(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
  }
  await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 60000 });
  await waitReady(page);
  await page.evaluate(() => { location.hash = '#work/agents'; });
  await page.waitForFunction(() => /#work\/agents/.test(location.hash) && document.querySelector('#screen .panel'), null, { timeout: 15000 });
  // The deferred inbox list must have arrived first — otherwise it would
  // overwrite the fixture's messages afterwards.
  await page.waitForFunction(() => !D?.parts?.inbox || partState.inbox === 'ok' || partState.inbox === 'error', null, { timeout: 15000 });
  await page.evaluate(`(() => { const w = ${WORLD}; D.agents = w.agents; D.inbox = { ...(D.inbox || {}), readable: true }; if (D.parts) delete D.parts.inbox; setMessages(w.messages); render(); })()`);
  await page.waitForTimeout(200);
  return { ctx, page };
}

/** What the page shows — read from the DOM only. */
const view = (page) => page.evaluate(() => {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const groups = [...document.querySelectorAll('#screen [data-group]')].map((g) => ({
    title: g.dataset.group,
    open: g.tagName === 'DETAILS' ? g.open : true,
    head: txt(g.querySelector('summary, .ag-group-title')),
    agents: [...g.querySelectorAll('.ag-row')].map((z) => z.dataset.agent),
  }));
  const states = Object.fromEntries([...document.querySelectorAll('#screen .ag-row')].map((z) => [z.dataset.agent, z.dataset.state]));
  const bar = [...document.querySelectorAll('#screen .metrics .metric')].map((m) => [txt(m.querySelector('.name')), txt(m.querySelector('strong'))]);
  const cards = [...document.querySelectorAll('#screen .panel h2')].map(txt);
  return { groups, states, bar, cards };
});

test(`RED on the fixed old state (${OLD.slice(0, 8)}): no groups, no summary bar — but the agents are there (positive control)`, NEEDS, async (t) => {
  let old;
  try {
    old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    t.skip(`commit ${OLD} not reachable (shallow clone?) — red proof unknown, not green`);
    return;
  }
  const s = await startServer();
  const { ctx, page } = await open(s.base, { oldScript: old });
  try {
    const v = await view(page);
    assert.ok(v.cards.includes('foreign-gpt') && v.cards.includes('old-quiet'), 'positive control: the old state shows the agents (as cards)');
    assert.deepEqual(v.groups, [], 'old state: no groups');
    assert.equal(v.bar.length, 0, 'old state: no summary bar');
  } finally { await ctx.close(); await s.stop(); }
});

test('GREEN: summary bar, groups in a fixed order, Idle collapsed with its count', NEEDS, async () => {
  const s = await startServer();
  const { ctx, page } = await open(s.base);
  try {
    const v = await view(page);
    assert.deepEqual(v.bar, [['Agents', '8'], ['Active in 7 days', '4'], ['Need attention', '3'], ['Open mail', '3']]);
    assert.deepEqual(v.groups.map((g) => g.title), ['Needs attention', 'Active (7 days)', 'Idle']);
    assert.deepEqual(v.groups[0].agents, ['mail-old', 'wild-writer', 'pause-over']);
    assert.deepEqual(v.groups[1].agents, ['foreign-gpt', 'foreign-quiet', 'human-alex']);
    assert.deepEqual(v.groups[2].agents, ['paused', 'old-quiet']);
    assert.equal(v.groups[2].open, false, 'Idle is collapsed by default');
    assert.match(v.groups[2].head, /Idle\s*·\s*2/);
    assert.equal(v.cards.filter((k) => k === 'foreign-gpt').length, 0, 'no card per agent any more');
  } finally { await ctx.close(); await s.stop(); }
});

test('GREEN: state rule — unknown is never good, no penalty for a by-design missing heartbeat, a pause is no fault', NEEDS, async () => {
  const s = await startServer();
  const { ctx, page } = await open(s.base);
  try {
    const { states } = await view(page);
    assert.deepEqual(states, {
      'mail-old': 'warning',
      'wild-writer': 'warning',
      'pause-over': 'warning',
      'foreign-gpt': 'good',
      'foreign-quiet': 'unknown',
      'human-alex': 'unknown',
      paused: 'unknown',
      'old-quiet': 'unknown',
    });
    const reason = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#screen .ag-row')].map((z) => [z.dataset.agent, z.querySelector('.ag-state').getAttribute('title')])));
    assert.match(reason['mail-old'], /2 messages waiting longer than 48 h/);
    assert.match(reason['wild-writer'], /not registered/);
    assert.match(reason['pause-over'], /pause expired/);
    assert.match(reason['foreign-gpt'], /by design, no penalty/);
    assert.match(reason['foreign-quiet'], /only one of two sources/);
    assert.match(reason['human-alex'], /human: no registration/);
    assert.match(reason.paused, /paused until 2099-01-01/);
  } finally { await ctx.close(); await s.stop(); }
});

test('GREEN: a click on the row expands every field; "Contributions" leads to the entries', NEEDS, async () => {
  const s = await startServer();
  const { ctx, page } = await open(s.base);
  try {
    await page.click('#screen .ag-row[data-agent="foreign-gpt"] > summary .ag-name');
    const fields = await page.evaluate(() => {
      const z = document.querySelector('#screen .ag-row[data-agent="foreign-gpt"]');
      return { open: z.open, rows: [...z.querySelectorAll('.ag-detail .row > span:first-child')].map((x) => x.textContent.trim()) };
    });
    assert.equal(fields.open, true);
    for (const f of ['State', 'Registration', 'Alive (two sources)', 'Heartbeat / activity', 'Pause (silent_until)', 'Locally startable', 'Inbox bell', 'Open mail', 'Last entry']) {
      assert.ok(fields.rows.includes(f), `field "${f}" missing in the details: ${fields.rows.join(', ')}`);
    }
    const alive = await page.textContent('#screen .ag-row[data-agent="foreign-gpt"] .ag-detail');
    assert.match(alive, /2 of 2 sources/);
    await page.click('#screen .ag-row[data-agent="foreign-quiet"] button[data-action="agent-entries"]');
    await page.waitForFunction(() => /#knowledge\/entries/.test(location.hash), null, { timeout: 5000 });
  } finally { await ctx.close(); await s.stop(); }
});

test('GREEN: open mail not measured is "—", never 0', NEEDS, async () => {
  const s = await startServer();
  const { ctx, page } = await open(s.base);
  try {
    await page.evaluate(() => { D.inbox = { ...D.inbox, readable: false }; render(); });
    const v = await view(page);
    assert.deepEqual(v.bar[3], ['Open mail', '—']);
  } finally { await ctx.close(); await s.stop(); }
});

test('GREEN: phone width 390 — no horizontal scrolling, no table head, rows readable', NEEDS, async () => {
  const s = await startServer();
  const { ctx, page } = await open(s.base, { width: 390 });
  try {
    await page.evaluate(() => document.querySelector('#screen .ag-idle')?.setAttribute('open', ''));
    await page.click('#screen .ag-row[data-agent="mail-old"] > summary .ag-name');
    const m = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: window.innerWidth,
      head: [...document.querySelectorAll('#screen .ag-head')].some((k) => k.offsetParent !== null),
      rows: [...document.querySelectorAll('#screen .ag-row > summary')].map((z) => z.getBoundingClientRect().right),
    }));
    assert.ok(m.scroll <= m.width, `horizontal scrolling: scrollWidth ${m.scroll} > ${m.width}`);
    assert.equal(m.head, false, 'the table head is hidden on a phone');
    assert.ok(m.rows.length === 8 && m.rows.every((r) => r <= m.width), 'every row inside the width');
  } finally { await ctx.close(); await s.stop(); }
});
