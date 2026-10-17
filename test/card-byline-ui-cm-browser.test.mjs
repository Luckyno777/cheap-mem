// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/card-byline-ui-cm-browser.test.mjs - the card's origin line in the dashboard says who wrote it with name AND rank, in the
// same words as `mem today` and `mem card list` (`authority.rankWord`): a rank the line does not carry reads "unknown (missing)",
// "unknown (empty)" or "unknown (broken)".
//
// Measure:             the real dashboard in a real Chromium over the card world (test/fixture/card-view-world.mjs) plus four
//                      written cards: the configured human's NAME at tier agent, and an author with a blank, a foreign and (from
//                      the world) no tier at all.
// Starting value:      the state BEFORE the branch (9a10bf6): every rank the line does not carry reads "tier unknown", the three
//                      states fall together.
// Expected change:     "tier unknown (missing)" / "(empty)" / "(broken)"; the human's name at tier agent keeps "Written by an
//                      agent, not checked by you"; a card of rank user carries no such hint; no sideways scroll at 390 px, light
//                      and dark.
// Abort criterion:     any of these false.
//
// Red proof: the same scenario against the dashboard.js of the old state (git show, a fixed hash) is played in through
// page.route; positive control: the same page, the same data, with the new script, shows the three states.
/* global document, window, localStorage, sections */
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

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '9a10bf6'; // the state before this branch (fixed, never merge-base)
const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });

const B = lazyBrowser();
browserStartProbe(B);

let oldScript = null;
try { oldScript = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { /* no history: the red probe skips */ }
const NO_OLD = oldScript ? false : 'old state not available in this checkout';

const ts = '2026-10-02T09:00:00Z';
const card = (id, author, authority, q) => ({
  id, ts, title: q, who: 'user', agent: author, ...(authority === undefined ? {} : { authority }),
  card_question: q, card_options: ['Yes - it goes ahead', 'No - it stays as it is', 'Not now - nothing changes'], card_kind: 'decide',
});
// The configured human of a fresh `mem init` is the participant `user`.
const EXTRA = [
  card('dnameag001', 'user', 'agent', 'Should the newsletter go out on Monday?'),
  card('dempty0001', 'orch-2', '', 'Should the archive be split by year?'),
  card('dbroke0001', 'orch-3', 'boss', 'Should the old mirror be shut down?'),
];
let ids = null;
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-byline-'));
  made.push(r);
  ids = buildWorld(r);
  fs.appendFileSync(path.join(r, 'global', 'duties.jsonl'), EXTRA.map((z) => `${JSON.stringify(z)}\n`).join(''));
  return r;
}
const ENV = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1', MEM_RECALL_SERVER: '0' };

const READY = () => typeof sections === 'object' && !document.querySelector('#screen .loading');
async function scenario(t, { width = 1400, light = false, script = null }, fn) {
  const browser = await B.need(t);
  if (!browser) return;
  const s = await startView(world(), ENV);
  let ctx = null;
  try {
    ctx = await browser.newContext({ viewport: { width, height: 1000 } });
    await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* no storage */ } }, light);
    const page = await ctx.newPage();
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (script) await page.route(/\/dashboard\/app\.js(\?|$)/, (rt) => rt.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: script }));
    await page.goto(`${s.base}/dashboard#work/tasks`, { waitUntil: 'load' });
    await page.waitForFunction(READY, null, { timeout: 150000 });
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
    await fn(page, errors);
  } finally {
    await ctx?.close().catch(() => {});
    await s.stop();
  }
}
const cardOf = (page, id) => page.locator(`#screen .dcard:has([data-entry="${id}"])`);
const originOf = (page, id) => cardOf(page, id).locator('[data-card-origin]').innerText();
const hints = (page, id) => cardOf(page, id).locator('[data-card-agent]').count();

test('the origin line: name AND rank in the words of rankWord; the human\'s name at tier agent keeps the hint, rank user carries none', { timeout: 600000 }, async (t) => {
  await scenario(t, {}, async (page, errors) => {
    // The configured human's NAME at tier agent: the name is no rank, the hint stays.
    assert.match(await originOf(page, 'dnameag001'), /^Written by user · tier agent · 02 Oct 2026 · written on the entry$/);
    assert.equal(await hints(page, 'dnameag001'), 1, 'the human\'s name at tier agent carries the hint');
    assert.match(await cardOf(page, 'dnameag001').locator('[data-card-agent]').innerText(), /^Written by an agent, not checked by you\.$/);
    // Rank user: no hint.
    assert.match(await originOf(page, ids.human), /^Written by user · tier user · /);
    assert.equal(await hints(page, ids.human), 0, 'a card of rank user carries no hint');
    // No authority on the line, a blank one, a foreign word: three states, each named.
    assert.match(await originOf(page, ids.written), /^Written by alex-planner · tier unknown \(missing\) · /);
    assert.match(await originOf(page, 'dempty0001'), /^Written by orch-2 · tier unknown \(empty\) · /);
    assert.match(await originOf(page, 'dbroke0001'), /^Written by orch-3 · tier unknown \(broken\) · /);
    for (const id of [ids.written, 'dempty0001', 'dbroke0001']) assert.equal(await hints(page, id), 1, `a card without a rank carries the hint: ${id}`);
    // An addendum keeps its tier as it is; a replacement card names no author and no tier.
    assert.match(await originOf(page, ids.addendum), /^Written by orch-1 · tier agent · /);
    assert.match(await originOf(page, ids.fallback), /^Replacement card\. /);
    assert.deepEqual(errors, []);
  });
});

for (const light of [false, true]) {
  test(`390 px ${light ? 'light' : 'dark'}: no sideways scroll, every origin line inside its card`, { timeout: 600000 }, async (t) => {
    await scenario(t, { width: 390, light }, async (page, errors) => {
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const lines = [...document.querySelectorAll('#screen [data-card-origin], #screen [data-card-agent]')];
        const out = lines.filter((el) => {
          const r = el.getBoundingClientRect(); const c = el.closest('.dcard').getBoundingClientRect();
          return el.scrollWidth > el.clientWidth + 1 || r.right > c.right + 1 || r.left < c.left - 1;
        }).length;
        return { sw: de.scrollWidth, cw: de.clientWidth, lines: lines.length, out };
      });
      assert.ok(m.lines >= 10, `origin lines found: ${m.lines}`);
      assert.ok(m.sw <= m.cw, `no sideways scroll: ${m.sw} > ${m.cw}`);
      assert.equal(m.out, 0, 'no origin line sticks out of its card');
      assert.match(await originOf(page, 'dbroke0001'), /tier unknown \(broken\)/);
      assert.deepEqual(errors, []);
    });
  });
}

test(`RED on the old state (${OLD}): the three states fall together as "tier unknown" (positive control: the new script names them)`, { skip: NO_OLD, timeout: 600000 }, async (t) => {
  await scenario(t, { script: oldScript }, async (page) => {
    for (const id of [ids.written, 'dempty0001', 'dbroke0001']) {
      const line = await originOf(page, id);
      assert.match(line, / · tier unknown · /, `the old script says a bare "unknown": ${line}`);
      assert.doesNotMatch(line, /\((missing|empty|broken)\)/);
    }
  });
  await scenario(t, {}, async (page) => {
    assert.match(await originOf(page, ids.written), /tier unknown \(missing\)/, 'positive control: the same data with the new script');
  });
});
