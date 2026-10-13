// Load children on a double leash (test/fixture/loadchild.mjs).
//
// Failure record 3rmr30wgcgjn: four `while (true)` children of a load probe ran for 9.5 days (PPID 1, 2.7 GB
// each, the machine at 100 % CPU for a week), because only the test's `finally` cleaned up, and `finally`
// never runs when the test process is killed with SIGKILL.
//
// Red proof: (a-red) runs against the OLD shape (a child without a parent leash, with a 20 s kill switch for
// the probe's sake only): the child LIVES ON after SIGKILL of its parent -- so probe (a) bites. (c) is the
// positive control: the child really computes (its CPU time grows), otherwise "the child is gone" proves
// nothing.
//
// These probes never leave a child behind. Cleanup without PID-recycling risk: direct children of this file
// through their ChildProcess handle (Node no longer signals after the exit); grandchildren (PIDs reported by
// the driver) only while their start time from /proc is still the one noted at the report -- a recycled PID
// falls through, neither a false alarm nor an innocent process killed.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import {
  loadChildSource, startLoadChildren, cpuTimeMs, isAlive, startTime, MAX_LIFETIME_MS, CHECK_EVERY_MAX,
} from './fixture/loadchild.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'fixture', 'loadchild-driver.mjs');
const handles = new Set();
const grandchildren = new Map(); // pid -> start time noted at the report
const note = (pid) => grandchildren.set(pid, startTime(pid));
const own = (child) => { handles.add(child); return child; };
const sameProcess = (pid) => isAlive(pid) && startTime(pid) === grandchildren.get(pid);

after(async () => {
  for (const k of handles) { try { k.kill('SIGKILL'); } catch { /* gone */ } }
  for (const pid of grandchildren.keys()) {
    if (sameProcess(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  await waitUntil(() => ![...grandchildren.keys()].some(sameProcess), 3000); // SIGKILL acts once the kernel has reaped it
  const left = [...grandchildren.keys()].filter(sameProcess);
  assert.deepEqual(left, [], `the probe left processes behind: ${left}`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond, deadlineMs, stepMs = 50) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) { if (cond()) return true; await sleep(stepMs); }
  return cond();
}

async function startDriver(mode, t) {
  const dir = tempDir('cm-loadchild-', t);
  const pidFile = path.join(dir, 'pids.json');
  const driver = own(spawn(process.execPath, [DRIVER, mode, pidFile], { stdio: 'ignore' }));
  assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0, 15000), 'the driver reported no PIDs');
  const { children } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  for (const k of children) note(k);
  return { driver, children };
}

test('a) parent ended with SIGKILL: the load children are gone within seconds', async (t) => {
  const { driver, children } = await startDriver('new', t);
  assert.equal(children.length, 2);
  assert.ok(children.every((k) => isAlive(k)), 'the children were not running after the start');
  driver.kill('SIGKILL');
  assert.ok(await waitUntil(() => children.every((k) => !isAlive(k)), 15000),
    `load children ${children.filter(isAlive)} outlive SIGKILL of their parent (orphans)`);
});

test('a-red) positive control: after the OLD shape the child lives on after SIGKILL of its parent', async (t) => {
  const { driver, children } = await startDriver('old', t);
  driver.kill('SIGKILL');
  await sleep(3000);
  if (process.platform === 'win32') {
    // Windows has a leash of its own: libuv puts every child it spawns without `detached` into a job object that
    // ends with the parent, so the old shape leaves no orphan there and this control cannot bite. Hold that fact
    // instead: should it ever change, this turns red and probe a) needs its red proof on Windows again.
    assert.deepEqual(children.filter(isAlive), [],
      'Windows no longer ends a non-detached child with its parent: probe a) needs a red proof here again');
    return;
  }
  const living = children.filter(isAlive);
  assert.equal(living.length, children.length,
    'probe a) does not bite: even without a parent leash the children would have been gone within 3 s');
  for (const k of living) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
  assert.ok(await waitUntil(() => children.every((k) => !isAlive(k)), 10000), 'cleaned-up old children still live');
});

test('a2) parent PID gone: a child with a dead parent PID ends at once (exit 0)', async () => {
  const dead = own(spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }));
  await new Promise((r) => dead.on('exit', r));
  const k = own(spawn(process.execPath, ['-e', loadChildSource({ parent: dead.pid, maxLifetimeMs: 30000 })], { stdio: 'ignore' }));
  const exited = new Promise((r) => { k.on('exit', (c, s) => r(c ?? s)); });
  // The lifetime is 30 s: ending within 15 s can only be the parent leash.
  const code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
  assert.equal(code, 0);
});

test('b) maximum lifetime bites: the child ends by itself although the parent lives', async () => {
  const { children, pids } = startLoadChildren(1, { maxLifetimeMs: 1500 });
  children.forEach(own);
  await sleep(300);
  assert.ok(isAlive(pids[0]), 'the child was gone 300 ms after the start -- the 1500 ms lifetime cannot have ended it');
  const hold = setInterval(() => {}, 100); // the helper unref()s its children; this keeps the event loop alive meanwhile
  const exited = new Promise((r) => { children[0].on('exit', (c, sig) => r(c ?? sig)); });
  // A deadline, so that a broken lifetime turns this red instead of hanging (the helper's own 1500 ms is far below 10 s).
  const code = await Promise.race([exited, sleep(10000).then(() => 'still running after 10 s')]);
  clearInterval(hold);
  assert.equal(code, 0, `the child did not end cleanly: ${code}`);
  assert.ok(isAlive(process.pid), 'the parent lives (so the parent leash cannot be the cause)');
});

test('b2) the lifetime is capped (60 s) and runs on the monotonic clock; checkEvery is capped', () => {
  assert.equal(MAX_LIFETIME_MS, 60000);
  const ns = (ms) => new RegExp(`hrtime\\.bigint\\(\\) \\+ ${ms}000000n;`);
  assert.match(loadChildSource({ maxLifetimeMs: 3600000 }), ns(60000));
  assert.match(loadChildSource({ maxLifetimeMs: 'x' }), ns(60000));
  assert.match(loadChildSource({ maxLifetimeMs: 5000 }), ns(5000));
  assert.match(loadChildSource({}), ns(60000));
  assert.doesNotMatch(loadChildSource({}), /Date\.now/, 'a wall clock can jump (NTP, DST): the leash uses the monotonic clock');
  // A huge checkEvery must not switch the parent leash off: the first check comes after CHECK_EVERY_MAX iterations at the latest.
  assert.equal(CHECK_EVERY_MAX, 1000000);
  for (const big of [1e12, 5e9, CHECK_EVERY_MAX + 1]) {
    assert.match(loadChildSource({ checkEvery: big }), /i < 1000000;/, `checkEvery=${big} not capped`);
  }
  assert.match(loadChildSource({ checkEvery: 500 }), /i < 500;/, 'small values stay');
  // One rule for both tunables: Infinity and too large -> the cap; 0, negative, NaN, text, fractions below 1 -> the default;
  // numeric text is read as a number; fractions are floored.
  const life = (v) => loadChildSource({ maxLifetimeMs: v }).match(/hrtime\.bigint\(\) \+ (\d+)000000n;/)[1];
  const every = (v) => loadChildSource({ checkEvery: v }).match(/i < (\d+);/)[1];
  for (const [v, want] of [[0, '60000'], [-5, '60000'], [NaN, '60000'], [Infinity, '60000'], [-Infinity, '60000'], ['x', '60000'],
    [null, '60000'], [0.5, '60000'], ['5000', '5000'], [1234.9, '1234'], [1, '1']]) {
    assert.equal(life(v), want, `maxLifetimeMs=${String(v)}`);
  }
  for (const [v, want] of [[0, '20000'], [-5, '20000'], [NaN, '20000'], [Infinity, '1000000'], [-Infinity, '20000'], ['x', '20000'],
    [null, '20000'], [0.5, '20000'], ['700', '700'], [1e12, '1000000'], [1, '1']]) {
    assert.equal(every(v), want, `checkEvery=${String(v)}`);
  }
});

// b3 proves only that both lines are in the source text; b4 and b5 below drive each check ALONE (the behaviour).
test('b3) the parent leash is in the loop and checks both ppid and kill(parent, 0)', () => {
  const src = loadChildSource({ parent: 4242 });
  assert.match(src, /const PARENT = 4242;/);
  assert.match(src, /process\.ppid !== PARENT/);
  assert.match(src, /process\.kill\(PARENT, 0\)/);
  assert.match(loadChildSource({}), /const PARENT = process\.ppid;/);
  assert.match(loadChildSource({ checkEvery: 20000 }), /i < 20000;/);
});

// The two leash checks, each driven alone (a regex on the source text proves only that the lines exist).
const without = (source, pattern) => source.split('\n').filter((l) => !pattern.test(l)).join('\n');

test('b4) kill(parent, 0) alone ends the child: with the ppid check struck, a dead parent PID still ends it', async () => {
  const dead = own(spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }));
  await new Promise((r) => dead.on('exit', r));
  const source = without(loadChildSource({ parent: dead.pid, maxLifetimeMs: 30000 }), /process\.ppid !== PARENT/);
  assert.ok(!/ppid/.test(source) && /process\.kill\(PARENT, 0\)/.test(source));
  const k = own(spawn(process.execPath, ['-e', source], { stdio: 'ignore' }));
  const code = await Promise.race([new Promise((r) => { k.on('exit', (c, sig) => r(c ?? sig)); }), sleep(15000).then(() => 'still running')]);
  assert.equal(code, 0, 'the second leash (kill) did not end the child');
});

test('b5) the ppid check alone ends the child: with kill struck, a PARENT that is not the real parent still ends it', async () => {
  // PARENT is a live process (this one) that is NOT the child's parent (a detached relay process spawns it, so its ppid is the relay
  // helper): ppid !== PARENT at the first check. kill(PARENT, 0) would succeed, so only the ppid line can end it.
  const source = without(loadChildSource({ parent: process.pid, maxLifetimeMs: 30000 }), /process\.kill\(PARENT, 0\)/);
  assert.ok(/process\.ppid !== PARENT/.test(source) && !/kill\(PARENT/.test(source));
  const relay = own(spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const k = spawn(process.execPath, ['-e', ${JSON.stringify(source)}], { stdio: 'ignore', detached: true });
    process.stdout.write(String(k.pid)); k.unref();`], { stdio: ['ignore', 'pipe', 'ignore'] }));
  let out = '';
  relay.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => relay.on('exit', r));
  const pid = Number(out);
  assert.ok(pid > 0, 'the relay reported no PID');
  note(pid);
  assert.ok(await waitUntil(() => !sameProcess(pid), 15000), 'the ppid check did not end the child (it lives on with a foreign PARENT)');
});

test('c) positive control: the load child really produces load while it runs (its CPU time grows)', async (t) => {
  const { children, pids, stop } = startLoadChildren(1, { maxLifetimeMs: 20000 });
  children.forEach(own);
  try {
    // Deadline-based, not a fixed window: on a busy machine the child gets less than a core, and a fixed
    // 1.2 s window would measure the machine instead of the child.
    const first = await (async () => {
      const until = Date.now() + 5000;
      while (Date.now() < until) { const v = cpuTimeMs(pids[0]); if (v !== null) return v; await sleep(50); }
      return null;
    })();
    if (first === null) { t.skip('/proc/<pid>/stat not readable -- CPU time not measurable here'); return; }
    let grown = 0;
    const grew = await waitUntil(() => { grown = cpuTimeMs(pids[0]) - first; return grown >= 300; }, 12000, 100);
    assert.ok(grew, `the load child's CPU time grew by only ${grown} ms in 12 s of wall time`);
  } finally { stop(); }
  assert.ok(await waitUntil(() => !isAlive(pids[0]), 5000));
});

test('d) stop() cleans up (the finally path); a child the probe started itself is cleaned up through watch() and process.on(exit)', async (t) => {
  // A separate parent process starts load children WITHOUT a parent leash (both check lines are struck from the
  // source text; `watch` puts them under the helper's exit cleanup) and ends NORMALLY (no SIGKILL, no stop()).
  // Only the lifetime (15 s) remains as an emergency brake: within 3 s of the parent's end only the exit handler
  // can have fetched the children -- otherwise the probe would prove leash (a), not the exit cleanup.
  const dir = tempDir('cm-loadchild-', t);
  const pidFile = path.join(dir, 'pids.json');
  const script = path.join(dir, 'parent.mjs');
  fs.writeFileSync(script, `import { loadChildSource, watch } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'fixture', 'loadchild.mjs')).href)};
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const text = loadChildSource({ maxLifetimeMs: 15000 }).split('\\n').filter((l) => !/^\\s*(if \\(process\\.ppid|try \\{ process\\.kill\\(PARENT)/.test(l)).join('\\n');
if (/kill\\(PARENT|ppid !==/.test(text)) throw new Error('parent leash not struck');
const pids = [0, 1].map(() => { const k = spawn(process.execPath, ['-e', text], { stdio: 'ignore' }); k.unref(); watch(k); return k.pid; });
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(pids));
setTimeout(() => {}, 800);\n`);
  const parent = own(spawn(process.execPath, [script], { stdio: 'ignore' }));
  await new Promise((r) => parent.on('exit', r));
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  for (const p of pids) note(p);
  assert.ok(await waitUntil(() => pids.every((p) => !sameProcess(p)), 3000), `the exit handler left ${pids.filter(sameProcess)} behind`);

  const h = startLoadChildren(1, { maxLifetimeMs: 5000 });
  h.children.forEach(own);
  for (const p of h.pids) note(p);
  h.stop();
  assert.ok(await waitUntil(() => !sameProcess(h.pids[0]), 5000), 'stop() left the child behind');
});
