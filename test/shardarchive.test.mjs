// shardarchive.test.mjs — P17: a clone without the archive must never
// answer with a silent nothing.
//
// Four tests, matching the build plan's own list:
//   1. POSITIVE CONTROL — a full clone (archive present, reachable)
//      answers exactly as it does today.
//   2. THE REAL PROBE — a clone with the archive absent answers with a
//      signposted redirect, and the redirect names where the material
//      is and how to reach it (asserted on content, not just presence).
//   3. SABOTAGE — an archived shard made unreachable must report the
//      THIRD state, never "nothing found". Proven by hand: a
//      deliberately-broken resolveEntry is shown RED first (returns a
//      silent "not found" instead of the third state), then the real
//      code is shown GREEN.
//   4. SIZE — a fresh clone's size with and without the archived
//      shards, both numbers reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as memory from '../src/memory.mjs';
import * as archive from '../src/archive.mjs';
import * as cfg from '../src/config.mjs';
import * as shardarchive from '../src/shardarchive.mjs';
import { buildCorpus } from '../bench/atlas/core.mjs';

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-'));
  cfg.writeConfig(r, cfg.DEFAULT_CONFIG);
  return r;
}

/** N learning entries, oldest first, so `archiveOldest` has something to move. */
function seedLearnings(root, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const e = memory.logEntry(root, 'learning', { title: `lesson ${i}`, text: `what to do differently at step ${i}` });
    ids.push(e.entry.id);
  }
  return ids;
}

// ---------------------------------------------------------------------
// 1. POSITIVE CONTROL
// ---------------------------------------------------------------------

test('POSITIVE CONTROL: an entry never archived resolves exactly as memory.getEntry would', () => {
  const root = tmpRoot();
  const ids = seedLearnings(root, 5);
  const direct = memory.getEntry(root, ids[2]);
  const wrapped = shardarchive.resolveEntry(root, ids[2]);
  assert.equal(wrapped.state, shardarchive.PASS);
  assert.equal(wrapped.source, 'live');
  assert.deepEqual(wrapped.entry, direct);
});

test('POSITIVE CONTROL: a full clone (archive present and reachable) answers an archived id with the real entry', () => {
  const root = tmpRoot();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-store-'));
  archive.setLocation(root, store);
  const ids = seedLearnings(root, 6);

  const before = memory.getEntry(root, ids[0]);
  const moved = shardarchive.archiveOldest(root, 'learning', { count: 4 });
  assert.equal(moved.archived, 4);

  // The moved id is gone from the tracked file (this is the whole point
  // of the move) but the wrapped resolver still answers it, correctly.
  assert.equal(memory.getEntry(root, ids[0]), null, 'still in the tracked file — nothing was actually moved');
  const resolved = shardarchive.resolveEntry(root, ids[0]);
  assert.equal(resolved.state, shardarchive.PASS);
  assert.equal(resolved.source, 'archive');
  assert.equal(resolved.entry.title, before.title);
  assert.equal(resolved.entry.text, before.text);
  assert.equal(resolved.entry._archived, true);

  // And an id that stayed young (never archived) still resolves live,
  // unaffected by the archive existing at all.
  const stillLive = shardarchive.resolveEntry(root, ids[5]);
  assert.equal(stillLive.state, shardarchive.PASS);
  assert.equal(stillLive.source, 'live');
});

test('POSITIVE CONTROL: findWithArchiveNotice matches memory.find with no notice when the archive is fully reachable', () => {
  const root = tmpRoot();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-store-'));
  archive.setLocation(root, store);
  seedLearnings(root, 5);
  shardarchive.archiveOldest(root, 'learning', { count: 3 });

  const direct = memory.find(root, 'step 0');
  const wrapped = shardarchive.findWithArchiveNotice(root, 'step 0');
  assert.equal(wrapped.notice, null);
  assert.equal(wrapped.state, shardarchive.PASS);
  // Everything memory.find alone can see is still in there...
  for (const h of direct) assert.ok(wrapped.hits.some((w) => w.id === h.id));
  // ...plus the archived hit memory.find alone CANNOT see any more.
  assert.ok(wrapped.hits.some((h) => h._archived && h.text?.includes('step 0')));
});

// ---------------------------------------------------------------------
// 2. THE REAL PROBE: archive absent
// ---------------------------------------------------------------------

test('THE REAL PROBE: archive absent -> resolveEntry redirects, naming where the material is and how to reach it', () => {
  const root = tmpRoot();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-store-'));
  archive.setLocation(root, store);
  const ids = seedLearnings(root, 4);
  // The exact raw line, byte for byte, before it gets moved — used
  // below to prove the redirect's coordinates are the real ones, not
  // just plausible-looking numbers.
  const rawLineBefore = fs.readFileSync(memory.logPath(root, 'learning'), 'utf8')
    .split('\n').filter((l) => l.trim())[0];
  shardarchive.archiveOldest(root, 'learning', { count: 4 });

  // A clone WITHOUT the archive: the same manifest travels (it is
  // tracked), but the shard directory never arrived.
  fs.rmSync(store, { recursive: true, force: true });

  const result = shardarchive.resolveEntry(root, ids[0]);
  assert.equal(result.state, shardarchive.NOT_MEASURED, 'must be the third state, not FAIL and not silent PASS-with-nothing');
  assert.equal(result.entry, undefined, 'a not-measured result must not also hand back a (fabricated) entry');

  // Assert on the REDIRECT'S CONTENT, not just its presence.
  assert.ok(result.redirect, 'no redirect at all is exactly the silent nothing this build point forbids');
  assert.equal(result.redirect.id, ids[0]);
  assert.equal(typeof result.redirect.shard, 'string');
  assert.ok(result.redirect.shard.length > 0);
  assert.equal(typeof result.redirect.offset, 'number');
  assert.equal(typeof result.redirect.length, 'number');
  assert.match(result.redirect.expectedPath, /shards[/\\]/);
  assert.match(result.reason, /archived/);
  assert.match(result.reason, /unreachable/);
  assert.match(result.redirect.howTo, /CHEAP_MEM_ARCHIVE|archive\.json/);

  // Sanity: the redirect's coordinates are the REAL ones — hand-writing
  // exactly the bytes it named (nothing else) makes the same id resolve
  // again, checksum and all. This is the "disk came back" case.
  const shardFile = path.join(store, shardarchive.SHARD_SUBDIR, result.redirect.shard);
  fs.mkdirSync(path.dirname(shardFile), { recursive: true });
  fs.writeFileSync(shardFile, `${rawLineBefore}\n`);
  const again = shardarchive.resolveEntry(root, ids[0]);
  assert.equal(again.state, shardarchive.PASS, 'once the archive is reachable again the same id must resolve');
  assert.equal(again.entry.id, ids[0]);
});

test('THE REAL PROBE: archive absent -> findWithArchiveNotice keeps live hits and names the gap explicitly', () => {
  const root = tmpRoot();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-store-'));
  archive.setLocation(root, store);
  seedLearnings(root, 5);
  shardarchive.archiveOldest(root, 'learning', { count: 3 });
  fs.rmSync(store, { recursive: true, force: true });

  const result = shardarchive.findWithArchiveNotice(root, 'step');
  assert.notEqual(result.state, shardarchive.PASS, 'reporting PASS while 3 entries went unsearched is the silent-nothing failure mode');
  assert.ok(result.hits.length > 0, 'the live (young) hits must still come back, never withheld');
  assert.ok(result.notice, 'no notice at all is indistinguishable from "there was nothing else"');
  assert.match(result.notice, /3 archived/);
  assert.match(result.notice, new RegExp(shardarchive.MANIFEST_FILE.replace('.', '\\.')));
  assert.match(result.notice, /incomplete/);
});

// ---------------------------------------------------------------------
// 3. SABOTAGE, verified by hand: a silent "not found" must turn this RED
// ---------------------------------------------------------------------

test('SABOTAGE: an unreachable archived shard must report NOT_MEASURED, never a silent "not found"', () => {
  const root = tmpRoot();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-store-'));
  archive.setLocation(root, store);
  const ids = seedLearnings(root, 3);
  shardarchive.archiveOldest(root, 'learning', { count: 3 });

  // Sabotage: the shard file itself goes missing (disk yanked), while
  // the manifest — tracked, in every clone — still names it.
  const row = shardarchive.readManifest(root).find((r) => r.id === ids[0]);
  assert.ok(row, 'setup broken: the manifest never recorded this id');
  fs.rmSync(path.join(store, shardarchive.SHARD_SUBDIR, row.shard));

  // --- RED: a plausible but wrong implementation, swapped in by hand ---
  // This is what `resolveEntry` would do if it swallowed the read error
  // and fell through to "no such id" instead of reporting the third
  // state — the exact bug this build point exists to rule out.
  function brokenResolveEntry(r, id) {
    const live = memory.getEntry(r, id);
    if (live) return { state: shardarchive.PASS, entry: live, source: 'live' };
    const manifestRow = shardarchive.readManifest(r).find((x) => x.id === id);
    if (!manifestRow) return { state: shardarchive.FAIL, reason: 'not found' };
    try {
      // (imagine a working read here) — sabotaged, so this throws...
      fs.readFileSync(path.join(store, shardarchive.SHARD_SUBDIR, manifestRow.shard));
      return { state: shardarchive.PASS, entry: {}, source: 'archive' };
    } catch {
      // ...and the bug: swallow it and report the SAME shape as
      // "genuinely does not exist". This is the silent nothing.
      return { state: shardarchive.FAIL, reason: 'not found' };
    }
  }
  const red = brokenResolveEntry(root, ids[0]);
  assert.equal(red.state, shardarchive.FAIL, 'sanity: the broken version really does collapse to FAIL/"not found"');
  assert.equal(red.reason, 'not found');
  // The real assertion a caller would make against the broken version —
  // this is the RED this probe is required to show, captured by hand
  // rather than left to accidentally pass: the same assertion the GREEN
  // block below makes, proven here to FAIL against the broken code.
  let redFailed = false;
  try {
    assert.equal(red.state, shardarchive.NOT_MEASURED);
  } catch (e) {
    assert.ok(e instanceof assert.AssertionError);
    redFailed = true;
  }
  assert.ok(redFailed, 'the broken implementation must fail this exact assertion — otherwise the sabotage did not sabotage anything (RED not shown)');

  // --- GREEN: the real implementation ---
  const green = shardarchive.resolveEntry(root, ids[0]);
  assert.equal(green.state, shardarchive.NOT_MEASURED, 'the real implementation must report the third state');
  assert.notEqual(green.reason, 'not found', 'must not collapse to the same wording as "does not exist"');
  assert.ok(green.redirect, 'must still point at where the material lives');
  assert.equal(green.redirect.shard, row.shard);
});

test('SABOTAGE: archiveStatus tells "some unreachable" (DEGRADED) apart from "all unreachable" (NOT_MEASURED)', () => {
  const root = tmpRoot();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-store-'));
  archive.setLocation(root, store);
  seedLearnings(root, 6);
  const first = shardarchive.archiveOldest(root, 'learning', { count: 2 });
  const second = shardarchive.archiveOldest(root, 'learning', { count: 2 });
  assert.notEqual(first.shard, second.shard, 'setup: need two distinct shards to sabotage only one');

  fs.rmSync(path.join(store, shardarchive.SHARD_SUBDIR, first.shard));
  const partial = shardarchive.archiveStatus(root);
  assert.equal(partial.state, shardarchive.DEGRADED);
  assert.equal(partial.unreachableShards, 1);
  assert.equal(partial.reachableShards, 1);

  fs.rmSync(path.join(store, shardarchive.SHARD_SUBDIR, second.shard));
  const total = shardarchive.archiveStatus(root);
  assert.equal(total.state, shardarchive.NOT_MEASURED);
  assert.equal(total.unreachableShards, 2);
});

// ---------------------------------------------------------------------
// 4. SIZE: a fresh clone with and without the archived shards
// ---------------------------------------------------------------------

function du(p) {
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    if (entry.isDirectory()) total += du(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

/**
 * A throwaway git repository (init + one commit), sized via `.git`.
 *
 * **Why two SEPARATE repos, not one repo archived mid-history.** Git
 * deletes nothing (see archive.mjs's own header) — committing a
 * shrunk file on top of a full one keeps BOTH blobs reachable from
 * history, so `.git` after archiving is measured LARGER than before in
 * a single repo (verified by hand while building this test: 13,072,388
 * B before -> 13,377,012 B after, in the same history). That is real
 * and worth knowing — archiving line-by-line on top of existing history
 * does not shrink a `.git` that already has the bloat in it, only a
 * history rewrite would (which this house explicitly refuses to do to
 * a shared memory). But it is not what "size of a fresh clone" asks:
 * that question is about the STEADY STATE — a repository that has been
 * archiving all along versus one that never does — so it is measured
 * here as two independent single-commit repositories.
 */
function freshRepoGitSize(buildFn) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-freshrepo-'));
  buildFn(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'p17@localhost'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'p17-fixture'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'fresh state'], { cwd: repo });
  const size = du(path.join(repo, '.git'));
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  return size;
}

test('SIZE: a fresh clone of the steady state is smaller with archiving than without, and both numbers are reported', () => {
  // Realistically-sized entries, not the tiny fixed-shape entries
  // `seedLearnings` uses elsewhere in this file. This module's own
  // header explains why that distinction matters: a synthetic corpus of
  // short entries mismeasures a body-size question by an order of
  // magnitude (the same failure mode this build point's own
  // re-measurement of the 166.2 B/entry figure ran into). Reusing
  // `bench/atlas/core.mjs`'s generator (imported read-only, not
  // extended) gives the same body shape that file's own header
  // measured: ~974-1861 B/entry, not ~137 B/entry.
  const N = 40000;

  // "Today": every entry ever written is still tracked in git — the
  // scenario the build plan says grows without bound.
  let learningEntries = 0;
  let beforeBytes = 0;
  const withoutArchiving = freshRepoGitSize((repo) => {
    cfg.writeConfig(repo, cfg.DEFAULT_CONFIG);
    buildCorpus(repo, N, { seed: 42, anchors: 0 });
    beforeBytes = fs.statSync(memory.logPath(repo, 'learning')).size;
    learningEntries = memory.readLog(repo, 'learning').entries.length;
  });
  assert.ok(beforeBytes / learningEntries > 500,
    `fixture entries must be realistically sized, not toy-sized — got ${(beforeBytes / learningEntries).toFixed(1)} B/entry`);

  // "Steady state with archiving": the same corpus, but the oldest 80%
  // was moved out as it aged — the only part left tracked is the young
  // tail plus the manifest that stands in for everything older.
  let afterBytes = 0;
  let manifestBytes = 0;
  let archivedCount = 0;
  let shardBytesOutsideGit = 0;
  const withArchiving = freshRepoGitSize((repo) => {
    cfg.writeConfig(repo, cfg.DEFAULT_CONFIG);
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shardarchive-clonesize-store-'));
    archive.setLocation(repo, store);
    buildCorpus(repo, N, { seed: 42, anchors: 0 });
    const toMove = Math.floor(learningEntries * 0.8);
    const moved = shardarchive.archiveOldest(repo, 'learning', { count: toMove });
    archivedCount = moved.archived;
    afterBytes = fs.statSync(memory.logPath(repo, 'learning')).size;
    manifestBytes = fs.statSync(path.join(repo, shardarchive.MANIFEST_FILE)).size;
    shardBytesOutsideGit = du(path.join(store, shardarchive.SHARD_SUBDIR));
  });

  assert.equal(archivedCount, Math.floor(learningEntries * 0.8));
  assert.ok(afterBytes < beforeBytes, 'the tracked drawer file did not actually shrink');

  console.log(`[P17 size] ${N} entries in the corpus, ${learningEntries} in learnings.jsonl `
    + `(${(beforeBytes / learningEntries).toFixed(1)} B/entry, re-measured on the current tree — `
    + 'the build plan cites 166.2 B/entry, this run found substantially more, see this file\'s '
    + `header): fresh-clone .git WITHOUT archiving = ${withoutArchiving} B; WITH archiving `
    + `(${archivedCount} of ${learningEntries} learnings moved out) = ${withArchiving} B `
    + `(learnings.jsonl ${beforeBytes} B -> ${afterBytes} B tracked, ${manifestBytes} B manifest `
    + `tracked, ${shardBytesOutsideGit} B moved outside git entirely, still on disk).`);

  // The point of this build point: a fresh clone is smaller once old
  // material stops being tracked, and nothing was deleted to get there
  // — the archived bytes still exist, just not inside .git.
  assert.ok(withArchiving < withoutArchiving,
    `archiving must make a fresh clone smaller: ${withArchiving} B is not < ${withoutArchiving} B`);
  assert.ok(manifestBytes < (beforeBytes - afterBytes),
    'the manifest must be cheaper than the drawer bytes it replaces, or nothing was gained');
  assert.ok(shardBytesOutsideGit > 0, 'archived bytes must still exist SOMEWHERE — this build point relocates, it does not delete');
});
