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
//  - **Age alone is NEVER proof for a takeover (2026-10-06, audit F02).**
//    Until now a lock was taken over after `staleS` even if its owner was
//    alive (mtime 61 s back -> a second process inside the protected
//    section; long critical sections ran concurrently). Now only the
//    OWNER IDENTITY the lock carries decides: pid, host, process start
//    time and boot context. Three verdicts, `unknown` is never `dead`:
//      dead     the pid is gone (ESRCH), a zombie, OR (Linux) the pid is
//               alive with a DIFFERENT start time (pid reused), OR (Linux)
//               the lock comes from another boot. Only then it is taken.
//      alive    (Linux) the pid lives with the same start time. Never taken,
//               however old the lock is: wait, then LockTimeoutError.
//      unknown  another host, another PID namespace (Linux), a lock without
//               start time (old format) whose pid lives, unreadable/empty,
//               EPERM without /proc, and ANY living pid on a platform
//               without /proc. Never taken: wait, then LockTimeoutError
//               naming the owner and the verdict, for a human to look at.
//    PLATFORMS, honestly. The start time (field 22 of `/proc/<pid>/stat`)
//    and the boot context (`boot_id`, PID namespace) exist only on Linux.
//    On macOS and Windows there is no `/proc`: a pid that is gone (ESRCH)
//    still counts as dead and is taken over at once; a pid that lives can
//    be the owner or a reused pid and cannot be told apart, so the verdict
//    is `unknown` and the lock is never taken (safe, but a lock whose owner
//    died and whose pid got reused there needs a human). `staleS` stays as
//    an option only for compatibility and for the message (the age is
//    shown); it is never a reason to take over, except through
//    `takeOverIfStale`, which is for markers (see there).
//  - **Semantics: ONE HOST (and one PID namespace) only.** The lock is a
//    local file; its proof that the owner lives is a local pid. On a
//    network/cloud file system shared by several hosts it does NOT protect:
//    a foreign host is `unknown` and never taken over (safe, but without
//    self-healing). Multi-host use needs a real lease protocol; that is not
//    built here and not claimed.
//  - **Every removal of someone else's lock goes through the takeover
//    bar `<lock>.takeover` (2026-10-02).** Finding: four simultaneous
//    takers of an orphan — two processes inside at once. The old takeover
//    renamed the lock away and linked it back if the content was not the
//    one judged dead. But rename checks no content: B renamed A's FRESH
//    lock away, meanwhile C linked its own lock into the empty name, B's
//    link back failed with EEXIST, B deleted A's lock — A and C inside.
//    Now the bar is created atomically (link/O_EXCL, like the lock); only
//    its holder reads the lock content AGAIN and removes the lock with
//    unlink if it still is exactly the one judged dead/stale. While the
//    lock exists nobody can create it; only the bar holder removes it
//    (and its owner on release, also under the bar) — so no rename-away
//    and put-back any more, no deleting someone else's lock. The bar is
//    held for one read + stat + unlink (microseconds). An orphaned bar
//    (its holder died in exactly that window) is broken after
//    `TAKEOVER_ORPHAN_S` — see there.
//  - **The lock file is never empty.** It is written under a temporary
//    name and attached with `link` (fails atomically with EEXIST, like
//    `wx`). With `wx`, a SIGKILL between create and write could leave an
//    EMPTY lock — no pid, so not recognisable as orphaned (seen once in the
//    same run as "owner: unknown"). Without hard links it falls back to `wx`.
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

/** Start time (ticks since boot, field 22) from /proc/<pid>/stat as text; `null` without /proc or if unreadable. */
function processStart(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // from field 3 (state)
  const t = rest[19]; // field 22
  return /^[0-9]+$/.test(t ?? '') ? t : null;
}

/** Boot context: boot_id and PID namespace, `boot/ns`; missing parts as `-` (no /proc: `-/-`). */
function bootContext() {
  let boot = '-';
  let ns = '-';
  try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || '-'; } catch { /* no /proc */ }
  try { ns = fs.readlinkSync('/proc/self/ns/pid').replace(/[^0-9A-Za-z:\[\]]/g, '') || '-'; } catch { /* no /proc */ }
  return `${boot}/${ns}`;
}

/** Line: `pid host iso start context token` (the token is always last). */
function ownerText(token) {
  return `${process.pid} ${os.hostname()} ${new Date().toISOString()} ${processStart(process.pid) ?? '-'} ${bootContext()} ${token}\n`;
}

/** Error codes where `link` cannot work by design: fall back to `wx`. */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EACCES']);

/**
 * Create the lock file atomically, WITH its content: write it under a
 * temporary name, then `link` it to the lock name (EEXIST if one is
 * there — atomic like `wx`). There is no moment in which the lock exists
 * empty. `true` = got it, `false` = it exists. Other errors throw.
 */
function createLock(lockPath, token) {
  const text = ownerText(token);
  const write = (p) => fs.writeFileSync(p, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const tmp = `${lockPath}.new-${process.pid}-${token}`;
  try {
    try {
      write(tmp);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
      // Directory missing: create it only now, not on every call (a
      // recursive mkdir per lock was a measurable part of the cost).
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      write(tmp);
    }
  } catch {
    return createLockPlain(lockPath, write);
  }
  try {
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    if (!e || !NO_LINK.has(e.code)) throw e;
    return createLockPlain(lockPath, write);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* a crumb, harmless */ }
  }
}

/** The plain `wx` create, for when the link route is not available. */
function createLockPlain(lockPath, write) {
  try {
    try {
      write(lockPath);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      write(lockPath);
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
 * Age (seconds) after which a takeover bar counts as orphaned. The bar is
 * held for one read + stat + unlink of a single small file —
 * microseconds, milliseconds under load. 10 s is more than a thousand
 * times that: a holder standing that long has died (or was stopped,
 * SIGSTOP), it is not slow. Shorter than `DEFAULT_STALE_S` (60 s), so an
 * orphaned bar never blocks longer than an orphaned lock would anyway; by
 * age and not by pid, because a bar can only be orphaned in that tiny
 * window and age knows no pid reuse.
 */
export const TAKEOVER_ORPHAN_S = 10;

/** The takeover bar belonging to a lock. */
export function takeoverPath(lockPath) { return `${lockPath}.takeover`; }

/**
 * Break an orphaned bar (older than `TAKEOVER_ORPHAN_S`). Through rename,
 * and the age is checked on the renamed file (rename keeps mtime). No bar
 * above the bar: breaking one is only needed after a death inside the
 * microsecond window. `true` = the bar is gone, try to create it again.
 */
function breakOrphanedBar(bar) {
  const age = lockAgeS(bar);
  // A MISSING bar (`Infinity`) has nothing to break: create it again. Never
  // treat it as ancient — the rename would then hit the fresh bar someone
  // just created (seen in the stress probe: two bar holders, a bar left behind).
  if (age === Infinity) return true;
  if (age <= TAKEOVER_ORPHAN_S) return false;
  // A living bar holder (SIGSTOP, slow) is never broken; only dead or
  // unknown (old format, other host) plus age breaks it.
  if (ownerVerdict(readOwner(bar)) === 'alive') return false;
  const grave = `${bar}.orphan-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { fs.renameSync(bar, grave); } catch { return false; }
  const moved = lockAgeS(grave);
  if (moved <= TAKEOVER_ORPHAN_S) {
    try { fs.linkSync(grave, bar); } catch { /* best effort */ }
  }
  try { fs.rmSync(grave, { force: true }); } catch { /* fine */ }
  return moved > TAKEOVER_ORPHAN_S;
}

/**
 * Run `fn` under the takeover bar. `{ got, result }`; if the bar cannot be
 * had within `waitMs`, `got: false` and `fn` did not run. Never throws
 * except from `fn`.
 */
function underBar(lockPath, fn, waitMs = 0) {
  const bar = takeoverPath(lockPath);
  const token = randomBytes(6).toString('hex');
  const deadline = Date.now() + waitMs;
  let delay = 1;
  for (;;) {
    let got = false;
    try { got = createLock(bar, token); } catch { return { got: false, result: undefined }; }
    if (!got && breakOrphanedBar(bar)) continue;
    if (got) {
      try {
        return { got: true, result: fn() };
      } finally {
        if (readOwner(bar).endsWith(` ${token}`)) releaseLock(bar);
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { got: false, result: undefined };
    sleepMs(Math.min(delay, left));
    delay = Math.min(delay * 2, 20);
  }
}

/**
 * Remove the lock if, under the bar, it still carries exactly `content`
 * and `stillValid()` agrees. `true` means it is gone (removed by us or
 * already vanished) and the caller may create it again.
 */
function removeUnderBar(lockPath, content, stillValid = () => true) {
  const { got, result } = underBar(lockPath, () => {
    if (lockAgeS(lockPath) === Infinity) return true; // already gone
    if (readOwner(lockPath) !== content || !stillValid()) return false; // a different one by now
    try { fs.unlinkSync(lockPath); } catch (e) { return Boolean(e && e.code === 'ENOENT'); }
    return true;
  });
  return got && result === true;
}

/**
 * FOR MARKERS, NOT FOR MUTEX LOCKS (audit F02): take over a lock/marker
 * only if it is older than `staleS` — without looking at the owner. Meant
 * for the rebuild marker (`component-table.mjs`), where a double run is
 * harmless and the owner ends on purpose. `withLock` does NOT use it any
 * more. `true` means
 * the lock is gone (taken away or already vanished) and the caller may
 * try to create it again. Never removes a fresh lock on purpose. Removal
 * happens only under the takeover bar, and only of the same lock (same
 * content) whose age was checked — checked there once more.
 */
export function takeOverIfStale(lockPath, staleS) {
  const content = readOwner(lockPath);
  const age = lockAgeS(lockPath);
  if (age === Infinity) return true; // vanished meanwhile
  if (age <= staleS) return false;
  return removeUnderBar(lockPath, content, () => lockAgeS(lockPath) > staleS);
}

/**
 * Verdict on the owner of a lock: `'dead'`, `'alive'` or `'unknown'` (rules
 * in the header comment, including the platform differences). Only
 * `'dead'` allows a takeover. Never throws.
 */
export function ownerVerdict(content) {
  const parts = String(content ?? '').trim().split(/\s+/);
  if (parts.length < 4) return 'unknown';
  const [pidText, host] = parts;
  if (!/^[1-9][0-9]{0,9}$/.test(pidText)) return 'unknown';
  if (host !== os.hostname()) return 'unknown'; // one host only
  const pid = Number(pidText);
  // New format: pid host iso start context token (6 parts). Old format: 4.
  const newFormat = parts.length >= 6;
  const start = newFormat ? parts[3] : '-';
  const context = newFormat ? parts[4] : '-';
  if (context !== '-') {
    const [boot, ns] = context.split('/');
    const [myBoot, myNs] = bootContext().split('/');
    if (boot !== '-' && myBoot !== '-' && boot !== myBoot) return 'dead'; // other boot: process is gone
    if (ns !== '-' && myNs !== '-' && ns !== myNs) return 'unknown'; // pid from another namespace
  }
  try { process.kill(pid, 0); } catch (e) {
    if (e && e.code === 'ESRCH') return 'dead'; // all platforms
    // EPERM: alive, someone else's: the start time below decides
  }
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch {
    // No readable /proc/<pid>/stat (macOS, Windows, hidepid, or just gone):
    // without a start time there is no proof. unknown, never dead.
    return 'unknown';
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  if (state === 'Z' || state === 'X') return 'dead'; // zombie / dead
  if (start === '-') return 'unknown'; // old format, pid lives: reuse cannot be ruled out
  return processStart(pid) === start ? 'alive' : 'dead'; // other start time = reused pid
}

/**
 * Take a lock over if its holder is provably dead (see `ownerVerdict`). `true` means the lock is gone and the caller may create
 * it again. Removal happens only under the takeover bar and only if the
 * lock there still carries EXACTLY the content judged dead (its token is
 * unique: same content = the same dead lock).
 */
function takeOverIfOrphaned(lockPath) {
  const content = readOwner(lockPath);
  if (!content || ownerVerdict(content) !== 'dead') return false;
  return removeUnderBar(lockPath, content);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long a release waits for the takeover bar, milliseconds. */
const BAR_RELEASE_WAIT_MS = 200;

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
    if (takeOverIfOrphaned(lockPath)) continue;
    const left = deadline - Date.now();
    if (left <= 0) {
      const owner = readOwner(lockPath);
      const age = lockAgeS(lockPath);
      throw new LockTimeoutError(
        `lock '${lockPath}' still held after ${waitMs} ms (owner: ${owner || 'unknown'}, `
        + `verdict: ${ownerVerdict(owner)}, age: ${age === Infinity ? '?' : Math.round(age)} s). `
        + 'Age alone never releases a lock; only a provably dead owner is replaced '
        + '(pid + start time, this host only). On "unknown" (other host, old format, no /proc, unreadable) '
        + 'please look, and remove the lock file by hand only if the owner is surely gone.');
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
    // Only remove the lock if it is still OURS (it may have been taken over
    // as stale) — and under the takeover bar, so no taker hits a successor
    // between its check and its unlink. If the bar cannot be had (orphaned),
    // as before without it.
    const release = () => {
      if (readOwner(lockPath).endsWith(` ${token}`)) releaseLock(lockPath);
    };
    if (!underBar(lockPath, release, BAR_RELEASE_WAIT_MS).got) release();
  }
  if (result && typeof result.then === 'function') {
    throw new TypeError('withLock: fn must be synchronous — the lock is already released when a promise settles.');
  }
  return result;
}
