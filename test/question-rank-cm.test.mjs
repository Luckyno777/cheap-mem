// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// question-rank-cm.test.mjs - who may close a question? (owner decision "question-closes-by-rank",
// 2026-10-12, variant A; port of lucky-mem's `fragen-rang-lm`.)
//
// **The finding.** `question.all()` read "some `resolves` edge points at it" and never asked WHO wrote the edge.
// `mem answer`, the bridge's `mem_answer` and a raw `mem log link --kind resolves` therefore closed a question
// the owner had asked himself: any agent, silently, and the question then showed as answered.
//
// **The rule.**
//   - A question of tier `user` (a person asked it) is closed only by an edge of tier `user`: the person's
//     confirmation (`mem questions confirm`, `mem answer --authority user`, the dashboard button behind a
//     password session). An agent's answer leaves it `waiting`: neither open nor closed.
//   - Every other question (agent, unknown, no tier) closes on any valid edge, as before.
//   - A headless run (MEM_HEADLESS) never writes a line of tier `user`: the guard sits in the write core
//     (`memory.logEntry`), so every input form fails alike. Under a ceiling the tier is lowered, not refused.
//   - Append-only: no line is changed; the state is folded from the graph.
//
// Red proof: this file against origin/main (0bf3ae5) is red: the human question reads as closed after an agent's
// answer, the confirm command and the helpers do not exist, a headless run writes tier `user` on every route.
// Positive controls: the agent question is closed by an agent there and here; the legacy question without a tier
// keeps closing on any edge; a non-headless person still writes tier `user`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as authority from '../src/authority.mjs';
import * as question from '../src/question.mjs';

// This process must not be a headless one or capped: the probes seed fixtures in-process.
delete process.env.MEM_HEADLESS;
delete process.env.CHEAP_MEM_MAX_AUTHORITY;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

/** Run the CLI in a scratch root. `env` adds to a clean base (no ceiling, not headless). */
function cli(root, args, env = {}) {
  const e = { ...process.env, ...env };
  for (const k of ['MEM_HEADLESS', 'CHEAP_MEM_MAX_AUTHORITY']) if (!(k in env)) delete e[k];
  return spawnSync(process.execPath, [MEM, ...args, '--root', root], { encoding: 'utf8', input: '', timeout: 40000, env: e });
}
const HEADLESS = { MEM_HEADLESS: 'watcher' };

function world(t) {
  const root = tempDir('cm-qrank-', t);
  const r = cli(root, ['init']);
  assert.equal(r.status, 0, r.stderr);
  return root;
}

function bridge(root, calls) {
  const msgs = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  calls.forEach(([name, a], i) => msgs.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: a } })));
  const env = { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign' };
  delete env.CHEAP_MEM_MAX_AUTHORITY;
  delete env.MEM_HEADLESS;
  const r = spawnSync(process.execPath, [MCP], { input: `${msgs.join('\n')}\n`, encoding: 'utf8', timeout: 40000, env });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  return calls.map((_, i) => {
    const x = replies.find((y) => y.id === 10 + i);
    if (!x) throw new Error(`no reply: ${String(r.stderr).slice(0, 600)}`);
    return x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] };
  });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

// On the old state there is no `state`: a question is open or (through ANY edge) closed. One probe measures both.
const stateOf = (q) => q.state ?? (q.open ? 'open' : 'closed');
const find = (root, id) => question.all(root).find((q) => q.id === id);
const lines = (root, type) => memory.readLog(root, type).entries;
const raw = (root, type) => {
  const p = memory.logPath(root, type, null);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

/** A question a person asked (tier user) and an agent's entry that could answer it. */
function setup(t, { asked = 'user' } = {}) {
  const root = world(t);
  const q = memory.logEntry(root, 'question', { question: 'Which port does the dashboard use?', authority: asked, agent: 'owner' }).entry;
  const a = memory.logEntry(root, 'decision', { title: 'Port 8080', choice: '8080', why: 'default', agent: 'session' }).entry;
  return { root, q, a };
}

// --- The rule itself (pure) -------------------------------------------------------

test('authority.mayCloseQuestion: only a user edge closes a user question; any edge closes another', () => {
  const human = { authority: 'user' };
  const agent = { authority: 'agent' };
  assert.equal(authority.mayCloseQuestion({ authority: 'user' }, human).ok, true);
  for (const t of ['agent', 'system', 'external', 'inferred', 'unknown']) {
    const v = authority.mayCloseQuestion({ authority: t }, human);
    assert.equal(v.ok, false, t);
    assert.equal(v.status, 'waits', t);
  }
  assert.equal(authority.mayCloseQuestion({}, human).ok, false, 'a missing tier reads unknown: waits');
  // POSITIVE CONTROL: the rule is not "nobody closes": every other question closes on any edge.
  for (const q of [agent, { authority: 'unknown' }, {}, { authority: 'inferred' }]) {
    for (const e of [{ authority: 'agent' }, {}, { authority: 'user' }]) assert.equal(authority.mayCloseQuestion(e, q).ok, true);
  }
});

test('authority.mayCloseQuestion: no same-author shortcut - the scribe of a person\'s question does not close it', () => {
  const q = { authority: 'user', agent: 'session' };
  const e = { authority: 'agent', agent: 'session' };
  assert.equal(authority.mayCloseQuestion(e, q).ok, false);
});

test('authority guards: headless and ceiling are separate codes; checkUserWrite is both', () => {
  assert.throws(() => authority.checkNotHeadless({ MEM_HEADLESS: 'reflector' }), (e) => e.code === 'HEADLESS');
  assert.doesNotThrow(() => authority.checkNotHeadless({}));
  assert.throws(() => authority.checkUnderUserCeiling({ CHEAP_MEM_MAX_AUTHORITY: 'inferred' }), (e) => e.code === 'AUTHORITY_CAPPED');
  assert.doesNotThrow(() => authority.checkUnderUserCeiling({ CHEAP_MEM_MAX_AUTHORITY: 'user' }));
  assert.throws(() => authority.checkUserWrite({ MEM_HEADLESS: 'x' }), (e) => e.code === 'HEADLESS');
  assert.throws(() => authority.checkUserWrite({ CHEAP_MEM_MAX_AUTHORITY: 'agent' }), (e) => e.code === 'AUTHORITY_CAPPED');
  assert.doesNotThrow(() => authority.checkUserWrite({}));
});

// --- RED: an agent closes the person's question ------------------------------------

test('CLI: an agent answers a person\'s question - answered, waits, NOT closed', (t) => {
  const { root, q, a } = setup(t);
  const r = cli(root, ['answer', q.id, '--with', a.id]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(find(root, q.id)), 'waiting', 'the agent\'s answer closed the person\'s question');
  assert.equal(question.open(root).some((x) => x.id === q.id), false, 'it is not open either: an answer exists');
  assert.match(r.stdout, /wait/i, 'the writer is told it is not closed');
  const shown = cli(root, ['questions']);
  assert.match(shown.stdout, new RegExp(`wait.*${q.id}|${q.id}.*wait`, 'i'), 'the default list still shows it: it needs the person');
  assert.equal(lines(root, 'link').length, 1, 'the answer itself is recorded');
});

test('bridge: mem_answer on a person\'s question waits; mem_questions shows it; the answering agent cannot confirm', (t) => {
  const { root, q, a } = setup(t);
  const [ans, list] = bridge(root, [
    ['mem_answer', { question_id: q.id, with: a.id }],
    ['mem_questions', {}],
  ]);
  assert.ok(!ans.isError, textOf(ans));
  assert.match(textOf(ans), /wait/i);
  assert.equal(stateOf(find(root, q.id)), 'waiting');
  assert.match(textOf(list), /wait/i);
  assert.match(textOf(list), new RegExp(q.id));
  const edge = lines(root, 'link')[0];
  assert.equal(edge.authority, 'agent', 'the bridge stamps the agent tier, whatever the caller says');
});

test('raw edge: `mem log link --kind resolves` and a bridge mem_log edge claiming user do not close a person\'s question', (t) => {
  const { root, q, a } = setup(t);
  const r1 = cli(root, ['log', 'link', '--from', a.id, '--to', q.id, '--kind', 'resolves']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(stateOf(find(root, q.id)), 'waiting');
  // under a ceiling (a model writer): the claimed user tier is lowered, so the edge does not close either
  const b = memory.logEntry(root, 'decision', { title: 'Port 9090', choice: '9090', why: 'other', agent: 'session' }).entry;
  const r2 = cli(root, ['log', 'link', '--from', b.id, '--to', q.id, '--kind', 'resolves', '--authority', 'user'], { CHEAP_MEM_MAX_AUTHORITY: 'inferred' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(stateOf(find(root, q.id)), 'waiting', 'a lowered claim must not close');
  const [viaBridge] = bridge(root, [['mem_log', { type: 'link', from: a.id, to: q.id, kind: 'resolves', authority: 'user' }]]);
  assert.ok(!viaBridge.isError, textOf(viaBridge));
  assert.equal(stateOf(find(root, q.id)), 'waiting', 'the bridge lowers a claimed user tier to agent');
});

// --- GREEN: the person confirms ----------------------------------------------------

test('a person confirms: `mem questions confirm --authority user` closes, append-only', (t) => {
  const { root, q, a } = setup(t);
  assert.equal(cli(root, ['answer', q.id, '--with', a.id]).status, 0);
  const qBefore = raw(root, 'question');
  const linksBefore = raw(root, 'link');
  const r = cli(root, ['questions', 'confirm', q.id, '--authority', 'user', '--why', 'yes, that is it']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(find(root, q.id)), 'closed');
  assert.equal(raw(root, 'question'), qBefore, 'the question line is untouched');
  assert.ok(raw(root, 'link').startsWith(linksBefore), 'the earlier edge is untouched: the confirmation is a NEW line');
  const edges = lines(root, 'link');
  assert.equal(edges.length, 2);
  const conf = edges[1];
  assert.equal(conf.authority, 'user');
  assert.equal(conf.from, a.id, 'it confirms the agent\'s answer');
  assert.equal(conf.to, q.id);
  assert.equal(conf.kind, 'resolves');
  assert.equal(conf.confirmed, true);
  assert.equal(find(root, q.id).answers.find((x) => x.edge === conf.id).closes, true);
  assert.equal(find(root, q.id).answers.find((x) => x.edge === edges[0].id).closes, false, 'the agent\'s edge alone did not close it');
});

test('confirming is a person\'s act: without --authority user, headless, or under a ceiling it is refused, nothing written', (t) => {
  const { root, q, a } = setup(t);
  assert.equal(cli(root, ['answer', q.id, '--with', a.id]).status, 0);
  const before = raw(root, 'link');
  for (const [label, args, env] of [
    ['no tier', ['questions', 'confirm', q.id], {}],
    ['agent tier', ['questions', 'confirm', q.id, '--authority', 'agent'], {}],
    ['headless', ['questions', 'confirm', q.id, '--authority', 'user'], HEADLESS],
    ['ceiling', ['questions', 'confirm', q.id, '--authority', 'user'], { CHEAP_MEM_MAX_AUTHORITY: 'inferred' }],
  ]) {
    const r = cli(root, args, env);
    assert.notEqual(r.status, 0, `${label}: ${r.stdout}`);
    assert.equal(raw(root, 'link'), before, `${label}: something was written`);
  }
  assert.equal(stateOf(find(root, q.id)), 'waiting');
});

test('confirm only what waits: an open or an already closed question is refused', (t) => {
  const { root, q, a } = setup(t);
  const open = cli(root, ['questions', 'confirm', q.id, '--authority', 'user']);
  assert.notEqual(open.status, 0);
  assert.match(open.stderr + open.stdout, /not (been )?answered|nothing to confirm/i);
  assert.equal(lines(root, 'link').length, 0);
  assert.equal(cli(root, ['answer', q.id, '--with', a.id]).status, 0);
  assert.equal(cli(root, ['questions', 'confirm', q.id, '--authority', 'user']).status, 0);
  const again = cli(root, ['questions', 'confirm', q.id, '--authority', 'user']);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr + again.stdout, /already closed/i);
  assert.equal(lines(root, 'link').length, 2);
  const none = cli(root, ['questions', 'confirm', 'nosuchid1', '--authority', 'user']);
  assert.notEqual(none.status, 0);
});

test('the person answers himself: `mem answer --authority user` closes at once; headless or capped it is refused', (t) => {
  const { root, q, a } = setup(t);
  const before = raw(root, 'link');
  for (const [label, env] of [['headless', HEADLESS], ['ceiling', { CHEAP_MEM_MAX_AUTHORITY: 'agent' }]]) {
    const r = cli(root, ['answer', q.id, '--with', a.id, '--authority', 'user'], env);
    assert.notEqual(r.status, 0, `${label}: ${r.stdout}`);
    assert.equal(raw(root, 'link'), before, `${label}: something was written`);
  }
  const ok = cli(root, ['answer', q.id, '--with', a.id, '--authority', 'user']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(stateOf(find(root, q.id)), 'closed');
  assert.equal(lines(root, 'link')[0].authority, 'user');
});

test('a new person\'s question: `mem questions new --authority user` stamps the tier; without it the question is the agents\'', (t) => {
  const root = world(t);
  const id = (r) => /id:\s*(\S+)/.exec(r.stdout)[1];
  const human = cli(root, ['questions', 'new', 'Who owns the staging box?', '--authority', 'user']);
  assert.equal(human.status, 0, human.stderr);
  const agent = cli(root, ['questions', 'new', 'Is the cache warm?']);
  assert.equal(agent.status, 0, agent.stderr);
  const byId = Object.fromEntries(lines(root, 'question').map((e) => [e.id, e]));
  assert.equal(byId[id(human)].authority, 'user');
  assert.equal(byId[id(agent)].authority, 'agent');
  for (const [label, env] of [['headless', HEADLESS], ['ceiling', { CHEAP_MEM_MAX_AUTHORITY: 'inferred' }]]) {
    const n = lines(root, 'question').length;
    const r = cli(root, ['questions', 'new', 'Forged person question?', '--authority', 'user'], env);
    assert.notEqual(r.status, 0, `${label}: ${r.stdout}`);
    assert.equal(lines(root, 'question').length, n, `${label}: a line was written`);
  }
});

// --- POSITIVE CONTROLS: the agents' questions close as before ----------------------

test('POSITIVE CONTROL: an agent\'s question answered by an agent is closed at once (CLI and bridge)', (t) => {
  const root = world(t);
  const q1 = memory.logEntry(root, 'question', { question: 'Is the cache warm?', agent: 'session' }).entry;
  const q2 = memory.logEntry(root, 'question', { question: 'Which node version?', agent: 'session', authority: 'agent' }).entry;
  const a = memory.logEntry(root, 'decision', { title: 'Node 22', choice: '22', why: 'lts', agent: 'session' }).entry;
  assert.equal(cli(root, ['answer', q1.id, '--with', a.id]).status, 0);
  assert.equal(stateOf(find(root, q1.id)), 'closed');
  const [r] = bridge(root, [['mem_answer', { question_id: q2.id, with: a.id }]]);
  assert.ok(!r.isError, textOf(r));
  assert.equal(stateOf(find(root, q2.id)), 'closed');
  assert.equal(question.open(root).length, 0);
});

test('POSITIVE CONTROL: a legacy question without any tier closes on any edge, as before', (t) => {
  const root = world(t);
  // Written by hand like an old store: no authority on the question.
  const p = memory.logPath(root, 'question', null);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify({ v: 1, id: 'legacyq1', ts: '2026-01-01T00:00:00Z', agent: 'old', question: 'Old question?' })}\n`);
  const a = memory.logEntry(root, 'decision', { title: 'Old answer', choice: 'x', why: 'y', agent: 'session' }).entry;
  assert.equal(stateOf(find(root, 'legacyq1')), 'open');
  assert.equal(cli(root, ['answer', 'legacyq1', '--with', a.id]).status, 0);
  assert.equal(stateOf(find(root, 'legacyq1')), 'closed');
});

// --- The guard sits in the write core: a headless run never writes tier user ----------

const FORMS = [
  ['log decision --authority user', (a) => ['log', 'decision', '--title', 'forged', '--choice', 'x', '--why', 'y', '--authority', 'user'], 'decision'],
  ['log decision with blanks and capitals', () => ['log', 'decision', '--title', 'forged', '--choice', 'x', '--why', 'y', '--authority', ' User\t'], 'decision'],
  ['log question --authority user', () => ['log', 'question', '--question', 'Forged person question?', '--authority', 'user'], 'question'],
  ['log link resolves --authority user', (a) => ['log', 'link', '--from', a.a.id, '--to', a.q.id, '--kind', 'resolves', '--authority', 'user'], 'link'],
  ['mem answer --authority user', (a) => ['answer', a.q.id, '--with', a.a.id, '--authority', 'user'], 'link'],
  ['mem done --authority user', (a) => ['done', a.a.id, '--why', 'forged', '--authority', 'user'], 'decision'],
];
for (const [name, argv, drawer] of FORMS) {
  test(`headless: ${name} is refused in the write core, nothing written; without MEM_HEADLESS a person may`, (t) => {
    const w = setup(t);
    const before = raw(w.root, drawer);
    const r = cli(w.root, argv(w), HEADLESS);
    assert.notEqual(r.status, 0, `a headless run wrote tier user: ${r.stdout}`);
    assert.equal(raw(w.root, drawer), before, 'a line was written');
    assert.equal(stateOf(find(w.root, w.q.id)), 'open');
    // POSITIVE CONTROL: the same command by a person works - the probe measures the guard, not a typo.
    const ok = cli(w.root, argv(w));
    assert.equal(ok.status, 0, ok.stderr);
    assert.notEqual(raw(w.root, drawer), before);
  });
}

test('headless under a ceiling keeps working: the claim is LOWERED, not refused (reflector and digest unchanged)', (t) => {
  const w = setup(t);
  const r = cli(w.root, ['log', 'decision', '--title', 'by the reflector', '--choice', 'x', '--why', 'y', '--authority', 'user'],
    { MEM_HEADLESS: 'reflector', CHEAP_MEM_MAX_AUTHORITY: 'inferred' });
  assert.equal(r.status, 0, r.stderr);
  const e = lines(w.root, 'decision').find((x) => x.title === 'by the reflector');
  assert.equal(e.authority, 'inferred');
  assert.equal(e.authority_clamped_from, 'user');
  // and a headless run with no claim at all still writes (agent tier)
  const plain = cli(w.root, ['log', 'decision', '--title', 'plain headless', '--choice', 'x', '--why', 'y'], HEADLESS);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(lines(w.root, 'decision').find((x) => x.title === 'plain headless').authority, 'agent');
});

test('the core refuses in-process too: memory.logEntry with tier user under MEM_HEADLESS throws, other tiers pass', (t) => {
  const root = world(t);
  const before = process.env.MEM_HEADLESS;
  process.env.MEM_HEADLESS = 'watcher';
  try {
    assert.throws(() => memory.logEntry(root, 'decision', { title: 't', choice: 'c', why: 'w', authority: 'user' }), (e) => e.code === 'HEADLESS');
    assert.doesNotThrow(() => memory.logEntry(root, 'decision', { title: 't2', choice: 'c', why: 'w', authority: 'agent' }));
    assert.doesNotThrow(() => memory.logEntry(root, 'decision', { title: 't3', choice: 'c', why: 'w' }));
  } finally {
    if (before === undefined) delete process.env.MEM_HEADLESS; else process.env.MEM_HEADLESS = before;
  }
  assert.deepEqual(lines(root, 'decision').map((e) => e.title).sort(), ['t2', 't3']);
});
