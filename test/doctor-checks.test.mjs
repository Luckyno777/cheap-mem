// test/doctor-checks.test.mjs — the two deterministic health checks added
// as cheap-mem's own answer to obsidian's contradiction/orphan detection.
// No model, no git: they read the logs and reason over ids and dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { checkFactConflicts, checkOrphans, checkIntegrity, LEVEL } from '../src/doctor.mjs';

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-doctor-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  return root;
}

test('fact-conflicts: clean when facts only update by date', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'timeline', { key: 'k', value: '10', valid_from: '2026-06-01' });
  memory.logEntry(root, 'timeline', { key: 'k', value: '13', valid_from: '2026-07-01' });
  const f = checkFactConflicts(root);
  assert.equal(f.level, LEVEL.GOOD);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fact-conflicts: warns on same date, different value', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'timeline', { key: 'server.users', value: '13', valid_from: '2026-07-13' });
  memory.logEntry(root, 'timeline', { key: 'server.users', value: '14', valid_from: '2026-07-13' });
  const f = checkFactConflicts(root);
  assert.equal(f.level, LEVEL.WARN);
  assert.match(f.text, /server\.users/);
  assert.ok(f.advice);
  fs.rmSync(root, { recursive: true, force: true });
});

test('orphans: clean when every correction points at a real entry', () => {
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'decision', { title: 'use postgres' });
  assert.ok(entry.id, 'logEntry must return the written entry with its id');
  memory.logEntry(root, 'decision', { title: 'use postgres (fixed)', replaces_id: entry.id });
  const f = checkOrphans(root);
  assert.equal(f.level, LEVEL.GOOD);
  fs.rmSync(root, { recursive: true, force: true });
});

test('orphans: warns when a correction points at a missing id', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision', { title: 'a correction of nothing', replaces_id: 'ghost-id-123' });
  const f = checkOrphans(root);
  assert.equal(f.level, LEVEL.WARN);
  assert.match(f.text, /ghost-id-123/);
  assert.ok(f.advice);
  fs.rmSync(root, { recursive: true, force: true });
});

test('orphans: a link edge into nothing is caught like any dead pointer', () => {
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'decision', { title: 'real' });
  memory.logEntry(root, 'link', { from: entry.id, to: 'ghost-edge-1', kind: 'causes' });
  const f = checkOrphans(root);
  assert.equal(f.level, LEVEL.WARN);
  assert.match(f.text, /ghost-edge-1/);
});

// --- integrity: valid_until before valid_from ------------------------

test('integrity: an entry with valid_until before valid_from is named, not folded into a generic count', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision', {
    topic: 'x', choice: 'y', why: 'z',
    valid_from: '2026-06-01T00:00:00Z', valid_until: '2026-01-01T00:00:00Z',
  });
  const f = checkIntegrity(root);
  assert.equal(f.level, LEVEL.WARN,
    'a claim that can never be valid at any --as-of is worth more than a GOOD note');
  assert.match(f.text, /valid_until before valid_from/);
  assert.ok(f.advice, 'a non-good finding must carry a next step');
  fs.rmSync(root, { recursive: true, force: true });
});

test('integrity: an ordinary clock skew stays GOOD, unaffected by the new check', () => {
  const root = tmpRoot();
  // A timestamp 20 minutes in the future — past the 5-minute slack, so
  // it lands in the generic "questionable timestamp(s)" bucket, which
  // this new check must not have touched.
  memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z',
    ts: new Date(Date.now() + 20 * 60000).toISOString() });
  const f = checkIntegrity(root);
  assert.equal(f.level, LEVEL.GOOD);
  assert.match(f.text, /questionable timestamp/);
  fs.rmSync(root, { recursive: true, force: true });
});
