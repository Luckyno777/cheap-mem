// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// B5-B9 (external security review, 2026-10-11): the dashboard's doors, against a real server.
//
//   B5  The bearer token could set the FIRST password and so became a person session. Now only the
//       setup code on the machine does. `/login/logout` is no bearer route either.
//   B6  `/inbox/reply` and `/inbox/state` wrote as the human with the bearer alone (or, with login
//       off, with a same-origin header alone). Now: a password session, 403 otherwise.
//   B7  `/setting` (raw-archive redirect), the two verdict routes and the `raw-delete` task needed only
//       the token. Now a password session; the archive target must lie inside an allowed base.
//   B8  Five routes lacked the Host check: `/`, `/desk.json`, `/console.json`, `/entry.json`, `/task.json`.
//   B9  The sign-in lock took its source from `CF-Connecting-IP` from any loopback client: six wrong
//       passwords with six different headers were never locked. The header counts only with
//       CHEAP_MEM_SERVE_BEHIND_TUNNEL=1. The lock across ALL sources (a stranger could lock the owner
//       out) is gone; the lock is per source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as login from '../src/login.mjs';
import * as inbox from '../src/inbox.mjs';
import * as dashboardPage from '../src/dashboard-page.mjs';
import { personCookie } from './person-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const MEM = path.join(HERE, '..', 'bin', 'mem');
const DOOR = ['probe', 'door', String(process.pid)].join('-');
const BEARER = { authorization: `Bearer ${DOOR}` };
const PW = 'a-proper-long-password';
const WRONG = ['not', 'the', 'one', String(process.pid)].join('-'); // assembled, not a literal
/** The token door wants the bearer or the `mem_k` cookie; the person check wants the session cookie. */
const SESS = (c) => ({ cookie: `${c}; mem_k=${DOOR}` });

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-b59-'));
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', r, '--participants', 'lucky,session', '--human', 'lucky'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const file = path.join(r, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.dashboard = { allowWrites: true };
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return r;
}

async function start(root, env = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', ...env,
  }, { allowWrites: true });
  return {
    base: `http://127.0.0.1:${server.address().port}`, port: server.address().port,
    stop: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  };
}

/** Raw http: lets a probe set Host and CF-Connecting-IP. */
function raw(s, route, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: s.port, path: route, method,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }, (r) => {
      let text = ''; r.on('data', (c) => { text += c; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, text }));
    });
    q.on('error', reject); q.end(body);
  });
}
const form = (o) => new URLSearchParams(o).toString();
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });

// --- B5 ----------------------------------------------------------------------------------------------

test('B5: the bearer token cannot set the first password; the setup code still can', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const bad = await fetch(`${s.base}/login/setup`, {
      method: 'POST', headers: { ...BEARER, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ password: PW, password2: PW }),
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('set-cookie'), null, 'a session came with it');
    assert.equal(login.isSet(login.dirFor(r)), false, 'the password was set');
    const code = fs.readFileSync(path.join(r, '.pipeline', 'serve-setup-code'), 'utf8').trim();
    const ok = await fetch(`${s.base}/login/setup`, {
      method: 'POST', redirect: 'manual', headers: { ...BEARER, origin: s.base },
      body: new URLSearchParams({ code, password: PW, password2: PW }),
    });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('set-cookie') ?? '', /^mem_session=/);
  } finally { await s.stop(); gone(r); }
});

test('B5: /login/logout needs a session; the bearer alone gets 401 and clears nothing', async () => {
  const r = memory();
  const cookie = personCookie(r);
  const s = await start(r);
  try {
    const viaBearer = await fetch(`${s.base}/login/logout`, { method: 'POST', redirect: 'manual', headers: BEARER });
    assert.equal(viaBearer.status, 401);
    assert.equal(viaBearer.headers.get('set-cookie'), null);
    assert.equal(viaBearer.headers.get('clear-site-data'), null);
    const viaSession = await fetch(`${s.base}/login/logout`, { method: 'POST', redirect: 'manual', headers: { ...SESS(cookie), origin: s.base } });
    assert.equal(viaSession.status, 303);
  } finally { await s.stop(); gone(r); }
});

// --- B6 ----------------------------------------------------------------------------------------------

test('B6: /inbox/reply and /inbox/state answer 403 without a password session and write nothing', async () => {
  const r = memory();
  const parts = { lucky: { human: true }, session: {} };
  const name = inbox.write(r, parts, { from: 'session', to: 'lucky', subject: 'ping', text: 'are you there?' }).name;
  const cookie = personCookie(r);
  const s = await start(r);
  const before = fs.readdirSync(path.join(r, 'inbox')).length;
  try {
    for (const [route, body] of [['/inbox/reply', { name, text: 'yes, approved', from: '/' }], ['/inbox/state', { name, state: 'closed' }]]) {
      const viaBearer = await fetch(s.base + route, { method: 'POST', redirect: 'manual', headers: { ...BEARER, origin: s.base }, body: new URLSearchParams(body) });
      assert.equal(viaBearer.status, 403, `${route} with the bearer`);
      assert.match(await viaBearer.text(), /password session/);
    }
    assert.equal(fs.readdirSync(path.join(r, 'inbox')).length, before, 'a reply was written');
    assert.equal(inbox.stateOf(r, name).state, 'open', 'the state moved');
    // positive control: the same requests with a password session go through
    const st = await fetch(`${s.base}/inbox/state`, { method: 'POST', redirect: 'manual', headers: { ...SESS(cookie), origin: s.base }, body: new URLSearchParams({ name, state: 'processed' }) });
    assert.equal(st.status, 303);
    assert.equal(inbox.stateOf(r, name).state, 'processed');
    const rp = await fetch(`${s.base}/inbox/reply`, { method: 'POST', redirect: 'manual', headers: { ...SESS(cookie), origin: s.base }, body: new URLSearchParams({ name, text: 'yes', from: '/' }) });
    assert.equal(rp.status, 303, await rp.text());
  } finally { await s.stop(); gone(r); }
});

test('B6: with the login switched off nothing writes as the owner either (no same-origin-only door)', async () => {
  const r = memory();
  const parts = { lucky: { human: true }, session: {} };
  const name = inbox.write(r, parts, { from: 'session', to: 'lucky', subject: 'ping', text: 'x' }).name;
  const s = await start(r, { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  try {
    const res = await fetch(`${s.base}/inbox/state`, { method: 'POST', redirect: 'manual', headers: { origin: s.base }, body: new URLSearchParams({ name, state: 'closed' }) });
    assert.equal(res.status, 403);
    assert.equal(inbox.stateOf(r, name).state, 'open');
  } finally { await s.stop(); gone(r); }
});

// --- B7 ----------------------------------------------------------------------------------------------

test('B7: /setting needs a password session; raw-archive stays inside an allowed base', async () => {
  const r = memory();
  const cookie = personCookie(r);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-b7-target-'));
  const s = await start(r);
  const post = (headers, value) => fetch(`${s.base}/setting`, {
    method: 'POST', redirect: 'manual', headers: { origin: s.base, ...headers }, body: new URLSearchParams({ id: 'raw-archive', value }),
  });
  const archiveFile = path.join(r, '.mem', 'archive.json');
  try {
    assert.equal((await post(BEARER, target)).status, 403, 'the bearer redirected the archive');
    assert.equal(fs.existsSync(archiveFile), false);
    // a session, but a place outside every base (not the root, home, temp or a listed base)
    const outside = path.join(path.parse(os.homedir()).root, 'cm-b7-not-allowed', String(process.pid));
    const refused = await post(SESS(cookie), outside);
    assert.equal(refused.status, 400, await refused.text());
    assert.equal(fs.existsSync(archiveFile), false);
    assert.equal(fs.existsSync(outside), false, 'the folder was created');
    assert.equal((await post(SESS(cookie), target)).status, 303, 'positive control: an allowed folder works');
    assert.equal(JSON.parse(fs.readFileSync(archiveFile, 'utf8')).location, fs.realpathSync(target) === target ? target : JSON.parse(fs.readFileSync(archiveFile, 'utf8')).location);
  } finally { await s.stop(); gone(r); gone(target); }
});

test('B7: the verdict routes need a password session', async () => {
  const r = memory();
  const cookie = personCookie(r);
  const s = await start(r);
  const mod = await import(pathToFileURL(SERVE).href);
  const verifyFile = path.join(os.tmpdir(), `cm-b7-verify-${process.pid}.jsonl`);
  try {
    for (const route of [mod.VERIFY_VERDICT_PATH, mod.GOLD_VERDICT_PATH]) {
      const res = await fetch(s.base + route, { method: 'POST', headers: { ...BEARER, origin: s.base }, body: new URLSearchParams({ verdict: 'empty-correct', expected: '[]' }) });
      assert.equal(res.status, 403, route);
    }
    // control: with a session the gate lets the request on (what it answers then is its own business, not 403 here)
    const res = await fetch(s.base + mod.GOLD_VERDICT_PATH, { method: 'POST', headers: { ...SESS(cookie), origin: s.base }, body: new URLSearchParams({ verdict: 'empty-correct', expected: '[]' }) });
    assert.notEqual(res.status, 403, await res.text());
  } finally { await s.stop(); gone(r); fs.rmSync(verifyFile, { force: true }); }
});

test('B7: raw-delete is a humanOnly task: the bearer gets 403 NOT_A_PERSON', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/task`, { method: 'POST', headers: { ...BEARER, origin: s.base, accept: 'application/json' }, body: new URLSearchParams({ kind: 'raw-delete', path: 'raw/2026/10/x.jsonl.gz', reason: 'probe reason' }) });
    assert.equal(res.status, 403, await res.text());
  } finally { await s.stop(); gone(r); }
});

// --- B8 ----------------------------------------------------------------------------------------------

test('B8: every data route and the page refuse a foreign Host (control: the right host is let in)', async () => {
  const r = memory();
  const s = await start(r);
  try {
    for (const route of ['/', '/dashboard', '/desk.json', '/console.json', '/entry.json?name=x', '/task.json', '/dashboard.json']) {
      const evil = await raw(s, route, { headers: { ...BEARER, host: 'evil.example:18848' } });
      assert.equal(evil.status, 403, `${route} with a foreign Host`);
      assert.match(evil.text, /foreign-host/);
    }
    for (const route of ['/desk.json', '/console.json', '/task.json']) {
      const ok = await raw(s, route, { headers: BEARER });
      assert.notEqual(ok.status, 403, `${route} with the right Host`);
    }
    // Central (review of B8): EVERY route of the server that is not an asset refuses a foreign Host - a route
    // nobody named in a list included.
    const mod = await import(pathToFileURL(SERVE).href);
    const asset = new Set([
      ...Object.keys(dashboardPage.FILES), ...dashboardPage.FONTS.map((f) => f.path), ...login.ALL_PATHS,
      '/favicon.ico', '/sw.js', '/manifest.webmanifest', dashboardPage.PATHS.swRegister,
    ]);
    const routes = mod.PATHS.filter((p) => !asset.has(p));
    assert.ok(routes.length > 20 && routes.includes('/dashboard'), 'positive control: the route list is real');
    for (const route of routes) {
      const evil = await raw(s, route, { headers: { ...BEARER, host: 'evil.example:18848' } });
      assert.equal(evil.status, 403, `${route} with a foreign Host`);
    }
  } finally { await s.stop(); gone(r); }
});

// --- B9 ----------------------------------------------------------------------------------------------

test('B9: sourceOf trusts CF-Connecting-IP only when the operator said the server sits behind a tunnel', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '203.0.113.9' } };
  assert.equal(login.sourceOf(req), '127.0.0.1');
  assert.equal(login.sourceOf(req, { tunnel: false }), '127.0.0.1');
  assert.equal(login.sourceOf(req, { tunnel: true }), '203.0.113.9');
  assert.equal(login.sourceOf({ socket: { remoteAddress: '198.51.100.7' }, headers: { 'cf-connecting-ip': '203.0.113.9' } }, { tunnel: true }), '198.51.100.7',
    'a non-loopback client never sets its own source');
  assert.equal(login.behindTunnel({ CHEAP_MEM_SERVE_BEHIND_TUNNEL: '1' }), true);
  assert.equal(login.behindTunnel({}), false);
});

test('B9: a changing CF-Connecting-IP no longer escapes the per-source lock', async () => {
  const r = memory();
  login.setPassword(login.dirFor(r), PW);
  const s = await start(r);
  const codes = [];
  try {
    for (let i = 0; i < 6; i += 1) {
      const res = await raw(s, '/login', { method: 'POST', headers: { ...BEARER, origin: s.base, 'cf-connecting-ip': `203.0.113.${i + 1}` }, body: form({ password: WRONG }) });
      codes.push(res.status);
    }
    assert.ok(codes.includes(429), `no lock after six wrong passwords: ${codes}`);
  } finally { await s.stop(); gone(r); }
});

test('B9: behind a declared tunnel the sources stay separate, and failures of many sources lock nobody else', async () => {
  const b = login.newLimiter();
  for (let i = 0; i < login.GLOBAL_LOCK_FROM + 5; i += 1) b.failure(`src-${i}`);
  assert.equal(b.wait('the-owner'), 0, 'strangers locked the owner out');
  for (let i = 0; i < 4; i += 1) b.failure('one');
  assert.ok(b.wait('one') > 0, 'positive control: the per-source lock bites');
});

test('B9: one server line (never the header value) when CF-Connecting-IP arrives from loopback without the declaration', async () => {
  const r = memory();
  const lines = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (z, ...rest) => { lines.push(String(z)); return real(z, ...rest); };
  const s = await start(r);
  const s2 = await start(memory(), { CHEAP_MEM_SERVE_BEHIND_TUNNEL: '1' });
  const seenIp = '203.0.113.77';
  try {
    for (let i = 0; i < 3; i += 1) await raw(s, '/health', { headers: { 'cf-connecting-ip': seenIp } }) && await raw(s, '/login', { headers: { ...BEARER, 'cf-connecting-ip': seenIp } });
    await raw(s2, '/login', { headers: { ...BEARER, 'cf-connecting-ip': seenIp } });
    const noted = lines.filter((z) => z.includes('CHEAP_MEM_SERVE_BEHIND_TUNNEL'));
    assert.equal(noted.length, 1, `one line, got ${noted.length}: ${noted.join('')}`);
    assert.ok(!lines.some((z) => z.includes(seenIp)), 'the header value was logged');
  } finally { process.stderr.write = real; await s.stop(); await s2.stop(); gone(r); }
});
