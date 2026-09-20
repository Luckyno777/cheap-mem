// test/chain-cost.test.mjs — the cost ladder this build exists to fix.
//
// The measurement that opened this build (synthetic drawers, one seal
// each, the OLD `appendSeal` that called `replay(raw)` on the whole
// file every time):
//
//   1000 rows    0.1 MB   seal      9.3 ms
//  10000 rows    1.4 MB   seal     47.3 ms
// 100000 rows   14.3 MB   seal    432.6 ms
// 500000 rows   72.6 MB   seal   2624.3 ms
//
// Linear in FILE size. Extrapolated to the 5 M-row target this plan
// works toward, roughly 26 s per seal — which is why sealing was never
// wired into a live write path on that implementation.
//
// This file re-measures the SAME ladder against the NEW,
// tail-bounded `chain.appendSeal` (see `src/chain.mjs`,
// `recoverWriterTail`) in the shape that actually matters for a live
// write path: NOT "the first seal of an unsealed file" (which is
// unavoidably O(file) exactly once — see `test/chain.test.mjs`'s
// "FIRST SEAL / NO PREDECESSOR" test) but "reseal after a small,
// constant amount of new writes", at each file size. If the fix works,
// this second number stays roughly FLAT across the whole ladder instead
// of climbing with it. If it does not, this test says so plainly
// (see the assertion messages) rather than being loosened to pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as chain from '../src/chain.mjs';

const LADDER = [1000, 10000, 100000, 500000];
const TAIL_ROWS = 50;     // a small, constant amount of new writes between seals

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-chain-cost-'));
}
const away = (root) => fs.rmSync(root, { recursive: true, force: true });

/** One synthetic row, sized in the same class the brief's own ladder
 *  used (~140-150 bytes each, so the byte totals below land close to
 *  the brief's 0.1/1.4/14.3/72.6 MB). */
function row(i, agent = 'w1') {
  return JSON.stringify({
    id: String(i),
    ts: '2026-01-01T00:00:00Z',
    agent,
    title: `synthetic drawer row ${i}`,
    text: 'measuring seal cost against file size, not against the tail',
  });
}

/** Build a file of `n` rows in ONE write (fast: this is fixture setup,
 *  not the thing being measured), by writer `w1` throughout. */
function buildFile(n) {
  const dir = fixtureRoot();
  const file = path.join(dir, 'errors.jsonl');
  const parts = new Array(n);
  for (let i = 0; i < n; i += 1) parts[i] = row(i);
  fs.writeFileSync(file, `${parts.join('\n')}\n`);
  return { dir, file };
}

test('COST LADDER: reseal (constant tail) stays roughly flat as the FILE grows from 1k to 500k rows', () => {
  const results = [];
  try {
    for (const n of LADDER) {
      const { dir, file } = buildFile(n);
      try {
        // Establish a predecessor -- this first seal is the honest,
        // unavoidable O(file) exception (see chain.mjs's own comment on
        // it), NOT what this test is measuring.
        chain.appendSeal(file, 'w1');

        // Now append a SMALL, CONSTANT tail -- the shape every write
        // after the first actually has once sealing is wired in.
        const tail = new Array(TAIL_ROWS);
        for (let i = 0; i < TAIL_ROWS; i += 1) tail[i] = row(`tail-${n}-${i}`);
        fs.appendFileSync(file, `${tail.join('\n')}\n`);

        const t0 = performance.now();
        const seal = chain.appendSeal(file, 'w1');
        const ms = performance.now() - t0;

        const bytes = fs.statSync(file).size;
        results.push({ rows: n, bytes, ms });
        assert.equal(seal.chain_seal.through_id, `tail-${n}-${TAIL_ROWS - 1}`);
      } finally { away(dir); }
    }
  } finally {
    const line = (r) => `  ${String(r.rows).padStart(7)} rows  ${(r.bytes / 1e6).toFixed(1).padStart(6)} MB  ` +
      `reseal (${TAIL_ROWS}-row tail)  ${r.ms.toFixed(2).padStart(8)} ms`;
    console.log([
      '',
      'COST LADDER -- tail-bounded reseal, same file sizes as the brief\'s original measurement:',
      ...results.map(line),
      `  (compare: the OLD file-replaying appendSeal measured 9.3 / 47.3 / 432.6 / 2624.3 ms ` +
      'on the same ladder -- linear in file size)',
      '',
    ].join('\n'));
  }

  assert.equal(results.length, LADDER.length, 'not every rung of the ladder produced a measurement');

  const smallest = results[0].ms;
  const largest = results[results.length - 1].ms;
  // The real claim: cost tracks the TAIL (constant), not the file (500x
  // larger by the last rung). A generous ceiling -- not a tight one --
  // because wall-clock timing on a shared machine is noisy at the
  // millisecond scale; the point is "does not climb by anything like
  // 500x", not "is bit-for-bit identical every run".
  for (const r of results) {
    assert.ok(r.ms < 200,
      `reseal at ${r.rows} rows took ${r.ms.toFixed(2)} ms -- expected flat, low-single-digit-to-tens ` +
      'of milliseconds regardless of file size; if this climbs with `rows`, the tail-bounding fix did ' +
      'not work and this must be reported plainly, not loosened away');
  }
  assert.ok(largest < smallest * 20 || largest < 50,
    `reseal cost grew from ${smallest.toFixed(2)} ms at ${results[0].rows} rows to ${largest.toFixed(2)} ms ` +
    `at ${results[results.length - 1].rows} rows (${(largest / smallest).toFixed(1)}x) across a 500x growth ` +
    'in file size -- that is still growing with the file, not flat with the tail');
});

test('COST: bytesScanned during reseal is bounded by the tail across the same ladder', () => {
  const results = [];
  try {
    for (const n of LADDER) {
      const { dir, file } = buildFile(n);
      try {
        chain.appendSeal(file, 'w1');
        const tail = new Array(TAIL_ROWS);
        for (let i = 0; i < TAIL_ROWS; i += 1) tail[i] = row(`tail-${n}-${i}`);
        fs.appendFileSync(file, `${tail.join('\n')}\n`);

        const chunkSize = 4096;
        const rec = chain.recoverWriterTail(file, 'w1', { chunkSize });
        results.push({ rows: n, bytesScanned: rec.bytesScanned, fileBytes: fs.statSync(file).size });
        assert.equal(rec.sealFound, true);
      } finally { away(dir); }
    }
  } finally {
    console.log('', results.map((r) => `  ${r.rows} rows: file ${r.fileBytes} B, scanned ${r.bytesScanned} B`).join('\n'), '');
  }

  for (const r of results) {
    assert.ok(r.bytesScanned < r.fileBytes / 4,
      `at ${r.rows} rows, recoverWriterTail scanned ${r.bytesScanned} of ${r.fileBytes} file bytes -- ` +
      'that is not bounded by the tail');
  }
  // The real property: scanned bytes should be about the SAME small
  // number at every rung, not proportional to the file.
  const scans = results.map((r) => r.bytesScanned);
  assert.ok(Math.max(...scans) <= Math.min(...scans) * 4,
    `bytesScanned ranged from ${Math.min(...scans)} to ${Math.max(...scans)} across a 500x file-size ` +
    'growth -- expected roughly constant, not growing with the file');
});
