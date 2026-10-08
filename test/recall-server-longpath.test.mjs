// A memory root whose default socket path exceeds sun_path (macOS temp dirs:
// /var/folders/...; CI run 37692975754 said "socket path too long (104 bytes
// > 100)") must still get a server, in a short dir the product picks itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as place from '../src/recallserver-place.mjs';
import * as server from '../src/recallserver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The sun_path limit exists on Unix sockets only (Windows listens on a named pipe), so the rule is
// driven for the 'linux' platform explicitly: the same answer on every host.
test('long root: the place moves to a short per-user, per-root dir; an explicit dir is never moved', () => {
  const longRoot = path.join(os.tmpdir(), 'x'.repeat(90), 'memory');
  const w = place.place(longRoot, {}, 'linux');
  assert.equal(w.fallback, true);
  assert.ok(Buffer.byteLength(w.socket) <= place.MAX_SOCKET_PATH, w.socket);
  assert.ok(w.dir.includes(place.rootId(longRoot)), 'per-root name');
  assert.equal(path.dirname(w.pointer), path.join(longRoot, '.pipeline', 'recall'));
  const other = place.place(`${longRoot}2`, {}, 'linux');
  assert.notEqual(other.dir, w.dir);
  assert.equal(place.place(longRoot, { MEM_RECALL_SERVER_DIR: '/tmp/zz' }, 'linux').fallback, false);
  assert.equal(place.place('/tmp/short', {}, 'linux').fallback, false);
});

// A Unix socket under a long path does not exist on Windows (a named pipe has no sun_path), so
// there is nothing to measure there; the place rule itself is covered above for every host.
test('long root: the server starts, the parent is 0700, the pointer says where, the client is served',
  { skip: process.platform === 'win32' && 'Unix domain socket and POSIX 0700: no such thing on Windows (named pipe; see the place rule test above)' },
  async (t) => {
  const base = fs.mkdtempSync('/tmp/crs-');
  const longRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-long-')), 'y'.repeat(90), 'memory');
  fs.mkdirSync(longRoot, { recursive: true });
  const env = { ...process.env, MEM_RECALL_SERVER_SHORT_BASE: base };
  delete env.MEM_RECALL_SERVER_DIR;
  const mem = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin/mem'), '--root', longRoot, ...a], { env, encoding: 'utf8' });
  mem('init');
  mem('log', 'learning', '--title', 'warm socket on a long path', '--text', 'the quokka server answers');
  const said = [];
  const s = await server.start(longRoot, { env, log: (x) => said.push(x) });
  t.after(async () => { if (s.running) await s.close(); fs.rmSync(base, { recursive: true, force: true }); });
  assert.equal(s.running, true, said.join(' | '));
  const w = place.place(longRoot, env);
  assert.ok(fs.statSync(w.socket).isSocket());
  assert.equal(fs.statSync(path.dirname(w.dir)).mode & 0o077, 0, 'parent is private');
  assert.equal(fs.readFileSync(w.pointer, 'utf8').trim(), w.dir);
  // Async: the server lives in THIS process, a blocking spawn would starve it.
  const c = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin/mem-retrieve-client.mjs'), longRoot, 'quokka server answers', '3'],
      { env: { ...env, MEM_RETRIEVE_TIME: '5' } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /quokka/);
});
