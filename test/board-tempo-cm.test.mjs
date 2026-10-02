// test/board-tempo-cm.test.mjs — the dashboard's first answer (task
// board-tempo-cm, 2026-10-02; the sibling's test/dash-tempo-lm.test.mjs).
//
// **The finding (bench/board-tempo.mjs, old state ee5e6f4).** The first
// answer of /dashboard.json carried EVERY entry and came only after one whole
// build: 3.6 s at 10k entries, 35 s and 43 MB at 100k, no answer at 1M (the
// server died at its heap limit). After every start the cache was empty, so
// the first page always waited for the whole build.
//
// Promises, each with a probe (and a positive control that the probe sees
// anything at all):
//   1. The first answer is a small head (newest entries + `overview`
//      counters + `parts.entries`); the pages of the `entries` part are the
//      same ids as the whole list, from ONE state (`state_id`).
//   2. A cold start answers from the head on disk — not fresh, with its
//      reason — and reads no drawer file. Without a head on disk a large
//      store gets the placeholder (state unknown), never a wait.
//   3. The head on disk: 0600, atomic, WITHOUT free texts.
//   4. A part that is not built yet answers `building`, never an empty
//      list; the project package refuses (503) instead of being incomplete.
//   5. The age counts from the END of the build; the gap between two
//      background builds scales with the build time.
//   6. The build worker has a heap cap: an overflow rejects, the server
//      stays up.
//   7. The size of the store counts the archive manifest and the archived
//      shards (but the shards do not decide whether the full build runs).
//   8. The light head (for stores the full build cannot handle) carries the
//      same counters, bounded memory, and says why it is only a head.
//
// Red proof: the last test runs the OLD mem-serve (pinned commit) against
// the same store; the whole file was also run in a throwaway worktree of the
// old commit (report). Browser side: test/board-tempo-cm-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as cache from '../src/dashboard-cache.mjs';
import * as head from '../src/dashboard-head.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
// FIXED commit of the old state — never a moving ref.
const OLD_STATE = 'ee5e6f4f6e7dd7254b9891ba58b1727e0e52828b';
const SECRET = 'zebra-unique-free-text-marker';
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function world({ entries = 3, textBytes = 0, project = null } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-btempo-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'btempo', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  const types = ['learning', 'decision', 'error'];
  for (let i = 0; i < entries; i += 1) {
    const type = types[i % types.length];
    const data = type === 'decision'
      ? { title: `Decision ${i}`, choice: `option ${i}`, why: `${SECRET} ${i} ${'w'.repeat(textBytes)}` }
      : { title: `Entry ${i}`, text: `${SECRET} ${i} ${'x'.repeat(textBytes)}` };
    memory.logEntry(r, type, data, { project, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  }
  return r;
}

/**
 * A store above the synchronous limit (1 MB) made of MANY SMALL entries
 * written straight into a drawer (one big entry would make the build slow
 * for the wrong reason: measured 61 s for 140 entries of 9 KB). `crypt`
 * adds newest entries written with `shred: true` that carry SECRET.
 */
function bigWorld({ lines = 4000, crypt = 0 } = {}) {
  const r = world({ entries: 0 });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  const rows = [];
  for (let i = 0; i < lines; i += 1) {
    rows.push(JSON.stringify({
      id: `s${i.toString(36)}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      title: `Entry ${i} about queue`, text: `plain body ${i} ${'x'.repeat(200)}`, tags: ['queue'],
    }));
  }
  fs.writeFileSync(path.join(r, 'global', 'learnings.jsonl'), `${rows.join('\n')}\n`);
  for (let i = 0; i < crypt; i += 1) {
    memory.logEntry(r, 'learning', { title: `vault ${i}`, text: `${SECRET} vault ${i}`, shred: true }, { now: new Date(Date.UTC(2026, 5, 1, 0, 0, i)) });
  }
  assert.ok(cache.storeBytes(r).build > cache.SYNC_UP_TO_BYTES, 'the probe store must be above the synchronous limit');
  return r;
}

async function start(root, env = {}, script = SERVE) {
  const mod = await import(`${pathToFileURL(script).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', ...env,
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

// --- 1. the head and its pages (units) -----------------------------------------

const entry = (i, over = {}) => ({
  id: `e${String(i).padStart(4, '0')}`, type: ['learning', 'decision'][i % 2], project: i % 3 ? 'global' : 'p1',
  title: `t${i}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), readable: i % 5 !== 0, ...over,
});

test('head: a large list gives the newest N plus the open ones, the overview counts ALL', () => {
  const all = Array.from({ length: 500 }, (_, i) => entry(i));
  const h = head.headEntries(all, { open: new Set(['e0003', 'e0007']), max: 50, route: '/x?part=entries' });
  assert.equal(h.entries.length, 52);
  assert.equal(h.entries[0].id, 'e0499', 'newest first');
  assert.ok(h.entries.some((e) => e.id === 'e0003') && h.entries.some((e) => e.id === 'e0007'), 'the open ones are in the head');
  assert.equal(h.overview.count, 500);
  assert.equal(h.overview.readable, 400);
  assert.equal(h.overview.perType.learning + h.overview.perType.decision, 500);
  assert.equal(h.overview.perProject.p1.count, all.filter((e) => e.project === 'p1').length);
  assert.deepEqual(h.part, { path: '/x?part=entries', count: 500, in_head: 52, page: head.PAGE_MAX });
});

test('head: positive control — a small list stays whole, without an entries part', () => {
  const all = Array.from({ length: 30 }, (_, i) => entry(i));
  const h = head.headEntries(all, { max: 50 });
  assert.equal(h.entries.length, 30);
  assert.equal(h.part, null);
});

test('head: the pages are the whole list, once, in order; the last has next:null', () => {
  const all = Array.from({ length: 1234 }, (_, i) => entry(i));
  const { sorted } = head.headEntries(all, { max: 10 });
  const ids = [];
  let from = 0;
  for (let guard = 0; from !== null && guard < 100; guard += 1) {
    const p = head.page(sorted, from, 500);
    assert.equal(p.total, 1234);
    ids.push(...p.data.map((e) => e.id));
    from = p.next;
  }
  assert.equal(ids.length, 1234);
  assert.equal(new Set(ids).size, 1234);
  assert.deepEqual(ids, sorted.map((e) => e.id));
  // an absurd page size is capped; a negative or broken offset starts at 0
  assert.equal(head.page(sorted, -5, 1e9).n, 1234, 'positive control: a short list is not padded');
  const long = head.headEntries(Array.from({ length: head.PAGE_MAX + 50 }, (_, i) => entry(i)), { max: 10 }).sorted;
  assert.equal(head.page(long, -5, 1e9).n, head.PAGE_MAX);
  assert.equal(head.page(sorted, 'x', 3).from, 0);
});

// --- 2.-4. the server --------------------------------------------------------

test('server: the first answer is small and carries counters; the pages equal the full list (one state)', async () => {
  const N = 400;
  const root = world({ entries: N });
  const s = await start(root);
  try {
    const d = await s.json('/dashboard.json');
    assert.equal(d.cache.source, 'build');
    assert.equal(d.cache.fresh, true);
    assert.ok(d.entries.length <= head.HEAD_ENTRIES + 150, `the first answer carries ${d.entries.length} entries — the whole list`);
    assert.equal(d.overview.count, N, 'the counters come from the server, not from the length of the head');
    assert.equal(d.parts.entries.count, N);
    assert.equal(d.parts.entries.in_head, d.entries.length);
    // positive control: the list is really there to be fetched, with its free text
    const ids = [];
    let from = 0;
    let stateId = null;
    while (from !== null) {
      const p = await s.json(`/dashboard/part.json?part=entries&from=${from}&n=150`);
      assert.equal(p.state, 'ok');
      if (stateId !== null) assert.equal(p.state_id, stateId, 'two pages from two different states');
      stateId = p.state_id;
      assert.equal(p.total, N);
      ids.push(...p.data.map((e) => e.id));
      if (from === 0) assert.ok(p.data.some((e) => String(e.text ?? e.why ?? '').includes(SECRET)), 'positive control: the page carries the free texts');
      from = p.next;
    }
    assert.equal(new Set(ids).size, N);
    for (const e of d.entries) assert.ok(ids.includes(e.id), 'an entry of the head is not in the pages');
  } finally { await s.stop(); }
});

test('server: a large store without a stored head gets the placeholder (never a wait), then head, then build', async () => {
  const root = bigWorld();
  const s = await start(root);
  try {
    const t0 = Date.now();
    const first = await s.json('/dashboard.json');
    // On a very quiet machine the quick head can already be in; the promise is "no wait for the full build".
    assert.ok(['placeholder', 'head', 'build'].includes(first.cache.source), first.cache.source);
    assert.ok(Date.now() - t0 < 5000, 'the first answer waited');
    if (first.cache.source === 'placeholder') {
      assert.equal(first.cache.fresh, false);
      assert.ok(first.cache.reason, 'not fresh without a reason');
      assert.equal(first.state, 'unknown');
      assert.equal(first.placeholder, true);
      assert.deepEqual(first.entries, [], 'the placeholder carries no invented list');
      assert.equal(first.overview, null, 'no counter without a measurement');
      // 4. a part that is not built yet is `building`, never an empty list
      const part = await s.json('/dashboard/part.json?part=entries');
      assert.equal(part.building, true);
      assert.equal(part.data, null);
      assert.equal(part.state, 'unknown');
    }
    const done = await until(async () => { const d = await s.json('/dashboard.json'); return d.cache.source === 'build' && d; }, 'full build');
    assert.equal(done.cache.fresh, true);
    assert.equal(done.overview.count, 4000);
  } finally { await s.stop(); }
});

test('disk: the head is laid down 0600 without decrypted content; a cold start answers from it and reads no drawer', async () => {
  const root = bigWorld({ crypt: 3 });
  let s = await start(root);
  try {
    const built = await until(async () => { const d = await s.json('/dashboard.json'); return d.cache.source === 'build' && d; }, 'first full build');
    // positive control: the decrypted text IS in memory (the head of the live answer) — otherwise "not on disk" proves nothing
    assert.ok(built.entries.some((e) => String(e.text ?? '').includes(SECRET)), 'positive control: the live answer shows the decrypted text');
  } finally { await s.stop(); }
  const file = head.headPath(root);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the head on disk must be 0600');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(SECRET), 'decrypted content of an entry reached the disk');
  const onDisk = JSON.parse(text).data;
  assert.ok(onDisk.entries.length > 0);
  for (const e of onDisk.entries) for (const f of ['text', 'fact', 'why']) assert.equal(e[f], undefined, `entry carries '${f}' on disk`);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('dashboard-head') && n !== 'dashboard-head.json'), [], 'a temporary file stayed behind (not atomic)');

  // cold start: count every open of a drawer file during the FIRST request
  const drawerReads = [];
  const realOpen = fs.openSync;
  const realRead = fs.readFileSync;
  const isDrawer = (p) => typeof p === 'string' && /[\\/](global|projects[\\/][^\\/]+)[\\/][a-z-]+\.jsonl$/.test(p) && p.startsWith(root);
  fs.openSync = (p, ...a) => { if (isDrawer(p)) drawerReads.push(p); return realOpen(p, ...a); };
  fs.readFileSync = (p, ...a) => { if (isDrawer(p)) drawerReads.push(p); return realRead(p, ...a); };
  let first;
  try {
    s = await start(root);
    first = await s.json('/dashboard.json');
  } finally { fs.openSync = realOpen; fs.readFileSync = realRead; }
  try {
    assert.equal(first.cache.source, 'disk');
    assert.equal(first.cache.fresh, false, 'a head from disk is never fresh');
    assert.match(first.cache.reason, /disk|last run/);
    assert.equal(first.overview.count, 4003);
    assert.deepEqual(drawerReads, [], 'the cold start opened drawer files');
    assert.ok(first.entries.every((e) => e.text === undefined), 'free text came back from disk');
    // while only the head is there: part answers `building`, the package refuses (503)
    const part = await s.json('/dashboard/part.json?part=entries');
    assert.equal(part.building, true);
    assert.equal(part.data, null);
    const pkg = await fetch(`${s.base}/dashboard/project-package.json?project=global&preview=1`);
    assert.ok([503, 404].includes(pkg.status), `package answered ${pkg.status}`);
    // after the rebuild: fresh and the pages are there
    await until(async () => (await s.json('/dashboard.json')).cache.source === 'build', 'rebuild after the cold start');
    const full = await s.json('/dashboard/part.json?part=entries&from=0&n=5');
    assert.equal(full.state, 'ok');
    assert.equal(full.total, 4003);
  } finally { await s.stop(); }
});

test('disk: positive control — a synchronous build DOES read the drawers (the counter above sees something)', async () => {
  const root = world({ entries: 5 });
  const reads = [];
  const realRead = fs.readFileSync;
  const realOpen = fs.openSync;
  fs.openSync = (p, ...a) => { if (typeof p === 'string' && p.startsWith(root) && p.endsWith('.jsonl')) reads.push(p); return realOpen(p, ...a); };
  fs.readFileSync = (p, ...a) => { if (typeof p === 'string' && p.startsWith(root) && p.endsWith('.jsonl')) reads.push(p); return realRead(p, ...a); };
  let s;
  try {
    s = await start(root);
    await s.json('/dashboard.json');
  } finally { fs.openSync = realOpen; fs.readFileSync = realRead; if (s) await s.stop(); }
  assert.ok(reads.length > 0, 'the build read no drawer — the counter would be blind');
});

test('disk: an unreadable or foreign head is ignored (never trusted, never a crash)', () => {
  const root = world({ entries: 1 });
  assert.equal(head.readHead(root), null, 'no head yet');
  fs.writeFileSync(head.headPath(root), '{"version":99,"data":{}}');
  assert.equal(head.readHead(root), null, 'another version is not read');
  fs.writeFileSync(head.headPath(root), 'not json');
  assert.equal(head.readHead(root), null);
  head.writeHead(root, { entries: [{ id: 'a', text: 'secret' }] }, { stamp: 's', builtMs: 1, durationMs: 2 });
  const back = head.readHead(root);
  assert.equal(back.data.entries[0].id, 'a');
  assert.equal(back.data.entries[0].text, undefined, 'positive control: the free text really is stripped');
});

// --- 5. age from the end of the build, gap scaled with the duration -------------

function clocked({ buildMs, ttlMs = 60_000, minGapMs = 20_000, syncUpToMs = -1 }) {
  const clock = { t: 1_000_000 };
  let st = 's1';
  const calls = { sync: 0, background: 0 };
  const c = cache.createCache({
    build: () => { calls.sync += 1; clock.t += buildMs; return { v: calls.sync }; },
    buildInBackground: async () => { calls.background += 1; clock.t += buildMs; return { v: 'bg' }; },
    stamp: () => st, ttlMs, minGapMs, syncUpToMs, now: () => clock.t,
  });
  return { c, clock, calls, setStamp: (x) => { st = x; } };
}

test('cache: a build longer than the TTL is fresh right after it ends (the age counts from the end)', () => {
  const p = clocked({ buildMs: 100_000 });
  const a = p.c.get();
  assert.equal(a.meta.build_ms, 100_000);
  assert.equal(a.meta.fresh, true, 'a 100 s build was "too old" the moment it finished');
  // positive control: the TTL still bites — 61 s after the end it is too old
  p.clock.t += 61_000;
  const b = p.c.get();
  assert.equal(b.meta.fresh, false);
  assert.match(b.meta.reason, /older than/);
});

test('cache: the gap between background builds scales with the build time (at most a quarter of the time)', async () => {
  const p = clocked({ buildMs: 100_000 });
  p.c.get(); // synchronous first build
  p.setStamp('s2');
  p.c.get(); // first background build (takes 100 s)
  await p.c.waitForRebuild();
  assert.equal(p.calls.background, 1);
  p.setStamp('s3');
  p.clock.t += 30_000; // over the 20 s minimum gap, under 4 x 100 s
  p.c.get();
  await p.c.waitForRebuild();
  assert.equal(p.calls.background, 1, 'a rebuild started after 30 s although the last build took 100 s');
  p.clock.t += 450_000;
  p.c.get();
  await p.c.waitForRebuild();
  assert.equal(p.calls.background, 2, 'positive control: after the scaled gap the rebuild runs');
});

test('cache: cold start order — disk head, else synchronous (small), else placeholder + quick head + full build', async () => {
  const mk = (over) => {
    const calls = { sync: 0, head: 0, full: 0 };
    const c = cache.createCache({
      build: () => { calls.sync += 1; return { kind: 'sync' }; },
      buildInBackground: async () => { calls.full += 1; return { kind: 'full' }; },
      buildHead: async () => { calls.head += 1; return { kind: 'head' }; },
      stamp: () => 's', minGapMs: 0, ...over,
    });
    return { c, calls };
  };
  const a = mk({ fromDisk: () => ({ data: { kind: 'disk' }, stamp: 'old', builtMs: 5, durationMs: 7 }), syncAllowed: () => false });
  const r1 = a.c.get();
  assert.equal(r1.data.kind, 'disk');
  assert.equal(r1.meta.fresh, false);
  assert.equal(a.calls.sync, 0, 'a head from disk must not trigger a synchronous build');
  await a.c.waitForRebuild();
  assert.equal(a.c.get().data.kind, 'full');
  assert.equal(a.c.get().meta.fresh, true);

  const b = mk({ syncAllowed: () => true });
  assert.equal(b.c.get().data.kind, 'sync');

  const c = mk({ syncAllowed: () => false, placeholder: () => ({ kind: 'placeholder' }) });
  const r3 = c.c.get();
  assert.equal(r3.data.kind, 'placeholder');
  assert.equal(r3.meta.fresh, false);
  assert.ok(r3.meta.reason);
  await c.c.waitForRebuild();
  assert.equal(c.calls.head, 1, 'the quick head runs before the full build');
  assert.equal(c.calls.sync, 0);
  assert.equal(c.c.get().data.kind, 'full');
});

// --- 6. the heap cap ---------------------------------------------------------

test('worker: a build over the heap cap is stopped and rejects (the server stays up); positive control — the normal cap builds', async () => {
  const root = bigWorld();
  const ok = await cache.buildInWorker(root, { kind: 'head', title: 't', route: '/r' });
  assert.equal(ok.light, true, 'positive control: with the normal cap the light head builds');
  assert.equal(ok.overview.count, 4000);
  const t0 = Date.now();
  await assert.rejects(
    () => cache.buildInWorker(root, { title: 't' }, { heapMb: 1 }),
    /memory cap/,
    'a worker over its cap must be stopped, not run on until the whole process limit',
  );
  assert.ok(Date.now() - t0 < 20_000, 'the cap was enforced late');
  assert.ok(cache.WORKER_HEAP_MB >= 512 && cache.WORKER_HEAP_MB <= 4096, `default cap ${cache.WORKER_HEAP_MB} MB`);
});

// --- 7. the size of the store ------------------------------------------------

test('storeBytes: drawers + manifest + archived shards; the shards do not count into the build size', () => {
  const root = world({ entries: 6, textBytes: 1000 });
  const base = cache.storeBytes(root);
  assert.ok(base.drawers > 6000);
  assert.equal(base.shards, 0);
  assert.equal(base.total, base.build, 'positive control: without an archive nothing is added');
  fs.writeFileSync(path.join(root, 'archive-manifest.jsonl'), 'x'.repeat(300));
  fs.mkdirSync(path.join(root, 'raw', 'shards'), { recursive: true });
  fs.writeFileSync(path.join(root, 'raw', 'shards', 'a.jsonl'), 'y'.repeat(5000));
  fs.writeFileSync(path.join(root, 'raw', 'shards', 'b.jsonl'), 'z'.repeat(7000));
  const more = cache.storeBytes(root);
  assert.equal(more.manifest, 300);
  assert.equal(more.shards, 12_000);
  assert.equal(more.total, base.drawers + 300 + 12_000);
  assert.equal(more.build, base.drawers + 300, 'archived shards cost the full build nothing');
});

// --- 8. the light head -------------------------------------------------------

test('light head: the same counters as the full list, bounded entries, no free text, a reason', () => {
  const root = world({ entries: 90, textBytes: 10 });
  const types = [{ type: 'learning', name: 'Learning' }];
  const light = head.lightHead(root, { max: 20, reason: 'because probe', types, route: '/r' });
  assert.equal(light.light, true);
  assert.equal(light.state, 'warning');
  assert.equal(light.reasons[0], 'because probe');
  assert.equal(light.overview.count, 90);
  assert.equal(light.overview.perType.learning, 30);
  assert.equal(light.overview.perType.decision, 30);
  assert.equal(light.entries.length, 20);
  const stamps = light.entries.map((e) => e.ts);
  assert.deepEqual(stamps, [...stamps].sort().reverse(), 'newest first');
  for (const e of light.entries) for (const f of ['text', 'fact', 'why']) assert.equal(e[f], undefined);
  assert.equal(light.parts.entries.head_only, true);
  assert.equal(light.parts.entries.count, 90);
  assert.equal(light.inbox.readable, false, 'a tile that was not built is unknown, not empty');
  // agrees with the full build's counters (one truth)
  return import('../src/dashboard-data.mjs').then((m) => {
    const full = m.collectDashboard(root, {});
    assert.equal(head.overview(full.entries).count, light.overview.count);
    assert.deepEqual(head.overview(full.entries).perType, light.overview.perType);
  });
});

test('server: over the full-build size only the light head is served — with the reason, never fresh-and-complete', async () => {
  const root = bigWorld();
  const s = await start(root, { CHEAP_MEM_SERVE_FULL_BUILD_MB: '0.5' });
  try {
    const d = await until(async () => { const x = await s.json('/dashboard.json'); return x.light && x.cache.source === 'build' && x; }, 'light head as the build');
    assert.equal(d.state, 'warning');
    assert.match(d.reasons[0], /full build runs only up to/);
    assert.equal(d.overview.count, 4000);
    assert.equal(d.parts.entries.head_only, true);
    const part = await s.json('/dashboard/part.json?part=entries');
    assert.equal(part.head_only, true);
    assert.equal(part.data, null, 'no invented list');
    const pkg = await fetch(`${s.base}/dashboard/project-package.json?project=global&preview=1`);
    assert.ok([503, 404].includes(pkg.status));
    // positive control: the same store under the limit builds in full
    const s2 = await start(root, { CHEAP_MEM_SERVE_FULL_BUILD_MB: '500' });
    try {
      const f = await until(async () => { const x = await s2.json('/dashboard.json'); return x.cache.source === 'build' && !x.light && x; }, 'full build');
      assert.equal(f.overview.count, 4000);
    } finally { await s2.stop(); }
  } finally { await s.stop(); }
});

// --- red proof: the old mem-serve ---------------------------------------------

test(`RED on the old state (${OLD_STATE.slice(0, 7)}): the first answer carries every entry, no overview, no entries part`, async (t) => {
  let old;
  try {
    old = execFileSync('git', ['show', `${OLD_STATE}:bin/mem-serve`], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 << 20 });
  } catch {
    t.skip(`commit ${OLD_STATE.slice(0, 7)} not reachable (shallow clone?) — red proof unknown, not green`);
    return;
  }
  const tmpScript = path.join(REPO, 'bin', `.btempo-old-mem-serve-${process.pid}.mjs`);
  fs.writeFileSync(tmpScript, old.replace(/^#!.*\n/, ''));
  try {
    const s = await start(world({ entries: 400 }), {}, tmpScript);
    try {
      const d = await s.json('/dashboard.json');
      assert.equal(d.entries.length, 400, 'the old state carries every entry in the first answer — otherwise the probe shows nothing');
      assert.equal(d.overview, undefined);
      assert.equal(d.parts.entries, undefined);
      const part = await fetch(`${s.base}/dashboard/part.json?part=entries`);
      assert.equal(part.status, 404);
    } finally { await s.stop(); }
  } finally { fs.rmSync(tmpScript, { force: true }); }
});
