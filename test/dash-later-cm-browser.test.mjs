// test/dash-later-cm-browser.test.mjs — a deferred part that stays "building" asks again BOUNDED (wackler repair
// 2026-10-07, the sibling's teilSpaeterNochmal) in a real Chromium.
// Before: `partLaterAgain` asked every 3 s without end (the tab said "Loading …" forever). Now: deadline +
// request budget of the run helper (F20 style), then a visible end state with the button "Load again";
// a click on it starts a new waiting spell with a new budget.
// The part route is answered through page.route; TEMPO_TEST_MS=5 shortens the 3 s interval, so the
// budget (40 requests) runs out in about a second — the 120 s deadline itself is covered by the logic probe
// (test/dash-run-cm.test.mjs, "later: the deadline ...").
// Red proof: the same scenario against the dashboard.js of the FIXED old state 4ed3a08 (git show, played in
// through page.route) keeps asking and never shows an end state; positive control: green on the new state.
// Server, context and page are torn down in finally.
/* global requestAnimationFrame -- these run inside the page (browser), not in Node */
/* global document, messages */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBrowser, waitReady, startView } from './fixture/browser.mjs';
import * as inbox from '../src/inbox.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '4ed3a08';
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const { browser, reason } = await startBrowser();
const SKIP = reason;
let oldScript = null;
try { oldScript = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { /* no history: the red probe skips */ }
const NO_OLD = oldScript ? false : 'old state not available in this checkout';

const PARTICIPANTS = { alex: { human: true }, bot: {} };
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dashlater-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'dashlater', participants: PARTICIPANTS, language: 'en' }));
  inbox.write(r, PARTICIPANTS, { from: 'bot', to: 'alex', subject: 'Message A', text: 'Text A', now: new Date('2026-10-03T10:00:00Z') });
  return r;
}

async function scenario({ script = null }, fn) {
  // warm: the inbox part is answered by page.route (building) or by the real server later; the cold start is not part of the deadlines
  const { base, stop } = await startView(world(), { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0', CHEAP_MEM_SERVE_TEMPO_TEST_MS: '5' });
  let ctx = null;
  try {
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (script) await page.route(/\/dashboard\/app\.js(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: script }));
    const answers = { mode: 'building', n: 0 };
    await page.route('**/dashboard/part.json?part=inbox*', (rt) => {
      answers.n += 1;
      if (answers.mode === 'real') return rt.continue().catch(() => {});
      return rt.fulfill({ json: { building: true } });
    });
    await page.goto(`${base}/dashboard#work/inbox`, { waitUntil: 'load' });
    await waitReady(page);
    await fn(page, answers, errors);
  } finally {
    await ctx?.close().catch(() => {});
    await stop();
  }
}

test('later: a permanently building part ends bounded and visible; "Load again" starts a new spell and delivers', { skip: SKIP, timeout: 300000 }, async () => {
  await scenario({}, async (page, answers, errors) => {
    await page.waitForFunction(() => /still being built/.test(document.querySelector('#screen')?.innerText || ''), null, { timeout: 60000 });
    const text = await page.evaluate(() => document.querySelector('#screen').innerText);
    assert.match(text, /budget of 40 requests/);
    assert.ok(await page.locator('#screen [data-action="reload"]').count() >= 1, 'the end state carries the button "Load again"');
    assert.ok(answers.n >= 2 && answers.n <= 41, `requests while building: ${answers.n}`);
    const n1 = answers.n;
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 400)))));
    assert.equal(answers.n, n1, 'no further asking after the end state');
    answers.mode = 'real';
    await page.locator('#screen [data-action="reload"]').first().click();
    await page.waitForFunction(() => typeof messages !== 'undefined' && messages.length === 1 && !/still being built/.test(document.querySelector('#screen')?.innerText || ''), null, { timeout: 30000 });
    assert.deepEqual(errors, []);
  });
});

test(`later RED on the fixed old state (${OLD}): it keeps asking and shows no end state (positive control: green on the new state)`, { skip: SKIP || NO_OLD, timeout: 300000 }, async () => {
  await scenario({ script: oldScript }, async (page, answers) => {
    // Event: more requests than the new budget allows (40) have been made.
    for (let i = 0; i < 600 && answers.n <= 60; i += 1) await page.waitForTimeout(50);
    assert.ok(answers.n > 60, `the old state asked only ${answers.n} times — the probe would not catch the endless loop`);
    const text = await page.evaluate(() => document.querySelector('#screen').innerText);
    assert.doesNotMatch(text, /still being built/, 'the old state shows no end state');
    assert.match(text, /Loading/, 'the old state says "Loading …" without end');
  });
});
