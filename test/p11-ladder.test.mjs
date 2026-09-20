// P11 · `deriveState` reads the WHOLE memory into one array just to
// answer "what is retired" — measured on 2026-09-20 as ~6.4 GB at
// 5,000,000 entries (bauplan figure, 1.33 KB/entry).
//
// The ladder below: 1k / 10k / 100k rows, time and peak RSS, for the OLD
// implementation (`state.deriveStateMaterialized` — kept only as the
// equivalence oracle, see `test/p11-equivalence.test.mjs`) against the
// NEW one (`state.deriveState`, backed by
// `memory.retiredMapFromFiles`). Each rung runs in a fresh child process
// so one measurement's garbage cannot pollute the next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p11-'));
}

/**
 * A drawer with a realistic MIX, not a corpus tuned to make either
 * implementation look good: mostly plain entries, a steady trickle of
 * corrections (`replaces_id`, ~1 in 40) and retirements (`retires_id`,
 * ~1 in 200) — the shape `state.mjs`'s own header comment insists on
 * ("the real corpus this was built for") rather than an all-active
 * corpus that would never exercise `byId` at all.
 */
function buildDecisionDrawer(root, n) {
  const dir = path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  const pad = 'x'.repeat(420);
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const id = `id-${i}`;
    const ts = new Date(2026, 0, 1, 0, 0, i).toISOString();
    if (i > 0 && i % 200 === 0) {
      lines.push(JSON.stringify({
        id: `t-${i}`, ts, retires_id: `id-${i - 5}`, state: 'discarded',
        author: 'bench', authority: 'agent',
      }));
    } else if (i > 0 && i % 40 === 0) {
      lines.push(JSON.stringify({
        id, ts, replaces_id: `id-${i - 10}`, author: 'bench', authority: 'agent',
        topic: 'x', choice: `revision ${i}`, text: pad,
      }));
    } else {
      lines.push(JSON.stringify({
        id, ts, author: 'bench', authority: 'agent',
        topic: 'x', choice: `entry ${i}`, text: pad,
      }));
    }
  }
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

const RUNNER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p11-runner-'));
const RUNNER = path.join(RUNNER_DIR, 'bench-runner.mjs');
function writeRunner() {
  fs.writeFileSync(RUNNER, `
import * as state from ${JSON.stringify(path.join(SRC, 'state.mjs'))};
const [, , root, mode] = process.argv;
if (global.gc) global.gc();
const before = process.memoryUsage().rss;
const t0 = performance.now();
const map = mode === 'old' ? state.deriveStateMaterialized(root) : state.deriveState(root);
const t1 = performance.now();
const after = process.memoryUsage().rss;
process.stdout.write(JSON.stringify({
  ms: t1 - t0, rssDeltaMB: (after - before) / (1024 * 1024), size: map.size,
}));
`, 'utf8');
}

function run(root, mode) {
  writeRunner();
  const out = execFileSync('node', ['--expose-gc', RUNNER, root, mode], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('P11 LADDER — deriveState: materialised array vs streaming, time and peak RSS', () => {
  const rungs = [1000, 10000, 100000];
  const rows = [];
  for (const n of rungs) {
    const root = tmp();
    try {
      buildDecisionDrawer(root, n);
      const oldRun = run(root, 'old');
      const newRun = run(root, 'new');
      rows.push({ n, oldRun, newRun });
      assert.equal(newRun.size, oldRun.size,
        `deriveState and deriveStateMaterialized disagree on the number of retirements at ${n} rows`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  try { fs.rmSync(RUNNER_DIR, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log('\nP11 ladder (deriveStateMaterialized vs deriveState):');
  console.log('rows      old ms   old dRSS MB   new ms   new dRSS MB   retirements');
  for (const r of rows) {
    console.log(
      `${String(r.n).padStart(7)}   ${r.oldRun.ms.toFixed(1).padStart(6)}   `
      + `${r.oldRun.rssDeltaMB.toFixed(2).padStart(10)}   `
      + `${r.newRun.ms.toFixed(1).padStart(6)}   ${r.newRun.rssDeltaMB.toFixed(2).padStart(10)}   `
      + `${r.oldRun.size}`);
  }

  // Memory: the whole point of this build. The new path's peak must be
  // clearly, not marginally, lower once the drawer is not tiny — it
  // never holds the corpus, only a `Set` of referenced ids, a slim
  // projection of each, and the retirement map itself, all of which are
  // small even at 100k rows with a realistic (low) correction density,
  // PLUS bounded per-chunk reads (see `iterLogFile`) instead of the
  // whole file's text at once. Checked at 2x, generously below the
  // ~2.8x actually measured on 2026-09-20, to stay robust on a noisier
  // machine while still catching a real regression.
  const hundredK = rows.find((r) => r.n === 100000);
  assert.ok(hundredK.newRun.rssDeltaMB < hundredK.oldRun.rssDeltaMB / 2,
    `deriveState's peak memory should be well under deriveStateMaterialized's at 100k rows `
    + `(old: ${hundredK.oldRun.rssDeltaMB.toFixed(1)} MB, new: ${hundredK.newRun.rssDeltaMB.toFixed(1)} MB)`);

  // Time: reported honestly, NOT asserted as an improvement. Three
  // sequential file reads instead of one is a real cost, and this build
  // traded it deliberately for the memory result above — see the build
  // report for the exact numbers rather than a hidden regression.
});
