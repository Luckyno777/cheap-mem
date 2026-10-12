// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/dash-write-fresh-cm.test.mjs - after a write of the person's OWN the affected parts are fresh at the next read
// (job board-width-fresh-cm, 2026-10-12; parity with lucky-mem `dash-schreiben-frisch-lm`, bug 3fzbv8vxvosj).
//
// Finding: saving a setting or acknowledging a message wrote correctly, and the page showed the OLD state, also after
// a reload: /dashboard.json comes from the cache, whose rebuild takes seconds (with the gap: minutes); `invalidate()`
// started the next build at once, but the answer BEFORE it was the old state. Measured in a real Chromium on 0bf3ae5:
// the file says errorWindow 77, the page 14 (after the save and after the reload); an acknowledged message stays "open".
//
// Measure:             what the page / the data route shows right after the write: setting value, message state,
//                      gold questions of the day, project "new" mark, raw counters; sound of `cache.live_parts`.
// Starting value:      the OLD value in every case (cache with a long gap and a slow build, as on a real store).
// Expected change:     the new value at once, from the freshly computed part; `cache.fresh` stays honestly false until
//                      the rebuild is through; a read without a write computes nothing; a part that cannot be
//                      computed is named (`cache.live_errors`) and said at the card, never silently old.
// Abort criterion:     any write path shows the old state / a read without a write computes a part / a failing part
//                      stays silent / a rebuild that began BEFORE the write clears the stale mark.
//
// Positive control: the same scenarios against the FIXED old commit 0bf3ae5 (never merge-base), exported to a temp
// directory with only the probe pause for the build added: every write path shows the old state there.
// Without Playwright/Chromium the browser probes are SKIPPED with a reason, never green.
/* global document, messages, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as inbox from '../src/inbox.mjs';
import * as login from '../src/login.mjs';
import * as goldlog from '../src/goldlog.mjs';
import * as archive from '../src/archive.mjs';
import * as tasks from '../src/tasks.mjs';
import * as dashboardCache from '../src/dashboard-cache.mjs';
import * as dashboardLive from '../src/dashboard-live.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';
import { lazyBrowser, browserStartProbe, startView, waitReady } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '0bf3ae5'; // fixed stand before the change (never merge-base: that one moves along)
const PEOPLE = { alex: { human: true }, bot: {} };
const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

const B = lazyBrowser();
browserStartProbe(B);

// ---------------------------------------------------------------- (1) the cache: parts
function fakeCache(over = {}) {
  let n = 0;
  let stampValue = 's0';
  let release = null;
  const c = dashboardCache.createCache({
    build: () => ({ n: (n += 1) }),
    buildInBackground: () => new Promise((res) => { release = () => res({ n: (n += 1) }); }),
    stamp: () => stampValue,
    ttlMs: 1e9, syncUpToMs: -1, minGapMs: 0, fromDisk: () => null, syncAllowed: () => true,
    ...over,
  });
  return { c, bump: () => { stampValue += 'x'; }, finish: async () => { await new Promise((r) => setImmediate(r)); release(); await c.waitForRebuild(); } };
}

test('(1) cache: invalidate(parts) names the parts until a build that STARTED after the write is through', async () => {
  const { c, bump, finish } = fakeCache();
  assert.deepEqual(c.get().live.parts, [], 'a read without a write has no stale part');
  assert.equal(c.get().meta.live_parts.length, 0);
  bump();
  c.get(); // the stamp changed: a background build starts (build 2)
  c.invalidate(['settings']); // a write AFTER that build began: it may have read before the write
  assert.deepEqual(c.get().live.parts, ['settings']);
  assert.deepEqual(c.get().meta.live_parts, ['settings']);
  const key1 = c.get().live.key;
  await finish(); // the build that began BEFORE the write is through
  assert.deepEqual(c.get().live.parts, ['settings'], 'a build that began before the write does not clear the part');
  assert.equal(c.get().meta.fresh, false, 'and the state is not fresh either');
  // the next build starts after the write (the write made the state stale, no gap) and clears it
  await finish();
  assert.deepEqual(c.get().live.parts, [], 'a build that began after the write clears it');
  assert.equal(c.get().meta.fresh, true);
  // a second write to the same part changes the key (the server computes again)
  c.invalidate(['settings']);
  const key2 = c.get().live.key;
  c.invalidate(['settings', 'inbox']);
  assert.notEqual(c.get().live.key, key2);
  assert.notEqual(key1, key2);
  assert.deepEqual(c.get().live.parts, ['inbox', 'settings']);
});

test('(1b) cache: invalidate() without parts keeps the old behaviour; a synchronous build clears the parts', () => {
  const { c } = fakeCache({ syncUpToMs: 1000 });
  c.get();
  c.invalidate();
  const st = c.get(); // the small store rebuilds synchronously at once
  assert.deepEqual(st.live.parts, []);
  assert.equal(st.meta.fresh, true);
  c.invalidate(['inbox']);
  const after = c.get(); // synchronous again: built after the write, so nothing stale is left
  assert.deepEqual(after.live.parts, [], 'the synchronous build is after the write: the part is in the state itself');
});

// ---------------------------------------------------------------- (2) the module
test('(2) module: every task kind and every writing route is in exactly one list; every part named exists', async () => {
  for (const kind of Object.keys(tasks.KINDS)) {
    const a = Object.hasOwn(dashboardLive.TASK_PARTS, kind);
    const b = Object.hasOwn(dashboardLive.REBUILD_ONLY, kind);
    assert.ok(a !== b, `task kind '${kind}' must be in exactly one of TASK_PARTS / REBUILD_ONLY (in ${a && b ? 'both' : 'none'})`);
  }
  for (const k of [...Object.keys(dashboardLive.TASK_PARTS), ...Object.keys(dashboardLive.REBUILD_ONLY)]) assert.ok(Object.hasOwn(tasks.KINDS, k), `'${k}' is no task kind (any more)`);
  for (const [k, why] of Object.entries(dashboardLive.REBUILD_ONLY)) assert.ok(String(why).length > 10, `REBUILD_ONLY '${k}' needs a reason`);
  const mod = await import(`${path.join(REPO, 'bin', 'mem-serve')}?x=${Math.random()}`);
  for (const route of mod.WRITE_PATHS) {
    const a = Object.hasOwn(dashboardLive.ROUTE_PARTS, route);
    const b = Object.hasOwn(dashboardLive.ROUTE_NO_PART, route);
    assert.ok(a !== b, `writing route '${route}' must be in exactly one of ROUTE_PARTS / ROUTE_NO_PART (in ${a && b ? 'both' : 'none'})`);
  }
  for (const route of [...Object.keys(dashboardLive.ROUTE_PARTS), ...Object.keys(dashboardLive.ROUTE_NO_PART)]) assert.ok(mod.WRITE_PATHS.includes(route), `'${route}' is no writing route (any more)`);
  for (const parts of [...Object.values(dashboardLive.ROUTE_PARTS), ...Object.values(dashboardLive.TASK_PARTS)]) {
    for (const p of parts) assert.ok(Object.hasOwn(dashboardLive.PARTS, p), `part '${p}' does not exist`);
  }
});

function memoryRoot() {
  const r = tmp('cm-wfresh-');
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'wfresh', participants: PEOPLE, language: 'en' }));
  for (let i = 0; i < 12; i += 1) memory.logEntry(r, 'learning', { title: `Entry ${i}`, text: `Body ${i}`, tags: ['x'], topic: `t/${i % 4}` });
  return r;
}

test('(2b) module: compute() lays the parts over a COPY, names a part that cannot be computed and keeps the stored one', () => {
  const root = memoryRoot();
  const stored = { settings: [{ id: 'error-window', value: 14 }], log: [], inbox: { readable: true, messages: [] }, humanInbox: { readable: true, messages: [] }, humanTray: { count: 0 }, other: 'stays' };
  const frozen = JSON.stringify(stored);
  const ok = dashboardLive.compute(root, stored, ['settings'], {});
  assert.equal(JSON.stringify(stored), frozen, 'the stored state is not changed (it serves many answers)');
  assert.ok(ok.data.settings.find((s) => s.id === 'error-window').value === 14 && ok.data.settings.length > 3, 'the settings list is computed (all settings, not the stored stub)');
  assert.equal(ok.data.other, 'stays');
  assert.deepEqual(ok.errors, {});
  // an unreadable inbox (a file where the folder belongs): the part is named, the stored inbox stays
  fs.writeFileSync(path.join(root, 'inbox'), 'a file where the inbox folder belongs');
  const bad = dashboardLive.compute(root, stored, ['inbox', 'settings', 'nonsense'], {});
  assert.match(bad.errors.inbox, /ENOTDIR|not a directory/);
  assert.match(bad.errors.nonsense, /unknown part/);
  assert.deepEqual(bad.data.inbox, stored.inbox, 'a part that failed stays the stored one - never an invented fresh one');
  assert.ok(!('settings' in bad.errors), 'the other part is computed all the same');
});

test('(2c) module: the raw counters are read again, the topics and entries of a capture stay those of the stored state', () => {
  const root = tmp('cm-wfresh-raw-');
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'wfraw' }));
  archive.setLocation(root, path.join(root, 'archive-outside'));
  const cfg = archive.readConfig({}, root);
  const rel = 'raw/2026/09/2026-09-01T00-00-00Z--s0.jsonl.gz';
  const body = zlib.gzipSync(Buffer.from('{"line":0}\n'));
  archive.put(cfg, rel, body);
  archive.writeRecord(root, { path: rel, captured_at: '2026-09-01T00:00:00Z', ts_to: '2026-09-01T00:00:00Z', lines: 1, stored_bytes: body.length, stamp: { session_id: 's0', surface: 'test', project: null } });
  const stored = dashboardData.rawLive(root, { captures: [{ path: rel, topics: ['kept-topic'], entries: ['e1'] }] });
  assert.equal(stored.counts.present, 1, 'positive control: the capture is there');
  assert.deepEqual(stored.captures[0].topics, ['kept-topic']);
  archive.remove(cfg, root, rel, { reason: 'probe', by: 'lucky' });
  const now = dashboardData.rawLive(root, stored);
  assert.equal(now.counts.deleted, 1);
  assert.equal(now.counts.present, 0);
  assert.equal(now.captures[0].state, 'deleted');
  assert.deepEqual(now.captures[0].topics, ['kept-topic']);
  assert.deepEqual(now.captures[0].entries, ['e1']);
});

// ---------------------------------------------------------------- the server scenarios
/** The old stand, exported, with ONLY the probe pause for the build added (the old stand has no such switch). */
function oldTree() {
  const dir = tmp('cm-wfresh-old-');
  exportCommit(REPO, OLD, ['.'], dir);
  const f = path.join(dir, 'bin', 'mem-serve');
  const src = fs.readFileSync(f, 'utf8');
  const patched = src.replace('    buildInBackground: async () => {\n      const bytes =', '    buildInBackground: async () => {\n      const pauseTest = Number(env.CHEAP_MEM_SERVE_BUILD_PAUSE_TEST_MS || 0);\n      if (pauseTest > 0) await new Promise((r) => { setTimeout(r, pauseTest).unref(); });\n      const bytes =');
  assert.notEqual(patched, src, 'the pause switch was added to the old copy');
  fs.writeFileSync(f, patched);
  return dir;
}

function world() {
  const r = memoryRoot();
  inbox.write(r, PEOPLE, { from: 'bot', to: 'alex', subject: 'Hello A', text: 'text A' });
  execFileSync('node', [path.join(REPO, 'bin', 'mem'), 'project', 'new', 'garden', '--title', 'Garden', '--reason', 'probe'], { env: { ...process.env, CHEAP_MEM_ROOT: r, MEM_HEADLESS: '' }, stdio: 'ignore' });
  const goldFile = path.join(tmp('cm-wfresh-gold-'), 'g.jsonl');
  const rows = ['a', 'b', 'c'].map((x) => goldlog.buildRow({ question: `how does ${x} work`, share: 'no', expected: ['e1'], occasion: 'question', source: `raw-capture:hit:s1:${x}`, kind: 'drawn', verdict: null }));
  fs.writeFileSync(goldFile, `${rows.map((r2) => JSON.stringify(r2)).join('\n')}\n`);
  return { root: r, goldFile, rows };
}

/** A server with the background path, a long gap and (after priming) a slow build, like a real store. */
async function startServer(w, repo = REPO) {
  const env = {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '', MEM_RECALL_SERVER: '0',
    CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: '0', CHEAP_MEM_SERVE_CACHE_GAP_TEST_MS: '600000', CHEAP_MEM_GOLD_FILE: w.goldFile,
  };
  const dir = login.dirFor(w.root, env);
  login.setPassword(dir, 'a-proper-long-password');
  const session = login.newSession(dir);
  const cookie = `${login.COOKIE}=${session}`;
  const { base, stop } = await startView(w.root, env, { repo, serveOpts: { allowWrites: true }, cookie, keepFresh: false });
  const json = async (p) => (await fetch(`${base}${p}`, { headers: { cookie } })).json();
  const post = (route, fields) => fetch(`${base}${route}`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const dash = () => json('/dashboard.json');
  const part = async (name) => (await json(`/dashboard/part.json?part=${name}`));
  // Prime like a busy store: a new entry makes the first answer stale; the background build that follows starts the gap.
  const built0 = (await dash()).cache.built_at;
  memory.logEntry(w.root, 'learning', { title: 'Late entry', text: 'b', tags: ['x'], topic: 't/1' });
  for (let i = 0; i < 150; i += 1) { const c = (await dash()).cache; if (c.built_at !== built0 && c.fresh && !c.refreshing) break; await new Promise((r) => setTimeout(r, 200)); }
  const primed = (await dash()).cache;
  assert.ok(primed.built_at !== built0 && primed.fresh, 'primed: a background build has finished and started the gap');
  env.CHEAP_MEM_SERVE_BUILD_PAUSE_TEST_MS = '60000'; // from here on every rebuild takes a minute
  return { base, session, cookie, env, json, post, dash, part, stop };
}

/** Every writing path of the dashboard once; what the data routes show right after each write. */
async function httpScenario(repo) {
  const w = world();
  const s = await startServer(w, repo);
  const o = {};
  try {
    const before = await s.dash();
    o.before = {
      setting: before.settings.find((x) => x.id === 'error-window').value,
      gold: before.today.gold.candidates.length,
      garden: before.projectShelf.projects.find((p) => p.name === 'garden').isNew,
      waiting: before.today.projects.list.length,
      msg: (await s.part('inbox')).data.map((m) => `${m.subject}:${m.state}:${m.situation}`),
      tray: before.humanTray.count,
    };
    const msgName = (await s.part('inbox')).data[0].name;

    o.setting = { status: (await s.post('/setting', { id: 'error-window', value: '77' })).status };
    const a = await s.dash();
    o.setting.value = a.settings.find((x) => x.id === 'error-window').value;
    o.setting.log = a.log.length;
    o.setting.cache = a.cache;

    o.ack = { status: (await s.post('/inbox/state', { name: msgName, state: 'replied' })).status };
    const p1 = await s.part('inbox');
    const b = await s.dash();
    o.ack.msg = p1.data.map((m) => `${m.subject}:${m.state}:${m.situation}`);
    o.ack.tray = b.humanTray.count;
    o.ack.head = b.humanInbox.messages.map((m) => m.state);
    o.ack.partCount = b.parts?.inbox?.count;
    o.ack.cache = b.cache;

    o.reply = { status: (await s.post('/inbox/reply', { name: msgName, text: 'my answer' })).status };
    const p2 = await s.part('inbox');
    const c = await s.dash();
    o.reply.count = p2.data.length;
    o.reply.partCount = c.parts?.inbox?.count;

    const first = w.rows[0];
    o.gold = { status: (await s.post('/dashboard/gold-verdict', { verdict: 'correct', occasion: 'question', source: first.source, expected: JSON.stringify(first.expected), id: first.id })).status };
    const d = await s.dash();
    o.gold.left = d.today.gold.candidates.length;
    o.gold.counts = d.today.counts.goldQuestions;
    o.gold.cache = d.cache;

    const started = await (await s.post('/task', { kind: 'project-confirm', name: 'garden' })).json();
    o.project = { started: started.ok ?? started.state };
    for (let i = 0; i < 100; i += 1) { const t = await s.json(`/task.json?id=${encodeURIComponent(started.id)}`); if (t.running === false) { o.project.done = t.state; break; } await new Promise((r) => setTimeout(r, 200)); }
    const e = await s.dash();
    o.project.garden = e.projectShelf.projects.find((p) => p.name === 'garden').isNew;
    o.project.waiting = e.today.projects.list.length;
    o.project.cache = e.cache;
  } finally { await s.stop(); }
  return o;
}

test('(3) data routes: after each writing path of the dashboard the next read shows the NEW state, with a slow build and a long gap', { timeout: 300000 }, async () => {
  const o = await httpScenario(REPO);
  assert.deepEqual(o.before, { setting: 14, gold: 3, garden: true, waiting: 1, msg: ['Hello A:open:open'], tray: 1 }, 'positive control: the starting state');
  assert.equal(o.setting.status, 303);
  assert.equal(o.setting.value, 77, 'setting: the new value');
  assert.equal(o.setting.log, 1, 'setting: the change log carries the change');
  assert.equal(o.setting.cache.fresh, false, 'the state is honestly not fresh (the rebuild is still running), so the cache path is real');
  assert.deepEqual(o.setting.cache.live_parts, ['settings']);
  assert.equal(o.ack.status, 303);
  assert.deepEqual(o.ack.msg, ['Hello A:replied:done'], 'inbox: the message is acknowledged in the list the page asks for');
  assert.equal(o.ack.tray, 0, 'the tray summary follows');
  assert.deepEqual(o.ack.head, ['replied'], 'the human tray list follows');
  assert.equal(o.ack.partCount, 1, 'the part path of the answer carries the right count');
  assert.deepEqual(o.ack.cache.live_parts, ['inbox', 'settings']);
  assert.equal(o.reply.status, 303);
  assert.equal(o.reply.count, 2, 'the reply is a new message in the list');
  assert.equal(o.reply.partCount, 2);
  assert.equal(o.gold.status, 201);
  assert.equal(o.gold.left, 2, 'gold: a rated question does not come back in Today');
  assert.equal(o.gold.counts, 2);
  assert.deepEqual(o.gold.cache.live_parts, ['gold', 'inbox', 'settings']);
  assert.equal(o.project.done, 'ok');
  assert.equal(o.project.garden, false, 'project: the "new" mark is gone in the project shelf');
  assert.equal(o.project.waiting, 0, 'and the project does not wait in Today any more');
  assert.deepEqual(o.project.cache.live_parts, ['gold', 'inbox', 'projects', 'settings']);
  assert.equal(o.project.cache.fresh, false);
});

test('(3b) red proof: the SAME scenario on the old commit 0bf3ae5 shows the OLD state after every write path', { timeout: 300000 }, async () => {
  const o = await httpScenario(oldTree());
  assert.equal(o.before.setting, 14, 'positive control: the same starting state');
  assert.equal(o.setting.value, 14, 'old: the saved setting is not shown');
  assert.deepEqual(o.ack.msg, ['Hello A:open:open'], 'old: the acknowledged message still reads open');
  assert.equal(o.ack.tray, 1);
  assert.equal(o.reply.count, 1, 'old: the reply is not in the list');
  assert.equal(o.gold.left, 3, 'old: the rated question is still offered');
  assert.equal(o.project.garden, true, 'old: the project still carries the "new" mark');
  assert.equal(o.setting.cache.live_parts, undefined, 'old: the answer knows no parts');
});

test('(3c) a read without a write computes nothing; a write is computed ONCE however often it is read', { timeout: 300000 }, async () => {
  const w = world();
  const s = await startServer(w);
  try {
    const runs0 = dashboardLive.runCount();
    for (let i = 0; i < 4; i += 1) { await s.dash(); await s.part('inbox'); }
    assert.equal(dashboardLive.runCount(), runs0, 'no write: no part computed, the read costs what it did');
    assert.deepEqual((await s.dash()).cache.live_parts, []);
    await s.post('/setting', { id: 'error-window', value: '33' });
    for (let i = 0; i < 4; i += 1) { await s.dash(); await s.part('inbox'); }
    assert.equal(dashboardLive.runCount(), runs0 + 1, 'one write: computed once, the answer is remembered per state and write');
  } finally { await s.stop(); }
});

test('(3d) a part that cannot be computed is named in cache.live_errors, on the data route and the part route; the stored state stays', { timeout: 300000 }, async () => {
  const w = world();
  const s = await startServer(w);
  try {
    const msgName = (await s.part('inbox')).data[0].name;
    assert.equal((await s.post('/inbox/state', { name: msgName, state: 'replied' })).status, 303);
    // after the write the inbox folder becomes unreadable (a file in its place)
    fs.rmSync(path.join(w.root, 'inbox'), { recursive: true, force: true });
    fs.writeFileSync(path.join(w.root, 'inbox'), 'now a file');
    const d = await s.dash();
    assert.match(d.cache.live_errors.inbox, /ENOTDIR|not a directory/, 'the reason is named');
    assert.ok(!d.cache.live_errors.inbox.includes(w.root), 'no server path in the answer');
    assert.match(d.cache.live_errors.inbox, /<memory>/);
    assert.ok(!d.cache.live_errors.settings, 'only the failing part is named');
    const p = await s.part('inbox');
    assert.match(p.cache.live_errors.inbox, /ENOTDIR|not a directory/, 'the part route names it as well');
    assert.equal(p.state, 'ok', 'and shows the stored list (the state of before) - never an empty one');
    assert.equal(p.data.length, 1);
    assert.equal(p.data[0].state, 'open', 'the stored state: honestly old, and said so');
  } finally { await s.stop(); }
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
    page.setDefaultTimeout(40000);
    page.on('dialog', (d) => d.accept());
    const val = () => page.inputValue('.setting-field[data-id="error-window"]');
    await page.goto(`${s.base}/dashboard#settings/system`);
    await waitReady(page);
    await page.waitForSelector('.setting-field[data-id="error-window"]');
    o.settingBefore = await val();
    await page.fill('.setting-field[data-id="error-window"]', '77');
    await page.click('[data-action="save-config"]');
    await page.waitForFunction(() => /Saved and logged/.test(document.querySelector('#configStatus')?.textContent || ''), null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    o.settingFile = JSON.parse(fs.readFileSync(path.join(w.root, '.mem', 'console.json'), 'utf8')).errorWindow;
    o.settingInPage = await val();
    await page.reload();
    await waitReady(page);
    await page.waitForSelector('.setting-field[data-id="error-window"]');
    o.settingReload = await val();
    o.cache = (await s.dash()).cache;
    o.shotSettings = await page.screenshot();

    await page.goto(`${s.base}/dashboard#work/inbox`);
    await waitReady(page);
    await page.waitForSelector('#inboxRows .post-row');
    await page.click('#inboxRows [data-action="message"]');
    await page.click('[data-action="inbox-state"]:not([disabled]) >> nth=0');
    await page.waitForTimeout(2000);
    const rows = () => page.evaluate(() => messages.map((m) => `${m.subject}:${m.state}:${m.situation}`));
    o.inboxInPage = await rows();
    await page.reload();
    await waitReady(page);
    await page.waitForSelector('.metrics');
    o.inboxReload = await rows();
    o.shotInbox = await page.screenshot();
    o.root = w.root;
  } finally { await ctx?.close().catch(() => {}); await s.stop(); }
  return o;
}

test('(4) browser: a saved setting and an acknowledged message are what the page shows - at once and after the reload', { timeout: 400000 }, async (t) => {
  if (!(await B.need(t))) return;
  const o = await pageScenario(REPO);
  assert.equal(o.settingBefore, '14', 'positive control: the old value first');
  assert.equal(o.settingFile, 77, 'the click wrote the file');
  assert.equal(o.settingInPage, '77', 'the page shows the new value right after the save');
  assert.equal(o.settingReload, '77', 'and after the reload');
  assert.equal(o.cache.fresh, false, 'the cache path is real: the state is not fresh (the rebuild is held), the part came from the live computation');
  assert.ok(o.cache.live_parts.includes('settings'));
  assert.deepEqual(o.inboxInPage, ['Hello A:replied:done']);
  assert.deepEqual(o.inboxReload, ['Hello A:replied:done'], 'the acknowledged message is done after the reload');
  if (process.env.WRITE_FRESH_IMAGES) {
    fs.mkdirSync(process.env.WRITE_FRESH_IMAGES, { recursive: true });
    fs.writeFileSync(path.join(process.env.WRITE_FRESH_IMAGES, 'settings-after-reload.png'), o.shotSettings);
    fs.writeFileSync(path.join(process.env.WRITE_FRESH_IMAGES, 'inbox-after-reload.png'), o.shotInbox);
  }
});

test('(4b) red proof: the same page scenario on the old commit 0bf3ae5 shows the old value and the open message, also after the reload', { timeout: 400000 }, async (t) => {
  if (!(await B.need(t))) return;
  const o = await pageScenario(oldTree());
  assert.equal(o.settingBefore, '14');
  assert.equal(o.settingFile, 77, 'positive control: the old stand wrote the file correctly too');
  assert.equal(o.settingInPage, '14', 'old: the page shows the old value after the save');
  assert.equal(o.settingReload, '14', 'old: and after the reload');
  assert.deepEqual(o.inboxReload, ['Hello A:open:open'], 'old: the acknowledged message reads open after the reload');
});

test('(5) browser: a part that could not be computed fresh is said at its card, as the LAST thing in the panel, not at the others', { timeout: 400000 }, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const w = world();
  const s = await startServer(w);
  let ctx = null;
  try {
    const msgName = (await s.part('inbox')).data[0].name;
    assert.equal((await s.post('/inbox/state', { name: msgName, state: 'replied' })).status, 303);
    fs.rmSync(path.join(w.root, 'inbox'), { recursive: true, force: true });
    fs.writeFileSync(path.join(w.root, 'inbox'), 'now a file');
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await ctx.addCookies([{ name: login.COOKIE, value: s.session, url: s.base }]);
    const page = await ctx.newPage();
    page.setDefaultTimeout(40000);
    await page.goto(`${s.base}/dashboard#work/inbox`);
    await waitReady(page);
    await page.waitForSelector('#inboxRows .post-row');
    const note = await page.evaluate(() => {
      const n = [...document.querySelectorAll('.live-note')];
      const panel = n[0]?.closest('.panel');
      return { count: n.length, text: n[0]?.textContent || '', last: Boolean(panel) && panel.lastElementChild === n[0], title: panel?.querySelector('h2')?.textContent || '' };
    });
    assert.equal(note.count, 1, 'exactly one card says it');
    assert.equal(note.title, 'Messages');
    assert.ok(note.last, 'the note is the last element of the panel (nothing above it jumps)');
    assert.match(note.text, /Could not be computed fresh \(.*(ENOTDIR|not a directory).*\) — showing the state of \d\d:\d\d\./);
    await page.goto(`${s.base}/dashboard#settings/system`);
    await waitReady(page);
    await page.waitForSelector('.setting-field');
    assert.equal(await page.locator('.live-note').count(), 0, 'the settings card does not say it: its part was computed');
  } finally { await ctx?.close().catch(() => {}); await s.stop(); }
});
