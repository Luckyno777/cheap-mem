// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/dashboard-page.test.mjs — the dashboard's shell, its routes and
// the house rules it has to keep (English mirror of the sibling's
// test/dashboard.test.mjs, plus the parity invariants of 2026-09-28).
//
// What is pinned here:
//  - the page carries THIS house's mark (the C) and never the sibling's L,
//    and no served file names the sibling;
//  - the page reaches nothing outside: every script and stylesheet is a
//    route of this server, and every fetch() in the script goes to a
//    closed list of this server's own routes;
//  - four states, never three: "unknown" has its own tone in the badge
//    and its own CSS rule, never the warning's;
//  - not measurable is not zero: an unreadable journal leaves `recall`
//    null on every entry; an absent one does too; only a read journal
//    yields a measured 0;
//  - every data route checks the Host header (DNS rebinding) and no
//    route ever answers with a CORS header;
//  - the empty store looks intentional: one calm core and a hint;
//  - raw capture deletion through the task, with a reason, behind the
//    write gate — really deleting, really refusing.
//
// invariant: vier-zustaende-eigener-ton
// invariant: nicht-messbar-ist-nicht-null
// invariant: kein-cors-kopf
// invariant: host-riegel-lesewege
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as page from '../src/dashboard-page.mjs';
import * as data from '../src/dashboard-data.mjs';
import * as memory from '../src/memory.mjs';
import * as inbox from '../src/inbox.mjs';
import * as icon from '../src/icon.mjs';
import * as measurements from '../src/measurements.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const JS = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.css'), 'utf8');

function memoryRoot({ writes = false } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dash-page-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'pagetest', participants: { alex: { human: true }, bot: {} }, language: 'en',
    ...(writes ? { dashboard: { allowWrites: true } } : {}),
  }));
  return r;
}
async function start(root, env = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?page=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '', ...env });
  const port = server.address().port;
  return {
    mod, port, base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}
/** A raw request with a chosen Host header (fetch() would not let us set one). */
function rawGet(port, p, host, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// --- the shell --------------------------------------------------------------

test('the page carries the C mark from icon.mjs, never the sibling\'s L', () => {
  const html = page.asHtml({ workspace: { name: 'x', human: 'alex' } });
  assert.ok(html.includes(icon.cPath()), 'the C path is not in the sidebar');
  assert.ok(html.includes(icon.markLink(64)), 'the tab icon is not this house\'s mark');
  assert.doesNotMatch(html, /M300 230 V1010 H1010/, 'the sibling\'s L is on this page');
});

test('no served file names the sibling house', () => {
  const html = page.asHtml({ workspace: { name: 'x' } });
  for (const [name, text] of [['page', html], ['dashboard.js', JS], ['dashboard.css', CSS]]) {
    assert.doesNotMatch(text, /lucky-mem|luckymem|Lucky Mem/i, `${name} names the sibling`);
  }
});

test('the page reaches nothing outside: scripts and styles are this server\'s own routes', () => {
  const html = page.asHtml({});
  const targets = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:') && !u.startsWith('#'));
  assert.ok(targets.length >= 3);
  for (const t of targets) assert.match(t, /^\/[a-z]/, `outside or relative target: ${t}`);
  assert.doesNotMatch(html + JS + CSS, /https?:\/\//, 'an absolute URL in the page, the script or the stylesheet');
});

test('every fetch() in the script goes to a closed list of this server\'s routes', () => {
  const allowed = new Set(['/dashboard.json', '/dashboard/entry.json', '/dashboard/message.json', '/dashboard/probe.json',
    '/dashboard/facts-at.json', '/entries.json', '/task', '/task/cancel', '/task.json', '/setting', '/inbox/reply', '/inbox/state',
    '/dashboard/verify-verdict',
    // login (2026-09-28): change the password and sign out (Settings >
    // Access) — Host + Origin checks in src/login.mjs; writes only the
    // password hash / sessions under .pipeline/, never memory.
    '/login/password', '/login/logout']);
  const calls = [...JS.matchAll(/fetch\(\s*([`'])([^`'?$]*)/g)].map((m) => m[2]);
  // formPost(path, …) is the one wrapper for form writes.
  const posts = [...JS.matchAll(/formPost\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 8, `only ${calls.length} fetch calls found — the probe reads nothing`);
  for (const c of [...calls, ...posts]) {
    if (c === '') continue; // the one generic wrapper body: fetch(pathName, …)
    assert.ok(allowed.has(c), `fetch to a route outside the closed list: ${c}`);
  }
  assert.equal([...JS.matchAll(/fetch\(pathName/g)].length, 1, 'more than one generic fetch');
});

// --- four states ------------------------------------------------------------

function badgeFn() {
  const src = JS.slice(JS.indexOf('function badge('), JS.indexOf('// The old desk\'s four board states'));
  const esc = (v) => String(v ?? '');
  return vm.runInNewContext(`(${src.trim()})`, { esc });
}

test('four states, never three: unknown has its own tone, never the warning\'s', () => {
  const badge = badgeFn();
  const tone = (s) => /class="badge ([a-z]*)"/.exec(badge(s))[1];
  assert.equal(tone('good'), 'good');
  assert.equal(tone('warning'), 'warn');
  assert.equal(tone('error'), 'bad');
  for (const s of ['unknown', 'not measured', 'not measurable', 'not available']) assert.equal(tone(s), 'unknown', s);
  assert.match(CSS, /\.badge\.unknown\{/, 'no own CSS rule for unknown');
  assert.notEqual(tone('unknown'), tone('warning'));
});

test('positive control: the badge probe really distinguishes (a changed map would fail it)', () => {
  const src = JS.slice(JS.indexOf('function badge('), JS.indexOf('// The old desk\'s four board states'));
  const collapsed = src.replace("['unknown', 'not seen'", "['__none__'").replace("'off', 'known_partial'", "'off', 'unknown', 'known_partial'");
  const badge = vm.runInNewContext(`(${collapsed.trim()})`, { esc: String });
  assert.equal(/class="badge ([a-z]*)"/.exec(badge('unknown'))[1], 'warn');
});

// --- not measurable is not zero ---------------------------------------------

test('unknown is not 0: recall is null when the journal cannot be read or is absent, 0 only when read', () => {
  const r = memoryRoot();
  try {
    memory.logEntry(r, 'learning', { title: 'probe', text: 'x' });
    const broken = data.collectDashboard(r, { readJournal: () => { throw new Error('EIO'); } });
    assert.equal(broken.recall.measurable, false);
    assert.ok(broken.entries.every((e) => e.recall === null), 'an unreadable journal turned into a number');
    assert.equal(broken.state, 'warning', 'an unreadable journal must be named');
    const absent = data.collectDashboard(r);
    assert.ok(absent.entries.every((e) => e.recall === null));
    assert.equal(absent.state, 'ok', 'an absent journal (fresh install) is not a warning');
    const read = data.collectDashboard(r, { readJournal: () => ({ present: true, lines: [], broken: 0 }) });
    assert.ok(read.entries.every((e) => e.recall && e.recall.sessions === 0), 'a read journal must give a measured 0');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('unknown is not 0: a weekly metric that cannot be measured is null with a reason', () => {
  const r = memoryRoot();
  try {
    const s = measurements.snapshot(r, { doctorResult: { summary: { warn: 1, error: 0 } } });
    assert.equal(s.metrics.injectionsShown.value, null);
    assert.ok(s.metrics.injectionsShown.reason);
    assert.equal(s.metrics.entries.value, 0, 'an empty store IS a measured 0');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the weekly series: one line per ISO week, capped at 52', () => {
  const r = memoryRoot();
  try {
    const doctorResult = { summary: { warn: 0, error: 0 } };
    const start = new Date('2025-01-06T12:00:00Z');
    for (let i = 0; i < 60; i += 1) {
      const now = new Date(start.getTime() + i * 7 * 86400000);
      assert.equal(measurements.recordIfDue(r, { now, doctorResult }).recorded, true);
      assert.equal(measurements.recordIfDue(r, { now, doctorResult }).recorded, false, 'a week recorded twice');
    }
    const got = measurements.read(r);
    assert.equal(got.weeks.length, 52);
    assert.equal(got.weeks.at(-1).week, measurements.isoWeek(new Date(start.getTime() + 59 * 7 * 86400000)));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --- the empty store ------------------------------------------------------------

test('a fresh install: no entry, state ok, and an intentional empty network', () => {
  const r = memoryRoot();
  try {
    const d = data.collectDashboard(r);
    assert.equal(d.entries.length, 0);
    assert.equal(d.state, 'ok');
    for (const k of ['books', 'digesterYield', 'liveInjection']) assert.ok(d.notAvailable[k].reason.includes('Not available in cheap-mem'));
    assert.match(JS, /Your first entries will appear here/);
    assert.match(CSS, /\.graph-empty\{/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --- the server ---------------------------------------------------------------

test('every dashboard route answers; the page has a CSP; no route sends a CORS header', async () => {
  const r = memoryRoot();
  const s = await start(r);
  try {
    const routes = [...Object.values(page.PATHS), ...page.FONTS.map((f) => f.path), '/manifest.webmanifest', '/sw.js', '/favicon.ico'];
    for (const p of routes) {
      const q = p === page.PATHS.entry ? `${p}?id=nope` : p === page.PATHS.message ? `${p}?name=nope.md` : p === page.PATHS.factsAt ? `${p}?known=2026-09-28&valid=2026-09-28` : p === page.PATHS.probe ? `${p}?question=x` : p;
      const res = await rawGet(s.port, q, `127.0.0.1:${s.port}`, { origin: 'https://evil.example' });
      assert.ok([200, 404].includes(res.status), `${q} answered ${res.status}`);
      assert.equal(res.headers['access-control-allow-origin'], undefined, `${q} sent a CORS header`);
      assert.equal(res.headers['access-control-allow-credentials'], undefined, `${q} sent a CORS header`);
    }
    const html = await rawGet(s.port, '/dashboard', `127.0.0.1:${s.port}`);
    assert.match(String(html.headers['content-security-policy']), /script-src 'self'/);
    assert.match(String(html.body), /rel="manifest"/, 'the PWA shell is missing');
    const json = await rawGet(s.port, '/dashboard.json', `127.0.0.1:${s.port}`, { 'accept-encoding': 'gzip' });
    assert.equal(json.headers['content-encoding'], 'gzip');
    assert.ok(Array.isArray(JSON.parse(zlib.gunzipSync(json.body)).entries));
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('the Host check: every data route refuses a foreign Host (DNS rebinding), loopback and listed hosts pass', async () => {
  const r = memoryRoot();
  const s = await start(r, { CHEAP_MEM_SERVE_HOSTS: 'mem.example.org' });
  try {
    for (const p of s.mod.HOST_GUARDED) {
      const q = `${p}?id=x&name=x.md&question=x&known=2026-09-28&valid=2026-09-28`;
      assert.equal((await rawGet(s.port, q, 'evil.example')).status, 403, `${p} served a foreign host`);
      assert.equal((await rawGet(s.port, q, `evil.example:${s.port}`)).status, 403, `${p} served a foreign host with port`);
      assert.notEqual((await rawGet(s.port, q, `localhost:${s.port}`)).status, 403, `${p} refused loopback`);
      assert.notEqual((await rawGet(s.port, q, 'mem.example.org')).status, 403, `${p} refused a listed host`);
    }
    assert.ok(s.mod.HOST_GUARDED.includes('/dashboard.json') && s.mod.HOST_GUARDED.includes('/dashboard/probe.json'));
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('with a token, every dashboard route is invisible without it (a bare 404)', async () => {
  const r = memoryRoot();
  const s = await start(r, { CHEAP_MEM_SERVE_TOKEN: 'probe-token-dashboard' });
  try {
    for (const p of ['/dashboard', '/dashboard.json', '/dashboard/app.js', '/manifest.webmanifest', '/fonts/dm-sans-latin.woff2']) {
      // Remote is loopback here; the server only waives the token for
      // loopback when no token is configured.
      const res = await rawGet(s.port, p, `127.0.0.1:${s.port}`);
      assert.equal(res.status, 404, `${p} answered ${res.status} without the token`);
    }
    const ok = await rawGet(s.port, '/dashboard.json', `127.0.0.1:${s.port}`, { authorization: 'Bearer probe-token-dashboard' });
    assert.equal(ok.status, 200);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('the retrieval probe is read-only: it answers and writes nothing into the memory', async () => {
  const r = memoryRoot();
  memory.logEntry(r, 'learning', { title: 'probes answer questions', text: 'x' });
  const before = fs.readdirSync(path.join(r, '.mem')).sort();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/dashboard/probe.json`, { method: 'POST', body: new URLSearchParams({ question: 'probes answer' }) });
    const b = await res.json();
    assert.equal(b.state, 'ok');
    assert.ok(b.hits.length >= 1);
    assert.ok(!fs.existsSync(path.join(r, '.pipeline', 'observations.jsonl')), 'the question was observed');
    assert.ok(!fs.existsSync(path.join(r, '.pipeline', 'injections.jsonl')), 'the question was journaled');
    assert.deepEqual(fs.readdirSync(path.join(r, '.mem')).filter((n) => !/index/.test(n)).sort(), before.filter((n) => !/index/.test(n)), 'only the derived search index may appear (the same cache mem find builds)');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

// --- writes: acknowledge, and delete a raw capture -----------------------------

test('acknowledge: only a message addressed to the human, only behind the write switch', async () => {
  const off = memoryRoot();
  const on = memoryRoot({ writes: true });
  const participants = { alex: { human: true }, bot: {} };
  const toHuman = inbox.write(on, participants, { from: 'bot', to: 'alex', subject: 'hello', text: 'hi' }).name;
  const toBot = inbox.write(on, participants, { from: 'alex', to: 'bot', subject: 'yo', text: 'hi' }).name;
  const sOff = await start(off);
  const sOn = await start(on);
  const post = (s, body) => fetch(`${s.base}/inbox/state`, { method: 'POST', redirect: 'manual', headers: { origin: s.base }, body: new URLSearchParams(body) });
  try {
    assert.equal((await post(sOff, { name: 'x.md', state: 'closed' })).status, 403, 'wrote with the switch off');
    assert.equal((await post(sOn, { name: toBot, state: 'closed' })).status, 400, 'acknowledged a message to someone else');
    assert.equal((await post(sOn, { name: toHuman, state: 'processed' })).status, 303);
    assert.equal(inbox.parse(inbox.readMessage(on, toHuman)).state, 'processed');
  } finally {
    await sOff.stop(); await sOn.stop();
    fs.rmSync(off, { recursive: true, force: true }); fs.rmSync(on, { recursive: true, force: true });
  }
});

test('raw capture delete: the task needs a reason, and really deletes through mem raw delete', async (t) => {
  const r = memoryRoot({ writes: true });
  const raw = await import('../src/raw.mjs');
  const transcript = path.join(r, 't.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' }, timestamp: '2026-09-28T08:00:00Z' })}\n`);
  let captured;
  try { captured = raw.capture(r, transcript, { minBytes: 1, stampExtra: { session_id: 'probe-session' } }); } catch (e) { t.skip(`capture not possible here: ${e.message}`); fs.rmSync(r, { recursive: true, force: true }); return; }
  const rows = raw.capturesWithState(r);
  if (!rows.length) { t.skip(`no capture written (${JSON.stringify(captured)})`); fs.rmSync(r, { recursive: true, force: true }); return; }
  const target = rows[0].path;
  const s = await start(r);
  const post = (body) => fetch(`${s.base}/task`, { method: 'POST', headers: { origin: s.base, accept: 'application/json' }, body: new URLSearchParams(body) });
  try {
    const noReason = await post({ kind: 'raw-delete', path: target });
    assert.equal(noReason.status, 400, 'a delete without a reason was accepted');
    const outside = await post({ kind: 'raw-delete', path: '../../etc/passwd', reason: 'probe reason' });
    assert.equal(outside.status, 400, 'a path outside the register shape was accepted');
    const res = await post({ kind: 'raw-delete', path: target, reason: 'probe: remove after review' });
    assert.equal(res.status, 201);
    const { id } = await res.json();
    let st;
    for (let i = 0; i < 100; i += 1) {
      st = await (await fetch(`${s.base}/task.json?id=${id}`)).json();
      if (st.running !== true) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.equal(st.state, 'ok', JSON.stringify(st));
    const after = raw.capturesWithState(r).find((x) => x.path === target);
    assert.equal(after.state, 'deleted');
    assert.equal(after.deleted.reason, 'probe: remove after review');
    assert.equal(after.deleted.by, 'dashboard');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});
