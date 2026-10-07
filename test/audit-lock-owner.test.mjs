// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Audit F02 (2026-10-06): age alone is no proof for taking a lock over.
//
// The finding: `withLock` took a lock over after `staleS` even if its owner
// was alive: two processes inside one protected section. Now only a PROVABLY
// dead owner is replaced (pid + start time from /proc/<pid>/stat + boot
// context on Linux; elsewhere a gone pid is dead and a living pid is
// unknown). A living or unknown owner means: wait, then a clear error.
// One host only.
//
// Red proof: the FIXED state before the change (git archive, hash below)
// enters the section despite a living owner. No hoping on timing: entering
// and leaving run over barrier files; children are ended in finally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock, ownerVerdict, LockTimeoutError, takeOverIfStale } from '../src/filelock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CHILD = path.join(HERE, 'audit-lock-owner-child.mjs');
const NEW_SRC = path.join(REPO, 'src');
// FIXED state before the change (never a moving ref).
const OLD = '4bbca612f0f087aec290ff7fbe210f0ecd2b42b0';
const LINUX = process.platform === 'linux' && fs.existsSync('/proc/self/stat');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lockown-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
let counter = 0;
const newDir = () => { const d = path.join(tmp, `t${++counter}`); fs.mkdirSync(d); return d; };

let oldSrcDir;
function oldSrc() {
  if (oldSrcDir !== undefined) return oldSrcDir;
  try {
    const d = path.join(tmp, 'old'); fs.mkdirSync(d);
    execFileSync('git', ['-C', REPO, 'archive', '-o', path.join(d, 's.tar'), OLD, 'src']);
    execFileSync('tar', ['-xf', path.join(d, 's.tar'), '-C', d]);
    oldSrcDir = path.join(d, 'src');
  } catch { oldSrcDir = null; }
  return oldSrcDir;
}

const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const waitFor = async (file) => { const t0 = Date.now(); while (!fs.existsSync(file)) { if (Date.now() - t0 > 30000) throw new Error('barrier ' + file); await new Promise((r) => setTimeout(r, 5)); } };
const ended = (k) => new Promise((r) => { if (k.exitCode !== null || k.signalCode !== null) r(); else k.once('exit', r); });
function startChild(src, ...args) {
  return spawn(process.execPath, [CHILD, src, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
}
function attempt(src, lock, waitMs) {
  const r = spawnSync(process.execPath, [CHILD, src, 'try', lock, String(waitMs)], { env: childEnv(), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `child (try) ended with ${r.status}/${r.signal}; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
function startOf(pid) {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
}
const context = () => {
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const ns = fs.readlinkSync('/proc/self/ns/pid').replace(/[^0-9A-Za-z:[\]]/g, '');
  return `${boot}/${ns}`;
};
const line = (pid, start, token = 'foreigntoken', host = os.hostname(), ctx = context()) =>
  `${pid} ${host} ${new Date().toISOString()} ${start} ${ctx} ${token}\n`;
const age = (file, s = 120) => { const t = new Date(Date.now() - s * 1000); fs.utimesSync(file, t, t); };

/** An owner child that holds `withLock` until <release> exists. */
async function holder(src, dir) {
  const lock = path.join(dir, 'x.lock'); const inside = path.join(dir, 'inside'); const release = path.join(dir, 'release');
  const k = startChild(src, 'hold', lock, inside, release);
  await waitFor(inside);
  return { k, lock, release };
}
async function cleanup(...kids) {
  for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  for (const k of kids) await ended(k);
}

test('living owner, lock far past the age limit: never taken over, clear message', { skip: !LINUX && 'needs /proc for a "alive" verdict' }, async () => {
  const dir = newDir(); const h = await holder(NEW_SRC, dir);
  try {
    age(h.lock, 3600);
    const r = attempt(NEW_SRC, h.lock, 300);
    assert.equal(r.entered, false, 'a second process must not enter the section');
    assert.equal(r.error, 'LockTimeoutError');
    assert.throws(() => withLock(h.lock, () => 1, { waitMs: 100, staleS: 1 }), (e) =>
      e instanceof LockTimeoutError && /verdict: alive/.test(e.message) && /Age alone/.test(e.message));
    assert.ok(fs.existsSync(h.lock), 'the living owner lock stayed');
  } finally { fs.writeFileSync(h.release, ''); await ended(h.k); await cleanup(h.k); }
});

test('red proof: the old state enters the section despite a living owner', async (t) => {
  const old = oldSrc();
  if (!old) return t.skip('fixed old state not in this clone');
  const dir = newDir(); const h = await holder(old, dir);
  try {
    age(h.lock, 61);
    const r = attempt(old, h.lock, 1500);
    assert.equal(r.entered, true, 'old state: second process inside while the owner lives (the finding)');
  } finally { fs.writeFileSync(h.release, ''); await ended(h.k); await cleanup(h.k); }
});

test('positive control: free lock and a normal run work; the line carries start time and context (Linux)', () => {
  const dir = newDir(); const lock = path.join(dir, 'x.lock');
  assert.equal(withLock(lock, () => {
    const parts = fs.readFileSync(lock, 'utf8').trim().split(' ');
    assert.equal(parts.length, 6);
    if (LINUX) {
      assert.equal(parts[3], startOf(process.pid));
      assert.equal(parts[4], context());
      assert.equal(ownerVerdict(fs.readFileSync(lock, 'utf8')), 'alive');
    } else {
      assert.equal(parts[3], '-');
      assert.equal(ownerVerdict(fs.readFileSync(lock, 'utf8')), 'unknown', 'no /proc: a living pid is unknown, never dead');
    }
    return 'ran';
  }), 'ran');
  assert.ok(!fs.existsSync(lock));
});

test('dead owner (SIGKILL inside the section): taken over at once, without age (all platforms)', async () => {
  const dir = newDir(); const h = await holder(NEW_SRC, dir);
  try {
    h.k.kill('SIGKILL'); await ended(h.k);
    assert.equal(ownerVerdict(fs.readFileSync(h.lock, 'utf8')), 'dead');
    assert.equal(withLock(h.lock, () => 'inside', { waitMs: 2000 }), 'inside');
    assert.ok(!fs.existsSync(h.lock));
  } finally { await cleanup(h.k); }
});

test('pid reuse: pid lives with another start time -> dead, taken; same start time -> alive, not', { skip: !LINUX && 'start time exists on Linux only' }, async () => {
  const dir = newDir(); const inside = path.join(dir, 'inside'); const release = path.join(dir, 'release');
  const k = startChild(NEW_SRC, 'idle', inside, release);
  try {
    await waitFor(inside);
    const start = startOf(k.pid);
    const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, line(k.pid, start));
    age(lock, 3600);
    assert.throws(() => withLock(lock, () => 1, { waitMs: 100 }), LockTimeoutError, 'same start time: the same process lives');
    fs.writeFileSync(lock, line(k.pid, String(Number(start) - 1)));
    assert.equal(ownerVerdict(fs.readFileSync(lock, 'utf8')), 'dead');
    assert.equal(withLock(lock, () => 'fresh', { waitMs: 2000 }), 'fresh', 'reused pid: the owner was another one, dead');
    const old = oldSrc();
    if (old) {
      const reused = path.join(dir, 'y.lock');
      fs.writeFileSync(reused, line(k.pid, String(Number(start) - 1)));
      assert.equal(attempt(old, reused, 200).entered, false, 'red proof: the old state keeps a dead lock with a reused pid');
      assert.equal(attempt(NEW_SRC, reused, 200).entered, true, 'the new state releases it at once');
    }
  } finally { fs.writeFileSync(release, ''); await ended(k); await cleanup(k); }
});

test('old format (4 fields): living pid -> unknown, never taken; dead pid -> dead', { skip: !LINUX && 'verdict for a living pid without /proc is unknown anyway; covered above' }, async () => {
  const dir = newDir(); const inside = path.join(dir, 'inside'); const release = path.join(dir, 'release');
  const k = startChild(NEW_SRC, 'idle', inside, release);
  try {
    await waitFor(inside);
    const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, `${k.pid} ${os.hostname()} ${new Date().toISOString()} token\n`);
    age(lock, 3600);
    assert.equal(ownerVerdict(fs.readFileSync(lock, 'utf8')), 'unknown');
    assert.throws(() => withLock(lock, () => 1, { waitMs: 100 }), /verdict: unknown/);
    fs.writeFileSync(release, ''); await ended(k);
    assert.equal(ownerVerdict(fs.readFileSync(lock, 'utf8')), 'dead');
    assert.equal(withLock(lock, () => 'ok', { waitMs: 2000 }), 'ok');
  } finally { fs.writeFileSync(release, ''); await cleanup(k); }
});

test('verdicts: other host, other boot, other PID namespace, garbage', { skip: !LINUX && 'boot context exists on Linux only' }, () => {
  const own = process.pid; const st = startOf(own);
  assert.equal(ownerVerdict(line(own, st)), 'alive');
  assert.equal(ownerVerdict(line(own, st, 'm', 'another-host-entirely')), 'unknown');
  const [boot, ns] = context().split('/');
  assert.equal(ownerVerdict(line(own, st, 'm', os.hostname(), `00000000-0000-0000-0000-000000000000/${ns}`)), 'dead', 'other boot: process is gone');
  assert.equal(ownerVerdict(line(own, st, 'm', os.hostname(), `${boot}/pid:[1]`)), 'unknown', 'other namespace');
  for (const m of ['', 'x', '0 h i m', 'abc ' + os.hostname() + ' i s k m']) assert.equal(ownerVerdict(m), 'unknown');
});

test('verdicts, all platforms: garbage and a foreign host are unknown, a gone pid is dead', () => {
  for (const m of ['', 'x', '0 h i m']) assert.equal(ownerVerdict(m), 'unknown');
  assert.equal(ownerVerdict(`4242 another-host-entirely ${new Date().toISOString()} tok\n`), 'unknown');
  const r = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(ownerVerdict(`${r.pid} ${os.hostname()} ${new Date().toISOString()} tok\n`), 'dead');
});

test('competing takers of a dead lock: all get their turn, never two at once (barrier)', async () => {
  const dir = newDir(); const occupancy = path.join(dir, 'occupancy'); fs.mkdirSync(occupancy);
  const h = await holder(NEW_SRC, dir);
  h.k.kill('SIGKILL'); await ended(h.k);
  const goFile = path.join(dir, 'go');
  const N = 4; const kids = [];
  try {
    for (let i = 0; i < N; i++) kids.push(startChild(NEW_SRC, 'enter', h.lock, occupancy, goFile, String(i)));
    fs.writeFileSync(goFile, '');
    await Promise.all(kids.map(ended));
    const files = fs.readdirSync(occupancy).filter((f) => f.startsWith('done-'));
    assert.equal(files.length, N, 'all four had their turn: ' + files);
    assert.ok(!files.some((f) => f.endsWith('VIOLATED')), 'no simultaneous occupancy: ' + files);
    assert.ok(kids.every((k) => k.exitCode === 0));
  } finally { await cleanup(h.k, ...kids); }
});

test('a late release by an old owner does not delete the successor lock', () => {
  const dir = newDir(); const lock = path.join(dir, 'x.lock');
  const successor = line(process.pid, LINUX ? startOf(process.pid) : '-', 'successor');
  withLock(lock, () => { fs.writeFileSync(lock, successor); }); // someone "took over"
  assert.equal(fs.readFileSync(lock, 'utf8'), successor);
});

test('the rebuild marker stays an age marker: takeOverIfStale only for that one marker caller', () => {
  const dir = newDir(); const marker = path.join(dir, 'm.lock');
  fs.writeFileSync(marker, line(process.pid, LINUX ? startOf(process.pid) : '-'));
  assert.equal(takeOverIfStale(marker, 60), false, 'fresh: never');
  age(marker, 120);
  assert.equal(takeOverIfStale(marker, 60), true);
});
