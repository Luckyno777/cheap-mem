// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/cat-confirm-cm-browser.test.mjs — a confirmed category stays confirmed after a reload
// (task cat-confirm-cm, 2026-10-03; parity with lucky-mem `kat-bestaetigen-lm`, commit 1fac163f).
//
// The bug: the click wrote correctly (a `confirmed` line in global/topic-category.jsonl), but a reload
// showed the old proposals and buttons again. Three causes:
//   a. /dashboard.json comes from the cache, which rebuilds in the background with a minimum gap of
//      max(20 s, 4 x build time) — a reload right after the click got the old state;
//   b. the client's local patch (catPatch) was overwritten by a quiet refetch of that old state;
//   c. readAssignments took the last line per topic, so a later machine proposal undid a confirmation.
//
//   (1) browser, background build with a long gap: confirm one, confirm all, reload -> no proposals left
//       (positive control: six proposals first; the data route says `fresh:false`, so the cache path is real)
//   (2) reading logic: a later proposal never overrides a confirmation; a person's new assignment does
//   (3) cache: `invalidate()` starts the next build despite the gap; a build begun before it does not count as fresh
//   (4) project-confirm through the server: after the finished task the next build runs without the gap
//   (5) red proof: the same browser scenario against the FIXED base commit (plus only the test switch) fails
// Without Playwright/Chromium the browser tests are SKIPPED with a reason, never green.
/* global document -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as categories from '../src/categories.mjs';
import * as login from '../src/login.mjs';
import * as dashboardCache from '../src/dashboard-cache.mjs';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The integration branch before this fix (the base of agent/cat-confirm-cm).
const BASE = 'd276282';
const { browser, reason } = await startBrowser();
const SKIP = reason;
const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const T = ['infra/deploys', 'infra/backups', 'infra/monitoring', 'design/tokens', 'design/layout', 'garden/beds', 'garden/compost', 'misc/one', 'misc/two', 'misc/three'];
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cc-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'cc', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  for (let i = 0; i < 40; i += 1) { const t = T[i % T.length]; memory.logEntry(r, 'learning', { title: `Entry ${i} ${t}`, text: `Body ${i}`, tags: ['x'], topic: t }); }
  categories.createCategory(r, 'infrastructure', 'Infrastructure');
  categories.createCategory(r, 'design', 'Design');
  categories.assign(r, 'infra/deploys', 'infrastructure');
  categories.assign(r, 'design/tokens', 'design');
  categories.decide(r, ['garden/beds', 'garden/compost', 'misc/one'].map((t) => ({ topic: t, source: 'agent', fresh: { key: 'gardening', label: 'Gardening' } })), { write: true });
  categories.decide(r, [{ topic: 'infra/backups', source: 'agent', category: 'infrastructure' }, { topic: 'design/layout', source: 'agent', category: 'design' }, { topic: 'infra/monitoring', source: 'agent', category: 'infrastructure' }], { write: true });
  return r;
}
const lines = (root) => { try { return fs.readFileSync(path.join(root, 'global', 'topic-category.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// `repo`: the tree whose server runs. For the red proof it is the base commit, extracted to a temp directory,
// with ONLY the test switch for the gap added (the base has `minGapMs: 0` under the sync switch).
async function startServer(root, repo = REPO, { gapMs = 600000 } = {}) {
  const mod = await import(`${pathToFileURL(path.join(repo, 'bin', 'mem-serve')).href}?cc=${Math.random()}`);
  const env = {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '',
    CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0', CHEAP_MEM_SERVE_CACHE_GAP_TEST_MS: String(gapMs),
  };
  const dir = login.dirFor(root, env);
  login.setPassword(dir, 'a-proper-long-password');
  const session = login.newSession(dir);
  const { server } = await mod.serve(root, env, { allowWrites: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = async () => {
    const j = await (await fetch(`${base}/dashboard.json`, { headers: { cookie: `${login.COOKIE}=${session}` } })).json();
    return { proposals: j.categories.proposals.length, builtAt: j.cache.built_at, fresh: j.cache.fresh, refreshing: j.cache.refreshing, projects: j.projectShelf?.projects ?? [] };
  };
  return { base, session, route, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

// Prime the cache like a busy store: a new entry makes the cold answer stale, the background build that
// follows starts the gap. From here on every further build is held back until the gap is over.
async function prime(root, s) {
  const built0 = (await s.route()).builtAt;
  memory.logEntry(root, 'learning', { title: 'Late entry', text: 'Body', tags: ['x'], topic: 'misc/two' });
  for (let i = 0; i < 150; i += 1) { const r = await s.route(); if (r.builtAt !== built0 && r.fresh && !r.refreshing) break; await new Promise((res) => setTimeout(res, 200)); }
  const primed = await s.route();
  assert.ok(primed.builtAt !== built0 && primed.fresh, 'primed: a background build has finished and started the gap');
}

function baseTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cc-base-'));
  roots.push(dir);
  exportCommit(REPO, BASE, ['.'], dir);
  const f = path.join(dir, 'bin', 'mem-serve');
  const src = fs.readFileSync(f, 'utf8');
  const patched = src.replace('{ syncUpToMs: Number(syncUpToMsTest), minGapMs: 0 }', '{ syncUpToMs: Number(syncUpToMsTest), minGapMs: Number(env.CHEAP_MEM_SERVE_CACHE_GAP_TEST_MS ?? 0) }');
  assert.notEqual(patched, src, 'the test switch was added to the base copy');
  fs.writeFileSync(f, patched);
  return dir;
}

async function scenario(repo) {
  const root = world();
  const s = await startServer(root, repo);
  const out = {};
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: login.COOKIE, value: s.session, url: s.base }]);
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    const visible = () => page.evaluate(() => ({ buttons: document.querySelectorAll('[data-action=cat-confirm]').length, all: Boolean(document.querySelector('[data-action=cat-confirm-all]')) }));
    const reload = async () => { await page.reload(); await waitReady(page); await page.waitForSelector('#topicList .tl-row'); };
    await page.goto(`${s.base}/dashboard#knowledge/topics`);
    await waitReady(page);
    await page.waitForSelector('#topicList .tl-row');
    out.before = await visible();
    // Prime the cache like a busy store: a new entry makes the first answer stale, the background build that
    // follows starts the 600 s gap. From here on every further build is held back until the gap is over.
    await prime(root, s);
    await page.click('[data-action=cat-confirm] >> nth=0');
    await page.waitForFunction(() => /confirmed/.test(document.querySelector('#catStatus')?.textContent || ''), null, { timeout: 40000 });
    out.written = lines(root).filter((l) => l.status === 'confirmed' && l.source !== undefined).length;
    out.route1 = await s.route();
    await reload();
    out.afterOne = await visible();
    await page.click('[data-action=cat-confirm-all]');
    await page.waitForFunction(() => !document.querySelector('[data-action=cat-confirm-all]'), null, { timeout: 40000 });
    out.route2 = await s.route();
    await reload();
    out.afterAll = await visible();
    await ctx.close();
  } finally { await s.stop(); }
  return out;
}

test('(1) browser: confirm one and all, reload -> no proposal comes back, with a background build and a long gap', { skip: SKIP, timeout: 400000 }, async () => {
  const o = await scenario(REPO);
  assert.deepEqual(o.before, { buttons: 6, all: true }, 'positive control: six proposals are shown first');
  assert.ok(o.written >= 1, 'the click wrote a confirmed line');
  assert.equal(o.route1.fresh, false, 'the cache path is real (the answer is not fresh), otherwise the probe proves nothing');
  assert.equal(o.route1.proposals, 5, 'the data route shows five right after the click');
  assert.equal(o.afterOne.buttons, 5, 'after a reload five, not six again');
  assert.equal(o.route2.proposals, 0);
  assert.deepEqual(o.afterAll, { buttons: 0, all: false }, 'after the second reload no proposal and no button');
});

test('(2) reading logic: a later proposal never overrides a confirmation; a person does', () => {
  const w = world();
  categories.confirm(w, 'garden/beds');
  assert.equal(categories.readAssignments(w).get('garden/beds').status, 'confirmed');
  // the wish pass had read the topic before the click and writes its proposal now
  categories.appendAssignments(w, [{ topic: 'garden/beds', category: 'design', source: 'agent', status: 'proposal', ts: '2026-10-03T00:00:00Z' }]);
  const a = categories.readAssignments(w).get('garden/beds');
  assert.equal(a.status, 'confirmed');
  assert.equal(a.category, 'gardening');
  assert.equal(categories.view(w).proposals.some((p) => p.topic === 'garden/beds'), false);
  // positive control: a person's assignment still changes it
  categories.assign(w, 'garden/beds', 'design');
  assert.equal(categories.readAssignments(w).get('garden/beds').category, 'design');
  // positive control: an unconfirmed proposal is still replaced by a newer proposal
  categories.appendAssignments(w, [{ topic: 'misc/one', category: 'design', source: 'agent', status: 'proposal', ts: '2026-10-03T00:00:00Z' }]);
  assert.equal(categories.readAssignments(w).get('misc/one').category, 'design');
});

test('(3) cache: invalidate() starts the next build despite the gap; a build begun before it is not fresh', async () => {
  let t = 1000; let state = 'old'; let builds = 0;
  const release = [];
  const tick = () => new Promise((r) => setImmediate(r));
  const c = dashboardCache.createCache({
    build: () => ({ state }),
    buildInBackground: () => new Promise((res) => { builds += 1; const read = state; release.push(() => res({ state: read })); }),
    stamp: () => 'same', syncUpToMs: -1, minGapMs: 20000, ttlMs: 60000, now: () => t,
    fromDisk: () => ({ data: { state: 'old' }, stamp: 'same', builtMs: 0, durationMs: 5000 }),
  });
  c.get(); await tick(); release.shift()(); await c.waitForRebuild(); // first build (from disk, then background)
  assert.equal(c.get().meta.fresh, true);
  t += 2000; state = 'new'; c.invalidate();                          // a click 2 s after the build, the stamp is equal
  const a = c.get();
  assert.equal(a.meta.fresh, false);
  assert.equal(a.meta.refreshing, true, 'the rebuild starts despite the 20 s gap (red: never without invalidate)');
  state = 'newer'; c.invalidate();                                  // a second click while that build runs
  await tick(); release.shift()(); await c.waitForRebuild();
  assert.equal(c.get().meta.fresh, false, 'the build begun before the second click does not make it fresh');
  await tick(); release.shift()(); await c.waitForRebuild();
  const done = c.get();
  assert.equal(done.meta.fresh, true);
  assert.equal(done.data.state, 'newer');
  assert.equal(builds, 3);
});

test('(4) project-confirm through the server: the finished task invalidates the cache, the next build runs at once', async () => {
  const root = world();
  const env = { ...process.env, CHEAP_MEM_ROOT: root, MEM_HEADLESS: '' };
  const r = (...a) => execFileSync('node', [path.join(REPO, 'bin', 'mem'), ...a], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  r('project', 'new', 'garden', '--title', 'Garden', '--reason', 'probe');
  const s = await startServer(root);
  try {
    const h = { cookie: `${login.COOKIE}=${s.session}` };
    const first = await s.route(); // cold start: synchronous, fresh
    assert.equal(first.projects.find((p) => p.name === 'garden')?.isNew, true, 'positive control: the project is new');
    await prime(root, s);
    const post = await fetch(`${s.base}/task`, { method: 'POST', headers: { ...h, origin: s.base, host: new URL(s.base).host, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ kind: 'project-confirm', name: 'garden' }) });
    assert.equal(post.status, 201, await post.clone().text());
    const { id } = await post.json();
    let done = null;
    for (let i = 0; i < 200 && !done; i += 1) {
      const j = await (await fetch(`${s.base}/task.json?id=${id}`, { headers: h })).json();
      if (j.running === false) done = j; else await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(done?.state, 'ok', JSON.stringify(done));
    // The gap is 600 s: without invalidate() no rebuild would start. The task poll above already reported the end once.
    let seen = null;
    for (let i = 0; i < 100; i += 1) {
      seen = await s.route();
      if (seen.fresh && !seen.projects.find((p) => p.name === 'garden')?.isNew) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.equal(seen.projects.find((p) => p.name === 'garden')?.isNew, false, 'the new mark is gone in the served state');
    assert.equal(seen.fresh, true);
  } finally { await s.stop(); }
});

test('(5) red proof: the base commit shows the proposals again after a reload (plus only the test switch)', { skip: SKIP, timeout: 400000 }, async (t) => {
  let tree;
  try { tree = baseTree(); } catch (e) { t.skip(`commit ${BASE} not reachable (${e.message}) — red proof unknown, not green`); return; }
  const o = await scenario(tree);
  assert.equal(o.before.buttons, 6, 'positive control: the same six proposals first');
  assert.equal(o.route1.fresh, false, 'the base serves the old state from the cache');
  assert.equal(o.route1.proposals, 6, 'red: the data route still carries all six');
  assert.equal(o.afterOne.buttons, 6, 'red: after a reload the confirmed proposal is back');
  assert.equal(o.afterAll.all, true, 'red: after "confirm all" and a reload the button is still there');
});
