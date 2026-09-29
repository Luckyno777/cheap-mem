// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/gap.test.mjs — N18 parity (src/gap.mjs): a retrieval miss the
// injection journal recorded, later matched by content-word overlap
// with a NEW entry, is a closed knowledge gap -> a `kind:'gap'` gold
// candidate.
//
// Red proof pinned to this worktree's starting commit (agent-rahmen.md
// rule 12): f77439fac293d46dc1d46c73a54e4bb0f38bfecc, never `git
// merge-base`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as gap from '../src/gap.mjs';
import * as injection from '../src/injection.mjs';
import * as goldlog from '../src/goldlog.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_GAP_COMMIT = 'f77439fac293d46dc1d46c73a54e4bb0f38bfecc';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gap-'));
}
function away(r) { fs.rmSync(r, { recursive: true, force: true }); }
function goldEnv(root) {
  return { CHEAP_MEM_GOLD_FILE: path.join(root, '..', `${path.basename(root)}-gold.jsonl`) };
}

// ---------------------------------------------------------------------
// Red proof
// ---------------------------------------------------------------------

test('RED PROOF (pinned commit): src/gap.mjs did not exist before this build', () => {
  assert.throws(() => execFileSync('git', ['show', `${PRE_GAP_COMMIT}:src/gap.mjs`], { cwd: REPO, stdio: 'pipe' }),
    /Command failed/, 'expected src/gap.mjs to be absent at the pinned pre-build commit');
});

// ---------------------------------------------------------------------
// Positive control: the tokenizer really sees overlap
// ---------------------------------------------------------------------

test('POSITIVE CONTROL: stemsOf sees real shared stems between two different sentences', () => {
  const a = gap.stemsOf('how do I configure the frobnicator widget');
  const b = gap.stemsOf('frobnicator widget configuration guide');
  const shared = [...a].filter((s) => b.has(s));
  assert.ok(shared.length >= 2, `expected at least 2 shared stems, got ${JSON.stringify(shared)}`);
});

// ---------------------------------------------------------------------
// isMiss / missCandidates
// ---------------------------------------------------------------------

test('isMiss: only occasion=question with reason too-weak/empty count; hits and before-edit do not', () => {
  assert.equal(gap.isMiss({ occasion: 'question', reason: 'empty' }), true);
  assert.equal(gap.isMiss({ occasion: 'question', reason: 'too-weak' }), true);
  assert.equal(gap.isMiss({ occasion: 'question', reason: null }), false, 'a hit is not a miss');
  assert.equal(gap.isMiss({ occasion: 'question', reason: 'no-signal' }), false, 'no-signal is not a quality miss');
  assert.equal(gap.isMiss({ occasion: 'before-edit', reason: 'empty' }), false, 'not a real question');
});

// ---------------------------------------------------------------------
// sweep: no journal -> not measurable
// ---------------------------------------------------------------------

test('sweep: no injection journal at all -> readable:false, not measurable (not a silent 0)', () => {
  const root = tmpRoot();
  try {
    const r = gap.sweep(root);
    assert.equal(r.readable, false);
    assert.equal(r.open.length, 0);
    assert.equal(r.closed.length, 0);
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// sweep: the three real outcomes
// ---------------------------------------------------------------------

function bookMiss(root, { ts, session, reason }) {
  const ok = injection.book(root, { ts, session, occasion: injection.OCCASION.QUESTION, reason, hits: 0 });
  assert.equal(ok, true, 'fixture setup: expected the journal line to be written');
}

test('sweep: a miss later matched (>=2 shared stems) by a NEW entry closes the gap — exactly one candidate', () => {
  const root = tmpRoot();
  try {
    bookMiss(root, { ts: '2026-09-29T10:00:00Z', session: 's1', reason: 'empty' });
    const messages = [{
      path: 'raw/2026/09/2026-09-29T100000Z--s1.jsonl.gz',
      line: 1,
      ts: '2026-09-29T10:00:02Z',
      text: 'how do I configure the frobnicator widget',
    }];
    const entries = new Map([
      ['e1', { id: 'e1', ts: '2026-09-29T11:00:00Z', title: 'frobnicator widget configuration guide' }],
    ]);
    const r = gap.sweep(root, { entries, messages });
    assert.equal(r.readable, true);
    assert.equal(r.closed.length, 1);
    assert.equal(r.open.length, 0);
    assert.equal(r.unknown.length, 0);
    assert.equal(r.closed[0].entryId, 'e1');

    const candidates = gap.goldCandidatesFromClosed(r.closed);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'gap');
    assert.deepEqual(candidates[0].expected, ['e1']);
    assert.equal(candidates[0].question, null, 'privacy: a gap candidate never carries question text');
  } finally { away(root); }
});

test('sweep: an UNRELATED later entry does not close the gap — stays open, no candidate', () => {
  const root = tmpRoot();
  try {
    bookMiss(root, { ts: '2026-09-29T10:00:00Z', session: 's1', reason: 'too-weak' });
    const messages = [{
      path: 'raw/2026/09/2026-09-29T100000Z--s1.jsonl.gz',
      line: 1,
      ts: '2026-09-29T10:00:02Z',
      text: 'how do I configure the frobnicator widget',
    }];
    const entries = new Map([
      ['e2', { id: 'e2', ts: '2026-09-29T11:00:00Z', title: 'weekend hiking trail conditions report' }],
    ]);
    const r = gap.sweep(root, { entries, messages });
    assert.equal(r.closed.length, 0);
    assert.equal(r.open.length, 1);
    assert.equal(gap.goldCandidatesFromClosed(r.closed).length, 0);
  } finally { away(root); }
});

test('sweep: an entry written BEFORE the miss never closes it (only later entries count)', () => {
  const root = tmpRoot();
  try {
    bookMiss(root, { ts: '2026-09-29T10:00:00Z', session: 's1', reason: 'empty' });
    const messages = [{
      path: 'raw/2026/09/2026-09-29T100000Z--s1.jsonl.gz', line: 1, ts: '2026-09-29T10:00:02Z',
      text: 'how do I configure the frobnicator widget',
    }];
    const entries = new Map([
      ['e0', { id: 'e0', ts: '2026-09-29T09:00:00Z', title: 'frobnicator widget configuration guide' }],
    ]);
    const r = gap.sweep(root, { entries, messages });
    assert.equal(r.closed.length, 0);
    assert.equal(r.open.length, 1);
  } finally { away(root); }
});

test('sweep: no correlated real message near the miss -> unknown (not-measured-is-not-zero), never silently open/closed', () => {
  const root = tmpRoot();
  try {
    bookMiss(root, { ts: '2026-09-29T10:00:00Z', session: 's1', reason: 'empty' });
    const r = gap.sweep(root, { entries: new Map(), messages: [] });
    assert.equal(r.unknown.length, 1);
    assert.equal(r.open.length, 0);
    assert.equal(r.closed.length, 0);
  } finally { away(root); }
});

test('closingEntry / minOverlap: a single shared stem is not enough (n>=2 requires 2)', () => {
  const stems = new Set(['frobnicator', 'widget']);
  const entries = new Map([
    ['e1', { id: 'e1', ts: '2026-09-29T12:00:00Z', title: 'frobnicator manual' }], // 1 shared stem only
  ]);
  const closes = gap.closingEntry(stems, '2026-09-29T10:00:00Z', entries);
  assert.equal(closes, null);
});

test('minOverlap: a candidate with a single known stem can never be asked for more than that one', () => {
  assert.equal(gap.minOverlap(1), 1);
  assert.equal(gap.minOverlap(2), 2);
  assert.equal(gap.minOverlap(5), 2);
});

// ---------------------------------------------------------------------
// draw(): idempotent append to the SAME external file goldlog.mjs owns
// ---------------------------------------------------------------------

test('draw: writes exactly one candidate for a closed gap, and NEVER a second time for the same gap', () => {
  const root = tmpRoot();
  const env = goldEnv(root);
  try {
    bookMiss(root, { ts: '2026-09-29T10:00:00Z', session: 's1', reason: 'empty' });
    const messages = [{
      path: 'raw/2026/09/2026-09-29T100000Z--s1.jsonl.gz', line: 1, ts: '2026-09-29T10:00:02Z',
      text: 'how do I configure the frobnicator widget',
    }];
    const entries = new Map([
      ['e1', { id: 'e1', ts: '2026-09-29T11:00:00Z', title: 'frobnicator widget configuration guide' }],
    ]);

    const first = gap.draw(root, { env, entries, messages });
    assert.equal(first.readable, true);
    assert.equal(first.drawn, 1);
    assert.equal(first.written, true);

    const rows = goldlog.read(goldlog.targetPath(env)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'gap');
    assert.deepEqual(rows[0].expected, ['e1']);

    // Same journal, same entries — the gap is already drawn (by `source`).
    const second = gap.draw(root, { env, entries, messages });
    assert.equal(second.drawn, 0, 'a gap already drawn once must never be proposed again');
    assert.equal(second.written, false);
    assert.equal(goldlog.read(goldlog.targetPath(env)).rows.length, 1, 'still exactly one row');
  } finally { away(root); }
});

test('draw: refuses a target inside the memory root (same boundary as goldlog.checkTargetOutsideRoot)', () => {
  const root = tmpRoot();
  try {
    assert.throws(() => gap.draw(root, { env: { CHEAP_MEM_GOLD_FILE: path.join(root, 'gold.jsonl') } }),
      /outside the memory root|must be outside/);
  } finally { away(root); }
});
