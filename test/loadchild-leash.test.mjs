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
// These probes never leave a child behind: every PID this file started or was told about is checked with
// signal 0 at the end and -- only our own -- ended.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { loadChildSource, startLoadChildren, cpuTimeMs, isAlive, MAX_LIFETIME_MS } from './fixture/loadchild.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'fixture', 'loadchild-driver.mjs');
const mine = new Set(); // every PID this file started or was told about

after(() => {
  for (const pid of mine) {
    if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  const left = [...mine].filter((p) => isAlive(p));
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
  const driver = spawn(process.execPath, [DRIVER, mode, pidFile], { stdio: 'ignore' });
  mine.add(driver.pid);
  assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0, 15000), 'the driver reported no PIDs');
  const { children } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  for (const k of children) mine.add(k);
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
  const living = children.filter(isAlive);
  assert.equal(living.length, children.length,
    'probe a) does not bite: even without a parent leash the children would have been gone within 3 s');
  for (const k of living) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
  assert.ok(await waitUntil(() => children.every((k) => !isAlive(k)), 10000), 'cleaned-up old children still live');
});

test('a2) parent PID gone: a child with a dead parent PID ends at once (exit 0)', async () => {
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  const k = spawn(process.execPath, ['-e', loadChildSource({ parent: dead.pid, maxLifetimeMs: 30000 })], { stdio: 'ignore' });
  mine.add(k.pid);
  const exited = new Promise((r) => { k.on('exit', (c, s) => r(c ?? s)); });
  // The lifetime is 30 s: ending within 15 s can only be the parent leash.
  const code = await Promise.race([exited, sleep(15000).then(() => 'still running')]);
  assert.equal(code, 0);
});

test('b) maximum lifetime bites: the child ends by itself although the parent lives', async () => {
  const { children, pids } = startLoadChildren(1, { maxLifetimeMs: 1500 });
  for (const p of pids) mine.add(p);
  await sleep(300);
  assert.ok(isAlive(pids[0]), 'the child was gone 300 ms after the start -- the 1500 ms lifetime cannot have ended it');
  const hold = setInterval(() => {}, 100); // the helper unref()s its children; this keeps the event loop alive meanwhile
  const code = await new Promise((r) => { children[0].on('exit', (c, s) => r(c ?? s)); });
  clearInterval(hold);
  assert.equal(code, 0, `the child did not end cleanly: ${code}`);
  assert.ok(isAlive(process.pid), 'the parent lives (so the parent leash cannot be the cause)');
});

test('b2) the lifetime is capped: more than 60 s and nonsense are clamped to 60 s', () => {
  assert.equal(MAX_LIFETIME_MS, 60000);
  assert.match(loadChildSource({ maxLifetimeMs: 3600000 }), /Date\.now\(\) \+ 60000;/);
  assert.match(loadChildSource({ maxLifetimeMs: 'x' }), /Date\.now\(\) \+ 60000;/);
  assert.match(loadChildSource({ maxLifetimeMs: 5000 }), /Date\.now\(\) \+ 5000;/);
  assert.match(loadChildSource({}), /Date\.now\(\) \+ 60000;/);
});

test('b3) the parent leash is in the loop and checks both ppid and kill(parent, 0)', () => {
  const src = loadChildSource({ parent: 4242 });
  assert.match(src, /const PARENT = 4242;/);
  assert.match(src, /process\.ppid !== PARENT/);
  assert.match(src, /process\.kill\(PARENT, 0\)/);
  assert.match(loadChildSource({}), /const PARENT = process\.ppid;/);
  assert.match(loadChildSource({ checkEvery: 20000 }), /i < 20000;/);
});

test('c) positive control: the load child really produces load while it runs (its CPU time grows)', async (t) => {
  const { pids, stop } = startLoadChildren(1, { maxLifetimeMs: 20000 });
  for (const p of pids) mine.add(p);
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

test('d) stop() cleans up (the finally path); the parent also cleans up through process.on(exit)', async (t) => {
  // A separate parent process starts load children and ends NORMALLY (no SIGKILL, no stop()): its exit handler
  // has to fetch them. The parent leash is made toothless on purpose here (first check only after 5e9
  // iterations, far beyond the 3 s below): within 3 s only the exit handler can have fetched the children --
  // otherwise the probe would prove leash (b), not the exit cleanup.
  const dir = tempDir('cm-loadchild-', t);
  const pidFile = path.join(dir, 'pids.json');
  const script = path.join(dir, 'parent.mjs');
  fs.writeFileSync(script, `import { startLoadChildren } from ${JSON.stringify(path.join(HERE, 'fixture', 'loadchild.mjs'))};
import fs from 'node:fs';
const { pids } = startLoadChildren(2, { maxLifetimeMs: 30000, checkEvery: 5000000000 });
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(pids));
setTimeout(() => {}, 800);\n`);
  const parent = spawn(process.execPath, [script], { stdio: 'ignore' });
  mine.add(parent.pid);
  await new Promise((r) => parent.on('exit', r));
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  for (const p of pids) mine.add(p);
  assert.ok(await waitUntil(() => pids.every((p) => !isAlive(p)), 10000), `the exit handler left ${pids.filter(isAlive)} behind`);

  const h = startLoadChildren(1, { maxLifetimeMs: 5000 });
  for (const p of h.pids) mine.add(p);
  h.stop();
  assert.ok(await waitUntil(() => !isAlive(h.pids[0]), 5000), 'stop() left the child behind');
});
