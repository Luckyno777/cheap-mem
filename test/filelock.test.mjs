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

// The loss is FORCED, not hoped for: every child reads the counter, then
// waits at a barrier until all three have read, then writes. Without a
// lock all three write the same n+1 — the result is 1, on any load. The
// earlier version raced 3 x 25 rounds and hoped for an interleaving; under
// a full suite the children ran one after the other and it went red
// (2026-09-30, K-branch full suite).
const barrierScript = (file, dir, id) => `
import fs from 'node:fs';
import path from 'node:path';
const n = Number(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'read-' + ${JSON.stringify(String(id))}), '');
const until = Date.now() + 20000;
while (fs.readdirSync(${JSON.stringify(dir)}).filter((f) => f.startsWith('read-')).length < 3) {
  if (Date.now() > until) process.exit(3);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
fs.writeFileSync(${JSON.stringify(file)}, String(n + 1));`;

test('positive control: the same read-modify-write WITHOUT the lock loses updates (forced interleaving)', async () => {
  const dir = mkTmp('fl-');
  const file = path.join(dir, 'counter'); fs.writeFileSync(file, '0');
  const runs = [1, 2, 3].map((id) => runChild(barrierScript(file, dir, id)));
  const res = await Promise.all(runs.map((r) => r.done));
  for (const r of res) assert.equal(r.code, 0, r.out);
  assert.equal(Number(fs.readFileSync(file, 'utf8')), 1, 'three unlocked increments that all read 0 must end at 1 — the probe measures the lost update');
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

test('age alone never takes over (audit F02): another host / unknown owner stays, however old', () => {
  const dir = mkTmp('fl-'); const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, '4242 elsewhere 2020-01-01T00:00:00Z tok\n');
  const old = new Date(Date.now() - 120 * 1000);
  fs.utimesSync(lock, old, old);
  assert.throws(() => withLock(lock, () => 'ran', { waitMs: 100, staleS: 60 }), /unknown/);
  assert.ok(fs.existsSync(lock), 'never deleted blindly');
  assert.deepEqual(fs.readdirSync(dir), ['x.lock'], 'no grave files left behind');
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
