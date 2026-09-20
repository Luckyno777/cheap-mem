// P16 · the durability promise `logEntry` actually makes, proven rather
// than asserted in prose.
//
// `src/memory.mjs`'s `logEntry` ends in a bare `fs.appendFileSync` — no
// `fsync`/`fdatasync`. The comment at that call site states the promise
// this implies: when `logEntry` returns, the line has reached the OS (the
// page cache — a reader opening the same file right after sees it), NOT
// that it has reached the disk. This file is what makes that claim
// checkable instead of trusted: it proves `fsyncSync`/`fsync` is never
// called on the path `logEntry` takes, with a sabotage/positive-control
// pair so a spy that always reports "never called" cannot pass unnoticed.
//
// It also measures the cost the alternative (fsync on every write) would
// have added, since "we chose not to pay for stronger durability" is only
// an honest trade-off if the cost that was avoided is written down as a
// number, not asserted from the gut.
//
// Measured 2026-09-20, median of 15 single-line appends to a mid-size
// (~2.9 MB) drawer:
//
//   fs.appendFileSync alone (no fsync)              ~0.006-0.01 ms
//   open + write + fsyncSync + close                ~0.24-0.29 ms
//
// ~25-30x the bare append, and still nowhere near the 8.91/s ceiling's
// actual cost (see test/p16-append-exponent.test.mjs: the two functions
// that dominate that number, `neighbours.neighbours()` and
// `display.countLines()`, cost tens to hundreds of ms at realistic corpus
// sizes — orders of magnitude past what fsync would add here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as memory from '../src/memory.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-durability-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'p16-durability' }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

/** Spies on `fs.fsyncSync`/`fs.fsync` for the duration of `fn`, then
 * restores them exactly — even if `fn` throws. `fs` is the same module
 * object `src/memory.mjs` imported (Node's module cache is per-process,
 * per-specifier), so reassigning these properties here is visible to
 * `logEntry` too, without touching `src/memory.mjs` itself. */
function withFsyncSpy(fn) {
  const origSync = fs.fsyncSync;
  const origAsync = fs.fsync;
  let syncCalls = 0;
  let asyncCalls = 0;
  fs.fsyncSync = (...args) => { syncCalls += 1; return origSync(...args); };
  fs.fsync = (...args) => { asyncCalls += 1; return origAsync(...args); };
  try {
    fn();
    return { syncCalls, asyncCalls };
  } finally {
    fs.fsyncSync = origSync;
    fs.fsync = origAsync;
  }
}

test('logEntry never calls fsync — the "reached the OS, not the disk" promise is honest', () => {
  const r = root();
  try {
    const { syncCalls, asyncCalls } = withFsyncSpy(() => {
      memory.logEntry(r, 'learning', { title: 'promise check', text: 'no fsync on this path' });
    });
    assert.equal(syncCalls, 0, `fsyncSync was called ${syncCalls} time(s) — the comment at the ` +
      'appendFileSync call site in src/memory.mjs claims it never is; update the comment or the code.');
    assert.equal(asyncCalls, 0, `fsync was called ${asyncCalls} time(s) — same claim, async form.`);
  } finally { away(r); }
});

test('sabotage: the spy actually detects an fsync call, restored exactly after', () => {
  const r = root();
  try {
    // RED: call fsyncSync ourselves inside the spied region, standing in
    // for "logEntry grew an fsync call it should not have" — without
    // editing src/memory.mjs, exactly the way `if (false && ...)` stands
    // in for a code change without touching a file this task must not
    // restructure.
    const { syncCalls } = withFsyncSpy(() => {
      const p = path.join(r, 'sabotage-probe.txt');
      fs.writeFileSync(p, 'x');
      const fd = fs.openSync(p, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    });
    assert.equal(syncCalls, 1, `sabotage did not turn red: spy saw ${syncCalls} call(s), expected 1 — ` +
      'this probe would not have caught a real regression either.');

    // GREEN: the real call, spy restored exactly (withFsyncSpy's finally
    // ran above; this is a fresh, independent spy on the same functions).
    const { syncCalls: real } = withFsyncSpy(() => {
      memory.logEntry(r, 'learning', { title: 'after sabotage', text: 'still no fsync' });
    });
    assert.equal(real, 0, `did not return to green after sabotage: ${real} fsyncSync call(s)`);
  } finally { away(r); }
});

test('the cost fsync would add, measured (not guessed) — the number behind the trade-off', () => {
  const r = root();
  try {
    const p = path.join(r, 'global', 'learnings.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A realistic-size drawer under the writes being timed, so the
    // measurement is not "appending to an empty file".
    const seed = [];
    for (let i = 0; i < 2000; i += 1) {
      seed.push(JSON.stringify({ id: `seed${i}`, ts: new Date().toISOString(), v: 1, title: 'x', text: 'y'.repeat(200) }));
    }
    fs.writeFileSync(p, `${seed.join('\n')}\n`);

    const reps = 15;
    const bareTimes = [];
    for (let i = 0; i < reps; i += 1) {
      const line = `${JSON.stringify({ id: `bare${i}`, ts: new Date().toISOString(), v: 1, title: 'x', text: 'y'.repeat(200) })}\n`;
      const t0 = performance.now();
      fs.appendFileSync(p, line, 'utf8');
      bareTimes.push(performance.now() - t0);
    }
    const fsyncTimes = [];
    for (let i = 0; i < reps; i += 1) {
      const buf = Buffer.from(`${JSON.stringify({ id: `fsy${i}`, ts: new Date().toISOString(), v: 1, title: 'x', text: 'y'.repeat(200) })}\n`, 'utf8');
      const t0 = performance.now();
      const fd = fs.openSync(p, 'a');
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fsyncTimes.push(performance.now() - t0);
    }
    const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const bareMs = median(bareTimes);
    const fsyncMs = median(fsyncTimes);
    // Not pinned to an exact number (machine- and disk-dependent) — just
    // the shape of the trade-off: fsync must cost meaningfully more than
    // a bare append, or this "measured, not guessed" claim is empty.
    assert.ok(fsyncMs > bareMs * 2,
      `expected fsync to cost noticeably more than a bare append; got bare=${bareMs.toFixed(3)} ms, ` +
      `fsync=${fsyncMs.toFixed(3)} ms`);
  } finally { away(r); }
});
