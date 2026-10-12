// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Fable security run 2026-10-11, ported from lucky-mem (B9/B14): "the socket is loopback" proves nothing about the
// requester when a tunnel on this machine (cloudflared) connects from 127.0.0.1. With no token that was the whole door:
// whoever reached the tunnel was in. Now a request that carries a proxy header (cf-connecting-ip, cf-ray, x-forwarded-*,
// forwarded, x-real-ip) is NOT local, so without a token the door stays shut. With a token nothing changes. With the
// login on, the password stands behind the door, so a password-only setup behind a tunnel keeps working: only the case
// "no token and login off" is affected on the viewer. The MCP bridge has no login, so it is always strict there.
// Positive control in every probe: plain loopback without headers stays local.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as webauth from '../src/webauth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(ROOT, 'bin', 'mem-serve');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');
const fake = (headers = {}, address = '127.0.0.1') => ({ socket: { remoteAddress: address }, headers });
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-access-jwt-assertion', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];

test('remoteIsLoopback: plain loopback is local; every proxy header takes the trust away (strict)', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(webauth.remoteIsLoopback(fake({}, a), { strict: true }), true, `positive control ${a}`);
    assert.equal(webauth.remoteIsLoopback(fake({}, a)), true);
  }
  for (const h of PROXY_HEADERS) {
    assert.equal(webauth.remoteIsLoopback(fake({ [h]: '8.8.8.8' }), { strict: true }), false, h);
    assert.equal(webauth.remoteIsLoopback(fake({ [h]: '' }), { strict: true }), false, `${h} present but empty`);
    assert.equal(webauth.remoteIsLoopback(fake({ [h]: '8.8.8.8' })), true, `${h}: not strict, the login stands behind the door`);
  }
  assert.equal(webauth.remoteIsLoopback(fake({}, '10.0.0.5'), { strict: true }), false);
  assert.equal(webauth.remoteIsLoopback({}, { strict: true }), false);
  // unrelated headers do not count
  assert.equal(webauth.remoteIsLoopback(fake({ accept: '*/*', 'user-agent': 'curl', origin: 'http://x' }), { strict: true }), true);
});

function raw(port, route, headers = {}, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (r) => {
      let text = ''; r.on('data', (c) => { text += c; }); r.on('end', () => resolve({ status: r.statusCode, text }));
    });
    q.on('error', reject); q.end(body);
  });
}

async function viewer(env) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-loopback-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'lb', participants: ['someone'], language: 'en' }));
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '', ...env }, {});
  return { port: server.address().port, stop: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); fs.rmSync(r, { recursive: true, force: true }); }) };
}

test('viewer without token and with the login off: a proxy header closes the door (404), plain loopback is served', async () => {
  const s = await viewer({ CHEAP_MEM_SERVE_LOGIN: 'off' });
  try {
    assert.equal((await raw(s.port, '/dashboard.json')).status, 200, 'positive control: plain loopback');
    for (const h of PROXY_HEADERS) {
      const res = await raw(s.port, '/dashboard.json', { [h]: '8.8.8.8' });
      assert.equal(res.status, 404, `${h}: ${res.status} ${res.text.slice(0, 80)}`);
      assert.equal(res.text, 'not found');
    }
    assert.equal((await raw(s.port, '/health', { 'cf-connecting-ip': '8.8.8.8' })).status, 200, '/health stays open');
  } finally { await s.stop(); }
});

test('viewer without token and with the login ON: the password stands behind the door, a proxy header does not lock the owner out', async () => {
  const s = await viewer({});
  try {
    for (const headers of [{}, { 'cf-connecting-ip': '8.8.8.8', 'x-forwarded-for': '8.8.8.8' }]) {
      const res = await raw(s.port, '/dashboard.json', headers);
      // past the door: the sign-in gate answers (not the invisible 404 of the closed door)
      assert.notEqual(res.status, 404, JSON.stringify(headers));
      assert.ok(res.status === 401 || res.status === 302 || res.status === 303 || res.status === 200, `${res.status}`);
    }
  } finally { await s.stop(); }
});

test('viewer with a token: proxy headers change nothing', async () => {
  const token = ['probe', 'loop', String(process.pid)].join('-');
  const s = await viewer({ CHEAP_MEM_SERVE_TOKEN: token, CHEAP_MEM_SERVE_LOGIN: 'off' });
  try {
    const h = { authorization: `Bearer ${token}` };
    assert.equal((await raw(s.port, '/dashboard.json', h)).status, 200);
    assert.equal((await raw(s.port, '/dashboard.json', { ...h, 'cf-connecting-ip': '8.8.8.8' })).status, 200);
    assert.equal((await raw(s.port, '/dashboard.json', { 'cf-connecting-ip': '8.8.8.8' })).status, 404, 'no token, no entry');
  } finally { await s.stop(); }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.once('error', reject);
    sock.listen(0, '127.0.0.1', () => { const { port } = sock.address(); sock.close((e) => (e ? reject(e) : resolve(port))); });
  });
}

test('MCP bridge over HTTP without a token: a proxy header is refused (403), plain loopback is served', async () => {
  const memory = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-loopback-mcp-'));
  fs.mkdirSync(path.join(memory, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(memory, '.mem', 'config.json'), JSON.stringify({ version: 1 }));
  const port = await freePort();
  let errors = '';
  const child = spawn(process.execPath, [MCP, '--http'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CHEAP_MEM_ROOT: memory, CHEAP_MEM_MCP_PORT: String(port), CHEAP_MEM_MCP_TOKEN: '' },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { errors += c; });
  try {
    for (const until = Date.now() + 10000; ; await new Promise((ok) => { setTimeout(ok, 25); })) {
      if (child.exitCode !== null) throw new Error(`mem-mcp exited: ${errors}`);
      try { if ((await raw(port, '/health')).status === 200) break; } catch { /* not up yet */ }
      if (Date.now() > until) throw new Error(`not ready: ${errors}`);
    }
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p', version: '1' } } });
    const base = { host: `127.0.0.1:${port}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const plain = await raw(port, '/mcp', base, { method: 'POST', body: init });
    assert.equal(plain.status, 200, `positive control: plain loopback -> ${plain.status} ${plain.text.slice(0, 100)}`);
    for (const h of ['cf-connecting-ip', 'x-forwarded-for']) {
      const res = await raw(port, '/mcp', { ...base, [h]: '8.8.8.8' }, { method: 'POST', body: init });
      assert.equal(res.status, 403, `${h}: ${res.status}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((ok) => { if (child.exitCode !== null) ok(); else child.once('exit', ok); });
    fs.rmSync(memory, { recursive: true, force: true });
  }
});

/** Put the real stderr writer back (a function of its own: eslint's require-atomic-updates dislikes an assignment after an await). */
function restoreStderr(original) { process.stderr.write = original; }

test('the viewer says ONCE on stderr why it turned a proxy-header request away (no token, login off), never the header value', async () => {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = function capture(chunk, ...rest) { lines.push(String(chunk)); return orig.call(this, chunk, ...rest); };
  const s = await viewer({ CHEAP_MEM_SERVE_LOGIN: 'off' });
  try {
    const headerValue = 'zz-header-value-8.8.8.8';
    await raw(s.port, '/dashboard.json', { 'cf-connecting-ip': headerValue });
    await raw(s.port, '/dashboard.json', { 'x-forwarded-for': headerValue });
    await raw(s.port, '/dashboard.json'); // plain loopback: no hint
    const hint = lines.filter((l) => /proxy header/i.test(l));
    assert.equal(hint.length, 1, `exactly one hint expected: ${JSON.stringify(hint)}`);
    assert.match(hint[0], /CHEAP_MEM_SERVE_TOKEN/);
    assert.ok(!lines.join('').includes(headerValue), 'the header value must never be printed');
  } finally { restoreStderr(orig); await s.stop(); }
});
