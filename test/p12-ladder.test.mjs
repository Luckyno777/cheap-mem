// P12 · `readLog` materialises the whole drawer.
//
// This file does two things the build brief asked for explicitly:
//
//   1. THE LADDER — 1k / 10k / 100k rows, time and peak RSS, for the
//      OLD shape (`readLog`: parse every line into one array) against
//      the NEW shape (`iterLog`: a generator a caller can stop early).
//      Run in a fresh child process per measurement so one rung's
//      garbage cannot pollute the next one's RSS reading.
//   2. IDENTITY — `readLog` itself was not touched at all (see
//      `src/memory.mjs`), so this locks that down: its result today is
//      exactly what it returned before this build, on the same corpus.
//
// The point-lookup functions this build moved onto `iterLog`
// (`getEntry`, `findEntryLocation`, `retireEntry`, `correctionEntry`)
// already have behavioural coverage in `test/memory.test.mjs` and
// `test/lifecycle.test.mjs`, which pass unchanged — this file's job is
// the MEASUREMENT, not re-proving correctness those suites already own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p12-'));
}

/** One `errors.jsonl`, N rows, ~500 bytes each — a realistic entry
 * width, not the 42-word-vocabulary mistake this house's own header
 * comments warn against repeating. */
function buildErrorDrawer(root, n) {
  const dir = path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  const pad = 'x'.repeat(420);
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      id: `id-${i}`,
      ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      author: 'bench', authority: 'agent',
      class: i % 97 === 0 ? 'rare-class' : 'common-class',
      title: `synthetic entry ${i}`,
      text: pad,
    }));
  }
  fs.writeFileSync(path.join(dir, 'errors.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

// The runner script lives in ITS OWN mkdtemp directory, never inside the
// repo checkout — this clone is shared by several agents at once, and a
// fixed filename in the working tree would be a race the moment two of
// them run this file together.
const RUNNER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p12-runner-'));
const RUNNER = path.join(RUNNER_DIR, 'bench-runner.mjs');
function writeRunner() {
  fs.writeFileSync(RUNNER, `
import * as memory from ${JSON.stringify(path.join(SRC, 'memory.mjs'))};
const [, , root, mode, lastId] = process.argv;
if (global.gc) global.gc();
const before = process.memoryUsage().rss;
const t0 = performance.now();
let result;
if (mode === 'readLog-full') {
  result = memory.readLog(root, 'error', {}).entries.length;
} else if (mode === 'getEntry-first') {
  result = memory.getEntry(root, 'id-0') ? 1 : 0;
} else if (mode === 'getEntry-last') {
  result = memory.getEntry(root, lastId) ? 1 : 0;
}
const t1 = performance.now();
const after = process.memoryUsage().rss;
process.stdout.write(JSON.stringify({
  ms: t1 - t0, rssDeltaMB: (after - before) / (1024 * 1024), result,
}));
`, 'utf8');
}

function run(root, mode, lastId = '') {
  writeRunner();
  const out = execFileSync('node', ['--expose-gc', RUNNER, root, mode, lastId], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('P12 LADDER — readLog vs iterLog-based point lookup, time and peak RSS', () => {
  const rungs = [1000, 10000, 100000];
  const rows = [];
  for (const n of rungs) {
    const root = tmp();
    try {
      buildErrorDrawer(root, n);
      const lastId = `id-${n - 1}`;
      const full = run(root, 'readLog-full');
      const first = run(root, 'getEntry-first');
      const last = run(root, 'getEntry-last', lastId);
      rows.push({ n, full, first, last });
      assert.equal(full.result, n, `readLog must still see all ${n} rows`);
      assert.equal(first.result, 1);
      assert.equal(last.result, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  try { fs.rmSync(RUNNER_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log('\nP12 ladder (readLog full-materialisation vs iterLog-based getEntry):');
  console.log('rows      readLog ms   readLog dRSS MB   getEntry(first) ms/dRSS   getEntry(last) ms/dRSS');
  for (const r of rows) {
    console.log(
      `${String(r.n).padStart(7)}   ${r.full.ms.toFixed(1).padStart(9)}   `
      + `${r.full.rssDeltaMB.toFixed(2).padStart(14)}   `
      + `${r.first.ms.toFixed(2).padStart(6)} / ${r.first.rssDeltaMB.toFixed(2).padStart(6)}          `
      + `${r.last.ms.toFixed(2).padStart(6)} / ${r.last.rssDeltaMB.toFixed(2).padStart(6)}`);
  }

  // `iterLogFile` reads in bounded chunks (see its own comment in
  // `memory.mjs`), so an early match's memory is bounded by the chunk
  // size, not by the drawer — this is checked generously (10x, not the
  // ~100x actually measured on 2026-09-20) to stay robust to a noisier
  // machine while still catching a real regression.
  const hundredK = rows.find((r) => r.n === 100000);
  assert.ok(hundredK.first.rssDeltaMB < hundredK.full.rssDeltaMB / 10,
    `an early match should cost far less memory than materialising all 100k rows `
    + `(readLog: ${hundredK.full.rssDeltaMB.toFixed(1)} MB, getEntry-first: `
    + `${hundredK.first.rssDeltaMB.toFixed(1)} MB)`);
  // The worst case (wanted id is the very last line) still has to read
  // and parse every line — but chunked reading means even THAT case
  // stays well under materialising everything, because it never holds
  // more than one chunk plus the small number of ids/objects the caller
  // itself keeps. Checked at a more modest margin (2x) since this case
  // does the same JSON.parse work as `readLog`, just without keeping it.
  assert.ok(hundredK.last.rssDeltaMB < hundredK.full.rssDeltaMB / 2,
    `even the worst case (last line) should cost less memory than materialising all 100k rows `
    + `(readLog: ${hundredK.full.rssDeltaMB.toFixed(1)} MB, getEntry-last: `
    + `${hundredK.last.rssDeltaMB.toFixed(1)} MB)`);
});

test('P12 IDENTITY — readLog is untouched: same corpus, same result as before', () => {
  const root = tmp();
  try {
    buildErrorDrawer(root, 250);
    // A broken line and a missing-file case belong in the identity
    // check too — both were part of readLog's contract before this
    // build and neither line of its own code changed.
    fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'), 'not json at all\n', 'utf8');
    const { entries, missing, path: p } = memory.readLog(root, 'error');
    assert.equal(missing, false);
    assert.equal(path.basename(p), 'errors.jsonl');
    assert.equal(entries.length, 251);
    assert.equal(entries[0].id, 'id-0');
    assert.equal(entries[249].id, 'id-249');
    assert.deepEqual(entries[250], { __broken: true, raw: 'not json at all' });

    const missingType = memory.readLog(root, 'thought');
    assert.deepEqual(missingType.entries, []);
    assert.equal(missingType.missing, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
