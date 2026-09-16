// An instrument that raises a false alarm gets switched off.
//
// The funnel puts produced and consumed side by side per channel. Its
// first draft reported "questions: 5 produced, 0 consumed — dead
// channel". That was wrong: questions are deliberately closed through
// a `resolves` edge rather than a field on the entry. Three channels,
// three closing conventions, each well founded on its own.
//
// So the important tests here are not "it finds a dead channel" but
// the counter-checks: a live channel must not be reported dead, and
// "not measured" must never turn into "zero".
//
// Covers assurances from shared/invariants.jsonl.
// invariant: drei-zustaende-nie-zwei
// invariant: leer-ist-kein-bestehen
// invariant: abschluss-zeiger-eine-stelle
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { funnel, finding, readJsonl } from '../bench/consumption-funnel.mjs';
import * as inbox from '../src/inbox.mjs';

const run = (r) => funnel(r, { isDone: inbox.isDone });
const pick = (cs, name) => cs.find((c) => c.channel === name);

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-funnel-'));
  fs.mkdirSync(path.join(r, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(r, 'projects/p'), { recursive: true });
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const rows = (r, file, list) => fs.writeFileSync(
  path.join(r, 'projects/p', file), `${list.map((x) => JSON.stringify(x)).join('\n')}\n`);
const msg = (r, name, state) => fs.writeFileSync(path.join(r, 'inbox', name),
  `From: a\nTo: b\nTime: 2026-09-16T10:00:00Z\nSubject: x\nState: ${state}\n\nText.\n`);

test('a question closed by a resolves edge counts as consumed', () => {
  // The first draft's mistake, kept as a test.
  const r = build();
  try {
    rows(r, 'questions.jsonl', [
      { id: 'q1', ts: '2026-09-16T10:00:00Z', frage: 'A?' },
      { id: 'q2', ts: '2026-09-16T11:00:00Z', frage: 'B?' },
    ]);
    rows(r, 'links.jsonl', [
      { id: 'l1', art: 'resolves', von: 'e9', nach: 'q1' },
      { id: 'l2', art: 'causes', von: 'e8', nach: 'q2' },
    ]);
    const q = pick(run(r), 'questions');
    assert.equal(q.produced, 2);
    assert.equal(q.consumed, 1, 'the resolves edge was not read as a closing');
    assert.deepEqual(finding(run(r), { atLeast: 1 }).dead.map((x) => x.channel), [],
      'a live channel was reported dead — the false alarm this tool nearly died of');
  } finally { away(r); }
});

test('"not measured" is null and never becomes 0', () => {
  // With REAL injections, so the early return does not satisfy the
  // assertion on a branch it never entered.
  const r = build();
  try {
    fs.mkdirSync(path.join(r, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(r, '.pipeline', 'injections.jsonl'),
      `${JSON.stringify({ ts: 'x', hits: 3 })}\n${JSON.stringify({ ts: 'y', hits: 0 })}\n`);
    const cs = run(r);
    assert.equal(pick(cs, 'retrieval').produced, 2, 'precondition: the real branch runs');
    assert.equal(pick(cs, 'retrieval').delivered, 1);
    assert.equal(pick(cs, 'retrieval').consumed, null,
      'retrieval consumption is not observable — that must be null, not 0');
    assert.equal(pick(cs, 'inbox').delivered, null);
    const f = finding(cs);
    assert.ok(f.blind.some((x) => x.channel === 'retrieval'));
    assert.deepEqual(f.dead.map((x) => x.channel), [],
      'an unmeasured channel must never count as a dead channel');
  } finally { away(r); }
});

test('a genuinely dead channel is reported', () => {
  const r = build();
  try {
    rows(r, 'duties.jsonl', Array.from({ length: 7 }, (_, i) =>
      ({ id: `d${i}`, ts: '2026-09-16T10:00:00Z', titel: `T${i}` })));
    assert.deepEqual(finding(run(r)).dead.map((x) => x.channel), ['duties']);
  } finally { away(r); }
});

test('a small channel with no consumption is not yet a finding', () => {
  const r = build();
  try {
    rows(r, 'duties.jsonl', [{ id: 'd1', ts: 't', titel: 'A' }, { id: 'd2', ts: 't', titel: 'B' }]);
    assert.deepEqual(finding(run(r)).dead, []);
  } finally { away(r); }
});

test('the inbox channel asks isDone instead of interpreting', () => {
  const r = build();
  try {
    let i = 0;
    for (const st of ['open', 'replied', 'processed', 'closed']) {
      msg(r, `2026-09-16T10-0${i++}-00Z--a-to-b.md`, st);
    }
    const c = pick(run(r), 'inbox');
    assert.equal(c.produced, 4);
    assert.equal(c.consumed, 3, 'processed and closed count as through');
  } finally { away(r); }
});

test('orphan closings stand out', () => {
  const r = build();
  try {
    rows(r, 'duties.jsonl', [
      { id: 'd1', ts: 't', titel: 'A' },
      { id: 'x1', ts: 't', stand: 'done', closes_id: 'doesnotexist' },
    ]);
    assert.equal(pick(run(r), 'duties').orphanClosings, 1);
  } finally { away(r); }
});

test('an empty root is not a pass', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-empty-'));
  try {
    const f = finding(run(empty));
    assert.equal(f.measured, 0, 'without a store nothing may count as measured');
    assert.deepEqual(f.dead, [], 'found nothing is not the same as nothing there');
  } finally { away(empty); }
});

test('broken lines are counted, not swallowed', () => {
  const r = build();
  try {
    fs.writeFileSync(path.join(r, 'projects/p/duties.jsonl'),
      `${JSON.stringify({ id: 'd1', titel: 'A' })}\n{broken\n`);
    const x = readJsonl(path.join(r, 'projects/p/duties.jsonl'));
    assert.equal(x.rows.length, 1);
    assert.equal(x.broken, 1);
    assert.equal(pick(run(r), 'duties').brokenLines, 1);
  } finally { away(r); }
});

test('a closing row is not counted as a new duty', () => {
  // The two lines that read the closing pointer look independent and
  // are not. Getting them out of step makes produced rise while
  // consumed stands still — which reads as a channel going bad.
  const r = build();
  try {
    rows(r, 'duties.jsonl', [
      { id: 'd1', ts: 't', titel: 'A' },
      { id: 'd2', ts: 't', titel: 'B' },
      { id: 'x1', ts: 't', stand: 'done', closes_id: 'd1' },
    ]);
    const c = pick(run(r), 'duties');
    assert.equal(c.produced, 2, 'the closing row was counted as a duty');
    assert.equal(c.consumed, 1);
    assert.equal(c.orphanClosings, 0);
  } finally { away(r); }
});
