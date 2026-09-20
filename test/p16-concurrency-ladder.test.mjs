// P16 · N concurrent writers on one drawer — throughput and correctness,
// across a real ladder (1, 2, 4, 8, 16), as real OS processes.
//
// `src/environment.mjs`'s `checkAppendAtomicity` / `runAppendAtomicityProbe`
// already measures whether concurrent O_APPEND is safe on this mount (worker
// threads, one round, sized for a `mem doctor` budget) — this file does not
// build a second instrument for that question. What it adds is the thing
// the brief for this build point asks for and that probe does not report:
// a THROUGHPUT ladder over real, separate processes (worker threads still
// share one Node process and one event loop; the P16 question is what
// several independent AGENTS running as separate processes actually get),
// with the same torn/missing/duplicate accounting `analyzeAppendProbe` uses,
// reused in shape here rather than re-derived.
//
// Every writer calls the real `memory.logEntry()` — not a bare
// `fs.appendFileSync` — against ONE shared `learning` drawer, so this is
// the actual write path's concurrent behaviour, not an idealised one.
// Lines are padded past PIPE_BUF (4096 B): below that, an atomic append is
// the easy case every filesystem gets right (see the same note in
// `test/concurrent-append.test.mjs`).
//
// Measured 2026-09-20, 4 cores, tmpfs-backed /tmp, 30 entries/writer,
// ~6 KB/line:
//
//   N   wall ms   entries/s   torn   missing   duplicates
//   1      88       341         0       0          0
//   2      88       682         0       0          0
//   4     103      1165         0       0          0
//   8     186      1290         0       0          0
//  16     385      1247         0       0          0
//
// Zero torn/missing/duplicate lines at every rung: concurrent appends are
// already safe on this filesystem, consistent with `checkAppendAtomicity`'s
// own finding (POSIX O_APPEND under a size limit is atomic on a local
// filesystem — ext4/tmpfs/etc, see environment.mjs). Throughput scales
// through 8 writers, then flattens/dips at 16 against the 4-core ceiling —
// contention on the single shared file/CPU, not corruption. This is the
// number the bauplan's second proposed repair for P16 (shard by writer,
// so there is no shared file to contend on) would remove, not something
// this file fixes: sharding means editing `src/cli/commands/write.mjs`'s
// dispatch and adding a shard-path function to `src/memory.mjs`, out of
// this build point's actual bottleneck (see p16-append-exponent.test.mjs)
// and, for the write.mjs half, out of this build's file scope.
//
// The numbers in the comment above are ONE run on one machine; the
// invariant this file actually enforces is torn === 0 && missing === 0 &&
// duplicates === 0 at every rung, plus the positive control below, which
// exists so a probe that always reports "clean" cannot pass unnoticed.
//
// invariant: leer-ist-kein-bestehen
// invariant: drei-zustaende-nie-zwei

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A file:// URL, not a bare path — see the same note in
// concurrent-append.test.mjs: an ESM specifier is a URL, and a Windows
// path is not one.
const MEMORY = pathToFileURL(path.join(HERE, '..', 'src', 'memory.mjs')).href;

const PER_WRITER = 20;
const PAD = 6000; // past PIPE_BUF (4096 B on Linux)
const LADDER = [1, 2, 4, 8, 16];

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-ladder-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'p16-ladder' }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

// The real path: N processes, each calling the exported logEntry() with a
// marker this file can count back out of the drawer afterwards.
const REAL_WRITER = `
import { logEntry } from ${JSON.stringify(MEMORY)};
const [, , root, id, count, pad] = process.argv;
const filler = 'x'.repeat(Number(pad));
for (let i = 0; i < Number(count); i += 1) {
  logEntry(root, 'learning', { title: 'w' + id + '-' + i, text: 'marker:w' + id + 'e' + i + ':' + filler });
}
`;

// The positive control: same shape, but read-whole-file -> append in
// memory -> write-whole-file instead of O_APPEND. Raced against itself
// this MUST lose entries — proving `analyze()` below can tell a corrupted
// drawer from a clean one, not just report "clean" no matter what happened.
const LOSSY_WRITER = `
import fs from 'node:fs';
const [, , filePath, id, count, pad] = process.argv;
const filler = 'x'.repeat(Number(pad));
for (let i = 0; i < Number(count); i += 1) {
  const line = JSON.stringify({ text: 'marker:w' + id + 'e' + i + ':' + filler });
  let before = '';
  try { before = fs.readFileSync(filePath, 'utf8'); } catch { /* first writer */ }
  fs.writeFileSync(filePath, before + line + '\\n', 'utf8');
}
`;

function writeScript(dir, name, src) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, src);
  return p;
}

function runWriters(scriptPath, args, n) {
  const kinder = Array.from({ length: n }, (_, i) => spawn(
    process.execPath, [scriptPath, ...args(i)], { stdio: ['ignore', 'ignore', 'pipe'] },
  ));
  return Promise.all(kinder.map((k, i) => new Promise((ok, fail) => {
    let err = '';
    k.stderr.on('data', (b) => { err += b; });
    k.on('error', (e) => fail(new Error(`writer ${i} would not start: ${e.message}`)));
    k.on('close', (code, signal) => (code === 0
      ? ok()
      : fail(new Error(`writer ${i} exited ${code}${signal ? ` (${signal})` : ''}`
        + `${err ? `: ${err.trim().split('\n').slice(0, 4).join(' / ')}` : ''}`))));
  })));
}

/** Torn (unparseable), missing and duplicated markers in a JSONL file —
 * the same three-way accounting `analyzeAppendProbe` in `src/environment.mjs`
 * uses for the same property, reused in shape rather than re-derived. */
function analyze(filePath, expectedCount) {
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { /* nothing written at all */ }
  const rows = text.split('\n').filter((l) => l.trim().length > 0);
  let torn = 0;
  const seen = new Map();
  for (const row of rows) {
    let entry;
    try { entry = JSON.parse(row); } catch { torn += 1; continue; }
    const m = /marker:(w\S+?e\d+):/.exec(entry?.text ?? '');
    if (!m) { torn += 1; continue; }
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const duplicates = [...seen.values()].filter((c) => c > 1).length;
  const missing = Math.max(expectedCount - seen.size, 0);
  return { ok: torn === 0 && duplicates === 0 && missing === 0, torn, missing, duplicates, found: seen.size, rows: rows.length };
}

test('N real concurrent writers (1,2,4,8,16) through the real write path: no torn, missing or duplicated lines', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-scripts-'));
  const script = writeScript(dir, 'real-writer.mjs', REAL_WRITER);
  const table = [];
  try {
    for (const n of LADDER) {
      const r = root();
      try {
        const drawer = path.join(r, 'global', 'learnings.jsonl');
        const t0 = Date.now();
        await runWriters(script, (i) => [r, String(i), String(PER_WRITER), String(PAD)], n);
        const wallMs = Date.now() - t0;
        const expected = n * PER_WRITER;
        const result = analyze(drawer, expected);
        table.push({ n, wallMs, entriesPerSec: (expected / wallMs) * 1000, ...result, expected });
        assert.equal(result.torn, 0, `n=${n}: ${result.torn} torn line(s) — a write was corrupted`);
        assert.equal(result.missing, 0, `n=${n}: ${result.missing} missing of ${expected} — writes were lost`);
        assert.equal(result.duplicates, 0, `n=${n}: ${result.duplicates} duplicated marker(s)`);
      } finally { away(r); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // Not measurable is not zero: print the table the report is built from,
  // so a reader does not have to trust a bare "ok".
  t.diagnostic(`P16 concurrency ladder: ${JSON.stringify(table)}`);
});

test('sabotage: the positive control (read-modify-write) actually loses entries under the same race', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-scripts-'));
  const script = writeScript(dir, 'lossy-writer.mjs', LOSSY_WRITER);
  const n = 8;
  const drawerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-lossy-'));
  const drawer = path.join(drawerDir, 'unsafe.jsonl');
  fs.writeFileSync(drawer, '');
  try {
    await runWriters(script, (i) => [drawer, String(i), String(PER_WRITER), String(PAD)], n);
    const expected = n * PER_WRITER;
    const result = analyze(drawer, expected);
    assert.ok(
      !result.ok,
      `the read-modify-write control kept all ${expected} entries clean (torn=${result.torn}, `
      + `missing=${result.missing}, duplicates=${result.duplicates}). The writers did not overlap, `
      + 'so the ladder test above measured a sequential run and its green says nothing about '
      + 'concurrency. Raise PER_WRITER or PAD until this control corrupts again.',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(drawerDir, { recursive: true, force: true });
  }
});

test('an entry crosses the size where append atomicity stops being promised', () => {
  assert.ok(PAD > 4096, `PAD is ${PAD}; PIPE_BUF is 4096. Below that an atomic append is the easy case.`);
});
