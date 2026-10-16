// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/http-limits.test.mjs - hard limits of the listening HTTP services (parity A9 (a), the sibling's http-grenzen).
//
// The fault: the dashboard server (`mem serve`) and the MCP bridge over HTTP (`mem-mcp --http`) ran with the Node
// defaults. Header lines could trickle for 60 s (in practice 90 s, Node checks only every 30 s), a body for 300 s, and the
// number of open connections was unlimited. Now `hardenServer` (src/http-limits.mjs) sets head 10 s, request 30 s,
// connections per service.
//
// **Four groups.**
//   1. The helper on a CHILD server (test/fixture/limits-server.mjs) with SMALL times: slow headers, silent connections (no byte at
//      all), a dripping body, a connection flood (cap 8), the header-line count - and the other side: a long answer (SSE-like) does NOT break and a
//      normal request goes through. One mutation per probe (a line of the helper removed -> red) or a control that the probe
//      sees an abort at all.
//   2. The wiring: every `http.createServer(` under bin/ and src/ has its `hardenServer(` (a count, with sabotage), the cap
//      of each service is the one named in MAX_CONNECTIONS, and the real dashboard server carries the values.
//   3. The REAL services as processes with the real values: slow headers, silent connections, dripping body - and a mutation (call removed ->
//      the slow connection stays open). No flood against the real services: 512 sockets on a loaded machine prove nothing
//      the cap-8 probe of group 1 plus the wiring check do not.
//   4. The recall server (Unix socket / pipe): a hung client does not block the next one. No limit was added there (see
//      docs/security-model.md); this is the probe for the claim.
//
// **Waiting on states, not on spans.** Every probe waits for "the connection is closed", "the answer is complete",
// "the service answers". The ceilings below are hard edges against hanging, not measuring windows: the expected time is
// a multiple below. The mutations hold the other direction: a service without the limit does not close at all.
//
// Windows: children are started with `process.execPath` and ended by their handle, directories come from `os.tmpdir()`
// (tempDir), no POSIX tool, and no error code is asserted (a refused connect is "an error", whatever its code).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { LIMITS, MAX_CONNECTIONS, hardenServer } from '../src/http-limits.mjs';
import * as place from '../src/recallserver-place.mjs';
import * as recallserver from '../src/recallserver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HELPER = path.join(ROOT, 'src', 'http-limits.mjs');
const CHILD = path.join(HERE, 'fixture', 'limits-server.mjs');

// --- small tools -----------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a STATE (the condition becomes true). The edge is a hard ceiling, not a measuring window. Returns whether it happened. */
async function waitUntil(cond, edgeMs, stepMs = 50) {
  const until = Date.now() + edgeMs;
  while (Date.now() < until) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return Boolean(await cond());
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => (e ? reject(e) : resolve(port))); });
});

/**
 * A raw connection. `prelude` is written at once, `drip()` after that every `intervalMs` a piece.
 * `.closed` is the state "closed by the server (or us)", `.first` the beginning of the answer.
 */
function open(port, { prelude = '', drip = null, intervalMs = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const o = { sock: s, closed: false, first: '', all: '', beat: null };
    s.on('data', (d) => {
      if (o.first.length < 120) o.first += d.toString('latin1');
      if (o.all.length < 100_000) o.all += d.toString('latin1');
    });
    s.on('close', () => { o.closed = true; clearInterval(o.beat); });
    let connected = false;
    s.on('error', (e) => { if (!connected) reject(e); });
    s.on('connect', () => {
      connected = true;
      if (prelude) s.write(prelude);
      if (drip) o.beat = setInterval(() => { if (!s.destroyed && s.writable) s.write(drip()); }, intervalMs);
      resolve(o);
    });
  });
}

/** A normal request on a NEW connection. Result { status, text } or { error }. */
function fetchOnce(port, route, { method = 'GET', body = null, edgeMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: route, method, agent: false, timeout: edgeMs,
      headers: body == null ? {} : { 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', (e) => resolve({ error: e.code || e.message }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ error: 'edge' }); });
    r.on('error', (e) => resolve({ error: e.code || e.message }));
    r.end(body ?? undefined);
  });
}

function closeAll(conns) { for (const o of conns) { clearInterval(o.beat); o.sock.destroy(); } }

/** Starts the child; returns { port, stop }. Ended by its handle only. */
async function startChild(t, modulePath, opt = {}) {
  const p = spawn(process.execPath, [CHILD, JSON.stringify({ module: modulePath, opt })], { stdio: ['ignore', 'pipe', 'inherit'] });
  const stop = () => { try { p.kill(); } catch { /* already gone */ } };
  t?.after?.(stop);
  const port = await new Promise((resolve, reject) => {
    let s = '';
    p.stdout.on('data', (d) => { s += d; const m = /PORT (\d+)/.exec(s); if (m) resolve(Number(m[1])); });
    p.on('exit', () => reject(new Error('child server without a port')));
  });
  return { port, stop };
}

// --- group 1: the probes as functions (against the real helper AND against mutations) ------------------------------------

/** Small times for the child: the head may take 5 s, the request 10 s; checked every 100 ms. */
const SMALL = { headersTimeoutMs: 5000, requestTimeoutMs: 10_000, checkIntervalMs: 100 };

/** Slow headers: five connections trickle header lines. Green when the server closes them AND a normal request goes through meanwhile. */
async function probeSlowHeaders(modulePath, edgeMs, { opt = { ...SMALL, requestTimeoutMs: 600_000 }, mustBeOpen = true } = {}) {
  // requestTimeout large: only the head limit covers the probe (the request limit would close the connection as well).
  const k = await startChild(null, modulePath, opt);
  try {
    const conns = [];
    for (let i = 0; i < 5; i += 1) {
      conns.push(await open(k.port, { prelude: 'GET /health HTTP/1.1\r\nHost: x\r\n', drip: () => 'X-Slow: 1\r\n' }));
    }
    const meanwhile = await fetchOnce(k.port, '/health');
    const stillOpen = conns.filter((o) => !o.closed).length;
    const closed = await waitUntil(() => conns.every((o) => o.closed), edgeMs);
    const first = conns.map((o) => o.first.split('\r\n')[0]);
    closeAll(conns);
    return { ok: closed && meanwhile.status === 200 && (stillOpen > 0 || !mustBeOpen), closed, meanwhile, stillOpen, first };
  } finally { k.stop(); }
}

/** Dripping body: head complete, Content-Length 100000, one byte every 250 ms. Green when the server closes; a small POST goes through. */
async function probeDrippingBody(modulePath, edgeMs) {
  const k = await startChild(null, modulePath, SMALL);
  try {
    const o = await open(k.port, { prelude: 'POST /body HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n', drip: () => 'a' });
    const normal = await fetchOnce(k.port, '/body', { method: 'POST', body: 'small' });
    const closed = await waitUntil(() => o.closed, edgeMs);
    closeAll([o]);
    return { ok: closed && normal.status === 200 && normal.text === 'read', closed, normal };
  } finally { k.stop(); }
}

/** Flood: 20 silent connections at maxConnections 8. Green when the server closes the 12 surplus ones and answers normally once the flood is gone. */
async function probeFlood(modulePath, edgeMs) {
  // Times large: only the connection count may act.
  const k = await startChild(null, modulePath, { headersTimeoutMs: 60_000, requestTimeoutMs: 120_000, maxConnections: 8 });
  try {
    const conns = [];
    for (let i = 0; i < 20; i += 1) conns.push(await open(k.port));
    const capped = await waitUntil(() => conns.filter((o) => o.closed).length >= 12, edgeMs);
    closeAll(conns);
    const after = await waitUntil(async () => (await fetchOnce(k.port, '/health', { edgeMs: 3000 })).status === 200, 20_000, 200);
    return { ok: capped && after, capped, after };
  } finally { k.stop(); }
}

/**
 * Silent connections: a client connects and sends NOTHING. Green when the head limit closes them (Node answers 408) and a
 * normal request goes through meanwhile. (A probe must READ from its sockets: a client socket nobody reads from does not
 * show the close, which looks like "the server never closes it".)
 */
async function probeSilent(modulePath, edgeMs) {
  const k = await startChild(null, modulePath, { ...SMALL, requestTimeoutMs: 600_000 });
  try {
    const conns = [];
    for (let i = 0; i < 5; i += 1) conns.push(await open(k.port));
    const meanwhile = await fetchOnce(k.port, '/health');
    const closed = await waitUntil(() => conns.every((o) => o.closed), edgeMs);
    closeAll(conns);
    return { ok: closed && meanwhile.status === 200, closed, meanwhile };
  } finally { k.stop(); }
}

/**
 * The flood that frees itself: 20 silent connections at maxConnections 8 and NO cleanup by the probe. Green when the service
 * answers a normal client again on its own (the head limit frees the seats after 2 s). Without the head limit the seats stay taken.
 */
async function probeSilentFlood(modulePath, edgeMs) {
  const k = await startChild(null, modulePath, { headersTimeoutMs: 2000, requestTimeoutMs: 120_000, checkIntervalMs: 100, maxConnections: 8 });
  const conns = [];
  try {
    for (let i = 0; i < 20; i += 1) conns.push(await open(k.port));
    const capped = await waitUntil(() => conns.filter((o) => o.closed).length >= 12, edgeMs);
    const recovered = await waitUntil(async () => (await fetchOnce(k.port, '/health', { edgeMs: 3000 })).status === 200, edgeMs, 200);
    return { ok: capped && recovered, capped, recovered };
  } finally { closeAll(conns); k.stop(); }
}

/** Header lines: 300 lines in ONE request; the server reads at most maxHeadersCount. */
async function probeHeaderLines(modulePath) {
  const k = await startChild(null, modulePath, {});
  try {
    const many = Array.from({ length: 300 }, (_, i) => `X-H${i}: 1`).join('\r\n');
    const o = await open(k.port, { prelude: `GET /heads HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${many}\r\n\r\n` });
    await waitUntil(() => o.closed, 20_000);
    const read = Number(/\r\n\r\n(\d+)/.exec(o.all)?.[1]);
    closeAll([o]);
    return { ok: read > 0 && read <= LIMITS.maxHeadersCount, read, answer: o.all.slice(0, 200) };
  } finally { k.stop(); }
}

/** The other side: an answer that takes LONGER than the request limit (10 s) arrives whole. `abort` > 0: the server cuts it itself (the probe's control). */
async function probeLongAnswer(modulePath, { chunks = 24, abort = 0 } = {}) {
  const k = await startChild(null, modulePath, SMALL);
  try {
    const o = await open(k.port, { prelude: `GET /long?chunks=${chunks}&abort=${abort} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n` });
    const closed = await waitUntil(() => o.closed, 90_000);
    const events = (o.all.match(/data: \d+/g) || []).length;
    const end = o.all.includes('data: end');
    closeAll([o]);
    return { ok: closed && end && events === chunks, closed, end, events };
  } finally { k.stop(); }
}

// --- mutations of the helper ---------------------------------------------------------------------------------------------

/** Writes a copy of the helper with exactly ONE replaced line; the replacement has to bite (else the mutation is none). */
function mutatedHelper(t, from, to) {
  const text = fs.readFileSync(HELPER, 'utf8');
  assert.ok(text.includes(from), `mutation does not bite: "${from}" is not in the helper`);
  const dir = tempDir('http-limits-mut-', t);
  const target = path.join(dir, 'http-limits.mjs');
  fs.writeFileSync(target, text.replace(from, to));
  return target;
}

const EDGE_GREEN = 30_000;    // hard edge, green expected after ~3-5 s
const EDGE_MUTATION = 15_000; // red means "not closed within the edge"

test('group 1: the helper hardens; the mutations and controls keep the probes honest', { timeout: 300_000, concurrency: true }, async (t) => {
  await Promise.all([
    t.test('slow headers: the server closes, a normal request goes through meanwhile', async () => {
      const v = await probeSlowHeaders(HELPER, EDGE_GREEN);
      assert.ok(v.ok, JSON.stringify(v));
      assert.ok(v.first.every((z) => /408/.test(z)), `the server says 408: ${JSON.stringify(v.first)}`);
    }),
    t.test('mutation: headersTimeout removed -> slow headers are NOT closed (red)', async (tt) => {
      const m = mutatedHelper(tt, 'server.headersTimeout = g.headersTimeoutMs;', 'server.headersTimeout = 0;');
      const v = await probeSlowHeaders(m, EDGE_MUTATION);
      assert.equal(v.closed, false, `without the head limit nothing closes: ${JSON.stringify(v)}`);
      assert.equal(v.meanwhile.status, 200, 'control: the request itself goes through without the limit (5 connections lame nothing)');
    }),
    t.test('check interval: with the helper default (2 s) a head limit of 2 s acts after seconds, not after the Node default of 30 s', async () => {
      const opt = { headersTimeoutMs: 2000, requestTimeoutMs: 600_000 }; // checkIntervalMs stays at the helper default
      const v = await probeSlowHeaders(HELPER, 20_000, { opt, mustBeOpen: false });
      assert.ok(v.ok, JSON.stringify(v));
    }),
    t.test('mutation: check interval removed (Node default 30 s) -> the 2 s head limit acts only after ~30 s (red)', async (tt) => {
      const m = mutatedHelper(tt, 'server.connectionsCheckingInterval = g.checkIntervalMs;', 'void g.checkIntervalMs;');
      const opt = { headersTimeoutMs: 2000, requestTimeoutMs: 600_000 };
      const v = await probeSlowHeaders(m, 15_000, { opt, mustBeOpen: false });
      assert.equal(v.closed, false, JSON.stringify(v));
    }),
    t.test('silent connections (no byte at all) are closed by the head limit, a normal request goes through', async () => {
      const v = await probeSilent(HELPER, EDGE_GREEN);
      assert.ok(v.ok, JSON.stringify(v));
    }),
    t.test('mutation: headersTimeout removed -> silent connections stay open (red)', async (tt) => {
      const m = mutatedHelper(tt, 'server.headersTimeout = g.headersTimeoutMs;', 'server.headersTimeout = 0;');
      const v = await probeSilent(m, EDGE_MUTATION);
      assert.equal(v.closed, false, JSON.stringify(v));
      assert.equal(v.meanwhile.status, 200, 'control: the request itself goes through (5 silent connections lame nothing)');
    }),
    t.test('silent flood: the seats are freed by the head limit, the service answers again without help', async () => {
      const v = await probeSilentFlood(HELPER, EDGE_GREEN);
      assert.ok(v.ok, JSON.stringify(v));
    }),
    t.test('mutation: headersTimeout removed -> the silent flood keeps the seats (red)', async (tt) => {
      const m = mutatedHelper(tt, 'server.headersTimeout = g.headersTimeoutMs;', 'server.headersTimeout = 0;');
      const v = await probeSilentFlood(m, EDGE_MUTATION);
      assert.equal(v.recovered, false, JSON.stringify(v));
      assert.equal(v.capped, true, 'control: the cap itself acted (the surplus was dropped)');
    }),
    t.test('dripping body: the server closes, a small POST goes through', async () => {
      const v = await probeDrippingBody(HELPER, EDGE_GREEN);
      assert.ok(v.ok, JSON.stringify(v));
    }),
    t.test('mutation: requestTimeout removed -> the dripping body is NOT closed (red)', async (tt) => {
      const m = mutatedHelper(tt, 'server.requestTimeout = g.requestTimeoutMs;', 'server.requestTimeout = 0;');
      const v = await probeDrippingBody(m, EDGE_MUTATION);
      assert.equal(v.closed, false, JSON.stringify(v));
    }),
    t.test('flood: the surplus connections are closed, afterwards the server answers a normal client', async () => {
      const v = await probeFlood(HELPER, EDGE_GREEN);
      assert.ok(v.ok, JSON.stringify(v));
    }),
    t.test('mutation: maxConnections removed -> the flood is NOT capped (red)', async (tt) => {
      const m = mutatedHelper(tt, 'server.maxConnections = g.maxConnections;', 'void g.maxConnections;');
      const v = await probeFlood(m, EDGE_MUTATION);
      assert.equal(v.capped, false, JSON.stringify(v));
    }),
    t.test('header lines: 300 lines -> the server reads at most maxHeadersCount', async () => {
      const v = await probeHeaderLines(HELPER);
      assert.ok(v.ok, JSON.stringify(v));
    }),
    t.test('mutation: maxHeadersCount removed -> the server reads all 300 (red)', async (tt) => {
      const m = mutatedHelper(tt, 'server.maxHeadersCount = g.maxHeadersCount;', 'void g.maxHeadersCount;');
      const v = await probeHeaderLines(m);
      assert.ok(v.read > LIMITS.maxHeadersCount, JSON.stringify(v));
    }),
    t.test('long answer (SSE-like, 12 s, longer than the request limit of 10 s): arrives whole', async () => {
      const v = await probeLongAnswer(HELPER);
      assert.ok(v.ok, JSON.stringify(v));
    }),
    t.test('control of the "long answer" probe: when the server cuts it itself, the probe says red', async () => {
      const v = await probeLongAnswer(HELPER, { abort: 2000 });
      assert.equal(v.ok, false, JSON.stringify(v));
      assert.equal(v.end, false);
    }),
  ]);
});

test('group 1: the values of the helper are the promised ones', () => {
  assert.equal(LIMITS.headersTimeoutMs, 10_000);
  assert.equal(LIMITS.requestTimeoutMs, 30_000);
  assert.equal(LIMITS.keepAliveTimeoutMs, 5_000);
  assert.equal(LIMITS.maxHeadersCount, 100);
  assert.equal(LIMITS.checkIntervalMs, 2_000);
  // No wall clock, only the order of the constants (Node needs request >= head; the idle limit has to stay below the head limit).
  const { keepAliveTimeoutMs: idle, headersTimeoutMs: head, requestTimeoutMs: request } = LIMITS;
  assert.ok(idle < head, 'the idle limit has to stay below the head limit');
  assert.ok(head <= request, 'Node needs requestTimeout >= headersTimeout');
  assert.deepEqual({ ...MAX_CONNECTIONS }, { dashboard: 512, mcp: 256 });
  // Never 0 (Node drops EVERY connection), and clearly below the 1024 descriptors a service unit usually has.
  for (const [name, n] of Object.entries(MAX_CONNECTIONS)) assert.ok(Number.isInteger(n) && n > 0 && n < 1024, `${name}: a positive cap below 1024`);
});

test('group 1: hardenServer never sets maxConnections to 0 (Node would drop every connection); a bad value leaves the cap unset', async () => {
  const build = () => http.createServer((q, r) => { r.end('ok'); });
  const listen = (server) => new Promise((res) => { server.listen(0, '127.0.0.1', () => res(server.address().port)); });
  for (const bad of [0, -1, 1.5, NaN, '8', null, undefined]) {
    const s = hardenServer(build(), { maxConnections: bad });
    assert.equal(s.maxConnections, undefined, `${String(bad)} leaves the cap unset`);
  }
  assert.equal(hardenServer(build(), { maxConnections: 8 }).maxConnections, 8);
  // The helper with 0 still serves; the control below shows what a raw 0 does.
  const a = hardenServer(build(), { maxConnections: 0 });
  const portA = await listen(a);
  try {
    assert.equal((await fetchOnce(portA, '/')).status, 200, 'the helper with 0 serves normally');
  } finally { a.close(); }
  const b = build();
  b.maxConnections = 0;
  const portB = await listen(b);
  try {
    const r = await fetchOnce(portB, '/');
    assert.ok(r.error, `control: a raw maxConnections = 0 drops every connection: ${JSON.stringify(r)}`);
  } finally { b.close(); }
});

// --- group 2: the wiring ---------------------------------------------------------------------------------------------------

function withoutComments(text) {
  return text
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, ' ')
    .split('\n')
    .map((z) => z.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}
const RAW_START = /(?<![\w.])http\.createServer\(/g;
const RAW_START_ONCE = /(?<![\w.])http\.createServer\(/;
const HARDEN = /(?<![\w.])hardenServer\(/g;

/** A file's violation: more `http.createServer(` than `hardenServer(` - else null. */
export function checkWiring(text) {
  const code = withoutComments(text);
  const starts = (code.match(RAW_START) || []).length;
  const hardens = (code.match(HARDEN) || []).length;
  return starts > hardens ? { starts, hardens } : null;
}

function serviceFiles() {
  const out = [];
  for (const dir of ['bin', 'src']) {
    for (const n of fs.readdirSync(path.join(ROOT, dir))) {
      const p = path.join(ROOT, dir, n);
      if (!fs.statSync(p).isFile()) continue;
      if (/\.(mjs|js|cjs)$/.test(n) || /^mem-/.test(n)) out.push(p);
    }
  }
  return out;
}

test('group 2: every http.createServer under bin/ and src/ has its hardenServer', () => {
  const violations = [];
  const withStart = [];
  for (const p of serviceFiles()) {
    const text = fs.readFileSync(p, 'utf8');
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (RAW_START_ONCE.test(withoutComments(text))) withStart.push(rel);
    const v = checkWiring(text);
    if (v) violations.push(`${rel}: ${v.starts} start(s), ${v.hardens} hardenServer( call(s)`);
  }
  assert.deepEqual(violations, [], 'a new HTTP service: hardenServer(server, { maxConnections }) from src/http-limits.mjs right after createServer');
  // Positive control: the count sees the two known services, so it is not empty.
  assert.deepEqual(withStart.sort(), ['bin/mem-mcp', 'bin/mem-serve']);
});

test('group 2: sabotage - a removed hardenServer call turns the count red', () => {
  for (const n of ['mem-mcp', 'mem-serve']) {
    const text = fs.readFileSync(path.join(ROOT, 'bin', n), 'utf8');
    assert.equal(checkWiring(text), null, `${n} is clean as shipped`);
    const without = text.replace(/hardenServer\(/g, 'withoutHardening(');
    assert.notEqual(without, text);
    assert.ok(checkWiring(without), `${n}: without hardenServer( it has to turn red`);
  }
  // A comment is no call.
  assert.ok(checkWiring("import http from 'node:http';\n// hardenServer(s);\nconst s = http.createServer(() => {});\n"));
  assert.equal(checkWiring("const s = http.createServer(() => {});\nhardenServer(s);\n"), null);
});

test('group 2: each service passes the cap that is named for it, and never 0', () => {
  const serve = withoutComments(fs.readFileSync(path.join(ROOT, 'bin', 'mem-serve'), 'utf8'));
  const mcp = withoutComments(fs.readFileSync(path.join(ROOT, 'bin', 'mem-mcp'), 'utf8'));
  assert.match(serve, /hardenServer\(server, \{ maxConnections: MAX_CONNECTIONS\.dashboard \}\)/);
  assert.match(mcp, /hardenServer\(network, \{ maxConnections: MAX_CONNECTIONS\.mcp \}\)/);
  // The call stands BEFORE `listen` (Node reads the check interval there).
  assert.ok(serve.indexOf('hardenServer(server') < serve.indexOf('server.listen('), 'dashboard: hardened before listen');
  assert.ok(mcp.indexOf('hardenServer(network') < mcp.indexOf('network.listen('), 'MCP bridge: hardened before listen');
  for (const text of [serve, mcp]) assert.doesNotMatch(text, /maxConnections\s*[:=]\s*0\b/);
});

test('group 2: the real dashboard server carries the values (read from the server object)', async (t) => {
  const root = tempDir('cm-limits-root-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'limits', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  const mod = await import(`${pathToFileURL(path.join(ROOT, 'bin', 'mem-serve')).href}?limits=${Math.random()}`);
  const port = await freePort();
  const env = { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_SERVE_PORT: String(port), CHEAP_MEM_SERVE_HOST: '', CHEAP_MEM_SERVE_TOKEN: '', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0' };
  const { server } = await mod.serve(root, env, { localNoToken: true });
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  assert.equal(server.headersTimeout, LIMITS.headersTimeoutMs);
  assert.equal(server.requestTimeout, LIMITS.requestTimeoutMs);
  assert.equal(server.keepAliveTimeout, LIMITS.keepAliveTimeoutMs);
  assert.equal(server.maxHeadersCount, LIMITS.maxHeadersCount);
  assert.equal(server.connectionsCheckingInterval, LIMITS.checkIntervalMs);
  assert.equal(server.maxConnections, MAX_CONNECTIONS.dashboard);
});

// --- group 3: the REAL services as processes, with the real values ------------------------------------------------------

const EDGE_REAL_HEAD = 45_000;     // expected: head 10 s + check 2 s = ~12 s
const EDGE_REAL_BODY = 90_000;     // expected: request 30 s + check 2 s = ~32 s
const EDGE_REAL_MUTATION = 20_000; // red = "still open after 20 s" (a service without the limit closes only after 60 s or more)
const SLOW_CONNECTIONS = 8;        // small on purpose: the probe must not lame the machine

const SERVICES = {
  dashboard: { script: 'mem-serve', health: '/health', post: '/dashboard/probe.json', length: 5000 },
  mcp: { script: 'mem-mcp', health: '/health', post: '/mcp', length: 100_000 },
};

/**
 * A tree for the mutation: directories of the root are linked (a junction, which Windows allows without a privilege), files are
 * COPIED (a file symlink needs one there); bin/ is copied file by file - the `files` are put in as a changed copy.
 */
function mutatedTree(t, files) {
  const dir = tempDir('http-limits-tree-', t);
  for (const n of fs.readdirSync(ROOT)) {
    if (n === 'bin' || n === '.git' || n === 'node_modules') continue;
    const source = path.join(ROOT, n);
    if (fs.statSync(source).isDirectory()) fs.symlinkSync(source, path.join(dir, n), 'junction');
    else fs.copyFileSync(source, path.join(dir, n));
  }
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(dir, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const n of fs.readdirSync(path.join(ROOT, 'bin'))) {
    const source = path.join(ROOT, 'bin', n);
    if (!fs.statSync(source).isFile()) continue;
    if (n in files) fs.writeFileSync(path.join(dir, 'bin', n), files[n](fs.readFileSync(source, 'utf8')), { mode: 0o755 });
    else fs.copyFileSync(source, path.join(dir, 'bin', n));
  }
  return dir;
}

/** Removes the `hardenServer(...)` call (a line of its own) from a service's source - as a function for mutatedTree. */
function withoutHardening(text) {
  const next = text.replace(/^[ \t]*hardenServer\([^\n]*\);[ \t]*$/gm, '');
  assert.notEqual(next, text, 'mutation does not bite: no hardenServer call found');
  assert.ok(!/(?<![\w.])hardenServer\(/.test(withoutComments(next)), 'a call is still there');
  return next;
}

/** Starts the real service `kind` from the tree `tree`; waits for the state "answers on /health". */
async function startReal(t, kind, tree) {
  const port = await freePort();
  const root = tempDir(`http-limits-${kind}-`, t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'limits', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  const env = { ...process.env, CHEAP_MEM_ROOT: root, MEM_RECALL_SERVER: '0', CHEAP_MEM_SERVE_TOKEN: '', CHEAP_MEM_MCP_TOKEN: '',
    CHEAP_MEM_SERVE_HOST: '', CHEAP_MEM_MCP_HOST: '', CHEAP_MEM_SERVE_HOSTS: '', CHEAP_MEM_MCP_HOSTS: '' };
  let args;
  if (kind === 'dashboard') {
    args = [path.join(tree, 'bin', 'mem-serve'), '--local-no-token'];
    Object.assign(env, { CHEAP_MEM_SERVE_PORT: String(port), CHEAP_MEM_SERVE_LOGIN: 'off' });
  } else {
    args = [path.join(tree, 'bin', 'mem-mcp'), '--http'];
    Object.assign(env, { CHEAP_MEM_MCP_PORT: String(port), CHEAP_MEM_MCP_LOCAL_NO_TOKEN: '1', CHEAP_MEM_AGENT: 'limitsprobe' });
  }
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  let ended = false;
  p.on('exit', () => { ended = true; });
  const stop = () => { try { p.kill(); } catch { /* already gone */ } };
  t?.after?.(stop);
  const up = await waitUntil(async () => !ended && (await fetchOnce(port, SERVICES[kind].health, { edgeMs: 3000 })).status === 200, 90_000, 200);
  assert.ok(up, `${kind} does not come up: ${err.split('\n')[0]}`);
  return { port, stop };
}

/** Real: slow connections (one header line a second); a normal request goes through, and the service closes them. */
async function realSlowHeaders(kind, tree, edgeMs) {
  const d = SERVICES[kind];
  const s = await startReal(null, kind, tree);
  try {
    const conns = [];
    for (let i = 0; i < SLOW_CONNECTIONS; i += 1) {
      conns.push(await open(s.port, { prelude: `GET ${d.health} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n`, drip: () => 'X-Slow: 1\r\n', intervalMs: 1000 }));
    }
    const meanwhile = await fetchOnce(s.port, d.health);
    const stillOpen = conns.filter((o) => !o.closed).length;
    const closed = await waitUntil(() => conns.every((o) => o.closed), edgeMs, 250);
    const first = conns[0].first.split('\r\n')[0];
    closeAll(conns);
    return { kind, ok: closed && meanwhile.status === 200 && stillOpen > 0, closed, meanwhile, stillOpen, first };
  } finally { s.stop(); }
}

/** Real: silent connections (no byte at all); the head limit closes them, a normal request goes through. */
async function realSilent(kind, tree, edgeMs) {
  const d = SERVICES[kind];
  const s = await startReal(null, kind, tree);
  try {
    const conns = [];
    for (let i = 0; i < SLOW_CONNECTIONS; i += 1) conns.push(await open(s.port));
    const meanwhile = await fetchOnce(s.port, d.health);
    const closed = await waitUntil(() => conns.every((o) => o.closed), edgeMs, 250);
    closeAll(conns);
    return { kind, ok: closed && meanwhile.status === 200, closed, meanwhile };
  } finally { s.stop(); }
}

/** Real: head complete, large Content-Length, one byte a second. */
async function realDrippingBody(kind, tree, edgeMs) {
  const d = SERVICES[kind];
  const s = await startReal(null, kind, tree);
  try {
    const type = kind === 'dashboard' ? 'application/x-www-form-urlencoded' : 'application/json';
    const o = await open(s.port, {
      prelude: `POST ${d.post} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nOrigin: http://127.0.0.1:${s.port}\r\nContent-Type: ${type}\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${d.length}\r\n\r\n`,
      drip: () => 'a', intervalMs: 1000 });
    const normal = await fetchOnce(s.port, d.health);
    const closed = await waitUntil(() => o.closed, edgeMs, 250);
    const first = o.first.split('\r\n')[0];
    closeAll([o]);
    return { kind, ok: closed && normal.status === 200, closed, normal, first };
  } finally { s.stop(); }
}

test('group 3: the real services close slow headers and a dripping body (real values)', { timeout: 400_000, concurrency: true }, async (t) => {
  const kinds = Object.keys(SERVICES);
  await Promise.all([
    ...kinds.map((kind) => t.test(`${kind}: slow headers are closed, a normal request goes through`, async () => {
      const v = await realSlowHeaders(kind, ROOT, EDGE_REAL_HEAD);
      assert.ok(v.ok, JSON.stringify(v));
      assert.match(v.first, /408/);
    })),
    ...kinds.map((kind) => t.test(`${kind}: silent connections (no byte at all) are closed, a normal request goes through`, async () => {
      const v = await realSilent(kind, ROOT, EDGE_REAL_HEAD);
      assert.ok(v.ok, JSON.stringify(v));
    })),
    ...kinds.map((kind) => t.test(`${kind}: a dripping body is closed, a normal request goes through`, async () => {
      const v = await realDrippingBody(kind, ROOT, EDGE_REAL_BODY);
      assert.ok(v.ok, JSON.stringify(v));
    })),
    ...kinds.map((kind) => t.test(`mutation ${kind}: hardenServer removed -> the slow connection stays open (red)`, async (tt) => {
      const file = SERVICES[kind].script;
      const tree = mutatedTree(tt, { [file]: withoutHardening });
      const v = await realSlowHeaders(kind, tree, EDGE_REAL_MUTATION);
      assert.equal(v.closed, false, `without the limit the service does not close within the edge: ${JSON.stringify(v)}`);
      assert.equal(v.meanwhile.status, 200, 'control: the mutated service ran and answered');
    })),
  ]);
});

// --- group 4: the recall server (Unix socket / named pipe) -----------------------------------------------------------------

test('group 4: a hung client on the recall socket does not block the next one (no limit was added there; this is the probe for the claim)', async (t) => {
  const root = tempDir('cm-limits-recall-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'limits', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  const s = await recallserver.start(root, { env: {}, log: () => {} });
  t.after(() => s.close());
  assert.equal(s.running, true);
  const w = place.place(root, {});
  const key = fs.readFileSync(w.key, 'utf8');
  // The hung clients: connect, send half a line, never finish. Each one holds a socket until the server's own 30 s idle limit.
  const hung = [];
  for (let i = 0; i < 4; i += 1) {
    const c = net.connect(w.socket);
    await new Promise((resolve, reject) => { c.once('connect', resolve); c.once('error', reject); });
    c.on('error', () => {});
    c.write('{"v":');
    hung.push(c);
  }
  t.after(() => { for (const c of hung) c.destroy(); });
  const ask = () => new Promise((resolve) => {
    const c = net.connect(w.socket);
    let a = '';
    c.setEncoding('utf8');
    c.setTimeout(8000, () => { c.destroy(); resolve({ error: 'timeout' }); });
    c.on('connect', () => c.write(`${JSON.stringify({ v: place.VERSION, key, root, query: 'nothing here', top: 1 })}\n`));
    c.on('data', (x) => { a += x; });
    c.on('error', (e) => resolve({ error: e.code || 'error' }));
    c.on('end', () => { try { resolve(JSON.parse(a)); } catch { resolve({ error: 'unparsable' }); } });
  });
  const answer = await ask();
  assert.equal(answer.ok, true, `a healthy client is answered while others hang: ${JSON.stringify(answer)}`);
  assert.ok(hung.every((c) => !c.destroyed), 'control: the hung clients really were still connected');
});
