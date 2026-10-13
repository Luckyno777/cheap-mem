// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/today-due.test.mjs — Q7, the day brief with due dates (build plan step 6b, branch B, `today-due-cm`; the sibling house
// builds the same as `tagesbrief-faellig-lm`).
//
// What is proven here — and is red on 6390925 (the base: the due-date core is there, nothing reads it for the day brief):
//   1. The day line: calm = nothing, a read error = "not measurable" (never 0), too long = whole parts fall away by rank.
//   2. The part "Deadlines" of `mem today`: the human's duties one by one (a flood of 200 gives 8 and the number), agents' only
//      as a number; JSON the same.
//   3. ONE pass over the duty drawers per `today()` (a counter over the drawer file, with a positive control that counts).
//   4. The Monday briefing: the day line, the week review only when a deadline fell due last week or falls due this week, the
//      review alone keeps a day from being empty; the week is Monday to Monday in the HOUSE zone, over midnight and both clock
//      changes.
//   5. An encrypted duty: the date readable, the title locked. The output guard: a key built at run time, standing across the cut.
//   6. The doctor finding `deadlines`: warn / good / unknown, and "good over nothing" is unknown.
//   7. The before-edit list: overdue duties first, only the order.
//   8. The dashboard data of both builds, and the card in the browser file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as today from '../src/today.mjs';
import * as deadlines from '../src/deadlines.mjs';
import * as dayline from '../src/dayline.mjs';
import * as doctor from '../src/doctor.mjs';
import * as memory from '../src/memory.mjs';
import * as errorcontext from '../src/errorcontext.mjs';
import * as A from '../src/appointments.mjs';
import * as C from '../src/appointment-clock.mjs';
import * as T from '../src/appointment-today.mjs';
import * as tm from '../src/appointment-time.mjs';
import * as inbox from '../src/inbox.mjs';
import * as cfgmod from '../src/config.mjs';
import * as dd from '../src/dashboard-data.mjs';
import * as compact from '../src/dashboard-compact.mjs';
import { maskText } from '../src/outputguard.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BERLIN = 'Europe/Berlin';
const ms = (iso) => Date.parse(iso);
const CALM_DOCTOR = { findings: [], worst: 'good', summary: {} };
// A key built at run time, never a literal: `ghp_` and 36 more characters.
const FAKE_KEY = () => `ghp${'_'}${'Q'.repeat(36)}`;

const cli = (root, ...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root],
  { encoding: 'utf8', input: '', timeout: 60000, env: { ...process.env, CHEAP_MEM_AGENT: 'due-test', CHEAP_MEM_TZ: BERLIN } });

function world(t, { timezone = BERLIN } = {}) {
  const root = tempDir('cheap-mem-today-due-', t);
  assert.equal(cli(root, 'init').status, 0);
  if (timezone) {
    const f = path.join(root, '.mem', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    cfg.timezone = timezone;
    fs.writeFileSync(f, JSON.stringify(cfg));
  }
  return root;
}
const dutiesFile = (root) => path.join(root, 'global', 'duties.jsonl');
const handWritten = (root, objects) => {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.appendFileSync(dutiesFile(root), objects.map((o) => `${JSON.stringify(o)}\n`).join(''));
};
let n = 0;
const id = () => `d${String((n += 1)).padStart(7, '0')}`;
const duty = (o) => ({ id: id(), ts: '2026-09-01T00:00:00Z', agent: 'human:t', ...o });
const NOW = new Date('2026-10-12T10:00:00Z'); // Monday, Berlin 12:00
const opts = (root) => ({ now: NOW, env: { CHEAP_MEM_TZ: BERLIN, CHEAP_MEM_GOLD_FILE: path.join(root, 'no-gold.jsonl') }, doctorResult: CALM_DOCTOR });

/** The passes over the duty drawer file: opens and reads of `duties.jsonl`, counted in this process. */
function dutyPasses(fn) {
  let count = 0;
  const originals = {};
  const bump = (p) => { if (typeof p === 'string' && /duties\.jsonl$/.test(p)) count += 1; };
  for (const name of ['openSync', 'readFileSync', 'createReadStream']) {
    originals[name] = fs[name];
    fs[name] = function spy(...a) { bump(a[0]); return originals[name].apply(this, a); };
  }
  module.syncBuiltinESMExports();
  try { return { result: fn(), count }; } finally {
    for (const [name, orig] of Object.entries(originals)) fs[name] = orig;
    module.syncBuiltinESMExports();
  }
}

// ---------------------------------------------------------------- 1. the day line

test('day line: quiet is nothing; an overdue duty and one due today are named; the projects keep their old words', (t) => {
  const root = world(t);
  const calm = today.today(root, opts(root));
  // a fresh install has other things to say (gold, ...); the deadlines add nothing of their own when there are none
  assert.doesNotMatch(String(calm.line), /deadline|due today/);
  assert.equal(calm.counts.deadlinesOverdue, 0);
  assert.equal(calm.counts.deadlinesDue, 0);
  handWritten(root, [
    duty({ title: 'Late A', owner: 'user', due: '2026-10-01' }),
    duty({ title: 'Late B', owner: 'user', due: '2026-10-10' }),
    duty({ title: 'Today', owner: 'user', due: '2026-10-12' }),
    duty({ title: 'Later', owner: 'user', due: '2026-12-24' }),
    duty({ title: 'Agent late', owner: 'session', due: '2026-10-01' }),
  ]);
  const r = today.today(root, opts(root));
  assert.deepEqual([r.counts.deadlinesOverdue, r.counts.deadlinesDue], [2, 1], 'the human\'s only; the agent\'s duty is not in the line');
  assert.match(r.line, /^Today: 2 deadlines overdue · 1 due today/);
  const one = today.line({ counts: { deadlinesOverdue: 1, deadlinesDue: 0, decisions: 0, operationsWorst: 'good', verify: 0, goldQuestions: 0, projectsAwaiting: 2 } });
  assert.equal(one, 'Today: 1 deadline overdue · 2 projects awaiting confirmation');
});

test('day line: a deadlines read error says "not measurable", never 0 and never silence', (t) => {
  const root = world(t);
  // positive control: the same line with a readable, calm part says nothing about deadlines
  assert.equal(today.line({ counts: { deadlinesOverdue: 0, deadlinesDue: 0, decisions: 0, operationsWorst: 'good', verify: 0, goldQuestions: 0 } }), null);
  // the drawer is a directory: the duties cannot be read
  fs.mkdirSync(dutiesFile(root), { recursive: true });
  const r = today.today(root, opts(root));
  assert.equal(r.deadlines.readable, false);
  assert.match(r.deadlines.reason, /duties not readable/);
  assert.equal(r.counts.deadlinesOverdue, null);
  assert.match(r.line, /deadlines not measurable/);
  assert.doesNotMatch(r.line, /\b0 deadlines/);
  assert.match(today.asText(r), /DEADLINES: not measurable/);
  // the decisions say the same of the same drawer (one fold, one verdict)
  assert.equal(r.decisions.readable, false);
});

test('day line: too long, whole parts fall away by rank - never a cut inside a word or a number', () => {
  const counts = {
    deadlinesOverdue: 123456789, deadlinesDue: 987654321, decisions: 111111111, operationsWorst: 'error', verify: 222222222,
    goldQuestions: 333333333, projectsAwaiting: 444444444,
  };
  const all = dayline.fit([
    { text: dayline.overdueText(counts.deadlinesOverdue), rank: dayline.RANK.overdue },
    { text: dayline.dueTodayText(counts.deadlinesDue), rank: dayline.RANK.dueToday },
    { text: `${counts.decisions} decisions open`, rank: dayline.RANK.decisions },
    { text: 'operations error', rank: dayline.RANK.operations },
    { text: `${counts.verify} to verify`, rank: dayline.RANK.verify },
    { text: `${counts.goldQuestions} gold questions`, rank: dayline.RANK.gold },
    { text: dayline.projectsText(counts.projectsAwaiting), rank: dayline.RANK.projects },
  ], { max: 1000 });
  assert.ok(all.length > today.LINE_MAX, 'positive control: with no limit all seven parts are there and the line is longer than the cap');
  const l = today.line({ counts });
  assert.ok(l.length <= today.LINE_MAX, String(l.length));
  assert.doesNotMatch(l, /…/);
  // what stays is whole parts, the most important ones; the least important went first
  const kept = l.replace(/^Today: /, '').split(' · ');
  for (const part of kept) assert.ok(all.includes(part), `${part} is a whole part`);
  assert.ok(kept[0].endsWith('deadlines overdue'), 'overdue deadlines stay longest');
  assert.ok(!kept.some((k) => /gold question/.test(k)), 'gold questions go first');
  assert.ok(kept.length < 7 && kept.length >= 2);
  // order of falling away: with room for exactly the two best, only those stay
  const two = dayline.fit([
    { text: 'C part', rank: 3 }, { text: 'A part', rank: 1 }, { text: 'B part', rank: 2 },
  ], { max: 'Today: A part · B part'.length + 4 });
  assert.deepEqual(two.replace('Today: ', '').split(' · ').sort(), ['A part', 'B part'], 'the part of rank 3 went, the two best stayed');
  // nothing fits: a short pointer, not a stump
  assert.equal(dayline.fit([{ text: 'x'.repeat(200), rank: 1 }], { max: 120 }), 'Today: more than fits here, see mem today');
});

// ---------------------------------------------------------------- 2. the part "Deadlines"

test('Deadlines: the human\'s duties one by one, earliest first; agents\' only as a number; JSON and text agree', (t) => {
  const root = world(t);
  handWritten(root, [
    duty({ title: 'Tax', owner: 'user', due: '2026-10-01' }),
    duty({ title: 'Today', owner: 'user', due: '2026-10-12' }),
    duty({ title: 'Soon', owner: 'user', due: '2026-11-01' }),
    duty({ title: 'Broken date', owner: 'user', due: 'soon' }),
    duty({ title: 'No date', owner: 'user' }),
    duty({ title: 'Agent A', owner: 'session', due: '2026-10-01' }),
    duty({ title: 'Agent B', owner: 'session', due: '2026-10-12' }),
    duty({ title: 'Nobody', due: '2026-12-01' }),
  ]);
  const r = today.today(root, opts(root));
  const d = r.deadlines;
  assert.equal(d.readable, true);
  assert.equal(d.zone, BERLIN);
  assert.deepEqual(d.mine.list.map((x) => [x.title, x.state]), [['Tax', 'overdue'], ['Today', 'due'], ['Soon', 'fresh'], ['Broken date', 'unknown']]);
  assert.deepEqual([d.mine.withDue, d.mine.overdue, d.mine.dueToday, d.mine.fresh, d.mine.unknown, d.mine.more], [4, 1, 1, 1, 1, 0]);
  assert.deepEqual({ ...d.others }, { withDue: 3, overdue: 1, dueToday: 1, fresh: 1, unknown: 0 }, 'agents and nobody: a number, no rows');
  assert.equal(JSON.stringify(d).includes('Agent A'), false, 'no agent duty title travels in the part');
  assert.equal(d.open, 8);
  assert.equal(d.withoutDue, 1);
  const text = today.asText(r);
  assert.match(text, /DEADLINES FOR THE HUMAN: 4 with a due date \(1 overdue, 1 due today, 1 later, 1 unreadable\)/);
  assert.match(text, /overdue {2}2026-10-01 {2}\[\w+\] {2}Tax/);
  assert.match(text, /Not addressed to the human \(agents, nobody\): 3 with a due date/);
  const json = JSON.parse(cli(root, 'today', '--json').stdout);
  assert.equal(json.deadlines.mine.list.length, 4);
  assert.equal(json.counts.deadlinesOverdue, json.deadlines.mine.overdue, 'the count of the line is the part\'s own number');
  assert.equal(json.deadlines.others.withDue, 3);
  // the decisions carry the state of their due date as the core gives it (a chip on the dashboard)
  assert.deepEqual(r.decisions.list.map((x) => [x.title, x.dueState]).sort(), [['Broken date', 'unknown'], ['No date', null], ['Soon', 'fresh'], ['Tax', 'overdue'], ['Today', 'due']]);
});

test('Deadlines: a flood of 200 duties of the human shows 8 and counts the rest; 150 agent duties are one number', (t) => {
  const root = world(t);
  const rows = [];
  for (let i = 0; i < 200; i += 1) rows.push(duty({ title: `Human ${i}`, owner: 'user', due: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}` }));
  for (let i = 0; i < 150; i += 1) rows.push(duty({ title: `Agent ${i}`, owner: 'session', due: '2026-09-01' }));
  handWritten(root, rows);
  const d = today.today(root, opts(root)).deadlines;
  assert.equal(d.mine.list.length, deadlines.SHOWN_MAX);
  assert.equal(deadlines.SHOWN_MAX, 8);
  assert.equal(d.mine.more, 192);
  assert.equal(d.mine.withDue, 200);
  assert.equal(d.mine.overdue, 200);
  assert.equal(d.others.withDue, 150);
  assert.equal(JSON.stringify(d).match(/Agent \d+/g), null, 'not one agent title in the part');
  // earliest due first, so the shown eight are the longest overdue
  assert.ok(d.mine.list.every((x) => x.day === '2026-09-01'));
  assert.match(today.asText(today.today(root, opts(root))), /… and 192 more: mem deadlines/);
  // positive control: a smaller cap shows fewer (the cap is what limits, not the data)
  assert.equal(deadlines.part({ open: [duty({ title: 'a', owner: 'user', due: '2026-09-01' }), duty({ title: 'b', owner: 'user', due: '2026-09-02' })] },
    { human: 'user', now: NOW, zone: BERLIN, max: 1 }).mine.list.length, 1);
});

test('Deadlines: the house zone decides the day, not UTC (config.timezone, then CHEAP_MEM_TZ)', (t) => {
  const root = world(t, { timezone: 'Pacific/Auckland' });
  handWritten(root, [duty({ title: 'Edge', owner: 'user', due: '2026-10-12' })]);
  // 2026-10-12T20:00Z is 2026-10-13 09:00 in Auckland (the day is over) and still the 12th in Berlin and New York
  const at = new Date('2026-10-12T20:00:00Z');
  const auck = today.today(root, { ...opts(root), now: at }).deadlines;
  assert.equal(auck.zone, 'Pacific/Auckland');
  assert.equal(auck.mine.overdue, 1);
  const f = path.join(root, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete cfg.timezone;
  fs.writeFileSync(f, JSON.stringify(cfg));
  const viaEnv = today.today(root, { ...opts(root), now: at, env: { CHEAP_MEM_TZ: 'America/New_York', CHEAP_MEM_GOLD_FILE: path.join(root, 'x') } }).deadlines;
  assert.equal(viaEnv.zone, 'America/New_York');
  assert.deepEqual([viaEnv.mine.overdue, viaEnv.mine.dueToday], [0, 1]);
  // a zone that is not one: not measurable with the reason, not a guess
  cfg.timezone = 'Mars/Olympus';
  fs.writeFileSync(f, JSON.stringify(cfg));
  const bad = today.deadlinesPart(root, { now: at, env: {} });
  assert.equal(bad.readable, false);
  assert.match(bad.reason, /zone/);
});

test('Deadlines: an encrypted duty keeps its date readable, its title is locked, nothing of it leaks', (t) => {
  const root = world(t);
  const CANARY = 'canarydeadlinexq';
  memory.logCheckedEntry(root, 'duty', { title: `Secret ${CANARY}`, text: `Body ${CANARY}`, owner: 'user', due: '2026-10-01', shred: true });
  assert.equal(fs.readFileSync(dutiesFile(root), 'utf8').includes(CANARY), false, 'positive control: the log holds no clear text of it');
  const r = today.today(root, opts(root));
  assert.deepEqual(r.deadlines.mine.list.map((x) => [x.title, x.due, x.state]), [[deadlines.LOCKED, '2026-10-01', 'overdue']]);
  assert.equal(r.counts.deadlinesOverdue, 1, 'THAT it is late is said without the key');
  const out = `${today.asText(r)}\n${JSON.stringify(r)}\n${cli(root, 'today', '--json').stdout}`;
  assert.equal(out.includes(CANARY), false);
});

test('Deadlines: output guard - a key built at run time standing over the cut is masked first, then cut; a right-to-left override is made visible', (t) => {
  const root = world(t);
  const key = FAKE_KEY();
  // 66 characters and a blank, then the key: a cut at 100 BEFORE the mask would leave `ghp_` and 29 more characters (a stump
  // below the pattern's minimum length)
  const title = `${'a'.repeat(66)} ${key} and more words after it`;
  const naive = maskText(title.slice(0, deadlines.TITLE_MAX));
  assert.match(naive, /Q{10}/, 'positive control: cut-then-mask lets a stump of the key through');
  handWritten(root, [
    duty({ title, owner: 'user', due: '2026-10-01' }),
    duty({ title: 'Bidi \u202Eevil\u202C end', owner: 'user', due: '2026-10-02' }),
  ]);
  const r = today.today(root, opts(root));
  const shown = r.deadlines.mine.list;
  assert.equal(shown.length, 2);
  const jsonOut = JSON.parse(cli(root, 'today', '--json').stdout);
  const all = `${today.asText(r)}\n${JSON.stringify(r.deadlines)}\n${cli(root, 'today').stdout}\n${cli(root, 'today', '--json').stdout}`;
  assert.doesNotMatch(all, /Q{10}/, 'no part of the key, anywhere');
  // the part itself (text and data) carries no raw control character; the decisions list is another part with its own rules
  const part = `${JSON.stringify(r.deadlines)}\n${JSON.stringify(jsonOut.deadlines)}\n${today.asText(r).split('\n').filter((l) => /overdue|due /.test(l)).join('\n')}`;
  assert.match(shown[0].title, /\[REDACTED/);
  assert.doesNotMatch(shown[0].title, /\[REDACTED(:[A-Za-z0-9-]*)?$/, 'no torn marker at the end');
  assert.equal(/[\u202A-\u202E\u2066-\u2069]/.test(part), false, 'no raw bidi control left in the part');
  assert.match(shown[1].title, /\[U\+202E/, 'made visible, not dropped');
});

// ---------------------------------------------------------------- 3. one pass over the duties

test('one duty pass per day result: today() reads the drawer ONCE and hands the one fold to decisions and deadlines', (t) => {
  const root = world(t);
  handWritten(root, [duty({ title: 'A', owner: 'user', due: '2026-10-01' }), duty({ title: 'B', owner: 'session', due: '2026-10-02' })]);
  const one = dutyPasses(() => today.today(root, opts(root)));
  assert.equal(one.count, 1, `passes over duties.jsonl: ${one.count}`);
  assert.equal(one.result.decisions.list.length, 1);
  assert.equal(one.result.deadlines.mine.withDue, 1);
  // positive control: the counter counts - two independent readers are two passes
  const naive = dutyPasses(() => {
    today.decisionsForHuman(root, {});
    return today.deadlinesPart(root, { now: NOW, env: { CHEAP_MEM_TZ: BERLIN } });
  });
  assert.equal(naive.count, 2, 'positive control: decisions and deadlines each reading for themselves are two passes');
  // a caller that read the fold already hands it in: no pass at all inside today()
  const fold = today.dutyFold(root);
  const handed = dutyPasses(() => today.today(root, { ...opts(root), duties: fold }));
  assert.equal(handed.count, 0);
  assert.deepEqual(handed.result.counts, one.result.counts);
  // a fold that failed to read is reported by both parts, from the one failed read
  const failed = today.today(root, { ...opts(root), duties: { error: new Error('disk gone') } });
  assert.match(failed.decisions.reason, /disk gone/);
  assert.match(failed.deadlines.reason, /disk gone/);
});

test('one duty pass per dashboard build: the build reads the drawer once and hands the fold to the day result', (t) => {
  const root = world(t);
  handWritten(root, [duty({ title: 'A', owner: 'user', due: '2026-10-01' })]);
  let reads = 0;
  let handedFold = null;
  const fold = memory.openDuties(root);
  const data = dd.collectDashboard(root, {
    now: NOW, env: { CHEAP_MEM_TZ: BERLIN, CHEAP_MEM_GOLD_FILE: path.join(root, 'x') },
    dutiesOpen: () => { reads += 1; return fold; },
    doctorCheck: () => CALM_DOCTOR,
    todayOf: (r, o) => { handedFold = o.duties; return today.today(r, o); },
  });
  assert.equal(reads, 1);
  assert.equal(handedFold, fold, 'the very fold the build read');
  assert.equal(data.deadlines.readable, true);
  assert.deepEqual(data.deadlines, data.today.deadlines, 'the full build carries the day result\'s own part');
  assert.equal(data.deadlines.mine.overdue, 1);
});

// ---------------------------------------------------------------- 4. the Monday briefing

const clock = tm.clockFor(BERLIN);
const wall = (y, mo, d, h = 0, mi = 0) => clock.wallToUtc(y, mo, d, h, mi);
function apptWorld(t) {
  const r = tempDir('cm-today-due-appt-', t);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    version: 1, participants: { alex: { role: 'the human', human: true }, 'vm-admin': 'operator agent', librarian: 'curator' }, language: 'en', timezone: BERLIN,
  }));
  return r;
}
const ENV = {};
const HUMAN = A.actorFrom({ name: 'human:alex', authority: 'user', env: ENV });
const lettersTo = (r, to) => inbox.read(r, cfgmod.readConfig(r).participants, { to }).messages;
const briefings = (r) => lettersTo(r, 'alex').filter((m) => /^Today in the calendar/.test(m.subject));

function briefed(t, extra) {
  const r = apptWorld(t);
  const mon = wall(2026, 10, 5, 7, 0);
  A.create(r, { title: 'Briefing', atMs: mon, repeat: 'weekdays', kind: 'briefing', actor: HUMAN, now: mon - 86400000, env: ENV });
  if (extra) handWritten(r, extra);
  return { r, mon, tue: wall(2026, 10, 6, 7, 0) };
}

test('briefing: the day line opens the letter and the subject; quiet has none', (t) => {
  const { r, mon } = briefed(t, [
    duty({ title: 'Late', owner: 'alex', due: '2026-10-01' }),
    duty({ title: 'Today', owner: 'alex', due: '2026-10-05' }),
    duty({ title: 'Agent late', owner: 'vm-admin', due: '2026-10-01' }),
  ]);
  C.tick(r, { now: mon + 1000, env: ENV });
  const m = briefings(r)[0];
  assert.match(m.subject, /^Today in the calendar \(Monday, 2026-10-05\) - 1 deadline overdue, 1 due today$/);
  assert.match(m.text, /\nDay line: 1 deadline overdue · 1 due today\n/);
  // quiet: no day line at all
  const q = briefed(t);
  C.tick(q.r, { now: q.mon + 1000, env: ENV });
  const quiet = briefings(q.r)[0];
  assert.equal(quiet.subject, 'Today in the calendar (Monday, 2026-10-05)');
  assert.doesNotMatch(quiet.text, /Day line:/);
  assert.doesNotMatch(quiet.text, /Week review/);
});

test('briefing: a deadlines read error says "not measurable" in the day line, not nothing', (t) => {
  const { r, mon } = briefed(t);
  fs.mkdirSync(dutiesFile(r), { recursive: true });
  const h = T.today(r, { now: mon + 1000 });
  assert.equal(h.dayLine.overdue, null);
  assert.match(T.briefingText(h), /Day line: deadlines not measurable/);
  assert.match(T.briefingSubject(h), /deadlines not measurable/);
  assert.equal(T.machine(h).empty, false, 'a day that says "not measurable" is not an empty day');
});

test('briefing: the week review comes on Monday, only when a deadline fell due last week or falls due this week - not on Tuesday', (t) => {
  const { r, mon, tue } = briefed(t, [
    duty({ id: 'wk000001', title: 'Last week, open', owner: 'alex', due: '2026-10-02' }),
    duty({ id: 'wk000002', title: 'Last week, done', owner: 'alex', due: '2026-10-01' }),
    duty({ id: 'wk000003', title: 'Last week, dropped', owner: 'alex', due: '2026-09-30' }),
    duty({ id: 'wk000004', title: 'This week', owner: 'alex', due: '2026-10-08' }),
    duty({ id: 'wk000005', title: 'Next week', owner: 'alex', due: '2026-10-12' }),
    duty({ id: 'wk000006', title: 'Agent, last week', owner: 'vm-admin', due: '2026-10-02' }),
  ]);
  const closing = (target, state) => ({ id: id(), ts: '2026-10-03T10:00:00Z', agent: 'human:alex', closes_id: target, state });
  handWritten(r, [closing('wk000002', 'done'), closing('wk000003', 'dropped')]);
  const tickMon = C.tick(r, { now: mon + 1000, env: ENV });
  assert.equal(tickMon.fired.filter((x) => x.outcome === 'briefing').length, 1);
  const monday = briefings(r).find((m) => /Monday/.test(m.subject));
  assert.match(monday.text, /Week review/);
  assert.match(monday.text, /- Last week: 3 deadlines fell due: 1 done, 1 dropped, 1 still open/);
  assert.match(monday.text, /- Overdue now: 1/);
  assert.match(monday.text, /- Due this week: 1 deadline$/m);
  assert.match(monday.text, /- Projects awaiting confirmation: 0/);
  C.tick(r, { now: tue + 1000, env: ENV });
  const tuesday = briefings(r).find((m) => /Tuesday/.test(m.subject));
  assert.ok(tuesday, 'the briefing of Tuesday came');
  assert.doesNotMatch(tuesday.text, /Week review/, 'Tuesday has no review');
  // a quiet week: duties exist, but none fell due last week or falls due this week - no block even on Monday
  const q = briefed(t, [duty({ title: 'Far away', owner: 'alex', due: '2026-12-24' }), duty({ title: 'Long ago', owner: 'alex', due: '2026-08-01' })]);
  C.tick(q.r, { now: q.mon + 1000, env: ENV });
  assert.doesNotMatch(briefings(q.r)[0].text, /Week review/);
});

test('briefing: the week review ALONE keeps a day from being empty (machine form); without it the day is empty', (t) => {
  const quiet = briefed(t);
  assert.equal(T.machine(T.today(quiet.r, { now: quiet.mon + 1000 })).empty, true, 'positive control: nothing at all is an empty day');
  const { r, mon } = briefed(t, [duty({ id: 'wk100001', title: 'Done last week', owner: 'alex', due: '2026-10-02' })]);
  handWritten(r, [{ id: id(), ts: '2026-10-02T10:00:00Z', agent: 'human:alex', closes_id: 'wk100001', state: 'done' }]);
  const h = T.today(r, { now: mon + 1000 });
  assert.equal(h.duties.due.length, 0, 'no duty due today or overdue');
  assert.equal(h.dayLine.overdue, 0);
  assert.equal(h.week.show, true);
  const m = T.machine(h);
  assert.equal(m.empty, false, 'only the review is there');
  assert.equal(m.week_review.last.done, 1);
  // the same on Tuesday: no review, so the day is empty again
  assert.equal(T.machine(T.today(r, { now: wall(2026, 10, 6, 7, 0) })).empty, true);
});

test('week boundaries are Monday 00:00 to Monday 00:00 in the HOUSE zone, over midnight and both clock changes', () => {
  const days = (iso, zone = BERLIN) => deadlines.weekDays(ms(iso), zone);
  // Berlin midnight: Sunday 23:59 (CEST) is still the old week, Monday 00:00 is the new one - UTC says 21:59Z and 22:00Z
  assert.deepEqual(days('2026-10-04T21:59:00Z'), { lastFrom: '2026-09-21', from: '2026-09-28', to: '2026-10-05' });
  assert.deepEqual(days('2026-10-04T22:00:00Z'), { lastFrom: '2026-09-28', from: '2026-10-05', to: '2026-10-12' });
  assert.equal(deadlines.isoWeekday(ms('2026-10-04T22:00:00Z'), BERLIN), 1, 'Monday in Berlin, while UTC still says Sunday');
  // the autumn change (Sunday 2026-10-25, a day of 25 hours): Monday starts 23:00Z, not 22:00Z
  assert.deepEqual(days('2026-10-25T22:59:00Z'), { lastFrom: '2026-10-12', from: '2026-10-19', to: '2026-10-26' });
  assert.deepEqual(days('2026-10-25T23:00:00Z'), { lastFrom: '2026-10-19', from: '2026-10-26', to: '2026-11-02' });
  // the spring change (Sunday 2026-03-29, a day of 23 hours): Monday starts 22:00Z
  assert.deepEqual(days('2026-03-29T21:59:00Z'), { lastFrom: '2026-03-16', from: '2026-03-23', to: '2026-03-30' });
  assert.deepEqual(days('2026-03-29T22:00:00Z'), { lastFrom: '2026-03-23', from: '2026-03-30', to: '2026-04-06' });
  // the same instant is another week in another zone
  assert.deepEqual(days('2026-10-04T22:00:00Z', 'America/New_York'), { lastFrom: '2026-09-21', from: '2026-09-28', to: '2026-10-05' });
  // and the classification follows: a duty due Sunday 10-04 is "last week" at Monday 00:30 Berlin, not "this week"
  const fold = { open: [{ id: 'a0000001', ts: '2026-09-01T00:00:00Z', owner: 'alex', due: '2026-10-04' }, { id: 'a0000002', ts: '2026-09-01T00:00:00Z', owner: 'alex', due: '2026-10-05' }], done: [] };
  const w = deadlines.week(fold, { human: 'alex', now: ms('2026-10-04T22:30:00Z'), zone: BERLIN });
  assert.deepEqual([w.last.total, w.thisWeek.total, w.show], [1, 1, true]);
  // positive control: read as UTC the same instant is still Sunday and both duties would fall into "last week" and "this week"
  // the other way round - the zone is what puts them right
  const utc = deadlines.week(fold, { human: 'alex', now: ms('2026-10-04T22:30:00Z'), zone: 'UTC' });
  assert.deepEqual([utc.last.total, utc.thisWeek.total], [0, 1], 'UTC: Sunday 10-04 is the current week, 10-05 is the next one');
});

// ---------------------------------------------------------------- 5. the doctor

test('doctor `deadlines`: warn on an overdue duty without movement, on an unreadable value and on an old field name', (t) => {
  const root = world(t);
  const at = new Date('2026-10-12T10:00:00Z');
  handWritten(root, [duty({ id: 'st000001', title: 'Stale', owner: 'user', due: '2026-10-01' })]);
  const stale = doctor.checkDeadlines(root, at);
  assert.equal(stale.level, 'warn');
  assert.match(stale.text, /1 of 1 open duties carry a due date: 1 overdue by more than 1 day without movement, 0 with an unreadable value, 0 under an old field name/);
  assert.match(stale.advice, /st000001/);
  assert.match(stale.advice, /mem duties close st000001/);
  // movement: a later line of the chain (a correction after it became overdue) is not "without movement"
  memory.correctionEntry(root, 'duty', 'st000001', { title: 'Stale', owner: 'user', due: '2026-10-01', ts: '2026-10-10T09:00:00Z' });
  assert.equal(doctor.checkDeadlines(root, at).level, 'good', 'moved/touched since it became overdue');
  // overdue for less than the grace: good
  const young = world(t);
  handWritten(young, [duty({ title: 'Just late', owner: 'user', due: '2026-10-11' })]);
  assert.equal(doctor.checkDeadlines(young, new Date('2026-10-12T06:00:00Z')).level, 'good', 'overdue since 00:00 of the 12th: not yet a day');
  assert.equal(doctor.checkDeadlines(young, new Date('2026-10-13T10:00:00Z')).level, 'warn', 'a day later it is');
  // unreadable value
  const bad = world(t);
  handWritten(bad, [duty({ title: 'Soon-ish', owner: 'user', due: 'soon' }), duty({ title: 'Fine', owner: 'user', due: '2026-12-24' })]);
  const b = doctor.checkDeadlines(bad, at);
  assert.equal(b.level, 'warn');
  assert.match(b.text, /1 with an unreadable value/);
  // old field name: still read, but named
  const old = world(t);
  handWritten(old, [duty({ title: 'Old name', owner: 'user', deadline: '2026-12-24' })]);
  const o = doctor.checkDeadlines(old, at);
  assert.equal(o.level, 'warn');
  assert.match(o.text, /1 under an old field name/);
  assert.match(o.advice, /deadline/);
  // good: due dates that are fine
  const fine = world(t);
  handWritten(fine, [duty({ title: 'Fine', owner: 'user', due: '2026-12-24' })]);
  const g = doctor.checkDeadlines(fine, at);
  assert.equal(g.level, 'good');
  assert.match(g.text, /1 of 1 open duties carry a due date/);
});

test('doctor `deadlines`: "good over nothing" is unknown - nothing to judge, an unreadable drawer, an unusable zone', (t) => {
  const at = new Date('2026-10-12T10:00:00Z');
  const none = world(t);
  const a = doctor.checkDeadlines(none, at);
  assert.equal(a.level, 'unknown');
  assert.match(a.text, /no open duties at all/);
  const undated = world(t);
  handWritten(undated, [duty({ title: 'No date', owner: 'user' })]);
  const b = doctor.checkDeadlines(undated, at);
  assert.equal(b.level, 'unknown');
  assert.match(b.text, /none of the 1 open duties carries a due date/);
  // positive control: one dated duty and the same store is judged
  handWritten(undated, [duty({ title: 'Dated', owner: 'user', due: '2026-12-24' })]);
  assert.equal(doctor.checkDeadlines(undated, at).level, 'good');
  const broken = world(t);
  fs.mkdirSync(dutiesFile(broken), { recursive: true });
  const c = doctor.checkDeadlines(broken, at);
  assert.equal(c.level, 'unknown');
  assert.match(c.text, /unknown, not zero/);
  const zone = world(t, { timezone: 'Mars/Olympus' });
  handWritten(zone, [duty({ title: 'Dated', owner: 'user', due: '2026-10-01' })]);
  assert.equal(doctor.checkDeadlines(zone, at).level, 'unknown');
  // the finding is in the doctor's run, once, and is never an error
  const all = doctor.checkAll(undated).findings.filter((f) => f.name === 'deadlines');
  assert.equal(all.length, 1);
  assert.notEqual(all[0].level, 'error');
});

test('doctor `deadlines` is in the finding map with an honest one-sided entry, German and English numbers equal', () => {
  const rows = fs.readFileSync(path.join(REPO, 'shared', 'finding-map.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const row = rows.find((x) => x.finding === 'deadlines');
  assert.ok(row, 'the finding has a line in the map');
  assert.equal(row.nur, 'finding');
  assert.equal(row['luecke'], true);
  assert.deepEqual((row['warum'].match(/\d+/g) || []).sort(), (row.why.match(/\d+/g) || []).sort());
});

// ---------------------------------------------------------------- 6. the before-edit list

test('before-edit: an overdue duty comes first, the longest overdue first - only the order, the cap and the content stay', (t) => {
  const root = world(t);
  const f = 'src/widget.mjs';
  handWritten(root, [
    duty({ id: 'be000001', ts: '2026-10-10T00:00:00Z', title: 'Newest, not due', file: f, owner: 'user', due: '2026-12-24' }),
    duty({ id: 'be000002', ts: '2026-10-09T00:00:00Z', title: 'Newer, no date', file: f, owner: 'user' }),
    duty({ id: 'be000003', ts: '2026-09-01T00:00:00Z', title: 'Oldest, overdue a week', file: f, owner: 'user', due: '2026-10-05' }),
    duty({ id: 'be000004', ts: '2026-09-02T00:00:00Z', title: 'Old, overdue a month', file: f, owner: 'user', due: '2026-09-10' }),
    duty({ id: 'be000005', ts: '2026-10-11T00:00:00Z', title: 'Elsewhere', file: 'other.mjs', owner: 'user', due: '2026-01-01' }),
  ]);
  const at = ms('2026-10-12T10:00:00Z');
  const got = errorcontext.beforeEditDuties(root, f, [], { cap: 2, now: at }).duties.map((d) => d.id);
  assert.deepEqual(got, ['be000004', 'be000003'], 'overdue first, the longest overdue first; the other file stays out');
  // the cap decides what is heard: with a cap of 3 the next is the newest of the rest, as before
  assert.deepEqual(errorcontext.beforeEditDuties(root, f, [], { cap: 3, now: at }).duties.map((d) => d.id), ['be000004', 'be000003', 'be000001']);
  // nothing overdue: the order is the old one (newest first)
  assert.deepEqual(errorcontext.beforeEditDuties(root, f, [], { cap: 2, now: ms('2026-09-01T00:00:00Z') }).duties.map((d) => d.id), ['be000001', 'be000002']);
  // through the hook command (the .sh and the .ps1 twin read this very list)
  const hook = JSON.parse(cli(root, 'component', f, '--hook', '--json').stdout);
  assert.equal(hook.duties.length, 2);
  assert.equal(hook.duties[0].id, 'be000004');
  for (const twin of ['mem-before-edit', 'mem-before-edit.ps1']) {
    assert.match(fs.readFileSync(path.join(REPO, 'bin', twin), 'utf8'), /j\.duties/, `${twin} shows the list in the order it receives`);
  }
});

// ---------------------------------------------------------------- 7. the dashboard

test('dashboard data: both builds carry the part; the compact build above its module limit says so, never 0', (t) => {
  const root = world(t);
  handWritten(root, [duty({ title: 'Late', owner: 'user', due: '2026-10-01' }), duty({ title: 'Agent', owner: 'session', due: '2026-10-01' })]);
  const env = { CHEAP_MEM_TZ: BERLIN, CHEAP_MEM_GOLD_FILE: path.join(root, 'x') };
  const full = dd.collectDashboard(root, { now: NOW, env, doctorCheck: () => CALM_DOCTOR });
  assert.equal(full.deadlines.readable, true);
  assert.deepEqual([full.deadlines.mine.overdue, full.deadlines.others.overdue], [1, 1]);
  const small = compact.collectCompact(root, { now: NOW, env, bytes: 1, modulesUpTo: 1e9 });
  assert.equal(small.deadlines.readable, true, 'the compact build computes it from the duties it read');
  assert.deepEqual(small.deadlines.mine.list.map((x) => x.state), ['overdue']);
  assert.deepEqual(small.deadlines.mine, full.deadlines.mine, 'one computation: the two builds agree');
  const over = compact.collectCompact(root, { now: NOW, env, bytes: 500 * 1048576 });
  assert.equal(over.deadlines.readable, false);
  assert.match(over.deadlines.reason, /not computed in the compact build/);
  assert.equal(over.deadlines.mine, undefined, 'no invented number');
});

test('dashboard page: the Today card draws the part and the chip from the data; a missing part draws nothing; not measurable is said', () => {
  const js = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
  assert.match(js, /function todayDeadlinesPart\(dl\)/);
  assert.match(js, /deadlinesDrawn/);
  assert.match(js, /function dueChip\(state\)/);
  assert.match(js, /dueChip\(dt\.dueState\)/, 'the chip sits next to each decision for the human');
  assert.match(js, /Not measurable/);
  // the pure part of the page script, run on its own: a due DAY is shown as it is, not moved by the browser's zone
  assert.match(js, /const dueShown = \(v\) => \(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(String\(v\)\) \? String\(v\) : when\(v\)\);/);
});

// ---------------------------------------------------------------- 8. red on the base

test('RED on the base 6390925: no deadlines part, no week review, no doctor finding, the old line cuts mid-word', () => {
  const BASE = '6390925';
  const show = (file) => execFileSync('git', ['show', `${BASE}:${file}`], { cwd: REPO, encoding: 'utf8' });
  assert.throws(() => show('src/deadlines.mjs'), /does not exist|exists on disk, but not in/);
  assert.throws(() => show('src/dayline.mjs'), /does not exist|exists on disk, but not in/);
  assert.doesNotMatch(show('src/today.mjs'), /deadlinesPart/);
  assert.doesNotMatch(show('src/doctor.mjs'), /checkDeadlines/);
  assert.doesNotMatch(show('src/appointment-today.mjs'), /week_review|Week review/);
  assert.match(show('src/today.mjs'), /text\.slice\(0, LINE_MAX - 1\)\}…/, 'positive control: the base line is cut at the limit with an ellipsis');
});
