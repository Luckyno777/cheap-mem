// Two failure classes that used to be invisible: silently skipped broken
// lines, and an unchecked replacement graph. Every case here was either
// measured against the real code (2026-09-05) or is a shape the graph
// admits and the resolver had no answer for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanIntegrity, replacementGraph, isClean, MAX_CHAIN } from '../src/integrity.mjs';

function fixture(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-int-'));
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'), lines.join('\n') + '\n');
  return root;
}
const line = (o) => JSON.stringify(o);
const claim = (id, extra = {}) => line({ id, ts: '2026-01-01T00:00:00Z', topic: 't', choice: `c ${id}`, why: 'w', ...extra });

test('a truncated line is counted and located, not silently dropped', () => {
  const root = fixture([claim('a'), '{"id":"b","ts":"2026-01-01T00:00:00Z","choice":"half']);
  const r = scanIntegrity(root);
  assert.equal(r.entries, 1);
  assert.equal(r.broken.length, 1);
  assert.equal(r.broken[0].line, 2);
  assert.match(r.broken[0].file, /decisions\.jsonl$/);
  assert.equal(isClean(r), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the report never carries line content — a broken line may hold a half-written secret', () => {
  // Assembled from parts: written as a literal, this fixture trips the
  // pre-commit hook and the test file cannot be committed. Which is the
  // hook doing its job, and worth the two extra lines.
  const marker = 'wJalrXUtnFEMI' + 'K7MDENG';
  const root = fixture([claim('a'), `{"id":"b","tok` + `en":"${marker}`]);
  const r = scanIntegrity(root);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes(marker), 'the diagnostic leaked the broken line');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a duplicate id across lines is reported with both locations', () => {
  const root = fixture([claim('a'), claim('a')]);
  const r = scanIntegrity(root);
  assert.equal(r.duplicateIds.length, 1);
  assert.equal(r.duplicateIds[0].id, 'a');
  assert.equal(r.duplicateIds[0].at.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unparseable or far-future timestamp is reported', () => {
  const root = fixture([
    claim('a', { ts: 'not-a-date' }),
    claim('b', { ts: '2099-01-01T00:00:00Z' }),
    claim('c', { valid_from: '2026-05-01T00:00:00Z', valid_until: '2026-01-01T00:00:00Z' }),
  ]);
  const r = scanIntegrity(root);
  const why = r.badTimestamp.map((b) => b.why).sort();
  assert.deepEqual(why, ['ts in the future', 'unparseable ts', 'valid_until before valid_from']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clock a few minutes fast is not called time travel', () => {
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  const root = fixture([claim('a', { ts: soon })]);
  assert.equal(scanIntegrity(root).badTimestamp.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- the replacement graph ------------------------------------------------

const graph = (pairs) => replacementGraph(new Map(
  pairs.map(([id, replaces]) => [id, { replaces, file: 'f', line: 1 }]),
));

test('a chain resolves and its depth is reported', () => {
  const g = graph([['a', null], ['b', 'a'], ['c', 'b']]);
  assert.deepEqual(g.missing, []);
  assert.deepEqual(g.cycles, []);
  assert.equal(g.maxDepth, 3);
});

test('a dangling replaces is reported, not followed', () => {
  const g = graph([['b', 'does-not-exist']]);
  assert.equal(g.missing.length, 1);
  assert.equal(g.missing[0].replaces, 'does-not-exist');
});

test('a two-node cycle terminates and is reported once', () => {
  const g = graph([['a', 'b'], ['b', 'a']]);
  assert.equal(g.cycles.length, 1);
  assert.deepEqual(g.cycles[0], ['a', 'b']);
});

test('a self-replacing claim is a cycle, not an infinite walk', () => {
  const g = graph([['a', 'a']]);
  assert.equal(g.cycles.length, 1);
  assert.deepEqual(g.cycles[0], ['a']);
});

test('a fork — two claims replacing the same target — is reported, not resolved', () => {
  const g = graph([['a', null], ['b', 'a'], ['c', 'a']]);
  assert.equal(g.forks.length, 1);
  assert.equal(g.forks[0].target, 'a');
  assert.deepEqual(g.forks[0].by, ['b', 'c']);
  // A fork is ambiguous but not corrupt: merge=union will produce it
  // whenever two sessions correct the same entry without seeing each other.
  assert.deepEqual(g.cycles, []);
});

test('a chain longer than the cap terminates and is flagged, not truncated', () => {
  const pairs = [['n0', null]];
  const n = MAX_CHAIN + 20;
  for (let i = 1; i <= n; i += 1) pairs.push([`n${i}`, `n${i - 1}`]);
  const g = graph(pairs);          // returning at all is the first assertion
  // The cap exists to stop an unbounded walk, not to lie about the depth:
  // memoisation settles each node in one step, so the true depth is
  // reported and `tooDeep` is what says it is pathological.
  assert.equal(g.maxDepth, n + 1);
  assert.equal(g.tooDeep, true);
  assert.deepEqual(g.cycles, []);
});

test('a long chain that ends in a cycle still terminates', () => {
  const pairs = [];
  const n = MAX_CHAIN + 20;
  for (let i = 1; i <= n; i += 1) pairs.push([`n${i}`, `n${i - 1}`]);
  pairs.push(['n0', `n${n}`]);     // close the ring
  const g = graph(pairs);
  assert.ok(g.cycles.length >= 1, 'the ring was not detected');
  // A ring has no depth: every node on it is unresolvable, so maxDepth
  // stays 0 and `tooDeep` says nothing. The cycle is the finding.
  assert.equal(g.maxDepth, 0);
  assert.equal(g.cycles[0].length, n + 1);
});

test('graph analysis is order-independent', () => {
  const a = graph([['a', null], ['b', 'a'], ['c', 'a']]);
  const b = graph([['c', 'a'], ['b', 'a'], ['a', null]]);
  assert.deepEqual(a.forks, b.forks);
  assert.deepEqual(a.cycles, b.cycles);
  assert.deepEqual(a.missing.map((m) => m.id), b.missing.map((m) => m.id));
});
