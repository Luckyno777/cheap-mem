// test/freshness.test.mjs — the deterministic living-facts resolution.
//
// Pure over an array of timeline entries: no fs, no model, no clock unless
// injected. Covers the four behaviours that matter — newest valid_from
// wins, stale is flagged, a same-date disagreement is a conflict, retired
// versions and keyless entries are left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFacts, formatFact, subjectKey } from '../src/freshness.mjs';

const NOW = new Date('2026-09-01T00:00:00Z');

test('newest valid_from is current, the rest are history', () => {
  const entries = [
    { id: 'a', key: 'server.users', value: '10', valid_from: '2026-06-01' },
    { id: 'b', key: 'server.users', value: '13', valid_from: '2026-07-13' },
    { id: 'c', key: 'server.users', value: '11', valid_from: '2026-06-20' },
  ];
  const [f] = resolveFacts(entries, { now: NOW });
  assert.equal(f.key, 'server.users');
  assert.equal(f.current.value, '13');
  assert.deepEqual(f.history.map((h) => h.value), ['11', '10']);
  assert.equal(f.conflict, false);
});

test('a current value older than staleDays is flagged stale', () => {
  const entries = [{ id: 'a', key: 'k', value: 'x', valid_from: '2026-01-01' }];
  const [f] = resolveFacts(entries, { now: NOW, staleDays: 120 });
  assert.equal(f.stale, true);
  assert.ok(f.ageDays > 120);
  const [fresh] = resolveFacts([{ id: 'b', key: 'k', value: 'x', valid_from: '2026-08-20' }], { now: NOW, staleDays: 120 });
  assert.equal(fresh.stale, false);
});

test('two versions with the same date but different values are a conflict', () => {
  const entries = [
    { id: 'a', key: 'k', value: '13', valid_from: '2026-07-13' },
    { id: 'b', key: 'k', value: '14', valid_from: '2026-07-13' },
  ];
  const [f] = resolveFacts(entries, { now: NOW });
  assert.equal(f.conflict, true);
});

test('retired versions are dropped', () => {
  const entries = [
    { id: 'a', key: 'k', value: 'new', valid_from: '2026-07-01' },
    { id: 'b', key: 'k', value: 'wrong', valid_from: '2026-08-01' },
  ];
  const retired = new Map([['b', { state: 'discarded' }]]);
  const [f] = resolveFacts(entries, { now: NOW, retired });
  assert.equal(f.current.value, 'new'); // 'b' would have won by date, but it is retired
  assert.equal(f.history.length, 0);
});

test('entries without a key are not tracked facts', () => {
  const entries = [
    { id: 'a', fact: 'a one-off note', valid_from: '2026-07-01' },
    { id: 'b', key: 'k', value: 'v', valid_from: '2026-07-01' },
  ];
  const res = resolveFacts(entries, { now: NOW });
  assert.equal(res.length, 1);
  assert.equal(res[0].key, 'k');
  assert.equal(subjectKey(entries[0]), null);
});

test('formatFact renders key, value, as-of and flags', () => {
  const [f] = resolveFacts([{ id: 'a', key: 'server.users', value: '13', valid_from: '2026-01-01', source: 'ops' }], { now: NOW });
  const line = formatFact(f);
  assert.match(line, /server\.users = 13/);
  assert.match(line, /as of 2026-01-01/);
  assert.match(line, /<ops>/);
  assert.match(line, /stale/);
});
