// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// y4b-authority-flags.test.mjs — Y4b (BAUPLAN-mem-admin_02.md, 2026-09-30).
//
// Y4 made `retires_id`/`closes_id`/`replaces_id` ONE question
// (`authority.mayChangeState`). Four gaps stayed, each measured here:
//
//   1. New lines carried NO `authority` — they read as `unknown`, the
//      lowest tier, so the digest (ceiling `inferred`) could still close
//      or retire anything a session wrote after Y4. Now the write path
//      stamps `agent` (the ceiling wins; `user` only explicitly).
//   2. The CLI had no way to say "the person told me to": `mem done`,
//      `discard`, `supersede`, `duties close`, `correction` now take
//      `--authority <tier>`; a refused line is still written, warned
//      about on stderr, and read as disputed.
//   3. The reflector (a model writer, like the digest) had no ceiling;
//      the MCP bridge let a caller claim `user`.
//   4. `mem doctor` could not see contested claims (`contested-claims`,
//      counterpart of lucky-mem's `bestritten`).
//
// Red proof: against the fixed start commit c23ad5c (before this build)
// the default-tier probe, the flag probes, the correction warning, the
// bridge clamp and the doctor probe are red (the flags are refused as
// unknown switches, the digest line closes the session duty, the finding
// does not exist). The dashboard probe was red there too: `done` from a
// password session wrote no tier at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as authority from '../src/authority.mjs';
import * as doctor from '../src/doctor.mjs';
import * as tasks from '../src/tasks.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

function cli(root, args, env = {}) {
  const e = { ...process.env, ...env };
  delete e.CHEAP_MEM_MAX_AUTHORITY;
  if (env.CHEAP_MEM_MAX_AUTHORITY) e.CHEAP_MEM_MAX_AUTHORITY = env.CHEAP_MEM_MAX_AUTHORITY;
  return spawnSync(process.execPath, [MEM, ...args, '--root', root], { encoding: 'utf8', input: '', timeout: 40000, env: e });
}

function world(t) {
  const root = tempDir('cm-y4b-', t);
  const r = cli(root, ['init']);
  assert.equal(r.status, 0, r.stderr);
  return root;
}

function withCeiling(value, fn) {
  const before = process.env[authority.CEILING_ENV];
  if (value === null) delete process.env[authority.CEILING_ENV];
  else process.env[authority.CEILING_ENV] = value;
  try { return fn(); } finally {
    if (before === undefined) delete process.env[authority.CEILING_ENV];
    else process.env[authority.CEILING_ENV] = before;
  }
}

/** The raw lines of a drawer, tombstones included. */
const lines = (root, type) => memory.readLog(root, type).entries;
const lastLine = (root, type) => lines(root, type).at(-1);
const stateOf = (root, type, id) => memory.retiredMap(lines(root, type)).get(id) ?? null;

// --- 1. The default tier ---------------------------------------------------

test('a new line without a tier is stamped agent; the ceiling wins; user stays explicit', (t) => {
  const root = world(t);
  withCeiling(null, () => {
    const plain = memory.logEntry(root, 'decision', { title: 'a', choice: 'c', why: 'w' }).entry;
    assert.equal(plain.authority, 'agent', 'no tier given must read agent, not absent/unknown');
    assert.ok(!('authority_clamped_from' in plain), 'a default is not a demotion');
    const user = memory.logEntry(root, 'decision', { title: 'b', choice: 'c', why: 'w', authority: 'user' }).entry;
    assert.equal(user.authority, 'user', 'an explicit user tier must survive without a ceiling');
  });
  withCeiling('inferred', () => {
    const plain = memory.logEntry(root, 'decision', { title: 'c', choice: 'c', why: 'w' }).entry;
    assert.equal(plain.authority, 'inferred', 'under a ceiling the default is the ceiling');
    assert.ok(!('authority_clamped_from' in plain), 'the default claimed nothing, so nothing was demoted');
    const user = memory.logEntry(root, 'decision', { title: 'd', choice: 'c', why: 'w', authority: 'user' }).entry;
    assert.equal(user.authority, 'inferred');
    assert.equal(user.authority_clamped_from, 'user', 'a real demotion is still recorded');
  });
  assert.equal(authority.writeTierDefault({}), 'agent');
  assert.equal(authority.writeTierDefault({ [authority.CEILING_ENV]: 'external' }), 'external');
  assert.equal(authority.writeTierDefault({ [authority.CEILING_ENV]: 'user' }), 'agent', 'a ceiling never raises');
});

test('the default protects a session duty from the digest (POSITIVE CONTROL: an unstamped legacy duty is still closable)', (t) => {
  const root = world(t);
  const duty = withCeiling(null, () => memory.logEntry(root, 'duty',
    { title: 'session duty', agent: 'session' }).entry);
  assert.equal(duty.authority, 'agent');
  // The digest writes under its ceiling. Its closing line names no tier.
  withCeiling('inferred', () => memory.closeDuty(root, duty.id, { agent: 'digest', why: 'looks done' }));
  const open = memory.openDuties(root).open.map((d) => d.id);
  assert.ok(open.includes(duty.id), 'the digest closed a session duty — the default tier protected nothing');

  // Control: a legacy duty (no tier on disk) is lateral to an unstamped
  // closer and closes as it always did — the probe CAN see a close.
  const p = memory.logPath(root, 'duty', null);
  fs.appendFileSync(p, JSON.stringify({ id: 'legacyduty1', ts: '2026-01-01T00:00:00Z', title: 'old', agent: 'session' }) + '\n');
  fs.appendFileSync(p, JSON.stringify({ id: 'legacyclose', ts: '2026-01-02T00:00:00Z', closes_id: 'legacyduty1', state: 'done', agent: 'digest' }) + '\n');
  assert.ok(!memory.openDuties(root).open.some((d) => d.id === 'legacyduty1'), 'the probe cannot see a close at all');
});

// --- 2. The CLI flags --------------------------------------------------------

function userTarget(root, type = 'decision', extra = {}) {
  return withCeiling(null, () => memory.logEntry(root, type,
    { title: `user ${type}`, choice: 'c', why: 'w', agent: 'lucky', authority: 'user', ...extra }).entry);
}

for (const verb of ['done', 'discard']) {
  test(`mem ${verb}: without --authority the line is agent, refused against a user claim, warned and disputed`, (t) => {
    const root = world(t);
    const target = userTarget(root);
    const r = cli(root, [verb, target.id]);
    assert.equal(r.status, 0, r.stderr);
    const line = lastLine(root, 'decision');
    assert.equal(line.retires_id, target.id, 'the line must be written (append-only)');
    assert.equal(line.authority, 'agent');
    assert.match(r.stderr, /not honoured/, 'the writer must hear it now, not at the next recall');
    assert.equal(stateOf(root, 'decision', target.id), null, 'the user claim was retired by an agent line');
    assert.equal(stateOf(root, 'decision', line.id)?.state, 'disputed');
  });

  test(`mem ${verb} --authority user: stamped, no warning, the target is retired`, (t) => {
    const root = world(t);
    const target = userTarget(root);
    const r = cli(root, [verb, target.id, '--authority', 'user']);
    assert.equal(r.status, 0, r.stderr);
    const line = lastLine(root, 'decision');
    assert.equal(line.authority, 'user');
    assert.doesNotMatch(r.stderr, /not honoured/);
    assert.equal(stateOf(root, 'decision', target.id)?.state, verb === 'done' ? 'done' : 'discarded');
  });
}

test('--authority with a name that is no tier is refused and writes nothing', (t) => {
  const root = world(t);
  const target = userTarget(root);
  const before = lines(root, 'decision').length;
  const r = cli(root, ['done', target.id, '--authority', 'boss']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--authority takes one of/);
  assert.equal(lines(root, 'decision').length, before, 'a refused flag still wrote a line');
});

test('mem supersede --authority: the strict rule refuses a lateral agent line, user passes', (t) => {
  const root = world(t);
  const [oldE, newE] = withCeiling(null, () => [
    memory.logEntry(root, 'decision', { title: 'old', choice: 'a', why: 'w', agent: 'other' }).entry,
    memory.logEntry(root, 'decision', { title: 'new', choice: 'b', why: 'w', agent: 'other' }).entry,
  ]);
  const refused = cli(root, ['supersede', oldE.id, '--by', newE.id]);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /not honoured/);
  assert.equal(stateOf(root, 'decision', oldE.id), null, 'a different agent at the same tier replaced a claim');
  const ok = cli(root, ['supersede', oldE.id, '--by', newE.id, '--authority', 'user']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(lastLine(root, 'decision').authority, 'user');
  assert.equal(stateOf(root, 'decision', oldE.id)?.state, 'superseded');
});

test('mem duties close --authority: refused as agent against a user duty, closes as user', (t) => {
  const root = world(t);
  const duty = userTarget(root, 'duty');
  const refused = cli(root, ['duties', 'close', duty.id]);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /not honoured/);
  assert.equal(lastLine(root, 'duty').authority, 'agent');
  assert.ok(memory.openDuties(root).open.some((d) => d.id === duty.id), 'an agent line closed a user duty');
  const ok = cli(root, ['duties', 'close', duty.id, '--authority', 'user']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(lastLine(root, 'duty').authority, 'user');
  assert.ok(!memory.openDuties(root).open.some((d) => d.id === duty.id), 'a user line did not close the duty');
});

test('mem correction --authority: a refused correction warns on stderr; user replaces', (t) => {
  const root = world(t);
  const target = withCeiling(null, () => memory.logEntry(root, 'decision',
    { title: 'agent claim', choice: 'a', why: 'w', agent: 'other' }).entry);
  const refused = cli(root, ['correction', 'decision', target.id, '--choice', 'b']);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /not honoured/, 'a refused correction must be announced, like a refused close');
  assert.equal(stateOf(root, 'decision', target.id), null);
  const ok = cli(root, ['correction', 'decision', target.id, '--choice', 'c', '--authority', 'user']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /not honoured/);
  assert.equal(lastLine(root, 'decision').authority, 'user');
  assert.equal(stateOf(root, 'decision', target.id)?.state, 'superseded');
  const bad = cli(root, ['correction', 'decision', target.id, '--choice', 'd', '--authority', 'boss']);
  assert.notEqual(bad.status, 0, 'an unknown tier would have become unknown without a word');
});

// --- 3. The model writers and the bridge --------------------------------------

test('both model writers set the ceiling themselves (digest and reflect, sh and ps1)', () => {
  for (const f of ['mem-digest', 'mem-reflect']) {
    assert.match(fs.readFileSync(path.join(REPO, 'bin', f), 'utf8'), /export CHEAP_MEM_MAX_AUTHORITY="\$\{CHEAP_MEM_MAX_AUTHORITY:-inferred\}"/, f);
  }
  for (const f of ['mem-digest.ps1', 'mem-reflect.ps1']) {
    assert.match(fs.readFileSync(path.join(REPO, 'bin', f), 'utf8'), /\$env:CHEAP_MEM_MAX_AUTHORITY = 'inferred'/, f);
  }
});

function bridge(root, calls) {
  const msgs = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  calls.forEach(([name, a], i) => msgs.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: a } })));
  const env = { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign' };
  delete env.CHEAP_MEM_MAX_AUTHORITY;
  const r = spawnSync(process.execPath, [MCP], { input: `${msgs.join('\n')}\n`, encoding: 'utf8', timeout: 40000, env });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  return calls.map((_, i) => {
    const x = replies.find((y) => y.id === 10 + i);
    if (!x) throw new Error(`no reply: ${String(r.stderr).slice(0, 600)}`);
    return x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] };
  });
}

test('the bridge cannot mint user: a claimed user tier is lowered to agent and recorded; no tier reads agent', (t) => {
  const root = world(t);
  const [a, b, c] = bridge(root, [
    ['mem_log', { type: 'decision', title: 'claims user', choice: 'x', why: 'y', authority: 'user' }],
    ['mem_log', { type: 'decision', title: 'claims nothing', choice: 'x', why: 'y' }],
    ['mem_log', { type: 'decision', title: 'claims less', choice: 'x', why: 'y', authority: 'external' }],
  ]);
  for (const x of [a, b, c]) assert.ok(!x.isError, JSON.stringify(x));
  const byTitle = Object.fromEntries(lines(root, 'decision').map((e) => [e.title, e]));
  assert.equal(byTitle['claims user'].authority, 'agent');
  assert.equal(byTitle['claims user'].authority_clamped_from, 'user');
  assert.equal(byTitle['claims nothing'].authority, 'agent');
  assert.equal(byTitle['claims less'].authority, 'external', 'POSITIVE CONTROL: a lower claim is kept as it is');
});

// --- 4. The dashboard: user only behind a password session --------------------

test('the dashboard done task passes --authority user only when told a person is signed in', () => {
  const plain = tasks.KINDS.done.command('/r', 'x', { id: 'abcd1234' }, {});
  assert.ok(!plain.args.includes('--authority'), 'no context must never mean user');
  const token = tasks.KINDS.done.command('/r', 'x', { id: 'abcd1234' }, { user: 'yes' });
  assert.ok(!token.args.includes('--authority'), 'only a strict true counts');
  const person = tasks.KINDS.done.command('/r', 'x', { id: 'abcd1234' }, { user: true });
  assert.deepEqual(person.args.slice(-2), ['--authority', 'user']);
  assert.throws(() => tasks.checkParams('done', { id: 'abcd1234', authority: 'user' }), /takes no parameter 'authority'/,
    'a form field must never carry the tier');
});

async function serveStart(root, env, opts) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', ...env }, opts);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

async function waitForLine(root, id) {
  const t0 = Date.now();
  for (;;) {
    const hit = lines(root, 'decision').find((e) => e.retires_id === id);
    if (hit) return hit;
    if (Date.now() - t0 > 20000) throw new Error('the done task wrote nothing in 20 s');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('dashboard: a password session marks done as user; the bearer token alone stays agent', async (t) => {
  const root = world(t);
  const [a, b] = withCeiling(null, () => [
    memory.logEntry(root, 'decision', { title: 'one', choice: 'c', why: 'w' }).entry,
    memory.logEntry(root, 'decision', { title: 'two', choice: 'c', why: 'w' }).entry,
  ]);
  const s = await serveStart(root, { CHEAP_MEM_SERVE_TOKEN: 'door' }, { allowWrites: true });
  try {
    // Bearer only (tools, probes, whoever holds the link): not a person.
    const r1 = await fetch(`${s.base}/task`, { method: 'POST', redirect: 'manual',
      headers: { authorization: 'Bearer door', origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'done', id: a.id }) });
    assert.equal(r1.status, 201, await r1.text());
    assert.equal((await waitForLine(root, a.id)).authority, 'agent', 'the bearer token made itself the user');

    // A password session: set up with the setup code, then act.
    const code = fs.readFileSync(path.join(root, '.pipeline', 'serve-setup-code'), 'utf8').trim();
    const pw = 'a-proper-long-password';
    const setup = await fetch(`${s.base}/login/setup`, { method: 'POST', redirect: 'manual',
      headers: { origin: s.base, authorization: 'Bearer door' },
      body: new URLSearchParams({ code, password: pw, password2: pw }) });
    assert.equal(setup.status, 303, await setup.text());
    const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^mem_session=/);
    const r2 = await fetch(`${s.base}/task`, { method: 'POST', redirect: 'manual',
      headers: { cookie, authorization: 'Bearer door', origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'done', id: b.id }) });
    assert.equal(r2.status, 201, await r2.text());
    assert.equal((await waitForLine(root, b.id)).authority, 'user', 'a signed-in person was not recorded as user');
  } finally { await s.stop(); }
});

// --- 5. The doctor -----------------------------------------------------------

test('contested-claims: unknown without a pointer, good without a refusal, warning with count and youngest', (t) => {
  const root = world(t);
  const empty = doctor.checkContestedClaims(root);
  assert.equal(empty.level, 'unknown', 'no pointer at all must not read as good');

  const target = userTarget(root);
  const own = withCeiling(null, () => memory.logEntry(root, 'decision', { title: 'mine', choice: 'c', why: 'w', agent: 'me' }).entry);
  withCeiling(null, () => memory.retireEntry(root, 'decision', own.id, { agent: 'me' }));
  const good = doctor.checkContestedClaims(root);
  assert.equal(good.level, 'good', JSON.stringify(good));

  const refused = withCeiling(null, () => memory.retireEntry(root, 'decision', target.id, { agent: 'someone' })).entry;
  const warn = doctor.checkContestedClaims(root);
  assert.equal(warn.level, 'warn', JSON.stringify(warn));
  assert.match(warn.text, new RegExp(`1 contested claim .*youngest: ${refused.id}`));
  assert.ok(doctor.checkAll(root).findings.some((f) => f.name === 'contested-claims'),
    'the finding is not part of the doctor run');
});
