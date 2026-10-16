// `--as-me` (the writer is this install's own identity) and the card's byline (author NAME and RANK, port of lucky-mem
// `--ich`, F1b, and `verfasserVon`, Lucky decision 2026-10-14).
//
// The finding behind both: a write without `--agent` is stamped `memory.agentDefault()`, and without CHEAP_MEM_AGENT that is
// `human:<os user>` - a name that reads as a person (`authority.isHumanName`) on a line an agent may have written. And a card
// was "by a person" by that NAME alone, so such a line suppressed the note "written by an agent, not checked by you".
//
// Red proof against the base (origin/kette/cm 04ca129, own worktree, no stash): every `--as-me` probe is red there (the switch
// became a field `as-me: true` and the writer stayed `human:<user>`), and the byline probes are red (no `byline`, `by_human`
// by name). Positive controls: the probe without the switch really sees the OS account name, so a green run is not blind.
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
import * as authority from '../src/authority.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const OS_ACCOUNT = 'osperson';

/** The CLI with a CONTROLLED identity: no CHEAP_MEM_AGENT unless given, the OS account is `osperson`. */
function cli(root, args, env = {}) {
  const e = { ...process.env, USER: OS_ACCOUNT, LOGNAME: OS_ACCOUNT, USERNAME: OS_ACCOUNT };
  for (const k of ['CHEAP_MEM_AGENT', 'MEM_AGENT', 'MEM_HEADLESS', 'CHEAP_MEM_MAX_AUTHORITY', 'CHEAP_MEM_ROOT']) delete e[k];
  Object.assign(e, env);
  return spawnSync(process.execPath, [MEM, ...args, '--root', root], { encoding: 'utf8', input: '', timeout: 60000, env: e });
}

function world(t, whoami = null) {
  const root = tempDir('cm-asme-', t);
  const r = cli(root, ['init', '--participants', 'anna,builder', '--human', 'anna']);
  assert.equal(r.status, 0, r.stderr);
  if (whoami) {
    const w = cli(root, ['whoami', whoami]);
    assert.equal(w.status, 0, w.stderr);
  }
  return root;
}

const lines = (root, rel) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((z) => JSON.parse(z)) : [];
};
const last = (root, rel) => lines(root, rel).at(-1);
const rawBytes = (root, rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel)) : Buffer.alloc(0));

// --- inventory pin: what stamped the writer before ---------------------------------------------------------------------------

test('positive control: without the switch the writer is the OS account (human:<user>) - the probes below can see the difference', (t) => {
  const root = world(t, 'builder');
  const r = cli(root, ['log', 'thought', '--text', 'no switch']);
  assert.equal(r.status, 0, r.stderr);
  const z = last(root, 'global/thoughts.jsonl');
  assert.equal(z.agent, `human:${OS_ACCOUNT}`);
  assert.equal(authority.isHumanName(z.agent), true, 'that is exactly the name that reads as a person');
});

// --- mem log --as-me -----------------------------------------------------------------------------------------------------------

test('mem log --as-me stamps this install (mem whoami), not the OS account; the tier stays agent', (t) => {
  const root = world(t, 'builder');
  const r = cli(root, ['log', 'thought', '--text', 'by the install', '--as-me']);
  assert.equal(r.status, 0, r.stderr);
  const z = last(root, 'global/thoughts.jsonl');
  assert.equal(z.agent, 'builder');
  assert.equal(z.authority, 'agent');
  assert.ok(!('as-me' in z), 'the switch is not a field of the entry');
});

test('mem log --as-me: CHEAP_MEM_AGENT (a process) outranks the stored whoami, like the bridge', (t) => {
  const root = world(t, 'builder');
  const r = cli(root, ['log', 'thought', '--text', 'env wins', '--as-me'], { CHEAP_MEM_AGENT: 'ci-runner' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(last(root, 'global/thoughts.jsonl').agent, 'ci-runner');
});

test('mem log --as-me without any identity is refused and writes nothing - the OS account is never the fallback', (t) => {
  const root = world(t);
  const before = rawBytes(root, 'global/thoughts.jsonl');
  const r = cli(root, ['log', 'thought', '--text', 'nobody', '--as-me']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no identity/);
  assert.match(r.stderr, /mem whoami/);
  assert.ok(!r.stderr.includes(OS_ACCOUNT), 'the OS account name is not offered as an identity');
  assert.deepEqual(rawBytes(root, 'global/thoughts.jsonl'), before);
});

test('mem log --as-me: the stored name in its three bad states (blank, not a participant) is refused, nothing written', (t) => {
  const root = world(t);
  const file = path.join(root, '.mem', 'inbox-whoami');
  const before = rawBytes(root, 'global/thoughts.jsonl');
  fs.writeFileSync(file, '   \n');
  const blank = cli(root, ['log', 'thought', '--text', 'blank', '--as-me']);
  assert.notEqual(blank.status, 0);
  assert.match(blank.stderr, /no identity/, 'a blank file is "not set", not a name');
  fs.writeFileSync(file, 'ghost\n');
  const broken = cli(root, ['log', 'thought', '--text', 'ghost', '--as-me']);
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /ghost.*not a configured participant/s);
  assert.deepEqual(rawBytes(root, 'global/thoughts.jsonl'), before);
});

test('mem log --as-me refuses a name that reads as a person (owner, human:<name>), nothing written', (t) => {
  const root = world(t, 'builder');
  const before = rawBytes(root, 'global/thoughts.jsonl');
  for (const name of ['human:alex', 'owner']) {
    const r = cli(root, ['log', 'thought', '--text', 'a person?', '--as-me'], { CHEAP_MEM_AGENT: name });
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /reads as a person/, name);
  }
  assert.deepEqual(rawBytes(root, 'global/thoughts.jsonl'), before);
});

test('mem log --as-me never raises a rank: --authority and --agent do not combine with it; the human participant gets tier agent', (t) => {
  const root = world(t, 'anna'); // anna IS the configured human participant
  const before = rawBytes(root, 'global/thoughts.jsonl');
  const claim = cli(root, ['log', 'thought', '--text', 'claim', '--authority', 'user', '--as-me']);
  assert.notEqual(claim.status, 0);
  assert.match(claim.stderr, /carries no rank/);
  const two = cli(root, ['log', 'thought', '--text', 'two', '--agent', 'someone', '--as-me']);
  assert.notEqual(two.status, 0);
  assert.match(two.stderr, /two writers/);
  assert.deepEqual(rawBytes(root, 'global/thoughts.jsonl'), before);
  const ok = cli(root, ['log', 'thought', '--text', 'as the human participant', '--as-me']);
  assert.equal(ok.status, 0, ok.stderr);
  const z = last(root, 'global/thoughts.jsonl');
  assert.equal(z.agent, 'anna');
  assert.equal(z.authority, 'agent', 'the name is a participant\'s; the rank is not hers to take');
});

test('mem log --as-me under a process ceiling: the tier is still lowered to the ceiling, not raised', (t) => {
  const root = world(t, 'builder');
  const r = cli(root, ['log', 'thought', '--text', 'capped', '--as-me'], { CHEAP_MEM_MAX_AUTHORITY: 'inferred' });
  assert.equal(r.status, 0, r.stderr);
  const z = last(root, 'global/thoughts.jsonl');
  assert.equal(z.agent, 'builder');
  assert.equal(authority.rank(z.authority) >= authority.rank('inferred'), true, `tier ${z.authority} is not above the ceiling`);
});

test('mem log without the switch is unchanged (CHEAP_MEM_AGENT, --agent), and old lines stay byte for byte (append-only)', (t) => {
  const root = world(t, 'builder');
  assert.equal(cli(root, ['log', 'thought', '--text', 'first', '--as-me']).status, 0);
  const before = rawBytes(root, 'global/thoughts.jsonl');
  const env = cli(root, ['log', 'thought', '--text', 'env'], { CHEAP_MEM_AGENT: 'from-env' });
  assert.equal(env.status, 0, env.stderr);
  assert.equal(last(root, 'global/thoughts.jsonl').agent, 'from-env');
  const flag = cli(root, ['log', 'thought', '--text', 'flag', '--agent', 'from-flag']);
  assert.equal(flag.status, 0, flag.stderr);
  assert.equal(last(root, 'global/thoughts.jsonl').agent, 'from-flag');
  const after = rawBytes(root, 'global/thoughts.jsonl');
  assert.deepEqual(after.subarray(0, before.length), before, 'the earlier bytes are untouched');
});

test('mem log procedure --as-me: the procedure latch sees the install\'s name as the writer, and a human issuer stays a separate field', (t) => {
  const root = world(t, 'builder');
  const r = cli(root, ['log', 'procedure', '--title', 'Check twice', '--rule', 'Check twice before pushing.', '--issued-by', 'owner', '--as-me']);
  assert.equal(r.status, 0, r.stderr);
  const z = last(root, 'global/procedures.jsonl');
  assert.equal(z.agent, 'builder');
  assert.equal(z.issued_by, 'owner');
});

// --- mem correction --as-me ----------------------------------------------------------------------------------------------------

test('mem correction --as-me stamps the correcting writer; the corrected line keeps standing', (t) => {
  const root = world(t, 'builder');
  assert.equal(cli(root, ['log', 'decision', '--topic', 'colour', '--choice', 'red', '--why', 'because'], { CHEAP_MEM_AGENT: 'first' }).status, 0);
  const old = last(root, 'global/decisions.jsonl');
  const before = rawBytes(root, 'global/decisions.jsonl');
  const r = cli(root, ['correction', 'decision', old.id, '--choice', 'blue', '--as-me']);
  assert.equal(r.status, 0, r.stderr);
  const z = last(root, 'global/decisions.jsonl');
  assert.equal(z.replaces_id, old.id);
  assert.equal(z.agent, 'builder');
  assert.equal(z.authority, 'agent');
  assert.deepEqual(rawBytes(root, 'global/decisions.jsonl').subarray(0, before.length), before);
  const bad = cli(root, ['correction', 'decision', z.id, '--choice', 'green', '--as-me', '--authority', 'user']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /carries no rank/);
});

// --- mem sources add / bridge --as-me ------------------------------------------------------------------------------------------

test('mem sources add and bridge --as-me stamp the install; without it the OS account stays (unchanged)', (t) => {
  const root = world(t, 'builder');
  const plain = cli(root, ['sources', 'add', 'https://example.org/plain']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(last(root, 'global/sources.jsonl').agent, `human:${OS_ACCOUNT}`);
  const mine = cli(root, ['sources', 'add', 'https://example.org/mine', '--as-me']);
  assert.equal(mine.status, 0, mine.stderr);
  assert.equal(last(root, 'global/sources.jsonl').agent, 'builder');
  const br = cli(root, ['sources', 'bridge', 'repo://x/y', '--tool', 'inspect_symbol', '--as-me']);
  assert.equal(br.status, 0, br.stderr);
  assert.equal(last(root, 'global/sources.jsonl').agent, 'builder');
});

test('mem sources add --as-me <address>: the parser would swallow the address - refused, address not echoed, nothing written', (t) => {
  const root = world(t, 'builder');
  const before = rawBytes(root, 'global/sources.jsonl');
  const r = cli(root, ['sources', 'add', '--as-me', 'https://example.org/secret-looking-token-123']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /switch without a value/);
  assert.ok(!r.stderr.includes('secret-looking-token-123'));
  assert.deepEqual(rawBytes(root, 'global/sources.jsonl'), before);
});

test('mem sources add --as-me with no identity is refused, nothing written', (t) => {
  const root = world(t);
  const r = cli(root, ['sources', 'add', 'https://example.org/none', '--as-me']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no identity/);
  assert.equal(lines(root, 'global/sources.jsonl').length, 0);
});

// --- mem card add --as-me ------------------------------------------------------------------------------------------------------

test('mem card add --as-me: the card is by the install, tier agent, and its byline is NOT a person\'s - even for the human participant', (t) => {
  const root = world(t, 'anna');
  assert.equal(cli(root, ['log', 'duty', '--title', 'Decide', '--who', 'anna', '--agent', 'orch', '--card_question', 'Go?', '--card_options', 'Yes — go', '--card_options', 'No — stay']).status, 0);
  const duty = last(root, 'global/duties.jsonl');
  const r = cli(root, ['card', 'add', duty.id, '--question', 'Which way?', '--context', 'Now.', '--option', 'Left — west', '--option', 'No — stay', '--as-me']);
  assert.equal(r.status, 0, r.stderr);
  const z = last(root, 'global/cards.jsonl');
  assert.equal(z.agent, 'anna');
  assert.equal(z.authority, 'agent');
  const shelf = cardstore.readCards(root);
  const card = decisioncard.cardOf(duty, { type: 'duty', context: { cards: shelf.cards, human: 'anna' } });
  assert.equal(card.byline.text, 'anna (agent)');
  assert.equal(card.byline.by_human, false, 'the name of the configured human participant does not make an agent-tier card a person\'s');
  assert.equal(card.origin.by_human, false);
  const claim = cli(root, ['card', 'add', duty.id, '--question', 'Again?', '--context', 'Now.', '--option', 'Yes — a', '--option', 'No — b', '--as-me', '--authority', 'user']);
  assert.notEqual(claim.status, 0);
});

// --- the bridge: same semantics, no new surface --------------------------------------------------------------------------------

test('MCP bridge: writes carry the connected identity, there is no per-call writer parameter, and a tier `user` never lands', (t) => {
  const root = world(t, 'anna');
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mem_log', arguments: { type: 'thought', text: 'via bridge', agent: 'anna' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mem_log', arguments: { type: 'thought', text: 'claims user', authority: 'user' } } },
  ];
  const env = { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'bridge-agent', USER: OS_ACCOUNT };
  for (const k of ['CHEAP_MEM_MAX_AUTHORITY', 'MEM_HEADLESS']) delete env[k];
  const r = spawnSync(process.execPath, [MCP], { input: `${msgs.map((m) => JSON.stringify(m)).join('\n')}\n`, encoding: 'utf8', timeout: 60000, env });
  const replies = String(r.stdout).split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  const tools = replies.find((x) => x.id === 2).result.tools;
  const writers = tools.filter((x) => /^mem_(log|card_add|answer|duty_close)$/.test(x.name));
  assert.ok(writers.length >= 3, 'the write tools exist');
  for (const w of writers) {
    const props = Object.keys(w.inputSchema?.properties ?? {});
    assert.ok(!props.some((p) => /^(as_me|as-me|ich|agent|writer|author)$/.test(p)), `${w.name} takes no writer parameter (${props.join(', ')})`);
  }
  const z = last(root, 'global/thoughts.jsonl');
  assert.equal(z.agent, 'bridge-agent', 'a writer field in the call does not override the bridge identity');
  assert.equal(z.authority, 'agent');
  const claim = replies.find((x) => x.id === 4);
  const claimText = JSON.stringify(claim);
  assert.ok(claim.result?.isError || claim.error || /clamp|agent/.test(claimText), claimText);
  assert.ok(!lines(root, 'global/thoughts.jsonl').some((l) => l.authority === 'user'), 'no line of tier user came over the bridge');
});

// --- the card's byline: name AND rank ------------------------------------------------------------------------------------------

const TS = '2026-10-10T00:00:00Z';
const entry = (extra = {}) => ({ id: 'abc123def456', ts: TS, agent: 'builder-x', authority: 'agent', card_question: 'Which one?', card_options: ['A — a', 'No — b'], ...extra });
const cardOf = (e, context = {}) => decisioncard.cardOf(e, { type: 'duty', context });

test('byline: name AND rank in one text; origin.by_human is the same flag', () => {
  const k = cardOf(entry());
  assert.deepEqual(k.byline, { name: 'builder-x', rank: 'agent', rank_state: 'set', text: 'builder-x (agent)', by_human: false });
  assert.equal(k.origin.by_human, k.byline.by_human);
});

test('byline: the NAME alone never makes a card a person\'s (human:<user>, owner, the configured human at tier agent)', () => {
  for (const agent of ['human:alex', 'owner', 'anna']) {
    const k = cardOf(entry({ agent }), { human: 'anna' });
    assert.equal(k.byline.by_human, false, agent);
    assert.equal(k.origin.by_human, false, agent);
  }
});

test('byline: the RANK user makes it a person\'s, and the name stays shown', () => {
  const k = cardOf(entry({ agent: 'human:alex', authority: 'user' }));
  assert.equal(k.byline.by_human, true);
  assert.equal(k.byline.text, 'human:alex (user)');
  assert.equal(cardOf(entry({ agent: 'anna', authority: 'user' })).byline.by_human, true);
  assert.equal(cardOf(entry({ agent: undefined, authority: 'user' })).byline.by_human, false, 'a rank without a name is not a person either');
});

test('byline: a rank the line does not carry is missing / empty / broken - never an invented tier (old lines stay readable)', () => {
  const missing = cardOf(entry({ authority: undefined }));
  assert.deepEqual(missing.byline, { name: 'builder-x', rank: null, rank_state: 'missing', text: 'builder-x (rank unknown)', by_human: false });
  assert.equal(cardOf(entry({ authority: '  ' })).byline.rank_state, 'empty');
  const broken = cardOf(entry({ authority: 'emperor' }));
  assert.equal(broken.byline.rank_state, 'broken');
  assert.equal(broken.byline.rank, null);
  assert.equal(broken.byline.by_human, false);
  assert.equal(authority.tierState({ authority: 7 }).state, 'broken');
  assert.deepEqual(authority.tierState({}), { tier: null, state: 'missing' });
  // the old reading for decisions is unchanged: all three still rank as `unknown`
  assert.equal(authority.tierOf({}), 'unknown');
  assert.equal(missing.origin.rank, 'unknown');
});

test('byline: a card from the shelf (addendum) keeps the three states through cardstore', (t) => {
  const root = world(t);
  const shelf = path.join(root, 'global', 'cards.jsonl');
  const base = { target_id: 'abc123def456', ts: '2026-10-11T00:00:00Z', card_question: 'Shelf?', card_options: ['A — a', 'No — b'], agent: 'orch' };
  const rows = [
    { ...base, id: 'c1', authority: 'agent' },
  ];
  fs.mkdirSync(path.dirname(shelf), { recursive: true });
  fs.writeFileSync(shelf, rows.map((z) => `${JSON.stringify(z)}\n`).join(''));
  const e = entry({ card_question: undefined, card_options: undefined });
  let k = cardOf(e, { cards: cardstore.readCards(root).cards });
  assert.equal(k.origin.stage, 'addendum');
  assert.equal(k.byline.text, 'orch (agent)');
  fs.writeFileSync(shelf, `${JSON.stringify({ ...base, id: 'c2' })}\n`);
  k = cardOf(e, { cards: cardstore.readCards(root).cards });
  assert.equal(k.byline.rank_state, 'missing', 'a shelf line without a tier is "missing", not "unknown" made up');
  assert.equal(k.byline.text, 'orch (rank unknown)');
  fs.writeFileSync(shelf, `${JSON.stringify({ ...base, id: 'c3', authority: 'user', agent: 'human:alex' })}\n`);
  k = cardOf(e, { cards: cardstore.readCards(root).cards });
  assert.equal(k.byline.by_human, true);
});

test('byline: a replacement card has no author - everything null, not a person\'s', () => {
  const k = decisioncard.cardOf({ id: 'e2', title: 'T' }, { type: 'duty', context: { human: 'anna' } });
  assert.deepEqual(k.byline, { name: null, rank: null, rank_state: null, text: null, by_human: false });
  assert.equal(k.origin.by_human, undefined, 'the origin of a replacement card stays without a flag, as before');
});

test('byline: the name is cleaned and masked like every author (no control characters on the display)', () => {
  const k = cardOf(entry({ agent: 'bad\u001b[2Jname' }));
  assert.ok(!/[\u0000-\u001f]/.test(k.byline.text), JSON.stringify(k.byline.text));
  assert.equal(k.byline.name, k.origin.author);
});

// --- the display of a card in `mem today` ---------------------------------------------------------------------------------------

test('mem today shows name and tier; a missing tier reads "unknown (missing)" (CLI)', (t) => {
  const root = world(t, 'builder');
  const duty = { id: 'dm0000abcdef', ts: TS, title: 'Old stock', who: 'anna', agent: 'orch', card_question: 'Old?', card_options: ['A — a', 'No — b'] };
  fs.appendFileSync(path.join(root, 'global', 'duties.jsonl'), `${JSON.stringify(duty)}\n`);
  const r = cli(root, ['today']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /by orch, tier unknown \(missing\)/);
});

test('memory.agentDefault is untouched: the OS account still reads human:<user> without CHEAP_MEM_AGENT', () => {
  assert.equal(memory.agentDefault({ USER: 'someone' }), 'human:someone');
  assert.equal(memory.agentDefault({ CHEAP_MEM_AGENT: 'x', USER: 'someone' }), 'x');
});
