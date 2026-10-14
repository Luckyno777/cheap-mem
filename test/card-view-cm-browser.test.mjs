// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/card-view-cm-browser.test.mjs - H11 (card-view-cm): everything a person is meant to decide or release is a readable
// card in the dashboard, not an identifier or the first 110 characters of a text.
//
// Measure:             the real dashboard in a real Chromium over a store with every kind of card (test/fixture/card-view-world.mjs):
//                      a card written on the entry, an addendum from the shelf, replacement cards, a title with markup, a title
//                      with a key, agent work, a task, a waiting question, a waiting project.
// Starting value:      the state BEFORE the branch (2f93f88): no card element anywhere, "Your next look" shows the title and the
//                      first 110 characters of the text.
// Expected change:     card per item on Today, "Your next look", the duties list, the projects tab and the entry drawer; "For you"
//                      apart from "Agent work"; the origin line; an agent card says it was not checked by you; the replacement
//                      card says nobody wrote it; the recommendation carries its author and is never preselected; a No / not-now
//                      option on every card; the evidence as a link; markup stays text; a key stays masked; no sideways scroll at
//                      390 / 720 / 1920 px, light and dark.
// Abort criterion:     any of these false.
//
// Red proof: the same scenario against the dashboard.js of the old state (git show) is played in through page.route; positive
// control: the same page, the same data, with the new script, shows the cards.
/* global document, window, getComputedStyle, localStorage, sections, byId */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lazyBrowser, browserStartProbe, startView } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { buildWorld, FAKE_KEY, XSS_TITLE } from './fixture/card-view-world.mjs';
import * as dashboardLive from './../src/dashboard-live.mjs';
import * as dashboardData from './../src/dashboard-data.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '2f93f88'; // the state before this branch (fixed, never merge-base)
const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });

const B = lazyBrowser();
browserStartProbe(B);

let oldScript = null;
try { oldScript = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch { /* no history: the red probe skips */ }
const NO_OLD = oldScript ? false : 'old state not available in this checkout';

let ids = null;
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cardview-'));
  made.push(r);
  ids = buildWorld(r);
  return r;
}
const ENV = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0' };

const READY = () => typeof sections === 'object' && !document.querySelector('#screen .loading');
async function scenario(t, { width = 1400, light = false, hash = '', script = null }, fn) {
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
    await page.goto(`${s.base}/dashboard${hash}`, { waitUntil: 'load' });
    await page.waitForFunction(READY, null, { timeout: 150000 });
    // The Today card and the panels reveal when they scroll into view.
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
    await fn(page, errors, s);
  } finally {
    await ctx?.close().catch(() => {});
    await s.stop();
  }
}
const cardOf = (page, id) => page.locator(`#screen .dcard:has([data-entry="${id}"])`);

test('the duties list: one card per item, For you apart from Agent work, origin and stage on every card', { timeout: 600000 }, async (t) => {
  await scenario(t, { hash: '#work/tasks' }, async (page, errors) => {
    const q = (sel) => page.locator(`#screen ${sel}`);
    // For you / Agent work
    assert.equal(await q('[data-card-group="you"]').count(), 1);
    assert.equal(await q('[data-card-group="agent"]').count(), 1);
    const you = await q('[data-card-group="you"]').innerText();
    const agent = await q('[data-card-group="agent"]').innerText();
    assert.match(you, /for you \(10\)/i);
    assert.match(agent, /agent work \(1\)/i);
    assert.match(agent, /Guard for race at src\/lock\.mjs/, 'an agent posting is under Agent work');
    // card-group-cm: whom the task is owed to decides, not its card: a task of the human (kind do-it) is for the human
    assert.match(you, /Rename the folder old-notes/, 'a task owed to the human is under For you');
    assert.doesNotMatch(you, /Guard for race/, 'the agent posting is not under For you');
    assert.doesNotMatch(agent, /Rename the folder/, 'the human\'s task is not agent work');

    // Every card: a heading with the question, the options as a list, a No / not-now option, nothing preselected.
    const n = await q('.dcard').count();
    assert.ok(n >= 8, `cards: ${n}`);
    const shape = await page.evaluate(() => [...document.querySelectorAll('#screen .dcard')].map((c) => ({
      heading: c.querySelector('h3.dcard-q')?.textContent || '',
      list: c.querySelectorAll('ul.dcard-opts > li').length,
      decline: c.querySelectorAll('ul.dcard-opts > li[data-decline]').length,
      inputs: c.querySelectorAll('input,[aria-pressed],[aria-checked],.selected,.active,[checked]').length,
      primary: c.querySelectorAll('.btn.primary').length,
      origin: c.querySelector('[data-card-origin]')?.getAttribute('data-card-origin') || '',
    })));
    for (const c of shape) {
      assert.match(c.heading, /\?$/, `the question is a heading and ends with a question mark: ${c.heading}`);
      assert.ok(c.list >= 2, 'options are a list of at least two');
      assert.ok(c.decline >= 1, `a No / not-now option: ${c.heading}`);
      assert.equal(c.inputs, 0, 'nothing is preselected');
      assert.equal(c.primary, 0, 'no button is highlighted as the preferred answer');
      assert.ok(['written', 'addendum', 'fallback'].includes(c.origin), `origin line: ${c.origin}`);
    }
    assert.deepEqual([...new Set(shape.map((c) => c.origin))].sort(), ['addendum', 'fallback', 'written']);

    // Written card: author, tier, date, stage; the recommendation carries its author; an agent card says "not checked by you".
    const written = cardOf(page, ids.written);
    const wt = await written.innerText();
    assert.match(wt, /Which transfer details should the payment page show\?/);
    assert.match(wt, /Recommendation from alex-planner: The newer file was reviewed last week\./);
    assert.match(wt, /Written by alex-planner · tier unknown · 01 Oct 2026 · written on the entry/);
    assert.equal(await written.locator('[data-card-agent]').count(), 1);
    assert.match(await written.locator('[data-card-agent]').innerText(), /Written by an agent, not checked by you\./);
    // The evidence is a link (https) or a button to the entry; the identifier is small.
    assert.equal(await written.locator('a[href="https://example.org/notes/transfer"][rel~="noopener"]').count(), 1);
    assert.equal(await written.locator('[data-entry]').count() >= 1, true);
    const idSize = await written.locator('.mono.small.quiet').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const qSize = await written.locator('h3.dcard-q').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(idSize <= 12 && qSize >= 15, `identifier ${idSize}px, question ${qSize}px`);

    // Addendum: named as such, with the author of the card.
    const add = await cardOf(page, ids.addendum).innerText();
    assert.match(add, /Written by orch-1 · tier agent · 12 Oct 2026 · added later from the card shelf/);
    assert.match(add, /Recommendation from orch-1:/);

    // Replacement card: named as such, no author, NO recommendation.
    for (const id of [ids.fallback, ids.question]) {
      const fb = cardOf(page, id);
      assert.match(await fb.innerText(), /Replacement card\. Nobody wrote a card for this entry/);
      assert.equal(await fb.locator('[data-card-advice]').count(), 0, 'a replacement card has no recommendation');
      assert.equal(await fb.locator('[data-card-agent]').count(), 0);
    }

    // A card written by the configured human: no "written by an agent" note, whatever its tier.
    const human = cardOf(page, ids.human);
    assert.match(await human.innerText(), /Written by user · tier /);
    assert.equal(await human.locator('[data-card-agent]').count(), 0, 'the configured human is a person: no agent note');
    assert.equal(await written.locator('[data-card-agent]').count(), 1, 'positive control: another author still carries the note');

    // The waiting question carries its confirm button in the card's foot.
    assert.equal(await cardOf(page, ids.waiting).locator('[data-action="question-confirm"]').count(), 1);
    assert.deepEqual(errors, []);
  });
});

test('the output stays safe: markup in a title is text, a key stays masked, nothing is put together again', { timeout: 600000 }, async (t) => {
  await scenario(t, { hash: '#work/tasks' }, async (page, errors) => {
    const screen = page.locator('#screen');
    const html = await screen.innerHTML();
    const text = await screen.innerText();
    assert.equal(await page.evaluate(() => window.__pwn), undefined, 'the handler of the injected image never ran');
    assert.equal(await page.locator('#screen img').count(), 0, 'no image element from a title');
    assert.equal(await page.locator('#screen [onerror]').count(), 0);
    assert.ok(text.includes('<img src=x onerror="window.__pwn=1">'), 'the markup is shown as text');
    assert.ok(html.includes('&lt;img src=x onerror="window.__pwn=1"&gt;'), 'and it is escaped in the markup');
    assert.ok(XSS_TITLE.includes('<img'), 'positive control: the fixture really carries markup');
    assert.ok(!html.includes(FAKE_KEY) && !text.includes(FAKE_KEY), 'the key never reaches the page');
    assert.match(text, /\[REDACTED:[a-z-]+\]/, 'the key stands masked');
    // Bidi and zero-width characters come back through the entry list (the evidence link shows the entry's title): dropped.
    const raw = await page.evaluate((id) => byId(id).title, ids.bidi);
    assert.ok(/[\u202E\u2066\u200B]/.test(raw), 'positive control: the entry list still carries the characters');
    const inCards = await page.evaluate(() => [...document.querySelectorAll('#screen .dcard')].map((c) => c.innerHTML).join('\n'));
    assert.ok(!/[\u202E\u2066\u200B]/.test(inCards), 'no bidi or zero-width character in any card');
    assert.ok(inCards.includes('Decide reversed now please'), 'the title stands, only the characters are gone');
    assert.deepEqual(errors, []);
  });
});

test('the overview: Today and "Your next look" carry the same cards; the waiting project is a card with its button', { timeout: 600000 }, async (t) => {
  await scenario(t, { hash: '' }, async (page, errors) => {
    const next = page.locator('.home-layout article.pad');
    const nt = await next.innerText();
    assert.match(nt, /for you \(10\)/i);
    assert.match(nt, /Which of the four open points from the decision form do you want first\?/);
    assert.ok(!/\bGLOBAL · USER\b/i.test(nt), 'no bare project and owner line instead of a card');
    assert.equal(await next.locator('.dcard').count(), 3, 'three cards at most, as the 3 items before');
    const today = page.locator('.overview-today');
    assert.ok(await today.locator('.dcard').count() >= 7);
    assert.equal(await today.locator('[data-card-group="you"]').count() >= 1, true);
    // The project: "Take over project garden-plan?" from the card, the hand-made one too.
    const proj = today.locator('.dcard:has-text("Take over project garden-plan?")');
    assert.equal(await proj.count(), 1);
    assert.match(await proj.innerText(), /Garden planner\. Reason: Three captures on two days\./);
    assert.equal(await proj.locator('[data-action="project-confirm"][data-value="garden-plan"], .mono:has-text("mem project confirm garden-plan")').count(), 1);
    assert.equal(await today.locator('.dcard:has-text("Take over project hand-made?")').count(), 1);
    // The task owed to the human (kind do-it) is a card under For you; Today lists what is owed to the human only, so no agent work.
    assert.match(await today.locator('[data-card-group="you"]').first().innerText(), /Rename the folder old-notes/);
    assert.equal(await today.locator('[data-card-group="agent"]').count(), 0);
    assert.deepEqual(errors, []);
  });
});

test('the projects tab shows the card of a project that waits', { timeout: 600000 }, async (t) => {
  await scenario(t, { hash: '#sources/projects' }, async (page, errors) => {
    const c = page.locator('#screen .dcard:has-text("Take over project garden-plan?")');
    assert.equal(await c.count(), 1);
    assert.equal(await c.locator('h3.dcard-q').count(), 1);
    assert.equal(await page.locator('#screen [data-action="project-confirm"][data-value="garden-plan"]').count(), 1, 'the confirm button stays (the same task)');
    assert.deepEqual(errors, []);
  });
});

test('the entry drawer opens with the card of the entry', { timeout: 600000 }, async (t) => {
  await scenario(t, { hash: '#work/tasks' }, async (page, errors) => {
    await cardOf(page, ids.written).locator('[data-entry]').last().click();
    await page.waitForSelector('#detail .dcard', { timeout: 60000 });
    const d = await page.locator('#detail .dcard').first().innerText();
    assert.match(d, /Which transfer details should the payment page show\?/);
    assert.deepEqual(errors, []);
  });
});

for (const light of [false, true]) {
  for (const width of [390, 720, 1920]) {
    test(`no sideways scroll, readable colours: ${width} px, ${light ? 'light' : 'dark'}`, { timeout: 600000 }, async (t) => {
      for (const hash of ['', '#work/tasks', '#sources/projects']) {
        await scenario(t, { width, light, hash }, async (page, errors) => {
          const m = await page.evaluate(() => {
            const de = document.documentElement;
            const bad = [...document.querySelectorAll('#screen .dcard')].filter((c) => c.scrollWidth > c.clientWidth + 1 || c.getBoundingClientRect().right > de.clientWidth + 1).length;
            // contrast of EVERY text in a card (badges, buttons, links, identifier, foot) against its real background
            const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
            const parse = (str) => (str.match(/[\d.]+/g) || []).map(Number);
            const bgOf = (el) => {
              const layers = [];
              for (let n = el; n; n = n.parentElement) {
                const c = parse(getComputedStyle(n).backgroundColor);
                const a = c.length > 3 ? c[3] : 1;
                if (c.length >= 3 && a > 0) layers.push([c[0], c[1], c[2], a]);
                if (a >= 1) break;
              }
              let acc = [255, 255, 255];
              for (const l of layers.reverse()) acc = [0, 1, 2].map((i) => l[i] * l[3] + acc[i] * (1 - l[3]));
              return acc;
            };
            let worst = 99; let where = '';
            for (const c of document.querySelectorAll('#screen .dcard')) {
              for (const el of c.querySelectorAll('*')) {
                if (![...el.childNodes].some((nd) => nd.nodeType === 3 && nd.textContent.trim())) continue;
                if (el.closest('[disabled]')) continue; // a disabled control is exempt
                const fg = parse(getComputedStyle(el).color).slice(0, 3);
                const a = lum(fg); const b = lum(bgOf(el));
                const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
                if (ratio < worst) { worst = ratio; where = `${el.tagName.toLowerCase()}.${el.className} "${el.textContent.trim().slice(0, 30)}"`; }
              }
            }
            return { sw: de.scrollWidth, cw: de.clientWidth, bad, cards: document.querySelectorAll('#screen .dcard').length, worst, where };
          });
          assert.ok(m.cards >= 1, `cards on ${hash || 'overview'}`);
          assert.ok(m.sw <= m.cw, `no sideways scroll on ${hash || 'overview'}: ${m.sw} > ${m.cw}`);
          assert.equal(m.bad, 0, 'no card sticks out of the page');
          assert.ok(m.worst >= 4.5, `text contrast ${m.worst.toFixed(2)} on ${hash || 'overview'} at ${m.where}`);
          assert.deepEqual(errors, []);
        });
      }
    });
  }
}

test(`RED on the old state (${OLD}): no card anywhere, "Your next look" shows a cut-off text (positive control: the new script shows the cards)`, { skip: NO_OLD, timeout: 600000 }, async (t) => {
  await scenario(t, { hash: '', script: oldScript }, async (page) => {
    assert.equal(await page.locator('.dcard').count(), 0, 'the old script draws no card');
    assert.equal(await page.locator('[data-card-group]').count(), 0);
    const nt = await page.locator('.home-layout article.pad').innerText();
    assert.match(nt, /GLOBAL · USER/i, 'the old view ends in the bare project and owner line');
    assert.doesNotMatch(nt, /Which of the four open points/, 'the card question is nowhere');
    assert.doesNotMatch(await page.locator('.overview-today').innerText(), /Recommendation from/);
  });
  await scenario(t, { hash: '' }, async (page) => {
    assert.ok(await page.locator('.dcard').count() >= 3, 'positive control: the same data with the new script');
  });
});

test('a write makes the card come with the freshly computed part (the projects part carries its cards)', () => {
  const root = world();
  const data = dashboardData.collectDashboard(root);
  assert.ok(data.today.projects.list.every((p) => p.card && p.card.question), 'positive control: every waiting project carries a card');
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem'), 'project', 'confirm', 'garden-plan', '--root', root], { encoding: 'utf8', input: '', env: { ...process.env, CHEAP_MEM_AGENT: 'builder-x', CHEAP_MEM_MAX_AUTHORITY: 'user' } });
  assert.equal(r.status, 0, r.stderr);
  const live = dashboardLive.compute(root, data, ['projects']);
  assert.deepEqual(live.errors, {});
  const names = live.data.today.projects.list.map((p) => p.name);
  assert.ok(!names.includes('garden-plan'), 'the confirmed project is gone from the fresh part');
  assert.ok(names.includes('hand-made'));
  const hand = live.data.today.projects.list.find((p) => p.name === 'hand-made');
  assert.equal(hand.card.question, 'Take over project hand-made?', 'the card is in the fresh part, not only in the stored one');
});
