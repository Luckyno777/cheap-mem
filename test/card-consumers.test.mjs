// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/card-consumers.test.mjs — H11 (card-core-cm): where the card is read. `today` (the human's decisions and the projects
// that wait), the dashboard data of BOTH builds (the full one and the compact one), the closing report, and the addressee `who`
// of a question.
//
// Ported from the sibling's cross-check of its consumers (2026-10-13): cards only for items a person is meant to look at (the
// human's and the unassigned ones, never agent work), at most 200 per list with the rest COUNTED, a shelf that cannot be read
// says so (fallback cards, never "no cards"), broken and unusable lines stand in the reasons, a refresh does not drop an
// addendum back to the fallback card.
//
// Red proof: before this build no item carried a `card` and no question carried `who` (every assertion on them fails).
// Positive controls: the first items carry their card, the unassigned ones belong to the carded; an agent's duty carries none;
// a clean shelf reports 0 broken and no reason.
//
// invariant: nicht-messbar-ist-nicht-null
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as today from '../src/today.mjs';
import * as cardstore from '../src/cardstore.mjs';
import * as cardfeed from '../src/cardfeed.mjs';
import * as question from '../src/question.mjs';
import * as closingreport from '../src/closingreport.mjs';
import * as data from '../src/dashboard-data.mjs';
import * as compact from '../src/dashboard-compact.mjs';

delete process.env.MEM_HEADLESS;
delete process.env.CHEAP_MEM_MAX_AUTHORITY;
delete process.env.CHEAP_MEM_AGENT;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const NOW = new Date('2026-10-13T12:00:00Z');

const cli = (root, args, env = {}) => spawnSync(process.execPath, [MEM, ...args, '--root', root], {
  encoding: 'utf8', input: '', timeout: 40000, env: { ...process.env, CHEAP_MEM_AGENT: 'builder-x', ...env },
});

/** A store with the default participants: `user` (the human), `session`, `librarian`. */
function world(t, { human = 0, agent = 0, unassigned = 0, questions = 0 } = {}) {
  const root = tempDir('cm-cardc-', t);
  assert.equal(cli(root, ['init']).status, 0);
  const lines = [];
  for (let i = 0; i < human; i += 1) lines.push({ id: `ph${String(i).padStart(4, '0')}`, ts: '2026-10-01T00:00:00Z', title: `Task for the human number ${i}`, text: 'One sentence of background. Another sentence.', who: 'user' });
  for (let i = 0; i < agent; i += 1) lines.push({ id: `pa${String(i).padStart(4, '0')}`, ts: '2026-10-01T00:00:00Z', title: `Guard for class${i} at src/file${i}.mjs`, who: 'session', class: `class${i}`, file: `src/file${i}.mjs`, tags: ['auto-duty'], automatic: true });
  for (let i = 0; i < unassigned; i += 1) lines.push({ id: `pu${String(i).padStart(4, '0')}`, ts: '2026-10-01T00:00:00Z', title: `Task without owner ${i}` });
  if (lines.length) fs.appendFileSync(path.join(root, 'global', 'duties.jsonl'), lines.map((z) => `${JSON.stringify(z)}\n`).join(''));
  if (questions) {
    fs.appendFileSync(path.join(root, 'global', 'questions.jsonl'), Array.from({ length: questions }, (_, i) => `${JSON.stringify({
      id: `qu${String(i).padStart(4, '0')}`, ts: '2026-10-01T00:00:00Z', question: `Open question number ${i}?`, why: 'Because it is open.',
    })}\n`).join(''));
  }
  return root;
}
const GOOD = { question: 'Should that happen?', context: 'It is time.', options: ['Yes — it happens', 'No — it stays'] };
const builders = {
  full: (w) => data.collectDashboard(w, { now: NOW }),
  compact: (w) => compact.collectCompact(w, { now: NOW, bytes: 1, modulesUpTo: 1e9 }),
};

// --- today ----------------------------------------------------------------------------------------------

test('today: the human\'s decisions carry their card; an addendum from the shelf counts; the count of decisions does not change', (t) => {
  const w = world(t, { human: 2, agent: 1 });
  const before = today.decisionsForHuman(w);
  assert.equal(before.list.length, 2);
  assert.ok(before.list.every((d) => d.card?.origin.stage === 'fallback' && d.card.options.some((o) => o.decline)));
  assert.match(before.list[0].card.question, /^Do or decide: Task for the human number 0\?$/);
  cardstore.write(w, { target_id: 'ph0000', ...GOOD }, { agent: 'orch' });
  const r = today.today(w, { now: NOW });
  assert.equal(r.counts.decisions, 2);
  const first = r.decisions.list.find((d) => d.id === 'ph0000');
  assert.equal(first.card.origin.stage, 'addendum');
  assert.equal(first.card.question, GOOD.question);
  assert.equal(r.decisions.list.find((d) => d.id === 'ph0001').card.origin.stage, 'fallback');
  assert.deepEqual(r.cards, { readable: true, reason: null, cards: 1, broken: 0, unusable: 0 });
  assert.ok(!r.reasons.some((x) => /card shelf/.test(x)));
  const text = today.asText(r);
  assert.match(text, /\[duty\] ph0000 {2}Should that happen\? {2}\(card added later by orch, tier agent\)/);
  assert.match(text, /Options: Yes \| No/);
  assert.match(text, /\[duty\] ph0001 {2}Do or decide: Task for the human number 1\? {2}\(fallback card\)/);
});

test('today: a shelf that cannot be read gives fallback cards AND says so; broken lines are counted into the reasons', (t) => {
  const w = world(t, { human: 1 });
  const file = path.join(w, 'global', 'cards.jsonl');
  fs.writeFileSync(file, '{broken\n');
  const r1 = today.today(w, { now: NOW });
  assert.deepEqual([r1.cards.broken, r1.cards.unusable], [1, 0]);
  assert.ok(r1.reasons.some((x) => /card shelf: 1 broken and 0 unusable/.test(x)), JSON.stringify(r1.reasons));
  assert.equal(r1.state, 'warning');
  fs.rmSync(file); fs.mkdirSync(file);
  const r2 = today.today(w, { now: NOW });
  assert.equal(r2.cards.readable, false);
  assert.equal(r2.cards.cards, null, 'unknown, not 0');
  assert.equal(r2.decisions.list[0].card.origin.stage, 'fallback');
  assert.ok(r2.reasons.some((x) => /card shelf not readable.*fallback cards/.test(x)));
  // positive control: a clean (empty) shelf reports 0 and no reason
  fs.rmSync(file, { recursive: true }); fs.writeFileSync(file, '');
  const r3 = today.today(w, { now: NOW });
  assert.equal(r3.cards.broken, 0);
  assert.ok(!r3.reasons.some((x) => /card shelf/.test(x)));
});

test('today: a waiting project carries title, reason and its card "Take over project <name>?"', (t) => {
  const w = world(t);
  const pn = cli(w, ['project', 'new', 'garden-plan', '--title', 'Garden planner', '--reason', 'Three captures on two days.']);
  assert.equal(pn.status, 0, pn.stderr);
  const r = today.projectsAwaiting(w);
  const p = r.list.find((x) => x.name === 'garden-plan');
  assert.equal(p.title, 'Garden planner');
  assert.equal(p.reason, 'Three captures on two days.');
  assert.equal(p.card.question, 'Take over project garden-plan?');
  assert.match(p.card.context, /Garden planner\. Reason: Three captures on two days\./);
  assert.equal(p.card.origin.stage, 'fallback');
  assert.equal(p.card.identifier, 'project:garden-plan');
  // an addendum by project name
  cardstore.write(w, { target_id: 'project:garden-plan', question: 'Does the garden belong to house and yard?', context: 'A project house exists.', options: ['Yes — there', 'No — its own project'] }, { agent: 'orch' });
  assert.equal(today.projectsAwaiting(w).list.find((x) => x.name === 'garden-plan').card.origin.stage, 'addendum');
});

test('today.refresh keeps an addendum an addendum, shows a card added since, reads a missing shelf state fresh, and says an unreadable shelf', (t) => {
  const w = world(t, { human: 1 });
  cli(w, ['project', 'new', 'garden-plan', '--title', 'Garden planner', '--reason', 'A reason.']);
  cardstore.write(w, { target_id: 'project:garden-plan', question: 'Does it belong?', context: 'c', options: ['Yes — a', 'No — b'] }, { agent: 'orch' });
  const stored = today.today(w, { now: NOW });
  assert.equal(stored.projects.list[0].card.origin.stage, 'addendum');
  const again = today.refresh(stored, w, ['projects'], { now: NOW });
  assert.equal(again.projects.list[0].card.origin.stage, 'addendum');
  assert.equal(again.cards.cards, 1);
  const gold = today.refresh(stored, w, ['gold'], { now: NOW });
  assert.equal(gold.projects.list[0].card.origin.stage, 'addendum', 'a refresh of another part leaves the projects as they were');
  // a stored state from before the shelf existed has no `cards`: read once, not "not read"
  const old = { ...stored }; delete old.cards;
  const fresh = today.refresh(old, w, ['gold'], { now: NOW });
  assert.equal(fresh.cards.readable, true);
  assert.ok(!fresh.reasons.some((x) => /card shelf/.test(x)));
  // a card added after the stored state shows after the refresh of the projects (and only there)
  cardstore.write(w, { target_id: 'project:garden-plan', question: 'Newer question?', context: 'c', options: ['Yes — a', 'No — b'] }, { agent: 'orch', now: new Date('2026-10-14T00:00:00Z') });
  assert.equal(today.refresh(stored, w, ['projects'], { now: NOW }).projects.list[0].card.question, 'Newer question?');
  assert.equal(stored.projects.list[0].card.question, 'Does it belong?', 'the stored state stayed as it was');
  // an unreadable shelf after the refresh: unknown, fallback cards, the reasons say so
  const file = path.join(w, 'global', 'cards.jsonl');
  fs.rmSync(file); fs.mkdirSync(file);
  const un = today.refresh(stored, w, ['projects'], { now: NOW });
  assert.equal(un.cards.readable, false);
  assert.equal(un.projects.list[0].card.origin.stage, 'fallback');
  assert.ok(un.reasons.some((x) => /card shelf not readable/.test(x)));
});

// --- the dashboard data, both builds ------------------------------------------------------------------------

for (const [name, build] of Object.entries(builders)) {
  test(`${name} build: cards only for the human's and the unassigned items, never for agent work; each carries its addressee`, (t) => {
    const w = world(t, { human: 2, agent: 2, unassigned: 1 });
    cardstore.write(w, { target_id: 'ph0001', ...GOOD }, { agent: 'orch' });
    const d = build(w);
    const byId = new Map(d.openDuties.map((p) => [p.id, p]));
    assert.equal(d.openDuties.length, 5, 'no item is missing');
    assert.equal(byId.get('ph0000').card.origin.stage, 'fallback');
    assert.equal(byId.get('ph0001').card.origin.stage, 'addendum');
    assert.equal(byId.get('pu0000').card.origin.stage, 'fallback', 'the unassigned belong to the carded ones');
    assert.equal(byId.get('pa0000').card, null, 'agent work carries no card');
    assert.equal(byId.get('pa0000').who, 'session');
    assert.deepEqual(d.cards, { readable: true, reason: null, cards: 1, broken: 0, unusable: 0 });
    assert.deepEqual(d.cards_omitted, { openDuties: 0, openQuestions: 0, waitingQuestions: 0 });
  });

  test(`${name} build: at most 200 cards per list, the items stay, the rest is COUNTED`, (t) => {
    const w = world(t, { human: 250, agent: 150, unassigned: 5 });
    const d = build(w);
    const withCard = d.openDuties.filter((p) => p.card);
    assert.equal(withCard.length, 200, 'the cap bites at 255 candidates');
    assert.equal(d.openDuties.length, 405, 'no item is missing');
    assert.ok(d.openDuties.filter((p) => p.id.startsWith('pa')).every((p) => p.card === null));
    assert.equal(d.cards_omitted.openDuties, 55);
    assert.ok(Buffer.byteLength(JSON.stringify(withCard.map((p) => p.card))) < 200 * 1700);
    // positive control: the first items carry theirs
    assert.ok(d.openDuties[0].card.question.length > 0);
  });

  test(`${name} build: open questions carry their addressee and a card; the cap counts them too`, (t) => {
    const w = world(t, { questions: 260 });
    const d = build(w);
    assert.equal(d.openQuestions.length, 260);
    assert.equal(d.openQuestions.filter((q) => q.card).length, 200);
    assert.equal(d.cards_omitted.openQuestions, 60);
    const q0 = d.openQuestions.find((q) => q.id === 'qu0000');
    assert.equal(q0.who, null);
    assert.equal(q0.card.question, 'Open question number 0?');
    assert.match(q0.card.context, /Because it is open\./);
  });

  test(`${name} build: a question addressed to an agent carries no card; one addressed to the human does and names him`, (t) => {
    const w = world(t);
    fs.appendFileSync(path.join(w, 'global', 'questions.jsonl'), [
      { id: 'qh0001abc', ts: '2026-10-01T00:00:00Z', question: 'For the human?', who: 'user' },
      { id: 'qa0001abc', ts: '2026-10-01T00:00:00Z', question: 'For the agent?', who: 'session' },
    ].map((z) => `${JSON.stringify(z)}\n`).join(''));
    const d = build(w);
    const byId = new Map(d.openQuestions.map((q) => [q.id, q]));
    assert.equal(byId.get('qh0001abc').who, 'user');
    assert.equal(byId.get('qh0001abc').card.question, 'For the human?');
    assert.equal(byId.get('qa0001abc').who, 'session');
    assert.equal(byId.get('qa0001abc').card, null);
  });

  test(`${name} build: broken and unusable lines of the shelf stand in the state AND in the reasons; an unreadable shelf is unknown`, (t) => {
    const w = world(t, { human: 1 });
    const file = path.join(w, 'global', 'cards.jsonl');
    fs.writeFileSync(file, [
      '{broken',
      JSON.stringify({ id: 'k1', ts: '2026-10-14T00:00:00Z', agent: 'a', card_question: 'Without a target?' }),
      JSON.stringify({ id: 'k2', ts: '2026-10-14T00:00:00Z', agent: 'a', target_id: 'ph0000', card_question: 'Good?', card_context: 'w', card_options: ['A — a', 'No — b'] }),
    ].join('\n') + '\n');
    const d = build(w);
    assert.deepEqual(d.cards, { readable: true, reason: null, cards: 1, broken: 1, unusable: 1 });
    assert.ok(d.reasons.some((x) => /card shelf: 1 broken and 1 unusable/.test(x)), JSON.stringify(d.reasons));
    assert.equal(d.openDuties[0].card.question, 'Good?');
    // An unreadable drawer (here: the shelf is a directory) stops the FULL build for every drawer alike (`viewer.collect` reads them
    // all and throws; that is the house's rule, not a card rule). The compact build carries on and says it.
    if (name === 'compact') {
      fs.rmSync(file); fs.mkdirSync(file);
      const u = build(w);
      assert.equal(u.cards.readable, false);
      assert.deepEqual([u.cards.cards, u.cards.broken, u.cards.unusable], [null, null, null]);
      assert.equal(u.openDuties[0].card.origin.stage, 'fallback');
      assert.ok(u.reasons.some((x) => /card shelf not readable/.test(x)));
      fs.rmSync(file, { recursive: true }); fs.writeFileSync(file, '');
    } else {
      fs.rmSync(file); fs.writeFileSync(file, '');
    }
    // positive control: an empty shelf has no reason
    assert.ok(!build(w).reasons.some((x) => /card shelf/.test(x)));
  });
}

// card-group-cm: every open item says whom it is owed to, so the page groups by the owner and not by the kind of its card.
for (const [name, build] of Object.entries(builders)) {
  test(`${name} build: every open duty and question carries its owner (human | agent | unassigned), from the configuration`, (t) => {
    const w = world(t, { human: 1, agent: 1, unassigned: 1, questions: 1 });
    const d = build(w);
    const owner = (id) => d.openDuties.find((x) => x.id === id)?.owner;
    assert.equal(owner('ph0000'), 'human');
    assert.equal(owner('pa0000'), 'agent');
    assert.equal(owner('pu0000'), 'unassigned');
    // the human's duty has a replacement card of kind do-it and is still owed to the human (the case the page used to file as agent work)
    assert.equal(d.openDuties.find((x) => x.id === 'ph0000').card.kind, 'do-it');
    assert.equal(d.openQuestions.find((x) => x.id === 'qu0000').owner, 'unassigned');
  });

  test(`${name} build: an open duty carries \`dueAt\` (ms, from the due core) when its due date is readable, else null`, (t) => {
    const w = world(t, { human: 1 });
    fs.appendFileSync(path.join(w, 'global', 'duties.jsonl'), [
      { id: 'pd0001', ts: '2026-10-01T00:00:00Z', title: 'Dated duty', who: 'user', due: '2026-10-05' },
      { id: 'pd0002', ts: '2026-10-01T00:00:00Z', title: 'Duty with a nonsense date', who: 'user', due: 'soon' },
    ].map((z) => `${JSON.stringify(z)}\n`).join(''));
    const d = build(w);
    const at = (id) => d.openDuties.find((x) => x.id === id).dueAt;
    assert.equal(typeof at('pd0001'), 'number');
    assert.equal(new Date(at('pd0001')).toISOString().slice(0, 10) >= '2026-10-05', true, 'overdue from the end of the day');
    assert.equal(at('pd0002'), null, 'an unreadable date is unknown, never a guessed one');
    assert.equal(at('ph0000'), null, 'no due date: null');
  });
}

// --- the allocation, pure --------------------------------------------------------------------------------------

test('cardfeed.ownerKind: the human, a known agent, anything else is unassigned; no name stands in the module', () => {
  const p = { human: 'alex', known: new Set(['bot']) };
  assert.equal(cardfeed.ownerKind('alex', p), 'human');
  assert.equal(cardfeed.ownerKind('bot', p), 'agent');
  assert.equal(cardfeed.ownerKind('someone', p), 'unassigned');
  assert.equal(cardfeed.ownerKind(null, p), 'unassigned');
  assert.equal(cardfeed.ownerKind('  ', p), 'unassigned');
  const src = fs.readFileSync(path.join(REPO, 'src', 'cardfeed.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/['"](lucky|user|session|librarian)['"]/.test(src), 'a participant name is written into the code');
});

// --- the closing report -----------------------------------------------------------------------------------------

test('closing report: a duty with a card somebody wrote is named by its question; one with the fallback card by its title', (t) => {
  const w = world(t, { human: 2 });
  cardstore.write(w, { target_id: 'ph0000', ...GOOD }, { agent: 'orch' });
  const d = today.decisionsForHuman(w);
  const text = closingreport.reportText(d.list);
  assert.match(text, /ph0000 Should that happen\?/);
  assert.match(text, /ph0001 Task for the human number 1/);
  assert.ok(!/Do or decide/.test(text), text);
});

// --- the addressee of a question ---------------------------------------------------------------------------------

test('question.check: `who` is optional, but when it is there it is ONE name', () => {
  assert.equal(question.check({ question: 'Which?' }).ok, true);
  assert.equal(question.check({ question: 'Which?', who: 'alex' }).ok, true);
  assert.equal(question.check({ question: 'Which?', who: 'human:alex' }).ok, true);
  for (const bad of ['', '   ', 'two names', 'a,b', ['a'], { a: 1 }, 5, 'x'.repeat(65)]) {
    const r = question.check({ question: 'Which?', who: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.errors.join(), /who/);
  }
  assert.equal(question.whoOf({ who: ' alex ' }), 'alex');
  assert.equal(question.whoOf({ who: ['a'] }), null);
  assert.equal(question.whoOf({}), null);
});

test('`who` on a question on every road: mem questions new, mem log question, the bridge; a bad one is refused and nothing is written', (t) => {
  const w = world(t);
  const n = cli(w, ['questions', 'new', 'Which colour?', '--who', 'user']);
  assert.equal(n.status, 0, n.stderr);
  const l = cli(w, ['log', 'question', '--question', 'Which size?', '--who', 'user']);
  assert.equal(l.status, 0, l.stderr);
  const msgs = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'mem_log', arguments: { type: 'question', question: 'Which shape?', who: 'user' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'mem_log', arguments: { type: 'question', question: 'Which tone?', who: 'two names' } } })];
  const r = spawnSync(process.execPath, [MCP], { input: `${msgs.join('\n')}\n`, encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: w, CHEAP_MEM_AGENT: 'foreign' } });
  const replies = r.stdout.split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  assert.equal(replies.find((x) => x.id === 10).result.isError ?? false, false, r.stdout);
  assert.equal(replies.find((x) => x.id === 11).result.isError, true);
  const bad1 = cli(w, ['questions', 'new', 'Which?', '--who', 'two names']);
  const bad2 = cli(w, ['log', 'question', '--question', 'Which?', '--who', 'a,b']);
  assert.notEqual(bad1.status, 0);
  assert.notEqual(bad2.status, 0);
  const qs = memory.readLog(w, 'question').entries;
  assert.deepEqual(qs.map((q) => q.who), ['user', 'user', 'user']);
  assert.match(cli(w, ['questions']).stdout, /\(to user\)/);
  // positive control: a question without `who` still reads as before
  assert.ok(!/\(to /.test(question.line({ id: 'q', question: 'x', open: true, answers: [] })));
});
