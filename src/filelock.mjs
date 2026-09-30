// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/filelock.mjs — one small leaf lock for read-modify-write on a file.
//
// **The finding this answers (2026-09-30, reproduced).** Three places
// read a file, changed it in memory and wrote the whole thing back with
// no lock: the keyring (`shred.mjs` putKey/destroyKey) and a drawer
// rewrite (`shardarchive.mjs` archiveOldest). Two writers holding stale
// snapshots lose a key, resurrect a destroyed one, or drop a line that
// was appended in between. The fix is one lock that all of them use.
//
// **Shape.** `withLock(lockPath, fn, { waitMs, staleS })` runs `fn`
// while holding an exclusive lock file at `lockPath`.
//
//  - The lock is created with `O_EXCL` (`flag: 'wx'`): atomic, and the
//    content is readable — pid, host, time and a private token — so a
//    session that looks can see WHOSE lock it is. The pid/host pair is
//    for people; ownership is decided by the token, never by the pid.
//  - **Bounded waiting.** A held lock is retried with a short, growing
//    sleep until `waitMs` has passed, then `LockTimeoutError` is thrown.
//    Never an unbounded wait.
//  - **A stale lock is taken over only by age** (mtime older than
//    `staleS`), and never by deleting it blindly: the file is first
//    renamed away (atomic — only one taker wins that rename) and its age
//    is checked on the renamed file. A fresh lock is never taken.
//  - **Leaf locks only.** Taking a lock while this process already holds
//    one throws `NestedLockError`. Not reentrant, on purpose: with only
//    leaf locks two processes can never wait on each other's second
//    lock, so no deadlock can be built from these.
//  - The lock is released only if its token is still ours; if `fn` ran
//    past `staleS` and someone took the lock over, we do not delete
//    their lock.
//
// `tryLock`/`lockAgeS`/`releaseLock` are the low-level pieces, exported
// for the one caller that hands a lock to a detached child
// (`component-table.mjs` background rebuild), so the O_EXCL/age logic
// lives in this one file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Default bound on waiting for a held lock, milliseconds. */
export const DEFAULT_WAIT_MS = 5000;
/** Default age (seconds) after which an untouched lock file counts as dead. */
export const DEFAULT_STALE_S = 60;

export class LockTimeoutError extends Error {
  constructor(message) { super(message); this.name = 'LockTimeoutError'; this.code = 'ELOCKTIMEOUT'; }
}
export class NestedLockError extends Error {
  constructor(message) { super(message); this.name = 'NestedLockError'; this.code = 'ELOCKNESTED'; }
}

/** Age of the lock file in seconds, or `Infinity` if it is missing/unreadable. Never throws. */
export function lockAgeS(lockPath) {
  let st;
  try { st = fs.statSync(lockPath); } catch { return Infinity; }
  return (Date.now() - st.mtimeMs) / 1000;
}

function ownerText(token) {
  return `${process.pid} ${os.hostname()} ${new Date().toISOString()} ${token}\n`;
}

/** Create the lock file atomically. `true` = got it, `false` = it exists. Other errors throw. */
function createLock(lockPath, token) {
  const write = () => fs.writeFileSync(lockPath, ownerText(token),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    try {
      write();
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
      // Directory missing: create it only now, not on every call (a
      // recursive mkdir per lock was a measurable part of the cost).
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      write();
    }
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Non-throwing variant of the create step: `true` means THIS call got
 * the lock; `false` means it was already there — or could not be
 * created, conservatively the same answer.
 */
export function tryLock(lockPath) {
  try { return createLock(lockPath, randomBytes(6).toString('hex')); } catch { return false; }
}

/** Remove the lock file unconditionally. Never throws. For a lock this caller knows is its own or dead. */
export function releaseLock(lockPath) {
  try { fs.rmSync(lockPath, { force: true }); } catch { /* it expires by age anyway */ }
}

function readOwner(lockPath) {
  try { return fs.readFileSync(lockPath, 'utf8').trim(); } catch { return ''; }
}

/**
 * Take over a lock file only if it is older than `staleS`. `true` means
 * the lock is gone (taken away or already vanished) and the caller may
 * try to create it again. Never removes a fresh lock on purpose.
 */
export function takeOverIfStale(lockPath, staleS) {
  const age = lockAgeS(lockPath);
  if (age === Infinity) return true; // vanished meanwhile
  if (age <= staleS) return false;
  const grave = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { fs.renameSync(lockPath, grave); } catch { return false; } // someone else moved it first
  // rename keeps mtime, so this is the age of the file we actually moved.
  const moved = lockAgeS(grave); // Infinity if unreadable: then it is ours to drop
  if (moved <= staleS) {
    // We moved a lock that was replaced by a fresh one in the meantime:
    // put it back (fails harmlessly if yet another lock exists by now).
    try { fs.linkSync(grave, lockPath); } catch { /* best effort */ }
    try { fs.rmSync(grave, { force: true }); } catch { /* fine */ }
    return false;
  }
  try { fs.rmSync(grave, { force: true }); } catch { /* fine */ }
  return true;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let heldPath = null; // per-process guard: at most one lock at a time

/** The lock this process currently holds through `withLock`, or `null`. */
export function heldLock() { return heldPath; }

/**
 * Run `fn` (synchronous) while holding the lock at `lockPath` and
 * return its result. Throws `LockTimeoutError` after `waitMs`,
 * `NestedLockError` if this process already holds a lock.
 */
export function withLock(lockPath, fn, { waitMs = DEFAULT_WAIT_MS, staleS = DEFAULT_STALE_S } = {}) {
  if (heldPath !== null) {
    throw new NestedLockError(
      `withLock('${lockPath}') while already holding '${heldPath}': only leaf locks are allowed `
      + '(no nesting, no re-entry).');
  }
  const token = randomBytes(6).toString('hex');
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let delay = 2;
  for (;;) {
    if (createLock(lockPath, token)) break;
    if (takeOverIfStale(lockPath, staleS)) continue;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new LockTimeoutError(
        `lock '${lockPath}' still held after ${waitMs} ms (owner: ${readOwner(lockPath) || 'unknown'}); `
        + `a lock older than ${staleS} s would be taken over.`);
    }
    sleepMs(Math.min(delay, left));
    delay = Math.min(delay * 2, 50);
  }
  heldPath = lockPath;
  let result;
  try {
    result = fn();
  } finally {
    heldPath = null;
    // Only remove the lock if it is still OURS (it may have been taken over as stale).
    if (readOwner(lockPath).endsWith(` ${token}`)) releaseLock(lockPath);
  }
  if (result && typeof result.then === 'function') {
    throw new TypeError('withLock: fn must be synchronous — the lock is already released when a promise settles.');
  }
  return result;
}
