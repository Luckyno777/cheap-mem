// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// login.test.mjs — the password in front of the dashboard (2026-09-28,
// parity with the sibling's test/login.test.mjs).
//
// One probe per guarantee plus a positive control (the same probe sees
// content where the guarantee is not meant to bite). Red proof against the
// fixed state 6154cd0 (before this build): there `/` and `/dashboard.json`
// served content without any sign-in, and `/login` was a 404.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as login from '../src/login.mjs';
import * as pwa from '../src/pwa.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'bin', 'mem-serve');
const MEM = path.join(HERE, '..', 'bin', 'mem');
const PW = 'a-proper-long-password';

const newRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cm-login-'));

/** Server in-process; the log is captured (for "never plain text in the log"). */
async function start(root, env = {}) {
  const mod = await import(pathToFileURL(SERVER).href);
  const log = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (z, ...r) => { log.push(String(z)); return real(z, ...r); };
  const s = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', ...env });
  return {
    base: `http://127.0.0.1:${s.server.address().port}`,
    log,
    stop: () => new Promise((r) => { process.stderr.write = real; s.server.close(r); }),
  };
}

/** fetch() does not let the Host header be set — raw http for host probes. */
function raw(base, route, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(route, base);
    const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }, (r) => {
      let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, text: t }));
    });
    q.on('error', reject); q.end(body);
  });
}

const code = (root) => fs.readFileSync(path.join(root, '.pipeline', 'serve-setup-code'), 'utf8').trim();
const form = (o) => new URLSearchParams(o);
const sessionOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function setUp(base, root, pw = PW) {
  const r = await fetch(base + '/login/setup', {
    method: 'POST', redirect: 'manual', headers: { origin: base },
    body: form({ code: code(root), password: pw, password2: pw }),
  });
  assert.equal(r.status, 303, 'setup with the code must succeed');
  return sessionOf(r);
}

function signIn(base, pw = PW, extra = {}) {
  return fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { origin: base, ...extra }, body: form({ password: pw }) });
}

// --- 1. No session, no content --------------------------------------------

test('without a session: page -> /login, data and writing routes -> 401 JSON (control: with a session / off, content)', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    for (const p of ['/', '/dashboard', '/pult']) {
      const r = await fetch(s.base + p, { redirect: 'manual' });
      assert.equal(r.status, 303, p);
      assert.equal(r.headers.get('location'), '/login');
    }
    for (const [route, init] of [
      ['/dashboard.json', {}],
      // tempo (2026-09-28): the deferred parts are data too — the same lock.
      ['/dashboard/part.json?part=raw', {}],
      ['/entries.json?q=x', {}],
      ['/console.json', {}],
      ['/manifest.webmanifest', {}],
      ['/dashboard/app.js', {}],
      ['/setting', { method: 'POST', body: form({ id: 'x', value: '1' }), headers: { origin: s.base } }],
      ['/task', { method: 'POST', body: form({ kind: 'x' }), headers: { origin: s.base } }],
      ['/inbox/reply', { method: 'POST', body: form({ to: 'x' }), headers: { origin: s.base } }],
      // N9 parity ("gold nebenbei"/"Rate today"): a gold verdict is a
      // writing route like /setting/ /task — the same lock (see
      // test/gold-verdict.test.mjs for the "nothing written" effect).
      ['/dashboard/gold-verdict', { method: 'POST', body: form({ verdict: 'empty-correct', expected: '[]' }), headers: { origin: s.base } }],
    ]) {
      const r = await fetch(s.base + route, { redirect: 'manual', ...init });
      assert.equal(r.status, 401, `${route} without a session`);
      assert.equal((await r.json()).reason, 'login-required', route);
    }
    const ck = await setUp(s.base, root);
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { cookie: ck } })).status, 200);
    const page = await fetch(s.base + '/', { headers: { cookie: ck } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-login="1"/);
  } finally { await s.stop(); }

  const s2 = await start(newRoot(), { CHEAP_MEM_SERVE_LOGIN: 'off' });
  try {
    assert.equal((await fetch(s2.base + '/dashboard.json')).status, 200);
    assert.equal((await fetch(s2.base + '/login')).status, 404, 'no login routes when off');
  } finally { await s2.stop(); }
});

test('mark, worker and fonts stay reachable without a session (no memory content)', async () => {
  const s = await start(newRoot());
  try {
    assert.equal((await fetch(s.base + '/favicon.ico')).status, 200);
    assert.equal((await fetch(s.base + '/sw.js')).status, 200);
    assert.equal((await fetch(s.base + '/fonts/dm-sans-latin.woff2')).status, 200);
  } finally { await s.stop(); }
});

// --- 2. Wrong password ----------------------------------------------------

test('wrong password: refused, delayed, locked after failures; the right one works', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    await setUp(s.base, root);
    const t0 = Date.now();
    const r = await signIn(s.base, 'wrong-wrong-wrong');
    const took = Date.now() - t0;
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.match(await r.text(), /The password is wrong/);
    assert.ok(took >= login.DELAY_MS - 50, `delay ${took} ms`);
    for (let i = 1; i < login.LOCK_FROM; i++) await signIn(s.base, 'wrong-wrong-wrong');
    const locked = await signIn(s.base, PW);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    assert.ok(s.log.some((z) => /failed attempt \(source=/.test(z)), 'failure logged');
    await wait(1100);
    const ok = await signIn(s.base, PW);
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('set-cookie') || '', /^mem_session=/);
  } finally { await s.stop(); }
});

test('limiter: exponential per source, capped globally', () => {
  let t = 0;
  const b = login.newLimiter({ now: () => t });
  for (let i = 0; i < login.LOCK_FROM - 1; i++) b.failure('a');
  assert.equal(b.wait('a'), 0);
  b.failure('a'); assert.equal(b.wait('a'), 1000);
  b.failure('a'); assert.equal(b.wait('a'), 2000);
  assert.equal(b.wait('b'), 0);
  for (let i = 0; i < login.GLOBAL_LOCK_FROM; i++) b.failure('q' + i);
  assert.ok(b.wait('new') > 0, 'global lock');
  t += 60 * 60 * 1000;
  assert.equal(b.wait('a'), 0, 'forgets after an hour');
});

// --- 3. First setup only with proof -----------------------------------------

test('first setup without proof refused — loopback too; with the code or the bearer allowed', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    assert.ok(s.log.some((z) => z.includes('The setup code is in') && z.includes('.pipeline')), 'log names the place');
    assert.ok(!s.log.some((z) => z.includes(code(root))), 'log NEVER names the code');
    const page = await (await fetch(s.base + '/login')).text();
    assert.match(page, /mem serve setup-code/);
    assert.ok(!page.includes(code(root)), 'the page does not show the code');
    for (const c of ['', 'AAAA-BBBB-CCCC']) {
      const r = await fetch(s.base + '/login/setup', {
        method: 'POST', redirect: 'manual', headers: { origin: s.base }, body: form({ code: c, password: PW, password2: PW }),
      });
      assert.equal(r.status, 403, `code '${c}'`);
      assert.equal(login.isSet(path.join(root, '.pipeline')), false);
    }
    const mismatch = await fetch(s.base + '/login/setup', {
      method: 'POST', redirect: 'manual', headers: { origin: s.base }, body: form({ code: code(root), password: PW, password2: PW + 'x' }),
    });
    assert.equal(mismatch.status, 400);
    assert.match(await setUp(s.base, root), /^mem_session=/);
    assert.equal(fs.existsSync(path.join(root, '.pipeline', 'serve-setup-code')), false, 'code used up');
    const again = await fetch(s.base + '/login/setup', {
      method: 'POST', redirect: 'manual', headers: { origin: s.base }, body: form({ code: 'x', password: 'another-password', password2: 'another-password' }),
    });
    assert.equal(again.status, 409);
  } finally { await s.stop(); }

  const s2 = await start(newRoot(), { CHEAP_MEM_SERVE_TOKEN: 'door-secret' });
  try {
    const r = await fetch(s2.base + '/login/setup', {
      method: 'POST', headers: { authorization: 'Bearer door-secret', 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ password: PW, password2: PW }),
    });
    assert.equal(r.status, 201);
  } finally { await s2.stop(); }
});

// --- 4. A hash, not plain text ----------------------------------------------

test('stored is a salted scrypt hash, mode 600, never plain text — not in the log either', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    await setUp(s.base, root);
    await signIn(s.base, 'wrong-wrong-wrong');
    const file = path.join(root, '.pipeline', 'serve-password.json');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(PW));
    const j = JSON.parse(text);
    assert.equal(j.method, 'scrypt');
    assert.ok(Buffer.from(j.salt, 'base64').length >= 16);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(root, '.pipeline', 'serve-sessions.json')).mode & 0o777, 0o600);
      assert.deepEqual(login.modeReport(path.join(root, '.pipeline')), { hash: 'private', sessions: 'private', code: 'missing' });
    } else {
      // No POSIX modes on Windows (stat says 0666): not asserted. The product has to say so instead.
      const rep = login.modeReport(path.join(root, '.pipeline'));
      assert.equal(rep.hash, 'not-checkable');
      assert.equal(rep.sessions, 'not-checkable');
      assert.match(login.modeNote(path.join(root, '.pipeline')), /not checkable on this platform/);
      process.stderr.write('NOTICE: serve-password.json mode (0600) not asserted on Windows; the product reports it as not checkable\n');
    }
    assert.ok(!s.log.join('').includes(PW) && !s.log.join('').includes('wrong-wrong-wrong'));
    assert.equal(login.matches(PW, j), true);
    assert.equal(login.matches(PW + '!', j), false);
    const tok = (await signIn(s.base)).headers.get('set-cookie').split(';')[0].split('=')[1];
    assert.ok(!fs.readFileSync(path.join(root, '.pipeline', 'serve-sessions.json'), 'utf8').includes(tok));
  } finally { await s.stop(); }
});

test('.pipeline/ is gitignored (the hash stays on this machine)', () => {
  const r = spawnSync('git', ['-C', path.join(HERE, '..'), 'check-ignore', '-q', '.pipeline/serve-password.json']);
  assert.equal(r.status, 0);
});

// --- 5. Changing the password -----------------------------------------------

test('a change needs the current password and two equal new ones; other sessions end', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    const a = await setUp(s.base, root);
    const b = sessionOf(await signIn(s.base));
    const change = (ck, body) => fetch(s.base + '/login/password', {
      method: 'POST', headers: { cookie: ck, origin: s.base, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
    });
    const NEW = 'a-brand-new-password-2026';
    let r = await change(a, { current: 'wrong-wrong-wrong', next: NEW, next2: NEW });
    assert.equal(r.status, 403); assert.match((await r.json()).reason, /current password is wrong/);
    r = await change(a, { current: PW, next: NEW, next2: NEW + 'x' });
    assert.equal(r.status, 400); assert.match((await r.json()).reason, /do not match/);
    r = await change(a, { current: PW, next: 'short', next2: 'short' });
    assert.equal(r.status, 400); assert.match((await r.json()).reason, /at least 10 characters/);
    r = await change('', { current: PW, next: NEW, next2: NEW });
    assert.equal(r.status, 401);
    r = await change(a, { current: PW, next: NEW, next2: NEW });
    assert.equal(r.status, 200);
    const a2 = sessionOf(r);
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { cookie: b } })).status, 401, 'other session ended');
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { cookie: a } })).status, 401, 'old own session ended');
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { cookie: a2 } })).status, 200, 'new own session valid');
    assert.equal((await signIn(s.base, PW)).status, 401);
    assert.equal((await signIn(s.base, NEW)).status, 303);
  } finally { await s.stop(); }
});

// --- 6. Signing out -----------------------------------------------------------

test('signing out ends the session on the server and clears cookie and cache', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    const ck = await setUp(s.base, root);
    const r = await fetch(s.base + '/login/logout', { method: 'POST', redirect: 'manual', headers: { cookie: ck, origin: s.base } });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('set-cookie'), /mem_session=;.*Max-Age=0/);
    assert.equal(r.headers.get('clear-site-data'), '"cache"');
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { cookie: ck } })).status, 401);
  } finally { await s.stop(); }
});

// --- 7. Cookie flags ------------------------------------------------------------

test('session cookie: HttpOnly, SameSite=Strict, Path=/, 30 days; Secure behind https', async () => {
  const root = newRoot();
  const s = await start(root, { CHEAP_MEM_SERVE_ORIGINS: 'https://mem.example.test' });
  try {
    await setUp(s.base, root);
    const local = (await signIn(s.base)).headers.get('set-cookie');
    for (const f of ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${30 * 24 * 3600}`]) assert.ok(local.includes(f), f);
    assert.ok(!/Secure/.test(local), 'no Secure over http://127.0.0.1');
    assert.match((await signIn(s.base, PW, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie'), /; Secure/);
    const tunnel = await raw(s.base, '/login', { method: 'POST', headers: { host: 'mem.example.test', origin: 'https://mem.example.test' }, body: form({ password: PW }).toString() });
    assert.equal(tunnel.status, 303);
    assert.match(String(tunnel.headers['set-cookie']), /; Secure/);
  } finally { await s.stop(); }
});

// --- 8. Latches on the login routes -----------------------------------------------

test('sign-in POST from a foreign origin or host refused', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    await setUp(s.base, root);
    const r = await fetch(s.base + '/login', { method: 'POST', redirect: 'manual', headers: { origin: 'https://evil.test' }, body: form({ password: PW }) });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('set-cookie'), null);
    const h = await raw(s.base, '/login', { method: 'POST', headers: { host: 'evil.test', origin: 'http://evil.test' }, body: form({ password: PW }).toString() });
    assert.equal(h.status, 403);
    assert.match(h.text, /foreign-host/);
    const good = await raw(s.base, '/login', { method: 'POST', headers: { origin: s.base }, body: form({ password: PW }).toString() });
    assert.equal(good.status, 303);
  } finally { await s.stop(); }
});

test('bearer CHEAP_MEM_SERVE_TOKEN stays valid for tools; the token cookie alone does NOT replace the password', async () => {
  const s = await start(newRoot(), { CHEAP_MEM_SERVE_TOKEN: 'door-secret' });
  try {
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { authorization: 'Bearer door-secret' } })).status, 200);
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { cookie: 'mem_k=door-secret' } })).status, 401);
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { authorization: 'Bearer wrong' } })).status, 404);
  } finally { await s.stop(); }
});

test('back from an identity provider (cross-site): reload same-site once instead of a sign-in loop', async () => {
  const s = await start(newRoot());
  try {
    const r = await fetch(s.base + '/', { redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.match(t, /http-equiv="refresh" content="0"/);
    assert.ok(!/dashboard\.json|data-writes/.test(t));
    const second = await fetch(s.base + '/', { redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(second.status, 303);
  } finally { await s.stop(); }
});

// --- 9. Service worker ------------------------------------------------------------

test('the offline worker stores no redirect and no sign-in page; without offline it stores nothing', () => {
  const on = pwa.serviceWorker({ offline: true });
  assert.doesNotThrow(() => new Function(on));
  assert.match(on, /!answer\.redirected/);
  assert.match(on, /startsWith\('\/login'\)/);
  const off = pwa.serviceWorker({ offline: false });
  assert.ok(!/addEventListener\('fetch'/.test(off));
});

// --- 10. The way out ----------------------------------------------------------------

test('mem serve reset-password: hash and sessions gone, the next visit asks for the setup', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    const ck = await setUp(s.base, root);
    const r = spawnSync(process.execPath, [MEM, 'serve', 'reset-password', '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Password reset/);
    assert.equal(fs.existsSync(path.join(root, '.pipeline', 'serve-password.json')), false);
    assert.equal((await fetch(s.base + '/dashboard.json', { headers: { cookie: ck } })).status, 401);
    assert.match(await (await fetch(s.base + '/login')).text(), /Set password/);
    const c = spawnSync(process.execPath, [MEM, 'serve', 'setup-code', '--root', root], { encoding: 'utf8' });
    assert.equal(c.status, 0);
    assert.match(c.stdout, /Setup code: [A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(root, '.pipeline', 'serve-setup-code')).mode & 0o777, 0o600);
    } else {
      // No POSIX modes on Windows (UNVERIFIED there): assert the honest statement instead.
      assert.match(c.stdout, /not checkable on this platform/, 'the CLI must say that the mode cannot be judged');
      const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'dashboard.md'), 'utf8');
      assert.match(doc, /serve-setup-code[^]{0,300}Windows[^]{0,200}(cannot be checked|not checkable)/, 'docs must say modes are not checkable on Windows');
      process.stderr.write('NOTICE: serve-setup-code mode (0600) not asserted on Windows; docs say it cannot be checked\n');
    }
  } finally { await s.stop(); }
});

// --- 11. The page -------------------------------------------------------------------

test('sign-in page: black, no script, nothing from outside, CSP header', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    const r = await fetch(s.base + '/login');
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-security-policy')?.includes("script-src 'self'"));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    // no-referrer would make the browser send `Origin: null` on the form POST (found by the browser run).
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    const t = await r.text();
    assert.ok(!/<script/i.test(t));
    assert.ok(!/https?:\/\//.test(t.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')));
    assert.match(t, /background:#000/);
    assert.match(t, /DM Sans/);
    await setUp(s.base, root);
    const signin = await (await fetch(s.base + '/login')).text();
    assert.match(signin, /type="password" name="password"/);
    assert.ok(!/name="code"/.test(signin));
  } finally { await s.stop(); }
});

test('the password files modes, win32 behaviour driven on every platform: no verdict, "not checkable on this platform"', async () => {
  const root = newRoot();
  const s = await start(root);
  try {
    await setUp(s.base, root);
    const dir = path.join(root, '.pipeline');
    assert.ok(fs.existsSync(path.join(dir, 'serve-password.json')), 'positive control: the hash file is there');
    const rep = login.modeReport(dir, { platform: 'win32' });
    assert.equal(rep.hash, 'not-checkable');
    assert.equal(rep.sessions, 'not-checkable');
    assert.equal(rep.code, 'missing', 'a file that is not there is missing, not "not checkable"');
    assert.match(login.modeNote(dir, { platform: 'win32' }), /not checkable on this platform/);
  } finally { await s.stop(); }
});
