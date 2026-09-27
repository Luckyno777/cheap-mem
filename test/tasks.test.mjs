// test/tasks.test.mjs — E1.7 (English mirror): long CLI work as tasks.
//
// Mirrors lucky-mem's `test/vorgaenge.test.mjs` + `test/vorgang-server.
// test.mjs` (its commit `d6880335`) for cheap-mem's own two real
// long-running CLI paths; see the header comment on `src/tasks.mjs` for
// the full contract and the third kind (an index rebuild) that was
// looked for and deliberately left out.
//
// Module-level probes run against REAL child processes (`bin/mem raw
// export`, `bin/mem chain`) — no mock, no second, invented command
// layer. That costs real wall time (the cancel probe needs a run long
// enough to catch mid-flight), but a test against a faked `spawn` could
// not see the class of bug this file exists to catch: fd inheritance,
// process groups, a really-ended process. HTTP-layer probes then check
// only the door in front of it (`bin/mem-serve`'s `/task` family) —
// same split of concerns as `test/pages.test.mjs` / `test/dashboard-
// entry-fast.test.mjs` already use for their own routes, kept in one
// file per this project's own convention rather than lucky-mem's two.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as tasks from '../src/tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tasks-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.mkdirSync(path.join(r, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'tasks', participants: ['someone'], language: 'en' }));
  return r;
}
function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

/**
 * A single large drawer file, written directly (no CLI round-trips) so
 * `mem chain` has enough real work to still be running when a cancel
 * probe reaches it. Calibrated on this machine: 50k lines repeated 8x
 * (400k lines, ~66MB) runs a full, uncancelled `mem chain` in ~1.9s --
 * comfortable headroom over the cancel probe's own well-under-a-second
 * path to SIGTERM, matching the calibration comment in lucky-mem's own
 * `schreibeFehlerJsonl`.
 */
function writeLargeDrawer(root, repeats) {
  const one = Array.from({ length: 50000 }, (_, i) => JSON.stringify({
    id: `e${String(i).padStart(8, '0')}`, ts: '2026-09-27T00:00:00Z',
    type: 'error', title: `probe ${i}`, text: 'x'.repeat(80),
  })).join('\n');
  fs.writeFileSync(path.join(root, 'global', 'errors.jsonl'), `${one}\n`.repeat(repeats));
}

async function waitForTerminal(root, id, { timeoutMs = 20000, intervalMs = 60 } = {}) {
  const started = Date.now();
  for (;;) {
    const b = tasks.read(root, id);
    if (b.result !== undefined || b.cancelled) return b;
    if (Date.now() - started >= timeoutMs) return b; // last, non-terminal state
    await new Promise((res) => { setTimeout(res, intervalMs); });
  }
}

// --- The closed list -------------------------------------------------

test('KINDS is a closed list with exactly the two real long-running paths', () => {
  assert.deepEqual(new Set(Object.keys(tasks.KINDS)), new Set(['export', 'integrity']));
  for (const spec of Object.values(tasks.KINDS)) {
    assert.equal(typeof spec.title, 'string');
    assert.ok(spec.title.length > 0);
    assert.equal(spec.resume, 'restart', 'neither command here can resume from a break -- that must read honestly');
  }
});

test('an unknown kind is rejected, no child process and no tasks directory', () => {
  const r = world();
  try {
    assert.throws(() => tasks.start(r, 'shred-everything'), (e) => e.code === 'UNKNOWN_KIND');
    assert.equal(fs.existsSync(path.join(r, '.mem', 'tasks')), false);
  } finally { gone(r); }
});

// --- started -> the state file grows -> a result ----------------------

test('started -> the state file grows -> result (real child, kind "integrity")', async () => {
  const r = world();
  try {
    const { id } = tasks.start(r, 'integrity');
    const file = tasks.statePath(r, id);
    assert.ok(fs.existsSync(file), 'the state file must exist immediately after start()');
    const linesAfterStart = fs.readFileSync(file, 'utf8').trim().split('\n').length;
    assert.equal(linesAfterStart, 1, 'exactly the started line, no result yet');

    const b = await waitForTerminal(r, id);
    const linesAtEnd = fs.readFileSync(file, 'utf8').trim().split('\n').length;
    assert.ok(linesAtEnd > linesAfterStart, 'the state file must have grown');
    assert.equal(b.running, false);
    assert.equal(b.kind, 'integrity');
    // A fresh memory has no drawer files and no seals -- verifyChain()'s
    // own 'unknown' verdict, honestly reported as a task-level warning,
    // never a silent 'ok' over nothing actually checked.
    assert.equal(b.state, 'warning', `unexpected state: ${b.state} (${b.reason})`);
    assert.match(b.reason, /no seal/i);
  } finally { gone(r); }
});

test('kind "export" on an empty record: exit 0, no JSON -- the exact quirk found in the CLI source', async () => {
  // `src/cli/commands/capture.mjs`, branch `sub === 'export'`: the
  // `!hit.length` early return sits AHEAD of the `args.json` check, so
  // an empty range prints plain text and skips --json entirely, same
  // shape as lucky-mem's own finding for `roh export`.
  const r = world();
  try {
    const { id } = tasks.start(r, 'export');
    const b = await waitForTerminal(r, id);
    assert.equal(b.state, 'warning', `unexpected state: ${b.state}`);
    assert.match(b.reason, /No captures in that range|JSON/);
  } finally { gone(r); }
});

// --- at most one task per kind at a time -------------------------------

test('a second start of the same kind is refused while the first is still running', async () => {
  const r = world();
  try {
    const first = tasks.start(r, 'integrity');
    // Synchronously right after start(): the child cannot have fired
    // 'close' yet (always async) -- the lock must already be up.
    assert.throws(() => tasks.start(r, 'integrity'), (e) => {
      assert.equal(e.code, 'LOCK_ACTIVE');
      assert.equal(e.runningId, first.id);
      return true;
    });
    await waitForTerminal(r, first.id);
    // Free again immediately after the end.
    const second = tasks.start(r, 'integrity');
    assert.notEqual(second.id, first.id);
    await waitForTerminal(r, second.id);
  } finally { gone(r); }
});

test('two DIFFERENT kinds may run at the same time', async () => {
  const r = world();
  try {
    const a = tasks.start(r, 'integrity');
    const b = tasks.start(r, 'export');
    assert.notEqual(a.id, b.id);
    await Promise.all([waitForTerminal(r, a.id), waitForTerminal(r, b.id)]);
  } finally { gone(r); }
});

// --- cancel really ends the child ---------------------------------------

test('cancel() really ends the child process (pid is provably gone afterwards)', async () => {
  const r = world();
  try {
    // Six repeats of 50k lines each keeps this a real, honest `mem
    // chain` run, just given enough input to still be mid-flight when
    // cancel() reaches it.
    writeLargeDrawer(r, 8);
    const { id } = tasks.start(r, 'integrity');
    const beforeCancel = tasks.read(r, id);
    assert.equal(beforeCancel.running, true, 'the check must still be running when cancel() is called');

    const pidBefore = (() => {
      const lines = fs.readFileSync(tasks.statePath(r, id), 'utf8').trim().split('\n');
      return JSON.parse(lines[0]).pid;
    })();

    const result = await tasks.cancel(r, 'integrity');
    assert.equal(result.id, id);
    assert.equal(result.reallyEnded, true, 'cancel() must wait for the real end, not just send a signal');

    assert.throws(() => process.kill(pidBefore, 0), /ESRCH|kill/i);

    const b = await waitForTerminal(r, id);
    assert.equal(b.cancelled, true);
    assert.equal(b.running, false);

    // The lock is free again right away -- "cancelled but still locked"
    // would just move the same problem one step over.
    const fresh = tasks.start(r, 'integrity');
    assert.notEqual(fresh.id, id);
    await tasks.cancel(r, 'integrity').catch(() => {}); // clean up regardless of how fast it ran
  } finally { gone(r); }
});

test('cancel() with nothing running of that kind throws NOTHING_ACTIVE', async () => {
  const r = world();
  try {
    await assert.rejects(tasks.cancel(r, 'export'), (e) => e.code === 'NOTHING_ACTIVE');
  } finally { gone(r); }
});

test('cancel() of an unknown kind throws UNKNOWN_KIND', async () => {
  const r = world();
  try {
    await assert.rejects(tasks.cancel(r, 'not-a-real-kind'), (e) => e.code === 'UNKNOWN_KIND');
  } finally { gone(r); }
});

// --- read(): the contract -----------------------------------------------

test('read() with an id never seen: state unknown, no guess', () => {
  const r = world();
  try {
    const b = tasks.read(r, 'neverstartedatall');
    assert.equal(b.state, 'unknown');
    assert.equal(b.id, 'neverstartedatall');
    assert.match(b.reason, /no task/);
  } finally { gone(r); }
});

test('read() with a malformed id is refused rather than turned into a path', () => {
  const r = world();
  try {
    for (const bad of ['../../../etc/passwd', '', 'a/b', 'a b', 'ABCDEFGHIJ']) {
      const b = tasks.read(r, bad);
      assert.equal(b.state, 'unknown', `id '${bad}' should have been refused`);
    }
  } finally { gone(r); }
});

test('a task from a FOREIGN server epoch reads as unknown, never running', () => {
  const r = world();
  try {
    const id = 'restarttest01';
    const file = tasks.statePath(r, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Hand-write a started line with an epoch that is NOT this (running)
    // test process's own -- exactly the situation after a server
    // restart: the file knows the task, but nobody here still holds the
    // child handle.
    fs.appendFileSync(file, `${JSON.stringify({
      event: 'started', ts: new Date().toISOString(), id, kind: 'export',
      pid: 999999, serverEpoch: 'a-DIFFERENT-epoch-than-this-one', command: ['bin/mem'],
    })}\n`, 'utf8');

    const b = tasks.read(r, id);
    assert.equal(b.state, 'unknown');
    assert.equal(b.running, 'unknown');
    assert.match(b.reason, /restart/i);
    assert.notEqual(b.state, 'ok', 'this must never read as running -- that would be the exact lie this case guards against');
  } finally { gone(r); }
});

// --- overview() ----------------------------------------------------------

test('overview() names both kinds even when nothing was ever started', () => {
  const r = world();
  try {
    const o = tasks.overview(r);
    assert.deepEqual(new Set(Object.keys(o)), new Set(['export', 'integrity']));
    for (const kind of Object.keys(o)) assert.equal(o[kind], null);
  } finally { gone(r); }
});

// =========================================================================
// HTTP layer: bin/mem-serve's /task, /task.json, /task/cancel
// =========================================================================

const DOOR = ['probe', 'door', String(process.pid)].join('-');
const WITH_DOOR = { authorization: `Bearer ${DOOR}` };

// Writing is off by default since 2026-09-27 (`src/writegate.mjs`).
// The probes in this file test the latches BEHIND that switch (origin,
// host, readonly, closed setting list), so they run with it ON — else a
// 403 from the switch would pass them without ever reaching the latch
// they name. The switch itself is probed in test/writegate.test.mjs.
async function start(root, env = {}, opts = { allowWrites: true }) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR,
    CHEAP_MEM_SERVE_HOST: '127.0.0.1',
    CHEAP_MEM_SERVE_PORT: '0',
    ...env,
  }, opts);
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}

test('/task, /task.json, /task/cancel are all in the server\'s own guarded path list', async () => {
  const mod = await import(`${pathToFileURL(SERVE).href}?paths=${Math.random()}`);
  for (const p of ['/task', '/task.json', '/task/cancel']) {
    assert.ok(mod.PATHS.includes(p), `'${p}' is missing from PATHS -- it would answer without the auth guard ever running`);
  }
});

test('POST /task with no Origin header is refused (403), no child process starts', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task`, {
      method: 'POST',
      headers: { ...WITH_DOOR, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity',
    });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(path.join(r, '.mem', 'tasks')), false);
  } finally { await s.stop(); gone(r); }
});

test('POST /task from a foreign origin is refused (403), no child process starts', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity',
    });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(path.join(r, '.mem', 'tasks')), false);
  } finally { await s.stop(); gone(r); }
});

test('CHEAP_MEM_SERVE_READONLY=1 refuses POST /task even with a valid origin', async () => {
  const r = world();
  const s = await start(r, { CHEAP_MEM_SERVE_READONLY: '1' });
  try {
    const res = await fetch(`${s.base}/task`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity',
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Writing is off/);
  } finally { await s.stop(); gone(r); }
});

test('POST /task/cancel without a valid origin is refused the same way', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task/cancel`, {
      method: 'POST',
      headers: { ...WITH_DOOR, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity',
    });
    assert.equal(res.status, 403);
  } finally { await s.stop(); gone(r); }
});

test('POST /task with an unknown kind -> 400 with the known list', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=shred-everything',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.state, 'unknown');
    assert.deepEqual(new Set(body.known), new Set(['export', 'integrity']));
  } finally { await s.stop(); gone(r); }
});

test('the full path: POST /task really starts, GET /task.json?id= eventually shows a result', async () => {
  const r = world();
  const s = await start(r);
  try {
    const startRes = await fetch(`${s.base}/task`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity',
    });
    assert.equal(startRes.status, 201);
    const { id } = await startRes.json();
    assert.ok(id);

    let last;
    const startedAt = Date.now();
    for (;;) {
      const res = await fetch(`${s.base}/task.json?id=${id}`, { headers: WITH_DOOR });
      last = await res.json();
      if (last.running === false) { assert.equal(res.status, 200); break; }
      if (Date.now() - startedAt > 20000) throw new Error('timed out waiting for a result');
      await new Promise((ok) => { setTimeout(ok, 60); });
    }
    assert.ok(['ok', 'warning'].includes(last.state));
  } finally { await s.stop(); gone(r); }
});

test('GET /task.json?id= with an unknown id -> 404', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task.json?id=hasnevereverexisted`, { headers: WITH_DOOR });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).state, 'unknown');
  } finally { await s.stop(); gone(r); }
});

test('GET /task.json with no id lists both kinds and their (empty) status', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task.json`, { headers: WITH_DOOR });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'ok');
    assert.deepEqual(new Set(Object.keys(body.kinds)), new Set(['export', 'integrity']));
    assert.deepEqual(new Set(Object.keys(body.running)), new Set(['export', 'integrity']));
  } finally { await s.stop(); gone(r); }
});

test('two POST /task of the same kind back to back: the second gets 409', async () => {
  const r = world();
  const s = await start(r);
  try {
    const post = () => fetch(`${s.base}/task`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=export',
    });
    const r1 = await post();
    assert.equal(r1.status, 201);
    const firstId = (await r1.json()).id;

    const r2 = await post();
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).runningId, firstId);

    // Let it finish so the process does not outlive the test.
    let done = false;
    const startedAt = Date.now();
    while (!done) {
      const b = await (await fetch(`${s.base}/task.json?id=${firstId}`, { headers: WITH_DOOR })).json();
      done = b.running === false;
      if (Date.now() - startedAt > 20000) throw new Error('timed out');
      if (!done) await new Promise((ok) => { setTimeout(ok, 60); });
    }
  } finally { await s.stop(); gone(r); }
});

test('POST /task/cancel with nothing running of that kind -> 409, no crash', async () => {
  const r = world();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task/cancel`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=integrity',
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).state, 'warning');
  } finally { await s.stop(); gone(r); }
});
