// test/missgold-daily.test.mjs — the daily collection of the miss-gold file
// (src/missgold.mjs dailyRun + the piggyback in bin/mem-digest), the port of
// lucky-mem's "taeglich sammeln" (commit 192519bb).
//
// Promised: (1) at most once per UTC day, (2) a failure in the collection
// never changes the host job's exit code — not even a hang (its own time
// cap), (3) no question text in any output or in the stamp, (4) the stamp
// has a reader: `mem gold miss status` (no log without a reader).
// Red proof pinned to a FIXED commit, never a merge-base (the digest tick
// before this build leaves no stamp). Positive control: the new tick does.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mg from '../src/missgold.mjs';
import { QUESTION, world, cleanup } from './fixture/missgold-world.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'mem');
const BEFORE = '4d746f6ede6d71dc2501903cd81e2f7331ac939c';   // the tree before this build, fixed
const DAY1 = new Date('2026-10-02T03:00:00Z');
const DAY1_LATE = new Date('2026-10-02T23:59:00Z');
const DAY2 = new Date('2026-10-03T00:01:00Z');
afterEach(cleanup);

test('positive control: the first call collects and writes a 0600 stamp with day and counts', () => {
  const root = world();
  const r = mg.dailyRun(root, { now: DAY1 });
  assert.equal(r.skipped, false);
  assert.equal(r.result, 'ok');
  assert.equal(r.fresh, 1);
  const st = mg.readRun(root);
  assert.equal(st.day, '2026-10-02');
  assert.equal(st.result, 'ok');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(mg.runPath(root)).mode & 0o777, 0o600);
    assert.equal(mg.status(root).runModeOk, true);
  } else {
    // No POSIX modes on Windows (stat says 0666): the product must say "not checkable", not claim 0600.
    assert.equal(mg.status(root).runModeOk, null, 'Windows: the stamp mode must be reported as not checkable');
    assert.match(mg.modeNote(mg.status(root)), /not checkable on this platform/);
  }
  assert.ok(!fs.readdirSync(path.dirname(mg.runPath(root))).some((n) => n.endsWith('.tmp')), 'no temp file');
  assert.equal(mg.read(mg.filePath(root)).rows.length, 1);
});

test('a second call on the same UTC day is skipped (even late in the evening); the next day collects again', () => {
  const root = world();
  mg.dailyRun(root, { now: DAY1 });
  const before = fs.readFileSync(mg.runPath(root), 'utf8');
  const second = mg.dailyRun(root, { now: DAY1_LATE });
  assert.equal(second.skipped, true);
  assert.equal(fs.readFileSync(mg.runPath(root), 'utf8'), before, 'stamp unchanged');
  const third = mg.dailyRun(root, { now: DAY2 });
  assert.equal(third.skipped, false);
  assert.equal(mg.readRun(root).day, '2026-10-03');
});

test('a failure while collecting: never throws, the stamp holds the day and only the class, no question', () => {
  const root = world();
  const evil = new Proxy({}, { get() { const e = new Error(`crash with ${QUESTION}`); e.name = 'EvilError'; throw e; } });
  const r = mg.dailyRun(root, { now: DAY1, index: evil });
  assert.equal(r.result, 'error');
  assert.equal(r.class, 'EvilError');
  assert.ok(!JSON.stringify(r).includes(QUESTION));
  assert.ok(!fs.readFileSync(mg.runPath(root), 'utf8').includes(QUESTION));
  assert.equal(mg.dailyRun(root, { now: DAY1_LATE }).skipped, true, 'failing does not mean: again at every tick');
});

test('stamp not writable: NOTHING is collected (otherwise it would run at every tick)', () => {
  const root = world();
  fs.mkdirSync(mg.runPath(root), { recursive: true }); // a directory where the stamp belongs
  const r = mg.dailyRun(root, { now: DAY1 });
  assert.equal(r.result, 'stamp-error');
  assert.equal(fs.existsSync(mg.filePath(root)), false);
});

test('CLI: daily/status carry numbers only, never the question; status reads the stamp', () => {
  const root = world();
  const run = (...a) => spawnSync(process.execPath, [BIN, '--root', root, 'gold', 'miss', ...a], { encoding: 'utf8' });
  const a = run('daily'); const b = run('daily'); const c = run('status');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /ok, 1 new case\(s\)/);
  assert.match(b.stdout, /already done/);
  assert.match(c.stdout, /Last collection: \d{4}-\d\d-\d\d ok, 1 new case\(s\)/);
  for (const o of [a, b, c]) assert.ok(!(o.stdout + o.stderr).includes(QUESTION));
  assert.equal(mg.read(mg.filePath(root)).rows[0].question, QUESTION, 'the question only in the local file');
});

// --- the digest tick, against a throwaway copy of the program ----------------

/**
 * bin/ and src/ copied (so a test can break a module), deps linked.
 * Only the VERSIONED files are copied (`git ls-files`), not a walk of the live
 * directories: a parallel test, an editor or another agent may leave a file in
 * bin/ or src/ for a moment, and a directory copy that meets it dies with
 * `ENOENT ... '<copy>/src'` (measured: 147 of 300 copies against one flickering
 * file). A tracked file is there for the whole run.
 */
function program(work, { digestFrom = null } = {}) {
  const k = path.join(work, 'cm');
  fs.mkdirSync(k);
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'bin', 'src'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0').filter(Boolean);
  for (const rel of tracked) {
    const from = path.join(REPO, ...rel.split('/'));
    const to = path.join(k, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
  }
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(k, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(k, 'node_modules'));
  if (digestFrom) {
    const old = execFileSync('git', ['show', `${digestFrom}:bin/mem-digest`], { cwd: REPO, encoding: 'utf8' });
    fs.writeFileSync(path.join(k, 'bin', 'mem-digest'), old, { mode: 0o755 });
  }
  return k;
}

/** One tick. The fake model exits 1, so a due pile makes the host job exit 1: a non-zero code to hold on to. */
function tick(k, root, work, extra = {}) {
  const fake = path.join(work, 'fake-model');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const t0 = Date.now();
  const r = spawnSync('bash', [path.join(k, 'bin', 'mem-digest')], {
    encoding: 'utf8', timeout: 90000,
    env: {
      ...process.env, CHEAP_MEM_ROOT: root, MEM_DIGEST_CMD: fake, MEM_DIGEST_TIMEOUT: '20',
      MEM_DIGEST_VOLUME_NOW_KB: '0', ...extra,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr, ms: Date.now() - t0 };
}

const withWork = (fn) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-missgold-tick-'));
  try { return fn(work); } finally { fs.rmSync(work, { recursive: true, force: true }); }
};

test('digest tick: leaves the day stamp, a second tick the same day leaves it alone; log and output stay free of it', () => {
  withWork((work) => {
    const root = world();
    const k = program(work);
    const a = tick(k, root, work);
    const st = mg.readRun(root);
    assert.ok(st, 'no stamp after the first tick');
    assert.equal(st.day, new Date().toISOString().slice(0, 10));
    assert.equal(st.result, 'ok');
    const before = fs.readFileSync(mg.runPath(root), 'utf8');
    const b = tick(k, root, work);
    assert.equal(fs.readFileSync(mg.runPath(root), 'utf8'), before);
    assert.equal(a.code, b.code);
    for (const o of [a.out, b.out]) assert.ok(!/miss gold/i.test(o), 'nothing about it in the output');
    const log = fs.existsSync(path.join(root, '.mem', 'digest.log')) ? fs.readFileSync(path.join(root, '.mem', 'digest.log'), 'utf8') : '';
    assert.ok(!/miss gold/i.test(log) && !log.includes(QUESTION), 'nothing in the digest log');
  });
});

test('digest tick: a crashing collection does not change the exit code of the job', () => {
  withWork((work) => {
    const root = world();
    const k = program(work);
    const without = tick(k, root, work, { MEM_GOLD_DAILY: 'no' });
    assert.equal(without.code, 1, `control: the host job exits 1 here (${without.out})`);
    fs.writeFileSync(path.join(k, 'src', 'missgold.mjs'), `throw new Error(${JSON.stringify(QUESTION)});\n`);
    const crashed = tick(k, root, work);
    assert.equal(crashed.code, without.code, 'same exit code as without the collection');
    assert.ok(!crashed.out.includes(QUESTION), 'the message text reaches no output');
  });
});

test('digest tick: a hanging collection is ended by its own cap, the exit code stays', () => {
  withWork((work) => {
    const root = world();
    const k = program(work);
    const without = tick(k, root, work, { MEM_GOLD_DAILY: 'no' });
    fs.writeFileSync(path.join(k, 'src', 'missgold.mjs'), 'while (true) {}\n');
    const hung = tick(k, root, work, { MEM_GOLD_TIMEOUT: '2' });
    assert.equal(hung.code, without.code);
    assert.ok(hung.ms < 60000, `the tick took ${hung.ms} ms`);
  });
});

test('red proof: the digest tick before this build leaves no stamp (the probe bites)', () => {
  withWork((work) => {
    const root = world();
    const k = program(work, { digestFrom: BEFORE });
    tick(k, root, work);
    assert.equal(mg.readRun(root), null, 'the old tick does not collect');
    assert.throws(() => execFileSync('git', ['cat-file', '-e', `${BEFORE}:src/missgold.mjs`], { cwd: REPO, stdio: 'ignore' }),
      'and the module did not exist there');
  });
});

test('the stamp mode, win32 behaviour driven on every platform: no verdict (control: a real stamp is there)', () => {
  const root = world();
  mg.dailyRun(root, { now: DAY1 });
  assert.ok(fs.existsSync(mg.runPath(root)), 'positive control: the stamp exists');
  const st = mg.status(root, process.env, { platform: 'win32' });
  assert.equal(st.runModeOk, null);
  assert.equal(st.modeOk, null);
  assert.match(mg.modeNote(st), /not checkable on this platform/);
});
