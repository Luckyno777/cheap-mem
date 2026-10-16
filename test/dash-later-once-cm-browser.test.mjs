// test/dash-later-once-cm-browser.test.mjs — a new round of the deferred parts drops the retry still waiting from the
// round before (dashboard-tempo-cm, 2026-10-16) in a real Chromium.
//
// Finding (a cold start with 5000 entries, base dc6b69d, request log): the first answer was the quick head, its parts
// answered `building` while the build ran, a retry was armed (3 s); the data load after the build fetched every part
// again, and then the retry fired and fetched them ALL a second time (3.5 s of parts the page already had). Not every
// cold start: when the first answer is the placeholder (no parts yet) there is no retry to fire (0 of 7 more starts).
//
// Measure:          requests of /dashboard/part.json?part=inbox after the part says `ok` in a newer round.
// Starting value:   one building answer (retry armed), then a newer data load that gets the part.
// Expected change:  no retry left waiting (partRetryTimer 0, partLater null) and no further request - the bound of the
//                   waiting spell (deadline, budget) is untouched (test/dash-later-cm-browser.test.mjs).
// Abort criterion:  a request after the part arrived / the part never arrives.
//
// Red proof: the same scenario against the dashboard.js of the fixed base dc6b69d (git show, played in through
// page.route) asks the part a second time when the old timer runs out; positive control: the new state asks once.
/* global messages, loadData, partRetryTimer, partLater, partState */
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
const BASE = 'dc6b69d58cbc90e35827f62381897bc3abe8fee6';
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const { browser, reason } = await startBrowser();
const SKIP = reason;
let baseScript = null;
try { baseScript = execFileSync('git', ['-C', REPO, 'show', `${BASE}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no history: the red probe skips */ }
const NO_BASE = baseScript ? false : `commit ${BASE} not reachable (shallow clone?) - red proof unknown, not green`;

const PARTICIPANTS = { alex: { human: true }, bot: {} };
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dashonce-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'dashonce', participants: PARTICIPANTS, language: 'en' }));
  inbox.write(r, PARTICIPANTS, { from: 'bot', to: 'alex', subject: 'Message A', text: 'Text A', now: new Date('2026-10-03T10:00:00Z') });
  return r;
}

async function scenario({ script = null }, fn) {
  // No CHEAP_MEM_SERVE_TEMPO_TEST_MS: the retry waits its real 3 s, the newer data load comes well inside it.
  const { base, stop } = await startView(world(), { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1', MEM_RECALL_SERVER: '0' });
  let ctx = null;
  try {
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (script) await page.route(/\/dashboard\/app\.js(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: script }));
    const answers = { mode: 'building', n: 0, real: 0 };
    await page.route('**/dashboard/part.json?part=inbox*', (rt) => {
      answers.n += 1;
      if (answers.mode === 'real') { answers.real += 1; return rt.continue().catch(() => {}); }
      return rt.fulfill({ json: { building: true } });
    });
    await page.goto(`${base}/dashboard#work/inbox`, { waitUntil: 'load' });
    await waitReady(page);
    // The first round: the part says building, a retry is armed.
    await page.waitForFunction(() => partRetryTimer === 1 && partLater !== null);
    assert.equal(answers.n, 1, 'positive control: one building answer, the retry waits');
    // The build is through: a newer data load gets the part in its own round, while the old retry still waits.
    answers.mode = 'real';
    await page.evaluate(() => loadData({ quiet: true }));
    await page.waitForFunction(() => partState.inbox === 'ok' && typeof messages !== 'undefined' && messages.length === 1);
    await fn(page, answers, errors);
  } finally {
    await ctx?.close().catch(() => {});
    await stop();
  }
}

test('later once: the newer round takes the part, the retry of the round before is dropped, no second request', { skip: SKIP, timeout: 300000 }, async () => {
  await scenario({}, async (page, answers, errors) => {
    const real = answers.real;
    // A later round still asks when a part says building again (checked below): the mechanism is not switched off.
    answers.mode = 'building';
    assert.equal(real, 1, 'the newer round asked once');
    const st = await page.evaluate(() => ({ timer: partRetryTimer, spell: partLater }));
    assert.deepEqual(st, { timer: 0, spell: null }, 'no retry is left waiting (nothing can ask again)');
    await page.evaluate(() => loadData({ quiet: true }));
    await page.waitForFunction(() => partRetryTimer === 1, null, { timeout: 30000 });
    assert.deepEqual(errors, []);
  });
});

test(`later once RED on the base (${BASE.slice(0, 7)}): the old retry fires and asks the part a second time`, { skip: SKIP || NO_BASE, timeout: 300000 }, async () => {
  await scenario({ script: baseScript }, async (page, answers) => {
    assert.equal(answers.real, 1, 'positive control: the newer round asked once');
    assert.equal(await page.evaluate(() => partRetryTimer), 1, 'the old retry still waits after the part arrived');
    // Event: the old timer runs out (3 s) and asks again.
    for (let i = 0; i < 200 && answers.real < 2; i += 1) await page.waitForTimeout(50);
    assert.equal(answers.real, 2, 'the old state asked the part it already had a second time');
  });
});
