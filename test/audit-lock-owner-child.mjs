// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Helper for test/audit-lock-owner.test.mjs. Not a test: without arguments
// it exits quietly with 0.
//
// Usage: node audit-lock-owner-child.mjs <srcDir> <mode> <args...>
//   hold <lock> <insideFile> <releaseFile>
//       withLock; writes <insideFile> once inside; waits (barrier) for <releaseFile>.
//   idle <insideFile> <releaseFile>
//       NO lock; only a living process (for pid reuse).
//   try <lock> <waitMs>
//       withLock with a short wait; prints JSON { entered, error }.
//   enter <lock> <occupancyDir> <goFile> <id>
//       Barrier: waits for <goFile>, then withLock; inside, claims
//       <occupancyDir>/inside with O_EXCL (EEXIST = violation).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [src, mode, ...a] = process.argv.slice(2);
if (!src || !mode) process.exit(0);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (file, limitMs = 60000) => {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > limitMs) { console.error('barrier never reached: ' + file); process.exit(3); }
    sleep(5);
  }
};
const { withLock } = await import(pathToFileURL(path.join(src, 'filelock.mjs')).href);

if (mode === 'hold') {
  const [lock, inside, release] = a;
  withLock(lock, () => { fs.writeFileSync(inside, 'inside'); waitFor(release); }, { waitMs: 10000 });
} else if (mode === 'idle') {
  const [inside, release] = a;
  fs.writeFileSync(inside, String(process.pid));
  waitFor(release);
} else if (mode === 'try') {
  const [lock, waitMs] = a;
  let entered = false; let error = null;
  try { withLock(lock, () => { entered = true; }, { waitMs: Number(waitMs) }); } catch (e) { error = e.name; }
  console.log(JSON.stringify({ entered, error }));
} else if (mode === 'enter') {
  const [lock, occupancyDir, go, id] = a;
  waitFor(go);
  let violated = false;
  withLock(lock, () => {
    const inside = path.join(occupancyDir, 'inside');
    try { fs.writeFileSync(inside, id, { flag: 'wx' }); } catch { violated = true; }
    for (let i = 0; i < 20; i++) fs.statSync(occupancyDir); // linger briefly inside
    if (!violated) fs.rmSync(inside);
    fs.writeFileSync(path.join(occupancyDir, `done-${id}${violated ? '-VIOLATED' : ''}`), '');
  }, { waitMs: 30000 });
}
