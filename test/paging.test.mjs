// "There is more" — and why there is no cursor.
//
// **What was built, and then taken back out.** The comparison document
// suggested snapshot-bound pagination (CBM does it well). I built it:
// a cursor carrying the corpus generation, refused when the log grew in
// between. It worked, and it cost two measured defences.
//
// The path is the lesson.
//
//  1. First attempt, `selectWant = offset + want + 1`. One claim came
//     back on page 2 AND page 3 — measured on nine entries from nine
//     authors: 9 rows, 1 of them twice. Cause: the author-share cap and
//     the context budget work on the SELECTION, not on the corpus.
//     Different selection size, different survivors, shifted offsets.
//     The generation guard could never have caught it — the corpus had
//     not changed, only the question about it had.
//
//  2. Second attempt, `selectWant = maxResults + 1`, constant. Pages fit
//     together. FOUR existing probes went red, and they were positive
//     controls: "if MMR changes nothing on this fixture, the comparison
//     above proves nothing". With 51 selected, everything on a small
//     fixture gets in, so MMR no longer shaped the selection — and
//     shaping the selection is exactly its job here (measured 7/18 ->
//     9/18 on the eval corpus). The flooding defence from 2026-09-05
//     rests on the same property.
//
// So: a measured defence traded for a convenience feature, silently,
// caught only because the old probes were positive controls rather than
// "does it render" checks. Taken back out.
//
// What remains is the honest half: `hasMore`, derived from the
// selection loop stopping early. It costs nothing, claims nothing about
// how many more there are, and a caller who wants more asks with a
// larger `top`. A cursor is refused rather than ignored — falling back
// to page 1 would answer a question nobody asked and look like success.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as retrieval from '../src/retrieval.mjs';
import * as capability from '../src/capability.mjs';
import * as search from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

/** Distinct authors, or the author-share cap shortens every answer. */
function memory(n) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-page-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  for (let i = 0; i < n; i += 1) {
    spawnSync(process.execPath, [MEM, '--root', r, 'log', 'decision',
      '--topic', 'storage', '--choice', `sqlite variant ${i}`, '--why', 'small and local'],
    { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_AGENT: `agent${i}` } });
  }
  return r;
}
const cap = () => capability.grantAll('human:root');

test('POSITIVE: a short answer over a large corpus reports more', () => {
  const r = memory(9);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 3 });
    assert.equal(res.claims.length, 3);
    assert.equal(res.hasMore, true);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('an answer that reached the end does NOT claim more', () => {
  // The counter-probe. Without it `hasMore: true` everywhere would pass
  // the test above and mean nothing.
  const r = memory(3);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 10 });
    assert.equal(res.hasMore, false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('hasMore costs no widening of the selection', () => {
  // The property the whole retreat was about. Asking for three must
  // select three — not four, not fifty. Anything else moves the author
  // share cap and MMR, which are measured defences.
  const r = memory(9);
  try {
    const three = retrieval.retrieve(r, 'sqlite', cap(), { top: 3 });
    assert.equal(three.claims.length, 3, 'the answer grew beyond what was asked');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a cursor is REFUSED, not silently treated as page one', () => {
  const r = memory(4);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 2, cursor: 'anything' });
    assert.equal(res.claims.length, 0, 'a cursor was served as a page');
    assert.equal(res.coverage.state, retrieval.COVERAGE.UNKNOWN);
    assert.match(res.excluded[0].why, /paging is not offered/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('more behind the answer makes the coverage partial', () => {
  // `hasMore` is the mechanism; coverage is what may be CONCLUDED from
  // it. An answer with more behind it is never complete evidence.
  const r = memory(9);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 3 });
    assert.equal(res.coverage.state, retrieval.COVERAGE.PARTIAL);
    assert.match(JSON.stringify(res.coverage.reasons), /more claims match/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the order is a function of (score, id), not of the lane a claim came in by', () => {
  // **What the id tie-break actually buys**, after the first comment
  // claimed something false. `Array.sort` is stable since ES2019, so
  // ties keep their insertion order and removing the key broke no
  // probe. The property it DOES give: the order does not depend on the
  // round-robin over authority tiers or on which lane ran first.
  //
  // Measured: six decisions on one topic score identically to six
  // decimal places. Ties are the normal case here, not the exception.
  const r = memory(9);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 9 });
    const expected = [...res.claims]
      .sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)))
      .map((c) => c.id);
    assert.deepEqual(res.claims.map((c) => c.id), expected,
      'the answer is not ordered by (score, id)');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the generation moves when the corpus does, and not otherwise', () => {
  // Kept from the retreat: it says whether two answers came from the
  // same state of the memory. That is worth having even without a
  // cursor to hang on it.
  const r = memory(2);
  try {
    const before = search.corpusGeneration(r);
    assert.equal(search.corpusGeneration(r), before, 'not stable across two reads');
    spawnSync(process.execPath, [MEM, '--root', r, 'log', 'event', '--title', 'something happened'],
      { encoding: 'utf8' });
    assert.notEqual(search.corpusGeneration(r), before, 'an append did not move it');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the CLI says there is more, and how to see it', () => {
  const r = memory(9);
  try {
    const out = spawnSync(process.execPath,
      [MEM, '--root', r, 'retrieve', 'sqlite', '--top', '3'], { encoding: 'utf8' }).stdout;
    assert.match(out, /More match/);
    assert.match(out, /--top/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
