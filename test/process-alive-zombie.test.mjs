// test/process-alive-zombie.test.mjs - a zombie process does not live
// (port of lucky-mem `prozess-zombie`, `nachlese-sperre-zombie`, 2026-10-03).
//
// Reason: `process.kill(pid, 0)` also succeeds for a <defunct> process (ended,
// not collected by its parent). In the sibling house such a zombie held a night
// run's lock for eleven hours. The two places here that decide "alive" by that
// signal: the file lock's orphan takeover (`src/filelock.mjs`) and the doctor's
// running-code check (`src/doctor.mjs`).
//
// Red proof: the OLD way (the bare signal) reports the very zombie of this test
// as alive; the lock probe below waits out its time on the old rule. Positive
// controls: a living pid still blocks the lock and a gone pid is still taken over.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { processAlive } from '../src/processalive.mjs';
import { withLock, LockTimeoutError } from '../src/filelock.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';
const hasProc = fs.existsSync('/proc/self/stat');
const oldAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A real zombie: bash starts a short child, then replaces itself by `sleep`, which never collects it.
 * No timing assumptions (mirror of the sibling's 1231e4b6): the parent lives until the probe ends
 * it (it used to `exec sleep 5`; whoever waited longer saw the init already reap the zombie), and
 * the state Z is awaited for 60 s instead of 50 x 50 ms. The message names the last /proc state seen.
 */
async function zombie() {
  let stderr = '';
  const parent = spawn('bash', ['-c', 'sleep 0 & echo $!; exec sleep 600'], { stdio: ['ignore', 'pipe', 'pipe'] });
  parent.stderr.on('data', (d) => { stderr += d; });
  const pid = await new Promise((resolve) => parent.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  let is = false;
  let last = '(never read)';
  const deadline = Date.now() + 60_000;
  while (!is && Date.now() < deadline) {
    try { last = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (e) { last = `unreadable: ${e.code}`; break; }
    is = /\) Z /.test(last);
    if (!is) pause(50);
  }
  if (!is) parent.kill('SIGKILL'); // the parent no longer ends by itself
  assert.ok(is, `test set-up: the child is a zombie (last /proc/${pid}/stat: ${last.slice(0, 120)}; stderr: ${stderr})`);
  return { pid, drop: () => parent.kill('SIGKILL') };
}

const lockWith = (dir, pid) => {
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, `${pid} ${os.hostname()} 2026-10-03T00:00:00Z feedfacefeed\n`);
  return lock;
};

test('a zombie: the old rule says alive (red), processAlive says dead', { skip: !hasProc && 'no /proc' }, async () => {
  const z = await zombie();
  try {
    assert.equal(oldAlive(z.pid), true, 'RED PROOF: the bare signal holds the zombie for alive');
    assert.equal(processAlive(z.pid), false, 'a zombie does not live');
  } finally { z.drop(); }
});

test('positive control: a running process lives; an ended or invalid pid does not', () => {
  assert.equal(processAlive(process.pid), true);
  const r = spawnSync('bash', ['-c', 'echo $$']);
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(processAlive(Number(String(r.stdout).trim())), false);
  for (const bad of [0, -3, 1.5, NaN, undefined, '12']) assert.equal(processAlive(bad), false);
});

test('a file lock held by a zombie is taken over at once, not waited out', { skip: !hasProc && 'no /proc' }, async (t) => {
  const dir = tempDir('cm-zombie-lock-', t);
  const z = await zombie();
  try {
    const lock = lockWith(dir, z.pid);
    const t0 = Date.now();
    const got = withLock(lock, () => 'ran', { waitMs: 3000, staleS: 3600 });
    assert.equal(got, 'ran');
    assert.ok(Date.now() - t0 < 2000, 'the zombie lock was waited out');
  } finally { z.drop(); }
});

test('positive control: a lock held by a LIVING pid still blocks; one held by a gone pid is taken over', (t) => {
  const dir = tempDir('cm-living-lock-', t);
  const alive = lockWith(dir, process.ppid);
  assert.throws(() => withLock(alive, () => 'ran', { waitMs: 200, staleS: 3600 }), LockTimeoutError);
  const r = spawnSync('bash', ['-c', 'echo $$']);
  const gone = path.join(dir, 'y.lock');
  fs.writeFileSync(gone, `${Number(String(r.stdout).trim())} ${os.hostname()} 2026-10-03T00:00:00Z feedfacefeed\n`);
  assert.equal(withLock(gone, () => 'ran', { waitMs: 3000, staleS: 3600 }), 'ran');
});

test('RED PROOF for the lock: at the base commit the same zombie lock times out (positive control: today it does not)', { skip: !hasProc && 'no /proc' }, async (t) => {
  const tmp = tempDir('cm-zombie-base-', t);
  const tar = execFileSync('git', ['archive', BASE, 'src', 'package.json'], { cwd: REPO, maxBuffer: 1 << 28 });
  assert.equal(spawnSync('tar', ['-x', '-C', tmp], { input: tar }).status, 0);
  const old = await import(pathToFileURL(path.join(tmp, 'src', 'filelock.mjs')).href);
  const dir = tempDir('cm-zombie-base-lock-', t);
  const z = await zombie();
  try {
    assert.throws(() => old.withLock(lockWith(dir, z.pid), () => 'ran', { waitMs: 300, staleS: 3600 }), old.LockTimeoutError,
      'the base took the zombie lock over');
    fs.rmSync(path.join(dir, 'x.lock'));
    assert.equal(withLock(lockWith(dir, z.pid), () => 'ran', { waitMs: 3000, staleS: 3600 }), 'ran');
  } finally { z.drop(); }
});
