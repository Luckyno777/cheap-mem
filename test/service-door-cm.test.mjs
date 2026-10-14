// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The doors of the two HTTP services (`bin/mem-mcp --http`, `bin/mem-serve`), counter-checked against the sibling's
// service security round (2026-10-10 .. 2026-10-12). Four items; cheap-mem was NOT red on any of them. These probes
// stay as guards, so that "not affected" is a measured state and not a claim:
//
//   A3  / F03  A request target or Host header that the URL parser rejects ends no service. (lm: `new URL(...)`
//              stood outside any `try` and killed the bridge. Here both services parse against a FIXED base inside
//              a `try`.) Probed on the wire, with raw sockets, against a spawned bridge and a started viewer.
//   A7  / F13  The Host check (DNS rebinding) covers EVERY route of the viewer, not only the data routes someone
//              remembered to list. Inventory over `PATHS`: with a foreign Host, only a closed list of routes that
//              carry no memory content (the shipped code, fonts and the PWA shell) answers 200; everything else is
//              refused, and no response, whatever its status, contains the marker text of an entry.
//   A13 / F04  The only place that decides "is this address this machine" for a network target is an ALLOW list
//              (`src/embed/loopback.mjs`); the SIIT form `::ffff:0:a.b.c.d` and its relatives are refused, the real
//              loopback spellings pass. cheap-mem has no feed fetcher at all (see test/network-allowlist.test.mjs:
//              nothing in `src/`/`bin/` resolves a foreign name or opens an outbound HTTP connection).
//   A5  / F05  The bridge keeps no "already shown" memory per process: several clients of one stateless bridge get the
//              same answers (lm: the card set of `mem_aufgabe` was remembered per process and root, so a second chat
//              got nothing). cheap-mem has no such tool; its recall dedupe lives in files keyed by the client's session
//              (src/recallhook.mjs `claimTurn`), not in the bridge process.
//   A8  / F14  The body limit of the bridge is cheap-mem's OWN (1 MiB, counted in bytes, answered 413), not the
//              SDK's default: it holds whichever SDK version is installed. Probed on the wire.
//
// Windows: raw sockets, `os.tmpdir()`, no POSIX tools; no error code is asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as loopback from '../src/embed/loopback.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(ROOT, 'bin', 'mem-serve');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');
const MARK = 'SECRETMARK-4711';

function memoryRoot(t) {
  const root = tempDir('cm-door-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    name: 'doortest', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  memory.logEntry(root, 'learning', { title: `${MARK} title`, text: `${MARK} body` });
  return root;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => (e ? reject(e) : resolve(port))); });
});

/** One raw request, byte for byte; resolves to the status line (or '' when the server closed without one). */
function wire(port, bytes, { end = true } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    const finish = () => { s.destroy(); resolve(out.split('\r\n')[0]); };
    s.setEncoding('latin1');
    s.on('data', (d) => { out += d; if (out.includes('\r\n')) finish(); });
    s.on('error', () => resolve(out.split('\r\n')[0]));
    s.on('close', () => resolve(out.split('\r\n')[0]));
    s.setTimeout(3000, finish);
    s.write(bytes, 'latin1');
    if (!end) setTimeout(() => s.destroy(), 150);
  });
}

// A request line / header block that the URL parser (or the HTTP parser) may reject. Each is sent to a live service;
// the service must answer (any status) or close the one connection, and must still answer /health afterwards.
const HOSTILE = [
  ['target //[', 'GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'],
  ['target http://[/x', 'GET http://[/x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'],
  ['target %', 'GET /%zz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'],
  ['Host [', 'GET /health HTTP/1.1\r\nHost: [\r\n\r\n'],
  ['Host [ on /mcp', 'POST /mcp HTTP/1.1\r\nHost: [\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}'],
  ['Host ]]:x', 'GET /dashboard.json HTTP/1.1\r\nHost: ]]:x\r\n\r\n'],
  ['Host bytes', 'GET /health HTTP/1.1\r\nHost: \xff\xfe\r\n\r\n'],
  ['Origin [', 'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://[\r\nContent-Length: 2\r\n\r\n{}'],
  ['Origin null bytes', 'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: \x00\r\nContent-Length: 2\r\n\r\n{}'],
  ['body ends early', 'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"a":'],
];

test('A3/F03 mem-mcp --http: no request target and no header ends the bridge (and the healthy path still answers)', async (t) => {
  const root = memoryRoot(t);
  const port = await freePort();
  let err = '';
  const child = spawn(process.execPath, [MCP, '--http'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(port) },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const until = Date.now() + 15000;
  let up = '';
  while (Date.now() < until && child.exitCode === null) {
    up = await wire(port, 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    if (/ 200 /.test(up)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(up, / 200 /, `positive control: the bridge answers /health ${err}`);
  for (const [name, bytes] of HOSTILE) {
    await wire(port, bytes, { end: !/ends early/.test(name) });
    assert.equal(child.exitCode, null, `"${name}" ended the bridge: ${err}`);
    assert.match(await wire(port, 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'), / 200 /, `"${name}": the bridge no longer answers`);
  }
});

async function startViewer(root, env = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?door=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '', ...env,
  });
  return { mod, port: server.address().port, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

test('A3/F03 mem-serve: no request target and no header ends the viewer', async (t) => {
  const root = memoryRoot(t);
  const s = await startViewer(root);
  t.after(s.stop);
  const ok = await wire(s.port, 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  assert.match(ok, / 200 /, 'positive control: the viewer answers /health');
  // An exception that escaped a request handler would be an uncaught exception of THIS process: the test runner
  // would fail the file. Asserting the later /health answer makes the survival explicit.
  for (const [name, bytes] of HOSTILE) {
    await wire(s.port, bytes, { end: !/ends early/.test(name) });
    assert.match(await wire(s.port, 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'), / 200 /, `"${name}" broke the viewer`);
  }
});

// --- A7/F13: the Host check over the whole route inventory ------------------------------------------------

/** Routes that may answer 200 to a foreign Host, and why: they are code, not memory. A new entry here is a decision. */
const PUBLIC_BY_DESIGN = new Map([
  ['/dashboard/app.css', 'shipped stylesheet'],
  ['/dashboard/app.js', 'shipped script'],
  ['/dashboard/three.js', 'shipped script (graph)'],
  ['/dashboard/sw-register.js', 'service worker registration snippet'],
  ['/fonts/dm-sans-latin.woff2', 'font'],
  ['/fonts/dm-sans-latin-ext.woff2', 'font'],
  ['/manifest.webmanifest', 'PWA manifest: the title from the configuration only'],
  ['/sw.js', 'service worker script: code'],
  ['/favicon.ico', 'the mark'],
  ['/login', 'the sign-in page itself carries no memory content'],
]);

function rawRequest(port, method, route, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path: route, method, headers: { host, ...headers } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: r.headers }));
    });
    q.on('error', reject);
    q.end(method === 'POST' ? 'question=x' : undefined);
  });
}

const QUERY = `?id=x&name=x.md&question=${MARK}&q=${MARK}&known=2026-09-28&valid=2026-09-28&project=global&preview=1`;

for (const mode of [
  { name: 'login off, no token', env: {}, headers: {} },
  { name: 'login off, token (bearer)', env: { CHEAP_MEM_SERVE_TOKEN: 'inventory-token-0123456789' }, headers: { authorization: 'Bearer inventory-token-0123456789' } },
  { name: 'login ON, token (bearer)', env: { CHEAP_MEM_SERVE_LOGIN: 'on', CHEAP_MEM_SERVE_TOKEN: 'inventory-token-0123456789' }, headers: { authorization: 'Bearer inventory-token-0123456789' } },
]) {
  test(`A7/F13 inventory (${mode.name}): with a foreign Host no route of PATHS gives out memory; only the closed asset list answers 200`, async (t) => {
    const root = memoryRoot(t);
    const s = await startViewer(root, mode.env);
    t.after(s.stop);

    // What must never reach a foreign Host on ANY route, public-by-design or not: entry text, the workspace name
    // (the configuration's `name`), the content of the sign-in setup code (login ON writes one under `.pipeline/`).
    const NAME = 'doortest';
    let setupCode = null;
    if (mode.env.CHEAP_MEM_SERVE_LOGIN === 'on') {
      try { setupCode = fs.readFileSync(path.join(root, '.pipeline', 'serve-setup-code'), 'utf8').trim(); } catch { setupCode = null; }
      assert.ok(setupCode && setupCode.length >= 6, 'positive control: the setup code exists on disk, so "never shown" can be tested');
    }
    // Positive control: with a loopback Host the same probe DOES see the marker and the name (otherwise "no leak" means nothing).
    const seen = []; let sawName = false;
    for (const p of [...s.mod.PATHS]) {
      const r = await rawRequest(s.port, 'GET', p + QUERY, `127.0.0.1:${s.port}`, mode.headers);
      if (r.body.includes(MARK)) seen.push(p);
      if (r.body.includes(NAME)) sawName = true;
    }
    assert.ok(seen.length >= 1, 'positive control: some route must show the marker to a loopback Host, or the probe sees nothing');
    assert.ok(sawName, 'positive control: some route shows the workspace name to a loopback Host');

    const routes = [...s.mod.PATHS];
    assert.ok(routes.length >= 30, `the inventory is suspiciously small (${routes.length})`);
    const answered = [];
    for (const method of ['GET', 'POST']) {
      for (const p of routes) {
        for (const host of ['evil.example', `evil.example:${s.port}`]) {
          const r = await rawRequest(s.port, method, p + QUERY, host, mode.headers);
          assert.ok(!r.body.includes(MARK), `${method} ${p} (Host ${host}) gave out entry text`);
          assert.ok(!r.body.includes(NAME), `${method} ${p} (Host ${host}) gave out the workspace name`);
          if (setupCode) assert.ok(!r.body.includes(setupCode) && !JSON.stringify(r.headers).includes(setupCode), `${method} ${p} (Host ${host}) gave out the setup code`);
          if (r.status === 200) assert.equal(r.headers['set-cookie'], undefined, `${method} ${p} (Host ${host}) set a cookie for a foreign Host`);
          assert.equal(r.headers['access-control-allow-origin'], undefined, `${method} ${p} sent a CORS header`);
          if (r.status === 200) answered.push(p);
        }
      }
    }
    for (const p of new Set(answered)) {
      assert.ok(PUBLIC_BY_DESIGN.has(p), `${p} answers 200 to a foreign Host and is not on the closed list of public-by-design routes`);
    }
    // And the list is not a fiction: every listed route exists in the inventory.
    for (const p of PUBLIC_BY_DESIGN.keys()) {
      if (p === '/login' && mode.env.CHEAP_MEM_SERVE_LOGIN !== 'on') continue; // 404 with the login off
      assert.ok(routes.includes(p), `${p} is listed as public but is no route of PATHS`);
    }
  });
}

// --- A13/F04 and A14: the address allow list ----------------------------------------------------------------

test('A13/F04: the one place that decides "this machine" for a network target is an allow list; SIIT and relatives are refused', () => {
  const refused = [
    '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '0:0:0:0:ffff:0:7f00:1', // SIIT (RFC 2765) forms of 127.0.0.1
    '::ffff:0:0:1', '::ffff:0:a9fe:a9fe', // SIIT of the metadata address
    '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', // compatible, NAT64, 6to4 of 127.0.0.1
    '::ffff:a9fe:a9fe', '::ffff:169.254.169.254', '::ffff:0a00:1', '::ffff:c0a8:101', // mapped, not loopback
    '::', '0.0.0.0', '10.0.0.1', '169.254.169.254', '192.168.0.1', '100.64.0.1', '8.8.8.8', 'fe80::1', 'fd00::1',
    '::1%eth0', '[::1]', 'localhost', 'example.org', '', '127.0.0.1 ', '2130706433', '0x7f.1',
  ];
  for (const a of refused) assert.equal(loopback.isLoopbackAddress(a), false, `${JSON.stringify(a)} must not count as loopback`);
  const accepted = ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:7f12:3456', '::FFFF:7F00:1',
    '0:0:0:0:0:ffff:7f00:1'];
  for (const a of accepted) assert.equal(loopback.isLoopbackAddress(a), true, `positive control: ${a} is loopback`);
});

test('A13/F04: checkEndpoint refuses SIIT/NAT64 literals in URL form and never resolves a name other than localhost', async () => {
  let looked = 0;
  const lookup = async () => { looked += 1; return [{ address: '127.0.0.1' }]; };
  for (const u of ['http://[::ffff:0:7f00:1]:11434', 'http://[64:ff9b::7f00:1]:11434', 'http://[2002:7f00:1::1]:11434',
    'http://[::ffff:a9fe:a9fe]:11434', 'http://evil.example:11434', 'http://localhost.evil.example:11434', 'http://127.0.0.1.evil.example']) {
    const r = await loopback.checkEndpoint(u, { lookup });
    assert.equal(r.ok, false, `${u} must be refused`);
  }
  assert.equal(looked, 0, 'a name other than localhost is refused WITHOUT being resolved (DNS rebinding: resolve and connect cannot disagree)');
  for (const u of ['http://127.0.0.1:11434', 'http://[::1]:11434', 'http://[::ffff:127.0.0.1]:11434', 'http://[::ffff:7f00:1]:11434', 'http://localhost:11434']) {
    const r = await loopback.checkEndpoint(u, { lookup });
    assert.equal(r.ok, true, `positive control: ${u}`);
  }
});

test('A13/F04: URL spellings of an address are judged by what the URL parser makes of them - and connected to as that address', async () => {
  const lookup = async () => [{ address: '127.0.0.1' }];
  // Spellings of 127.0.0.1 and of localhost: accepted, and the caller gets the NORMAL literal to connect to.
  for (const u of ['http://127.1:11434', 'http://0x7f.1:11434', 'http://2130706433:11434', 'http://017700000001:11434', 'http://LOCALHOST:11434']) {
    const r = await loopback.checkEndpoint(u, { lookup });
    assert.equal(r.ok, true, `${u} is loopback under another spelling`);
    assert.equal(r.address, '127.0.0.1', `${u}: the connection goes to the normalised literal, not to the spelling`);
    assert.equal(r.port, 11434);
  }
  // The same trick for addresses that are not this machine: refused, whatever the spelling.
  for (const u of ['http://0xa9.0xfe.0xa9.0xfe', 'http://2852039166', 'http://0x0a.1', 'http://10.1', 'http://0', 'http://localhost.:11434', 'http://LOCALHOST.evil.example:11434']) {
    const r = await loopback.checkEndpoint(u, { lookup });
    assert.equal(r.ok, false, `${u} must be refused`);
  }
});

// --- A14: the proxy-header families and the start-up notice -------------------------------------------------

test('A14: every proxy/CDN header (names and families) takes the local standing away in strict mode; unrelated headers do not', async () => {
  const webauth = await import('../src/webauth.mjs');
  const fake = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
  const names = ['forwarded', 'via', 'true-client-ip', 'cdn-loop', 'fastly-client-ip', 'x-client-ip', 'x-cluster-client-ip',
    'x-original-forwarded-for', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server',
    'x-forwarded-prefix', 'x-real-ip', 'x-real-port', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-worker',
    'cf-access-jwt-assertion', 'CF-Connecting-IP', 'X-Forwarded-For', 'Via'];
  assert.equal(webauth.remoteIsLoopback(fake({}), { strict: true }), true, 'positive control: plain loopback is local');
  assert.equal(webauth.remoteIsLoopback(fake({ accept: '*/*', 'user-agent': 'curl', origin: 'http://x', host: '127.0.0.1', 'x-request-id': '1', 'content-type': 'application/json', 'if-none-match': 'x', 'x-realm': 'y' }), { strict: true }), true,
    'unrelated headers (also near-misses like x-realm and x-request-id) do not count');
  for (const h of names) {
    assert.equal(webauth.remoteIsLoopback(fake({ [h]: 'x' }), { strict: true }), false, `${h} must take the local standing away`);
    assert.equal(webauth.hasProxyHeader(fake({ [h]: '' })), true, `${h} (empty value) is still a proxy header`);
    assert.equal(webauth.remoteIsLoopback(fake({ [h]: 'x' })), true, `${h}: not strict (login stands behind the door) changes nothing`);
  }
});

test('A14: the notice text - none behind a token or a login, always without; stronger with a configured public name', async () => {
  const { openDoorNotice } = await import('../src/webauth.mjs');
  assert.equal(openDoorNotice({ token: 'a-token-value' }), null);
  assert.equal(openDoorNotice({ login: true }), null);
  const plain = openDoorNotice({});
  assert.match(plain, /no token: anything that reaches this port through a local reverse proxy counts as local - set a token before putting a proxy in front/);
  assert.doesNotMatch(plain, /host name is configured/);
  assert.equal(openDoorNotice({ hosts: ['localhost', '127.0.0.1:8849', '[::1]'] }), plain, 'loopback names are no public name');
  assert.match(openDoorNotice({ hosts: ['memory.example.org'] }), /host name is configured/);
  assert.match(openDoorNotice({ origins: ['https://memory.example.org'] }), /host name is configured/);
  assert.equal(openDoorNotice({ token: 'a-token-value', hosts: ['memory.example.org'] }), null, 'a token silences it whatever is configured');
});

/** Start a service from its own entry point, collect stderr, stop it by its handle. */
async function startService(t, script, args, env, readyRe) {
  const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MEM_RECALL_SERVER: '0', ...env } });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
  });
  const until = Date.now() + 20000;
  while (Date.now() < until && child.exitCode === null && !readyRe.test(err)) await new Promise((r) => setTimeout(r, 40));
  await new Promise((r) => setTimeout(r, 300)); // the notice follows the ready line by a write
  return () => err;
}

test('A14: the bridge says so on stderr without a token, and not with one', async (t) => {
  const root = memoryRoot(t);
  const without = await startService(t, MCP, ['--http'], { CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(await freePort()), CHEAP_MEM_MCP_HOSTS: 'memory.example.org' }, /cheap-mem MCP \(http\)/);
  assert.match(without(), /NOTICE: no token: anything that reaches this port through a local reverse proxy counts as local/);
  assert.match(without(), /host name is configured/);
  const token = ['bridge', 'probe', 'credential', 'x'.repeat(24)].join('-');
  const withTok = await startService(t, MCP, ['--http'], { CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(await freePort()), CHEAP_MEM_MCP_TOKEN: token }, /cheap-mem MCP \(http\)/);
  assert.match(withTok(), /token=set/, 'positive control: the service did start with its token');
  assert.doesNotMatch(withTok(), /NOTICE/);
});

test('A14: the viewer says so on stderr with the login off and no token, and not with a token or with the login on', async (t) => {
  const root = memoryRoot(t);
  const base = { CHEAP_MEM_ROOT: root, CHEAP_MEM_SERVE_HOST: '127.0.0.1' };
  const off = await startService(t, SERVE, [], { ...base, CHEAP_MEM_SERVE_PORT: String(await freePort()), CHEAP_MEM_SERVE_LOGIN: 'off' }, /cheap-mem console on/);
  assert.match(off(), /NOTICE: no token: anything that reaches this port through a local reverse proxy counts as local/);
  const token = ['viewer', 'probe', 'credential', 'x'.repeat(24)].join('-');
  const tok = await startService(t, SERVE, [], { ...base, CHEAP_MEM_SERVE_PORT: String(await freePort()), CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: token }, /cheap-mem console on/);
  assert.match(tok(), /token set/, 'positive control: the viewer did start with its token');
  assert.doesNotMatch(tok(), /NOTICE/);
  const on = await startService(t, SERVE, [], { ...base, CHEAP_MEM_SERVE_PORT: String(await freePort()), CHEAP_MEM_SERVE_LOGIN: 'on' }, /cheap-mem console on/);
  assert.match(on(), /cheap-mem console on/, 'positive control: the viewer did start with its login');
  assert.doesNotMatch(on(), /NOTICE/);
});

test('A14: the socket-address half of the strict loopback test is an allow list of three literals', async () => {
  const webauth = await import('../src/webauth.mjs');
  const fake = (address) => ({ socket: { remoteAddress: address }, headers: {} });
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(webauth.remoteIsLoopback(fake(a), { strict: true }), true, a);
  for (const a of ['127.0.0.2', '127.1.2.3', '::ffff:7f00:1', '0:0:0:0:0:0:0:1', '::ffff:0:7f00:1', '0.0.0.0', '::', 'localhost', '', undefined, null, '10.0.0.5', '::ffff:10.0.0.5', '::ffff:127.0.0.1%lo']) {
    assert.equal(webauth.remoteIsLoopback(fake(a), { strict: true }), false, `${JSON.stringify(a)} is not on the list`);
  }
});

// --- A8/F14: the body limit is ours --------------------------------------------------------------------------

test('A8/F14: the bridge answers 413 above 1 MiB and passes exactly 1 MiB on to the transport - whichever SDK version is installed', async (t) => {
  const root = memoryRoot(t);
  const port = await freePort();
  let err = '';
  const child = spawn(process.execPath, [MCP, '--http'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(port) },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const until = Date.now() + 15000;
  while (Date.now() < until && child.exitCode === null) {
    if (/ 200 /.test(await wire(port, 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const post = (body, headers = {}) => new Promise((resolve) => {
    const q = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { host: '127.0.0.1', accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    q.on('error', (e) => resolve(`error ${e.code}`));
    q.end(body);
  });
  const MIB = 1024 * 1024;
  const frame = (fill) => `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"p":"${fill}"}}`;
  const pad = (bytes) => frame('a'.repeat(bytes - Buffer.byteLength(frame(''))));
  // Exactly the limit: not refused by size (the transport may refuse the message for its own reasons; never 413).
  const atLimit = pad(MIB);
  assert.equal(Buffer.byteLength(atLimit), MIB);
  assert.notEqual(await post(atLimit), 413, `positive control: a body of exactly 1 MiB is read ${err}`);
  // Above the limit the server answers 413 and may close the connection while the client still writes: on a
  // loopback socket that surfaces as a reset (the error CODE differs per platform and is not asserted). "Refused"
  // is therefore a 413 OR a reset; the one body that is a single byte over must show the real 413.
  const refused = (r) => r === 413 || (typeof r === 'string' && r.startsWith('error '));
  const over = pad(MIB + 1);
  assert.equal(Buffer.byteLength(over), MIB + 1);
  const overStatus = await post(over);
  assert.ok(refused(overStatus), `one byte over the limit: ${overStatus}`);
  const triple = await post(pad(MIB * 3));
  assert.ok(refused(triple), `three times the limit: ${triple}`);
  // Multi-byte characters count as bytes, not as characters.
  const wide = frame('ä'.repeat(MIB / 2));
  assert.ok(wide.length < MIB && Buffer.byteLength(wide) > MIB, 'fewer characters than the limit, more bytes');
  const wideStatus = await post(wide);
  assert.ok(refused(wideStatus), `counted in bytes: ${wideStatus}`);
  assert.ok([overStatus, triple, wideStatus].includes(413), `at least one of the refusals is the real 413 answer: ${[overStatus, triple, wideStatus]}`);
  assert.equal(child.exitCode, null, `the bridge survived the big bodies ${err}`);
  // The limit is cheap-mem's own code: the parsed body is handed to the transport, so the SDK's default is never
  // what bounds the input (it would, if `handleRequest` were called without the body).
  const src = fs.readFileSync(MCP, 'utf8');
  assert.match(src, /transport\.handleRequest\(req, res, body\)/, 'the bridge must hand its own, already bounded, body to the transport');
  assert.match(src, /size > 1024 \* 1024/, 'the bounded reader must still be there');
});

// --- A5/F05: no per-process "already shown" state in the stateless bridge ----------------------------------------

test('A5/F05: several clients of one stateless bridge get the same answers to the same question, every time', async (t) => {
  const root = memoryRoot(t);
  memory.logEntry(root, 'learning', { title: 'zebrafinch swirl needs a lock', text: 'the zebrafinch swirl in the mirror hall needs a lock file before the second start' });
  const port = await freePort();
  let err = '';
  const child = spawn(process.execPath, [MCP, '--http'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(port) },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { err += c; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const until = Date.now() + 15000;
  while (Date.now() < until && child.exitCode === null) {
    if (/ 200 /.test(await wire(port, 'GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  let id = 0;
  const call = (client, name, args) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const q = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      // A different "client" each time: its own connection (agent: false) and its own identity headers.
      agent: false,
      headers: { host: '127.0.0.1', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'user-agent': client, 'mcp-session-id': `${client}-session` },
    }, (r) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { text += c; });
      r.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error(`not JSON (${r.statusCode}): ${text.slice(0, 200)} ${err}`)); } });
    });
    q.on('error', reject);
    q.end(body);
  });
  const textOf = (r) => JSON.stringify(r.result?.structuredContent ?? r.result?.content ?? r.error);
  for (const [tool, args] of [
    ['mem_retrieve', { query: 'zebrafinch swirl mirror hall lock' }],
    ['mem_find', { query: 'zebrafinch swirl mirror hall lock' }],
  ]) {
    const answers = [];
    for (const client of ['chat-one', 'chat-two', 'chat-three', 'chat-one']) answers.push(textOf(await call(client, tool, args)));
    assert.match(answers[0], /zebrafinch/, `positive control: ${tool} finds the entry at all (${answers[0].slice(0, 200)})`);
    for (let i = 1; i < answers.length; i += 1) {
      // Compare without the timing fields that legitimately differ between calls.
      const norm = (a) => a.replace(/"(?:duration|elapsed|took)[A-Za-z_]*":\s*[\d.]+/g, '');
      assert.equal(norm(answers[i]), norm(answers[0]), `${tool}: client #${i + 1} got another answer than the first one`);
    }
  }
});

test('A5/F05: bin/mem-mcp holds no module-level collection that could remember what one client was shown', () => {
  const src = fs.readFileSync(MCP, 'utf8');
  const holder = /^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/m;
  // Positive control: the pattern does see the shape that lm's GEZEIGT_AUFGABE had.
  assert.match('const SHOWN_TASK = new Map();\n', holder);
  assert.doesNotMatch(src, holder, 'a process-wide Map/Set in the bridge: it would be shared by every client of the stateless bridge');
});
