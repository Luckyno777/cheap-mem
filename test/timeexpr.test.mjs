// test/timeexpr.test.mjs — the English NL time parser, zone-aware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFor, zonedToUtc, _internal } from '../src/timeexpr.mjs';

// Reference instant. Tests pin zone:'UTC' so expectations are exact and do not
// depend on the machine running them.
const NOW = new Date('2026-09-01T18:00:00.000Z');
const W = (t, zone = 'UTC') => windowFor(t, { now: NOW, zone });
const iso = (d) => d.toISOString().replace('.000Z', 'Z');

test('no time → null (falls back to keyword search)', () => {
  assert.equal(W('what about the revoke token'), null);
  assert.equal(W(''), null);
});

test('relative span: last 12 hours', () => {
  const w = W('what did we build in the last 12 hours');
  assert.equal(iso(w.from), '2026-09-01T06:00:00Z');
  assert.equal(iso(w.to), '2026-09-01T18:00:00Z');
});

test('last hour / last week without a number', () => {
  assert.equal(iso(W('last hour').from), '2026-09-01T17:00:00Z');
  assert.equal(iso(W('last week').from), '2026-08-25T18:00:00Z');
});

test('yesterday = whole UTC day here', () => {
  const w = W('what happened yesterday');
  assert.equal(iso(w.from), '2026-08-31T00:00:00Z');
  assert.equal(iso(w.to), '2026-09-01T00:00:00Z');
});

test('yesterday afternoon = 12–18', () => {
  const w = W('what did we discuss yesterday afternoon');
  assert.equal(iso(w.from), '2026-08-31T12:00:00Z');
  assert.equal(iso(w.to), '2026-08-31T18:00:00Z');
});

test('between 3 and 8 pm (am/pm applies to both)', () => {
  const w = W('between 3 and 8 pm');
  assert.equal(iso(w.from), '2026-09-01T15:00:00Z');
  assert.equal(iso(w.to), '2026-09-01T20:00:00Z');
});

test('3-8pm shorthand', () => {
  const w = W('anything from 3-8pm');
  assert.equal(iso(w.from), '2026-09-01T15:00:00Z');
  assert.equal(iso(w.to), '2026-09-01T20:00:00Z');
});

test('24h span: from 15:00 to 20:00', () => {
  const w = W('from 15:00 to 20:00');
  assert.equal(iso(w.from), '2026-09-01T15:00:00Z');
  assert.equal(iso(w.to), '2026-09-01T20:00:00Z');
});

test('explicit date + span', () => {
  const w = W('on 2026-08-29 from 15:00 to 20:00');
  assert.equal(iso(w.from), '2026-08-29T15:00:00Z');
  assert.equal(iso(w.to), '2026-08-29T20:00:00Z');
});

test('last friday = most recent past Friday, whole day', () => {
  const w = W('what did we research last friday');
  assert.equal(_internal.zonedParts(w.from.getTime(), 'UTC').wday, 5);
  assert.equal(w.to.getTime() - w.from.getTime(), 24 * 3600000);
  assert.ok(w.from.getTime() < NOW.getTime());
});

test('zone matters: afternoon in America/New_York (EDT -4)', () => {
  const w = W('yesterday afternoon', 'America/New_York');
  // 31.08. 12:00–18:00 EDT = 16:00Z–22:00Z
  assert.equal(iso(w.from), '2026-08-31T16:00:00Z');
  assert.equal(iso(w.to), '2026-08-31T22:00:00Z');
});

test('zonedToUtc honours DST', () => {
  assert.equal(iso(zonedToUtc(2026, 7, 1, 12, 0, 'America/New_York')), '2026-07-01T16:00:00Z'); // EDT -4
  assert.equal(iso(zonedToUtc(2026, 1, 1, 12, 0, 'America/New_York')), '2026-01-01T17:00:00Z'); // EST -5
});
