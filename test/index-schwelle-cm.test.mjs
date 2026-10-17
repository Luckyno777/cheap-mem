// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// index-schwelle-cm (2026-10-17), port of the sibling house's `abruf-nachtrag-schwelle-lm`: the stack of lines the recall hook
// appends to the cached search index has an ABSOLUTE bound, and the rebuild past it runs in the background, one at a time.
// Part 3 of the order (#25): `mem correction` no longer builds the whole index cold.
//
// The finding. The hook (`mem find --recall`) loads the cache and appends the lines written since the last full build. That
// costs about 0.5 ms per line in every hook process, and the rebuild came only at a fifth of the corpus, inside the
// asking process (and the hook's 5 s cap). At 7,000 entries a fifth is 1,400 lines. `mem correction` did not use the cache
// at all: `search.buildIndex(root)` read and tokenised the whole memory cold, once per correction, for one
// document-frequency table.
//
// Everything is checked through STATES (counts of appended lines, the lock and the note of the rebuild, the cache's own
// numbers, counts of children started, the process's count of full builds), never through a duration.
//
//   (a) the rule as a table
//   (b) the hook's cache path: at the bound appended, one line above `stale` and the rebuild started
//   (c) the terminal keeps its fifth: no `stale`, no lock, no background child
//   (d) effect: after the background rebuild the stack is empty, the hook builds nothing in its own process
//   (e) two processes asking at the same moment start exactly ONE child
//   (f) a lock whose child died is taken over by age; a fresh one is respected
//   (g) after a failed rebuild no child is started for a while; after a good one or an old failure it is
//   (h) end to end: `mem find --recall` answers from the stack and has the rebuild done; `mem find` does not
//   (i) part 3: `mem correction` loads the cache instead of building cold
//   (j) red proof: the same scenes at the pinned base
//
// Windows: temp dirs from `os.tmpdir()` via tempDir, `process.execPath` for children, `file:` URLs for imports, no POSIX tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as cfg from '../src/config.mjs';
import * as shell from '../src/cli/shell.mjs';
import { COMMANDS as WRITE } from '../src/cli/commands/write.mjs';
import * as indexrebuild from '../src/indexrebuild.mjs';
import { tryLock } from '../src/filelock.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
// The base of this work (origin/agent/k1-teilwort-cm), FIXED: never a moving merge-base (the probe would turn red by itself).
const BASE = '71be9cfe0a269932fd1c51bd889f5ea378b745ad';
const BOUND = search.REBUILD_AFTER_APPENDED ?? 100;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

/** Entries the memory holds before the first full build: a fifth of it lies ABOVE the bound (else the probes tell nothing). */
const BASIS_N = Math.ceil(BOUND / (search.REBUILD_AFTER_FRACTION ?? 0.2)) + 100;

function world(t, n = BASIS_N) {
  const root = tempDir('cm-index-schwelle-', t);
  cfg.writeConfig(root, cfg.DEFAULT_CONFIG);
  for (let i = 0; i < n; i += 1) {
    memory.logEntry(root, i % 4 ? 'learning' : 'decision', i % 4
      ? { title: `learning ${i} tunnel relay uniq${i}`, text: `about step ${i % 31} of the deploy, tag t${i % 7}` }
      : { topic: `topic ${i}`, choice: `chose approach ${i}`, why: `because of reason${i} shared` });
  }
  search.loadIndex(root, { fresh: true });   // the full build, the cache lies on disk
  return root;
}

function append(root, count, from = 0) {
  for (let i = 0; i < count; i += 1) {
    memory.logEntry(root, 'learning', { title: `late ${from + i} zebrafish`, text: `appended after the build, number ${from + i}` });
  }
}

const lockOf = (root) => path.join(root, indexrebuild.REBUILD_LOCK_PATH);
const noteOf = (root) => path.join(root, indexrebuild.REBUILD_NOTE_PATH);
const readNote = (root) => { try { return JSON.parse(fs.readFileSync(noteOf(root), 'utf8')); } catch { return null; } };
const idle = (root) => assert.equal(indexrebuild.waitForIndexRebuildIdle(root, 60000), true, 'the background rebuild did not end');

/** The stand-in for the child: counts its start, hangs until the release file exists, then lets go of the lock. */
const FAKE_CHILD = `const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.argv[1], 'starts.log'), 'x\\n');
const release = path.join(process.argv[1], 'release');
const end = Date.now() + 60000;
const t = setInterval(() => {
  if (fs.existsSync(release) || Date.now() > end) { clearInterval(t); try { fs.rmSync(process.argv[3], { force: true }); } catch {} }
}, 20);`;
const starts = (root) => { try { return fs.readFileSync(path.join(root, 'starts.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const release = (root) => fs.writeFileSync(path.join(root, 'release'), 'x');
async function warteBis(f, ms = 20000) {
  const bis = Date.now() + ms;
  while (!f() && Date.now() < bis) await warte(20);
  return f();
}

// --- (a) the rule -------------------------------------------------------------------------------------

test('(a) appendedTooMany: the smaller of a fifth and the absolute bound, exactly at the edge', () => {
  assert.equal(typeof search.REBUILD_AFTER_APPENDED, 'number');
  assert.equal(typeof search.appendedTooMany, 'function');
  // a big memory: the absolute bound counts
  assert.equal(search.appendedTooMany(6000, 6000 + BOUND), false);
  assert.equal(search.appendedTooMany(6000, 6000 + BOUND + 1), true);
  // a small one keeps its fifth (60 of 300)
  assert.equal(search.appendedTooMany(300, 360), false);
  assert.equal(search.appendedTooMany(300, 361), true);
  // nothing appended: never
  assert.equal(search.appendedTooMany(6000, 6000), false);
  // `absolute: false` (the terminal): only the fifth
  assert.equal(search.appendedTooMany(6000, 6000 + 500, { absolute: false }), false);
  assert.equal(search.appendedTooMany(6000, 7201, { absolute: false }), true);
  // the bound is a real improvement on a fifth of a memory of the size seen in the field
  assert.ok(BOUND <= 150 && BOUND < 7000 * search.REBUILD_AFTER_FRACTION / 5, `bound ${BOUND} improves nothing on a fifth of 7,000`);
});

// --- (b) the hook's cache path -------------------------------------------------------------------------

test('(b) hook: at the bound appended and answered; one line above it `stale` and the rebuild started', (t) => {
  const root = world(t);
  append(root, BOUND);
  const at = search.loadIndex(root, { allowStale: true });
  assert.equal(at.fromCache, true);
  assert.equal(at.appended, BOUND, 'the scene does not produce the stack it names');
  assert.equal(at.stale, undefined, 'at the bound nothing is due yet');
  assert.equal(fs.existsSync(lockOf(root)), false);

  append(root, 1, BOUND);
  const builds = search.fullBuildCount();
  const over = search.loadIndex(root, { allowStale: true });
  assert.equal(over.fromCache, true, 'the hook rebuilt in its own process');
  assert.equal(over.appended, BOUND + 1, 'the stack is answered from, all of it');
  assert.equal(over.stale, 'appended-too-many');
  assert.equal(over.rebuild, 'started');
  assert.equal(search.fullBuildCount(), builds, 'a full build ran in the asking process');
  // the appended line is findable right now
  assert.ok(search.search(over, 'zebrafish', { top: 3 }).length > 0);
  idle(root);
});

// --- (c) the terminal -----------------------------------------------------------------------------------

test('(c) terminal (no allowStale): the fifth counts; above the bound nothing stale, no lock, no child; above a fifth it builds in-process', (t) => {
  const root = world(t);
  const fifth = Math.floor(BASIS_N * (search.REBUILD_AFTER_FRACTION ?? 0.2));
  assert.ok(fifth > BOUND + 1, 'the scene needs a fifth above the bound');
  append(root, BOUND + 1);
  const cli = search.loadIndex(root, {});
  assert.equal(cli.fromCache, true);
  assert.equal(cli.appended, BOUND + 1);
  assert.equal(cli.stale, undefined);
  assert.equal(fs.existsSync(lockOf(root)), false, 'the terminal started a background rebuild');
  assert.equal(readNote(root), null);
  // positive control: past a fifth the terminal rebuilds, in its own process, as before
  append(root, fifth, BOUND + 1);
  const builds = search.fullBuildCount();
  const full = search.loadIndex(root, {});
  assert.equal(full.fromCache, false);
  assert.equal(search.fullBuildCount(), builds + 1);
});

// --- (d) effect ------------------------------------------------------------------------------------------

test('(d) EFFECT: after the background rebuild the stack is empty, the cache carries the new count, the hook builds nothing', (t) => {
  const root = world(t);
  append(root, BOUND + 1);
  const first = search.loadIndex(root, { allowStale: true });
  assert.equal(first.rebuild, 'started');
  idle(root);
  assert.equal(readNote(root)?.ok, true, 'the child left no note of a good end');
  const builds = search.fullBuildCount();
  const after = search.loadIndex(root, { allowStale: true });
  assert.equal(after.fromCache, true);
  assert.equal(after.appended, 0, 'the stack is not empty after the rebuild');
  assert.equal(after.stale, undefined);
  assert.equal(after.N, first.N);
  assert.equal(search.fullBuildCount(), builds);
  // the cache's own number: the full build now stands at the new count
  const manifest = JSON.parse(fs.readFileSync(path.join(root, search.CACHE_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.fullAt, first.N);
  // and a second question finds nothing to start
  assert.equal(fs.existsSync(lockOf(root)), false);
});

// --- (e) two processes at once ----------------------------------------------------------------------------

test('(e) two processes ask at the same moment: exactly one child', async (t) => {
  const root = tempDir('cm-index-schwelle-lock-', t);
  const asker = `const fs = require('node:fs'); const path = require('node:path');
const root = process.argv[1]; const me = process.argv[2];
fs.writeFileSync(path.join(root, 'ready-' + me), 'x');
const end = Date.now() + 30000;
while (!fs.existsSync(path.join(root, 'go')) && Date.now() < end) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'indexrebuild.mjs')).href)}).then((m) => {
  const r = m.kickIndexRebuild(root, { childScript: ${JSON.stringify(FAKE_CHILD)} });
  fs.writeFileSync(path.join(root, 'result-' + me), r);
});`;
  const run = (me) => new Promise((resolve) => {
    const k = spawn(process.execPath, ['-e', asker, root, me], { stdio: 'ignore' });
    k.once('exit', (status) => resolve(status));
  });
  const both = Promise.all([run('a'), run('b')]);
  assert.ok(await warteBis(() => fs.existsSync(path.join(root, 'ready-a')) && fs.existsSync(path.join(root, 'ready-b'))), 'the askers are not ready');
  fs.writeFileSync(path.join(root, 'go'), 'x');
  const [sa, sb] = await both;
  assert.equal(sa, 0);
  assert.equal(sb, 0);
  const results = ['a', 'b'].map((me) => fs.readFileSync(path.join(root, `result-${me}`), 'utf8')).sort();
  assert.deepEqual(results, ['running', 'started'], 'the probe does not produce two askers');
  assert.ok(await warteBis(() => starts(root) >= 1), 'no child started');
  await warte(400);   // a grace for an (unwanted) second start; a late one would only colour the probe green
  assert.equal(starts(root), 1, 'two askers, more than one child');
  assert.equal(fs.existsSync(lockOf(root)), true, 'the lock is gone while the child still runs');
  release(root);
  assert.ok(await warteBis(() => !fs.existsSync(lockOf(root))), 'the lock stays after the child ended');
  idle(root);
});

// --- (f) an orphaned lock ------------------------------------------------------------------------------------

test('(f) a lock older than the age bound is taken over; a fresh one is respected (positive control)', async (t) => {
  const root = tempDir('cm-index-schwelle-orphan-', t);
  fs.mkdirSync(path.dirname(lockOf(root)), { recursive: true });
  assert.equal(tryLock(lockOf(root)), true);
  // fresh: someone is at work
  assert.equal(indexrebuild.kickIndexRebuild(root, { childScript: FAKE_CHILD }), 'running');
  await warte(150);
  assert.equal(starts(root), 0, 'a child started although a fresh lock stood');
  // the owner died: the lock is older than the bound
  const old = new Date(Date.now() - (indexrebuild.REBUILD_LOCK_MAX_AGE_S + 60) * 1000);
  fs.utimesSync(lockOf(root), old, old);
  assert.equal(indexrebuild.rebuildRunning(root), false);
  assert.equal(indexrebuild.kickIndexRebuild(root, { childScript: FAKE_CHILD }), 'started');
  assert.ok(await warteBis(() => starts(root) === 1), 'no child after the takeover');
  release(root);
  assert.ok(await warteBis(() => !fs.existsSync(lockOf(root))));
  idle(root);
});

// --- (g) backoff --------------------------------------------------------------------------------------------

test('(g) after a failed rebuild a while of no child; an old failure or a good end does not hold it back', async (t) => {
  const root = tempDir('cm-index-schwelle-backoff-', t);
  const note = (ok, ageS) => {
    fs.mkdirSync(path.dirname(noteOf(root)), { recursive: true });
    fs.writeFileSync(noteOf(root), JSON.stringify({ at: new Date(Date.now() - ageS * 1000).toISOString(), ok, ...(ok ? {} : { error: 'boom' }) }));
  };
  note(false, 5);
  assert.equal(indexrebuild.failedRecently(root), true);
  assert.equal(indexrebuild.kickIndexRebuild(root, { childScript: FAKE_CHILD }), 'backoff');
  await warte(150);
  assert.equal(starts(root), 0);
  assert.equal(fs.existsSync(lockOf(root)), false, 'a backoff left a lock behind');
  note(true, 5);
  assert.equal(indexrebuild.failedRecently(root), false);
  note(false, indexrebuild.REBUILD_BACKOFF_S + 60);
  assert.equal(indexrebuild.failedRecently(root), false);
  assert.equal(indexrebuild.kickIndexRebuild(root, { childScript: FAKE_CHILD }), 'started');
  assert.ok(await warteBis(() => starts(root) === 1));
  release(root);
  assert.ok(await warteBis(() => !fs.existsSync(lockOf(root))));
  idle(root);
});

// --- (h) end to end through the command line ---------------------------------------------------------------------

test('(h) `mem find --recall` answers from the stack and has the rebuild done; a plain `mem find` does not', (t) => {
  const root = world(t);
  append(root, BOUND + 1);
  const env = { ...process.env, CHEAP_MEM_ROOT: root };
  delete env.MEM_HOOK_OFF;
  const find = (...flags) => spawnSync(process.execPath, [MEM, 'find', 'zebrafish', '--top', '3', ...flags], { env, encoding: 'utf8', timeout: 60000 });

  const plain = find();
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(plain.stdout.includes('zebrafish'), plain.stdout.slice(0, 300));
  indexrebuild.waitForIndexRebuildIdle(root, 5000);
  assert.equal(readNote(root), null, 'a plain `mem find` had the rebuild started');

  const hook = find('--recall');
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(hook.stdout.includes('zebrafish'), 'the hook did not answer from the stack');
  // the answer says nothing about a stale index: it is current in content (the stack is counted in)
  assert.equal(/rebuild|stale|older|before the last/i.test(hook.stdout), false, hook.stdout.slice(0, 300));
  assert.ok(indexrebuild.waitForIndexRebuildIdle(root, 60000));
  // the child ran: it leaves a note of a good end, and the cache stands at the new count
  assert.equal(readNote(root)?.ok, true, 'the hook started no rebuild');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, search.CACHE_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.fullAt, BASIS_N + BOUND + 1);
});

// --- (i) part 3: the correction -----------------------------------------------------------------------------------

/** Silence and collect stderr until the returned function is called (it hands back what was written). */
function listenStderr() {
  const prior = process.stderr.write;
  let seen = '';
  process.stderr.write = (chunk) => { seen += String(chunk); return true; };
  return () => { process.stderr.write = prior; return seen; };
}

async function correct(root, oldId, i, { stderr = null } = {}) {
  const done = listenStderr();
  try {
    await shell.captureOutput(() => WRITE.correction({ rest: ['learning', oldId], args: { root, title: `corrected ${i} relay`, text: `new text ${i}` } }));
  } finally {
    const seen = done();
    if (stderr) stderr.text = seen;
  }
}
const lastLearningId = (root) => {
  const lines = fs.readFileSync(path.join(root, 'global', 'learnings.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]).id;
};

test('(i) `mem correction` takes the index from the cache: no full build in its process, also with a stack above the bound', async (t) => {
  const root = world(t);
  const builds = search.fullBuildCount();
  await correct(root, lastLearningId(root), 1);
  await correct(root, lastLearningId(root), 2);
  assert.equal(search.fullBuildCount(), builds, 'a correction built the whole index');
  // above the bound: still no build in the writer; the rebuild goes to the background
  append(root, BOUND + 1);
  await correct(root, lastLearningId(root), 3);
  assert.equal(search.fullBuildCount(), builds, 'a correction above the bound built the whole index');
  idle(root);
  assert.equal(readNote(root)?.ok, true, 'the stack above the bound had no rebuild started');
});

test('(i2) the correction still warns about a rare word it drops (the guard is not lost on the cached index)', async (t) => {
  const root = world(t);
  memory.logEntry(root, 'learning', { title: 'quokkaword is the rare thing', text: 'only this entry names quokkaword' });
  search.loadIndex(root, { fresh: true });
  const warned = {};
  await correct(root, lastLearningId(root), 1, { stderr: warned });
  const seen = warned.text;
  assert.ok(/quokkaword/.test(seen), `no warning about the dropped rare word: ${seen}`);
});

// --- (j) red proof against the pinned base -------------------------------------------------------------------------

test('(j) RED PROOF at the base: the same scenes give the old behaviour (probe positive control: the new tree is the other way)', async (t) => {
  const old = tempDir('cm-index-schwelle-base-', t);
  exportCommit(REPO, BASE, ['bin', 'src', 'package.json'], old);
  const oldSearch = await import(pathToFileURL(path.join(old, 'src', 'search.mjs')).href);
  const oldWrite = await import(pathToFileURL(path.join(old, 'src', 'cli', 'commands', 'write.mjs')).href);
  const oldShell = await import(pathToFileURL(path.join(old, 'src', 'cli', 'shell.mjs')).href);
  const oldIndexrebuild = fs.existsSync(path.join(old, 'src', 'indexrebuild.mjs'));
  assert.equal(oldIndexrebuild, false, 'the base already has the rebuild module');
  assert.equal(oldSearch.appendedTooMany, undefined, 'the base already has the bound');

  // 1. the hook above the bound: the base appends silently, no marker, no child -- and nothing ever rebuilds it
  const root = world(t);
  append(root, BOUND + 1);
  const hookAtBase = oldSearch.loadIndex(root, { allowStale: true });
  assert.equal(hookAtBase.appended, BOUND + 1);
  assert.equal(hookAtBase.stale, undefined, 'base: the stack above the bound is flagged');
  assert.equal(fs.existsSync(lockOf(root)), false);
  assert.equal(readNote(root), null);
  const hookNow = search.loadIndex(root, { allowStale: true });
  assert.equal(hookNow.stale, 'appended-too-many', 'new tree: the same stack is flagged');
  idle(root);

  // 2. the correction at the base builds cold and never touches the cache: on a memory nobody has searched there is no cache after
  const bare = tempDir('cm-index-schwelle-bare-', t);
  cfg.writeConfig(bare, cfg.DEFAULT_CONFIG);
  for (let i = 0; i < 30; i += 1) memory.logEntry(bare, 'learning', { title: `learning ${i} relay`, text: `step ${i}` });
  const done = listenStderr();
  try {
    await oldShell.captureOutput(() => oldWrite.COMMANDS.correction({ rest: ['learning', lastLearningId(bare)], args: { root: bare, title: 'c relay', text: 't' } }));
  } finally { done(); }
  assert.equal(fs.existsSync(path.join(bare, search.CACHE_DIR)), false, 'base: a correction left a cache (it used to build cold)');
  await correct(bare, lastLearningId(bare), 1);
  assert.equal(fs.existsSync(path.join(bare, search.CACHE_DIR, 'manifest.json')), true, 'new tree: the correction goes through the cache');
});
