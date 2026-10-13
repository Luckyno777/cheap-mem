// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/card-rule.test.mjs — H11 (card-rule-doctor-cm): the WRITE RULE of the decision card. A NEW duty or question addressed to
// the human brings its card; without one, stage 1 takes it in and says so loudly, stage 2 (CHEAP_MEM_CARD_REJECT=yes) refuses.
//
// Port of the sibling's rule (agent/karte-schreibregel-lm, cross-checked 2026-10-13), in this house's idiom: the rule sits in the
// write core `memory.logCheckedEntry`, and only on a road that STATES ITS ROUTE (cli | mcp | task); an internal writer states none
// and is exempt; nobody is exempt by agent name.
//
// Red proof: on the base (card-core-cm 6e81ce3) there is no rule, no route, no switch, no `addressee`, no `humandecisions` — every
// probe below fails or does not load. Positive controls are marked: an agent's duty is not touched, a duty with a complete card
// passes, a question without `who` passes, an internal writer passes even with the switch on.
//
// invariant: eine-regel-eine-stelle
// invariant: nicht-messbar-ist-nicht-null
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as entryops from '../src/entryops.mjs';
import * as cardrule from '../src/cardrule.mjs';
import * as addressee from '../src/addressee.mjs';
import { yesNoValue } from '../src/yesno.mjs';
import * as decisioncard from '../src/decisioncard.mjs';
import * as humandecisions from '../src/humandecisions.mjs';
import * as today from '../src/today.mjs';

delete process.env.MEM_HEADLESS;
delete process.env.CHEAP_MEM_MAX_AUTHORITY;
delete process.env.CHEAP_MEM_AGENT;
delete process.env.CHEAP_MEM_CARD_REJECT;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

const cli = (root, args, env = {}) => spawnSync(process.execPath, [MEM, ...args, '--root', root], {
  encoding: 'utf8', input: '', timeout: 40000, env: { ...process.env, CHEAP_MEM_AGENT: 'builder-x', ...env },
});

function bridge(root, calls, env = {}) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  let id = 10;
  for (const [name, a] of calls) lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  const r = spawnSync(process.execPath, [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0', ...env },
  });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  if (replies.length < calls.length + 1) throw new Error(`bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 800)}`);
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

/** A store with the default participants: `user` is the human, `session` and `librarian` are agents. */
function world(t) {
  const root = tempDir('cm-cardrule-', t);
  assert.equal(cli(root, ['init']).status, 0);
  return root;
}
const rows = (root, type) => {
  const r = memory.readLog(root, type);
  return r.missing ? [] : (r.entries ?? []);
};
/** Run `fn` with the switch set to `value` (undefined = unset) and restore it. */
function withSwitch(value, fn) {
  const before = process.env.CHEAP_MEM_CARD_REJECT;
  if (value === undefined) delete process.env.CHEAP_MEM_CARD_REJECT; else process.env.CHEAP_MEM_CARD_REJECT = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.CHEAP_MEM_CARD_REJECT; else process.env.CHEAP_MEM_CARD_REJECT = before; }
}

const CARD = {
  card_question: 'Which licence should the package carry?',
  card_context: 'Two files disagree.',
  card_options: ['MIT — as in LICENSE', 'Not now — nothing changes'],
};
const duty = (extra = {}) => ({ title: 'Pick a licence', ...extra });

// --- the small leaves ---------------------------------------------------------------------------------------------

test('addressee: one trimmed reading, the first of who / owner / to wins, a blank who does not fall through', () => {
  assert.equal(addressee.nameOf('  user '), 'user');
  assert.equal(addressee.nameOf(7), '', 'a number addresses nobody');
  assert.equal(addressee.nameOf(['user']), '', 'a list addresses nobody');
  assert.equal(addressee.ofDuty({ who: ' user ' }), 'user');
  assert.equal(addressee.ofDuty({ owner: 'user' }), 'user');
  assert.equal(addressee.ofDuty({ to: 'user' }), 'user');
  assert.equal(addressee.ofDuty({ who: 'session', owner: 'user' }), 'session', 'who comes first');
  assert.equal(addressee.ofDuty({ who: '  ', owner: 'user' }), '', 'a blank who is a field that is there and says nothing');
  assert.equal(addressee.ofDuty({ who: null, owner: 'user' }), 'user', 'null falls through as before (`??`)');
  assert.equal(addressee.ofQuestion({ who: ' user ' }), 'user');
  assert.equal(addressee.ofQuestion({ owner: 'user' }), '', 'a question knows only `who`');
  assert.equal(addressee.of('decision', { who: 'user' }), '', 'other types address nobody');
  assert.equal(addressee.ofDuty(null), '');
});

test('yesno: yes / true / 1, no / false / 0, everything else is null (not a guess)', () => {
  for (const v of ['yes', 'YES', ' true ', '1']) assert.equal(yesNoValue(v), true, v);
  for (const v of ['no', 'False', ' 0 ']) assert.equal(yesNoValue(v), false, v);
  for (const v of ['', 'yse', 'on', 'off', 'ja', 'nein', undefined, null, 2]) assert.equal(yesNoValue(v), null, String(v));
});

// --- the judgement (pure) ----------------------------------------------------------------------------------------

test('judge: the rule applies on a stated route only, never by agent name; the human comes from the caller', () => {
  const d = duty({ who: 'user' });
  for (const route of cardrule.ROUTES) {
    const v = cardrule.judge('duty', d, { route, human: 'user' });
    assert.equal(v.applies, true, route);
    assert.equal(v.lacks, true, route);
    assert.equal(v.reject, false, 'stage 1 by default');
  }
  // an internal writer states no route: exempt, whatever it calls itself
  for (const route of [null, undefined, '', 'digest', 'internal']) {
    const v = cardrule.judge('duty', { ...d, agent: 'digest' }, { route, human: 'user' });
    assert.equal(v.applies, false, String(route));
  }
  // nobody is exempt by NAME: the agent field changes nothing on a free road
  for (const agent of ['digest', 'reflector', 'watcher', 'session']) {
    assert.equal(cardrule.judge('duty', { ...d, agent }, { route: 'cli', human: 'user' }).applies, true, agent);
  }
  // no human configured: nobody to protect, and the verdict says why
  const none = cardrule.judge('duty', d, { route: 'cli', human: null });
  assert.equal(none.applies, false);
  assert.match(none.why, /no human participant/);
  // positive control: a duty for an agent, a closing line, another type, a question without `who`
  assert.equal(cardrule.judge('duty', duty({ who: 'session' }), { route: 'cli', human: 'user' }).applies, false);
  assert.equal(cardrule.judge('duty', d, { route: 'cli', human: 'user', closing: true }).applies, false);
  assert.equal(cardrule.judge('decision', d, { route: 'cli', human: 'user' }).applies, false);
  assert.equal(cardrule.judge('question', { question: 'Which?' }, { route: 'cli', human: 'user' }).applies, false);
  assert.equal(cardrule.judge('question', { question: 'Which?', who: 'user' }, { route: 'cli', human: 'user' }).applies, true);
});

test('judge: who is read trimmed; owner and to count for a duty; the human name is trimmed too', () => {
  for (const f of ['who', 'owner', 'to']) {
    assert.equal(cardrule.judge('duty', duty({ [f]: ' user ' }), { route: 'cli', human: 'user' }).applies, true, f);
  }
  assert.equal(cardrule.judge('duty', duty({ who: 'user' }), { route: 'cli', human: ' user ' }).applies, true);
  assert.equal(cardrule.judge('duty', duty({ who: 'User' }), { route: 'cli', human: 'user' }).applies, false, 'names are compared exactly');
  // a question: `who` only
  assert.equal(cardrule.judge('question', { question: 'Q?', owner: 'user' }, { route: 'cli', human: 'user' }).applies, false);
});

test('judge: what counts as a card of its own; the explanation is "missing" as the card derives it', () => {
  const j = (extra) => cardrule.judge('duty', duty({ who: 'user', ...extra }), { route: 'cli', human: 'user' });
  const full = j(CARD);
  assert.deepEqual([full.has, full.lacks, full.reject], [true, false, false]);
  assert.deepEqual(cardrule.messages(full), [], 'a complete card leaves nothing to say');
  // positive control: the same card WITHOUT its context is still a card (the fallback card fills it; a warning, not a gap)
  const noContext = j({ card_question: CARD.card_question, card_options: CARD.card_options });
  assert.deepEqual([noContext.has, noContext.lacks], [true, false]);
  assert.ok(cardrule.messages(noContext).some((l) => /card_context missing/.test(l)));
  // nothing, a question alone, one option, two options without a No option
  for (const [name, extra] of [
    ['no card', {}],
    ['a question alone', { card_question: 'Which?' }],
    ['one option', { card_question: 'Which?', card_options: ['MIT — yes'] }],
    ['no decline option', { card_question: 'Which?', card_options: ['MIT — yes', 'GPL — also yes'] }],
    ['options without a question', { card_options: CARD.card_options }],
  ]) {
    const v = j(extra);
    assert.equal(v.has, false, name);
    assert.equal(v.lacks, true, name);
    assert.ok(v.gaps.length, name);
  }
  // a card that is complete but too long is NOT "explanation missing" (it is shown cut) - it says "not to the rules"
  const long = j({ ...CARD, card_question: `${'Is this a very long question? '.repeat(10)}?` });
  assert.deepEqual([long.has, long.lacks], [false, false]);
  assert.ok(cardrule.messages(long).some((l) => /Card not to the rules/.test(l)));
});

test('judge: output guard - a key in a card field is masked BEFORE the limits and the echo; no control or bidi character comes out', () => {
  const key = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
  const v = cardrule.judge('duty', duty({
    who: 'user', card_question: 'Which?', card_options: [`${key} — x`, `Not now ‮${key}`],
  }), { route: 'cli', human: 'user', env: { CHEAP_MEM_CARD_REJECT: 'yes' } });
  const text = [...cardrule.messages(v), ...v.gaps, ...v.warnings, v.fallbackQuestion ?? ''].join('\n');
  assert.ok(!text.includes(key), 'the key must not be echoed');
  assert.ok(!/[‪-‮⁦-⁩\u001b]/.test(text), 'no bidi or control character');
  // a token short enough to stand whole in the "names no effect" echo (40 characters): unmasked it would come out in the clear
  const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
  const t2 = cardrule.judge('duty', duty({ who: 'user', card_question: 'Which?', card_options: [token, 'No — b'] }), { route: 'cli', human: 'user' });
  const echo2 = [...cardrule.messages(t2), ...t2.warnings, ...t2.gaps].join('\n');
  assert.ok(!echo2.includes(token), 'the token must not be echoed');
  assert.match(echo2, /REDACTED/, 'positive control: the warning is there, with the mask in place of the token');
  const odd = cardrule.judge('duty', duty({ who: 'user' }), { route: 'cli', human: 'user', env: { CHEAP_MEM_CARD_REJECT: `ye‮s\u001b[31m${key}` } });
  const echoed = cardrule.messages(odd).join('\n');
  assert.ok(!echoed.includes(key));
  assert.ok(!/[‪-‮\u001b]/.test(echoed));
});

test('the switch: yes / true / 1 reject; no / false / 0 / empty / unset do not; anything else is stage 1 and is said ONCE per process', () => {
  const d = duty({ who: 'user' });
  const j = (value) => cardrule.judge('duty', d, { route: 'cli', human: 'user', env: value === undefined ? {} : { CHEAP_MEM_CARD_REJECT: value } });
  for (const v of ['yes', 'YES', 'true', '1', ' yes ']) assert.equal(j(v).reject, true, v);
  for (const v of [undefined, '', 'no', 'false', '0']) assert.equal(j(v).reject, false, String(v));
  assert.equal(cardrule.rejectOn({ CHEAP_MEM_CARD_REJECT: 'true' }), true);
  assert.equal(cardrule.rejectOn({}), false);
  const odd = `yse-${process.pid}`;
  const v = j(odd);
  assert.equal(v.reject, false, 'an unrecognised value is stage 1');
  assert.equal(v.unrecognised, odd);
  assert.ok(cardrule.messages(v).some((l) => l.includes(odd) && /not recognised/.test(l)), 'said the first time');
  assert.ok(!cardrule.messages(v).some((l) => /not recognised/.test(l)), 'not said again in this process');
  assert.ok(cardrule.messages(j('maybe')).some((l) => /not recognised/.test(l)), 'a different value is said again');
  // where the rule would not have bitten, nothing is said
  assert.deepEqual(cardrule.messages(cardrule.judge('duty', duty({ who: 'session' }), { route: 'cli', human: 'user', env: { CHEAP_MEM_CARD_REJECT: 'zzz' } })), []);
});

// --- the write core ------------------------------------------------------------------------------------------------

test('write core, stage 1: taken in, the verdict comes back, the entry shows as "explanation missing" when read (derived, no field)', (t) => {
  const root = world(t);
  const r = withSwitch(undefined, () => memory.logCheckedEntry(root, 'duty', duty({ who: 'user' }), { route: 'cli' }));
  assert.equal(r.card.applies, true);
  assert.equal(r.card.lacks, true);
  assert.equal(rows(root, 'duty').length, 1, 'taken in');
  assert.ok(!Object.keys(rows(root, 'duty')[0]).some((k) => /explanation|missing/i.test(k)), 'no field was stored for it');
  const listed = humandecisions.forHuman(root);
  assert.equal(listed.list.length, 1);
  assert.equal(decisioncard.lacksExplanation(listed.list[0].card), true, 'derived from the card stage');
  assert.match(today.asText(today.today(root)), /\[explanation missing\]/, 'mem today names it');
  assert.ok(cardrule.messages(r.card, { id: r.entry.id }).some((l) => l.includes(`mem card add ${r.entry.id}`)), 'the way to add it later is named');
});

test('write core: a complete card passes, is derived as an explanation that is NOT missing, and mem today does not flag it', (t) => {
  const root = world(t);
  const r = withSwitch('yes', () => memory.logCheckedEntry(root, 'duty', duty({ who: 'user', ...CARD }), { route: 'cli' }));
  assert.equal(r.card.has, true);
  const item = humandecisions.forHuman(root).list[0];
  assert.equal(item.card.origin.stage, 'written');
  assert.equal(decisioncard.lacksExplanation(item.card), false);
  assert.doesNotMatch(today.asText(today.today(root)), /explanation missing/);
});

test('write core: a half card (a question alone) stays "written" but its explanation is missing - options had to be filled in', (t) => {
  const root = world(t);
  const r = withSwitch(undefined, () => memory.logCheckedEntry(root, 'duty', duty({ who: 'user', card_question: 'Which licence?' }), { route: 'cli' }));
  assert.equal(r.card.has, false);
  const item = humandecisions.forHuman(root).list[0];
  assert.equal(item.card.origin.stage, 'written');
  assert.equal(decisioncard.lacksExplanation(item.card), true);
  assert.match(today.asText(today.today(root)), /explanation missing: the options are filled in/);
  // positive control: only the CONTEXT filled in does not count as missing
  const root2 = world(t);
  withSwitch(undefined, () => memory.logCheckedEntry(root2, 'duty', duty({ who: 'user', card_question: CARD.card_question, card_options: CARD.card_options }), { route: 'cli' }));
  assert.equal(decisioncard.lacksExplanation(humandecisions.forHuman(root2).list[0].card), false);
});

test('write core, stage 2: refused BEFORE anything is written, with the whole reason; the same for a question', (t) => {
  const root = world(t);
  for (const [type, data] of [['duty', duty({ who: 'user' })], ['question', { question: 'Which licence?', who: 'user' }]]) {
    const before = rows(root, type).length;
    let err;
    try { withSwitch('yes', () => memory.logCheckedEntry(root, type, data, { route: 'mcp' })); } catch (e) { err = e; }
    assert.ok(err, type);
    assert.equal(err.code, 'CARD_MISSING');
    assert.match(err.message, /Card missing: this (duty|question) goes to user/);
    assert.match(err.message, /card_question missing/);
    assert.match(err.message, /How it looks right: fields:/, 'the bridge example, not the CLI one');
    assert.match(err.message, /one of them No \/ not now/);
    assert.equal(rows(root, type).length, before, `${type}: nothing written`);
  }
  // positive controls: the same entry WITH its card is written under the switch; an agent's duty too
  withSwitch('yes', () => memory.logCheckedEntry(root, 'duty', duty({ who: 'user', ...CARD }), { route: 'cli' }));
  withSwitch('yes', () => memory.logCheckedEntry(root, 'duty', duty({ who: 'session' }), { route: 'cli' }));
  assert.equal(rows(root, 'duty').length, 2);
});

test('write core: NO route = exempt, even with the switch on - internal writers are never refused', (t) => {
  const root = world(t);
  withSwitch('yes', () => {
    memory.logCheckedEntry(root, 'duty', duty({ who: 'user' }));
    memory.logCheckedEntry(root, 'duty', duty({ who: 'user', agent: 'digest' }), {});
    memory.logEntry(root, 'duty', duty({ who: 'user' }));
  });
  assert.equal(rows(root, 'duty').length, 3);
  // a route that is not one of the known three is no route
  withSwitch('yes', () => memory.logCheckedEntry(root, 'duty', duty({ who: 'user' }), { route: 'internal' }));
  assert.equal(rows(root, 'duty').length, 4);
});

test('write core: the capture / digest writer is NO exception - it writes over the CLI, so the route is cli whatever it calls itself', (t) => {
  const root = world(t);
  for (const env of [{ MEM_HEADLESS: 'reflector' }, { MEM_HEADLESS: 'watcher' }, { CHEAP_MEM_AGENT: 'digest' }]) {
    const r = cli(root, ['log', 'duty', '--title', 'From a headless run', '--who', 'user'], { ...env, CHEAP_MEM_CARD_REJECT: 'yes' });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.match(r.stderr, /Card missing/, JSON.stringify(env));
  }
  assert.equal(rows(root, 'duty').length, 0);
});

test('the routes are pinned: only the CLI `log` / `correction` / `restore` / `questions new` and the bridge `mem_log` state one', () => {
  const files = execFileSync('git', ['ls-files', '-z', 'src', 'bin'], { cwd: REPO, encoding: 'utf8' }).split('\0')
    .filter((f) => /\.(mjs)$/.test(f) || /^bin\/[^.]+$/.test(f));
  const stating = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const m of text.matchAll(/route:\s*'([a-z]+)'/g)) if (cardrule.ROUTES.includes(m[1])) stating.push(`${f}:${m[1]}`);
  }
  const counted = {};
  for (const s of stating) counted[s] = (counted[s] ?? 0) + 1;
  assert.deepEqual(counted, {
    'bin/mem-mcp:mcp': 1,
    'src/cli/commands/agents.mjs:cli': 1,
    'src/cli/commands/write.mjs:cli': 3,
  }, 'a new free input road must state its route on purpose; an internal writer must not');
});

// --- correction and restore ---------------------------------------------------------------------------------------

test('correction: SETTING who to the human is a new duty to him (rule applies); an inherited complete card passes; an addressee that stood there is old stock', (t) => {
  const root = world(t);
  const agentDuty = memory.logEntry(root, 'duty', duty({ who: 'session' })).entry;
  // sets who to the human, no card: stage 1 takes it in and says so
  const c1 = withSwitch(undefined, () => memory.correctionEntry(root, 'duty', agentDuty.id, { who: 'user' }, { route: 'cli' }));
  assert.equal(c1.card.applies, true);
  assert.equal(c1.card.lacks, true);
  // under stage 2: refused, nothing written
  const before = rows(root, 'duty').length;
  assert.throws(() => withSwitch('yes', () => memory.correctionEntry(root, 'duty', agentDuty.id, { who: 'user' }, { route: 'cli' })), (e) => e.code === 'CARD_MISSING');
  assert.equal(rows(root, 'duty').length, before);
  // the card named in the correction passes
  const c2 = withSwitch('yes', () => memory.correctionEntry(root, 'duty', agentDuty.id, { who: 'user', ...CARD }, { route: 'cli' }));
  assert.equal(c2.card.has, true);

  // a complete card INHERITED from the predecessor makes the correction admissible (the human takes over from an agent with a card)
  const carded = memory.logEntry(root, 'duty', duty({ who: 'session', ...CARD })).entry;
  const c3 = withSwitch('yes', () => memory.correctionEntry(root, 'duty', carded.id, { who: 'user' }, { route: 'cli' }));
  assert.equal(c3.card.has, true, 'inherited');
  // old stock: the human already was the addressee - a correction of something else is not checked
  const legacy = memory.logEntry(root, 'duty', duty({ who: 'user', title: 'Old stock' })).entry;
  const c4 = withSwitch('yes', () => memory.correctionEntry(root, 'duty', legacy.id, { text: 'More words.' }, { route: 'cli' }));
  assert.equal(c4.card.applies, false);
  // a CLOSING correction is no new duty
  const c5 = withSwitch('yes', () => memory.correctionEntry(root, 'duty', agentDuty.id, { who: 'user', state: 'discarded', why: 'not needed' }, { route: 'cli' }));
  assert.equal(c5.card.applies, false);
  // no route: exempt
  const c6 = withSwitch('yes', () => memory.correctionEntry(root, 'duty', carded.id, { who: 'user', title: 'No route' }));
  assert.equal(c6.card.applies, false);
});

test('restore: a reopened duty to the human is a new one - the card copied with it counts; none = the rule', (t) => {
  const root = world(t);
  const old = memory.logEntry(root, 'duty', duty({ who: 'user' })).entry; // old stock without a card
  memory.retireEntry(root, 'duty', old.id, { state: 'discarded', why: 'not needed' });
  const before = rows(root, 'duty').length;
  assert.throws(() => withSwitch('yes', () => entryops.restore(root, old.id, { route: 'cli' })), (e) => e.code === 'CARD_MISSING');
  assert.equal(rows(root, 'duty').length, before, 'nothing written');
  const soft = withSwitch(undefined, () => entryops.restore(root, old.id, { route: 'cli' }));
  assert.equal(soft.card.lacks, true, 'stage 1: taken in, said');
  // without a route: exempt
  const old2 = memory.logEntry(root, 'duty', duty({ who: 'user', title: 'Second' })).entry;
  memory.retireEntry(root, 'duty', old2.id, { state: 'discarded', why: 'not needed' });
  assert.equal(withSwitch('yes', () => entryops.restore(root, old2.id)).card.applies, false);
  // positive control: a duty WITH its card on the entry is restored under the switch (the card is copied)
  const carded = memory.logEntry(root, 'duty', duty({ who: 'user', title: 'Third', ...CARD })).entry;
  memory.retireEntry(root, 'duty', carded.id, { state: 'discarded', why: 'not needed' });
  const r = withSwitch('yes', () => entryops.restore(root, carded.id, { route: 'cli' }));
  assert.equal(r.card.has, true);
});

// --- the real roads (CLI and bridge) -------------------------------------------------------------------------------

test('CLI: stage 1 warns on stderr and takes the entry in; the card flags may repeat; stage 2 exits non-zero with the whole reason', (t) => {
  const root = world(t);
  const soft = cli(root, ['log', 'duty', '--title', 'Pick a licence', '--who', 'user']);
  assert.equal(soft.status, 0);
  assert.match(soft.stderr, /Explanation missing: this duty goes to user/);
  assert.match(soft.stderr, /Better right away: mem log duty/);
  assert.match(soft.stderr, /mem card add [a-z0-9]+/);
  assert.doesNotMatch(soft.stdout, /Explanation missing/, 'the warning is on stderr');
  assert.equal(rows(root, 'duty').length, 1);

  const carded = cli(root, ['log', 'duty', '--title', 'Pick again', '--who', 'user', '--card_question', 'Which licence?',
    '--card_context', 'Two files disagree.', '--card_options', 'MIT — as in LICENSE', '--card_options', 'Not now — nothing changes']);
  assert.equal(carded.status, 0, carded.stderr);
  assert.doesNotMatch(carded.stderr, /Explanation missing|Card missing/);
  const line = rows(root, 'duty').find((d) => d.title === 'Pick again');
  assert.deepEqual(line.card_options, ['MIT — as in LICENSE', 'Not now — nothing changes'], 'a repeated flag is a list');

  const hard = cli(root, ['log', 'duty', '--title', 'Pick three', '--who', ' user '], { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.notEqual(hard.status, 0);
  assert.match(hard.stderr, /Card missing: this duty goes to user/);
  assert.match(hard.stderr, /How it looks right: mem log duty/);
  assert.match(hard.stderr, /Nothing was written/);
  assert.equal(rows(root, 'duty').length, 2, 'refused: nothing more written');

  // positive control: an agent's duty is untouched under the switch
  assert.equal(cli(root, ['log', 'duty', '--title', 'For an agent', '--who', 'session'], { CHEAP_MEM_CARD_REJECT: 'yes' }).status, 0);
});

test('CLI: mem correction and mem restore run through the rule on the route cli', (t) => {
  const root = world(t);
  const a = memory.logEntry(root, 'duty', duty({ who: 'session' })).entry;
  const c = cli(root, ['correction', 'duty', a.id, '--who', 'user'], { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /Card missing/);
  const ok = cli(root, ['correction', 'duty', a.id, '--who', 'user', '--card_question', 'Which?', '--card_options', 'Yes — a', '--card_options', 'No — b'],
    { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.equal(ok.status, 0, ok.stderr);
  const old = memory.logEntry(root, 'duty', duty({ who: 'user', title: 'Old stock' })).entry;
  memory.retireEntry(root, 'duty', old.id, { state: 'discarded', why: 'not needed' });
  const r = cli(root, ['restore', old.id], { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Card missing/);
  const soft = cli(root, ['restore', old.id]);
  assert.equal(soft.status, 0, soft.stderr);
  assert.match(soft.stderr, /Explanation missing/);
});

test('CLI: mem questions new is a free input road too - a question for the human brings its card, or is flagged / refused', (t) => {
  const root = world(t);
  const soft = cli(root, ['questions', 'new', 'Which licence?', '--who', 'user']);
  assert.equal(soft.status, 0, soft.stderr);
  assert.match(soft.stderr, /Explanation missing: this question goes to user/);
  assert.equal(rows(root, 'question').length, 1);
  const hard = cli(root, ['questions', 'new', 'Another one?', '--who', 'user'], { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.notEqual(hard.status, 0);
  assert.match(hard.stderr, /Card missing: this question goes to user/);
  assert.match(hard.stderr, /Nothing was written/);
  assert.equal(rows(root, 'question').length, 1);
  const ok = cli(root, ['questions', 'new', 'Third one?', '--who', 'user', '--card_question', 'Third?', '--card_options', 'Yes — a', '--card_options', 'No — b'],
    { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(rows(root, 'question').find((q) => q.question === 'Third one?').card_options, ['Yes — a', 'No — b']);
  // positive control: a question for nobody, and one for an agent, are not touched
  assert.equal(cli(root, ['questions', 'new', 'For nobody?'], { CHEAP_MEM_CARD_REJECT: 'yes' }).status, 0);
  assert.equal(cli(root, ['questions', 'new', 'For an agent?', '--who', 'session'], { CHEAP_MEM_CARD_REJECT: 'yes' }).status, 0);
  // the checked write path redacts: a key in the question does not reach the disk in the clear
  const key = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
  assert.equal(cli(root, ['questions', 'new', `Is ${key} still valid?`]).status, 0);
  assert.ok(!fs.readFileSync(path.join(root, 'global', 'questions.jsonl'), 'utf8').includes(key));
});

test('bridge: mem_log says "Explanation missing" in the answer (stage 1) and refuses with the whole reason (stage 2); internal tools are untouched', (t) => {
  const root = world(t);
  const [soft] = bridge(root, [['mem_log', { type: 'duty', title: 'Pick a licence', who: 'user' }]]);
  assert.notEqual(soft.isError, true, textOf(soft));
  assert.match(textOf(soft), /Explanation missing: this duty goes to user/);
  assert.match(textOf(soft), /Better right away: fields:/);
  assert.equal(rows(root, 'duty').length, 1);

  const [hard] = bridge(root, [['mem_log', { type: 'question', question: 'Which licence?', who: 'user' }]], { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.equal(hard.isError, true);
  assert.match(textOf(hard), /Card missing: this question goes to user/);
  assert.match(textOf(hard), /How it looks right: fields:/);
  assert.match(textOf(hard), /Nothing was written/);
  assert.equal(rows(root, 'question').length, 0);

  const [ok, agent] = bridge(root, [
    ['mem_log', { type: 'duty', title: 'Carded', who: 'user', card_question: 'Which?', card_options: ['Yes — a', 'No — b'] }],
    ['mem_log', { type: 'duty', title: 'For an agent', who: 'session' }],
  ], { CHEAP_MEM_CARD_REJECT: 'yes' });
  assert.notEqual(ok.isError, true, textOf(ok));
  assert.notEqual(agent.isError, true, textOf(agent));
  // a bridge caller cannot slip the card in as an array of the wrong shape
  const [bad] = bridge(root, [['mem_log', { type: 'duty', title: 'Odd', who: 'user', card_options: { a: 1 } }]]);
  assert.equal(bad.isError, true);
});

// --- surfaces name the card ---------------------------------------------------------------------------------------

test('the surfaces name the card fields, the addressee and the switch: mem log --help, the mem_log tool, the house rules', () => {
  const help = spawnSync(process.execPath, [MEM, 'log', '--help'], { encoding: 'utf8' }).stdout;
  for (const w of ['card_question', 'card_context', 'card_options', 'CHEAP_MEM_CARD_REJECT', 'explanation missing']) assert.ok(help.includes(w), `mem log --help: ${w}`);
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const mem = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'cm-cardrule-tools-'));
  try {
    fs.mkdirSync(path.join(mem, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(mem, '.mem/config.json'), JSON.stringify({ version: 1 }));
    const r = spawnSync(process.execPath, [MCP], { input: `${init}\n${list}\n`, encoding: 'utf8', timeout: 30000, env: { ...process.env, CHEAP_MEM_ROOT: mem } });
    const tools = JSON.parse(r.stdout.split('\n').filter((z) => z.trim())[1]).result.tools;
    const log = tools.find((x) => x.name === 'mem_log');
    for (const w of ['card_question', 'card_context', 'card_options', 'CHEAP_MEM_CARD_REJECT', 'Explanation missing']) assert.ok(log.description.includes(w), `mem_log: ${w}`);
    for (const p of ['who', 'card_question', 'card_context', 'card_options', 'card_advice', 'card_evidence']) assert.ok(log.inputSchema.properties[p], `mem_log property ${p}`);
  } finally { fs.rmSync(mem, { recursive: true, force: true }); }
  const rules = fs.readFileSync(path.join(REPO, 'HOUSE-RULES.md'), 'utf8');
  for (const w of ['card_question', 'card_options', 'explanation', 'who']) assert.ok(rules.includes(w), `HOUSE-RULES.md: ${w}`);
});

test('the shared card cases are not touched by this build (sha256 fixed)', () => {
  const sha = execFileSync('sha256sum', [path.join(REPO, 'shared', 'entscheidungskarten.jsonl')], { encoding: 'utf8' }).split(' ')[0];
  assert.match(sha, /^37da67a8.*1ec3$/);
});
