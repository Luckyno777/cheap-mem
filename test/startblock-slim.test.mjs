// Memory probe for the session-start block (`core()` -> `experiences()` ->
// `standing()`), port of lucky-mem c541183a.
//
// `standing()`/`experiences()` used to build `entriesById()`, a map of EVERY
// held entry (about 1 KiB each), just to answer "who cites whom". Now they
// stream the drawers in three passes and keep only citing entries, cited ids
// and, for `experiences({ minCited >= 1 })`, the entries of the cited ids.
// `minCited: 0` keeps the old path (it needs every learning).
//
// Two promises:
//  1. Equality: standing(), experiences() (minCited 0/1/2, other type) and
//     core() equal the pinned old state on a memory with citations, unknown
//     cited ids, duplicate ids, tombstones and contradicting links.
//  2. Memory: a child with a small --max-old-space-size. The OLD state dies
//     (red proof), the new one finishes and prints the same block. Positive
//     control: the old state finishes with a big heap, so the probe measures
//     memory and not some other failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CHILD = path.join(HERE, 'search-slim-child.mjs');
// FIXED state before the change (never merge-base: it moves along with a merge).
const OLD = 'f9fd134003dbdec6e342066fbe21a060ba6bf5c5';
// Measured 2026-10-06 on 100 000 entries of 40-60 words in ten drawers: the old
// state dies below ~81-88 MiB, the new one finishes from ~17-24 MiB.
// 48 keeps at least 24 MiB to either side.
const HEAP_MIB = 48;
const N_BIG = 100000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-slim-b-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function oldTree() {
  const dest = path.join(tmp, 'old');
  try {
    fs.mkdirSync(dest, { recursive: true });
    exportCommit(REPO, OLD, ['src', 'package.json'], dest);
    return dest;
  } catch { return null; }
}
const old = oldTree();

function child(tree, mode, root, { heap = null, n = '' } = {}) {
  const args = [...(heap ? [`--max-old-space-size=${heap}`] : []), CHILD, tree, mode, root, String(n)];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, WITH_CITES: '1' },
  });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

test('standing, experiences and core: same as the old state', { skip: !old && 'old commit not reachable (shallow clone?)', timeout: 55000 }, () => {
  const root = path.join(tmp, 'small');
  assert.equal(child(REPO, 'create', root, { n: 3000 }).rc, 0);
  const a = child(old, 'standing', root);
  const n = child(REPO, 'standing', root);
  assert.equal(a.rc, 0, a.err);
  assert.equal(n.rc, 0, n.err);
  assert.equal(n.out, a.out, 'standing()/experiences() differ from the old state');
  // Positive control: citations, a contradiction and the special cases are really in the memory.
  const j = JSON.parse(n.out);
  assert.ok(j.standing.length > 20, 'there are cited entries');
  assert.ok(j.standing.some(([, r]) => r.contested), 'a contradiction was hit');
  assert.ok(j.e1.length > 5 && j.e2.length > 0, 'experiences with one / two citations');
  assert.ok(j.e0 > j.e1.length, 'minCited 0 takes every learning (old path stays)');
  assert.ok(!JSON.stringify(j.standing).includes('does-not-exist'), 'unknown cited ids do not count');
  // The block itself, character for character.
  const ka = JSON.parse(child(old, 'start', root).out).block;
  const kn = JSON.parse(child(REPO, 'start', root).out).block;
  assert.equal(kn, ka, 'the session-start block differs');
  assert.match(kn, /experience \(backed/);
});

test(`memory: the session-start block runs at ${HEAP_MIB} MiB; the old state dies`, { skip: !old && 'old commit not reachable (shallow clone?)', timeout: 58000 }, () => {
  const root = path.join(tmp, 'big');
  assert.equal(child(REPO, 'create', root, { n: N_BIG }).rc, 0);
  // Positive control: old finishes with a big heap (the probe measures memory, not another failure).
  const ok = child(old, 'start', root, { heap: 1024 });
  assert.equal(ok.rc, 0, ok.err.slice(-400));
  // Red proof: old dies at the small heap.
  const red = child(old, 'start', root, { heap: HEAP_MIB });
  assert.notEqual(red.rc, 0, 'the old state should have died at this heap');
  assert.match(red.err, /heap out of memory|JavaScript heap/i);
  // New finishes and prints the same block.
  const fresh = child(REPO, 'start', root, { heap: HEAP_MIB });
  assert.equal(fresh.rc, 0, fresh.err.slice(-400));
  assert.equal(JSON.parse(fresh.out).block, JSON.parse(ok.out).block);
});
