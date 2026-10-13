// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/decision-without-explanation.test.mjs — H11 (card-rule-doctor-cm): the doctor finding `decision-without-explanation`, the
// replacement card for the duties `mem guard run --duty` raises, and the one source for "what waits on the human".
//
// Port of the sibling's finding `entscheidung-ohne-erklaerung` (agent/karte-schreibregel-lm), in this house's idiom: the count comes
// from the SAME function as `mem today` (`humandecisions`, behind `today.decisionsForHuman`) plus the open questions addressed to the
// human; the grace period is one day from `ts`; never `error`; not readable is `unknown`, never 0.
//
// Red proof: on the base (card-core-cm 6e81ce3) the finding does not exist (`checkDecisionWithoutExplanation` is not a function), no
// `humandecisions` module, and the latch duties get the generic "Do or decide" card. Positive controls are marked.
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
import * as doctor from '../src/doctor.mjs';
import * as today from '../src/today.mjs';
import * as humandecisions from '../src/humandecisions.mjs';
import * as cardstore from '../src/cardstore.mjs';
import * as decisioncard from '../src/decisioncard.mjs';
import * as memory from '../src/memory.mjs';

delete process.env.MEM_HEADLESS;
delete process.env.CHEAP_MEM_MAX_AUTHORITY;
delete process.env.CHEAP_MEM_AGENT;
delete process.env.CHEAP_MEM_CARD_REJECT;

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const T0 = '2026-10-01T00:00:00Z';
const DAY = 24 * 60 * 60 * 1000;
const NAME = 'decision-without-explanation';
const CARD = { card_question: 'Which licence?', card_context: 'Two files disagree.', card_options: ['MIT — as LICENSE', 'Not now — nothing changes'] };

function world(t, { human = true } = {}) {
  const root = tempDir('cm-dwe-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  if (!human) {
    const file = path.join(root, '.mem', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const v of Object.values(cfg.participants)) if (v && typeof v === 'object') delete v.human;
    fs.writeFileSync(file, JSON.stringify(cfg));
  }
  return root;
}
const put = (root, type, lines) => fs.appendFileSync(path.join(root, 'global', `${type}.jsonl`), lines.map((z) => `${JSON.stringify(z)}\n`).join(''));
const duty = (id, extra = {}) => ({ id, ts: T0, title: `Task ${id}`, who: 'user', ...extra });
const NOW_GRACE = new Date(Date.parse(T0) + DAY / 2); // half a day later
const NOW_LATER = new Date(Date.parse(T0) + 3 * DAY);

test('finding: nothing open for the human is good; an agent duty and a question for nobody are not counted (positive control)', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('ag0001', { who: 'session' })]);
  put(root, 'questions', [{ id: 'qn0001', ts: T0, question: 'Asked of nobody?' }]);
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_LATER);
  assert.equal(f.name, NAME);
  assert.equal(f.level, 'good');
  assert.match(f.text, /none is a decision for the human/);
});

test('finding: a decision with a card of its own is good; one without, past the grace period, is a warning with the way out', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('ca0001', CARD), duty('nc0001')]);
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_LATER);
  assert.equal(f.level, 'warn');
  assert.match(f.text, /2 open decisions for the human: 1 with a card of their own \(1 written, 0 added later\), 1 with the fallback card only; 1 of them without explanation and older than 1 day/);
  assert.match(f.advice, /mem card add nc0001 --question/);
  // positive control: only the carded one -> good, with the count
  const root2 = world(t);
  put(root2, 'duties', [duty('ca0001', CARD)]);
  const g = doctor.checkDecisionWithoutExplanation(root2, NOW_LATER);
  assert.equal(g.level, 'good');
  assert.match(g.text, /1 with a card of their own \(1 written, 0 added later\), 0 with the fallback card only/);
});

test('finding: the grace period is one day from ts - inside it is good (and says so), at it is a debt', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('nc0001')]);
  const inside = doctor.checkDecisionWithoutExplanation(root, NOW_GRACE);
  assert.equal(inside.level, 'good');
  assert.match(inside.text, /within the grace period of 1 day/);
  assert.equal(doctor.checkDecisionWithoutExplanation(root, new Date(Date.parse(T0) + DAY)).level, 'warn', 'exactly one day is not inside');
  assert.equal(doctor.EXPLANATION_GRACE_DAYS, 1);
});

test('finding: a date that cannot be read does NOT count as fresh', (t) => {
  const root = world(t);
  put(root, 'duties', [{ id: 'nd0001', title: 'No date', who: 'user' }]);
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_GRACE);
  assert.equal(f.level, 'warn');
  assert.match(f.text, /1 without a readable date/);
});

test('finding: a ts in the FUTURE is a debt, not a grace period for ever', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('fu0001', { ts: '2027-01-01T00:00:00Z' })]);
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_LATER);
  assert.equal(f.level, 'warn');
  assert.match(f.text, /1 without a readable date/);
  // positive control: the same entry with a past ts is inside the grace period
  const root2 = world(t);
  put(root2, 'duties', [duty('fu0001', { ts: new Date(NOW_LATER.getTime() - 3600000).toISOString() })]);
  assert.equal(doctor.checkDecisionWithoutExplanation(root2, NOW_LATER).level, 'good');
});

test('finding: a ts without a zone is read as UTC in every time zone (TZ=Pacific/Auckland and America/Los_Angeles)', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('nz0001', { ts: '2026-10-01T00:00:00' })]);
  const script = `import(${JSON.stringify(new URL('../src/doctor.mjs', import.meta.url).href)}).then((m) => {
    const f = m.checkDecisionWithoutExplanation(process.argv[1], new Date(process.argv[2]));
    console.log(f.level + '|' + f.text); });`;
  // 2026-10-01T12:00Z: twelve hours old in UTC -> inside the grace period. Local-zone reading in Auckland (UTC+13) would make it
  // -1h..-25h off in either direction, and in Los Angeles (UTC-7) seven hours off the other way.
  const at = '2026-10-01T12:00:00Z';
  const levels = {};
  for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
    const r = spawnSync(process.execPath, ['-e', script, root, at], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(r.status, 0, r.stderr);
    levels[tz] = r.stdout.trim().split('|')[0];
  }
  assert.deepEqual(levels, { UTC: 'good', 'Pacific/Auckland': 'good', 'America/Los_Angeles': 'good' });
  // 2026-10-02T00:30Z: 24.5 hours old in UTC -> a debt everywhere (a local reading in Auckland would say 11.5 hours, in Los Angeles 31.5)
  const later = '2026-10-02T00:30:00Z';
  for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
    const r = spawnSync(process.execPath, ['-e', script, root, later], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(r.stdout.trim().split('|')[0], 'warn', tz);
  }
});

test('finding: a card added later on the shelf clears the debt and counts as "added later"', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('nc0001')]);
  assert.equal(doctor.checkDecisionWithoutExplanation(root, NOW_LATER).level, 'warn');
  cardstore.write(root, { target_id: 'nc0001', question: 'Which licence?', context: 'Two files disagree.', options: ['MIT — as LICENSE', 'Not now — nothing changes'] });
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_LATER);
  assert.equal(f.level, 'good');
  assert.match(f.text, /1 with a card of their own \(0 written, 1 added later\)/);
});

test('finding: a half card (a question without options) does not clear the debt', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('hc0001', { card_question: 'Which licence?' })]);
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_LATER);
  assert.equal(f.level, 'warn');
  assert.match(f.text, /0 with a card of their own/);
});

test('finding: open questions addressed to the human are counted; one for nobody, an answered one and one for an agent are not', (t) => {
  const root = world(t);
  put(root, 'questions', [
    { id: 'qh0001', ts: T0, question: 'Which licence?', who: 'user' },
    { id: 'qh0002', ts: T0, question: 'Another one?', who: ' user ', ...CARD },
    { id: 'qa0001', ts: T0, question: 'For an agent?', who: 'session' },
    { id: 'qn0001', ts: T0, question: 'For nobody?' },
  ]);
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_LATER);
  assert.equal(f.level, 'warn');
  assert.match(f.text, /^2 open decisions for the human: 1 with a card of their own/);
  assert.match(f.advice, /mem card add qh0001/);
});

test('finding: ONE source - the duties the finding counts are the ones `today.decisionsForHuman` lists; who is read trimmed in both', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('a00001', { who: ' user ' }), duty('b00001', { who: undefined, owner: 'user' }), duty('c00001', { who: 'session' }), duty('d00001', { who: undefined, to: 'user' })]);
  put(root, 'questions', [{ id: 'qh0001', ts: T0, question: 'Which licence?', who: 'user' }]);
  const day = today.decisionsForHuman(root);
  assert.deepEqual(day.list.map((x) => x.id).sort(), ['a00001', 'b00001', 'd00001']);
  const all = humandecisions.withQuestions(root);
  assert.deepEqual(all.list.filter((x) => x.kind === 'duty').map((x) => x.id).sort(), day.list.map((x) => x.id).sort(), 'the same duties');
  assert.deepEqual(all.list.filter((x) => x.kind === 'question').map((x) => x.id), ['qh0001']);
  const f = doctor.checkDecisionWithoutExplanation(root, NOW_LATER);
  assert.match(f.text, /^4 open decisions for the human/);
  // `mem today` itself does not count the question (the owner decides that) - the number on the session-start line stays as it was
  assert.equal(day.list.length, 3);
  assert.equal(today.today(root).counts.decisions, 3);
});

test('finding: unknown, never 0 and never error - the shelf cannot be read; no human is configured; the duties cannot be read', (t) => {
  const shelf = world(t);
  put(shelf, 'duties', [duty('nc0001')]);
  fs.mkdirSync(path.join(shelf, 'global', 'cards.jsonl')); // a directory in the place of the file
  const a = doctor.checkDecisionWithoutExplanation(shelf, NOW_LATER);
  assert.equal(a.level, 'unknown');
  assert.match(a.text, /not readable.*unknown, not zero/);

  const nobody = world(t, { human: false });
  put(nobody, 'duties', [duty('nc0001')]);
  const b = doctor.checkDecisionWithoutExplanation(nobody, NOW_LATER);
  assert.equal(b.level, 'unknown');
  assert.match(b.text, /human/);

  const noduties = world(t);
  fs.mkdirSync(path.join(noduties, 'global', 'duties.jsonl'));
  const c = doctor.checkDecisionWithoutExplanation(noduties, NOW_LATER);
  assert.equal(c.level, 'unknown');
  for (const f of [a, b, c]) assert.notEqual(f.level, 'error');
});

test('finding: it is part of the doctor run under its name, and it is never an error there either', (t) => {
  const root = world(t);
  put(root, 'duties', [duty('nc0001')]);
  const all = doctor.checkAll(root).findings;
  const f = all.find((x) => x.name === NAME);
  assert.ok(f, 'part of checkAll');
  assert.notEqual(f.level, 'error');
  assert.equal(all.filter((x) => x.name === NAME).length, 1);
});

// --- the replacement card for the duties of `mem guard run --duty` ---------------------------------------------------------

test('fallback card: a red latch duty asks what to do about the error, not "Do or decide: Latch red: ..."', () => {
  const p = { id: 'lr0001', title: 'Latch red: wrong-cause', text: 'src/a.mjs still holds the pattern.\nBelongs to entry er0001.', who: 'user' };
  const c = decisioncard.cardOf(p, { type: 'duty' });
  assert.match(c.question, /^Should the error “wrong-cause” be fixed that a red latch shows\?$/);
  assert.doesNotMatch(c.question, /Do or decide/);
  assert.match(c.context, /still holds the pattern/);
  assert.doesNotMatch(c.context, /Belongs to entry/);
  assert.deepEqual(c.options.map((o) => o.choice), ['Fix the error', 'Discard', 'Not now']);
  assert.ok(c.options.some((o) => o.decline), 'a No option is always there');
  assert.ok(c.evidence.includes('lr0001') && c.evidence.includes('er0001'));
  assert.equal(c.kind, 'do-it');
  assert.equal(c.origin.stage, 'fallback');
  assert.equal(c.advice, null, 'nobody gave an advice');
});

test('fallback card: a broken latch duty is "repair the latch", not "fix the error"', () => {
  const p = { id: 'lb0001', title: 'Latch broken: wrong-cause', text: 'The file src/gone.mjs does not exist.\nBelongs to entry er0001.' };
  const c = decisioncard.cardOf(p, { type: 'duty' });
  assert.match(c.question, /^Should the broken latch for “wrong-cause” be repaired\?$/);
  assert.deepEqual(c.options.map((o) => o.choice), ['Repair the latch', 'Discard', 'Not now']);
  assert.match(c.context, /does not exist/);
  // positive control: a duty that merely MENTIONS a latch keeps the general card
  const other = decisioncard.cardOf({ id: 'ot0001', title: 'Check the latch red: later' }, { type: 'duty' });
  assert.match(other.question, /^Do or decide: /);
});

test('fallback card: the latch card is masked before it is cut (a key in the class name does not come out)', () => {
  const key = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
  const c = decisioncard.cardOf({ id: 'lr0002', title: `Latch red: ${key}`, text: `${key} is here.\nBelongs to entry er0001.` }, { type: 'duty' });
  assert.ok(!JSON.stringify(c).includes(key));
});

test('guard --duty end to end: the duty is written for the human WITHOUT a card, is exempt from the rule, and reads as a latch card', (t) => {
  const root = world(t);
  const env = { ...process.env, CHEAP_MEM_AGENT: 'builder-x', CHEAP_MEM_CARD_REJECT: 'yes' };
  const run = (...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root], { encoding: 'utf8', input: '', env });
  fs.writeFileSync(path.join(root, 'bad.txt'), 'the bad pattern is still here\n');
  const err = run('log', 'error', '--class', 'wrong-cause', '--title', 'A thing broke', '--text', 'It broke.', '--guard-kind', 'absent', '--guard-path', 'bad.txt', '--guard-pattern', 'bad pattern');
  assert.equal(err.status, 0, err.stderr);
  const g = run('guard', 'run', '--duty');
  assert.match(g.stdout, /duty\/duties raised/, g.stdout + g.stderr);
  const d = humandecisions.forHuman(root).list;
  assert.equal(d.length, 1, 'exempt from the rule even with the switch on: the duty is there');
  assert.match(d[0].card.question, /latch/i);
  assert.equal(d[0].card.origin.stage, 'fallback');
  assert.equal(decisioncard.lacksExplanation(d[0].card), true);
  assert.equal(memory.openDuties(root).open.length, 1);
});
