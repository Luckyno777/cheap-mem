// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// index-rest-cm part 2 (#49, 2026-10-17): the state a full build stores is the state of the bytes the build READ.
//
// The finding (review of index-schwelle-cm). `loadIndexCached` took `now = indexedFiles()` (sizes) BEFORE `buildIndex`, and counted
// lines, tail hash and whole-file hash AFTER it, from the file as it was by then. A writer working in between left the cache
// saying "N0 bytes, L lines" about documents that were built from N1 > N0 bytes: the next append read the bytes from N0 on
// again (the entries between N0 and N1 stood TWICE in the index: 1 to 3 ids at 20,000 entries, measured) and numbered the
// lines of every later entry from the wrong base (157 lines off, measured). Both ways in are driven here, deterministically,
// by a writer that appends at the moment the build reads the file (before the read: the stat is stale; after it: the later
// count is).
//
//   (a) a write BEFORE the build's read: no id twice after the next load, every source:line the one of a fresh build
//   (b) a write AFTER the build's read, then a later append: the lines of the later entries are right
//   (c) a log written for the first time during the build is not read again as new
//   (d) `assertCacheLanded`: a cache of a later build is fine; a miss in the gap of a second builder's swap is read once more
//   (e) two writers at once: the lost one removes its own parked cache; the next swap removes old leftovers (and only those)
//   (c2) the recorded line count, with and without a final newline
//   (f) red proof: (a), (b) and (e) at the pinned base 9c95641 give the old behaviour
//
// Everything is checked through states (documents by source:line:id, directory listings), never through a duration. Windows:
// `os.tmpdir()` via tempDir, no POSIX tools; the writer is the test process itself (a patched `fs.readFileSync`), no child.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as cfg from '../src/config.mjs';
import * as indexcache from '../src/indexcache.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The base of this work (origin/agent/index-schwelle-cm), FIXED: never a moving merge-base (the probe would turn red by itself).
const BASE = '9c95641';

function world(t, n = 40) {
  const root = tempDir('cm-index-snapshot-', t);
  cfg.writeConfig(root, cfg.DEFAULT_CONFIG);
  for (let i = 0; i < n; i += 1) {
    memory.logEntry(root, 'learning', { title: `learning ${i} tunnel relay uniq${i}`, text: `about step ${i % 31} of the deploy, tag t${i % 7}` });
  }
  return root;
}

const keyOf = (d) => `${d.source}:${d.line}:${d.entry?.id}`;
const docsOf = (index) => index.documents.map(keyOf);

/** The documents of a fresh build of the log as it stands now: the ground truth. */
function truth(root) {
  return docsOf(search.buildIndex(root));
}

/**
 * Run `fn` while the first read of `file` by the build is wrapped: `write()` runs just BEFORE (`'before'`) or just AFTER
 * (`'after'`) that read. `fs.readFileSync` is the same object for every module, so this reaches the old tree as well.
 */
function writerAtRead(file, mode, write, fn) {
  const real = fs.readFileSync;
  let armed = true;
  let busy = false;
  fs.readFileSync = function patched(p, ...rest) {
    if (armed && !busy && String(p) === file) {
      armed = false;
      busy = true;
      try {
        if (mode === 'before') write();
        const out = real.call(this, p, ...rest);
        if (mode === 'after') write();
        return out;
      } finally { busy = false; }
    }
    return real.call(this, p, ...rest);
  };
  try { return fn(); } finally { fs.readFileSync = real; }
}

function late(root, from, k, tag) {
  for (let i = from; i < from + k; i += 1) {
    memory.logEntry(root, 'learning', { title: `${tag} ${i} zebrafish relay`, text: `written ${tag} ${i}` });
  }
}

/**
 * The whole scene of (a) and (b) with the module `mod` (the live tree or the old one). Returns the load right after the race
 * (`mid`) and the one after a further append (`next`).
 */
function scene(mod, root, mode) {
  const file = memory.logPath(root, 'learning', null);
  const k = 5;
  writerAtRead(file, mode, () => late(root, 0, k, mode), () => mod.loadIndex(root, { fresh: true }));
  const mid = mod.loadIndex(root, {});   // nothing written since: cache hit (the writes after the read are appended)
  // a later entry after the race: its line must be the line it has in the file
  late(root, 100, 3, 'after');
  const next = mod.loadIndex(root, {});   // cache hit plus append
  return { mid, next, k };
}

function duplicates(keys) {
  return keys.length - new Set(keys).size;
}
function idDuplicates(index) {
  const seen = new Map();
  for (const d of index.documents) seen.set(d.entry?.id, (seen.get(d.entry?.id) ?? 0) + 1);
  return [...seen.values()].filter((v) => v > 1).length;
}

test('(a) a write before the build reads the file: no id twice at the next load, lines as in a fresh build', (t) => {
  const root = world(t);
  const { mid, next } = scene(search, root, 'before');
  // the state is the state of what the build read: the next load trusts the cache and appends nothing, then exactly the 3 new lines
  assert.equal(mid.fromCache, true, 'the cache just written is not trusted (rebuilt)');
  assert.equal(mid.appended, 0, 'lines the build had read were appended again');
  assert.equal(next.fromCache, true);
  assert.equal(next.appended, 3);
  assert.equal(idDuplicates(next), 0, 'an entry stands twice');
  assert.equal(duplicates(docsOf(next)), 0);
  assert.deepEqual([...docsOf(next)].sort(), [...truth(root)].sort(), 'the loaded documents are the ones of a fresh build');
  // control: the race was real, i.e. the file did hold the late lines the stat had not seen
  assert.ok(docsOf(next).length >= 40 + 5 + 3);
});

test('(b) a write after the build read the file, then one more: the lines of later entries are right', (t) => {
  const root = world(t);
  const { mid, next, k } = scene(search, root, 'after');
  assert.equal(mid.fromCache, true);
  assert.equal(mid.appended, k, 'the lines written after the read are appended, once');
  assert.equal(next.fromCache, true);
  assert.equal(next.appended, k + 3, 'the cache is not rewritten by a small append: the stack counts from the build');
  assert.equal(idDuplicates(next), 0);
  const byId = new Map(truth(root).map((k) => [k.split(':').slice(2).join(':'), k]));
  for (const k of docsOf(next)) {
    const id = k.split(':').slice(2).join(':');
    assert.equal(byId.get(id), k, `entry ${id} carries the wrong source:line`);
  }
  assert.equal(next.documents.length, truth(root).length, 'nothing missing');
});

test('(c) a log written for the first time during the build is not read again as new', (t) => {
  const root = world(t);
  // the first duty ever: its file does not exist when the stat is taken, and the build reads the duty log AFTER the learnings
  // log (the order of memory.SEARCH_TYPES), i.e. after the writer ran
  assert.ok(memory.SEARCH_TYPES.indexOf('duty') > memory.SEARCH_TYPES.indexOf('learning'), 'the scene needs this order');
  const learnings = memory.logPath(root, 'learning', null);
  writerAtRead(learnings, 'before', () => {
    for (let i = 0; i < 4; i += 1) memory.logEntry(root, 'duty', { title: `duty ${i} relay`, text: `to do ${i}` });
  }, () => search.loadIndex(root, { fresh: true }));
  assert.ok(fs.existsSync(memory.logPath(root, 'duty', null)), 'control: the writer made the new log');
  const next = search.loadIndex(root, {});
  assert.equal(idDuplicates(next), 0, 'the new log was indexed twice');
  assert.deepEqual([...docsOf(next)].sort(), [...truth(root)].sort());
  assert.ok(docsOf(next).some((k) => k.startsWith('global/duties.jsonl:')), 'control: the new log is in the index');
});

test('(c2) the recorded line count is the count of the lines read, with or without a final newline', (t) => {
  for (const ending of ['\n', '']) {
    const root = tempDir('cm-index-snapshot-lines-', t);
    cfg.writeConfig(root, cfg.DEFAULT_CONFIG);
    const file = memory.logPath(root, 'learning', null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = (i) => JSON.stringify({ id: `ln${i}`, ts: '2026-01-01T00:00:00.000Z', type: 'learning', title: `line ${i} relay`, text: `row ${i}` });
    fs.writeFileSync(file, `${[row(1), row(2), row(3)].join('\n')}${ending}`);
    search.loadIndex(root, { fresh: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, search.CACHE_DIR, 'manifest.json'), 'utf8'));
    const rec = manifest.files[memory.asSource(root, file)];
    assert.equal(rec.lines, 3, `lines with ${ending ? 'a' : 'no'} final newline`);
    assert.equal(rec.bytes, fs.statSync(file).size);
  }
});

test('(d) assertCacheLanded: a later build is fine, a miss in the gap of a swap is read once more, a missing cache still throws', (t) => {
  const root = world(t);
  const built = search.loadIndex(root, { fresh: true });
  const dir = path.join(root, search.CACHE_DIR);
  const n = built.N;
  let pauses = 0;
  const pause = () => { pauses += 1; };
  // 1. the cache holds a build with MORE documents than the one this child made (a second builder swapped a later one in)
  assert.doesNotThrow(() => search.assertCacheLanded(root, 'en', n - 3, { pause }));
  assert.equal(pauses, 0, 'a good cache is not waited for');
  // 2. exactly ours
  assert.doesNotThrow(() => search.assertCacheLanded(root, 'en', n, { pause }));
  // 3. an EARLIER build than the one just made is still a failure (after the second look)
  assert.throws(() => search.assertCacheLanded(root, 'en', n + 5, { pause }), /not the/);
  assert.equal(pauses, 1, 'one more look, not a loop');
  // 4. the gap: no manifest at the first look, the swap done at the second
  const parked = `${dir}.parked`;
  fs.renameSync(dir, parked);
  pauses = 0;
  assert.doesNotThrow(() => search.assertCacheLanded(root, 'en', n, { pause: () => { pauses += 1; fs.renameSync(parked, dir); } }));
  assert.equal(pauses, 1);
  // 5. no cache at all: still an error
  fs.rmSync(dir, { recursive: true, force: true });
  assert.throws(() => search.assertCacheLanded(root, 'en', n, { pause }), /did not land/);
});

function staleOf(root) {
  return fs.readdirSync(path.join(root, '.mem')).filter((x) => x.includes('.stale.'));
}

function smallIndex(root) {
  return search.buildIndex(root);
}

/** One writeIndexCache in which "another writer" lands its cache between our two renames (what two builders at once do). */
function lostRace(mod, root) {
  const cacheDir = path.join(root, search.CACHE_DIR);
  const index = smallIndex(root);
  const real = fs.renameSync;
  fs.renameSync = function patched(from, to, ...rest) {
    const out = real.call(this, from, to, ...rest);
    if (String(to).includes('.stale.')) {
      // the other writer: its own finished cache stands at the cache's name before our second rename
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{"other":"writer"}');
    }
    return out;
  };
  try { mod.writeIndexCache(cacheDir, { version: search.CACHE_VERSION, language: index.language, files: {}, fullAt: index.N, index }); } finally { fs.renameSync = real; }
  return cacheDir;
}

test('(e) two writers at once: the lost one leaves no parked cache behind; the next swap removes old leftovers and only those', (t) => {
  const root = world(t, 10);
  search.loadIndex(root, { fresh: true });
  const cacheDir = lostRace(indexcache, root);
  assert.deepEqual(staleOf(root), [], 'the lost writer left its parked cache');
  assert.equal(fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8'), '{"other":"writer"}', 'the other writer\'s cache stands');
  assert.deepEqual(fs.readdirSync(path.join(root, '.mem')).filter((x) => x.endsWith('.tmp')), [], 'no scratch directory left');

  // leftovers of writers that died between the two renames
  const mem = path.join(root, '.mem');
  const left = path.join(mem, 'search-index.stale.4242.abc123');
  const foreign = path.join(mem, 'other-cache.stale.4242.abc123');
  const odd = path.join(mem, 'search-index.stale.notes');
  for (const d of [left, foreign, odd]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'x'), 'x'); }
  // a young one is left alone
  assert.equal(indexcache.sweepStaleLeftovers(cacheDir), 0);
  assert.ok(fs.existsSync(left), 'a fresh parked cache is a live writer\'s');
  // the same by the clock of a swap an hour later
  assert.equal(indexcache.sweepStaleLeftovers(cacheDir, { now: Date.now() + 60 * 60 * 1000 }), 1);
  assert.equal(fs.existsSync(left), false, 'an old leftover of this cache is removed');
  assert.ok(fs.existsSync(foreign), 'another cache\'s leftover is not ours');
  assert.ok(fs.existsSync(odd), 'a name that is not the parking pattern is not ours');

  // and the swap itself does it: a leftover older than the bound goes when the next cache lands
  fs.mkdirSync(left); fs.writeFileSync(path.join(left, 'x'), 'x');
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60 * 1000;
  try {
    const index = smallIndex(root);
    indexcache.writeIndexCache(cacheDir, { version: search.CACHE_VERSION, language: index.language, files: {}, fullAt: index.N, index });
  } finally { Date.now = realNow; }
  assert.equal(fs.existsSync(left), false, 'the swap did not sweep');
  assert.ok(fs.existsSync(foreign));
  assert.deepEqual(staleOf(root).filter((x) => x.startsWith('search-index.')), ['search-index.stale.notes'], 'the swap leaves no parked cache of its own behind');
});

test('(f) RED PROOF at the base: the same scenes give the old behaviour (probe positive control: the new tree is the other way)', async (t) => {
  const old = tempDir('cm-index-snapshot-base-', t);
  exportCommit(REPO, BASE, ['bin', 'src', 'package.json'], old);
  const oldSearch = await import(pathToFileURL(path.join(old, 'src', 'search.mjs')).href);
  const oldCache = await import(pathToFileURL(path.join(old, 'src', 'indexcache.mjs')).href);
  assert.equal(oldCache.sweepStaleLeftovers, undefined, 'the base already has the sweep');

  // (a) at the base: entries stand twice
  const rootA = world(t);
  const { next: nextA } = scene(oldSearch, rootA, 'before');
  assert.ok(idDuplicates(nextA) > 0, 'base: no entry twice (the scene does not bite)');
  assert.equal(idDuplicates(scene(search, world(t), 'before').next), 0, 'new tree: none');

  // (b) at the base: the lines of later entries are off
  const rootB = world(t);
  const { next: nextB } = scene(oldSearch, rootB, 'after');
  const wanted = new Map(truth(rootB).map((k) => [k.split(':').slice(2).join(':'), k]));
  const off = docsOf(nextB).filter((k) => wanted.get(k.split(':').slice(2).join(':')) !== k);
  assert.ok(off.length > 0, 'base: all lines right (the scene does not bite)');

  // (e) at the base: the lost writer's parked cache stays
  const rootE = world(t, 10);
  oldSearch.loadIndex(rootE, { fresh: true });
  lostRace(oldCache, rootE);
  assert.ok(staleOf(rootE).length > 0, 'base: no parked cache left (the scene does not bite)');
});

test('code guard: the full build takes its state from the snapshot of its own reads', () => {
  const code = fs.readFileSync(path.join(REPO, 'src', 'search.mjs'), 'utf8');
  assert.match(code, /const index = buildIndex\(root, \{ language, snapshot \}\);/);
  assert.match(code, /stateOf\(now, null, sourceDocCounts\(index\.documents\), snapshot\)/);
  assert.match(code, /if \(snapshot\) snapshot\.logs\.set\(/);
});
