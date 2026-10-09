// Shared helpers for test/filelock*.test.mjs, test/keyring-lock.test.mjs
// and test/drawer-lock.test.mjs. Not a test itself.
//
// Red proof (pinned, never a moving ref): `oldSrc()` extracts `src/` of
// the FIXED commit below — the state BEFORE the lock existed — into a
// temp dir, so each regression test can show that the same scenario
// really loses data there. A regression test that cannot go red on the
// old code measures nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NEW_SRC = path.join(HERE, '..', 'src');
/** The last commit before src/filelock.mjs existed. FIXED on purpose. */
export const PRE_LOCK_COMMIT = '201a087f2d2f634f9b061f4681bd1f78f27408be';

export const mkTmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
export const url = (dir, f) => pathToFileURL(path.join(dir, f)).href;

let oldDir = null;
/** `src/` of PRE_LOCK_COMMIT in a temp dir, or `null` if that commit is not in this clone. */
export function oldSrc() {
  if (oldDir !== null) return oldDir || null;
  try {
    const tmp = mkTmp('prelock-');
    exportCommit(path.join(HERE, '..'), PRE_LOCK_COMMIT, ['src'], tmp);
    oldDir = path.join(tmp, 'src');
  } catch { oldDir = ''; }
  return oldDir || null;
}

/** Run an ES-module script in a child process; resolves `{ code, out }`. */
export function runChild(script, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
  return { child, done };
}

/**
 * A pid no OS can hand out (Linux caps at 2^22, macOS at 99999, Windows
 * uses multiples of 4), so it is dead for good: `kill(pid, 0)` says ESRCH
 * (asserted by `neverAssignedPid`). The pid of a child that has just exited
 * is NOT dead for good: Windows reuses it within milliseconds, and without
 * `/proc` a living pid is verdict `unknown`, never taken over.
 */
export const NEVER_ASSIGNED_PID = 2000000001;
export function neverAssignedPid() {
  try { process.kill(NEVER_ASSIGNED_PID, 0); } catch (e) { if (e && e.code === 'ESRCH') return NEVER_ASSIGNED_PID; throw e; }
  throw new Error(`test set-up: pid ${NEVER_ASSIGNED_PID} must not exist`);
}

/**
 * The pid of a child that has ended, as a "gone" pid -- but only while the OS has not handed it out
 * again. Windows reuses pids within milliseconds (CI windows-latest node 22, 2026-10-09: the pid of
 * an ended child answered "alive"), and there is no start time to tell a reused pid from the old
 * owner. So: `pid` itself if `kill(pid, 0)` says ESRCH right now, else `neverAssignedPid()`, which
 * states the same thing ("this pid is dead") and cannot be reused. The window between this check
 * and the caller's use is microseconds, not the milliseconds a bare child pid leaves open.
 */
export function endedPidOrNeverAssigned(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e && e.code === 'ESRCH') return pid; }
  return neverAssignedPid();
}

export const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Called from INSIDE a monkeypatched read in the parent: wait until the
 * child announced itself (`startedFile`), then give it `graceMs` to
 * finish (`doneFile`). Without a lock the child finishes in that time;
 * with the lock it is stuck behind the parent and the grace runs out.
 */
export function waitForChild(startedFile, doneFile, graceMs = 700) {
  const t0 = Date.now();
  while (!fs.existsSync(startedFile) && Date.now() - t0 < 20000) sleepMs(5);
  const t1 = Date.now();
  while (!fs.existsSync(doneFile) && Date.now() - t1 < graceMs) sleepMs(5);
}
