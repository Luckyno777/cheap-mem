// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// R3 (counter-check of the service security round, ported from the sibling's 6addbbc1a): the warm recall
// server and TWO things that are not its own.
//
//   Lever 8  Two starts at the same time. A listens, B fails (EADDRINUSE). B had written its key BEFORE
//            `listen` and removed it again in the error branch: A kept running with no key file on disk,
//            so no client could authenticate to it any more. The service was deaf.
//            Now: the key is written only AFTER a successful `listen`; the loser touches no key and
//            reports `busy` (the child exits BUSY_RC, the keeper tries again later).
//   Lever 9  `close()` removed the socket path unconditionally (and libuv's `server.close()` unlinks the
//            bound NAME on its own): an old server that was closed took the socket of a NEWER one away.
//            Now: a server remembers device and inode of its socket and takes away only that one.
//   Lever 9b A stale-socket clean-up removed whatever stood at the socket path, a regular file included.
//            Now: only a socket nobody listens on.
//
// Red on the base (e6c1dc7): the Lever 8, 9 and 9b probes. The positive controls (a normal start and stop,
// a dead server's socket is taken over) stay green on both.
//
// Windows: a named pipe leaves no file and has one name per memory, so there the inode levers have no
// file to look at. The probes then assert what a pipe does show (a second start is `busy`, the first one
// keeps answering) instead of skipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as place from '../src/recallserver-place.mjs';
import * as recallserver from '../src/recallserver.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';

function memoryRoot(t) {
  const root = tempDir('cm-r3-', t);
  execFileSync(process.execPath, [path.join(CODE, 'bin', 'mem'), '--root', root, 'init'], { stdio: 'ignore' });
  return root;
}

const quiet = () => {};
const startIn = (root) => recallserver.start(root, { env: {}, log: quiet });

/** What a client does: read the key file, connect, ask one question. Resolves to the parsed answer or `{ error }`. */
function ask(root, { key = null } = {}) {
  const w = place.place(root, {});
  let theKey = key;
  if (theKey === null) {
    try { theKey = fs.readFileSync(w.key, 'utf8'); } catch (e) { return Promise.resolve({ error: 'no key file', code: e.code }); }
  }
  return new Promise((resolve) => {
    const c = net.connect(w.socket);
    let a = '';
    c.setEncoding('utf8');
    c.setTimeout(8000, () => { c.destroy(); resolve({ error: 'timeout' }); });
    c.on('connect', () => c.write(`${JSON.stringify({ v: place.VERSION, key: theKey, root, query: 'nothing here', top: 1 })}\n`));
    c.on('data', (x) => { a += x; });
    c.on('error', (e) => resolve({ error: 'connect', code: e.code }));
    c.on('end', () => { try { resolve(JSON.parse(a)); } catch { resolve({ error: 'unparsable' }); } });
  });
}

const answers = (a) => a && a.ok === true;

test('positive control: a normal start answers an authenticated question and a stop leaves no file behind', async (t) => {
  const root = memoryRoot(t);
  const s = await startIn(root);
  assert.equal(s.running, true);
  const a = await ask(root);
  assert.ok(answers(a), `the healthy path must answer: ${JSON.stringify(a)}`);
  // The key file is not readable by the wrong key (the guard still guards).
  const wrong = await ask(root, { key: 'x'.repeat(64) });
  assert.equal(wrong.reason, 'refused');
  await s.close();
  assert.equal(fs.existsSync(s.where.key), false, 'the key goes with the server');
  assert.equal(fs.existsSync(s.where.listed), false, 'the socket (or marker) goes with the server');
});

test('R3 lever 8: two starts at the same time - exactly one listens, and it keeps its key', async (t) => {
  const root = memoryRoot(t);
  const [a, b] = await Promise.all([startIn(root), startIn(root)]);
  const running = [a, b].filter((x) => x.running);
  try {
    assert.equal(running.length, 1, `exactly one server may listen, got ${JSON.stringify([a.running, b.running])}`);
    const loser = a.running ? b : a;
    assert.equal(loser.reason, 'busy', 'the loser reports busy (the keeper retries later), not a failure');
    const answer = await ask(root);
    assert.ok(answers(answer), `the winner went deaf: ${JSON.stringify(answer)}`);
  } finally {
    for (const s of running) await s.close();
  }
});

test('R3 lever 8: the same, many rounds (the order of the two starts is not what saves it)', async (t) => {
  for (let i = 0; i < 6; i += 1) {
    const root = memoryRoot(t);
    const starts = await Promise.all([startIn(root), startIn(root), startIn(root)]);
    const running = starts.filter((x) => x.running);
    try {
      assert.equal(running.length, 1, `round ${i}: ${starts.map((x) => x.running).join(',')}`);
      assert.ok(answers(await ask(root)), `round ${i}: the winner went deaf`);
    } finally {
      for (const s of running) await s.close();
    }
  }
});

test('R3 lever 8: a key that cannot be written after listen closes the server again (nothing half-started)', async (t) => {
  const root = memoryRoot(t);
  const w = place.place(root, {});
  fs.mkdirSync(w.dir, { recursive: true, mode: 0o700 });
  // A directory where the key file belongs: the rename of the key onto it fails on every platform. The
  // error CODE differs (Windows says EPERM, Linux EISDIR); only that it fails is asserted.
  fs.mkdirSync(w.key);
  const s = await startIn(root);
  assert.equal(s.running, false, 'a server whose key cannot be stored must not run');
  const probe = await ask(root, { key: 'x'.repeat(64) });
  assert.ok(probe.error, `nobody may be listening: ${JSON.stringify(probe)}`);
  assert.equal(fs.existsSync(w.listed), false, 'no socket (or marker) is left behind');
});

test('R3 lever 9: closing an OLD server does not take the socket of a NEWER one away', async (t) => {
  const root = memoryRoot(t);
  const old = await startIn(root);
  assert.equal(old.running, true);
  if (WIN) {
    // A pipe has one name per memory and no file: a second server is simply busy, the first keeps answering.
    const second = await startIn(root);
    assert.equal(second.running, false);
    assert.equal(second.reason, 'busy');
    assert.ok(answers(await ask(root)), 'the first server keeps answering');
    await old.close();
    return;
  }
  // What a stale-socket clean-up (or a hurried operator) does: the old server's NAME is gone while the old
  // server still runs on its unlinked inode. A newer server then takes the name.
  fs.rmSync(old.where.socket, { force: true });
  const newer = await startIn(root);
  assert.equal(newer.running, true, 'the newer server starts on the freed name');
  assert.ok(answers(await ask(root)), 'precondition: the newer server answers');
  const inodeBefore = fs.lstatSync(newer.where.socket).ino;
  await old.close();
  try {
    assert.ok(fs.existsSync(newer.where.socket), 'the old server took the newer one\'s socket away');
    assert.equal(fs.lstatSync(newer.where.socket).ino, inodeBefore, 'the socket at the path is still the newer one\'s');
    assert.equal(fs.readFileSync(newer.where.key, 'utf8').length, 64, 'and its key is still there');
    const a = await ask(root);
    assert.ok(answers(a), `the newer server went deaf after the old one closed: ${JSON.stringify(a)}`);
  } finally {
    await newer.close();
  }
});

test('R3 lever 9b: a regular file at the socket path is not "a dead socket" and is never removed', async (t) => {
  const root = memoryRoot(t);
  const w = place.place(root, {});
  fs.mkdirSync(w.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(w.dir, 'recall.sock'), 'not a socket, somebody\'s file\n');
  const s = await startIn(root);
  try {
    if (WIN) {
      // The pipe name does not live in the directory: the file is none of the server's business and stays.
      assert.equal(s.running, true);
    } else {
      assert.equal(s.running, false, 'it must not start over a file it does not own');
      assert.match(String(s.reason), /socket/i, 'and it says why');
    }
    assert.equal(fs.readFileSync(path.join(w.dir, 'recall.sock'), 'utf8'), 'not a socket, somebody\'s file\n', 'the file is untouched');
  } finally {
    if (s.running) await s.close();
  }
  // Even after a stop (Windows: the server never owned that file) the foreign file is still there.
  assert.equal(fs.existsSync(path.join(w.dir, 'recall.sock')), true, 'a stop must not remove a file the server does not own');
});

/** A child server (own PID) listens on the memory's socket and is killed hard: its socket FILE stays behind. */
async function leaveStaleSocket(root) {
  // A child that listens on the memory's socket and is killed hard (by its own PID) leaves the file behind.
  const kid = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileURL(path.join(CODE, 'src', 'recallserver.mjs')).href)})
      .then((r) => r.start(${JSON.stringify(root)}, { env: {}, log: () => {} }))
      .then((x) => { if (!x.running) process.exit(1); process.stdout.write('up\\n'); });
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const pid = kid.pid;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child server did not come up')), 15000);
      kid.stdout.on('data', (d) => { if (String(d).includes('up')) { clearTimeout(timer); resolve(); } });
      kid.once('exit', () => { clearTimeout(timer); reject(new Error('child server exited early')); });
    });
    const gone = new Promise((r) => kid.once('exit', r));
    process.kill(pid, 'SIGKILL'); // this child only, by its PID
    await gone;
  } catch (e) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    throw e;
  }
}

test('positive control: the socket of a server that died is taken over (a stale socket is still cleaned up)', async (t) => {
  const root = memoryRoot(t);
  await leaveStaleSocket(root);
  const w = place.place(root, {});
  if (!WIN) assert.ok(fs.existsSync(w.socket), 'precondition: a killed server leaves its socket file');
  const s = await startIn(root);
  try {
    assert.equal(s.running, true, `a dead server's socket must not block the next start: ${JSON.stringify(s)}`);
    assert.ok(answers(await ask(root)));
  } finally {
    if (s.running) await s.close();
  }
});

test('R3 lever 9b (race): a socket bound by another starter between the probe and the clean-up is not taken for the dead one', async (t) => {
  const root = memoryRoot(t);
  const w = place.place(root, {});
  if (WIN) {
    // A named pipe is no file: there is no path to look at twice, and nothing to race on.
    assert.equal(w.marker !== null && w.socket.startsWith('\\\\.\\pipe\\'), true, 'on Windows the socket is a pipe name');
    return;
  }
  await leaveStaleSocket(root);
  assert.ok(fs.existsSync(w.socket), 'precondition: a dead server\'s socket file');
  // The "winner": another starter that, at the moment our probe finds nobody home, clears the dead file and binds a
  // new socket of its own. Injected into the very tick the probe's connect fails in.
  const winner = net.createServer((c) => { c.end('winner\n'); });
  const realConnect = net.connect;
  let fired = false;
  net.connect = function patched(...args) {
    const c = realConnect.apply(this, args);
    if (!fired) {
      fired = true;
      c.once('error', () => { fs.rmSync(w.socket, { force: true }); winner.listen(w.socket); });
    }
    return c;
  };
  const restore = () => { net.connect = realConnect; };
  const s = await startIn(root).finally(restore);
  try {
    assert.equal(fired, true, 'the injection point was reached (otherwise the probe proves nothing)');
    assert.ok(fs.existsSync(w.socket), 'the winner\'s socket was removed by the late starter');
    // (The winner's new socket usually gets the freed inode NUMBER of the dead one back: identity by inode alone is
    // not enough here, which is why the clean-up also compares the change time.)
    assert.equal(s.running, false, 'the late starter must not run over the winner');
    assert.equal(s.reason, 'busy');
    const talked = await new Promise((resolve) => {
      const c = net.connect(w.socket);
      let a = '';
      c.setEncoding('utf8');
      c.on('data', (x) => { a += x; });
      c.on('end', () => resolve(a));
      c.on('error', (e) => resolve(`error ${e.code}`));
    });
    assert.equal(talked, 'winner\n', 'the winner still answers at its path');
  } finally {
    if (s.running) await s.close();
    await new Promise((r) => winner.close(r));
  }
});
