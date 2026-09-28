// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/dash-fix4-tabs-visible.test.mjs — every tab shows something VISIBLE
// in a real browser (parity with lucky-mem dash-fix4, 2026-09-28).
//
// **Why.** In the sibling house, "Duties & questions" and "Learnings"
// were blank on a phone: heading and tab bar, then nothing, no empty
// message. The rows were in the DOM, but `.reveal` keeps a panel at
// opacity 0 until an IntersectionObserver fires, and with
// `threshold: 0.07` a panel taller than ~14 viewports (60 long duties at
// 390 px width) never reaches 7 % of its own area on screen — it stays
// invisible forever. No data test and no HTML test can see that; only a
// browser reading the computed opacity can. This house ran the same
// dashboard.js logic.
//
// **What is checked.** A real server (bin/mem-serve) over a small memory
// with many long duties and learnings, Chromium (Playwright) at phone
// 390x844 AND desktop 1440x900. For EVERY tab of every area: (a) text
// below the tab bar (content OR an explicit empty/unknown message), (b)
// every panel, once scrolled to, is really visible (computed opacity 1),
// (c) no page error and no content-security-policy violation. Plus: a
// renderer that throws yields a visible "unknown + reason" note, and the
// raw-capture export button always ends in a visible result.
//
// **Red proof inside the test, pinned to a FIXED commit** (never
// `merge-base`, which moves after the merge): the same browser run with
// `assets/dashboard/dashboard.js` from 6154cd0a (origin/main before this
// change), swapped in through `page.route`, must find invisible panels —
// that is also the positive control that the probe looks at all.
//
// Without Playwright/Chromium the tests are SKIPPED with a reason
// (visible as `# SKIP`), never silently green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const OLD = '6154cd0a';

function loadPlaywright() {
  const places = [REPO + '/', '/opt/node22/lib/node_modules/', ...(process.env.NODE_PATH || '').split(':').filter(Boolean).map((p) => p + '/')];
  for (const p of places) {
    try { return createRequire(p)('playwright'); } catch { /* next place */ }
  }
  return null;
}
const pw = loadPlaywright();
let browser = null;
let why = pw ? null : 'playwright not installed';
if (pw) {
  try { browser = await pw.chromium.launch(); } catch (e) { why = 'Chromium does not start: ' + String(e.message).split('\n')[0]; }
}
const NEEDS = why ? { skip: why } : {};

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dash-fix4-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'fix4', participants: { alex: { human: true } }, language: 'en' }));
  const long = ' — ' + 'a long sentence that needs several lines on a phone and makes the row tall'.repeat(6);
  for (let i = 0; i < 70; i += 1) {
    memory.logEntry(r, 'duty', { title: `Duty ${i}${long}`, who: 'alex' });
    memory.logEntry(r, 'learning', { title: `Learning ${i}${long}`, text: 'Evidence.' });
  }
  memory.logEntry(r, 'question', { question: 'Is the tab visible?' });
  return r;
}

async function startServer(r) {
  const mod = await import(`${pathToFileURL(SERVE).href}?fix4=${Math.random()}`);
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '' }, { allowWrites: true });
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((res) => server.close(res)) };
}

async function allTabs(page) {
  return page.evaluate(() => Object.entries(sections).flatMap(([a, s]) => (s.tabs.length ? s.tabs.map(([t]) => `${a}/${t}`) : [a])));
}

/** Opens a tab and returns what a person would see: text below the tab
 * bar and, per panel, the opacity AFTER scrolling to it. innerText alone
 * would not do — it was full in the failure case. */
async function visibility(page, route) {
  await page.evaluate((h) => { location.hash = h; }, '#' + route);
  await page.waitForFunction((h) => {
    const [a, t] = h.split('/');
    const active = document.querySelector('#screen nav.tabs button.active');
    return t ? active?.dataset.route === h : document.body.dataset.area === a && !document.querySelector('#screen .loading, #screen .laden');
  }, route, { timeout: 15000 });
  await page.waitForTimeout(150);
  const n = await page.evaluate(() => document.querySelectorAll('#screen .panel, #screen .metrics').length);
  for (let i = 0; i < n; i += 1) {
    await page.evaluate((k) => document.querySelectorAll('#screen .panel, #screen .metrics')[k]?.scrollIntoView({ block: 'start', behavior: 'instant' }), i);
    await page.waitForTimeout(60);
  }
  // Wait for running reveal animations (0.7 s + at most 275 ms delay). A
  // PAUSED one (never revealed) never finishes and stays at opacity 0 —
  // exactly what must show up below.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming?.().endTime)).map((a) => a.finished.catch(() => null))),
    new Promise((res) => setTimeout(res, 2000)),
  ]));
  return page.evaluate(() => {
    const scr = document.querySelector('#screen');
    const tabs = scr.querySelector('nav.tabs');
    let text = '';
    if (tabs) {
      for (let el = tabs.nextElementSibling; el; el = el.nextElementSibling) text += el.innerText || '';
    } else text = scr.innerText || '';
    const panels = [...scr.querySelectorAll('.panel, .metrics')].map((el) => ({
      title: (el.querySelector('h2')?.textContent || el.className).slice(0, 60),
      height: Math.round(el.getBoundingClientRect().height),
      opacity: Number(getComputedStyle(el).opacity),
    }));
    return { text: text.trim(), panels };
  });
}

async function open(base, viewport, { oldScript } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy/.test(m.text())) errors.push('CSP: ' + m.text().slice(0, 160)); });
  if (oldScript) {
    await page.route('**/dashboard/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
  }
  await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 60000 });
  return { page, ctx, errors };
}

function oldScript(t) {
  try {
    return execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    t.skip(`commit ${OLD} not reachable (shallow clone?) — red proof unknown, not green`);
    return null;
  }
}

test.after(async () => { await browser?.close(); });

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
  test(`${name}: every tab shows visible content or an explicit message`, NEEDS, async () => {
    const s = await startServer(world());
    const { page, ctx, errors } = await open(s.base, viewport);
    try {
      const tabs = await allTabs(page);
      assert.ok(tabs.length >= 30, `too few tabs found (${tabs.length}) — probe blind?`);
      const faults = [];
      for (const route of tabs) {
        const v = await visibility(page, route);
        if (!v.text) faults.push(`${route}: no text below the tab bar`);
        for (const p of v.panels) if (p.opacity < 0.99) faults.push(`${route}: panel "${p.title}" (${p.height}px) invisible, opacity ${p.opacity}`);
      }
      assert.deepEqual(faults, [], faults.join('\n'));
      assert.deepEqual(errors, [], 'pageerror/CSP: ' + errors.join(' | '));
    } finally { await ctx.close(); await s.stop(); }
  });
}

test('phone: the long panels really are long — otherwise the check above proves nothing', NEEDS, async () => {
  const s = await startServer(world());
  const { page, ctx } = await open(s.base, { width: 390, height: 844 });
  try {
    for (const route of ['work/tasks', 'knowledge/learnings']) {
      const v = await visibility(page, route);
      const tallest = Math.max(...v.panels.map((p) => p.height));
      assert.ok(tallest > 844 / 0.07, `${route}: tallest panel only ${tallest}px — the world does not reproduce the fault`);
    }
  } finally { await ctx.close(); await s.stop(); }
});

test('a renderer that throws shows "unknown + reason" instead of a blank area', NEEDS, async () => {
  const s = await startServer(world());
  const { page, ctx } = await open(s.base, { width: 390, height: 844 });
  try {
    await page.evaluate(() => { pages.learnings = () => { throw new Error('probe-throw'); }; });
    const v = await visibility(page, 'knowledge/learnings');
    assert.match(v.text, /could not be drawn: probe-throw/);
    assert.match(v.text, /unknown/);
  } finally { await ctx.close(); await s.stop(); }
});

test(`RED on the old state (${OLD}): Duties & questions and Learnings stay invisible on a phone`, NEEDS, async (t) => {
  const old = oldScript(t);
  if (!old) return;
  const s = await startServer(world());
  const { page, ctx } = await open(s.base, { width: 390, height: 844 }, { oldScript: old });
  try {
    for (const route of ['work/tasks', 'knowledge/learnings']) {
      const v = await visibility(page, route);
      assert.ok(v.text.length > 0, `${route}: the DOM holds text (the fault was never "no data")`);
      assert.ok(v.panels.some((p) => p.opacity < 0.99), `${route}: the old state should have been invisible — the probe does not look`);
    }
  } finally { await ctx.close(); await s.stop(); }
});

// --- Raw-capture export: a click always ends in a visible result ---------
async function exportClick(page) {
  await page.evaluate(() => { location.hash = '#sources/raw'; });
  const b = page.locator('#screen button[data-action="raw-export"]');
  await b.first().waitFor({ state: 'visible', timeout: 15000 });
  await b.first().click();
  await page.waitForFunction(() => {
    const t = document.querySelector('.raw-export-state')?.innerText || '';
    return t && !/Running|Starting/.test(t);
  }, null, { timeout: 120000 });
  return {
    state: await page.locator('.raw-export-state').first().innerText(),
    toast: await page.locator('#toast').innerText(),
  };
}

test('raw export: the click starts the real task and shows state, counts and target folder', NEEDS, async () => {
  const r = world();
  const s = await startServer(r);
  const { page, ctx } = await open(s.base, { width: 390, height: 844 });
  try {
    const x = await exportClick(page);
    assert.match(x.state, /State/);
    assert.match(x.state, /Target folder \(server\)/);
    assert.match(x.toast, /^Raw capture export: /);
  } finally { await ctx.close(); await s.stop(); }
});

test('raw export: a refused start (foreign-host) becomes visible, with the remedy', NEEDS, async () => {
  const s = await startServer(world());
  const { page, ctx } = await open(s.base, { width: 390, height: 844 });
  try {
    await page.route('**/task', (r) => (r.request().method() === 'POST'
      ? r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ state: 'error', reason: 'foreign-host' }) })
      : r.continue()));
    const x = await exportClick(page);
    assert.match(x.state, /not started: foreign-host/);
    assert.match(x.state, /CHEAP_MEM_SERVE_HOSTS/);
    assert.match(x.toast, /not started: foreign-host/);
  } finally { await ctx.close(); await s.stop(); }
});

test(`RED on the old state (${OLD}): no export button under Raw capture, the package buttons are silently disabled`, NEEDS, async (t) => {
  const old = oldScript(t);
  if (!old) return;
  const s = await startServer(world());
  const { page, ctx } = await open(s.base, { width: 390, height: 844 }, { oldScript: old });
  try {
    await visibility(page, 'sources/raw');
    assert.equal(await page.locator('#screen button[data-action="raw-export"]').count(), 0);
    await visibility(page, 'sources/export');
    assert.equal(await page.locator('#screen button[data-action="export-json"][disabled]').count(), 1, 'old state: a silent disabled button');
  } finally { await ctx.close(); await s.stop(); }
});

test('new state: no export button in the export studio is silently disabled', NEEDS, async () => {
  const s = await startServer(world());
  const { page, ctx } = await open(s.base, { width: 390, height: 844 });
  try {
    await visibility(page, 'sources/export');
    assert.equal(await page.locator('#screen button[data-action^="export-"][disabled]').count(), 0);
    // Playwright treats aria-disabled as "not clickable"; a person clicks anyway.
    await page.locator('#screen button[data-action="export-json"]').click({ force: true });
    assert.match(await page.locator('#toast').innerText(), /not built/);
  } finally { await ctx.close(); await s.stop(); }
});
