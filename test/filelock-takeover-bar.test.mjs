// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/filelock.mjs — the takeover bar (2026-10-02).
//
// Finding (full suite, filelock-orphan "four simultaneous takers"): two
// processes inside the lock at once. Sequence: A and B both read content C
// of the dead lock. A renames it away, creates its lock LA and is inside.
// B renames LA away (rename checks no content), sees content != C and
// wants to link it back — meanwhile a third process linked its own lock
// into the empty name, B's link fails with EEXIST, B deletes LA: A and the
// third are inside. The same pattern stood in the takeover by age.
//
// Now only the holder of `<lock>.takeover` removes someone else's lock,
// after reading it again, with unlink.
//
// Red proof (2026-10-02, measured, not in this test): the stress probe
// below (8 takers x 20 rounds) on 95ce820 was red in 4 of 30 idle runs and
// 2 of 5 runs under load (EEXIST on the 'inside' marker); with the bar 0
// of 15. In lucky-mem the same probe was red 10 of 10. In the test the red
// proof is deterministic: "a fresh bar blocks" fails on the pinned old
// state (the old code ignores the bar and takes over at once).
//
// Finding (2026-10-09, CI windows-latest node 20, twice before as well): the
// 8 x 20 probe was red with "two inside at once (or timeout)", and the
// lines were all `ELOCKTIMEOUT ... verdict: unknown`, owner = the untouched
// orphan: NO overlap. The orphan's pid came from a child that had just
// exited; Windows reuses pids at once, and without `/proc` a living pid is
// `unknown` and never taken over (src/filelock.mjs, "PLATFORMS"). A product
// property, documented, not a lock failure. So: (1) the orphans now carry a
// pid no OS can hand out, (2) the probe tells OVERLAP (a real failure) from
// TIMEOUT (lock never acquired) from ERROR, and says which one it was.
// Red proof (Linux, same picture): the previous version of this test with
// `deadPid()` returning a LIVE pid fails with exactly those TIMEOUT lines;
// the control "a taker that never gets the lock ..." keeps the split honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NEW_SRC, HERE, mkTmp, url, runChild } from './filelock-fixtures.mjs';
import { withLock, LockTimeoutError, takeoverPath, TAKEOVER_ORPHAN_S } from '../src/filelock.mjs';

const LOCK_URL = url(NEW_SRC, 'filelock.mjs');
/** The state BEFORE the bar. FIXED on purpose. */
const PRE_BAR_COMMIT = '95ce820bcd641dded4923051f5befd11f297ec36';

/**
 * A pid that is dead AND STAYS dead. A pid taken from a child that has just
 * exited does not: Windows hands freed pids out again within milliseconds,
 * and without `/proc` a LIVING pid is verdict `unknown` and never taken
 * over (header of src/filelock.mjs, "PLATFORMS"). CI saw exactly that twice
 * on windows-latest (2026-10-08 round 9 and 10, 2026-10-09 round 2): the
 * orphan's pid had been reused by another process, all eight takers ran
 * into `LockTimeoutError` (verdict unknown, owner = the untouched orphan),
 * never into an overlap. A pid above every OS's pid range cannot be
 * reused: Linux caps at 2^22, macOS at 99999, Windows hands out multiples
 * of 4 only; `kill(pid, 0)` answers ESRCH on all three (asserted below).
 */
const NEVER_ASSIGNED_PID = 2000000001;
function deadPid() {
  assert.throws(() => process.kill(NEVER_ASSIGNED_PID, 0), { code: 'ESRCH' }, 'probe: the pid must really be dead');
  return NEVER_ASSIGNED_PID;
}
const orphan = (lock, token = 'token', pid = deadPid()) => fs.writeFileSync(lock, `${pid} ${os.hostname()} ${new Date().toISOString()} ${token}\n`);
const foreignBar = (lock) => fs.writeFileSync(takeoverPath(lock), `1 other-host ${new Date().toISOString()} foreign\n`);

/**
 * N children, R rounds; each round its own orphan, all children start it
 * at the same moment. Inside, each child creates the marker 'inside<k>'
 * with O_EXCL — EEXIST means two inside at once. `bare`: no withLock
 * (positive control — the probe must be able to see an overlap).
 *
 * The probe tells three outcomes apart, because they mean different things:
 *  - `overlap`  : two inside at once. A REAL lock failure.
 *  - `timeout`  : a taker never got the lock within its bound (`LockTimeoutError`),
 *                 nobody was inside twice. Not a lock failure; the lock stayed
 *                 closed (e.g. the orphan's owner counts as alive/unknown).
 *  - `error`    : anything else thrown out of `withLock` (EPERM, EBUSY ...).
 * `ownerPid(k)`: the pid written into round k's orphan (default: a dead one).
 */
async function stress({ n, rounds, bare = false, waitMs = 5000, ownerPid = () => deadPid() }) {
  const dir = mkTmp('takeoverbar-');
  for (let k = 0; k < rounds; k += 1) orphan(path.join(dir, `x${k}.lock`), `token${k}`, ownerPid(k));
  const gap = 250; const start = Date.now() + 700 + n * 50;
  const kids = Array.from({ length: n }, (_, i) => runChild(`
    import fs from 'node:fs';
    import { withLock } from ${JSON.stringify(LOCK_URL)};
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (let k = 0; k < ${rounds}; k++) {
      while (Date.now() < ${start} + k * ${gap}) {} // common start
      const inside = ${JSON.stringify(dir)} + '/inside' + k;
      const body = () => {
        try { fs.writeFileSync(inside, '${i}', { flag: 'wx' }); }
        catch (e) { if (e && e.code === 'EEXIST') { console.log('OVERLAP ' + k + ' ${i}'); return; } throw e; }
        sleep(3); fs.rmSync(inside);
      };
      try {
        ${bare ? 'body();' : `withLock(${JSON.stringify(dir)} + '/x' + k + '.lock', body, { waitMs: ${waitMs}, staleS: 120 });`}
      } catch (e) {
        const kind = e && e.code === 'ELOCKTIMEOUT' ? 'TIMEOUT' : 'ERROR';
        console.log(kind + ' ' + k + ' ${i} ' + (e.code || '') + ' ' + String(e.message).split('\\n')[0]);
      }
    }
  `));
  const res = await Promise.all(kids.map((k) => k.done));
  for (const [i, r] of res.entries()) assert.equal(r.code, 0, `child ${i}: ${r.out}`);
  const lines = res.flatMap((r) => r.out.split('\n'));
  const pick = (tag) => lines.filter((l) => l.startsWith(`${tag} `));
  return { overlap: pick('OVERLAP'), timeout: pick('TIMEOUT'), error: pick('ERROR'), left: fs.readdirSync(dir) };
}

test('positive control: without the lock the probe sees an overlap', async () => {
  const { overlap } = await stress({ n: 8, rounds: 2, bare: true });
  assert.ok(overlap.length > 0, 'no overlap seen: the probe cannot see two inside at once');
});

test('positive control: a taker that never gets the lock is reported as a timeout, NOT as an overlap', async () => {
  // The orphan's owner is a LIVE process on this host (this test process): never taken over (src/filelock.mjs).
  // Same picture as a pid reused on Windows. A short bound only keeps the control fast; the real probe below keeps 5000.
  const { overlap, timeout, error, left } = await stress({ n: 3, rounds: 2, waitMs: 300, ownerPid: () => process.pid });
  assert.deepEqual(overlap, [], 'nobody got in, so nobody can be inside twice');
  assert.deepEqual(error, []);
  assert.equal(timeout.length, 3 * 2, `every taker of every round times out: ${timeout.join(' | ')}`);
  assert.ok(left.includes('x0.lock') && left.includes('x1.lock'), 'the live-owned locks stay');
});

test('eight simultaneous takers x 20 rounds: never two inside at once, nothing left behind', async () => {
  const { overlap, timeout, error, left } = await stress({ n: 8, rounds: 20 });
  assert.deepEqual(overlap, [], 'TWO INSIDE AT ONCE: a real lock failure');
  assert.deepEqual(timeout, [], 'no overlap, but a taker ran out of its 5000 ms bound: the lock was never acquired (owner verdict is in the line)');
  assert.deepEqual(error, [], 'withLock threw something other than a timeout');
  assert.deepEqual(left, [], 'no lock, no bar, no grave/temp file left');
});

/** A fresh bar blocks the takeover. */
async function barProbe(lockUrl) {
  const dir = mkTmp('takeoverbar-'); const lock = path.join(dir, 'x.lock');
  orphan(lock);
  const before = fs.readFileSync(lock, 'utf8');
  foreignBar(lock);
  const r = await runChild(`
    import { withLock } from ${JSON.stringify(lockUrl)};
    try { withLock(${JSON.stringify(lock)}, () => {}, { waitMs: 300, staleS: 120 }); console.log('TAKEN'); }
    catch (e) { console.log('TIMEOUT ' + e.code); }
  `).done;
  return { out: r.out.trim(), untouched: fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === before };
}

test('a fresh takeover bar blocks: the orphan stays, a taker waits out its bound', async () => {
  const { out, untouched } = await barProbe(LOCK_URL);
  assert.equal(out, 'TIMEOUT ELOCKTIMEOUT');
  assert.ok(untouched, 'the orphan is untouched while someone else holds the bar');
});

test('red proof (pinned old state): there the taker takes over despite a foreign bar', async (t) => {
  let oldFile;
  try {
    oldFile = path.join(mkTmp('takeoverbar-old-'), 'filelock.mjs');
    fs.writeFileSync(oldFile, execFileSync('git', ['-C', path.join(HERE, '..'), 'show', `${PRE_BAR_COMMIT}:src/filelock.mjs`]));
  } catch { t.skip(`commit ${PRE_BAR_COMMIT} is not in this clone`); return; }
  const { out, untouched } = await barProbe(url(path.dirname(oldFile), 'filelock.mjs'));
  assert.equal(out, 'TAKEN');
  assert.ok(!untouched);
});

test(`an orphaned bar (older than ${TAKEOVER_ORPHAN_S} s) is broken and the orphan taken over at once`, () => {
  const dir = mkTmp('takeoverbar-'); const lock = path.join(dir, 'x.lock');
  orphan(lock);
  foreignBar(lock);
  const old = new Date(Date.now() - (TAKEOVER_ORPHAN_S + 2) * 1000);
  fs.utimesSync(takeoverPath(lock), old, old);
  const t0 = Date.now();
  assert.equal(withLock(lock, () => 'ran', { waitMs: 2000, staleS: 120 }), 'ran');
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(fs.readdirSync(dir), [], 'lock, bar and grave gone');
});

test('a bar just under the limit still counts as held', () => {
  const dir = mkTmp('takeoverbar-'); const lock = path.join(dir, 'x.lock');
  orphan(lock);
  foreignBar(lock);
  const recent = new Date(Date.now() - (TAKEOVER_ORPHAN_S - 2) * 1000);
  fs.utimesSync(takeoverPath(lock), recent, recent);
  assert.throws(() => withLock(lock, () => 1, { waitMs: 200, staleS: 120 }), LockTimeoutError);
  assert.ok(fs.existsSync(lock));
});

test('an ancient lock of another host is never taken over (age is no proof, audit F02)', () => {
  const dir = mkTmp('takeoverbar-'); const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, `${process.ppid} other-host ${new Date().toISOString()} foreign\n`);
  assert.throws(() => withLock(lock, () => 1, { waitMs: 150, staleS: 5 }), LockTimeoutError, 'fresh: never taken');
  const old = new Date(Date.now() - 30000);
  fs.utimesSync(lock, old, old);
  assert.throws(() => withLock(lock, () => 2, { waitMs: 150, staleS: 5 }), LockTimeoutError, 'ancient: still never');
  assert.deepEqual(fs.readdirSync(dir), ['x.lock']);
});

test('release while someone else holds the bar: free after a short wait anyway (as before)', () => {
  const dir = mkTmp('takeoverbar-'); const lock = path.join(dir, 'x.lock');
  const t0 = Date.now();
  withLock(lock, () => { foreignBar(lock); });
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(!fs.existsSync(lock), 'own lock released');
  assert.ok(fs.existsSync(takeoverPath(lock)), 'foreign bar untouched');
});
