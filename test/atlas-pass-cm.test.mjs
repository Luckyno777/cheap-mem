// test/atlas-pass-cm.test.mjs — the single pass, the condensed atlas and the
// compact build (task atlas-pass-cm, 2026-10-02; the sibling's
// test/dash-tempo2-lm.test.mjs).
//
// **The finding (bench/board-tempo.mjs, old state 4d746f6).** Above 64 MB of
// drawers the server built only a light head: counters and the newest titles;
// net, agents, open questions, topics and the 3D atlas were unknown. At 1M
// entries the page could not show a single topic.
//
// Promises, each with a probe (and a positive control that the probe sees
// anything at all):
//   1. The single pass gives the same numbers as the readings it replaces: line
//      total, overview, net, open questions, agents, projects, per-entry state
//      and links — on a store with corrections, a retired entry, a closing line,
//      a broken line, an entry without an id and a duplicate id.
//   2. The compact build opens the biggest drawer exactly once (positive
//      control: the full build reads it many times).
//   3. The pass runs in a process with a 48 MB heap (positive control: holding
//      every entry in the same process does not).
//   4. HTTP: the condensed atlas carries exact topic and pair counts; the first
//      answer does not grow with the store; the pages of a topic are
//      gap-free, from the sample, the window and — beyond them — a search;
//      the head on disk carries no free text; a small store stays full.
//   5. Modules that read the whole store themselves are unknown with a reason
//      above their line, and run below it.
//   6. The build worker reports `ready` before it builds (a stop during the
//      evaluation of an ES module crashed V8 on Node 22.22) and a build over
//      the cap is stopped (tests that rely on a cap run WITHOUT NODE_OPTIONS:
//      its --max-old-space-size lifts the worker's limit).
//
// Red proof: the old mem-serve (pinned commit) against the same store serves a
// light head and has no atlas part; the whole file was also run in a
// throwaway worktree of the old commit (report). Browser side:
// test/atlas-pass-cm-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { oldBinCopy } from './helpers/old-source-copy.mjs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as question from '../src/question.mjs';
import * as consolePage from '../src/console.mjs';
import * as head from '../src/dashboard-head.mjs';
import * as dd from '../src/dashboard-data.mjs';
import * as pass from '../src/dashboard-pass.mjs';
import * as compact from '../src/dashboard-compact.mjs';
import * as cache from '../src/dashboard-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
// FIXED commit of the old state — never a moving ref.
const OLD_STATE = '4d746f6ede6d71dc2501903cd81e2f7331ac939c';
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// What a probe child process runs with: no NODE_OPTIONS (see the header).
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_OPTIONS; return e; };

function emptyRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-apass-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'apass', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  return r;
}

const THEMES = ['queue', 'billing', 'auth', 'cache', 'search', 'ui', 'ops'];
const themesOf = (i) => [THEMES[i % 7], THEMES[(i * 3 + 1) % 7]].filter((t, k, a) => a.indexOf(t) === k);

/** N entries written straight into drawers: three drawers, two projects, two tags each. */
function synth(n, { extraBytes = 0 } = {}) {
  const r = emptyRoot();
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.mkdirSync(path.join(r, 'projects', 'p1'), { recursive: true });
  const files = { 'global/learnings.jsonl': [], 'global/decisions.jsonl': [], 'projects/p1/learnings.jsonl': [] };
  const keys = Object.keys(files);
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const id = `s${i.toString(36)}`;
    ids.push(id);
    files[keys[i % 3]].push(JSON.stringify({
      id, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), title: `Entry ${i}`, text: `body ${i} ${'x'.repeat(extraBytes)}`,
      tags: themesOf(i), agent: i % 2 ? 'bot' : 'alex', note: 'zebra-secret-note',
    }));
  }
  for (const [f, rows] of Object.entries(files)) fs.writeFileSync(path.join(r, f), `${rows.join('\n')}\n`);
  return { root: r, ids };
}

/** A small store with every case the pass must agree with the full build on. */
function caseStore() {
  const r = emptyRoot();
  // Projects are created on purpose since project-new (logEntry refuses unknown ones).
  const L = (type, data, o = {}) => {
    if (o.project && !memory.projectExists(r, o.project)) memory.projectInit(r, o.project);
    return memory.logEntry(r, type, data, o);
  };
  const a = L('learning', { title: 'A one', text: 'x', tags: ['q', 'r'] }, { project: 'p1' });
  const b = L('learning', { title: 'B two', text: 'y', tags: ['q'] });
  const c = L('decision', { title: 'C', choice: 'o', why: 'w', tags: ['r'], agent: 'bot' });
  memory.retireEntry(r, 'learning', b.entry.id, { state: 'discarded', why: 'no' });
  const q1 = L('question', { question: 'why?', title: 'Q1' });
  L('question', { question: 'when?', title: 'Q2' });
  L('link', { kind: 'resolves', from: a.entry.id, to: q1.entry.id, title: 'res' });
  L('link', { kind: 'related', from: a.entry.id, to: c.entry.id, title: 'rel' });
  L('link', { kind: 'related', from: a.entry.id, to: 'nonexistent', title: 'dangling' });
  memory.correctionEntry(r, 'decision', c.entry.id, { title: 'C2', choice: 'o2', why: 'w2', tags: ['r', 'z'], agent: 'bot' });
  fs.appendFileSync(path.join(r, 'global', 'decisions.jsonl'), '{broken\n');
  fs.appendFileSync(path.join(r, 'global', 'thoughts.jsonl'), `${JSON.stringify({ ts: '2026-01-01T00:00:00Z', title: 'no id' })}\n`);
  fs.appendFileSync(path.join(r, 'global', 'thoughts.jsonl'), `${JSON.stringify({ id: 'dup1', ts: '2026-01-02T00:00:00Z', title: 'dup first' })}\n${JSON.stringify({ id: 'dup1', ts: '2026-01-03T00:00:00Z', title: 'dup second' })}\n`);
  return r;
}

// --- 1. equality with the readings the pass replaces ----------------------------

test('pass: the same numbers as the full readings on a store with corrections, retirements, broken and id-less lines', () => {
  const r = caseStore();
  const full = dd.collectDashboard(r);
  const p = pass.runPass(r);
  assert.equal(p.total, consolePage.inventory(r).total, 'line total = the inventory');
  assert.deepEqual(p.overview, head.overview(full.entries), 'overview counters');
  assert.deepEqual({ ...p.net }, { boxes: full.net.boxes, pairs: full.net.pairs, links: full.net.links, dangling: full.net.dangling }, 'net');
  assert.deepEqual([...p.questions.openIds].sort(), question.open(r).map((q) => q.id).sort(), 'open questions');
  assert.equal(p.questions.total, question.all(r).length);
  for (const a of full.agents) {
    const x = p.agents.find((y) => y.agent === a.name);
    assert.ok(x, `agent ${a.name} missing`);
    assert.equal(x.count, a.count, `${a.name} count`);
    assert.deepEqual(x.types, a.types);
    assert.deepEqual(x.projects, a.projects);
  }
  for (const pr of full.projects) {
    const x = p.projects.find((y) => y.name === pr.name);
    assert.deepEqual({ entries: x.entries, retired: x.retired, drawers: x.drawers, last: x.last }, { entries: pr.entries, retired: pr.retired, drawers: pr.drawers, last: pr.last }, `project ${pr.name}`);
  }
  // every kept row maps to the same entry the full build lists (state, links, title)
  const byPlace = new Map(full.entries.map((e) => [`${e.source}:${e.line}`, e]));
  assert.ok(p.window.length >= 8, 'positive control: the window holds the entries');
  for (const z of p.window) {
    const f = byPlace.get(`${z.source}:${z.line}`);
    const o = dd.entryRow(z, null, null);
    assert.equal(o.state, f.state, `${z.id} state`);
    assert.equal(o.title, f.title);
    for (const l of f.out ?? []) assert.ok((o.out ?? []).some((x) => x[0] === l[0] && x[1] === l[1] && x[2] === l[2]), `${z.id} link ${l}`);
  }
  assert.ok(full.entries.some((e) => e.state === 'superseded') && full.entries.some((e) => e.state === 'discarded'), 'positive control: the store really has retired entries');
  assert.equal(p.broken, 1);
});

test('pass: a retired entry does not count as held, a duplicate id counts once (positive control: the held figure moves)', () => {
  const r = caseStore();
  const p = pass.runPass(r);
  const lines = consolePage.inventory(r).total;
  assert.ok(p.held < lines, `held ${p.held} must be below the ${lines} lines`);
  // 2 superseded/discarded + 1 broken + 1 closing line + 1 duplicate
  assert.equal(lines - p.held, 5);
});

test('atlas: topic counts and topic pairs are exact (an entry counts in every topic it carries)', () => {
  const { root, ids } = synth(900);
  const p = pass.runPass(root);
  const expectCount = {}; const expectPair = {};
  for (let i = 0; i < ids.length; i += 1) {
    const t = themesOf(i);
    for (const x of t) expectCount[x] = (expectCount[x] ?? 0) + 1;
    if (t.length === 2) { const k = [...t].sort().join('|'); expectPair[k] = (expectPair[k] ?? 0) + 1; }
  }
  assert.equal(p.atlas.exact, true);
  for (const t of p.atlas.themes) assert.equal(t.count, expectCount[t.tag], `topic ${t.tag}`);
  assert.equal(p.atlas.themes.length, Object.keys(expectCount).length);
  for (const e of p.atlas.edges) assert.equal(e.count, expectPair[[e.from, e.to].join('|')], `pair ${e.from} ${e.to}`);
  assert.equal(p.atlas.edges.length, Object.keys(expectPair).length);
  assert.equal(p.atlas.drawers.reduce((n, d) => n + d.count, 0), 900);
  // fixed size: no free text anywhere in the atlas
  assert.doesNotMatch(JSON.stringify(p.atlas), /zebra-secret-note|body \d+/);
  // positive control: the cap marks the figures as lower bounds
  const capped = pass.runPass(root, { themesMax: 3 });
  assert.equal(capped.atlas.themesShown, 3);
  assert.ok(capped.atlas.themesTotal >= 7);
});

test('atlasSearch: the newest page of a topic and of a drawer, retired entries marked', () => {
  const r = caseStore();
  const s = pass.atlasSearch(r, { theme: 'r', max: 10 });
  assert.equal(s.total, 3, 'topic r: A one, C (superseded, still carries it) and C2');
  assert.ok(s.rows.some((x) => x.retired?.state === 'superseded'), 'positive control: the retired one is marked');
  const d = pass.atlasSearch(r, { drawer: 'global/learning', max: 10 });
  assert.ok(d.rows.every((x) => x.type === 'learning' && x.project === 'global'));
  assert.equal(pass.atlasSearch(r, { theme: pass.NO_THEME, max: 50 }).rows.every((x) => x.tags.length === 0), true);
});

// --- 2. one read of the big drawer ------------------------------------------------

test('compact build: opens the biggest drawer exactly once (positive control: the full build reads it many times)', () => {
  const { root } = synth(3000);
  const big = path.join(root, 'global', 'learnings.jsonl');
  const count = (fn) => {
    let n = 0;
    const oOpen = fs.openSync; const oRead = fs.readFileSync;
    fs.openSync = (p, ...a) => { if (String(p) === big) n += 1; return oOpen(p, ...a); };
    fs.readFileSync = (p, ...a) => { if (String(p) === big) n += 1; return oRead(p, ...a); };
    try { fn(); } finally { fs.openSync = oOpen; fs.readFileSync = oRead; }
    return n;
  };
  const once = count(() => pass.runPass(root));
  assert.equal(once, 1, 'the pass reads the drawer once');
  const many = count(() => dd.collectDashboard(root, { doctorCheck: () => ({ findings: [] }) }));
  assert.ok(many >= 4, `positive control: the full build reads it ${many} times`);
});

// --- 3. bounded memory --------------------------------------------------------------

test('pass: runs in a process with a 48 MB heap (positive control: holding every entry there does not)', () => {
  const { root } = synth(80000, { extraBytes: 300 });
  const run = (body) => {
    try {
      execFileSync(process.execPath, ['--max-old-space-size=48', '--input-type=module', '-e', body], { env: cleanEnv(), stdio: 'pipe', timeout: 120000 });
      return 0;
    } catch (e) { return e.status ?? 1; }
  };
  const mem = pathToFileURL(path.join(REPO, 'src', 'memory.mjs')).href;
  const pas = pathToFileURL(path.join(REPO, 'src', 'dashboard-pass.mjs')).href;
  const ok = run(`import { runPass } from ${JSON.stringify(pas)}; const p = runPass(${JSON.stringify(root)}, { window: 500 }); if (p.overview.count !== 80000) process.exit(3);`);
  assert.equal(ok, 0, 'the pass must fit into 48 MB');
  const hold = run(`import * as m from ${JSON.stringify(mem)}; const all = []; for (const t of ['learning','decision']) all.push(...m.readLog(${JSON.stringify(root)}, t).entries); all.push(...m.readLog(${JSON.stringify(root)}, 'learning', { project: 'p1' }).entries); if (all.length !== 80000) process.exit(3);`);
  assert.notEqual(hold, 0, 'positive control: holding the store in 48 MB must fail');
});

// --- 4. HTTP ---------------------------------------------------------------------------

async function start(root, env = {}, script = SERVE) {
  const mod = await import(`${pathToFileURL(script).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0', ...env,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    json: async (p) => (await fetch(`${base}${p}`)).json(),
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}
async function until(fn, what, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const COMPACT = { CHEAP_MEM_SERVE_FULL_BUILD_MB: '0.2' };

test('server: the compact build serves the condensed atlas; the first answer does not grow with the store; the head on disk has no free text', async () => {
  const small = synth(3000, { extraBytes: 400 });
  const bigger = synth(12000, { extraBytes: 400 });
  const sizes = [];
  for (const { root } of [small, bigger]) {
    const s = await start(root, COMPACT);
    try {
      const d = await until(async () => { const x = await s.json('/dashboard.json'); return x.compact && x.cache.source === 'build' && x; }, 'compact build');
      assert.equal(d.atlas.condensed, true);
      assert.equal(d.atlas.themes.length, 7);
      assert.equal(d.overview.count, root === small.root ? 3000 : 12000);
      assert.ok(d.entries.length <= 120 + 150, 'the head carries the newest entries only');
      assert.ok(d.parts.atlas && d.parts.entries);
      assert.equal(d.net.boxes.length, 3);
      assert.equal(d.agents.length, 2, 'agents from the pass');
      assert.equal(d.samples, undefined, 'the pages stay on the server');
      assert.equal(d.extras, undefined);
      assert.match(d.doctor.reason, /full build/, 'the doctor is unknown with its reason, not empty');
      sizes.push(JSON.stringify(d).length);
      const onDisk = fs.readFileSync(path.join(root, '.mem', 'dashboard-head.json'), 'utf8');
      assert.doesNotMatch(onDisk, /x{300}/, 'no free text on disk (the headline is cut at 240 characters)');
      assert.doesNotMatch(JSON.stringify(d), /x{300}|zebra-secret-note/, 'no free text in the answer');
      assert.match(onDisk, /"condensed":true/, 'positive control: the atlas IS in the head on disk');
    } finally { await s.stop(); }
  }
  assert.ok(sizes[1] < sizes[0] * 1.15, `the first answer grew with the store: ${sizes.join(' -> ')} bytes for 4x the entries`);
});

test('server: the pages of a topic are gap-free — sample, window, and beyond the window a search', async () => {
  const { root, ids } = synth(2400, { extraBytes: 600 }); // above the 1 MB line of the synchronous start
  const s = await start(root, { ...COMPACT, CHEAP_MEM_SERVE_WINDOW_ENTRIES: '300' });
  try {
    await until(async () => { const x = await s.json('/dashboard.json'); return x.compact && x.cache.source === 'build'; }, 'compact build');
    const expected = ids.map((id, i) => [id, i]).filter(([, i]) => themesOf(i).includes('queue')).map(([id]) => id).reverse();
    const seenSources = new Set();
    const got = [];
    let from = 0;
    for (let guard = 0; guard < 60 && from !== null; guard += 1) {
      const b = await until(async () => {
        const x = await s.json(`/dashboard/part.json?part=atlas&theme=queue&from=${from}&n=60`);
        return x.searching ? null : x;
      }, `page at ${from}`);
      assert.equal(b.state, 'ok', b.reason);
      seenSources.add(b.source);
      got.push(...b.data.map((e) => e.id));
      // eslint-disable-next-line require-atomic-updates -- single sequential loop, `from` is not shared
      from = b.next;
    }
    assert.deepEqual(got, expected, 'every entry of the topic once, newest first');
    assert.ok(seenSources.has('sample'), 'positive control: the first page came from the sample');
    assert.ok(seenSources.has('search'), 'beyond the 300-entry window the pages come from a search');
    // a drawer
    const dr = await s.json('/dashboard/part.json?part=atlas&drawer=p1%2Flearning&from=0&n=60'.replace('p1%2Flearning', 'global%2Fdecision'));
    assert.equal(dr.state, 'ok');
    assert.equal(dr.total, 800);
  } finally { await s.stop(); }
});

test('server: a small store stays full — no compact build, no atlas (positive control for the line)', async () => {
  const { root } = synth(300);
  const s = await start(root, {});
  try {
    const d = await until(async () => { const x = await s.json('/dashboard.json'); return x.cache.source === 'build' && x; }, 'build');
    assert.equal(d.compact, undefined);
    assert.equal(d.atlas, undefined);
    assert.equal(d.overview.count, 300);
  } finally { await s.stop(); }
});

test('server: the project package is refused over a compact build (it would be silently incomplete)', async () => {
  const { root } = synth(1500, { extraBytes: 800 }); // above the 1 MB line of the synchronous start
  const s = await start(root, COMPACT);
  try {
    await until(async () => { const x = await s.json('/dashboard.json'); return x.compact && x.cache.source === 'build'; }, 'compact build');
    const r = await fetch(`${s.base}/dashboard/project-package.json?project=global&preview=1`);
    assert.equal(r.status, 503);
  } finally { await s.stop(); }
});

// --- 5. modules ---------------------------------------------------------------------------

test('compact: modules that read the whole store are unknown with a reason above their line and run below it', () => {
  const { root } = synth(600);
  const over = compact.collectCompact(root, { bytes: 200 * 1048576 });
  assert.match(over.compact.unknown.topics, /over the 128 MB/);
  assert.match(over.compact.unknown.experiences, /over the 128 MB/);
  assert.equal(over.integrity.readable, false);
  assert.match(over.integrity.reason, /128 MB/);
  assert.equal(over.work.find((w) => w.title === 'Duties').state, 'unknown');
  assert.equal(over.topics.list.length, 0);
  // positive control: below the line they run
  const under = compact.collectCompact(root, { bytes: 1 * 1048576 });
  assert.equal(under.integrity.readable, true);
  assert.deepEqual(under.compact.unknown, {});
  assert.ok(under.topics.list.length > 0 || under.topics.areas.length >= 0);
  assert.equal(under.meta.entriesTotal, 600);
});

// --- 6. the worker ----------------------------------------------------------------------------

test('worker: reports ready first and builds one turn later (positive control: the result does come)', async () => {
  const { root } = synth(300);
  const messages = [];
  await new Promise((resolve, reject) => {
    const w = new Worker(new URL('../src/dashboard-cache.mjs', import.meta.url), {
      workerData: { dashboardCacheBuild: true, root, options: { kind: 'head', title: 't', route: '/r' } },
    });
    w.on('message', (m) => { messages.push(Object.keys(m).join(',')); if (m.ok !== undefined) resolve(); });
    w.on('error', reject);
  });
  assert.deepEqual(messages, ['ready', 'ok,data'], 'ready first, then the result');
});

test('worker: a build over the cap is stopped and the process survives; the normal cap builds (run without NODE_OPTIONS)', () => {
  const { root } = synth(40000, { extraBytes: 150 });
  // A script file, not `-e`: a worker inherits the process's execArgv, and `--input-type` is refused there.
  const file = path.join(root, 'cap-probe.mjs');
  const script = `
    import * as cache from ${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'dashboard-cache.mjs')).href)};
    const heapMb = Number(process.argv[2]);
    try { const d = await cache.buildInWorker(${JSON.stringify(root)}, { kind: 'compact', bytes: null, title: 't' }, { heapMb, guardMs: 5 });
      console.log('built ' + d.overview.count);
    } catch (e) { console.log('rejected ' + e.message); }
    process.exit(0);`;
  fs.writeFileSync(file, script);
  const run = (heapMb) => execFileSync(process.execPath, [file, String(heapMb)], { env: cleanEnv(), encoding: 'utf8', timeout: 180000 }).trim();
  assert.match(run(4096), /^built 40000$/, 'positive control: with the normal cap the compact build works');
  for (let i = 0; i < 3; i += 1) assert.match(run(24), /^rejected .*(memory|heap)/i, 'a worker over its cap must be stopped, never crash the process');
});

// --- red proof: the old mem-serve --------------------------------------------------------------

test(`RED on the old state (${OLD_STATE.slice(0, 7)}): over the line only a light head, no atlas part`, async (t) => {
  let old;
  try {
    old = execFileSync('git', ['show', `${OLD_STATE}:bin/mem-serve`], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    t.skip(`commit ${OLD_STATE.slice(0, 7)} not reachable (shallow clone?) — red proof unknown, not green`);
    return;
  }
  const copy = oldBinCopy(REPO, 'mem-serve.mjs', old); // a throwaway package: nothing is written into the live bin/
  const tmpScript = copy.script;
  try {
    const { root } = synth(1500, { extraBytes: 800 });
    const s = await start(root, COMPACT, tmpScript);
    try {
      const d = await until(async () => { const x = await s.json('/dashboard.json'); return x.light && x.cache.source === 'build' && x; }, 'light head');
      assert.equal(d.atlas, undefined, 'the old state has no atlas');
      assert.equal(d.net, undefined, 'the old state has no net above the line');
      const part = await fetch(`${s.base}/dashboard/part.json?part=atlas&theme=queue`);
      assert.equal(part.status, 404);
    } finally { await s.stop(); }
  } finally { fs.rmSync(copy.dir, { recursive: true, force: true }); }
});

test('cache: a quick head may be skipped (buildHead answers null) — nothing null is stored as a state', async () => {
  let during = null;
  const c = cache.createCache({
    build: () => ({ kind: 'full' }), buildInBackground: async () => { during = c.get(); return { kind: 'bg' }; },
    stamp: () => 's', syncAllowed: () => false, buildHead: async () => null, minGapMs: 0,
  });
  assert.equal(c.get().source, 'placeholder');
  await c.waitForRebuild();
  assert.equal(during.source, 'placeholder', 'while the build runs the placeholder stands — a skipped head is not a state');
  assert.notEqual(during.data, null);
  assert.equal(c.get().data.kind, 'bg');
  // positive control: a head that IS built becomes the state while the build runs
  let during2 = null;
  const c2 = cache.createCache({
    build: () => ({ kind: 'full' }), buildInBackground: async () => { during2 = c2.get(); return { kind: 'bg' }; },
    stamp: () => 's', syncAllowed: () => false, buildHead: async () => ({ kind: 'quick' }), minGapMs: 0,
  });
  c2.get();
  await c2.waitForRebuild();
  assert.equal(during2.source, 'head');
});
