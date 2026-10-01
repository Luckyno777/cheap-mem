// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Orphaned lock: holder provably dead -> taken over at once.
//
// Finding (bench/value-report.mjs, durability.json, 2026-10-01): the writer
// was killed 30 times with SIGKILL, and 5 times the next write failed or
// waited out its bound because the lock first had to go stale (120 s for
// drawer locks). Now: pid in the content, same host, `process.kill(pid, 0)`
// -> ESRCH => taken over at once, by rename, exactly one winner. If the
// holder lives or it is unclear (other host, no pid, empty), age decides.
//
// Red proof: "a SIGKILL orphan is taken over at once" and "a dead pid ...
// at once" fail on the parent of the fix commit (LockTimeoutError after
// the bound); the blocking tests pass there and here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLock, LockTimeoutError } from '../src/filelock.mjs';
import { NEW_SRC, mkTmp, url, runChild, sleepMs } from './filelock-fixtures.mjs';

const LOCK_URL = url(NEW_SRC, 'filelock.mjs');

/** A pid that was alive a moment ago and is dead now. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(r.stdout);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'probe: the pid must really be dead');
  return pid;
}

function waitForFile(p, ms = 20000) {
  const t0 = Date.now();
  while (!fs.existsSync(p) && Date.now() - t0 < ms) sleepMs(5);
  assert.ok(fs.existsSync(p), `${p} did not appear`);
}

/** A child takes the lock and sleeps inside it; it signals through `inside`. */
function holderInChild(lock, inside) {
  return runChild(`
    import fs from 'node:fs';
    import { withLock } from ${JSON.stringify(LOCK_URL)};
    withLock(${JSON.stringify(lock)}, () => {
      fs.writeFileSync(${JSON.stringify(inside)}, 'yes');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    }, { waitMs: 5000, staleS: 120 });
  `);
}

test('a SIGKILL orphan is taken over at once, not after staleS', async () => {
  const dir = mkTmp('orphan-lock-'); const lock = path.join(dir, 'x.lock'); const inside = path.join(dir, 'inside');
  const { child, done } = holderInChild(lock, inside);
  waitForFile(inside);
  const content = fs.readFileSync(lock, 'utf8');
  assert.ok(content.startsWith(`${child.pid} ${os.hostname()} `), `lock carries pid and host: ${content}`);
  child.kill('SIGKILL');
  await done;
  assert.ok(fs.existsSync(lock), 'probe: the orphan is really still there');

  const t0 = performance.now();
  assert.equal(withLock(lock, () => 'ran', { waitMs: 3000, staleS: 120 }), 'ran');
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms} ms until takeover`);
  assert.ok(!fs.existsSync(lock), 'free afterwards');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('x.lock')), [], 'no grave or temporary files');
});

test('a dead pid on this host with a fresh mtime: taken over at once', () => {
  const dir = mkTmp('orphan-lock-'); const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, `${deadPid()} ${os.hostname()} ${new Date().toISOString()} token\n`);
  const t0 = performance.now();
  assert.equal(withLock(lock, () => 1, { waitMs: 2000, staleS: 120 }), 1);
  assert.ok(performance.now() - t0 < 1000);
});

test('a live holder still blocks (bound, lock stays)', async () => {
  const dir = mkTmp('orphan-lock-'); const lock = path.join(dir, 'x.lock'); const inside = path.join(dir, 'inside');
  const { child, done } = holderInChild(lock, inside);
  try {
    waitForFile(inside);
    assert.throws(() => withLock(lock, () => 1, { waitMs: 300, staleS: 120 }), LockTimeoutError);
    assert.ok(fs.readFileSync(lock, 'utf8').startsWith(`${child.pid} `), 'the live lock is untouched');
  } finally {
    child.kill('SIGKILL');
    await done;
  }
});

test('unclear stays with age: other host, no pid, empty file, own pid', () => {
  const dead = deadPid();
  for (const content of [
    `${dead} some-other-host-than-this ${new Date().toISOString()} token\n`,
    `nopid ${os.hostname()} ${new Date().toISOString()} token\n`,
    '',
    `${process.pid} ${os.hostname()} ${new Date().toISOString()} token\n`,
  ]) {
    const dir = mkTmp('orphan-lock-'); const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, content);
    assert.throws(() => withLock(lock, () => 1, { waitMs: 150, staleS: 120 }), LockTimeoutError, JSON.stringify(content));
    assert.equal(fs.readFileSync(lock, 'utf8'), content, 'untouched');
  }
});

test('four simultaneous takers of an orphan: never two inside at once, all get their turn', async () => {
  for (let round = 0; round < 3; round += 1) {
    const dir = mkTmp('orphan-lock-'); const lock = path.join(dir, 'x.lock');
    const inside = path.join(dir, 'inside'); const go = Date.now() + 400;
    fs.writeFileSync(lock, `${deadPid()} ${os.hostname()} ${new Date().toISOString()} token\n`);
    const kids = [0, 1, 2, 3].map((i) => runChild(`
      import fs from 'node:fs';
      import { withLock } from ${JSON.stringify(LOCK_URL)};
      const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      while (Date.now() < ${go}) {} // common start
      withLock(${JSON.stringify(lock)}, () => {
        fs.writeFileSync(${JSON.stringify(inside)}, '${i}', { flag: 'wx' }); // throws if someone is inside
        nap(60);
        fs.rmSync(${JSON.stringify(inside)});
      }, { waitMs: 5000, staleS: 120 });
      console.log('ok ${i}');
    `));
    const res = await Promise.all(kids.map((k) => k.done));
    for (const [i, r] of res.entries()) assert.equal(r.code, 0, `child ${i}: ${r.out}`);
    assert.ok(!fs.existsSync(lock), 'free at the end');
  }
});
