// test/repetition.test.mjs — F0/F1 (BAUPLAN-mem-admin_02.md Block F,
// ported from lucky-mem/src/wiederholung.mjs): the ONE answer to "is
// this error a repeat?"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as repetition from '../src/repetition.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
function daysAgo(n) { return new Date(NOW - n * DAY).toISOString(); }

test('no reasons on a first-of-its-kind error', () => {
  const e = { id: 'a', ts: daysAgo(0), class: 'wrong-cause', file: 'src/x.mjs' };
  const r = repetition.check(e, [e], { now: NOW });
  assert.deepEqual(r.reasons, []);
  assert.equal(r.is, false);
});

test('POSITIVE CONTROL: same file + same class within 30 days fires file-class-30-days', () => {
  const earlier = { id: 'a', ts: daysAgo(20), class: 'wrong-cause', file: 'src/x.mjs' };
  const now = { id: 'b', ts: daysAgo(0), class: 'wrong-cause', file: 'src/x.mjs' };
  const r = repetition.check(now, [earlier, now], { now: NOW });
  assert.ok(r.reasons.includes('file-class-30-days'));
  assert.deepEqual(r.hits.map((h) => h.id), ['a']);
  assert.equal(r.is, true);
});

test('the SAME file rule does not fire past the 30-day window', () => {
  const earlier = { id: 'a', ts: daysAgo(31), class: 'wrong-cause', file: 'src/x.mjs' };
  const now = { id: 'b', ts: daysAgo(0), class: 'wrong-cause', file: 'src/x.mjs' };
  const r = repetition.check(now, [earlier, now], { now: NOW });
  assert.ok(!r.reasons.includes('file-class-30-days'));
});

test('a DIFFERENT file with the same class does not fire the file rule', () => {
  const earlier = { id: 'a', ts: daysAgo(5), class: 'wrong-cause', file: 'src/other.mjs' };
  const now = { id: 'b', ts: daysAgo(0), class: 'wrong-cause', file: 'src/x.mjs' };
  const r = repetition.check(now, [earlier, now], { now: NOW });
  assert.ok(!r.reasons.includes('file-class-30-days'));
});

test('a LATER entry is not a lead-up, even with the same file+class', () => {
  const later = { id: 'a', ts: daysAgo(-1), class: 'wrong-cause', file: 'src/x.mjs' };
  const now = { id: 'b', ts: daysAgo(0), class: 'wrong-cause', file: 'src/x.mjs' };
  const r = repetition.check(now, [later, now], { now: NOW });
  assert.deepEqual(r.hits, []);
});

test('POSITIVE CONTROL: the class threshold fires at exactly 3 within 7 days', () => {
  const e1 = { id: 'a', ts: daysAgo(6), class: 'concurrency', title: 'race one' };
  const e2 = { id: 'b', ts: daysAgo(3), class: 'concurrency', title: 'race two' };
  const e3 = { id: 'c', ts: daysAgo(0), class: 'concurrency', title: 'race three' };
  const all = [e1, e2, e3];
  const r = repetition.check(e3, all, { now: NOW });
  assert.ok(r.reasons.includes('class-3x-7-days'));
  assert.equal(r.classCount, 3);
});

test('two of a kind does not cross the class threshold', () => {
  const e1 = { id: 'a', ts: daysAgo(3), class: 'concurrency' };
  const e2 = { id: 'b', ts: daysAgo(0), class: 'concurrency' };
  const r = repetition.check(e2, [e1, e2], { now: NOW });
  assert.ok(!r.reasons.includes('class-3x-7-days'));
  assert.equal(r.classCount, 2);
});

test('the class threshold can fire with NO determinable file', () => {
  const e1 = { id: 'a', ts: daysAgo(6), class: 'concurrency' };
  const e2 = { id: 'b', ts: daysAgo(3), class: 'concurrency' };
  const e3 = { id: 'c', ts: daysAgo(0), class: 'concurrency' };
  const r = repetition.check(e3, [e1, e2, e3], { now: NOW });
  assert.deepEqual(r.files, []);
  assert.ok(r.reasons.includes('class-3x-7-days'));
});

test('an entry never counts against itself, even passed twice', () => {
  const e = { id: 'a', ts: daysAgo(0), class: 'wrong-cause', file: 'src/x.mjs' };
  const r = repetition.check(e, [e, e], { now: NOW });
  assert.deepEqual(r.hits, []);
  assert.equal(r.classCount, 1);
});
