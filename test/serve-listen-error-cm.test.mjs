// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// serve-token-rest: a failed listen is a message, not a stack.
//
// `bin/mem-serve` (also behind `mem serve`) and `bin/mem-mcp --http` bind a port. When the bind fails (the port is taken
// above all) the process says which host and port, what to do, exits 1 and prints no stack frame. The dashboard writes its
// setup code only AFTER the bind, so a refused start leaves no half-made file behind. The bridge words its token refusal for
// itself: it never had a password login.
//
// Every probe has a positive control (the same command starts when the port is free), so "no stack" cannot be a command that
// never ran. Windows: processes start with `process.execPath`, are stopped by their handle, the occupied port is found through
// port 0 on loopback, and no error code is asserted (the message is ours, whatever the platform called the failure).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as webauth from '../src/webauth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(ROOT, 'bin', 'mem-serve');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');
const MEM = path.join(ROOT, 'bin', 'mem');
const probeToken = () => ['probe', 'door', 'y'.repeat(20)].join('-');

function memoryRoot(t) {
  const root = tempDir('cm-listen-error-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    name: 'listenerror', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  return root;
}

/** Take a loopback port for the length of the test. It answers 404 to everything, so `/health` can never look like a start. */
async function occupy(t) {
  const holder = http.createServer((req, res) => { res.writeHead(404).end(); });
  await new Promise((resolve, reject) => { holder.once('error', reject); holder.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { holder.close(() => resolve()); holder.closeAllConnections?.(); }));
  return holder.address().port;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => (e ? reject(e) : resolve(port))); });
});

const healthy = (port) => new Promise((resolve) => {
  const q = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode === 200)); });
  q.on('error', () => resolve(false));
  q.setTimeout(3000, () => { q.destroy(); });
  q.end();
});

/** Run a command until it exits or is healthy (then it is stopped by its handle). */
async function run(t, script, args, env, port) {
  const base = { ...process.env, MEM_RECALL_SERVER: '0', CHEAP_MEM_SERVE_TOKEN: '', CHEAP_MEM_MCP_TOKEN: '',
    CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '', CHEAP_MEM_MCP_LOCAL_NO_TOKEN: '', CHEAP_MEM_SERVE_LOGIN: '',
    CHEAP_MEM_SERVE_HOST: '', CHEAP_MEM_MCP_HOST: '', CHEAP_MEM_SERVE_HOSTS: '', CHEAP_MEM_MCP_HOSTS: '' };
  const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, ...env } });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  const gone = new Promise((r) => child.once('exit', (code) => r(code)));
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
  });
  const until = Date.now() + 40000;
  let up = false;
  while (Date.now() < until && child.exitCode === null) {
    if (await healthy(port)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  // A start that never exits and never answers must fail the probe, not hang it.
  const code = up ? null : await Promise.race([gone, new Promise((r) => setTimeout(() => r('still running'), 8000).unref())]);
  return { up, code, err: () => err };
}

/** The shape every failed listen must have: exit 1, host and port named, a way out, and not one stack frame. */
function assertCleanListenFailure(r, { port, portHint }) {
  assert.equal(r.up, false, 'never became ready');
  assert.equal(r.code, 1, `exit 1, got ${r.code}: ${r.err()}`);
  const err = r.err();
  assert.ok(err.includes(`127.0.0.1:${port}`), `names host and port: ${err}`);
  assert.ok(err.includes(portHint), `names the way to pick another port (${portHint}): ${err}`);
  assert.match(err, /already in use|in use/i, `says what is wrong: ${err}`);
  assert.doesNotMatch(err, /\n\s+at .*(?:\.mjs|node:)|Unhandled|EADDRINUSE|fatal|Error:/i, `no stack, no raw error text: ${err}`);
  assert.equal(err.trim().split('\n').length <= 2, true, `a message of one or two lines, not a dump: ${err}`);
}

test('bin/mem-serve on a taken port: a message with host, port and the way out, exit 1, no stack, no setup code left behind', async (t) => {
  const root = memoryRoot(t);
  const code = path.join(root, '.pipeline', 'serve-setup-code');
  const taken = await occupy(t);
  const r = await run(t, SERVE, [], { CHEAP_MEM_ROOT: root, CHEAP_MEM_SERVE_PORT: String(taken) }, taken);
  assertCleanListenFailure(r, { port: taken, portHint: 'CHEAP_MEM_SERVE_PORT' });
  assert.equal(fs.existsSync(code), false, 'a start that never bound must not leave a setup code behind');

  // Positive control: the same command on a free port starts and DOES make the setup code, so the check above can see it.
  const free = await freePort();
  const ok = await run(t, SERVE, [], { CHEAP_MEM_ROOT: root, CHEAP_MEM_SERVE_PORT: String(free) }, free);
  assert.equal(ok.up, true, `starts on a free port ${ok.err()}`);
  assert.equal(fs.existsSync(code), true, 'positive control: a start that bound does make the setup code');
});

test('mem serve (the command) on a taken port: the same message, exit 1, no stack', async (t) => {
  const root = memoryRoot(t);
  const taken = await occupy(t);
  const r = await run(t, MEM, ['--root', root, 'serve'], { CHEAP_MEM_ROOT: root, CHEAP_MEM_SERVE_PORT: String(taken) }, taken);
  assertCleanListenFailure(r, { port: taken, portHint: '--port' });
  assert.equal(fs.existsSync(path.join(root, '.pipeline', 'serve-setup-code')), false, 'no setup code left behind');
});

test('bin/mem-mcp --http on a taken port: a message with host, port and the way out, exit 1, no stack', async (t) => {
  const root = memoryRoot(t);
  const taken = await occupy(t);
  const r = await run(t, MCP, ['--http'], { CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(taken), CHEAP_MEM_MCP_TOKEN: probeToken() }, taken);
  assertCleanListenFailure(r, { port: taken, portHint: 'CHEAP_MEM_MCP_PORT' });
  assert.ok(!r.err().includes(probeToken()), 'the token is not printed');

  const free = await freePort();
  const ok = await run(t, MCP, ['--http'], { CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(free), CHEAP_MEM_MCP_TOKEN: probeToken() }, free);
  assert.equal(ok.up, true, `positive control: starts on a free port ${ok.err()}`);
});

test('listenFailureMessage: each failure class says its own thing, and an unknown one still names host and port', () => {
  const m = (code, extra = {}) => webauth.listenFailureMessage({ host: '127.0.0.1', port: 8847, code, portVariable: 'P_VAR', portFlag: '--port', ...extra });
  assert.match(m('EADDRINUSE'), /127\.0\.0\.1:8847.*already in use/);
  assert.match(m('EADDRINUSE'), /P_VAR/);
  assert.match(m('EADDRINUSE'), /--port/);
  assert.match(m('EACCES'), /127\.0\.0\.1:8847.*may not bind/);
  assert.match(m('EADDRNOTAVAIL'), /127\.0\.0\.1.*not an address of this machine/i);
  assert.match(m('ESOMETHING', { message: 'odd failure' }), /127\.0\.0\.1:8847.*odd failure/);
  assert.doesNotMatch(m('EADDRINUSE', { portFlag: '' }), /undefined|--port/, 'no flag, no flag in the text');
  // IPv6 hosts are written in brackets so the port is not mistaken for a group.
  assert.match(webauth.listenFailureMessage({ host: '::1', port: 9, code: 'EADDRINUSE' }), /\[::1\]:9/);
});

// --- the bridge has never had a password login ----------------------------------------------------------------------------

test('the bridge refusal does not talk about a password login; the dashboard refusal still does', async (t) => {
  const bridge = webauth.startDecision({ host: '127.0.0.1', variable: 'T', switchVariable: 'S', hasLogin: false });
  assert.equal(bridge.ok, false);
  assert.doesNotMatch(bridge.reason, /password|login/i, bridge.reason);
  assert.match(bridge.reason, /T=<secret>/);
  assert.match(bridge.reason, /--local-no-token or S=1/);
  const bridgeOn = webauth.startDecision({ host: '127.0.0.1', variable: 'T', switchVariable: 'S', hasLogin: false, localNoToken: true });
  assert.equal(bridgeOn.ok, true);
  assert.doesNotMatch(bridgeOn.notice, /password|login/i, bridgeOn.notice);
  assert.match(bridgeOn.notice, /WITHOUT a token/);
  // Positive control: the dashboard keeps its wording.
  const dash = webauth.startDecision({ host: '127.0.0.1', variable: 'T', switchVariable: 'S' });
  assert.match(dash.reason, /no password login stands behind this door/);

  // And the real bridge, started for real: its first line is the refusal and carries no login talk.
  const root = memoryRoot(t);
  const port = await freePort();
  const r = await run(t, MCP, ['--http'], { CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(port) }, port);
  assert.equal(r.code, 1);
  assert.match(r.err(), /^mem-mcp: Refusing to start without a token/);
  assert.doesNotMatch(r.err(), /password|login/i, r.err());
});
