// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// alarm-tearing-cm - `mem doctor --alarm` sees a tearing that `mem doctor --full` MEASURED.
//
// Since cli-speed-cm TB7 a run without `--full` leaves out the concurrent-append probe, and the session-start banner
// (`mem doctor --alarm`) runs without it: a mount on which tearing was once measured raised no alarm any more.
// `--full` now keeps its verdict in `.pipeline/append-atomicity.json`; a run without `--full` reads it back.
//
// RED against origin/kette/cm (774ffc3): there is no record and nothing reads one, so (a) the banner stays silent over a torn
// record, (d) `--full` writes no file; (b) and (c) pass there only by accident (nothing is read, so nothing can be wrong
// about it) and are the guards for the new reader. Positive controls: the same record on the same mount DOES alarm.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as doctor from '../src/doctor.mjs';
import * as environment from '../src/environment.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const SPY = new URL('./probe-spy.mjs', import.meta.url).href;
const RECORD = path.join('.pipeline', 'append-atomicity.json');
const WHEN = '2026-10-01T08:30:00.000Z';

function world(t) {
  const root = tempDir('cm-alarm-tearing-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { input: '', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}
const devOf = (root) => String(fs.statSync(root).dev);
const recordPath = (root) => path.join(root, RECORD);

/** A record as the writer lays it down, with fields overridable. `dev` defaults to the real device of the root. */
function putRecord(root, over = {}) {
  const rec = {
    v: 1, ok: false, measuredAt: WHEN, dev: devOf(root), fsType: null, node: process.version,
    workers: 6, perWorker: 8, torn: 3, missing: 2, duplicates: 0, ...over,
  };
  fs.mkdirSync(path.dirname(recordPath(root)), { recursive: true });
  fs.writeFileSync(recordPath(root), `${JSON.stringify(rec)}\n`);
  return rec;
}
const atomicity = (result) => result.findings.find((f) => f.name === 'env/append-atomicity');
const lineOf = (r) => `${r.stdout}`.split('\n').find((l) => l.includes('env/append-atomicity')) ?? '';

/** Run `mem --root <root> doctor <flags>` with the probe spy; says how many probes the process started. */
function cli(t, root, flags) {
  const log = path.join(tempDir('cm-alarm-tearing-spy-', t), 'count.txt');
  const r = spawnSync(process.execPath, ['--import', SPY, MEM, '--root', root, 'doctor', ...flags], {
    encoding: 'utf8', env: { ...process.env, PROBE_SPY_LOG: log },
  });
  return { ...r, probes: fs.existsSync(log) ? Number(fs.readFileSync(log, 'utf8')) : null };
}

// --- (a) a measured tearing alarms without measuring again ---------------------------------------------------------

test('(a) a torn record on this mount: checkAll without --full reports an error with the time and the way to measure anew', (t) => {
  const root = world(t);
  putRecord(root);
  const f = atomicity(doctor.checkAll(root, { full: false }));
  assert.equal(f.level, doctor.LEVEL.ERROR);
  assert.ok(f.text.includes(WHEN), `the time of the measurement is missing: ${f.text}`);
  assert.match(f.text, /torn/);
  assert.match(f.advice, /mem doctor --full/);
});

test('(a) through the CLI: --alarm prints the torn mount, exits non-zero, and starts no probe', (t) => {
  const root = world(t);
  putRecord(root);
  const r = cli(t, root, ['--alarm']);
  assert.equal(r.probes, 0, 'the banner must not measure');
  assert.match(r.stdout, /^FAIL\s+env\/append-atomicity .*measured torn at 2026-10-01T08:30:00\.000Z/m);
  assert.notEqual(r.status, 0);
  const plain = cli(t, root, []);
  assert.match(lineOf(plain), /^FAIL\s+env\/append-atomicity/);
  assert.equal(plain.probes, 0);
});

test('(a) control: without the record the banner is silent about it', (t) => {
  const root = world(t);
  const r = cli(t, root, ['--alarm']);
  assert.equal(lineOf(r), '');
  assert.match(lineOf(cli(t, root, [])), /^\?\s+env\/append-atomicity .*not measured/);
});

test('a clean record never reads ok without a measurement: still the third state, naming the time', (t) => {
  const root = world(t);
  putRecord(root, { ok: true, torn: 0, missing: 0, duplicates: 0 });
  const f = atomicity(doctor.checkAll(root, { full: false }));
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.ok(f.text.includes(WHEN));
  assert.match(f.text, /not measured/);
  assert.equal(lineOf(cli(t, root, ['--alarm'])), '', 'a clean old measurement is not an alarm');
});

// --- (b) another mount is not used ---------------------------------------------------------------------------------

test('(b) a record from another device is not used: unknown, no alarm, and it says why', (t) => {
  const root = world(t);
  putRecord(root, { dev: `${devOf(root)}9` });
  const f = atomicity(doctor.checkAll(root, { full: false }));
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.match(f.text, /another device or filesystem is not used/);
  const r = cli(t, root, ['--alarm']);
  assert.equal(r.stdout.trim(), '');
  assert.equal(r.status, 0);
});

test('(b) a record from another named filesystem is not used; the name shown is the live one, never the file\'s', (t) => {
  const root = world(t);
  putRecord(root, { fsType: 'evil\u001b[2Jfs' });
  const c = environment.checkAppendAtomicity(root, { measure: false, fsTypeOf: () => 'ext4' });
  assert.equal(c.ok, null);
  assert.doesNotMatch(c.detail, /\u001b/);
  assert.match(c.detail, /another device or filesystem/);
  // Same device, the live name unavailable: the record counts (a flaky `stat` must not silence the alarm).
  const same = environment.checkAppendAtomicity(root, { measure: false, fsTypeOf: () => null });
  assert.equal(same.ok, false);
  assert.doesNotMatch(same.detail, /\u001b/);
  // Control: the same record with the matching name alarms.
  putRecord(root, { fsType: 'ext4' });
  assert.equal(environment.checkAppendAtomicity(root, { measure: false, fsTypeOf: () => 'ext4' }).ok, false);
});

// --- (c) a damaged record is a note, never a throw -----------------------------------------------------------------

const DAMAGED = {
  empty: ['', /empty and was ignored/],
  'not JSON': ['{"v":1,"ok":fal', /unreadable and was ignored/],
  'a JSON array': ['[]', /unreadable and was ignored/],
  'wrong type for ok': [JSON.stringify({ v: 1, ok: 'no', measuredAt: WHEN, dev: '1', fsType: null, workers: 6, perWorker: 8, torn: 1, missing: 0, duplicates: 0 }), /unreadable/],
  'time that is no time': [JSON.stringify({ v: 1, ok: false, measuredAt: 'soon', dev: '1', fsType: null, workers: 6, perWorker: 8, torn: 1, missing: 0, duplicates: 0 }), /unreadable/],
  'negative count': [JSON.stringify({ v: 1, ok: false, measuredAt: WHEN, dev: '1', fsType: null, workers: 6, perWorker: 8, torn: -1, missing: 0, duplicates: 0 }), /unreadable/],
};
for (const [name, [content, note]] of Object.entries(DAMAGED)) {
  test(`(c) a record that is ${name}: its own note, unknown, no throw, no alarm`, (t) => {
    const root = world(t);
    fs.mkdirSync(path.dirname(recordPath(root)), { recursive: true });
    fs.writeFileSync(recordPath(root), content);
    let f;
    assert.doesNotThrow(() => { f = atomicity(doctor.checkAll(root, { full: false })); });
    assert.equal(f.level, doctor.LEVEL.UNKNOWN);
    assert.match(f.text, note);
    const r = cli(t, root, ['--alarm']);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout.trim(), '');
  });
}

test('(c) a directory where the record should be is not read, not a crash', (t) => {
  const root = world(t);
  fs.mkdirSync(recordPath(root), { recursive: true });
  const f = atomicity(doctor.checkAll(root, { full: false }));
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.match(f.text, /not a plain file of at most 4096 bytes and was not read/);
});

// --- the reading bound: a record is a few hundred bytes; nothing else is read -------------------------------------

/** How many times the record file was opened or read whole while `fn` ran. */
function readsDuring(root, fn) {
  const target = recordPath(root);
  const realOpen = fs.openSync; const realRead = fs.readFileSync;
  let n = 0;
  fs.openSync = function patched(p, ...rest) { if (p === target) n += 1; return realOpen.call(this, p, ...rest); };
  fs.readFileSync = function patched(p, ...rest) { if (p === target) n += 1; return realRead.call(this, p, ...rest); };
  try { fn(); } finally { fs.openSync = realOpen; fs.readFileSync = realRead; }
  return n;
}

test('(c) an oversize record is not read: its own note, unknown, no alarm', (t) => {
  const root = world(t);
  putRecord(root);
  fs.appendFileSync(recordPath(root), ' '.repeat(5 * 1024 * 1024));
  let f;
  assert.equal(readsDuring(root, () => { f = atomicity(doctor.checkAll(root, { full: false })); }), 0, 'the file must not be opened');
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.match(f.text, /not a plain file of at most 4096 bytes and was not read/);
  const r = cli(t, root, ['--alarm']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('(c) the bound is 4096 bytes: a record padded to exactly that still counts, one byte more does not', (t) => {
  const root = world(t);
  const rec = putRecord(root);
  const body = JSON.stringify(rec);
  fs.writeFileSync(recordPath(root), body + ' '.repeat(environment.APPEND_RECORD_MAX_BYTES - body.length));
  assert.equal(fs.statSync(recordPath(root)).size, 4096);
  assert.equal(environment.readAppendRecord(root).state, 'usable');
  fs.appendFileSync(recordPath(root), ' ');
  assert.equal(environment.readAppendRecord(root).state, 'unfit');
});

test('(c) a symlink to a large file in the scratch is not read either (never to a device)', (t) => {
  const root = world(t);
  const big = path.join(tempDir('cm-alarm-tearing-big-', t), 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 0x20));
  fs.mkdirSync(path.dirname(recordPath(root)), { recursive: true });
  try { fs.symlinkSync(big, recordPath(root)); } catch (err) {
    // Windows without the symlink privilege: the platform cannot make this case; say so with an assertion, not a skip.
    assert.equal(process.platform, 'win32', `symlink failed on a POSIX platform: ${err.message}`);
    assert.ok(['EPERM', 'EACCES'].includes(err.code), `unexpected symlink error ${err.code}`);
    return;
  }
  assert.equal(readsDuring(root, () => assert.equal(environment.readAppendRecord(root).state, 'unfit')), 0);
  const f = atomicity(doctor.checkAll(root, { full: false }));
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.match(f.text, /was not read/);
});

test('(c) a file that grows between the look and the read is still bounded', (t) => {
  const root = world(t);
  putRecord(root);
  fs.appendFileSync(recordPath(root), ' '.repeat(100000));
  const real = fs.statSync;
  // The look is told the file is small (as it was a moment ago); the read must not trust it.
  fs.statSync = function patched(p, ...rest) {
    const st = real.call(this, p, ...rest);
    return p === recordPath(root) ? { isFile: () => true, size: 200, dev: st.dev } : st;
  };
  try { assert.equal(environment.readAppendRecord(root).state, 'unfit'); } finally { fs.statSync = real; }
});

test('(c) the three states: missing says nothing extra, empty and broken each say their own', (t) => {
  const root = world(t);
  assert.equal(environment.readAppendRecord(root).state, 'missing');
  fs.mkdirSync(path.dirname(recordPath(root)), { recursive: true });
  fs.writeFileSync(recordPath(root), '  \n');
  assert.equal(environment.readAppendRecord(root).state, 'empty');
  fs.writeFileSync(recordPath(root), 'x');
  assert.equal(environment.readAppendRecord(root).state, 'broken');
  putRecord(root);
  assert.equal(environment.readAppendRecord(root).state, 'usable');
});

// --- (d) --full writes the record -----------------------------------------------------------------------------------

const PROBE_TORN = () => ({ measured: true, workers: 6, perWorker: 8, ok: false, torn: 2, missing: 1, duplicates: 0, found: 47, expected: 48, rows: 50 });
const PROBE_CLEAN = () => ({ measured: true, workers: 6, perWorker: 8, ok: true, torn: 0, missing: 0, duplicates: 0, found: 48, expected: 48, rows: 48 });

test('(d) a finished measurement leaves the record: verdict, time, device, filesystem, node, writers and lines', (t) => {
  const root = world(t);
  const before = Date.now();
  environment.checkAppendAtomicity(root, { record: true, probe: PROBE_TORN, fsTypeOf: () => 'ext4' });
  const rec = JSON.parse(fs.readFileSync(recordPath(root), 'utf8'));
  assert.equal(rec.ok, false);
  assert.equal(rec.dev, devOf(root));
  assert.equal(rec.fsType, 'ext4');
  assert.equal(rec.node, process.version);
  assert.deepEqual([rec.workers, rec.perWorker, rec.torn, rec.missing, rec.duplicates], [6, 8, 2, 1, 0]);
  const at = Date.parse(rec.measuredAt);
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, `the time is not now: ${rec.measuredAt}`);
});

test('(d) a measurement that did not finish leaves the earlier record alone', (t) => {
  const root = world(t);
  putRecord(root);
  const kept = fs.readFileSync(recordPath(root), 'utf8');
  environment.checkAppendAtomicity(root, { record: true, probe: () => ({ measured: false, reason: '3/6 writer threads finished within 400ms' }) });
  assert.equal(fs.readFileSync(recordPath(root), 'utf8'), kept);
});

test('(d) the record goes down atomically: a temp file next to it, then a rename onto it', (t) => {
  const root = world(t);
  const real = fs.renameSync;
  const seen = [];
  fs.renameSync = function patched(from, to) { seen.push([from, to]); return real.call(this, from, to); };
  try { environment.checkAppendAtomicity(root, { record: true, probe: PROBE_CLEAN }); } finally { fs.renameSync = real; }
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], recordPath(root));
  assert.notEqual(seen[0][0], seen[0][1]);
  assert.equal(path.dirname(seen[0][0]), path.dirname(recordPath(root)));
  assert.deepEqual(fs.readdirSync(path.dirname(recordPath(root))).filter((n) => n.endsWith('.tmp')), []);
});

test('(d) the loop: a torn measurement alarms the next banner; a later clean one takes the alarm away', (t) => {
  const root = world(t);
  environment.checkAppendAtomicity(root, { record: true, probe: PROBE_TORN });
  assert.equal(atomicity(doctor.checkAll(root, { full: false })).level, doctor.LEVEL.ERROR);
  environment.checkAppendAtomicity(root, { record: true, probe: PROBE_CLEAN });
  const f = atomicity(doctor.checkAll(root, { full: false }));
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.equal(lineOf(cli(t, root, ['--alarm'])), '');
});

test('(d) through the CLI: `mem doctor --full` writes the record when the probe finished, and not otherwise', (t) => {
  const root = world(t);
  assert.ok(!fs.existsSync(recordPath(root)));
  assert.equal(cli(t, root, []).probes, 0);
  assert.ok(!fs.existsSync(recordPath(root)), 'a run without --full must not write the record');
  // A loaded machine may let the writers time out ("could not measure"): then there is no verdict to keep, and the test
  // says so by asserting the absence instead of skipping. Up to six tries to get a finished measurement.
  let measured = false;
  for (let i = 0; i < 6 && !measured; i += 1) {
    const r = cli(t, root, ['--full']);
    assert.equal(r.probes, 1);
    measured = !/could not measure/.test(lineOf(r));
    assert.equal(fs.existsSync(recordPath(root)), measured, `record present must equal "the probe finished" (${lineOf(r)})`);
  }
  if (measured) {
    const rec = JSON.parse(fs.readFileSync(recordPath(root), 'utf8'));
    assert.equal(rec.v, 1);
    assert.equal(rec.dev, devOf(root));
    assert.equal(typeof rec.ok, 'boolean');
    // What the next banner says depends on what was measured: a torn mount alarms, a clean one does not.
    const banner = cli(t, root, ['--alarm']);
    assert.equal(/env\/append-atomicity/.test(banner.stdout), !rec.ok);
  }
});

test('the record sits under .pipeline/, which a memory ignores: writing it leaves a git tree clean', (t) => {
  const root = world(t);
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-q', '-m', 'state').status, 0);
  environment.checkAppendAtomicity(root, { record: true, probe: PROBE_TORN });
  assert.ok(fs.existsSync(recordPath(root)));
  assert.equal(git('status', '--porcelain').stdout.trim(), '', 'the record must be ignored by git');
  assert.equal(git('check-ignore', '-q', RECORD.split(path.sep).join('/')).status, 0);
});

test('a root that does not exist is not created by the record, and nothing throws', (t) => {
  const gone = path.join(tempDir('cm-alarm-tearing-gone-', t), 'nope');
  assert.doesNotThrow(() => environment.checkAppendAtomicity(gone, { record: true, probe: PROBE_TORN }));
  assert.ok(!fs.existsSync(gone));
});

test('a documented-unsafe filesystem is still answered first, without the record', (t) => {
  const root = world(t);
  putRecord(root, { ok: true, torn: 0, missing: 0, duplicates: 0 });
  assert.equal(environment.checkAppendAtomicity(root, { measure: false, fsTypeOf: () => 'nfs' }).ok, false);
});

// --- looking writes nothing (alarm-record-cm) ----------------------------------------------------------------------
//
// The dashboard, `mem today`, the weekly instrument trace and the agents view call `doctor.checkAll(root)`, whose library
// default measures. Only an explicit call (`mem doctor --full/--strict`, `record: true`) lays the record down:
// test/agents-d5.test.mjs probe 3 holds "collecting the view writes nothing at all".

test('looking writes nothing: checkAll by default measures (the probe ran) and leaves no record', (t) => {
  const root = world(t);
  // A loaded machine may let the writers time out ("could not measure"); then nothing is kept in any case. Up to six tries
  // to get a run whose probe finished - that is the run in which a writing default would show.
  let finished = false;
  for (let i = 0; i < 6 && !finished; i += 1) {
    let result;
    const started = probesDuring(() => { result = doctor.checkAll(root); });
    assert.equal(started, 1, 'control: the default run did measure');
    finished = !/could not measure/.test(atomicity(result).text);
    assert.ok(!fs.existsSync(recordPath(root)), 'a view that only collects must not write the record');
  }
});

test('looking writes nothing: the library call without record, with a finished probe, leaves no file', (t) => {
  const root = world(t);
  environment.checkAppendAtomicity(root, { probe: PROBE_TORN });
  assert.ok(!fs.existsSync(recordPath(root)));
  environment.checkEnvironment(root, { full: true });
  assert.ok(!fs.existsSync(recordPath(root)));
});

test('record: true through checkAll lays the record down when the probe finished', (t) => {
  const root = world(t);
  let measured = false;
  for (let i = 0; i < 6 && !measured; i += 1) {
    const f = atomicity(doctor.checkAll(root, { record: true }));
    measured = !/could not measure/.test(f.text);
    assert.equal(fs.existsSync(recordPath(root)), measured, `record present must equal "the probe finished" (${f.text})`);
  }
});

/** How many append probes started while `fn` ran. */
function probesDuring(fn) {
  const real = fs.mkdtempSync;
  let n = 0;
  fs.mkdtempSync = function patched(prefix, ...rest) {
    if (typeof prefix === 'string' && path.basename(prefix).startsWith('.append-atomicity-')) n += 1;
    return real.call(this, prefix, ...rest);
  };
  try { fn(); } finally { fs.mkdtempSync = real; }
  return n;
}
