// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/board-parity-package-cm.test.mjs — the project package export
// (#sources/export), parity with lucky-mem's projektpaket (2026-10-01).
//
// What is secured (one test each):
//   (1) the package's counts = the preview's counts = the old browser rule
//       (`getExport()` until 2026-10-01) applied to /dashboard.json.
//   (2) exclusions: no raw capture text, no inbox mail, no key material.
//   (3) encrypted stays ciphertext — even though the server HAS the key
//       (positive control: /dashboard.json shows the plaintext).
//   (4) redaction: a fake token stands in the package only redacted.
//   (5) `why` only from raw lines: a plain retirement reason is there
//       (redacted), the reason of an encrypted retiring line is not.
//   (6) invalid project -> 400, unknown -> 404, POST -> 405.
//   (7) the same gates as the other read routes: without the door token a
//       bare 404, a foreign Host header 403-refused, no CORS header.
//
// Red proof: on the fixed base commit deca5ad7 the route does not exist —
// every call falls into the bare 404 (checked below in a throwaway worktree
// by the build report, and inside this file against the old route list).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const ROUTE = '/dashboard/project-package.json';
const OLD = 'deca5ad713f1dc7f3ec05cf21e0d5cf1ebb22a3b';
const TOKEN = `pp-${process.pid}`;
const WITH = { headers: { authorization: `Bearer ${TOKEN}` } };
const NOW = new Date('2026-09-30T10:00:00Z');
// Built at run time so no scanner flags the test file itself.
const FAKE_TOKEN = 'gh' + 'p_' + 'Zq7x'.repeat(10);
const SECRET = 'SECRET-PLAINTEXT-4711';
const SECRET_WHY = 'SECRET-RETIRE-REASON-0042';
const RAW_MARK = 'RAW-CAPTURE-MARK-0815';
const MAIL_MARK = 'INBOX-MAIL-MARK-1234';

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-package-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'pkg', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  // A raw capture with a marker; one entry points at it through origin.raw.
  const rawRel = path.join('raw', '2026', '09', 'capture-pp.jsonl');
  fs.mkdirSync(path.join(r, path.dirname(rawRel)), { recursive: true });
  fs.writeFileSync(path.join(r, rawRel), JSON.stringify({ text: RAW_MARK }) + '\n');
  // Inbox mail with a marker.
  fs.mkdirSync(path.join(r, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(r, 'inbox', '2026-09-30-bot-to-alex.md'), `---\nfrom: bot\nto: alex\nsubject: ${MAIL_MARK}\n---\n${MAIL_MARK}\n`);

  const g1 = memory.logEntry(r, 'learning', { title: 'Global foundation', text: 'holds everywhere' }, { now: NOW }).entry;
  const p1 = memory.logEntry(r, 'decision', { choice: 'Project decision', why: 'builds on the foundation', origin: { raw: rawRel, derived_from: [g1.id] } }, { project: 'demo', now: NOW }).entry;
  memory.logEntry(r, 'learning', { title: 'With a token', text: `curl -H "Authorization: token ${FAKE_TOKEN}"` }, { project: 'demo', now: NOW });
  memory.logEntry(r, 'learning', { title: SECRET, text: SECRET, shred: true }, { project: 'demo', now: NOW });
  // Another project the demo project points at (an external reference).
  const a1 = memory.logEntry(r, 'learning', { title: 'Foreign knowledge', text: 'belongs elsewhere' }, { project: 'other', now: NOW }).entry;
  memory.logEntry(r, 'learning', { title: 'Points outside', text: 'x', origin: { derived_from: [a1.id] } }, { project: 'demo', now: NOW });
  // Retired twice: once with a plain reason (carrying a token), once by an encrypted retiring line.
  const old1 = memory.logEntry(r, 'learning', { title: 'Retired plainly', text: 'x' }, { project: 'demo', now: NOW }).entry;
  memory.retireEntry(r, 'learning', old1.id, { state: 'discarded', why: `wrong, see ${FAKE_TOKEN}`, project: 'demo' });
  const old2 = memory.logEntry(r, 'learning', { title: 'Retired secretly', text: 'x' }, { project: 'demo', now: NOW }).entry;
  memory.logEntry(r, 'learning', { retires_id: old2.id, state: 'discarded', why: SECRET_WHY, shred: true }, { project: 'demo', now: NOW });
  return { r, p1, a1, g1, old1, old2 };
}

async function start(root, extra = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?pkg=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_TOKEN: TOKEN, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', ...extra });
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

/** The browser rule as it stood in assets/dashboard/dashboard.js until 2026-10-01 (getExport). */
function oldBrowserRule(rows, project, global, hist) {
  const included = rows.filter((e) => (e.project === project || (global && e.project === 'global')) && (hist || (e.state || 'active') === 'active'));
  const ids = new Set(included.map((e) => e.id));
  const refs = [...new Set(included.flatMap((e) => (e.out || []).map((x) => x[1])).filter((id) => !ids.has(id)))];
  return { included: included.length, refs: refs.length };
}

const w1 = world();
const s = await start(w1.r);
test.after(() => s.stop());
const get = (q, opts = WITH) => fetch(`${s.base}${ROUTE}?${q}`, opts);

test('(1) package = preview = the old browser rule, for all four switch combinations', async () => {
  const dash = await (await fetch(`${s.base}/dashboard.json`, WITH)).json();
  for (const [g, h] of [[1, 1], [1, 0], [0, 1], [0, 0]]) {
    const q = `project=demo&global=${g}&history=${h}`;
    const pre = await (await get(q + '&preview=1')).json();
    const res = await get(q);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="cheap-mem-demo-\d{4}-\d{2}-\d{2}\.json"/);
    const pkg = await res.json();
    const want = oldBrowserRule(dash.entries, 'demo', Boolean(g), Boolean(h));
    assert.equal(pre.counts.entries, want.included, `preview ${q}`);
    assert.equal(pkg.header.counts.entries, want.included, `package ${q}`);
    assert.equal(pkg.entries.length, want.included);
    assert.equal(pre.counts.externalRefs, want.refs);
    assert.equal(pkg.refs.length, want.refs);
    assert.equal(pkg.header.format, 'cheap-mem-project-package');
    assert.ok(pkg.header.created && pkg.header.selection.project === 'demo');
  }
  const pkg = await (await get('project=demo&global=1&history=1')).json();
  assert.ok(pkg.refs.some((v) => v.id === w1.a1.id && v.title === 'Foreign knowledge'), 'the external reference names id and title');
  assert.ok(!pkg.entries.some((e) => e.id === w1.a1.id), '... but its content is not in the package');
});

test('(2) exclusions: no raw capture text, no inbox mail, no key material — the origin pointer stays', async () => {
  const text = await (await get('project=demo&global=1&history=1')).text();
  assert.ok(!text.includes(RAW_MARK), 'raw capture text in the package');
  assert.ok(!text.includes(MAIL_MARK), 'inbox mail in the package');
  const ring = fs.readFileSync(path.join(w1.r, '.mem', 'keyring.json'), 'utf8');
  const keys = [...ring.matchAll(/"([A-Za-z0-9+/=_-]{32,})"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 1, 'positive control: the keyring holds key material');
  for (const k of keys) assert.ok(!text.includes(k), 'key material in the package');
  assert.match(text, /capture-pp\.jsonl/, 'the origin pointer (a path) stays');
  const pkg = JSON.parse(text);
  assert.ok(pkg.header.excluded.length >= 4);
});

test('(3) encrypted stays ciphertext, although the server has the key (positive control: /dashboard.json decrypts)', async () => {
  const dash = await (await fetch(`${s.base}/dashboard.json`, WITH)).text();
  assert.ok(dash.includes(SECRET), 'positive control: the display path shows the plaintext');
  const text = await (await get('project=demo&global=1&history=1')).text();
  assert.ok(!text.includes(SECRET), 'plaintext of an encrypted entry in the package');
  const pkg = JSON.parse(text);
  const enc = pkg.entries.filter((e) => e.encrypted);
  assert.ok(enc.length >= 1);
  assert.ok(enc.every((e) => e.entry && e.entry.body_enc !== undefined), 'the body_enc envelope is there');
  assert.ok(pkg.header.counts.encrypted >= 1);
});

test('(4) redaction: a fake token stands in the package only redacted', async () => {
  const text = await (await get('project=demo&global=1&history=1')).text();
  assert.ok(!text.includes(FAKE_TOKEN), 'fake token unredacted in the package');
  const pkg = JSON.parse(text);
  assert.ok(pkg.header.redaction.applied && pkg.header.redaction.found.length >= 1, 'findings are counted');
});

test('(5) why only from raw lines: plain reason redacted and present, the encrypted retiring line gives none', async () => {
  const pkg = await (await get('project=demo&global=1&history=1')).json();
  const plain = pkg.entries.find((e) => e.id === w1.old1.id);
  const secret = pkg.entries.find((e) => e.id === w1.old2.id);
  assert.ok(plain && secret, 'both retired entries are in the package (history on)');
  assert.equal(plain.state, 'discarded');
  assert.match(plain.why || '', /^wrong, see /, 'the plain reason is there');
  assert.ok(!plain.why.includes(FAKE_TOKEN), '... and redacted');
  assert.equal(secret.why, undefined, 'no reason from an encrypted retiring line');
  assert.ok(!JSON.stringify(pkg).includes(SECRET_WHY));
});

test('(6) invalid project 400, unknown 404, POST 405', async () => {
  assert.equal((await get('project=../x')).status, 400);
  assert.equal((await get('project=demo&global=maybe')).status, 400);
  assert.equal((await get('project=nothere')).status, 404);
  assert.equal((await fetch(`${s.base}${ROUTE}?project=demo`, { method: 'POST', headers: WITH.headers })).status, 405);
});

test('(7) the same gates as the other read routes: no token -> bare 404, foreign Host refused, no CORS header', async () => {
  const no = await get('project=demo', {});
  assert.equal(no.status, 404);
  assert.equal(await no.text(), 'not found');
  const u = new URL(`${s.base}${ROUTE}?project=demo`);
  const foreign = await new Promise((res, rej) => {
    http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...WITH.headers, host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej);
  });
  assert.notEqual(foreign, 200, 'a foreign Host header must not get the package');
  const ok = await get('project=demo');
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  const mod = await import(`${pathToFileURL(SERVE).href}?pkgpaths=${Math.random()}`);
  assert.ok(mod.HOST_GUARDED.includes(ROUTE), 'the route is host-guarded');
  assert.ok(!mod.WRITE_PATHS.includes(ROUTE), 'the route does not write');
});

test(`RED on the fixed old state (${OLD.slice(0, 8)}): the route is not in its route list`, (t) => {
  let old;
  try { old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:src/dashboard-page.mjs`], { encoding: 'utf8' }); } catch {
    t.skip(`commit ${OLD} not reachable — red proof unknown, not green`);
    return;
  }
  assert.match(old, /\/dashboard\/part\.json/, 'positive control: the old route list is read');
  assert.ok(!old.includes(ROUTE), 'RED: the old state has no project package route');
});
