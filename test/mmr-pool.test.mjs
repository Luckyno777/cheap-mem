// mmr-pool: search() hands MMR a bounded pool (mmrPoolFor), not every hit
// above the floor — and the answer stays the same.
//
// Found 2026-09-29 by bench/cold-find.mjs once its warm loop used the
// options `mem find` really passes (top 30, MMR 0.7): warm, load 0.95,
// 20k entries 465 ms median, 200k 5624 ms — against 43 / 620 ms without
// MMR. The sibling house caps the MMR pool since 2026-09-17; this house
// never got the cap.
//
// Two halves:
//   SAME ANSWER  on a generated corpus, the capped search returns exactly
//                what the uncapped code (fixed commit 9041b39, loaded from
//                git) returns, for every bench query.
//   BOUNDED      the uncapped code feeds MMR every kept hit; the capped one
//                at most mmrPoolFor(top). The corpus is checked to make
//                that a real difference, and a code guard pins the slice.
//                RED on 9041b39: the guard fails (no slice before MMR).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as search from '../src/search.mjs';
import { buildCorpus, QUERIES } from '../bench/scale.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED = '9041b39';
const OPTIONS = { top: 30, mmr: true, mmrLambda: 0.7 };

async function loadOld() {
  const text = execFileSync('git', ['show', `${FIXED}:src/search.mjs`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Same directory, so its relative imports resolve to the same modules.
  const file = path.join(ROOT, 'src', `.search-${FIXED}-${process.pid}.mjs`);
  fs.writeFileSync(file, text);
  try { return await import(pathToFileURL(file).href); } finally { fs.rmSync(file, { force: true }); }
}

test('mmrPoolFor: n without MMR, 10 x n with MMR, at least 50', () => {
  assert.equal(search.mmrPoolFor(30, false), 30);
  assert.equal(search.mmrPoolFor(30, true), 300);
  assert.equal(search.mmrPoolFor(3, true), 50);
  assert.equal(search.mmrPoolFor(0, true), 0);
});

test('capped MMR returns the same answer as the uncapped code, and its pool is smaller', async () => {
  const old = await loadOld();
  const { root } = buildCorpus(3000);
  try {
    const index = search.loadIndex(root, { language: 'en' });
    const ids = (hits) => hits.map((h) => h.id ?? h.entry?.id ?? JSON.stringify(h).slice(0, 80));
    let checked = 0;
    for (const q of QUERIES) {
      const now = search.search(index, q, OPTIONS);
      const before = old.search(index, q, OPTIONS);
      assert.deepEqual(ids(now), ids(before), `same answer for "${q}"`);
      if (now.length) checked += 1;
    }
    // Positive control: the corpus and queries actually produce hits.
    assert.ok(checked >= 3, `at least 3 queries with hits (got ${checked})`);
    // Bounded: the uncapped code handed MMR every kept hit, the capped one
    // at most mmrPoolFor(top). The corpus must make that a real difference.
    const q = QUERIES[1];
    const all = search.search(index, q, { top: 100000, mmr: false, minScore: 0 });
    const pool = Math.min(all.length, search.mmrPoolFor(OPTIONS.top, true));
    assert.ok(all.length > pool, `the uncapped pool (${all.length}) is larger than the cap (${pool}) — otherwise this corpus proves nothing`);
  } finally {
    removeTree(root);
  }
});

test('search() hands mmrRerank the capped pool (code guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'search.mjs'), 'utf8');
  assert.match(code, /^\s+\? mmrRerank\(kept\.slice\(0, mmrPoolFor\(top, true\)\),/m);
});
