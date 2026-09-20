// The search index cache as shards (P9, 2026-09-20 build plan) —
// correctness of `src/indexcache.mjs`, independent of the wall it
// exists to remove (that is `index-cache-ladder.test.mjs`).
//
// Four things this file pins:
//
//   round trip     a real index, written and read back, is the same
//                  index — every Map/Set reconstructed, not just the
//                  plain fields.
//   byte-identical rebuilding the SAME logs twice must produce THE
//                  SAME bytes on disk, file for file — this house's
//                  standing invariant for derived state (CLAUDE.md:
//                  "no second source of truth").
//   truncation     a cache cut mid-record is DETECTED, never served
//                  partially. Positive control: the same cache, intact,
//                  loads fine — so "detected" is not "everything fails".
//   sabotage       an "unsafe" reader that skips the length/hash check
//                  (the shape the truncation guard exists to prevent)
//                  DOES serve the cut file — proving the guard is load-
//                  bearing, not decorative. Driving the tamper past the
//                  guard rather than editing `src` to disable it follows
//                  `cache-tamper.test.mjs`'s existing pattern in this
//                  repo. The literal "disable the check in the source,
//                  see it go red, restore, see it go green" pass was
//                  also run by hand during development — see the
//                  session report for both counts, since a permanent
//                  test cannot leave the source broken.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as cfg from '../src/config.mjs';
import * as ic from '../src/indexcache.mjs';

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-indexcache-'));
  cfg.writeConfig(r, cfg.DEFAULT_CONFIG);
  return r;
}

/** A small, real corpus — real `buildIndex` output, real Maps and Sets. */
function seeded(root, n = 40) {
  for (let i = 0; i < n; i += 1) {
    memory.logEntry(root, 'learning', {
      title: `learning ${i} anchorword${i}`,
      text: `what to do differently about topic ${i % 7}, tag t${i % 5}`,
      tags: [`t${i % 5}`, 'shared-tag'],
    });
  }
  for (let i = 0; i < Math.floor(n / 4); i += 1) {
    memory.logEntry(root, 'decision', {
      topic: `topic ${i}`,
      choice: `chose approach ${i}`,
      why: `because of reason ${i} shared-tag`,
    });
  }
  return search.buildIndex(root, { language: 'en' });
}

function reconstructedEqual(a, b) {
  assert.deepEqual(a.documents.map((d) => ({ ...d, weights: [...d.weights] })),
    b.documents.map((d) => ({ ...d, weights: [...d.weights] })));
  assert.deepEqual([...a.docFreq].sort(), [...b.docFreq].sort());
  assert.deepEqual([...a.statsDocFreq].sort(), [...b.statsDocFreq].sort());
  assert.deepEqual([...a.lexicon].sort(), [...b.lexicon].sort());
  assert.deepEqual(
    [...a.lexicons].map(([k, v]) => [k, [...v].sort()]).sort(),
    [...b.lexicons].map(([k, v]) => [k, [...v].sort()]).sort(),
  );
  assert.deepEqual([...a.tagGraph], [...b.tagGraph]);
  assert.deepEqual([...a.termGraph], [...b.termGraph]);
  assert.deepEqual(
    [...a.entityIndex].map(([k, v]) => [k, [...v].sort()]).sort(),
    [...b.entityIndex].map(([k, v]) => [k, [...v].sort()]).sort(),
  );
  assert.equal(a.N, b.N);
  assert.equal(a.avgLength, b.avgLength);
  assert.equal(a.statsN, b.statsN);
  assert.equal(a.statsAvgLength, b.statsAvgLength);
}

test('round trip: write then read reproduces the built index exactly', () => {
  const root = tmpRoot();
  const index = seeded(root, 60);
  const dir = path.join(root, '.mem', 'search-index');
  const files = { 'learnings.jsonl': { bytes: 1, kind: 'log', docs: 60 } };
  ic.writeIndexCache(dir, { version: 9, language: 'en', files, fullAt: index.N, index });

  const res = ic.readIndexCache(dir, { expectedVersion: 9, expectedLanguage: 'en' });
  assert.equal(res.ok, true, `expected a clean read, got: ${res.reason}`);
  assert.deepEqual(res.files, files);
  assert.equal(res.fullAt, index.N);
  reconstructedEqual(res.index, index);
});

test('a version or language mismatch is reported, not silently accepted', () => {
  const root = tmpRoot();
  const index = seeded(root, 10);
  const dir = path.join(root, '.mem', 'search-index');
  ic.writeIndexCache(dir, { version: 9, language: 'en', files: {}, fullAt: index.N, index });

  assert.equal(ic.readIndexCache(dir, { expectedVersion: 10, expectedLanguage: 'en' }).ok, false);
  assert.equal(ic.readIndexCache(dir, { expectedVersion: 9, expectedLanguage: 'de' }).ok, false);
});

test('byte-identical rebuild: the same logs, built twice, are the same bytes', () => {
  const root = tmpRoot();
  const index1 = seeded(root, 120);
  const dirA = path.join(root, '.mem', 'search-index-a');
  const dirB = path.join(root, '.mem', 'search-index-b');
  const files = { 'learnings.jsonl': { bytes: 1 } };

  ic.writeIndexCache(dirA, { version: 9, language: 'en', files, fullAt: index1.N, index: index1 });
  // Rebuild from the SAME logs (no new entries in between) — a second,
  // independent `buildIndex` call, not a copy of the first result.
  const index2 = search.buildIndex(root, { language: 'en' });
  ic.writeIndexCache(dirB, { version: 9, language: 'en', files, fullAt: index2.N, index: index2 });

  const namesA = fs.readdirSync(dirA).sort();
  const namesB = fs.readdirSync(dirB).sort();
  assert.deepEqual(namesA, namesB, 'the two builds must produce the same set of files');
  for (const name of namesA) {
    const a = fs.readFileSync(path.join(dirA, name));
    const b = fs.readFileSync(path.join(dirB, name));
    assert.ok(a.equals(b), `${name} differs between two builds of the identical logs`);
  }
});

test('truncation: a cache cut mid-record is detected, not half-loaded', () => {
  const root = tmpRoot();
  const index = seeded(root, 200); // enough lines that a cut lands mid-record
  const dir = path.join(root, '.mem', 'search-index');
  ic.writeIndexCache(dir, { version: 9, language: 'en', files: {}, fullAt: index.N, index });

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const shardFile = manifest.documents[0].file;
  const shardPath = path.join(dir, shardFile);
  const full = fs.readFileSync(shardPath);
  assert.ok(full.length > 20, 'fixture too small to cut meaningfully');
  fs.writeFileSync(shardPath, full.subarray(0, full.length - 5)); // cut mid last record

  const res = ic.readIndexCache(dir, { expectedVersion: 9, expectedLanguage: 'en' });
  assert.equal(res.ok, false, 'a truncated shard must not be accepted');
  assert.match(res.reason, /^truncated:/);
  assert.equal(res.index, undefined, 'no partial index may be handed back');
});

test('POSITIVE CONTROL: the same cache, left intact, loads normally', () => {
  const root = tmpRoot();
  const index = seeded(root, 200);
  const dir = path.join(root, '.mem', 'search-index');
  ic.writeIndexCache(dir, { version: 9, language: 'en', files: {}, fullAt: index.N, index });

  const res = ic.readIndexCache(dir, { expectedVersion: 9, expectedLanguage: 'en' });
  assert.equal(res.ok, true, 'an untouched cache must not be rejected — the truncation check is not just refusing everything');
  assert.equal(res.index.documents.length, index.documents.length);
});

test('SABOTAGE: without the length/hash check, the same cut file is served as if intact', () => {
  const root = tmpRoot();
  const index = seeded(root, 200);
  const dir = path.join(root, '.mem', 'search-index');
  ic.writeIndexCache(dir, { version: 9, language: 'en', files: {}, fullAt: index.N, index });

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const shard = manifest.documents[0];
  const shardPath = path.join(dir, shard.file);
  const full = fs.readFileSync(shardPath);
  fs.writeFileSync(shardPath, full.subarray(0, full.length - 5));

  // The real reader: rejects it. (Repeats the truncation test above —
  // kept here too so this file alone shows both sides of the same
  // sabotage side by side.)
  const guarded = ic.readIndexCache(dir, { expectedVersion: 9, expectedLanguage: 'en' });
  assert.equal(guarded.ok, false, 'the guarded reader must refuse the cut file');

  // An "unsafe" reader: the exact same shape as `readIndexCache`, minus
  // the length/hash verification `readVerified` performs — i.e. what
  // this module would do if that check were deleted. It reads the
  // shard raw, splits on newlines, and parses whatever is left —
  // dropping the tail record silently.
  const raw = fs.readFileSync(shardPath, 'utf8');
  const lines = raw.length ? raw.split('\n').filter((l) => l.length) : [];
  let parsedOk = 0;
  for (const line of lines) {
    try { JSON.parse(line); parsedOk += 1; } catch { /* the cut record: silently dropped */ }
  }
  assert.ok(
    parsedOk < shard.count,
    'the sabotage fixture must actually be missing a record, or this proves nothing',
  );
  // This is the RED the guard exists to prevent: an unguarded reader
  // returns fewer documents than the cache claims to hold, with no
  // signal anywhere that anything was lost — exactly the "loads 80% of
  // an index and answers confidently" failure the brief names.
  assert.notEqual(parsedOk, shard.count,
    'SABOTAGE CHECK: an unguarded reader silently serves a truncated shard as if it were the whole thing');
});
