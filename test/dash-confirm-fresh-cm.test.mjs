// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/dash-confirm-fresh-cm.test.mjs - "Confirm answer" shows the new state at once, not after the cache expires
// (dashboard-tempo-cm, 2026-10-16; the sibling's H7, owner decision 294tkqgrdx20, bug 3fzbv8vxvosj).
//
// Finding (base dc6b69d): the task kind question-confirm was REBUILD_ONLY. The click wrote the closing line, the page
// then asked /dashboard.json and got the stored state: the question still "answered, waiting for you", the confirm
// button still there, also after a reload - until the rebuild was through (seconds on a real store, minutes with the
// gap). Projects, settings, messages, gold and raw captures had a live part; the confirm of an answer had none.
//
// Measure:          after the task ends: is the question in `waitingQuestions` of /dashboard.json, does the page still
//                   offer "Confirm answer" for it, what does its state badge say.
// Starting value:   waiting, button there, badge "answered, waiting for you" (rebuild held for a minute).
// Expected change:  the next read shows it closed: not waiting, no button, `cache.fresh` honestly false and
//                   `live_parts` naming `questions` - within the time the click flow takes, while the rebuild is held.
// Abort criterion:  the old state after the click / a compact store pretends a fresh list / a list that cannot be read
//                   is laid on as empty.
//
// Red proof: the SAME scenarios against the fixed base dc6b69d (exported; it already has the build pause switch).
// Without Playwright/Chromium the browser probes are SKIPPED with a reason, never green.
/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as memory from '../src/memory.mjs';
import * as login from '../src/login.mjs';
import * as dashboardLive from '../src/dashboard-live.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';
import { lazyBrowser, browserStartProbe, startView, waitReady } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'dc6b69d58cbc90e35827f62381897bc3abe8fee6'; // fixed base before the change (never merge-base: that one moves)
const PEOPLE = { alex: { human: true }, bot: {} };
const HELD_MS = 120000; // every rebuild after priming is held this long: what the page shows comes from the live part or is old
const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

const B = lazyBrowser();
browserStartProbe(B);

/** A memory with one question of the person (tier user) that an agent answered: it waits for the person's confirmation. */
function world() {
  const root = tmp('cm-cfresh-');
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'cfresh', participants: PEOPLE, language: 'en' }));
  for (let i = 0; i < 12; i += 1) memory.logEntry(root, 'learning', { title: `Entry ${i}`, text: `Body ${i}`, tags: ['x'], topic: `t/${i % 4}` });
  const q = memory.logEntry(root, 'question', { question: 'Which port does the dashboard use?', title: 'Which port does the dashboard use?', authority: 'user', agent: 'owner' }).entry;
  const open = memory.logEntry(root, 'question', { question: 'Who owns the garden project?', title: 'Who owns the garden project?', authority: 'user', agent: 'owner' }).entry;
  const a = memory.logEntry(root, 'decision', { title: 'Port 8080', choice: '8080', why: 'default', agent: 'session' }).entry;
  memory.logEntry(root, 'link', { from: a.id, to: q.id, kind: 'resolves', authority: 'agent', agent: 'session' });
  return { root, q, open, a };
}

// ---------------------------------------------------------------- (1) the module
test('(1) module: question-confirm names the part questions; the part comes from the function the build calls', () => {
  assert.deepEqual(dashboardLive.TASK_PARTS['question-confirm'], ['questions']);
  assert.ok(!Object.hasOwn(dashboardLive.REBUILD_ONLY, 'question-confirm'), 'not rebuild-only any more');
  const w = world();
  const built = dashboardData.collectDashboard(w.root, { env: {} });
  assert.deepEqual(built.waitingQuestions.map((x) => x.id), [w.q.id], 'positive control: the build sees the waiting question');
  assert.deepEqual(built.openQuestions.map((x) => x.id), [w.open.id]);
  const same = dashboardLive.compute(w.root, built, ['questions'], {});
  assert.deepEqual(same.errors, {});
  for (const k of ['openQuestions', 'waitingQuestions', 'cards_omitted']) assert.deepEqual(same.data[k], built[k], `${k}: the live part equals the build`);
  // the person confirms (one user edge closes the question)
  memory.logEntry(w.root, 'link', { from: w.a.id, to: w.q.id, kind: 'resolves', authority: 'user', confirmed: true });
  const after = dashboardLive.compute(w.root, built, ['questions'], {});
  assert.deepEqual(after.data.waitingQuestions, [], 'the confirmed question waits no more');
  assert.deepEqual(after.data.openQuestions.map((x) => x.id), [w.open.id], 'the open one stays');
  assert.deepEqual(built.waitingQuestions.map((x) => x.id), [w.q.id], 'the stored state is not changed (it serves many answers)');
});

test('(1b) module: a compact store is named and keeps the stored lists; an unreadable list is a reason, never an empty answer', () => {
  const w = world();
  const built = dashboardData.collectDashboard(w.root, { env: {} });
  const compact = dashboardLive.compute(w.root, { ...built, compact: true }, ['questions'], {});
  assert.match(compact.errors.questions, /built compact/);
  assert.deepEqual(compact.data.waitingQuestions, built.waitingQuestions, 'compact: the stored list stays');
  // questionLists (the build's and the part's one place): a list that throws is named; the part turns a reason into an error
  const broken = dashboardData.questionLists(w.root, { questionsWaiting: () => { throw new Error('drawer not readable'); } });
  assert.deepEqual(broken.reasons, ['waiting questions not readable: drawer not readable']);
  assert.deepEqual(broken.openQuestions.map((x) => x.id), [w.open.id], 'the other list is read all the same');
});

// ---------------------------------------------------------------- the server
/** A server with the background path, a long gap and (after priming) a held rebuild, like a real store. */
async function startServer(w, repo = REPO) {
  const env = {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '', MEM_RECALL_SERVER: '0',
    CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0', CHEAP_MEM_SERVE_CACHE_GAP_TEST_MS: '600000',
  };
  const dir = login.dirFor(w.root, env);
  login.setPassword(dir, 'a-proper-long-password');
  const session = login.newSession(dir);
  const cookie = `${login.COOKIE}=${session}`;
  const { base, stop } = await startView(w.root, env, { repo, serveOpts: { allowWrites: true }, cookie, keepFresh: false });
  const json = async (p) => (await fetch(`${base}${p}`, { headers: { cookie } })).json();
  const post = (route, fields) => fetch(`${base}${route}`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const dash = () => json('/dashboard.json');
  // Prime like a busy store: a new entry makes the first answer stale; the background build that follows starts the gap.
  const built0 = (await dash()).cache.built_at;
  memory.logEntry(w.root, 'learning', { title: 'Late entry', text: 'b', tags: ['x'], topic: 't/1' });
  for (let i = 0; i < 300; i += 1) { const c = (await dash()).cache; if (c.built_at !== built0 && c.fresh && !c.refreshing) break; await new Promise((r) => setTimeout(r, 200)); }
  const primed = (await dash()).cache;
  assert.ok(primed.built_at !== built0 && primed.fresh, 'primed: a background build has finished and started the gap');
  env.CHEAP_MEM_SERVE_BUILD_PAUSE_TEST_MS = String(HELD_MS); // from here on every rebuild is held
  return { base, session, cookie, json, post, dash, stop };
}

async function endOfTask(s, started) {
  for (let i = 0; i < 300; i += 1) {
    const t = await s.json(`/task.json?id=${encodeURIComponent(started.id)}`);
    if (t.running === false) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function httpScenario(repo) {
  const w = world();
  const s = await startServer(w, repo);
  try {
    const before = await s.dash();
    const started = await (await s.post('/task', { kind: 'question-confirm', id: w.q.id })).json();
    const end = await endOfTask(s, started);
    const after = await s.dash();
    return {
      w, before: before.waitingQuestions.map((x) => x.id), task: end?.state,
      after: after.waitingQuestions.map((x) => x.id), open: after.openQuestions.map((x) => x.id), cache: after.cache,
    };
  } finally { await s.stop(); }
}

test('(2) data route: after the confirm task the next read shows the question closed, with the rebuild held', { timeout: 400000 }, async () => {
  const o = await httpScenario(REPO);
  assert.deepEqual(o.before, [o.w.q.id], 'positive control: it waits before');
  assert.equal(o.task, 'ok', 'the task closed the question');
  assert.deepEqual(o.after, [], 'the confirmed question waits no more');
  assert.deepEqual(o.open, [o.w.open.id], 'the open question stays open');
  assert.equal(o.cache.fresh, false, 'honestly not fresh: the rebuild is held, the lists came from the live part');
  assert.ok(o.cache.live_parts.includes('questions'), JSON.stringify(o.cache));
  assert.ok(!o.cache.live_errors, JSON.stringify(o.cache.live_errors));
});

function baseTree(t) {
  const dir = tmp('cm-cfresh-base-');
  try { exportCommit(REPO, BASE, ['.'], dir); } catch {
    t.skip(`commit ${BASE} not reachable (shallow clone?) - red proof unknown, not green`);
    return null;
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

test(`(2b) red proof: the SAME scenario on the base ${BASE.slice(0, 7)} shows the question still waiting`, { timeout: 400000 }, async (t) => {
  const dir = baseTree(t);
  if (!dir) return;
  const o = await httpScenario(dir);
  assert.deepEqual(o.before, [o.w.q.id], 'positive control: the same starting state');
  assert.equal(o.task, 'ok', 'the old task closes it too (in the file)');
  assert.deepEqual(o.after, [o.w.q.id], 'old: the read after the confirm still says waiting');
});

// ---------------------------------------------------------------- the page
async function pageScenario(repo) {
  const w = world();
  const s = await startServer(w, repo);
  const browser = await B.get().then((h) => h.browser);
  const o = {};
  let ctx = null;
  try {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await ctx.addCookies([{ name: login.COOKIE, value: s.session, url: s.base }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('dialog', (d) => d.accept());
    const button = `[data-action="question-confirm"][data-id="${w.q.id}"]`;
    await page.goto(`${s.base}/dashboard#work/tasks`);
    await waitReady(page);
    await page.waitForSelector(`${button}:not([disabled])`);
    o.buttonBefore = await page.locator(button).count();
    // The clicked button is marked: once no marked node is left, the page has drawn after the click (render() replaces the view).
    await page.locator(button).evaluate((b) => { b.dataset.probeClicked = '1'; });
    const t0 = performance.now();
    await page.click(button);
    // The end state of the click flow: the toast of a closed question (old and new say it the same way) ...
    await page.waitForFunction((id) => (document.querySelector('#toast')?.textContent || '').includes(`Question ${id} closed`), w.q.id);
    // ... and the drawing after it.
    await page.waitForFunction(() => !document.querySelector('[data-probe-clicked]'));
    o.ms = Math.round(performance.now() - t0);
    o.buttonAfter = await page.locator(button).count();
    o.cache = (await s.dash()).cache;
    await page.reload();
    await waitReady(page);
    await page.waitForSelector('.panel h2');
    o.buttonReload = await page.locator(button).count();
    o.fileClosed = !dashboardData.questionLists(w.root).waitingQuestions.some((x) => x.id === w.q.id);
  } finally { await ctx?.close().catch(() => {}); await s.stop(); }
  return o;
}

test('(3) browser: after the click on "Confirm answer" the page shows the question closed - at once and after a reload', { timeout: 500000 }, async (t) => {
  if (!(await B.need(t))) return;
  const o = await pageScenario(REPO);
  assert.equal(o.buttonBefore, 1, 'positive control: the button is offered');
  assert.equal(o.fileClosed, true, 'the click wrote the closing line');
  assert.equal(o.buttonAfter, 0, 'the page offers no confirm for it any more');
  assert.equal(o.buttonReload, 0, 'and not after the reload either');
  assert.ok(o.ms < HELD_MS, `the new state came before the held rebuild (${o.ms} ms)`);
  assert.equal(o.cache.fresh, false, 'the cache path is real: the rebuild is still held');
});

test(`(3b) red proof in the browser: on the base ${BASE.slice(0, 7)} the reload still offers the confirm`, { timeout: 500000 }, async (t) => {
  if (!(await B.need(t))) return;
  const dir = baseTree(t);
  if (!dir) return;
  const o = await pageScenario(dir);
  assert.equal(o.buttonBefore, 1, 'positive control: the button is offered');
  assert.equal(o.fileClosed, true, 'the click wrote the closing line there too');
  assert.equal(o.buttonReload, 1, 'old: after the reload the page still offers the confirm (the stored state)');
});
