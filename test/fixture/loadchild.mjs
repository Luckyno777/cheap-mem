/**
 * loadchild.mjs -- load children (CPU eaters) on a double leash.
 *
 * Failure record 3rmr30wgcgjn (lucky-mem, 2026-10-13): four child processes
 * `node -e 'let x = 0; while (true) { x += Math.sqrt(x + 1); }'` from a load
 * probe kept running for 9.5 days on a CI runner (PPID 1, 2.7 GB each) and
 * held the machine at 100 % CPU for a week. The cleanup stood in the test's
 * `finally` only; when the test process is ended hard (a cancelled CI job, a
 * timeout, SIGKILL) `finally` never runs.
 *
 * Anyone who needs a child that REALLY computes uses `startLoadChildren()`
 * (or `loadChildSource()` when the source text goes into a fixture file or a
 * `node -e` argument). The child carries two leashes, both INSIDE the loop --
 * a timer would be useless, the loop blocks the event loop:
 *
 *   (a) HARD MAXIMUM LIFETIME: after `maxLifetimeMs` the child ends itself.
 *       Default and upper bound: 60 s (MAX_LIFETIME_MS); a caller may set it
 *       shorter, longer is clamped to 60 s.
 *   (b) PARENT LEASH: every `CHECK_EVERY` iterations the child checks that
 *       its parent still lives: `process.ppid` against the parent PID given
 *       at start (else the one seen at start), plus `process.kill(parent, 0)`.
 *       If the ppid changed (the child was re-parented to PID 1 or a
 *       subreaper) or the parent PID is gone, the child exits at once.
 *
 * The lifetime runs on the monotonic clock (`process.hrtime`), not the wall clock, which can jump (NTP, DST). `checkEvery`
 * is capped at CHECK_EVERY_MAX, so a huge value cannot switch the parent leash off. A child the probe spawns by itself
 * goes under the same cleanup with `watch(child)`.
 *
 * In the parent process there is also the cleanup the old shape had (`stop()`
 * in a `finally`), plus a `process.on('exit')` cleanup that kills every load
 * child of this process still alive. On SIGTERM/SIGINT/SIGHUP the helper
 * cleans up as well and then passes the signal on. On SIGKILL nothing runs in
 * the parent any more; there the parent leash (b) carries alone.
 *
 * A ratchet (test/loadchild-ratchet.test.mjs) refuses new endless-loop
 * literals in test/ and bench/ that do not come from here and carry no
 * `loadchild-ok: <reason>` exemption.
 *
 * Pure helper: no side effects on load (test/fixture scripts must exit 0 when
 * run bare).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Hard upper bound of a load child's lifetime, in ms. */
export const MAX_LIFETIME_MS = 60000;

/** Iterations between two leash checks (one block takes well under 1 ms). */
export const CHECK_EVERY = 20000;

/** Upper bound for `checkEvery` (about 15 ms of work): a huge value must not switch the parent leash off. */
export const CHECK_EVERY_MAX = 1000000;

/**
 * One rule for both tunables: a number (or numeric string) of at least 1 is floored and capped at `max` -- Infinity
 * and anything above `max` become `max`; NaN, non-numeric input, 0, negatives and fractions below 1 become `fallback`.
 * No input can switch a leash off or make it nonsensical.
 */
function clampPositive(value, fallback, max) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Source text for `node -e` or a module file: computes until a leash snaps,
 * then exits 0.
 *
 * @param {object} [o]
 * @param {number} [o.maxLifetimeMs] default and upper bound: MAX_LIFETIME_MS (0, negative, NaN, text: the default)
 * @param {number} [o.parent] parent PID; without it the ppid seen at start
 * @param {number} [o.checkEvery] iterations per check (default CHECK_EVERY, at most CHECK_EVERY_MAX; 0, negative, NaN: the default)
 */
export function loadChildSource({ maxLifetimeMs = MAX_LIFETIME_MS, parent, checkEvery = CHECK_EVERY } = {}) {
  const lifetime = clampPositive(maxLifetimeMs, MAX_LIFETIME_MS, MAX_LIFETIME_MS);
  const every = clampPositive(checkEvery, CHECK_EVERY, CHECK_EVERY_MAX);
  const parentText = Number.isInteger(parent) && parent > 0 ? String(parent) : 'process.ppid';
  return [
    `const PARENT = ${parentText};`,
    `const DEADLINE = process.hrtime.bigint() + ${lifetime}000000n;`, // monotonic clock: a wall clock can jump (NTP, DST)
    'let x = 0;',
    'for (;;) {',
    `  for (let i = 0; i < ${every}; i += 1) x += Math.sqrt(x + 1);`,
    '  if (process.ppid !== PARENT) process.exit(0);',
    '  try { process.kill(PARENT, 0); } catch { process.exit(0); }',
    '  if (process.hrtime.bigint() >= DEADLINE) process.exit(0);',
    '}',
    '',
  ].join('\n');
}

// --- cleanup in the parent process ------------------------------------------

const alive = new Set();
let wired = false;

function killAll() {
  for (const k of alive) {
    try { k.kill('SIGKILL'); } catch { /* already gone */ }
  }
  alive.clear();
}

function wire() {
  if (wired) return;
  wired = true;
  process.on('exit', killAll);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handler = () => {
      killAll();
      process.removeListener(sig, handler);
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

/** Puts a child the probe started itself under the same exit/signal cleanup as the helper's own children. */
export function watch(child) {
  wire();
  child.on('exit', () => alive.delete(child));
  alive.add(child);
  return child;
}

/**
 * Starts `count` load children on the double leash.
 * @returns {{ children: import('node:child_process').ChildProcess[], pids: number[], stop: () => void }}
 */
export function startLoadChildren(count, { maxLifetimeMs = MAX_LIFETIME_MS, checkEvery } = {}) {
  wire();
  const source = loadChildSource({ maxLifetimeMs, parent: process.pid, checkEvery });
  const children = [];
  for (let i = 0; i < count; i += 1) {
    const k = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
    // A load child never keeps the parent alive: the exit cleanup must get its chance.
    k.unref();
    children.push(watch(k));
  }
  return {
    children,
    pids: children.map((k) => k.pid),
    stop() {
      for (const k of children) {
        try { k.kill('SIGKILL'); } catch { /* already gone */ }
        alive.delete(k);
      }
    },
  };
}

/** CPU time (user + system) of a process in ms from /proc, or null when not measurable -- never an invented 0. */
export function cpuTimeMs(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(f[11]) + Number(f[12]); // utime, stime (fields 14, 15)
    return Number.isFinite(ticks) ? ticks * 10 : null; // 100 ticks per second
  } catch { return null; }
}

/** Start time of a process (ticks since boot, /proc/<pid>/stat field 22) or null: tells it apart from a recycled PID. */
export function startTime(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}

/** Does the process live (signal 0)? A zombie counts as dead. */
export function isAlive(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2, s.lastIndexOf(')') + 3) !== 'Z';
  } catch { return true; }
}
