// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/cardstore.test.mjs — H11 (card-core-cm): the card shelf `cards.jsonl`, `mem card add|list`, the MCP tools, and the one
// check in the write core that every road runs through.
//
// Ported from the sibling's cross-check of its card shelf (2026-10-13): a locked or mistyped target is refused on ALL roads
// (the library, `mem card add`, `mem log card`, `mem_log`, `mem_card_add`), tier `user` exists only from a person, the higher
// tier counts before the youngest card, the shelf is no search hit and no recall hit, and the three states of the shelf
// (missing = empty, broken lines counted, unreadable = unknown) stay apart.
//
// Red proof: before this build there was no type `card`, no shelf, no `mem card` (every probe fails at its first call).
// Positive controls: the same target without a lock goes through on every road; a person writes tier user; a withdrawn card
// no longer counts; a good card appears in `mem card list`.
//
// invariant: nicht-messbar-ist-nicht-null
// invariant: eine-regel-eine-stelle
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as cardstore from '../src/cardstore.mjs';
import * as decisioncard from '../src/decisioncard.mjs';
import * as capability from '../src/capability.mjs';
import * as mcpprofile from '../src/mcpprofile.mjs';

delete process.env.MEM_HEADLESS;
delete process.env.CHEAP_MEM_MAX_AUTHORITY;
delete process.env.CHEAP_MEM_AGENT;
delete process.env.MEM_AGENT;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

function cli(root, args, env = {}) {
  const e = { ...process.env, CHEAP_MEM_AGENT: 'builder-x', ...env };
  for (const k of ['MEM_HEADLESS', 'CHEAP_MEM_MAX_AUTHORITY']) if (!(k in env)) delete e[k];
  return spawnSync(process.execPath, [MEM, ...args, '--root', root], { encoding: 'utf8', input: '', timeout: 40000, env: e });
}

/** The stdio server of the bridge: calls [[name, args], ...] -> `{ error, text }` each. */
function bridge(root, calls, agent = 'foreign') {
  const msgs = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  calls.forEach(([name, a], i) => msgs.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: a } })));
  const env = { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: agent };
  delete env.CHEAP_MEM_MAX_AUTHORITY; delete env.MEM_HEADLESS;
  const r = spawnSync(process.execPath, [MCP], { input: `${msgs.join('\n')}\n`, encoding: 'utf8', timeout: 60000, env });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  return calls.map((_, i) => {
    const x = replies.find((y) => y.id === 10 + i);
    if (!x) throw new Error(`no reply: ${String(r.stderr).slice(0, 600)}`);
    return { error: Boolean(x.result?.isError || x.error), text: `${(x.result?.content ?? []).map((c) => c.text).join('\n')} ${JSON.stringify(x.error ?? '')}` };
  });
}

function world(t) {
  const root = tempDir('cm-shelf-', t);
  const r = cli(root, ['init']);
  assert.equal(r.status, 0, r.stderr);
  const lines = [
    { id: 'pl0001abc', ts: '2026-10-01T00:00:00Z', title: 'Open task', who: 'user', agent: 'orchestrator', authority: 'agent' },
    { id: 'px0002abc', ts: '2026-10-01T00:00:00Z', body_enc: { cipher: 'AAAA' }, agent: 'orchestrator', authority: 'agent' },
  ];
  fs.appendFileSync(path.join(root, 'global', 'duties.jsonl'), lines.map((z) => `${JSON.stringify(z)}\n`).join(''));
  return root;
}
const shelfLines = (root) => {
  const p = path.join(root, 'global', 'cards.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
};
const GOOD = { question: 'Should that happen?', context: 'It is time.', options: ['Yes — it happens', 'No — it stays'] };
const RAW = (target, extra = {}) => ({
  target_id: target, card_question: GOOD.question, card_context: GOOD.context, card_options: GOOD.options, ...extra,
});

// --- B2: no clear text beside the locked -----------------------------------------------------------

test('B2: a card for a locked target is refused loudly on every road; nothing stands on the shelf', (t) => {
  const w = world(t);
  assert.throws(() => cardstore.write(w, { target_id: 'px0002abc', ...GOOD }), /locked/);
  assert.throws(() => memory.logCheckedEntry(w, 'card', RAW('px0002abc')), /locked/);
  assert.throws(() => memory.logEntry(w, 'card', RAW('px0002abc')), /locked/);
  const a = cli(w, ['card', 'add', 'px0002abc', '--question', GOOD.question, '--context', GOOD.context, '--option', GOOD.options[0], '--option', GOOD.options[1]]);
  assert.equal(a.status, 1, a.stdout + a.stderr);
  assert.match(a.stderr, /locked/);
  const b = cli(w, ['log', 'card', '--target_id', 'px0002abc', '--card_question', GOOD.question, '--card_context', GOOD.context, '--card_options', GOOD.options.join('\n')]);
  assert.notEqual(b.status, 0, b.stdout);
  assert.match(b.stderr + b.stdout, /locked/);
  const [c, d] = bridge(w, [['mem_log', { type: 'card', ...RAW('px0002abc') }], ['mem_card_add', { target_id: 'px0002abc', ...GOOD }]]);
  assert.equal(c.error, true, c.text);
  assert.match(c.text, /locked/);
  assert.equal(d.error, true, d.text);
  assert.match(d.text, /locked/);
  assert.deepEqual(shelfLines(w), [], 'clear text stands on the shelf despite the refusal');
  // positive control: the unlocked target goes through
  assert.doesNotThrow(() => cardstore.write(w, { target_id: 'pl0001abc', ...GOOD }));
});

// --- S2: one check in the write core --------------------------------------------------------------

test('S2: `mem log card` and the bridge run through the same check as `mem card add` (target, options, decline option, lengths)', (t) => {
  const w = world(t);
  const bad = [
    ['without options', RAW('pl0001abc', { card_options: [] }), /at least two options/],
    ['without a decline option', RAW('pl0001abc', { card_options: ['Yes — a', 'Maybe — b'] }), /No \/ not-now option/],
    ['target does not exist', RAW('doesnotexist'), /no entry/],
    ['without a target', (() => { const r = RAW('x'); delete r.target_id; return r; })(), /target_id/],
    ['without a context', RAW('pl0001abc', { card_context: '' }), /card_context missing/],
    ['unknown project', RAW('project:no-such-project'), /no project/],
  ];
  for (const [name, fields, re] of bad) {
    assert.throws(() => memory.logCheckedEntry(w, 'card', fields), re, `core: ${name}`);
    const [r] = bridge(w, [['mem_log', { type: 'card', ...fields }]]);
    assert.equal(r.error, true, `bridge ${name}: ${r.text}`);
    assert.match(r.text, re, `bridge ${name}`);
    const cl = cli(w, ['log', 'card', ...Object.entries(fields).flatMap(([k, v]) => [`--${k}`, Array.isArray(v) ? v.join('\n') : String(v)])]);
    assert.notEqual(cl.status, 0, `CLI ${name}: ${cl.stdout}`);
  }
  assert.deepEqual(shelfLines(w), [], 'a refused card stands in the file');
  // positive control: one good card per road
  assert.doesNotThrow(() => memory.logCheckedEntry(w, 'card', RAW('pl0001abc')));
  const [ok] = bridge(w, [['mem_log', { type: 'card', ...RAW('pl0001abc', { card_question: 'And the second question?' }) }]]);
  assert.equal(ok.error, false, ok.text);
  const cl = cli(w, ['log', 'card', '--target_id', 'pl0001abc', '--card_question', 'Third question?', '--card_context', 'c', '--card_options', GOOD.options.join('\n')]);
  assert.equal(cl.status, 0, cl.stderr);
  assert.equal(shelfLines(w).length, 3);
});

test('S2: a tombstone in the shelf (mem discard --type card) goes through the core without being checked as a card', (t) => {
  const w = world(t);
  const { entry } = cardstore.write(w, { target_id: 'pl0001abc', ...GOOD }, { agent: 'a' });
  const v = cli(w, ['discard', entry.id, '--type', 'card', '--why', 'wrong']);
  assert.equal(v.status, 0, v.stderr);
  const shelf = cardstore.readCards(w);
  assert.equal(shelf.cards.size, 0);
  assert.equal(shelf.withdrawn, 1);
  assert.equal(shelf.broken, 0);
  assert.equal(shelf.unusable, 0);
});

test('a line in the shelf that is neither a card nor a tombstone is refused (clear text without a card)', (t) => {
  const w = world(t);
  assert.throws(() => memory.logEntry(w, 'card', { title: 'just text', text: 'clear text without a card and without a tombstone' }), /neither/);
  assert.deepEqual(shelfLines(w), []);
});

// --- S6: the target is validated, the hint is quoted -------------------------------------------------

test('S6: a target with shell characters is refused, nothing is written, nothing is printed unquoted', (t) => {
  const w = world(t);
  const evil = ['letter:$(id)"; echo X; "', 'letter:a b', 'project:../x', 'word-pair:a;b|c', 'pl0001abc; rm -rf', 'a`id`', "letter:'x", 'letter:', 'x'.repeat(200)];
  for (const z of evil) {
    assert.throws(() => cardstore.write(w, { target_id: z, ...GOOD }), /target_id/, z);
    const r = cli(w, ['card', 'add', z, '--question', GOOD.question, '--context', GOOD.context, '--option', GOOD.options[0], '--option', GOOD.options[1]]);
    assert.equal(r.status, 1, z);
    assert.ok(!/echo X; "/.test(r.stdout), `printed unquoted: ${r.stdout}`);
  }
  assert.deepEqual(shelfLines(w), []);
  // positive control: the allowed forms pass, and the hint quotes the target in single quotes
  fs.mkdirSync(path.join(w, 'projects', 'sample'), { recursive: true });
  for (const z of ['pl0001abc', 'letter:mail-1.md', 'word-pair:alarm|clock', 'project:sample']) {
    const r = cli(w, ['card', 'add', z, '--question', GOOD.question, '--context', GOOD.context, '--option', GOOD.options[0], '--option', GOOD.options[1]]);
    assert.equal(r.status, 0, `${z}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`git commit -m 'card: ${z.replace(/[|.]/g, '\\$&')}'`), z);
  }
});

// --- tier: user only from a person --------------------------------------------------------------------

test('tier user on a card exists only from a person: an agent is refused on every road, a person is not', (t) => {
  const w = world(t);
  const args = ['card', 'add', 'pl0001abc', '--question', GOOD.question, '--context', GOOD.context, '--option', GOOD.options[0], '--option', GOOD.options[1], '--authority', 'user'];
  const agent = cli(w, args);
  assert.notEqual(agent.status, 0, agent.stdout);
  assert.match(agent.stderr + agent.stdout, /Tier user/);
  const logRoad = cli(w, ['log', 'card', '--target_id', 'pl0001abc', '--card_question', GOOD.question, '--card_context', GOOD.context, '--card_options', GOOD.options.join('\n'), '--authority', 'user']);
  assert.notEqual(logRoad.status, 0, logRoad.stdout);
  assert.match(logRoad.stderr + logRoad.stdout, /Tier user/);
  assert.throws(() => memory.logEntry(w, 'card', RAW('pl0001abc', { authority: 'user', agent: 'builder-x' })), /Tier user/);
  // the bridge lowers a claimed tier to agent (and records it); the core does not even see `user` there
  const [br] = bridge(w, [['mem_log', { type: 'card', ...RAW('pl0001abc'), authority: 'user' }]]);
  assert.equal(br.error, false, br.text);
  assert.deepEqual(shelfLines(w).map((l) => JSON.parse(l).authority), ['agent']);
  // a person (human:<name>) writes tier user
  const person = cli(w, args, { CHEAP_MEM_AGENT: 'human:alex' });
  assert.equal(person.status, 0, person.stderr);
  assert.deepEqual(shelfLines(w).map((l) => JSON.parse(l).authority), ['agent', 'user']);
  // and an agent's later card does not displace it (the higher tier counts)
  cardstore.write(w, { target_id: 'pl0001abc', ...GOOD, question: 'Agent asks anew?' }, { agent: 'builder-x', now: new Date('2099-01-01T00:00:00Z') });
  const k = cardstore.readCards(w).cards.get('pl0001abc');
  assert.equal(k.question, GOOD.question);
  assert.equal(k.rank, 'user');
});

test('a headless run never writes a card of tier user', (t) => {
  const w = world(t);
  const r = cli(w, ['card', 'add', 'pl0001abc', '--question', GOOD.question, '--context', GOOD.context, '--option', GOOD.options[0], '--option', GOOD.options[1], '--authority', 'user'], { CHEAP_MEM_AGENT: 'human:alex', MEM_HEADLESS: 'watcher' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(shelfLines(w), []);
});

// --- N1: a correction line is checked as a whole card ---------------------------------------------------

test('N1: a line in the shelf checks its target ALWAYS - also a correction line (replaces_id) without a whole card; pure tombstones stay free', (t) => {
  const w = world(t);
  const { entry: old } = cardstore.write(w, { target_id: 'pl0001abc', ...GOOD }, { agent: 'a' });
  const roads = [
    { replaces_id: old.id, target_id: 'px0002abc', card_context: 'Clear text for the locked target', title: 'x' },
    { by_id: old.id, target_id: 'px0002abc', card_context: 'Clear text', title: 'x' },
    { closes_id: old.id, target_id: 'px0002abc', card_context: 'Clear text', title: 'x' },
    { replaces_id: old.id, card_context: 'Clear text without a target', title: 'x' },
    { replaces_id: old.id, target_id: 'pl0001abc', card_context: 'Only a context', title: 'x' },
    { title: 'only text', text: 'Clear text without a card and without a tombstone' },
  ];
  for (const fields of roads) {
    assert.throws(() => memory.logCheckedEntry(w, 'card', fields), /Card|locked|target_id/, JSON.stringify(fields));
  }
  const cl = cli(w, ['log', 'card', '--replaces_id', old.id, '--target_id', 'px0002abc', '--card_context', 'Clear text', '--title', 'x']);
  assert.notEqual(cl.status, 0, cl.stdout);
  assert.ok(!shelfLines(w).join('\n').includes('Clear text'), 'clear text stands on the shelf');
  const [br] = bridge(w, [['mem_log', { type: 'card', target_id: 'px0002abc', card_context: 'Clear text', replaces_id: old.id }]]);
  assert.equal(br.error, true, br.text);
  // positive controls: a pure tombstone, a whole correction card for a normal target
  assert.equal(cli(w, ['discard', old.id, '--type', 'card', '--why', 'wrong']).status, 0);
  assert.doesNotThrow(() => memory.logCheckedEntry(w, 'card', { replaces_id: old.id, ...RAW('pl0001abc', { card_question: 'Reworded?' }), agent: 'a' }));
});

// --- S1 on the shelf: the higher tier counts, then the youngest --------------------------------------------

test('S1: per target the higher tier counts, then the youngest; the card that lost stands as `replaced` on the one that counts', (t) => {
  const w = world(t);
  const line = (id, ts, agent, authority, question) => `${JSON.stringify({ id, ts, agent, authority, target_id: 'pl0001abc', card_question: question, card_context: 'c', card_options: ['A — a', 'No — b'] })}\n`;
  const file = path.join(w, 'global', 'cards.jsonl');
  fs.appendFileSync(file, line('k1', '2026-10-14T00:00:00Z', 'human:alex', 'user', 'The person asks?')
    + line('k2', '2026-10-16T00:00:00Z', 'orch', 'agent', 'Agent asks?') + line('k3', '2026-10-17T00:00:00Z', 'orch', 'agent', 'Newer agent asks?'));
  const k = cardstore.latestCards(w).get('pl0001abc');
  assert.equal(k.question, 'The person asks?');
  assert.equal(k.rank, 'user');
  assert.deepEqual(k.replaced, { author: 'orch', rank: 'agent', ts: '2026-10-17T00:00:00Z' }, 'the one displaced last at equal tier');
  // equal tiers: the youngest
  fs.writeFileSync(file, line('k2', '2026-10-16T00:00:00Z', 'orch', 'agent', 'Old?') + line('k3', '2026-10-17T00:00:00Z', 'orch', 'agent', 'New?'));
  const g = cardstore.latestCards(w).get('pl0001abc');
  assert.equal(g.question, 'New?');
  assert.deepEqual(g.replaced, { author: 'orch', rank: 'agent', ts: '2026-10-16T00:00:00Z' });
  // all the way into the card
  const kk = decisioncard.cardOf({ id: 'pl0001abc', ts: '2026-10-01T00:00:00Z' }, { type: 'duty', context: { cards: cardstore.latestCards(w) } });
  assert.deepEqual(kk.replaced, { author: 'orch', rank: 'agent', ts: '2026-10-16T00:00:00Z' });
  // the highest displaced card is named, whatever the reading order
  fs.writeFileSync(file, line('k1', '2026-10-14T00:00:00Z', 'sys', 'system', 'System?') + line('k2', '2026-10-15T00:00:00Z', 'orch', 'agent', 'Agent?')
    + line('k3', '2026-10-16T00:00:00Z', 'human:alex', 'user', 'Persons?'));
  assert.deepEqual(cardstore.latestCards(w).get('pl0001abc').replaced, { author: 'sys', rank: 'system', ts: '2026-10-14T00:00:00Z' });
  fs.writeFileSync(file, line('k3', '2026-10-16T00:00:00Z', 'human:alex', 'user', 'Persons?') + line('k2', '2026-10-15T00:00:00Z', 'orch', 'agent', 'Agent?')
    + line('k1', '2026-10-14T00:00:00Z', 'sys', 'system', 'System?'));
  assert.deepEqual(cardstore.latestCards(w).get('pl0001abc').replaced, { author: 'sys', rank: 'system', ts: '2026-10-14T00:00:00Z' });
});

// --- the three states of the shelf ------------------------------------------------------------------------

test('the shelf has three states: missing is empty and readable, broken and unusable lines are counted, an unreadable shelf is unknown', (t) => {
  const w = world(t);
  const missing = cardstore.readCards(w);
  assert.equal(missing.readable, true);
  assert.equal(missing.cards.size, 0);
  assert.deepEqual(cardstore.stateOf(missing), { readable: true, reason: null, cards: 0, broken: 0, unusable: 0 });
  const file = path.join(w, 'global', 'cards.jsonl');
  fs.writeFileSync(file, [
    '{broken',
    JSON.stringify({ id: 'k1', ts: '2026-10-14T00:00:00Z', agent: 'a', card_question: 'Without a target?' }),
    JSON.stringify({ id: 'k2', ts: '2026-10-14T00:00:00Z', agent: 'a', target_id: 'pl0001abc', card_question: 'Good?', card_context: 'w', card_options: ['A — a', 'No — b'] }),
  ].join('\n') + '\n');
  const state = cardstore.stateOf(cardstore.readCards(w));
  assert.deepEqual(state, { readable: true, reason: null, cards: 1, broken: 1, unusable: 1 });
  assert.match(cardstore.reasonsOf(state)[0], /1 broken and 1 unusable/);
  assert.deepEqual(cardstore.reasonsOf({ readable: true, broken: 0, unusable: 0 }), []);
  // unreadable: the shelf is a directory
  fs.rmSync(file); fs.mkdirSync(file);
  const un = cardstore.readCards(w);
  assert.equal(un.readable, false);
  assert.match(un.reason, /not readable/);
  const ust = cardstore.stateOf(un);
  assert.deepEqual([ust.cards, ust.broken, ust.unusable], [null, null, null], 'unknown is not 0');
  assert.match(cardstore.reasonsOf(ust)[0], /fallback cards/);
  const list = cli(w, ['card', 'list']);
  assert.equal(list.status, 1);
  assert.match(list.stderr, /unknown, not empty/);
});

test('a card can be filed in a project drawer and still counts for its target; a withdrawn card does not count', (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w, 'projects', 'sample'), { recursive: true });
  const { entry } = cardstore.write(w, { target_id: 'pl0001abc', ...GOOD }, { project: 'sample', agent: 'a' });
  assert.ok(fs.existsSync(path.join(w, 'projects', 'sample', 'cards.jsonl')));
  assert.equal(cardstore.latestCards(w).get('pl0001abc').project, 'sample');
  memory.retireEntry(w, 'card', entry.id, { state: 'discarded', project: 'sample', agent: 'a' });
  assert.equal(cardstore.latestCards(w).size, 0);
});

// --- cards are no search hits and no recall hits ----------------------------------------------------------

test('S3: a card does not displace its target - find, search and recall find the entry, not the card; mem card list and mem show reach it', (t) => {
  const w = tempDir('cm-shelf-search-', t);
  assert.equal(cli(w, ['init']).status, 0);
  fs.appendFileSync(path.join(w, 'global', 'duties.jsonl'), `${JSON.stringify({ id: 'pwake0001', ts: '2026-10-01T00:00:00Z', title: 'Reset the alarm-timer', text: 'The alarm-timer runs wrong.', who: 'user', agent: 'orchestrator', authority: 'agent' })}\n`);
  const { entry } = cardstore.write(w, {
    target_id: 'pwake0001', question: 'Should the alarm-timer be reset?', context: 'The alarm-timer runs wrong, reset the alarm-timer.',
    options: ['Yes — the alarm-timer is reset', 'No — it stays'],
  }, { agent: 'orch' });
  const cap = capability.grantAll('test');
  const found = memory.find(w, 'alarm-timer', cap);
  assert.deepEqual(found.map((h) => h.id), ['pwake0001'], 'memory.find: the card stands among the hits');
  const f = cli(w, ['find', 'alarm-timer', '--literal']);
  assert.match(f.stdout, /duties\.jsonl/, f.stdout + f.stderr);
  assert.ok(!f.stdout.includes('cards.jsonl'), 'mem find --literal shows the card');
  const g = cli(w, ['find', 'alarm-timer']);
  assert.match(g.stdout, /duties\.jsonl/, g.stdout + g.stderr);
  assert.ok(!g.stdout.includes('cards.jsonl'), 'mem find shows the card');
  const r = cli(w, ['retrieve', 'How do I reset the alarm-timer?']);
  assert.ok(!r.stdout.includes(entry.id), 'recall shows the card');
  assert.match(cli(w, ['card', 'list']).stdout, /pwake0001/);
  assert.match(cli(w, ['show', entry.id]).stdout, /alarm-timer/);
  // an explicit type filter at memory.find reads the shelf; `mem find --type card` points to `mem card list`
  assert.ok(memory.find(w, 'alarm-timer', cap, { types: ['card'] }).length >= 1);
  const hint = cli(w, ['find', 'passieren', '--type', 'card']);
  assert.equal(hint.status, 0);
  assert.match(hint.stdout, /Cards are not in the search index: mem card list/);
  assert.ok(!/Cards are not in the search index/.test(cli(w, ['find', 'task', '--type', 'duty']).stdout));
  assert.deepEqual(memory.SEARCH_TYPES.includes('card'), false);
  assert.ok(Object.keys(memory.TYPES).includes('card'));
});

// --- the MCP tools -------------------------------------------------------------------------------------------

test('mem_card_add and mem_card_list: a card is written with the agent name and tier agent; the list names it; a read-only bridge refuses the write', (t) => {
  const w = world(t);
  const [add, list] = bridge(w, [['mem_card_add', { target_id: 'pl0001abc', ...GOOD, advice: 'Yes.', evidence: ['docs/x.md'] }], ['mem_card_list', {}]], 'chatty');
  assert.equal(add.error, false, add.text);
  assert.match(add.text, /by chatty, tier agent/);
  assert.match(list.text, /pl0001abc {2}Should that happen\?/);
  const k = cardstore.latestCards(w).get('pl0001abc');
  assert.equal(k.author, 'chatty');
  assert.equal(k.rank, 'agent');
  assert.equal(k.advice, 'Yes.');
  // read-only profile: listing reads, adding writes
  assert.equal(mcpprofile.allowed('mem_card_list', mcpprofile.PROFILE.READ_ONLY), true);
  assert.equal(mcpprofile.allowed('mem_card_add', mcpprofile.PROFILE.READ_ONLY), false);
});

test('the type `card` is a drawer like the others: `mem doctor` names no finding about a shelf of good cards', (t) => {
  const w = world(t);
  const before = cli(w, ['doctor']).stdout;
  cardstore.write(w, { target_id: 'pl0001abc', ...GOOD }, { agent: 'a' });
  const after = cli(w, ['doctor']).stdout;
  assert.ok(!/cards/i.test(after), after.split('\n').filter((l) => /cards/i.test(l)).join('\n'));
  // same levels before and after (a finding that appears only with the shelf would be named here)
  // ONE finding is allowed to move, and it is no finding ABOUT the shelf: `decision-without-explanation` (card-rule-doctor-cm) counts
  // the human's decisions that have only the fallback card, and the card just written IS the explanation of its target `pl0001abc`
  // (the human's old open task). It warns before and is gone after - asserted below, not just filtered out.
  const levels = (out) => out.split('\n').filter((l) => /^(WARN|FAIL|ERR)/.test(l)).map((l) => l.split(/\s+/).slice(0, 2).join(' ')).sort();
  const without = (xs) => xs.filter((l) => l !== 'WARN decision-without-explanation');
  assert.deepEqual(without(levels(after)), without(levels(before)));
  assert.ok(levels(before).includes('WARN decision-without-explanation'), 'positive control: the task had only the fallback card');
  assert.ok(!levels(after).includes('WARN decision-without-explanation'), 'the card explains it');
});

test('S3: the pre-edit lookup of a file (`mem component --table`) names the entry, not the card that repeats its path', (t) => {
  const w = tempDir('cm-shelf-comp-', t);
  assert.equal(cli(w, ['init']).status, 0);
  // the table lists git-tracked paths: a real repository with the file in it
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'zeta-module.mjs'), 'export const zeta = 1;\n');
  const git = (...a) => spawnSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.test', '-c', 'commit.gpgsign=false', ...a], { cwd: w, encoding: 'utf8' });
  git('init', '-q'); git('add', 'src/zeta-module.mjs'); git('commit', '-q', '-m', 'file');
  fs.appendFileSync(path.join(w, 'global', 'duties.jsonl'), `${JSON.stringify({ id: 'pzeta0001', ts: '2026-10-01T00:00:00Z', title: 'Fix src/zeta-module.mjs', text: 'It breaks in src/zeta-module.mjs.', who: 'user', agent: 'o', authority: 'agent' })}\n`);
  const { entry } = cardstore.write(w, {
    target_id: 'pzeta0001', question: 'Should src/zeta-module.mjs be fixed?', context: 'It breaks in src/zeta-module.mjs.',
    options: ['Yes — fixed', 'No — stays'], evidence: ['src/zeta-module.mjs'],
  }, { agent: 'orch' });
  cli(w, ['component', '--rebuild', '--table']);
  const r = cli(w, ['component', 'src/zeta-module.mjs', '--table']);
  assert.match(r.stdout + r.stderr, /pzeta0001/, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(entry.id), 'the card stands in the component lookup');
});

// --- review of e73f830, B7: `mem log card` lists -----------------------------------------------------------

test('B7: `mem log card` takes a repeated --card_options / --card_evidence; the refusal names the flag of THAT road, not only --option', (t) => {
  const w = world(t);
  const base = ['log', 'card', '--target_id', 'pl0001abc', '--card_question', 'Which way?', '--card_context', 'c'];
  const twice = cli(w, [...base, '--card_options', 'Left — go left', '--card_options', 'No — stay', '--card_evidence', 'e1', '--card_evidence', 'e2']);
  assert.equal(twice.status, 0, twice.stderr);
  const row = JSON.parse(shelfLines(w).at(-1));
  assert.deepEqual(row.card_options, ['Left — go left', 'No — stay']);
  assert.deepEqual(row.card_evidence, ['e1', 'e2']);
  // one per line in one value still works
  assert.equal(cli(w, [...base, '--card_options', 'Left — a\nNo — b']).status, 0);
  // one option only: refused, and the message names the flags of this road
  const one = cli(w, [...base, '--card_options', 'No — stay']);
  assert.notEqual(one.status, 0);
  assert.match(one.stderr, /--card_options twice or one per line/);
  assert.match(one.stderr, /mem card add`: --option twice/);
  assert.match(cli(w, ['log', '--help']).stdout, /--card_options .* \(twice or more, or one per line/);
  assert.equal(shelfLines(w).length, 2);
});
