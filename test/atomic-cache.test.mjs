// The search cache is written beside its path and renamed into place.
//
// **Why this exists.** `loadIndex` caches the built index as one JSON
// file, and the retrieval hook reads that same path — in parallel, on
// every prompt. A writer that calls `writeFileSync` straight onto the
// target leaves a window in which the file on disk is half of one
// version: `JSON.parse` throws, the caller silently falls back to a
// full rebuild, and inside a hook a full rebuild means the time limit
// and no output. Silent, intermittent, and impossible to reproduce by
// reading the code.
//
// Measured on the sibling house with the identical shape: a reader in a
// tight loop caught broken JSON in 2 to 6 of roughly 600 reads, three
// runs, reproducibly. `rename` closes it — POSIX makes the swap atomic,
// so a reader sees the old file or the new one and never the seam.
//
// Three assertions:
//
//   P  positive control: the NAIVE write really does tear, here, on
//      this machine. Without it, "no tear found" means nothing.
//      Measured 2026-09-17, three runs: 2000, 2000 and 1996 torn reads
//      out of 2000. Deliberately harsher than production — a writer
//      thread that does nothing but rewrite three megabytes is not a
//      realistic load. A control's job is to prove the instrument can
//      see the thing at all, and near-saturation is what makes it do
//      that on a slow machine as well as a fast one.
//   A  the rename-based write does not tear, over many more reads than
//      the control needed to find its first one.
//   B  the shipped writer has that shape: it renames, and never writes
//      onto the cache path itself. P and A measure a copy of the
//      pattern; B is what notices if the real one loses it.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Two payloads big enough that a write is not one instruction.
 *
 * The real cache of a grown memory is megabytes; a few hundred bytes
 * would be written well inside a single scheduler slice and the control
 * would find nothing — a probe that is quiet because the experiment was
 * too small is the exact defect this file is about.
 */
const BIG = 3 * 1024 * 1024;

/**
 * The writer runs in another THREAD, not in this one.
 *
 * The first cut of this probe looped writer and reader in one event
 * loop, alternating with `setImmediate`. It found zero torn reads —
 * necessarily, because `writeFileSync` blocks the thread it runs on:
 * the reader could not possibly observe a half-written file, whatever
 * the writer did. That version would have gone green with the bug fully
 * present. The tear is a race between two OS threads, so the experiment
 * needs two.
 */
const WRITER = `
import fs from 'node:fs';
import { workerData } from 'node:worker_threads';
const { target, mode, size, stop } = workerData;
const flag = new Int32Array(stop);
const A = JSON.stringify({ tag: 'A', pad: 'a'.repeat(size) });
const B = JSON.stringify({ tag: 'B', pad: 'b'.repeat(size) });
let n = 0;
while (Atomics.load(flag, 0) === 0) {
  const text = (n += 1) % 2 ? B : A;
  if (mode === 'naive') fs.writeFileSync(target, text);
  else {
    const tmp = target + '.' + process.pid + '.' + n + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  }
}
Atomics.store(flag, 1, n);
`;

/**
 * Hammer one path from another thread and count what the reader sees.
 *
 * Driven by COUNTS and by what was seen — never by a clock. Five probes
 * in this codebase's history waited a fixed number of milliseconds for
 * something to happen, and a fixed wait is green on a fast machine
 * whatever the code does. The deadline here is a brake against a hang,
 * not the measurement; when it fires the caller is told so, rather than
 * handed a number that looks like a result.
 */
async function hammer(target, mode, { reads }) {
  const stop = new SharedArrayBuffer(8);
  const flag = new Int32Array(stop);
  const worker = new Worker(WRITER, {
    eval: true,
    workerData: { target, mode, size: BIG, stop },
  });
  const done = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });

  const seen = { torn: 0, ok: 0, missing: 0, other: 0 };
  const DEADLINE = Date.now() + 60000;

  // Wait for the FIRST file, not for a number of milliseconds. Starting
  // a worker and building a three-megabyte string takes long enough
  // that a reader let loose immediately burns its whole budget on a
  // path that does not exist yet — and reports a clean run.
  try {
    while (!fs.existsSync(target) && Date.now() < DEADLINE) {
      await new Promise((r) => setImmediate(r));
    }
  } catch { /* the loop below reports a missing file as such */ }

  try {
    while (seen.ok + seen.torn + seen.missing + seen.other < reads
      && Date.now() < DEADLINE) {
      let text;
      try { text = fs.readFileSync(target, 'utf8'); } catch { seen.missing += 1; continue; }
      try {
        const tag = JSON.parse(text).tag;
        if (tag === 'A' || tag === 'B') seen.ok += 1;
        else seen.other += 1;
      } catch { seen.torn += 1; }
      // Yield, so the reader is not one uninterrupted burst of syscalls.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    Atomics.store(flag, 0, 1);
  }
  await done;
  return { ...seen, writes: Atomics.load(flag, 1), timedOut: Date.now() >= DEADLINE };
}

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-cache-'));
  return path.join(dir, name);
}

test('P positive control: the naive write tears, here, on this machine', async () => {
  const target = scratch('naive.json');
  const r = await hammer(target, 'naive', { reads: 2000 });
  assert.ok(r.torn > 0,
    'the naive write never tore in ' +
    `${r.ok + r.torn + r.missing + r.other} reads over ${r.writes} writes ` +
    `(timedOut=${r.timedOut}). Then this file measures nothing, and ` +
    'assertion A below is green for the wrong reason. Do not weaken A ' +
    '— make the payload bigger or the experiment longer.');
});

test('A the rename-based write never tears', async () => {
  const target = scratch('renamed.json');
  const r = await hammer(target, 'renamed', { reads: 2000 });
  assert.ok(!r.timedOut,
    `the experiment ran out of time at ${r.ok + r.torn} reads — no verdict`);
  assert.equal(r.torn, 0,
    `${r.torn} torn reads out of ${r.ok + r.torn + r.missing + r.other} — rename is ` +
    'not doing what this whole change rests on');
  assert.equal(r.missing, 0,
    `${r.missing} reads found no file at all — rename never unlinks the ` +
    'target, so a reader must never see a gap either');
  assert.equal(r.other, 0, `${r.other} reads parsed but held neither payload`);
  assert.ok(r.ok >= 2000, `only ${r.ok} clean reads, expected the full budget`);
});

test('B the shipped writer renames, and never writes onto the cache path', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'search.mjs'), 'utf8');
  const start = src.indexOf('const writeCache =');
  assert.ok(start > 0, 'writeCache is gone or renamed — re-point this probe');
  const end = src.indexOf('\n  };', start);
  assert.ok(end > start, 'could not find the end of writeCache');
  const body = src.slice(start, end);

  assert.match(body, /fs\.renameSync\(\s*tmpPath\s*,\s*cachePath\s*\)/,
    'writeCache no longer renames its scratch file into place');
  assert.match(body, /fs\.writeFileSync\(\s*tmpPath\s*,/,
    'writeCache no longer writes to a scratch file');
  assert.doesNotMatch(body, /fs\.writeFileSync\(\s*cachePath\s*,/,
    'writeCache writes straight onto the cache path again — that is the ' +
    'tear assertion P reproduces');
});
