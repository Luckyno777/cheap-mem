// src/filelock.mjs — the leaf lock: two processes lose nothing, waiting
// is bounded, a stale lock is taken over by age only, nesting throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEW_SRC, mkTmp, url, runChild } from './filelock-fixtures.mjs';
import { withLock, LockTimeoutError, NestedLockError, heldLock } from '../src/filelock.mjs';

const LOCK_URL = url(NEW_SRC, 'filelock.mjs');

// A counter file incremented by read-modify-write with a deliberate
// pause between read and write, so unguarded writers MUST overlap.
const counterScript = (file, lock, rounds, locked) => `
import fs from 'node:fs';
const { withLock } = await import(${JSON.stringify(LOCK_URL)});
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const bump = () => { const n = Number(fs.readFileSync(${JSON.stringify(file)}, 'utf8')); pause(); fs.writeFileSync(${JSON.stringify(file)}, String(n + 1)); };
for (let i = 0; i < ${rounds}; i++) {
  ${locked ? `withLock(${JSON.stringify(lock)}, bump, { waitMs: 30000 });` : 'bump();'}
}`;

async function race(locked) {
  const dir = mkTmp('fl-');
  const file = path.join(dir, 'counter'); fs.writeFileSync(file, '0');
  const lock = path.join(dir, 'counter.lock');
  const runs = [1, 2, 3].map(() => runChild(counterScript(file, lock, 25, locked)));
  const res = await Promise.all(runs.map((r) => r.done));
  for (const r of res) assert.equal(r.code, 0, r.out);
  return Number(fs.readFileSync(file, 'utf8'));
}

test('three processes, read-modify-write under the lock: nothing lost', async () => {
  assert.equal(await race(true), 75);
});

test('positive control: the same race WITHOUT the lock does lose updates', async () => {
  const n = await race(false);
  assert.ok(n < 75, `expected lost updates without the lock, got ${n}/75 — the race no longer measures anything`);
});

test('a held fresh lock: waiting is bounded, then LockTimeoutError', () => {
  const dir = mkTmp('fl-'); const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, `${process.pid} h ${new Date().toISOString()} tok\n`);
  const t0 = Date.now();
  assert.throws(() => withLock(lock, () => 1, { waitMs: 200, staleS: 60 }), LockTimeoutError);
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 3000, `waited ${took} ms for a 200 ms bound`);
  assert.ok(fs.existsSync(lock), 'a fresh lock must not be removed');
});

test('a stale lock (mtime older than staleS) is taken over; a fresh one is not', () => {
  const dir = mkTmp('fl-'); const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, '4242 elsewhere 2020-01-01T00:00:00Z tok\n');
  const old = new Date(Date.now() - 120 * 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(lock, () => 'ran', { waitMs: 200, staleS: 60 }), 'ran');
  assert.ok(!fs.existsSync(lock), 'released after the run');

  // Same age, but staleS larger than the age: NOT taken.
  fs.writeFileSync(lock, '4242 elsewhere 2020-01-01T00:00:00Z tok\n');
  fs.utimesSync(lock, old, old);
  assert.throws(() => withLock(lock, () => 'ran', { waitMs: 100, staleS: 600 }), LockTimeoutError);
  assert.ok(fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(dir), ['x.lock'], 'no stale-grave files left behind');
});

test('the lock file carries pid and host while held', () => {
  const dir = mkTmp('fl-'); const lock = path.join(dir, 'x.lock');
  withLock(lock, () => {
    const parts = fs.readFileSync(lock, 'utf8').trim().split(' ');
    assert.equal(parts[0], String(process.pid));
    assert.equal(parts[1], os.hostname());
    assert.ok(!Number.isNaN(Date.parse(parts[2])));
  });
});

test('nested withLock throws (leaf locks only), also for the same path; the outer one still releases', () => {
  const dir = mkTmp('fl-'); const a = path.join(dir, 'a.lock'); const b = path.join(dir, 'b.lock');
  assert.throws(() => withLock(a, () => withLock(b, () => 1)), NestedLockError);
  assert.equal(heldLock(), null, 'guard cleared after the throw');
  assert.ok(!fs.existsSync(a), 'outer lock released');
  assert.throws(() => withLock(a, () => withLock(a, () => 1)), NestedLockError);
  assert.equal(withLock(a, () => 'again'), 'again');
});

test('a lock taken over as stale during fn is not deleted by the old holder', () => {
  const dir = mkTmp('fl-'); const lock = path.join(dir, 'x.lock');
  withLock(lock, () => { fs.writeFileSync(lock, '1 other 2026-01-01T00:00:00Z THEIRS\n'); });
  assert.equal(fs.readFileSync(lock, 'utf8').includes('THEIRS'), true);
});

test('fn throwing releases the lock', () => {
  const dir = mkTmp('fl-'); const lock = path.join(dir, 'x.lock');
  assert.throws(() => withLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(lock));
});
