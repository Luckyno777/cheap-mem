// AU8 (lucky-mem parity, automation gap L8): the MCP bridge wrote its W1 start
// marker (`.pipeline/running/<service>.json`) only in `--http` mode. In stdio
// mode - the way local clients start it - there was none, so the per-service
// version proof (B4) could not prove anything there.
//
// Now stdio writes a marker too, under the service name `mcp-stdio` (not
// `mcp-http`: stdio processes come and go with each client and would overwrite
// the marker of the long-lived HTTP bridge).
//
// Red probe: against bin/mem-mcp before AU8 the `mcp-stdio` marker is missing.
// Needs @modelcontextprotocol/sdk (optional peer); without it the probes skip
// and say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as runningmark from '../src/runningmark.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = process.env.AU8_MCP_PATH || path.join(REPO, 'bin', 'mem-mcp');

const sdk = spawnSync(process.execPath, ['--input-type=module', '-e',
  "await import('@modelcontextprotocol/sdk/server/index.js')"], { cwd: REPO }).status === 0;
const skip = sdk ? false : 'SDK @modelcontextprotocol/sdk not installed - stdio probe cannot run';

function memory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-au8-'));
  const r = spawnSync('node', [path.join(REPO, 'bin', 'mem'), 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return root;
}
const freePort = () => new Promise((ok, bad) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  s.on('error', bad);
});
async function until(f, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  return f();
}
function start(root, args = [], env = {}) {
  const kid = spawn(process.execPath, [MCP, ...args], {
    cwd: root, stdio: ['pipe', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, CHEAP_MEM_ROOT: root, ...env },
  });
  let err = '';
  kid.stderr.on('data', (d) => { err += d; });
  const stop = () => new Promise((ok) => {
    if (kid.exitCode !== null) return ok();
    kid.on('exit', () => ok());
    kid.stdin.end();
    setTimeout(() => kid.kill('SIGKILL'), 3000).unref();
  });
  return { kid, stop, stderr: () => err };
}
const head = () => spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

test('AU8: stdio mode writes the start marker mcp-stdio (service, commit, pid, start)', { skip }, async () => {
  const root = memory();
  const p = start(root);
  try {
    const m = await until(() => runningmark.readMarker(root, 'mcp-stdio'));
    assert.ok(m, `no start marker in stdio mode. stderr:\n${p.stderr()}`);
    assert.equal(m.service, 'mcp-stdio');
    assert.equal(m.commit, head());
    assert.equal(m.pid, p.kid.pid);
    assert.match(m.start, /^\d{4}-\d{2}-\d{2}T/);
  } finally { await p.stop(); }
});

test('AU8 counter-probe: the marker of the long-lived HTTP bridge (mcp-http) is not overwritten by a stdio process', { skip }, async () => {
  const root = memory();
  const bridge = runningmark.writeMarker(root, { service: 'mcp-http', codePath: REPO, pid: 424242 });
  const p = start(root);
  try {
    assert.ok(await until(() => runningmark.readMarker(root, 'mcp-stdio')), p.stderr());
    assert.deepEqual(runningmark.readMarker(root, 'mcp-http'), bridge);
  } finally { await p.stop(); }
});

test('AU8 counter-probe: HTTP mode still writes mcp-http (and no mcp-stdio)', { skip }, async () => {
  const root = memory();
  const port = await freePort();
  const p = start(root, ['--http'], { CHEAP_MEM_MCP_HOST: '127.0.0.1', CHEAP_MEM_MCP_PORT: String(port) });
  try {
    const m = await until(() => runningmark.readMarker(root, 'mcp-http'));
    assert.ok(m, `no marker in HTTP mode. stderr:\n${p.stderr()}`);
    assert.equal(m.commit, head());
    assert.equal(runningmark.readMarker(root, 'mcp-stdio'), null, 'HTTP mode must not write a stdio marker');
  } finally { await p.stop(); }
});

test('AU8: a marker that cannot be written does not stop the server, and stderr says why', { skip }, async () => {
  const root = memory();
  // A FILE where the .pipeline directory should be: mkdir fails whatever the permissions (also for root).
  fs.writeFileSync(path.join(root, '.pipeline'), 'not a directory\n');
  const p = start(root);
  try {
    await until(() => /could not write the W1 start marker/.test(p.stderr()));
    assert.match(p.stderr(), /could not write the W1 start marker/);
    assert.equal(p.kid.exitCode, null, 'the server died because of the marker');
  } finally { await p.stop(); }
});
