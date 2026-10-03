// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/dash-package-cm-browser.test.mjs — the ported dashboard package in a real
// Chromium (task dash-paket-cm, 2026-10-03; the sibling's
// dash-bedienbar-lm-browser.test.mjs).
//
//   (1) Topics as a list: 30 rows first, sort by count/name, filter, "Show more",
//       tiles remembered in the browser, "Open thread" filters the entries page,
//       "Tags" is the second tab; categories stay hidden without data and show
//       (column, filter, overview) when `D.categories` carries the contract.
//   (2) Settings: saving gives feedback in the button and a status line; a refused
//       value says why.
//   (3) Confirm a new project by a click (password session, dialog).
//   (4) Offline reading view: a download, opened from file:// without a single
//       outside request; search and detail work; no sideways scroll at 390 px.
//   (5) Overview order (day slot, figures, network, Today, recently) and the
//       legend in two paragraphs; no sideways scroll at 390 px.
//   (6) Raw capture review without digested entries explains itself.
//
// Red proof, pinned to the FIXED base commit 24cd9a9: the same page with the old
// script swapped in through page.route has no topic list (positive control: the
// new one has).
// Without Playwright/Chromium the tests are SKIPPED with a reason, never green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as login from '../src/login.mjs';
import { startBrowser, waitReady } from './fixture/browser.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const OLD = '24cd9a9';
const { browser, reason } = await startBrowser();
const SKIP = reason;
const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const TOPICS = Array.from({ length: 41 }, (_, i) => `area${String(i % 5)}/topic-${String(i).padStart(2, '0')}`);
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dpc-b-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'dpcb', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  const TYPES = ['learning', 'decision', 'event'];
  for (let i = 0; i < 120; i += 1) {
    const t = TOPICS[i % TOPICS.length];
    memory.logEntry(r, TYPES[i % 3], { title: `Entry ${i} ${t}`, text: `Body ${i} ${t}`, tags: [`tag-${i % 7}`], topic: t });
  }
  execFileSync('node', [path.join(REPO, 'bin', 'mem'), 'project', 'new', 'garden', '--title', 'Garden', '--reason', 'probe'], { env: { ...process.env, CHEAP_MEM_ROOT: r, MEM_HEADLESS: '' }, stdio: 'ignore' });
  return r;
}

async function start(root, { withLogin = false } = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?dpcb=${Math.random()}`);
  const env = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '' };
  let session = null;
  if (withLogin) {
    const dir = login.dirFor(root, env);
    login.setPassword(dir, 'a-proper-long-password');
    session = login.newSession(dir);
  } else env.CHEAP_MEM_SERVE_LOGIN = 'off';
  const { server } = await mod.serve(root, env, { allowWrites: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, session, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

async function open(s, route, { width = 1280, light = false, oldScript = null, accept = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, acceptDownloads: true });
  if (s.session) await ctx.addCookies([{ name: login.COOKIE, value: s.session, url: s.base }]);
  await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* without storage */ } }, light);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (accept) page.on('dialog', (d) => d.accept());
  if (oldScript) await page.route(/\/dashboard\/app\.js(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
  await page.goto(`${s.base}/dashboard#${route}`);
  await waitReady(page);
  return { ctx, page, errors };
}
const overflows = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const rowsOf = (page) => page.locator('#topicList .tl-row').count();

test('(1) topics: a list of 30, sort, filter, show more, tiles remembered, thread filter, tags tab', { skip: SKIP, timeout: 600000 }, async () => {
  const s = await start(world());
  try {
    const { ctx, page, errors } = await open(s, 'knowledge/topics');
    await page.waitForSelector('#topicList .tl-row');
    assert.equal(await rowsOf(page), 30, 'first window: 30 rows');
    assert.equal(await page.locator('.tl-tile').count(), 0);
    assert.match(await page.textContent('.tl-foot'), /30 of 41 topics/);
    const counts = await page.$$eval('#topicList .tl-row .tl-count', (a) => a.map((x) => Number(x.textContent.replace(/\D/g, ''))));
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'count descending by default');
    await page.click('.tl-sort[data-value=name]');
    const names = await page.$$eval('#topicList .tl-name', (a) => a.map((x) => x.textContent));
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
    await page.fill('#topicSearch', 'topic-0');
    assert.equal(await rowsOf(page), 10);
    assert.match(await page.textContent('.tl-foot'), /10 of 10 topics \(filtered\)/);
    await page.fill('#topicSearch', 'no-such-topic');
    assert.equal(await rowsOf(page), 0);
    await page.fill('#topicSearch', '');
    await page.click('[data-action=topic-more]');
    assert.equal(await rowsOf(page), 41, 'show more adds the rest');
    // categories: hidden without data
    assert.equal(await page.locator('#topicCat, .tl-overview, .tl-k-cat').count(), 0, 'no categories without data');
    // tiles, remembered
    await page.click('.tl-view [data-value=tiles]');
    assert.equal(await page.locator('.tl-tile').count(), 41 > 48 ? 48 : 41);
    await page.reload(); await waitReady(page);
    await page.waitForSelector('.tl-tile');
    assert.equal(await page.evaluate(() => localStorage.getItem('cm-dash-topics-view')), 'tiles');
    await page.click('.tl-view [data-value=list]');
    // thread filter
    await page.fill('#topicSearch', TOPICS[3]);
    await page.click('#topicList .tl-row [data-action=topic-thread]');
    await page.waitForSelector('#entriesPageLink');
    assert.match(await page.textContent('.tl-active'), new RegExp(`Topic: ${TOPICS[3]}`));
    const hits = await page.textContent('.tablefoot span');
    assert.match(hits, /^\s*3 hits/, `entries of that topic only (got ${hits})`);
    await page.click('[data-action=reset-filters]');
    assert.equal(await page.locator('.tl-active').count(), 0, 'reset clears the thread');
    // tags tab
    await page.evaluate(() => route('knowledge/topics'));
    await page.click('.tl-source [data-value=tags]');
    await page.waitForSelector('#topicList .tl-row');
    assert.match(await page.textContent('.tl-sort.tl-k-name'), /Tag/);
    assert.ok(await rowsOf(page) >= 7 && (await page.textContent('#topicList')).includes('tag-6'), 'the free tags (tag-0 … tag-6, plus the tag the project event carries)');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await s.stop(); }
});

test('(1b) categories show only when D.categories carries the contract', { skip: SKIP, timeout: 400000 }, async () => {
  const s = await start(world());
  try {
    const { ctx, page } = await open(s, 'knowledge/topics');
    await page.waitForSelector('#topicList .tl-row');
    const t0 = TOPICS[0], t1 = TOPICS[1];
    await page.evaluate(([a, b]) => {
      D.categories = {
        list: [{ key: 'infra', label: 'Infrastructure', status: 'confirmed', topics: 1, entries: 3 }, { key: 'newone', label: 'Fresh', status: 'seed', topics: 1, entries: 3 }],
        topics: [{ topic: a, count: 3, category: { key: 'infra', label: 'Infrastructure', status: 'confirmed', source: 'person' } }, { topic: b, count: 3, category: { key: 'newone', label: 'Fresh', status: 'proposal', source: 'rule' } }],
        unassigned: { topics: 39, entries: 100 }, proposals: [{ topic: b, category: 'newone', label: 'Fresh' }], new: [{ key: 'newone', label: 'Fresh' }], wishes: [], threshold: 5,
      };
      render();
    }, [t0, t1]);
    await page.waitForSelector('.tl-overview');
    assert.equal(await page.locator('.tl-cat-row').count(), 2);
    assert.match(await page.textContent('.tl-overview'), /39 topics \(100 entries\) without a category · 1 proposals await/);
    assert.ok(await page.locator('#topicCat').count(), 'filter');
    await page.selectOption('#topicCat', 'infra');
    assert.equal(await rowsOf(page), 1);
    await page.selectOption('#topicCat', '__none');
    assert.equal(await rowsOf(page), 30, 'no category: the 39 others, first window');
    await page.selectOption('#topicCat', '');
    assert.match(await page.textContent('.tl-row:has-text("topic-01")'), /Proposal/);
    // a broken contract hides everything again, no error on the page
    await page.evaluate(() => { D.categories = { error: 'unreadable' }; render(); });
    assert.equal(await page.locator('.tl-overview, #topicCat').count(), 0);
    await ctx.close();
  } finally { await s.stop(); }
});

test('(1c) red proof: the base commit has no topic list; the new page does', { skip: SKIP, timeout: 400000 }, async (t) => {
  let oldJs;
  try { oldJs = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return t.skip(`commit ${OLD} not reachable — red proof unknown, not green`); }
  const s = await start(world());
  try {
    const o = await open(s, 'knowledge/topics', { oldScript: oldJs });
    await o.page.waitForSelector('#screen .panel');
    assert.equal(await o.page.locator('#topicList .tl-row').count(), 0, 'old script: no list');
    assert.ok(await o.page.locator('#screen .grid.three .panel').count() > 5, 'old script: tiles');
    await o.ctx.close();
    const n = await open(s, 'knowledge/topics');
    assert.ok(await n.page.locator('#topicList .tl-row').count() > 0, 'positive control');
    await n.ctx.close();
  } finally { await s.stop(); }
});

test('(2) settings: saving gives feedback; a refused value says why', { skip: SKIP, timeout: 400000 }, async () => {
  const s = await start(world());
  try {
    const { ctx, page } = await open(s, 'settings/system');
    const field = page.locator('.setting-field[data-id="error-window"]');
    await field.fill('21');
    await page.click('[data-action=save-config]');
    await page.waitForFunction(() => /Saved and logged: /.test(document.querySelector('#configStatus')?.textContent || ''), null, { timeout: 15000 });
    assert.match(await page.textContent('#configStatus'), /Saved and logged: .*(window|Window)/i);
    await page.locator('.setting-field[data-id="error-window"]').fill('99999999');
    await page.click('[data-action=save-config]');
    await page.waitForFunction(() => /Not saved:/.test(document.querySelector('#configStatus')?.textContent || ''), null, { timeout: 15000 });
    assert.match(await page.textContent('[data-action=save-config]'), /Error — try again/);
    await page.click('[data-action=save-config]').catch(() => {});
    await ctx.close();
  } finally { await s.stop(); }
});

test('(3) a new project is confirmed by a click (password session, dialog)', { skip: SKIP, timeout: 400000 }, async () => {
  const root = world();
  const s = await start(root, { withLogin: true });
  try {
    const { ctx, page } = await open(s, 'sources/projects');
    await page.waitForSelector('[data-action=project-confirm]');
    assert.match(await page.textContent('#screen'), /new · unconfirmed/);
    await page.click('[data-action=project-confirm]');
    await page.waitForFunction(() => !document.querySelector('[data-action=project-confirm]'), null, { timeout: 40000 });
    assert.ok(!/status:\s*new/.test(fs.readFileSync(path.join(root, 'projects', 'garden', 'facts.yaml'), 'utf8')), 'the new-mark is gone on disk');
    assert.ok(!/new · unconfirmed/.test(await page.textContent('#screen')));
    await ctx.close();
  } finally { await s.stop(); }
});

test('(4) offline reading view: download, file:// without an outside request, search and detail, no sideways scroll at 390', { skip: SKIP, timeout: 600000 }, async () => {
  const s = await start(world());
  try {
    const { ctx, page } = await open(s, 'sources/export');
    await page.waitForSelector('[data-action=export-html]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-action=export-html]')]);
    assert.match(dl.suggestedFilename(), /-reading\.html$/);
    const file = path.join(os.tmpdir(), `cm-dpc-view-${process.pid}.html`);
    roots.push(file);
    await dl.saveAs(file);
    for (const width of [1280, 390]) {
      const c2 = await browser.newContext({ viewport: { width, height: 800 } });
      const p2 = await c2.newPage();
      const requests = [];
      const errs = [];
      p2.on('request', (r) => { if (!r.url().startsWith('file:')) requests.push(r.url()); });
      p2.on('pageerror', (e) => errs.push(e.message));
      await p2.goto(pathToFileURL(file).href);
      await p2.waitForSelector('#list li');
      await p2.fill('#search', 'topic-07');
      const shown = await p2.locator('#list button.row').count();
      assert.ok(shown > 0 && shown < 120, `search narrows the list (${shown})`);
      await p2.click('#list button.row');
      assert.match(await p2.textContent('#detail'), /topic-07/);
      assert.equal(await overflows(p2), false, `no sideways scroll at ${width}`);
      assert.deepEqual(requests, [], 'no outside request');
      assert.deepEqual(errs, []);
      await c2.close();
    }
    await ctx.close();
  } finally { await s.stop(); }
});

test('(5) overview: order and legend, no sideways scroll at 1920 or 390, light and dark', { skip: SKIP, timeout: 600000 }, async () => {
  const s = await start(world());
  try {
    for (const [width, light] of [[1920, false], [1920, true], [390, false], [390, true]]) {
      const { ctx, page, errors } = await open(s, 'home', { width, light });
      await page.waitForSelector('.home-layout');
      const top = (sel) => page.evaluate((q) => { const e = document.querySelector(q); return e ? e.getBoundingClientRect().top + scrollY : null; }, sel);
      const [metrics, net, today, recent] = [await top('.metrics'), await top('.home-layout'), await top('.overview-today'), await top('.sectionline')];
      assert.ok(metrics < net && net < today && today < recent, `order at ${width}: ${[metrics, net, today, recent]}`);
      const w = await page.evaluate(() => ({ today: document.querySelector('.overview-today')?.getBoundingClientRect().width, metrics: document.querySelector('.metrics').getBoundingClientRect().width }));
      assert.ok(Math.abs(w.today - w.metrics) < 4, 'Today runs the full width of the figures');
      assert.equal(await page.locator('#homeDay').evaluate((e) => getComputedStyle(e).display), 'none', 'the empty day slot takes no room');
      assert.equal(await page.locator('.graph-description').count(), 2, 'legend: two paragraphs');
      assert.match(await page.textContent('.graph-description:nth-of-type(1)'), /^What you see/);
      assert.equal(await overflows(page), false, `no sideways scroll at ${width}`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  } finally { await s.stop(); }
});

test('(6) raw capture review without digested entries explains itself', { skip: SKIP, timeout: 400000 }, async () => {
  const s = await start(world());
  try {
    const { ctx, page } = await open(s, 'sources/raw');
    await page.evaluate(() => {
      rawSamples.push({ path: 'raw/2026/10/x--s1.jsonl.gz', session: 's1', project: null, topics: [], state: 'present', at: '2026-10-01T10:00:00Z', lines: 4, bytes: 10, entries: [] });
      rawReview('raw/2026/10/x--s1.jsonl.gz');
    });
    await page.waitForSelector('#info[open]');
    const text = await page.textContent('#info');
    assert.match(text, /Nothing was digested from this capture/);
    assert.match(text, /never shown in the dashboard/);
    assert.ok(!/No entry was digested from this capture\./.test(text), 'the old, misleading line is gone');
    await ctx.close();
  } finally { await s.stop(); }
});
