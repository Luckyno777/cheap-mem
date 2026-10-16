// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// serve-token-refuse (owner decision 2026-10-14): "the HTTP service without a token refuses to start, unless a switch
// 'local, no token' is set on purpose."
//
// The two HTTP services (`bin/mem-serve` behind `mem serve`, `bin/mem-mcp --http`) share ONE start decision,
// `webauth.startDecision`. A door with nothing behind it (no token and, on the dashboard, no password login) does not
// start: exit code other than 0, a message that names the token variable, a command that makes a token and the
// switch, and no port bound. The switch (`--local-no-token`, or `CHEAP_MEM_SERVE_LOCAL_NO_TOKEN=1` /
// `CHEAP_MEM_MCP_LOCAL_NO_TOKEN=1`) lifts only that, and only on loopback: a public bind still refuses, a request with
// a proxy header is still turned away, and the start prints that it runs without a token.
//
// Every probe has its positive control (the service DOES start with a token / with the switch on loopback), so a
// refusal cannot be a service that never starts at all.
//
// Windows: processes are started with `process.execPath`, stopped by their handle, `os.tmpdir()` via tempDir, no
// POSIX tools, and no error code is asserted (a refused connect is "an error", whatever its code).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as webauth from '../src/webauth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(ROOT, 'bin', 'mem-serve');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');
const MEM = path.join(ROOT, 'bin', 'mem');
// Built at run time, not typed as a literal: a token in a probe is a probe value, not a secret.
const probeToken = () => ['probe', 'door', 'x'.repeat(20)].join('-');

function memoryRoot(t) {
  const root = tempDir('cm-token-refuse-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    name: 'tokenrefuse', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  return root;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => (e ? reject(e) : resolve(port))); });
});

/** Does something listen on this port? (A refused connect is an error of whatever code: not asserted.) */
const listening = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

function get(port, route, headers = {}, method = 'GET') {
  return new Promise((resolve) => {
    const q = http.request({ host: '127.0.0.1', port, path: route, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (r) => {
      r.resume(); r.on('end', () => resolve(r.statusCode));
    });
    q.on('error', (e) => resolve(`error ${e.code}`));
    q.end();
  });
}

/**
 * Start a command and watch it until it is ready (`/health` answers 200) or has exited. The environment starts clean of every
 * variable under test, so a parent shell cannot decide a probe. Stopped by its handle in `t.after`.
 */
async function start(t, script, args, env, port) {
  const base = { ...process.env, MEM_RECALL_SERVER: '0', CHEAP_MEM_SERVE_TOKEN: '', CHEAP_MEM_MCP_TOKEN: '',
    CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '', CHEAP_MEM_MCP_LOCAL_NO_TOKEN: '', CHEAP_MEM_SERVE_LOGIN: '',
    CHEAP_MEM_SERVE_HOST: '', CHEAP_MEM_MCP_HOST: '', CHEAP_MEM_SERVE_HOSTS: '', CHEAP_MEM_MCP_HOSTS: '' };
  const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...base, ...env } });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  const gone = new Promise((r) => child.once('exit', (code) => r(code)));
  // Bounded: a service that should have refused but runs must fail the probe, not hang it.
  const exited = Promise.race([gone, new Promise((r) => { setTimeout(() => r('still running'), 8000).unref(); })]);
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
  });
  const until = Date.now() + 25000;
  let up = false;
  while (Date.now() < until && child.exitCode === null) {
    if (await get(port, '/health') === 200) { up = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!up && child.exitCode === null) await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  return { up, err: () => err, code: () => child.exitCode, exited };
}

/** The service ended by itself with a code other than 0 (not "still running", not killed by us). */
function assertRefusedExit(code, what = 'service') {
  assert.ok(typeof code === 'number' && code !== 0, `${what}: expected an exit code other than 0, got ${code}`);
}

const serveEnv = (root, port, more = {}) => ({ CHEAP_MEM_ROOT: root, CHEAP_MEM_SERVE_PORT: String(port), ...more });
const mcpEnv = (root, port, more = {}) => ({ CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(port), ...more });

/** The message every refusal must carry: the variable, a way to make a token, the switch in both forms. */
function assertGuidance(err, { variable, switchVariable }) {
  assert.ok(err.includes(variable), `names the token variable ${variable}: ${err}`);
  assert.ok(err.includes(webauth.MAKE_TOKEN_COMMAND), `carries the command that makes a token: ${err}`);
  assert.ok(err.includes('--local-no-token'), `names the switch: ${err}`);
  assert.ok(err.includes(`${switchVariable}=1`), `names the switch variable: ${err}`);
  assert.ok(err.includes(`$env:${variable}=`), `names the PowerShell form of the token: ${err}`);
  // A refusal is a message, not a crash: no stack frames, no "fatal", the first line says what happened.
  assert.doesNotMatch(err, /\n\s+at .*(?:\.mjs|node:)|fatal|Error:/i, `no stack trace: ${err}`);
  assert.match(err.split('\n')[0], /^(?:mem-mcp: )?Refusing to (?:start|bind)/, `the first line is the refusal: ${err}`);
}

// --- the decision itself -------------------------------------------------------------------------------------------

test('startDecision: a credential starts, nothing behind the door refuses, the switch lifts only that', () => {
  const d = (o) => webauth.startDecision({ host: '127.0.0.1', variable: 'T', switchVariable: 'S', ...o });
  assert.deepEqual(d({ token: 'x' }), { ok: true, withoutToken: false }, 'a token starts');
  assert.deepEqual(d({ login: true }), { ok: true, withoutToken: false }, 'a password login is a credential');
  const refused = d({});
  assert.equal(refused.ok, false, 'no token, no login, no switch: refused');
  assert.match(refused.reason, /T=<secret>/);
  assert.match(refused.reason, /--local-no-token or S=1/);
  const on = d({ localNoToken: true });
  assert.equal(on.ok, true, 'the switch on loopback starts');
  assert.equal(on.withoutToken, true);
  assert.match(on.notice, /WITHOUT a token/);
  // The switch never carries a login-less door past a public bind.
  const pub = d({ host: '0.0.0.0', localNoToken: true });
  assert.equal(pub.ok, false);
  assert.match(pub.reason, /works on loopback only/);
  // With a token a public bind is the old, tested behaviour: allowed.
  assert.equal(d({ host: '0.0.0.0', token: 'x' }).ok, true);
});

test('startDecision: loopback is an ALLOW list of three names; every other spelling is public (N5)', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(webauth.isLoopback(host), true, `positive control ${host}`);
    assert.equal(webauth.startDecision({ host, localNoToken: true }).ok, true, host);
  }
  // Not on the list - including real loopback addresses written another way: they fail closed, never open.
  for (const host of ['0.0.0.0', '::', '', ' ', '10.0.0.5', '192.168.1.5', 'example.org', '127.0.0.2', '127.1', '[::1]', '::ffff:127.0.0.1',
    'LOCALHOST', '127.0.0.1.evil.example', 'localhost.evil.example', '127.0.0.1 ', '0', '::0', '0:0:0:0:0:0:0:0', 'undefined']) {
    assert.equal(webauth.isLoopback(host), false, `${JSON.stringify(host)} is not on the list`);
    assert.equal(webauth.startDecision({ host, localNoToken: true }).ok, false, `${JSON.stringify(host)} refuses even with the switch`);
    assert.equal(webauth.startDecision({ host }).ok, false, `${JSON.stringify(host)} refuses without it`);
  }
});

test('a request with a proxy header is not local, switch or not (the per-request half of the rule)', () => {
  const fake = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
  assert.equal(webauth.remoteIsLoopback(fake({}), { strict: true }), true, 'positive control: plain loopback');
  for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip', 'via']) {
    assert.equal(webauth.hasProxyHeader(fake({ [h]: '8.8.8.8' })), true, h);
    assert.equal(webauth.authDecision({ token: '', given: '', remoteLoopback: webauth.remoteIsLoopback(fake({ [h]: '8.8.8.8' }), { strict: true }) }).allowed, false, h);
  }
});

// --- the dashboard -------------------------------------------------------------------------------------------------

test('bin/mem-serve with the login off and no token: exit other than 0, the guidance, and the port is NOT bound', async (t) => {
  const root = memoryRoot(t);
  const port = await freePort();
  const r = await start(t, SERVE, [], serveEnv(root, port, { CHEAP_MEM_SERVE_LOGIN: 'off' }), port);
  assert.equal(r.up, false, 'never became ready');
  const code = await r.exited;
  assertRefusedExit(code);
  assert.equal(code, 1, 'exit 1, as `mem serve` does');
  assertGuidance(r.err(), { variable: 'CHEAP_MEM_SERVE_TOKEN', switchVariable: 'CHEAP_MEM_SERVE_LOCAL_NO_TOKEN' });
  assert.equal(await listening(port), false, 'the port was not bound');
});

test('bin/mem-serve with a token starts (positive control); the same without the login but with the switch starts on loopback', async (t) => {
  const root = memoryRoot(t);
  const p1 = await freePort();
  const withToken = await start(t, SERVE, [], serveEnv(root, p1, { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: probeToken() }), p1);
  assert.equal(withToken.up, true, `starts with a token ${withToken.err()}`);
  assert.doesNotMatch(withToken.err(), /WITHOUT a token/, 'no "without a token" line when there is one');

  const p2 = await freePort();
  const viaFlag = await start(t, SERVE, ['--local-no-token'], serveEnv(root, p2, { CHEAP_MEM_SERVE_LOGIN: 'off' }), p2);
  assert.equal(viaFlag.up, true, `starts with --local-no-token ${viaFlag.err()}`);
  assert.match(viaFlag.err(), /NOTICE: running WITHOUT a token/, 'the start says so');
  assert.match(viaFlag.err(), /NO TOKEN, no login: loopback only/, 'and so does the ready line');
  // Local standing: a plain request is served, a request with a proxy header is turned away (404, the bare answer).
  assert.equal(await get(p2, '/dashboard.json'), 200, 'plain loopback is served');
  assert.equal(await get(p2, '/dashboard.json', { 'x-forwarded-for': '8.8.8.8' }), 404, 'a proxy header takes the local standing');
  assert.equal(await get(p2, '/dashboard.json', { 'cf-connecting-ip': '8.8.8.8' }), 404);

  const p3 = await freePort();
  const viaEnv = await start(t, SERVE, [], serveEnv(root, p3, { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1' }), p3);
  assert.equal(viaEnv.up, true, `starts with the environment switch ${viaEnv.err()}`);
  assert.match(viaEnv.err(), /NOTICE: running WITHOUT a token/);
});

test('bin/mem-serve with the switch on a public bind still refuses, and binds nothing', async (t) => {
  const root = memoryRoot(t);
  for (const host of ['0.0.0.0', '::', '127.0.0.2']) {
    const port = await freePort();
    const r = await start(t, SERVE, ['--local-no-token'], serveEnv(root, port, { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: host }), port);
    assert.equal(r.up, false, `${host}: not ready`);
    const code = await r.exited;
    assertRefusedExit(code, host);
    assert.match(r.err(), /works on loopback only/, host);
    assert.equal(await listening(port), false, `${host}: the port was not bound`);
  }
  // Positive control for the same host with a token: a public bind with a token is the old, allowed shape.
  const port = await freePort();
  const ok = await start(t, SERVE, [], serveEnv(root, port, { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_HOST: '0.0.0.0', CHEAP_MEM_SERVE_TOKEN: probeToken() }), port);
  assert.equal(ok.up, true, `0.0.0.0 with a token starts ${ok.err()}`);
});

test('bin/mem-serve with the password login on (the default) and no token still starts: the password is the door', async (t) => {
  const root = memoryRoot(t);
  const port = await freePort();
  const r = await start(t, SERVE, [], serveEnv(root, port), port);
  assert.equal(r.up, true, `starts ${r.err()}`);
  assert.doesNotMatch(r.err(), /WITHOUT a token/);
  assert.match(r.err(), /password login, localhost only/);
  // The page itself answers with the sign-in, not with content.
  assert.equal(await get(port, '/dashboard.json'), 401, 'no session: refused');
});

test('mem serve (the command): refuses without token, login or switch; starts with --local-no-token; rejects a value for the switch', async (t) => {
  const root = memoryRoot(t);
  const p1 = await freePort();
  const refused = await start(t, MEM, ['--root', root, 'serve'], serveEnv(root, p1, { CHEAP_MEM_SERVE_LOGIN: 'off' }), p1);
  assert.equal(refused.up, false);
  const code = await refused.exited;
  assertRefusedExit(code);
  assert.ok(refused.err().includes('--local-no-token') && refused.err().includes('CHEAP_MEM_SERVE_TOKEN'), refused.err());
  assert.equal(await listening(p1), false, 'the port was not bound');

  const p2 = await freePort();
  const flagged = await start(t, MEM, ['--root', root, 'serve', '--local-no-token'], serveEnv(root, p2, { CHEAP_MEM_SERVE_LOGIN: 'off' }), p2);
  assert.equal(flagged.up, true, `starts with the flag ${flagged.err()}`);
  assert.match(flagged.err(), /NOTICE: running WITHOUT a token/);

  const p3 = await freePort();
  const valued = await start(t, MEM, ['--root', root, 'serve', '--local-no-token=yes'], serveEnv(root, p3, { CHEAP_MEM_SERVE_LOGIN: 'off' }), p3);
  assert.equal(valued.up, false);
  assertRefusedExit(await valued.exited);
  assert.match(valued.err(), /--local-no-token takes no value/);
  assert.equal(await listening(p3), false);
});

// --- the MCP bridge ------------------------------------------------------------------------------------------------

test('bin/mem-mcp --http with no token: exit other than 0, the guidance, and the port is NOT bound', async (t) => {
  const root = memoryRoot(t);
  const port = await freePort();
  const r = await start(t, MCP, ['--http'], mcpEnv(root, port), port);
  assert.equal(r.up, false);
  const code = await r.exited;
  assertRefusedExit(code);
  assert.equal(code, 1, 'exit 1');
  assertGuidance(r.err(), { variable: 'CHEAP_MEM_MCP_TOKEN', switchVariable: 'CHEAP_MEM_MCP_LOCAL_NO_TOKEN' });
  assert.equal(await listening(port), false, 'the port was not bound');
});

test('bin/mem-mcp --http: a token starts it; the switch starts it on loopback and says so; a proxy header is still refused', async (t) => {
  const root = memoryRoot(t);
  const p1 = await freePort();
  const withToken = await start(t, MCP, ['--http'], mcpEnv(root, p1, { CHEAP_MEM_MCP_TOKEN: probeToken() }), p1);
  assert.equal(withToken.up, true, `starts with a token ${withToken.err()}`);
  assert.doesNotMatch(withToken.err(), /WITHOUT a token/);

  const p2 = await freePort();
  const viaFlag = await start(t, MCP, ['--http', '--local-no-token'], mcpEnv(root, p2), p2);
  assert.equal(viaFlag.up, true, `starts with --local-no-token ${viaFlag.err()}`);
  assert.match(viaFlag.err(), /NOTICE: running WITHOUT a token/);
  // /mcp: a plain loopback request passes the door (whatever the transport then says about an empty GET), a tunnelled one is 403.
  const plain = await get(p2, '/mcp', {}, 'POST');
  assert.notEqual(plain, 403, `positive control: plain loopback is let through the door (${plain})`);
  assert.notEqual(plain, 401);
  assert.equal(await get(p2, '/mcp', { 'x-forwarded-for': '8.8.8.8' }, 'POST'), 403, 'a proxy header is refused even with the switch');
  assert.equal(await get(p2, '/mcp', { 'cf-connecting-ip': '8.8.8.8' }, 'POST'), 403);

  const p3 = await freePort();
  const viaEnv = await start(t, MCP, ['--http'], mcpEnv(root, p3, { CHEAP_MEM_MCP_LOCAL_NO_TOKEN: '1' }), p3);
  assert.equal(viaEnv.up, true, `starts with the environment switch ${viaEnv.err()}`);
});

test('bin/mem-mcp --http with the switch on a public bind still refuses, and binds nothing', async (t) => {
  const root = memoryRoot(t);
  for (const host of ['0.0.0.0', '::']) {
    const port = await freePort();
    const r = await start(t, MCP, ['--http', '--local-no-token'], mcpEnv(root, port, { CHEAP_MEM_MCP_HOST: host }), port);
    assert.equal(r.up, false, `${host}: not ready`);
    const code = await r.exited;
    assertRefusedExit(code, host);
    assert.match(r.err(), /works on loopback only/, host);
    assert.equal(await listening(port), false, `${host}: the port was not bound`);
  }
});

test('the switch changes nothing for the stdio bridge (no port, no door)', () => {
  const src = fs.readFileSync(MCP, 'utf8');
  assert.match(src, /if \(HTTP_MODE\) \{\s*await startHttp\(pkg\);/, 'the decision sits in startHttp, which only the HTTP mode reaches');
});

// --- inventory and the no-lock-out guards --------------------------------------------------------------------------

// --- the inventory of listeners ------------------------------------------------------------------------------------
//
// A ratchet against the COMMON shapes, not a proof: a file under bin/, src/, install/, hooks/, shared/, bench/ or eval/ that
// imports a network module (net, http, https, http2, tls, dgram; static, dynamic or require) AND creates a server (`createServer`
// / `createSecureServer` / `createSocket` by any receiver, `new Server(`, `new h.Server(`; `h['createServer']` is the same bare word, quoted) must be one of
//   - the two doored services (`bin/mem-serve`, `bin/mem-mcp`): they must call `webauth.startDecision` and act on a refusal;
//   - the recall server: a Unix socket / named pipe with a key file, every `.listen(` takes the socket path, never a port;
//   - the two bench helpers that find a free port: they bind `127.0.0.1:0` for an instant and close it, serving nothing.
// Comments are removed first (a comment that mentions `startDecision(` or `createServer(` proves nothing). Shell and PowerShell
// files are scanned for the usual listeners (`http.server`, `HttpListener`, `nc -l`, `socat ...LISTEN`). A name built at run
// time (`h['create' + 'Server']`) is NOT seen. tests/ are not scanned: a test's fixture server is not a shipped service, and
// the probes that start the real services set the switch (or a token) on purpose.
const SCAN_DIRS = ['bin', 'src', 'install', 'hooks', 'shared', 'bench', 'eval'];
const DOORED = ['bin/mem-mcp', 'bin/mem-serve'];
const SOCKET_ONLY = { 'src/recallserver.mjs': 'a Unix socket / named pipe with a key file, not a TCP port' };
const LOOPBACK_PROBES = {
  'bench/scale-gate.mjs': 'finds a free port: binds 127.0.0.1:0, closes at once, serves nothing',
  'bench/board-tempo.mjs': 'finds a free port: binds 127.0.0.1:0, closes at once, serves nothing',
};
const NET_MODULE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:node:)?(?:net|http|https|http2|tls|dgram)['"]/;
const CREATION = /\bcreate(?:Secure)?Server\b|\bcreateSocket\b|\bnew\s+(?:[A-Za-z_$][\w$]*\.)?(?:Http2?|Https?|Net|Tls)?Server\s*\(|\b(?:net|tls|https?2?)\.Server\b/;
const SHELL_LISTENER = /\bhttp\.server\b|\bHttpListener\b|\bTcpListener\b|TCP-LISTEN|\bnc\s+-\w*l|\bncat\b[^\n]*(?:-l\b|--listen)|\bsocat\b[^\n]*LISTEN/i;

/** Remove `//` and block comments outside strings. A string ends at its quote or at the end of the line (a regex literal with a quote cannot swallow the file). */
function stripJsComments(src) {
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j += 1; j += 1; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') { if (src[j] === '\\') j += 1; j += 1; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i += 1;
  }
  return out;
}
const stripShellComments = (src) => src.split('\n').filter((l) => !/^\s*#(?!!)/.test(l)).join('\n');

function walkFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
}

/** What kind of text is this file: 'js', 'shell' or null (binary, data, anything else)? */
function kindOf(file, text) {
  if (text.includes('\0') || text.length > 2_000_000) return null;
  const ext = path.extname(file).toLowerCase();
  if (['.mjs', '.js', '.cjs', '.ts'].includes(ext)) return 'js';
  if (['.sh', '.bash', '.ps1'].includes(ext)) return 'shell';
  const first = text.split('\n', 1)[0];
  if (ext === '' && /^#!.*\bnode\b/.test(first)) return 'js';
  if (ext === '') return 'shell'; // a hook or script without extension: read as shell (a shebang-less file is still text)
  return null;
}

/** Every listener-shaped file under `root`, and what is wrong with each. Returns { found, problems }. */
function inventory(root) {
  const found = []; const problems = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walkFiles(path.join(root, dir))) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const kind = kindOf(file, raw);
      if (!kind) continue;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const text = kind === 'js' ? stripJsComments(raw) : stripShellComments(raw);
      const listens = kind === 'js' ? (NET_MODULE.test(text) && CREATION.test(text)) : SHELL_LISTENER.test(text);
      if (!listens) continue;
      found.push(rel);
      if (DOORED.includes(rel)) {
        if (!/\bwebauth\.startDecision\(/.test(text) || !/!\s*\w+\.ok\)\s*throw/.test(text)) problems.push(`${rel}: opens a listener without acting on webauth.startDecision`);
      } else if (rel in SOCKET_ONLY) {
        const args = [...text.matchAll(/\.listen\(\s*([^,)\s]+)/g)].map((m) => m[1]);
        if (args.length === 0 || args.some((a) => a !== 'where.socket')) problems.push(`${rel}: a listener that is not the socket path (${args.join(', ')})`);
      } else if (rel in LOOPBACK_PROBES) {
        const listensOk = [...text.matchAll(/\.listen\(([^)]*)/g)].every((m) => /^\s*0\s*,\s*'127\.0\.0\.1'/.test(m[1]));
        const creates = [...text.matchAll(/\bnet\.createServer\(([^)]*)\)/g)].every((m) => m[1].trim() === '');
        if (!listensOk || !creates || /\bcreateSecureServer\b|\bhttps?2?\.create/.test(text)) problems.push(`${rel}: more than a free-port probe`);
      } else {
        problems.push(`${rel}: a listener that is neither a doored service nor a named exemption`);
      }
    }
  }
  return { found: found.sort(), problems };
}

test('inventory: every listener under bin/ src/ install/ hooks/ shared/ bench/ eval/ is a doored service or a named exemption', () => {
  const { found, problems } = inventory(ROOT);
  assert.deepEqual(problems, [], 'a new listener: give it the start decision, or name it above with the reason');
  assert.deepEqual(found, [...DOORED, ...Object.keys(LOOPBACK_PROBES), ...Object.keys(SOCKET_ONLY)].sort(), 'the exemptions are not stale: each one is still found');
  for (const [f, why] of Object.entries({ ...SOCKET_ONLY, ...LOOPBACK_PROBES })) assert.ok(why.length > 20, `${f} carries its reason`);
});

test('inventory counter-probes: each pattern, each directory and the comment rule turn a sample file red', () => {
  const SAMPLES = {
    'net.createServer on 0.0.0.0': ["import net from 'node:net';\nnet.createServer(() => {}).listen(0, '0.0.0.0');\n", 'src/x.mjs'],
    'createServer imported from node:net': ["import { createServer } from 'node:net';\ncreateServer().listen(8080);\n", 'src/x.mjs'],
    'dynamic import and bracket access': ["const h = await import('node:http');\nh['createServer'](() => {}).listen(80);\n", 'src/x.mjs'],
    'new Server from node:http': ["import { Server } from 'node:http';\nconst s = new Server(() => {});\n", 'src/x.mjs'],
    'new h.Server on a namespace import': ["import * as h from 'node:https';\nconst s = new h.Server({});\n", 'src/x.mjs'],
    'require and createSecureServer on http2': ["const http2 = require('node:http2');\nhttp2.createSecureServer({});\n", 'src/x.cjs'],
    'tls createServer, module without the node: prefix': ["import tls from 'tls';\ntls.createServer({});\n", 'src/x.mjs'],
    'dgram socket': ["import dgram from 'node:dgram';\ndgram.createSocket('udp4');\n", 'src/x.mjs'],
    'extensionless node script in bin/': ["#!/usr/bin/env node\nimport http from 'node:http';\nhttp.createServer(() => {}).listen(1);\n", 'bin/mem-extra'],
    'in install/': ["import net from 'node:net';\nnet.createServer();\n", 'install/x.mjs'],
    'in hooks/': ["import net from 'node:net';\nnet.createServer();\n", 'hooks/x.mjs'],
    'in shared/': ["import net from 'node:net';\nnet.createServer();\n", 'shared/x.mjs'],
    'in bench/ (not one of the two free-port helpers)': ["import net from 'node:net';\nnet.createServer(() => {}).listen(0, '0.0.0.0');\n", 'bench/x.mjs'],
    'in eval/': ["import net from 'node:net';\nnet.createServer();\n", 'eval/x.mjs'],
    'shell: python http.server': ['#!/usr/bin/env bash\npython3 -m http.server 8000\n', 'install/serve.sh'],
    'shell: netcat listen': ['nc -l 9000\n', 'hooks/pre-commit'],
    'PowerShell: HttpListener': ['$l = [System.Net.HttpListener]::new()\n', 'install/x.ps1'],
  };
  for (const [name, [text, rel]] of Object.entries(SAMPLES)) probeSample(name, rel, text);
  function probeSample(name, rel, text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inventory-'));
    try {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
      const r = inventory(dir);
      assert.ok(r.found.includes(rel) && r.problems.length > 0, `${name}: the sample file must turn the inventory red, got ${JSON.stringify(r)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
  // Not a listener: a comment that names one, a client, a module that only reads. Green.
  const quiet = {
    'a comment that names createServer': "import net from 'node:net';\n// net.createServer().listen(80)\n/* http.createServer( */\nnet.connect(80);\n",
    'a client only': "import net from 'node:net';\nnet.connect(80, '127.0.0.1');\n",
    'createServer without a network module (a local function)': 'function createServer() {}\ncreateServer();\n',
  };
  for (const [name, text] of Object.entries(quiet)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inventory-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'x.mjs'), text);
      const r = inventory(dir);
      assert.deepEqual(r, { found: [], problems: [] }, `${name}: not a listener`);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
  // A doored service whose only mention of the decision is a comment is red; with the real call it is green.
  const door = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inventory-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'bin', 'mem-serve'), `#!/usr/bin/env node\nimport http from 'node:http';\n${body}\nhttp.createServer(() => {});\n`);
      return inventory(dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  };
  assert.ok(door('// webauth.startDecision(cfg)\n/* if (!d.ok) throw new Error(); */').problems.length > 0, 'a comment is not the door');
  assert.deepEqual(door('const d = webauth.startDecision(cfg);\nif (!d.ok) throw new Error(d.reason);').problems, [], 'positive control: the real call is accepted');
  assert.ok(door('const d = webauth.startDecision(cfg);').problems.length > 0, 'calling it and ignoring a refusal is not the door');
  // The socket-only and free-port exemptions are narrow: the same file name with a TCP port is red.
  const tcpRecall = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inventory-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'recallserver.mjs'), "import net from 'node:net';\nnet.createServer().listen(8080, '0.0.0.0');\n");
      return inventory(dir);
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  })();
  assert.ok(tcpRecall.problems.length > 0, 'the recall exemption does not cover a TCP listen');
  // The recall server itself: a socket path, no port (the inventory above pins it; this names the shape).
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'recallserver.mjs'), 'utf8'), /server\.listen\(where\.socket,/);
});

test('no lock-out: the service units set no switch and no LOGIN=off (the password stays the door); the docs carry the way out', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'install', 'serve-service.sh'), 'utf8');
  assert.doesNotMatch(unit, /^\s*(Environment=)?CHEAP_MEM_SERVE_LOGIN=off/m, 'the unit must not turn the login off');
  assert.doesNotMatch(unit, /^\s*Environment=CHEAP_MEM_SERVE_TOKEN/m, 'and carries no token');
  for (const f of ['docs/dashboard.md', 'docs/mcp-setup.md', 'docs/security-model.md']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(text.includes('--local-no-token'), `${f} names the switch`);
  }
  assert.ok(fs.readFileSync(path.join(ROOT, 'docs', 'dashboard.md'), 'utf8').includes("randomBytes(24).toString('hex')"), 'docs/dashboard.md says how to make a token');
  assert.ok(fs.readFileSync(path.join(ROOT, 'docs', 'mcp-setup.md'), 'utf8').includes("randomBytes(24).toString('hex')"), 'docs/mcp-setup.md says how to make a token');
});
