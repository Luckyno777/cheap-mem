// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Audit F04 (2026-10-06): read errors must not look like an empty or complete store.
//
// The finding: a directory in the place of a log file gave "present, empty"; an
// EIO after the first chunk delivered only the beginning, unmarked; a bounded
// tail read reported "whole file scanned" with an empty list on any error.
// Now the states are distinguishable:
//   missing (ENOENT/ENOTDIR)         -> missing: true, empty
//   empty (file there, 0 lines)      -> missing: false, empty
//   read with a broken line          -> __broken entry (counted, never dropped)
//   NOT READABLE (EISDIR/EACCES/EIO) -> memory.ReadError (code, path, partial)
// Red proof against a FIXED old state (git archive).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as doctor from '../src/doctor.mjs';
import * as neighbours from '../src/neighbours.mjs';
import * as dashboard from '../src/dashboard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// FIXED state before the change (never a moving ref).
const OLD = '4bbca612f0f087aec290ff7fbe210f0ecd2b42b0';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-readerr-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
let counter = 0;
function newRoot() {
  const w = path.join(tmp, `w${++counter}`);
  fs.mkdirSync(path.join(w, 'global'), { recursive: true });
  fs.mkdirSync(path.join(w, 'projects'), { recursive: true });
  return w;
}
const drawer = (w, type = 'decision') => memory.logPath(w, type, null);
const row = (i) => JSON.stringify({ id: `x${i}`, ts: '2026-01-01T00:00:00Z', title: `t${i}`, pad: 'p'.repeat(60) });
const FORTY = `${Array.from({ length: 40 }, (_, i) => row(i)).join('\n')}\n`;

let oldMemory;
async function oldMem() {
  if (oldMemory !== undefined) return oldMemory;
  try {
    const d = path.join(tmp, 'old'); fs.mkdirSync(d);
    exportCommit(REPO, OLD, ['src', 'package.json'], d);
    // eslint-disable-next-line require-atomic-updates -- memoised import; a second caller would store the same module
    oldMemory = await import(pathToFileURL(path.join(d, 'src', 'memory.mjs')).href);
  // eslint-disable-next-line require-atomic-updates -- memoised import; a second caller would store the same module
  } catch { oldMemory = null; }
  return oldMemory;
}
const eio = () => { const x = new Error('EIO: i/o error, read'); x.code = 'EIO'; return x; };
function withBrokenRead(afterChunks, fn) {
  const orig = fs.readSync; let k = 0;
  fs.readSync = (...a) => { k += 1; if (k > afterChunks) throw eio(); return orig(...a); };
  try { return fn(); } finally { fs.readSync = orig; }
}

test('states are distinguishable: missing, empty, read, broken line', () => {
  const w = newRoot();
  const missing = memory.iterLog(w, 'decision');
  assert.equal(missing.missing, true);
  assert.deepEqual([...missing], []);
  assert.equal(memory.readLog(w, 'decision').missing, true);
  assert.equal(memory.tailEntries(w, 'decision').missing, true);
  fs.writeFileSync(drawer(w), '');
  const empty = memory.iterLog(w, 'decision');
  assert.equal(empty.missing, false);
  assert.deepEqual([...empty], []);
  assert.equal(memory.readLog(w, 'decision').missing, false);
  assert.equal(memory.tailEntries(w, 'decision').missing, false);
  // a broken line and a fragment at the file end are both counted, never dropped
  fs.writeFileSync(drawer(w), `${row(1)}\n{"broken\n${row(2)}\n{"frag`);
  assert.equal([...memory.iterLog(w, 'decision')].filter((e) => e.__broken).length, 2);
  assert.equal(memory.readLog(w, 'decision').entries.filter((e) => e.__broken).length, 2);
  assert.equal(memory.tailEntries(w, 'decision').entries.filter((e) => e.__broken).length, 2);
  // ENOTDIR (the parent is a file) counts as missing
  const w2 = newRoot(); fs.rmSync(path.join(w2, 'global'), { recursive: true }); fs.writeFileSync(path.join(w2, 'global'), 'x');
  assert.equal(memory.readLog(w2, 'decision').missing, true);
});

test('a directory in the place of the log: ReadError EISDIR, not "present and empty"', () => {
  const w = newRoot(); fs.mkdirSync(drawer(w));
  const g = memory.iterLog(w, 'decision');
  assert.equal(g.missing, false);
  assert.throws(() => [...g], (e) => e instanceof memory.ReadError && e.code === 'EISDIR' && e.path === drawer(w));
  assert.throws(() => memory.readLog(w, 'decision'), (e) => e instanceof memory.ReadError && e.code === 'EISDIR');
  assert.throws(() => memory.tailEntries(w, 'decision'), (e) => e instanceof memory.ReadError && e.code === 'EISDIR');
});

test('red proof: the old state takes a directory for an empty file (and a failing tail read for complete)', async (t) => {
  const old = await oldMem();
  if (!old) return t.skip('fixed old state not in this clone');
  const w = newRoot(); fs.mkdirSync(drawer(w));
  assert.deepEqual([...old.iterLog(w, 'decision')], [], 'old: silently empty');
  const tail = old.tailEntries(w, 'decision');
  assert.equal(tail.scannedWholeFile, true);
  assert.deepEqual(tail.entries, [], 'old: "whole file scanned", empty');
});

test('EIO mid-stream: entries before the error arrive, then ReadError (partial), never a silent end', () => {
  const w = newRoot(); fs.writeFileSync(drawer(w), FORTY);
  const got = [];
  let error = null;
  withBrokenRead(1, () => {
    try { for (const e of memory.iterLogFile(drawer(w), { chunkBytes: 512 })) got.push(e); } catch (e) { error = e; }
  });
  assert.ok(got.length > 0 && got.length < 40, `beginning delivered: ${got.length}`);
  assert.ok(error instanceof memory.ReadError);
  assert.equal(error.code, 'EIO');
  assert.equal(error.partial, true);
  assert.match(error.message, /only a beginning/);
});

test('red proof: the old state delivers only the beginning after EIO, without a signal', async (t) => {
  const old = await oldMem();
  if (!old) return t.skip('fixed old state not in this clone');
  const w = newRoot(); fs.writeFileSync(drawer(w), FORTY);
  let r; let error = null;
  withBrokenRead(1, () => { try { r = [...old.iterLogFile(drawer(w), { chunkBytes: 512 })]; } catch (e) { error = e; } });
  assert.equal(error, null, 'old: no error signal');
  assert.ok(r.length > 0 && r.length < 40, 'old: only the beginning, as if it were everything');
});

test('positive control: undamaged reads deliver all 40 entries, also in small chunks', () => {
  const w = newRoot(); fs.writeFileSync(drawer(w), FORTY);
  assert.equal([...memory.iterLogFile(drawer(w), { chunkBytes: 512 })].length, 40);
  assert.equal(memory.readLog(w, 'decision').entries.length, 40);
  const t = memory.tailEntries(w, 'decision');
  assert.equal(t.scannedWholeFile, true); assert.equal(t.entries.length, 40); assert.equal(t.missing, false);
  const small = memory.tailEntries(w, 'decision', { tailBytes: 1000 });
  assert.equal(small.scannedWholeFile, false, 'a window stays marked as a partial answer');
});

test('unreadable file (EACCES), as far as the run is not root', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores file permissions');
  if (process.platform === 'win32') return t.skip('no POSIX permissions');
  const w = newRoot(); fs.writeFileSync(drawer(w), FORTY); fs.chmodSync(drawer(w), 0o000);
  try {
    assert.throws(() => [...memory.iterLog(w, 'decision')], (e) => e instanceof memory.ReadError && e.code === 'EACCES');
    assert.throws(() => memory.readLog(w, 'decision'), memory.ReadError);
    assert.throws(() => memory.tailEntries(w, 'decision'), memory.ReadError);
  } finally { fs.chmodSync(drawer(w), 0o600); }
});

test('unreadable file, injected (EACCES at open): ReadError, checkable as root too', () => {
  const w = newRoot(); fs.writeFileSync(drawer(w), FORTY);
  const target = drawer(w); const orig = fs.openSync;
  fs.openSync = (p, ...r) => { if (p === target) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return orig(p, ...r); };
  try {
    assert.throws(() => [...memory.iterLogFile(target)], (e) => e instanceof memory.ReadError && e.code === 'EACCES');
  } finally { fs.openSync = orig; }
});

test('tailEntries: EIO while reading the window throws, instead of "whole file scanned, nothing in it"', () => {
  const w = newRoot(); fs.writeFileSync(drawer(w), FORTY);
  assert.throws(() => withBrokenRead(0, () => memory.tailEntries(w, 'decision', { tailBytes: 1000 })),
    (e) => e instanceof memory.ReadError && e.code === 'EIO');
});

test('red proof: the old tailEntries reports "whole file scanned" and empty after EIO', async (t) => {
  const old = await oldMem();
  if (!old) return t.skip('fixed old state not in this clone');
  const w = newRoot(); fs.writeFileSync(drawer(w), FORTY);
  const r = withBrokenRead(0, () => old.tailEntries(w, 'decision', { tailBytes: 1000 }));
  assert.equal(r.scannedWholeFile, true);
  assert.deepEqual(r.entries, []);
});

test('boundary doctor: a directory in the place of a log becomes an ERROR finding with the reason; positive control: none without a defect', () => {
  const READ_FAIL = /store not readable|unreadable/;
  const clean = newRoot();
  fs.writeFileSync(drawer(clean, 'error'), `${row(1)}\n`);
  const without = doctor.checkAll(clean);
  assert.equal(without.findings.some((f) => /store not readable/.test(JSON.stringify(f))), false, 'no defect, no read-error finding');

  const w = newRoot(); fs.writeFileSync(drawer(w), `${row(1)}\n`); fs.mkdirSync(drawer(w, 'error'));
  const r = doctor.checkAll(w);
  const hit = r.findings.filter((f) => READ_FAIL.test(JSON.stringify(f)) && f.level === 'error');
  assert.ok(hit.length >= 1, 'at least one ERROR finding names the unreadability: ' + JSON.stringify(r.findings.filter((f) => f.level !== 'good').map((f) => [f.name, f.level])));
  assert.equal(r.worst, 'error');
});

test('boundary doctor: a check that throws something else becomes an ERROR finding, the others still run', () => {
  const w = newRoot(); fs.writeFileSync(drawer(w), `${row(1)}\n`);
  const real = fs.readdirSync;
  let fired = 0;
  // Every listing of the projects directory fails with something that is no ReadError.
  fs.readdirSync = (p, ...a) => {
    if (String(p) === path.join(w, 'projects')) { fired += 1; throw new RangeError('synthetic'); }
    return real(p, ...a);
  };
  let r;
  try { r = doctor.checkAll(w); } finally { fs.readdirSync = real; }
  assert.ok(fired > 0, 'the synthetic fault was hit');
  assert.ok(r.findings.some((f) => f.level === 'error' && /check aborted \(RangeError\): synthetic/.test(f.text ?? JSON.stringify(f))),
    JSON.stringify(r.findings.filter((f) => f.level === 'error')));
  assert.ok(r.findings.length > 30, 'the doctor delivered the other findings: ' + r.findings.length);
});

test('boundary neighbour hint: not readable says UNKNOWN, not "nothing there"', () => {
  const w = newRoot(); fs.mkdirSync(drawer(w));
  const found = neighbours.neighbours(w, 'decision', { topic: 'abc' });
  assert.equal(typeof found.unreadable, 'string');
  const text = neighbours.hint(found).join('\n');
  assert.match(text, /UNKNOWN/);
});

test('boundary dashboard pass: an unreadable drawer is named, not skipped as empty', () => {
  const w = newRoot(); fs.mkdirSync(drawer(w));
  const pass = dashboard.readPass(w);
  assert.equal(pass.unreadable.length, 1);
  assert.match(pass.unreadable[0], /decision/);
  // positive control: without a defect nothing is named
  assert.deepEqual(dashboard.readPass(newRoot()).unreadable, []);
});

test('sameClass: an unreadable drawer is named, the count is only a lower bound', () => {
  const w = newRoot(); fs.mkdirSync(drawer(w, 'error'));
  const r = memory.sameClass(w, 'anything');
  assert.equal(r.lowerBound, true);
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].code, 'EISDIR');
  // positive control: without a defect no extra field
  assert.equal(memory.sameClass(newRoot(), 'anything').unreadable, undefined);
});
