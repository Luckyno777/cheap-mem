// mmr-pool-max: the MMR pool has a hard ceiling (MMR_POOL_MAX = 600), whatever `top` is.
//
// Found 2026-10-17 (ported from the sibling house's MMR_DECKEL_MAX). `mem find --top N` asks the search for 3 x N
// and the pool was ten times that, with no ceiling: 6000 entries, a query that matches most of them, median of 3
// under load 7 - top 10 0.58 s, top 200 9.3 s, top 1000 34 s, `--no-mmr` 0.67 s. `mmrRerank` costs
// O(pool x selection).
//
// Three halves:
//   BOUND        the pool is never above max(n, 600), never below n; for n <= 60 (`--top` up to 20) it is
//                the old formula max(10 n, 50), byte for byte. mmrSelect spends at most 600 x 600 similarities
//                for any n and any list length and hands back n distinct hits.
//   SAME ORDER   search() with top <= 60 returns, on a generated corpus and every bench query, exactly what the
//                code before this change returns (fixed commit 9c95641, loaded from git).
//   END TO END   search() with top 1000: the count stays 1000, the head is a permutation of the first 600 by score,
//                the tail is in score order. The positive control: handing MMR the whole list (the old behaviour)
//                does reorder the tail, so the probe distinguishes the two.
//
// RED on 9c95641 (the old state): MMR_POOL_MAX and mmrSelect do not exist, mmrPoolFor(1000, true) is 10000, and
// search() reorders hits beyond 600 (checked by running this file in a tree at that commit).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as search from '../src/search.mjs';
import { oldModuleCopy } from './helpers/old-source-copy.mjs';
import { buildCorpus, QUERIES } from '../bench/scale.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED = '9c95641';

/** The formula BEFORE this change. */
const oldPool = (n) => (n <= 0 ? 0 : Math.max(n * 10, 50));

const doc = (i) => ({ id: `d${i}`, score: 1000 - i, source: `s${i}`, line: i, __i: i });

test('the pool is capped at MMR_POOL_MAX and never smaller than n', () => {
  assert.equal(search.MMR_POOL_MAX, 600);
  for (const n of [1, 3, 10, 30, 60, 61, 100, 600, 601, 1000, 3000, 100000]) {
    const pool = search.mmrPoolFor(n, true);
    assert.ok(pool >= n, `n ${n}: pool ${pool} < n`);
    assert.ok(pool <= Math.max(n, search.MMR_POOL_MAX), `n ${n}: pool ${pool} above the ceiling`);
  }
  assert.equal(search.mmrPoolFor(0, true), 0);
  assert.equal(search.mmrPoolFor(30, false), 30, 'without MMR exactly n');
});

test('for n <= 60 the pool is the old one; above it is not (positive control)', () => {
  for (let n = 1; n <= 60; n += 1) assert.equal(search.mmrPoolFor(n, true), oldPool(n), `n ${n}`);
  assert.notEqual(search.mmrPoolFor(100, true), oldPool(100));
  assert.equal(search.mmrPoolFor(100, true), 600);
});

test('mmrSelect: n far above the pool costs at most MMR_POOL_MAX^2 similarities and stays n distinct hits', () => {
  const list = Array.from({ length: 5000 }, (_, i) => doc(i));
  let calls = 0;
  const simOf = (a, b) => { calls += 1; return Math.abs(a.__i - b.__i) % 7 === 0 ? 0.9 : 0.1; };
  const n = 3000;
  const out = search.mmrSelect(list, n, { lambda: 0.7, simOf });
  assert.equal(out.length, n);
  assert.equal(new Set(out.map((d) => d.id)).size, n, 'no duplicate');
  assert.ok(calls <= search.MMR_POOL_MAX * search.MMR_POOL_MAX, `${calls} similarities`);
  assert.ok(calls > 0, 'control: the similarity function was used at all');
  // Behind the pool: score order. The head is a reordering of the pool, nothing from outside.
  assert.deepEqual(out.slice(search.MMR_POOL_MAX).map((d) => d.__i),
    Array.from({ length: n - search.MMR_POOL_MAX }, (_, i) => i + search.MMR_POOL_MAX));
  assert.ok(out.slice(0, search.MMR_POOL_MAX).every((d) => d.__i < search.MMR_POOL_MAX));
});

test('mmrSelect: for normal n the same selection as mmrRerank over the old pool', () => {
  const list = Array.from({ length: 2000 }, (_, i) => doc(i));
  const simOf = (a, b) => ((a.__i * 31 + b.__i * 17) % 11) / 10;
  for (const n of [3, 10, 30, 45, 60]) {
    const before = search.mmrRerank(list.slice(0, oldPool(n)), { lambda: 0.7, top: n, simOf }).map((d) => d.id);
    const now = search.mmrSelect(list, n, { lambda: 0.7, simOf }).map((d) => d.id);
    assert.deepEqual(now, before, `n ${n}`);
  }
});

test('mmrSelect: empty list, one entry, n <= 0, n above the list', () => {
  const none = () => 0;
  assert.deepEqual(search.mmrSelect([], 5, { simOf: none }), []);
  assert.deepEqual(search.mmrSelect([doc(0)], 5, { simOf: none }).map((d) => d.id), ['d0']);
  assert.deepEqual(search.mmrSelect([doc(0), doc(1)], 0, { simOf: none }), []);
  assert.equal(search.mmrSelect([doc(0), doc(1), doc(2)], 10, { simOf: none }).length, 3);
});

async function loadOld() {
  const text = execFileSync('git', ['show', `${FIXED}:src/search.mjs`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const copy = oldModuleCopy(path.join(ROOT, 'src'), 'search.mjs', text);
  try { return await import(pathToFileURL(copy.file).href); } finally { fs.rmSync(copy.dir, { recursive: true, force: true }); }
}

const ids = (hits) => hits.map((h) => h.id ?? h.entry?.id ?? JSON.stringify(h).slice(0, 80));

test('search(): top <= 60 returns what the code before the ceiling returns; top 1000 keeps its count and orders only the pool', async () => {
  const old = await loadOld();
  const { root } = buildCorpus(3000);
  try {
    const index = search.loadIndex(root, { language: 'en' });
    // SAME ORDER
    let withHits = 0;
    for (const q of QUERIES) {
      for (const top of [3, 10, 30, 60]) {
        const opts = { top, mmr: true, mmrLambda: 0.7 };
        const now = search.search(index, q, opts);
        assert.deepEqual(ids(now), ids(old.search(index, q, opts)), `"${q}" top ${top}`);
        if (now.length) withHits += 1;
      }
    }
    assert.ok(withHits >= 12, `the control saw hits (${withHits} of ${QUERIES.length * 4} calls)`);

    // END TO END, on the query that matches most entries.
    const q = 'seen again in';
    const plain = search.search(index, q, { top: 1000, mmr: false });
    assert.equal(plain.length, 1000, 'the corpus must offer at least 1000 hits, or this proves nothing');
    const cap = search.MMR_POOL_MAX;
    const big = search.search(index, q, { top: 1000, mmr: true, mmrLambda: 0.7 });
    assert.equal(big.length, 1000);
    assert.equal(new Set(ids(big)).size, 1000, 'no duplicate');
    assert.deepEqual(ids(big).slice(cap), ids(plain).slice(cap), 'behind the pool: score order');
    assert.deepEqual([...ids(big).slice(0, cap)].sort(), [...ids(plain).slice(0, cap)].sort(), 'the head only reorders the pool');
    assert.notDeepEqual(ids(big).slice(0, cap), ids(plain).slice(0, cap), 'control: MMR did reorder the head');

    // Positive control: MMR over the WHOLE list (what the code before did) changes the tail, so the line above can fail.
    const whole = old.search(index, q, { top: 1000, mmr: true, mmrLambda: 0.7 });
    assert.notDeepEqual(ids(whole).slice(cap), ids(plain).slice(cap), 'control: the old code reorders beyond 600');
  } finally {
    removeTree(root);
  }
});

test('search() hands MMR through mmrSelect, with the ceiling inside it (code guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'search.mjs'), 'utf8');
  assert.match(code, /export const MMR_POOL_MAX = 600;/);
  assert.match(code, /Math\.min\(Math\.max\(n \* MMR_POOL_FACTOR, MMR_POOL_MIN\), MMR_POOL_MAX\)/);
  assert.match(code, /const pool = Math\.min\(mmrPoolFor\(n, true\), MMR_POOL_MAX\);/);
});
