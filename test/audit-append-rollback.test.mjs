// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Audit F01 (2026-10-06): the append rollback must never delete foreign data.
//
// The finding: after a short write, appendLine checked with fstat whether the
// file still ended at its own end and then cut it back with ftruncate. In
// between another process could append successfully; the truncate cut off its
// CONFIRMED line, and the error said torn:false. Now nothing is ever cut: the
// fragment stays (torn:true, written), the next append puts a line break in
// front, readers count the fragment as a broken line.
//
// Red proof: the FIXED state before the change (git archive) loses the
// confirmed foreign line. Two real processes, barriers instead of hoping on
// timing; children are ended in finally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';
import { appendLine, AppendError } from '../src/append.mjs';
import { iterLogFile } from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CHILD = path.join(HERE, 'audit-append-child.mjs');
const NEW_SRC = path.join(REPO, 'src');
// FIXED state before the change (never a moving ref).
const OLD = '4bbca612f0f087aec290ff7fbe210f0ecd2b42b0';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-appendrb-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
let counter = 0;
const newDir = () => { const d = path.join(tmp, `t${++counter}`); fs.mkdirSync(d); return d; };

let oldSrcDir;
function oldSrc() {
  if (oldSrcDir !== undefined) return oldSrcDir;
  try {
    const d = path.join(tmp, 'old'); fs.mkdirSync(d);
    exportCommit(REPO, OLD, ['src'], d);
    oldSrcDir = path.join(d, 'src');
  } catch { oldSrcDir = null; }
  return oldSrcDir;
}
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const waitFor = async (file) => { const t0 = Date.now(); while (!fs.existsSync(file)) { if (Date.now() - t0 > 30000) throw new Error('barrier ' + file); await new Promise((r) => setTimeout(r, 5)); } };
const start = (...args) => {
  const k = spawn(process.execPath, [CHILD, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  k.out = ''; k.stdout.on('data', (c) => { k.out += c; });
  k.errOut = ''; k.stderr.on('data', (c) => { k.errOut += c; });
  k.done = new Promise((r) => k.once('exit', (code) => r(code)));
  return k;
};
const end = async (k) => { try { k.kill('SIGKILL'); } catch { /* gone */ } await k.done; };

const BASE = '{"a":1}\n';
const OWN = `${JSON.stringify({ own: 'x'.repeat(60) })}\n`;
const FOREIGN = `${JSON.stringify({ foreign: 'confirmed' })}\n`;

/** The child writes short and holds at the decision point; THIS process appends a line, confirmed; then go on. */
async function race(src) {
  const dir = newDir(); const file = path.join(dir, 'a.jsonl');
  const blocked = path.join(dir, 'blocked'); const release = path.join(dir, 'release');
  fs.writeFileSync(file, BASE);
  const k = start(src, 'short', file, OWN, blocked, release);
  try {
    await waitFor(blocked);
    appendLine(file, FOREIGN); // second, real process: success, confirmed (no throw)
    fs.writeFileSync(release, '');
    const code = await k.done;
    assert.equal(code, 0, `${k.out}\nstderr: ${k.errOut}`);
    return { file, result: JSON.parse(k.out.trim().split('\n').pop()), content: fs.readFileSync(file, 'utf8') };
  } finally { await end(k); }
}

test('two processes: short write + confirmed foreign append -- every confirmed line stays, the error names the fragment', async () => {
  const { result, content } = await race(NEW_SRC);
  assert.ok(content.startsWith(BASE), 'the earlier content is untouched');
  assert.ok(content.includes(FOREIGN), 'the confirmed foreign line is there');
  assert.equal(result.error.name, 'AppendError');
  assert.equal(result.error.torn, true, 'a fragment stands: no torn:false acquittal');
  assert.ok(result.error.written > 0);
});

test('red proof: the old state deletes the confirmed foreign line and reports torn:false', async (t) => {
  const old = oldSrc();
  if (!old) return t.skip('fixed old state not in this clone');
  const { result, content } = await race(old);
  assert.equal(content.includes(FOREIGN), false, 'old state: foreign line lost (the finding)');
  assert.equal(result.error.torn, false, 'old state: reported as a clean rollback');
});

test('the fragment becomes a broken line of its own: the next writer does not glue on, readers count it as broken', async () => {
  const { file, content } = await race(NEW_SRC);
  assert.ok(content.includes(`\n${FOREIGN}`), 'the foreign writer (it came AFTER the fragment) got a line break in front');
  appendLine(file, `${JSON.stringify({ after: 1 })}\n`);
  const good = []; let broken = 0;
  for (const e of iterLogFile(file)) { if (e.__broken) broken += 1; else good.push(e); }
  assert.equal(broken, 1, 'exactly the fragment, not silently dropped');
  assert.deepEqual(good.map((e) => Object.keys(e)[0]), ['a', 'foreign', 'after']);
});

test('ftruncate is never called: short write, throw with and without a byte, normal append', () => {
  const dir = newDir(); const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, BASE);
  const realWrite = fs.writeSync; const realTrunc = fs.ftruncateSync;
  let truncs = 0;
  fs.ftruncateSync = (...x) => { truncs += 1; return realTrunc(...x); };
  const withStub = (stub, fn) => { fs.writeSync = stub; try { return fn(); } finally { fs.writeSync = realWrite; } };
  try {
    withStub((fd, p, o, l, ...r) => realWrite(fd, p, o, 10, ...r),
      () => assert.throws(() => appendLine(file, OWN), (e) => e instanceof AppendError && e.torn === true && e.written === 10));
    const before = fs.readFileSync(file);
    withStub(() => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; },
      () => assert.throws(() => appendLine(file, OWN), (e) => e instanceof AppendError && e.torn === false && e.written === 0));
    assert.deepEqual(fs.readFileSync(file), before, 'a throw without a byte: file untouched');
    // positive control: a normal append, healing the fragment from above
    assert.equal(appendLine(file, FOREIGN).healed, true);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith(`\n${FOREIGN}`));
  } finally { fs.ftruncateSync = realTrunc; fs.writeSync = realWrite; }
  assert.equal(truncs, 0, 'no ftruncate, not even as recovery');
});

test('positive control: two processes append at once (barrier) -- no line lost or glued', async () => {
  const dir = newDir(); const file = path.join(dir, 'a.jsonl'); const go = path.join(dir, 'go');
  fs.writeFileSync(file, BASE);
  const N = 200;
  const ks = [start(NEW_SRC, 'append', file, go, 'p1', String(N)), start(NEW_SRC, 'append', file, go, 'p2', String(N))];
  try {
    fs.writeFileSync(go, '');
    const codes = await Promise.all(ks.map((k) => k.done));
    assert.deepEqual(codes, [0, 0]);
    let good = 0; let broken = 0;
    for (const e of iterLogFile(file)) { if (e.__broken) broken += 1; else good += 1; }
    assert.equal(broken, 0);
    assert.equal(good, 1 + 2 * N);
  } finally { await Promise.all(ks.map(end)); }
});
