// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/kat-klicks-cm-browser.test.mjs — the category click actions in a real
// Chromium (task kat-klicks-cm, 2026-10-03; parity with lucky-mem
// dash-kategorien-lm). A throwaway root with categories, topics and proposals;
// a password session; every action writes through the task route and the
// lines land on disk.
//
//   (1) assign by select; confirm one proposal; confirm all (dialog)
//   (2) acknowledge, rename (dialog), merge (dialog) an automatic category
//   (3) create a category; a refusal names its reason and writes nothing
//   (4) without a password session: no click controls, the commands to copy
//   (5) no sideways scroll at 390 px, status text contrast AA, light and dark
//   (6) red proof, pinned to the FIXED base commit 5f9170b: its script has no
//       click controls; positive control: the new one has.
// Without Playwright/Chromium the tests are SKIPPED with a reason, never green.
/* global document, getComputedStyle, localStorage -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as categories from '../src/categories.mjs';
import * as login from '../src/login.mjs';
import { startBrowser, waitReady, startView } from './fixture/browser.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '5f9170b';
const { browser, reason } = await startBrowser();
const SKIP = reason;
const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const T = ['infra/deploys', 'infra/backups', 'infra/monitoring', 'design/tokens', 'design/layout', 'garden/beds', 'garden/compost', 'misc/one', 'misc/two', 'misc/three'];
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-kk-b-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'kkb', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  for (let i = 0; i < 40; i += 1) { const t = T[i % T.length]; memory.logEntry(r, 'learning', { title: `Entry ${i} ${t}`, text: `Body ${i}`, tags: ['x'], topic: t }); }
  categories.createCategory(r, 'infrastructure', 'Infrastructure');
  categories.createCategory(r, 'design', 'Design');
  categories.assign(r, 'infra/deploys', 'infrastructure');
  categories.assign(r, 'design/tokens', 'design');
  // three topics wish the same new category: it creates itself (status automatic), the topics get proposals
  categories.decide(r, ['garden/beds', 'garden/compost', 'misc/one'].map((t) => ({ topic: t, source: 'agent', fresh: { key: 'gardening', label: 'Gardening' } })), { write: true });
  categories.decide(r, [{ topic: 'infra/backups', source: 'agent', category: 'infrastructure' }, { topic: 'design/layout', source: 'agent', category: 'design' }], { write: true });
  return r;
}
const lines = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const view = (root) => categories.view(root);

async function start(root, { withLogin = true } = {}) {
  const env = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '' };
  let session = null;
  if (withLogin) {
    const dir = login.dirFor(root, env);
    login.setPassword(dir, 'a-proper-long-password');
    session = login.newSession(dir);
  } else env.CHEAP_MEM_SERVE_LOGIN = 'off';
  // warm (with the session cookie when login is on, else the warm-up would only see the sign-in page)
  const { base, stop } = await startView(root, env, { serveOpts: { allowWrites: true }, cookie: session ? `${login.COOKIE}=${session}` : '' });
  return { base, session, stop };
}

async function open(s, { width = 1280, light = false, oldScript = null, dialogs = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 } });
  if (s.session) await ctx.addCookies([{ name: login.COOKIE, value: s.session, url: s.base }]);
  await ctx.addInitScript((l) => { try { localStorage.setItem('cm-dash-light', l ? '1' : '0'); } catch { /* without storage */ } }, light);
  const page = await ctx.newPage();
  const seen = [];
  page.on('dialog', (d) => { seen.push({ type: d.type(), message: d.message() }); if (dialogs) d.accept(typeof dialogs === 'string' ? dialogs : undefined); else d.dismiss(); });
  if (oldScript) await page.route(/\/dashboard\/app\.js(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
  await page.goto(`${s.base}/dashboard#knowledge/topics`);
  await waitReady(page);
  await page.waitForSelector('#topicList .tl-row');
  return { ctx, page, seen };
}
const status = (page) => page.textContent('#catStatus');
const waitStatus = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#catStatus')?.textContent || ''), re.source, { timeout: 40000 });
const overflows = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test('(1) assign by select, confirm one proposal, confirm all (dialog)', { skip: SKIP, timeout: 600000 }, async () => {
  const root = world();
  const s = await start(root);
  try {
    const { ctx, page, seen } = await open(s);
    assert.equal(view(root).proposals.length, 5);
    // assign
    await page.selectOption('[data-cat-assign="infra/monitoring"]', 'infrastructure');
    await waitStatus(page, /confirmed/);
    assert.equal(lines(root, 'global/topic-category.jsonl').filter((l) => l.topic === 'infra/monitoring' && l.status === 'confirmed').length, 1);
    assert.equal(await page.locator('[data-cat-assign="infra/monitoring"]').inputValue(), 'infrastructure', 'the select shows the new state');
    // confirm one
    await page.click('.tl-row:has-text("infra/backups") [data-action=cat-confirm]');
    await waitStatus(page, /confirmed/);
    assert.equal(view(root).proposals.length, 4);
    assert.equal(await page.locator('.tl-row:has-text("infra/backups") [data-action=cat-confirm]').count(), 0, 'its button is gone');
    // confirm all, behind a dialog
    assert.match(await page.textContent('[data-action=cat-confirm-all]'), /Confirm all proposals \(4\)/);
    await page.click('[data-action=cat-confirm-all]');
    await waitStatus(page, /4 proposals confirmed/);
    assert.ok(seen.some((d) => d.type === 'confirm' && /Confirm all 4 proposals/.test(d.message)), 'a dialog asked first: ' + JSON.stringify(seen));
    assert.equal(view(root).proposals.length, 0);
    assert.equal(await page.locator('[data-action=cat-confirm-all], [data-action=cat-confirm]').count(), 0);
    await ctx.close();
  } finally { await s.stop(); }
});

test('(1b) a dismissed dialog writes nothing', { skip: SKIP, timeout: 400000 }, async () => {
  const root = world();
  const s = await start(root);
  try {
    const { ctx, page } = await open(s, { dialogs: false });
    await page.click('[data-action=cat-confirm-all]');
    await page.waitForTimeout(1500);
    assert.equal(view(root).proposals.length, 5, 'nothing was written');
    await ctx.close();
  } finally { await s.stop(); }
});

test('(2) acknowledge, rename (dialog), merge (dialog)', { skip: SKIP, timeout: 600000 }, async () => {
  const root = world();
  const s = await start(root);
  try {
    const { ctx, page, seen } = await open(s, { dialogs: 'Kitchen garden' });
    assert.equal(view(root).new.length, 1);
    await page.click('[data-action=cat-acknowledge]');
    await waitStatus(page, /confirmed/);
    assert.equal(view(root).new.length, 0, 'no longer new');
    assert.equal(await page.locator('[data-action=cat-acknowledge]').count(), 0);
    // rename (a prompt)
    await page.click('[data-action=cat-rename][data-key=gardening]');
    await waitStatus(page, /renamed/);
    assert.ok(seen.some((d) => d.type === 'prompt'), 'a dialog asked for the name');
    assert.equal(view(root).list.find((k) => k.key === 'gardening').label, 'Kitchen garden');
    // merge (a confirmation naming both)
    await page.selectOption('[data-cat-merge=design]', 'infrastructure');
    await waitStatus(page, /counts as/).catch(async () => { throw new Error('status: ' + (await status(page)) + ' dialogs: ' + JSON.stringify(seen)); });
    assert.ok(seen.some((d) => d.type === 'confirm' && /Merge category "Design" into "Infrastructure"/.test(d.message)));
    assert.ok(!view(root).list.some((k) => k.key === 'design'), 'design is an alias now');
    assert.equal(lines(root, 'global/category-aliases.jsonl').length, 1);
    await ctx.close();
  } finally { await s.stop(); }
});

test('(3) create a category; a refusal names its reason and writes nothing', { skip: SKIP, timeout: 600000 }, async () => {
  const root = world();
  const s = await start(root);
  try {
    const { ctx, page } = await open(s);
    // an empty name: a status line, no task
    await page.click('[data-action=cat-create]');
    assert.match(await status(page), /type a name/);
    await page.fill('#catNewLabel', 'Research');
    await page.press('#catNewLabel', 'Enter');
    await waitStatus(page, /created/);
    assert.ok(view(root).list.some((k) => k.key === 'research' && k.label === 'Research'));
    assert.equal(await page.locator('.tl-cat-name:has-text("Research")').count(), 1, 'the new category is listed');
    // a refusal: too like an existing one
    const before = lines(root, 'global/categories.jsonl').length;
    await page.fill('#catNewLabel', 'Infrastructures');
    await page.click('[data-action=cat-create]');
    await waitStatus(page, /Not saved: .*too like the category 'infrastructure'/s);
    assert.match(await status(page), /Nothing was written/);
    assert.equal(lines(root, 'global/categories.jsonl').length, before, 'nothing written');
    assert.match(await page.textContent('[data-action=cat-create]'), /Error|Create category/);
    await ctx.close();
  } finally { await s.stop(); }
});

test('(3b) shipped empty: a password session sees the first-category form, nobody else a panel', { skip: SKIP, timeout: 400000 }, async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-kk-e-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'kke', participants: { alex: { human: true } }, language: 'en' }));
  for (let i = 0; i < 6; i += 1) memory.logEntry(r, 'learning', { title: `E${i}`, text: `B${i}`, tags: ['x'], topic: `area/t${i}` });
  const s = await start(r);
  try {
    const { ctx, page } = await open(s);
    assert.equal(await page.locator('.tl-overview, #topicCat').count(), 0, 'no overview without data');
    await page.fill('#catNewLabel', 'First one');
    await page.click('[data-action=cat-create]');
    await page.waitForSelector('.tl-overview', { timeout: 40000 });
    assert.ok(view(r).list.some((k) => k.key === 'first-one'));
    await ctx.close();
  } finally { await s.stop(); }
  const s2 = await start(r, { withLogin: false });
  try {
    const o = await open(s2);
    assert.equal(await o.page.locator('#catNewLabel').count(), 0);
    await o.ctx.close();
  } finally { await s2.stop(); }
});

test('(4) without a password session: no click controls, the commands to copy', { skip: SKIP, timeout: 400000 }, async () => {
  const root = world();
  const s = await start(root, { withLogin: false });
  try {
    const { ctx, page } = await open(s);
    assert.equal(await page.locator('[data-action^=cat-confirm], [data-action=cat-rename], [data-action=cat-create], [data-cat-assign], [data-cat-merge]').count(), 0);
    assert.match(await page.textContent('.tl-cat-cmds summary'), /needs a password session/);
    const cmds = await page.$$eval('.tl-cat-cmds [data-sk-copy]', (a) => a.map((x) => x.dataset.skCopy));
    assert.ok(cmds.includes('node bin/mem category confirm --all-proposals') && cmds.includes('node bin/mem category merge <from> <to>'));
    // the server refuses on its own, too: a direct task call is not a person
    const r = await page.evaluate(async () => (await fetch('/task', { method: 'POST', body: new URLSearchParams({ kind: 'category-confirm', all: 'yes' }) })).status);
    assert.ok(r >= 400, `refused (${r})`);
    assert.equal(view(root).proposals.length, 5);
    await ctx.close();
  } finally { await s.stop(); }
});

test('(5) no sideways scroll at 390 px and 1920 px, status contrast AA, light and dark', { skip: SKIP, timeout: 600000 }, async () => {
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const s = await start(world());
  try {
    for (const width of [390, 1920]) for (const light of [false, true]) {
      const { ctx, page } = await open(s, { width, light });
      assert.equal(await overflows(page), false, `${width} ${light ? 'light' : 'dark'}: no sideways scroll`);
      // both status tones, on the panel they sit in
      await page.evaluate(() => { const st = document.querySelector('#catStatus'); st.textContent = 'Not saved: x'; st.className = 'small tl-cat-status-line red'; });
      const red = await page.evaluate(() => { const st = document.querySelector('#catStatus'); const c = getComputedStyle(st).color.match(/\d+/g).slice(0, 3).map(Number); let p = st, bg = null; while (p && !bg) { const v = getComputedStyle(p).backgroundColor.match(/[\d.]+/g).map(Number); if (v.length < 4 || v[3] > 0.9) bg = v.slice(0, 3); p = p.parentElement; } return { c, bg: bg || [255, 255, 255] }; });
      assert.ok(ratio(red.c, red.bg) >= 4.5, `${width} ${light ? 'light' : 'dark'}: red status ${ratio(red.c, red.bg).toFixed(2)}`);
      await page.evaluate(() => { document.querySelector('#catStatus').className = 'small tl-cat-status-line green'; });
      const green = await page.evaluate(() => { const st = document.querySelector('#catStatus'); const c = getComputedStyle(st).color.match(/\d+/g).slice(0, 3).map(Number); let p = st, bg = null; while (p && !bg) { const v = getComputedStyle(p).backgroundColor.match(/[\d.]+/g).map(Number); if (v.length < 4 || v[3] > 0.9) bg = v.slice(0, 3); p = p.parentElement; } return { c, bg: bg || [255, 255, 255] }; });
      assert.ok(ratio(green.c, green.bg) >= 4.5, `${width} ${light ? 'light' : 'dark'}: green status ${ratio(green.c, green.bg).toFixed(2)}`);
      await ctx.close();
    }
  } finally { await s.stop(); }
});

test('(6) red proof: the base commit has no click controls; the new page does', { skip: SKIP, timeout: 400000 }, async (t) => {
  let oldJs;
  try { oldJs = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return t.skip(`commit ${OLD} not reachable — red proof unknown, not green`); }
  const s = await start(world());
  try {
    const o = await open(s, { oldScript: oldJs });
    assert.ok(await o.page.locator('.tl-overview').count() > 0, 'old script: the display-only overview is there');
    assert.equal(await o.page.locator('[data-action=cat-confirm-all], [data-cat-assign], [data-action=cat-create]').count(), 0, 'old script: no click controls');
    await o.ctx.close();
    const n = await open(s);
    assert.ok(await n.page.locator('[data-action=cat-confirm-all]').count() > 0 && await n.page.locator('[data-cat-assign]').count() > 0, 'positive control');
    await n.ctx.close();
  } finally { await s.stop(); }
});
