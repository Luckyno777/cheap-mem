// The due-date core (build plan Q1, step 6b, branch A; the sibling house builds the same as src/faelligkeit.mjs).
//
// What is proven here — and is red on origin/main (there is no src/due.mjs, no --due, no `mem deadlines`):
//   1. The value form: exactly two forms, zone-less refused; the same refusal on every write path (mem log, mem_log,
//      mem correction).
//   2. The state table across midnight of the house zone and both clock changes, plus a SECOND zone.
//   3. Moving a due date is append-only: the original stays byte for byte, a lower tier is refused, the debtor may.
//   4. Age doping: "open since" is the start of the chain; overdue is computed from the due date.
//   5. One place: no module besides src/due.mjs reads the field (bench/calculations.mjs, with a positive control).
//   6. Output guard (on by default, UNGUARDED exceptions, masking) and an encrypted duty whose due date stays readable.
//   7. The parity table of field names and the shared fixture (same fixture, same state in both houses).
//
// invariant: frist-eine-stelle
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as due from '../src/due.mjs';
import * as memory from '../src/memory.mjs';
import * as bridgefields from '../src/bridgefields.mjs';
import * as shred from '../src/shred.mjs';
import * as fieldshape from '../src/fieldshape.mjs';
import * as appointmentToday from '../src/appointment-today.mjs';
import * as todayMod from '../src/today.mjs';
import * as calculations from '../bench/calculations.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const BERLIN = 'Europe/Berlin';
const ms = (iso) => Date.parse(iso);
const FAKE_TOKEN = `ghp${'_'}${'Q'.repeat(36)}`; // assembled at run time, never a literal

const cli = (root, ...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root],
  { encoding: 'utf8', input: '', timeout: 60000, env: { ...process.env, CHEAP_MEM_AGENT: 'due-test', CHEAP_MEM_TZ: BERLIN } });

function bridge(root, calls) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  let id = 10;
  for (const [name, a] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  }
  const r = spawnSync(process.execPath, [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'session', CHEAP_MEM_TZ: BERLIN },
  });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  if (replies.length < calls.length + 1) throw new Error(`bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 800)}`);
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

function world(t) {
  const root = tempDir('cheap-mem-due-', t);
  assert.equal(cli(root, 'init').status, 0);
  return root;
}
const file = (root, name = 'duties.jsonl') => path.join(root, 'global', name);
const lines = (root, name) => (fs.existsSync(file(root, name))
  ? fs.readFileSync(file(root, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const raw = (root, name) => (fs.existsSync(file(root, name)) ? fs.readFileSync(file(root, name)) : Buffer.alloc(0));
const handWritten = (root, objects) => {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.appendFileSync(file(root), objects.map((o) => `${JSON.stringify(o)}\n`).join(''));
};

// ---------------------------------------------------------------- 1. the value form

test('parseDue: exactly two forms — a day in the house zone, or an ISO point in time with a zone', () => {
  const day = due.parseDue('2026-10-12', { zone: BERLIN });
  assert.equal(day.ok, true);
  assert.equal(day.kind, 'day');
  assert.equal(day.day, '2026-10-12');
  assert.equal(day.dueFromMs, ms('2026-10-11T22:00:00Z'), 'midnight in Berlin (CEST), not in UTC');
  assert.equal(day.overdueFromMs, ms('2026-10-12T22:00:00Z'));
  for (const v of ['2026-11-01T17:00:00Z', '2026-11-01T17:00:00+01:00', '2026-11-01T17:00Z', '2026-11-01T17:00:00.250-05:00']) {
    const p = due.parseDue(v, { zone: BERLIN });
    assert.equal(p.ok, true, v);
    assert.equal(p.kind, 'instant', v);
  }
  assert.equal(due.parseDue('2026-11-01T17:00:00+01:00', { zone: BERLIN }).overdueFromMs, ms('2026-11-01T16:00:00Z'));
  assert.equal(due.parseDue('2026-11-01T23:30:00Z', { zone: BERLIN }).day, '2026-11-02', 'the calendar day of the point in the house zone');
  assert.equal(due.parseDue('2026-11-01T23:30:00Z', { zone: 'America/New_York' }).day, '2026-11-01');
});

test('parseDue: zone-less, other forms, impossible days and non-text are refused (never guessed)', () => {
  const noZone = due.parseDue('2026-11-01T17:00', { zone: BERLIN });
  assert.equal(noZone.ok, false);
  assert.match(noZone.reason, /zone/);
  assert.match(due.parseDue('2026-11-01 17:00', { zone: BERLIN }).reason, /zone/);
  for (const v of ['01.11.2026', '2026/11/01', '2026-11-1', 'soon', '', ' 2026-11-01', '2026-11-01 ', '2026-02-30', '2026-13-01',
    '1999-12-31', '2026-11-01T24:00:00Z', '2026-11-01T17:61:00Z', '2026-11-01T17:00:00+25:00', 20261101, null, undefined, {}, ['2026-11-01'], true]) {
    assert.equal(due.parseDue(v, { zone: BERLIN }).ok, false, `${JSON.stringify(v)} must be refused`);
  }
});

const GOOD = ['2026-11-01', '2026-11-01T17:00:00+01:00', '2026-11-01T16:00:00Z'];
const BAD = ['2026-11-01T17:00', 'soon', '01.11.2026', '2026-02-30', '2026-11-1'];

test('write path 1, mem log: --due on a duty in both forms; zone-less and nonsense refused loudly, nothing written', (t) => {
  const root = world(t);
  for (const v of GOOD) {
    const r = cli(root, 'log', 'duty', '--title', `D ${v}`, '--owner', 'human', '--due', v);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(lines(root).map((e) => e.due), GOOD);
  const before = raw(root);
  for (const v of BAD) {
    const r = cli(root, 'log', 'duty', '--title', 'X', '--owner', 'human', '--due', v);
    assert.notEqual(r.status, 0, `${v} must be refused`);
    assert.match(r.stderr, /'due'/, r.stderr);
    assert.match(r.stderr, /nothing was written/i);
  }
  assert.notEqual(cli(root, 'log', 'duty', '--title', 'X', '--due').status, 0, '--due without a value');
  assert.deepEqual(raw(root), before, 'no refused input left a line behind');
});

test('write path 2, mem_log (bridge): the same form, the same refusal; `due` is on the allowed list of a duty only', (t) => {
  const root = world(t);
  const answers = bridge(root, [
    ...GOOD.map((v) => ['mem_log', { type: 'duty', title: `B ${v}`, owner: 'human', due: v }]),
    ...BAD.map((v) => ['mem_log', { type: 'duty', title: 'X', due: v }]),
    ['mem_log', { type: 'duty', title: 'X', due: 20261101 }],
    ['mem_log', { type: 'duty', title: 'X', due: ['2026-11-01'] }],
  ]);
  GOOD.forEach((v, i) => assert.ok(!answers[i].isError, `${v}: ${textOf(answers[i])}`));
  answers.slice(GOOD.length).forEach((a, i) => {
    assert.equal(a.isError, true, `refusal ${i}: ${textOf(a)}`);
    assert.match(textOf(a), /due/);
  });
  assert.deepEqual(lines(root).map((e) => e.due), GOOD, 'only the good ones were written');
  assert.ok(bridgefields.ALLOWED_FIELDS.duty.includes('due'));
  for (const alias of ['due_date', 'until', 'deadline', 'by']) {
    assert.ok(!bridgefields.ALLOWED_FIELDS.duty.includes(alias), `${alias} is read, no longer written over the bridge`);
  }
  for (const [type, fields] of Object.entries(bridgefields.ALLOWED_FIELDS)) {
    if (type !== 'duty') assert.ok(!fields.includes('due'), `${type} must not carry a due date over the bridge`);
  }
});

test('write path 3, mem correction: a NAMED due is checked like a written one; an inherited broken one blocks nothing', (t) => {
  const root = world(t);
  const { entry } = memory.logCheckedEntry(root, 'duty', { title: 'Tax', owner: 'human', due: '2026-11-01' });
  const before = raw(root);
  const bad = cli(root, 'correction', 'duty', entry.id, '--due', '2026-11-01T10:00');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /zone/);
  assert.deepEqual(raw(root), before);
  // an old hand-written line with a broken due date: a correction of something else must still work
  handWritten(root, [{ id: 'hand0001', ts: '2026-09-01T00:00:00Z', title: 'By hand', owner: 'human', due: 'sometime' }]);
  const ok = cli(root, 'correction', 'duty', 'hand0001', '--tags', 'x');
  assert.equal(ok.status, 0, ok.stderr);
  // a due date on another type is refused on the correction path as well
  const th = memory.logCheckedEntry(root, 'thought', { text: 'a thought' });
  const nope = cli(root, 'correction', 'thought', th.entry.id, '--due', '2026-11-01');
  assert.notEqual(nope.status, 0);
  assert.match(nope.stderr, /only on a duty/);
});

test('a due date only on a duty: every other type refuses it — CLI, bridge, and the write core', (t) => {
  const root = world(t);
  for (const type of ['decision', 'error', 'event', 'thought', 'learning']) {
    const r = cli(root, 'log', type, '--title', 'T', '--text', 't', '--due', '2026-11-01');
    assert.notEqual(r.status, 0, `CLI ${type}`);
    assert.match(r.stderr, /only on a duty/, `CLI ${type}: ${r.stderr}`);
    const [b] = bridge(root, [['mem_log', { type, title: 'T', text: 't', due: '2026-11-01' }]]);
    assert.equal(b.isError, true, `bridge ${type}`);
  }
  assert.throws(() => memory.logCheckedEntry(root, 'thought', { text: 'x', due: '2026-11-01' }), /only on a duty/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'global')).filter((f) => f.endsWith('.jsonl') && fs.statSync(file(root, f)).size > 0), [],
    'nothing was written on any path');
});

// ------------------------------------------------------------ 2. the state table

const TABLE = [
  // [due, now, expected state, remark] — house zone Europe/Berlin
  ['2026-10-12', '2026-10-11T21:59:59Z', 'fresh', 'one second before Berlin midnight'],
  ['2026-10-12', '2026-10-11T22:00:00Z', 'due', 'Berlin midnight (00:00 CEST)'],
  ['2026-10-12', '2026-10-12T12:00:00Z', 'due', 'noon'],
  ['2026-10-12', '2026-10-12T21:59:59Z', 'due', 'one second before midnight of the following day'],
  ['2026-10-12', '2026-10-12T22:00:00Z', 'overdue', 'overdue from 00:00 of the following day'],
  ['2026-10-12', '2026-10-12T23:30:00Z', 'overdue', 'a UTC day would still say due'],
  ['2026-10-13', '2026-10-12T23:30:00Z', 'due', 'a UTC day would still say fresh'],
  // autumn change 2026-10-25: the day has 25 hours (00:00 CEST to 00:00 CET)
  ['2026-10-25', '2026-10-24T21:59:59Z', 'fresh', 'before midnight CEST'],
  ['2026-10-25', '2026-10-24T22:00:00Z', 'due', '00:00 CEST'],
  ['2026-10-25', '2026-10-25T22:00:00Z', 'due', '23:00 CET — a 24-hour calculation says overdue already'],
  ['2026-10-25', '2026-10-25T22:59:59Z', 'due', 'last second of the 25-hour day'],
  ['2026-10-25', '2026-10-25T23:00:00Z', 'overdue', '00:00 CET of the 26th'],
  ['2026-10-24', '2026-10-24T22:00:00Z', 'overdue', 'the day before ends on the same boundary'],
  // spring change 2027-03-28: the day has 23 hours (00:00 CET to 00:00 CEST)
  ['2027-03-28', '2027-03-27T22:59:59Z', 'fresh', 'before midnight CET'],
  ['2027-03-28', '2027-03-27T23:00:00Z', 'due', '00:00 CET'],
  ['2027-03-28', '2027-03-28T21:59:59Z', 'due', '23:59:59 CEST'],
  ['2027-03-28', '2027-03-28T22:00:00Z', 'overdue', '00:00 CEST of the 29th — a 24-hour calculation says an hour later'],
  // a point in time with a zone: due on its Berlin day up to the point, overdue FROM the point
  ['2026-10-12T15:00:00+02:00', '2026-10-11T21:59:59Z', 'fresh', 'point: the day before'],
  ['2026-10-12T15:00:00+02:00', '2026-10-11T22:00:00Z', 'due', 'point: the day begins'],
  ['2026-10-12T15:00:00+02:00', '2026-10-12T12:59:59Z', 'due', 'point: one second before'],
  ['2026-10-12T15:00:00+02:00', '2026-10-12T13:00:00Z', 'overdue', 'point: from the point on'],
  ['2026-10-12T15:00:00Z', '2026-10-12T15:00:00Z', 'overdue', 'the same clock time in UTC is another Berlin hour'],
];
for (const [value, now, expected, remark] of TABLE) {
  test(`state table (${BERLIN}): ${value} at ${now} -> ${expected} (${remark})`, () => {
    assert.equal(due.state(value, ms(now), { zone: BERLIN }), expected);
    assert.equal(due.state(value, new Date(now), { zone: BERLIN }), expected, 'a Date instead of milliseconds acts the same');
  });
}

// A SECOND zone: the boundary is midnight THERE, and its own clock changes (US: 2026-11-01 has 25 hours, 2027-03-14 has 23).
const TABLE_NY = [
  ['2026-10-12', '2026-10-12T03:59:59Z', 'fresh', 'before midnight EDT (04:00Z)'],
  ['2026-10-12', '2026-10-12T04:00:00Z', 'due', '00:00 EDT'],
  ['2026-10-12', '2026-10-13T03:59:59Z', 'due', 'last second of the day'],
  ['2026-10-12', '2026-10-13T04:00:00Z', 'overdue', '00:00 EDT of the 13th'],
  ['2026-11-01', '2026-11-02T04:59:59Z', 'due', '23:59:59 EST — the 25-hour day (Berlin changed a week earlier)'],
  ['2026-11-01', '2026-11-02T05:00:00Z', 'overdue', '00:00 EST of the 2nd'],
  ['2027-03-14', '2027-03-15T03:59:59Z', 'due', '23:59:59 EDT — the 23-hour day'],
  ['2027-03-14', '2027-03-15T04:00:00Z', 'overdue', '00:00 EDT of the 15th'],
];
for (const [value, now, expected, remark] of TABLE_NY) {
  test(`state table (America/New_York): ${value} at ${now} -> ${expected} (${remark})`, () => {
    assert.equal(due.state(value, ms(now), { zone: 'America/New_York' }), expected);
  });
}

test('the same instant is overdue in one zone and still fresh in another (the zone is part of the question)', () => {
  const now = ms('2026-10-12T22:30:00Z');
  assert.equal(due.state('2026-10-12', now, { zone: BERLIN }), 'overdue');
  assert.equal(due.state('2026-10-12', now, { zone: 'America/New_York' }), 'due');
  assert.equal(due.state('2026-10-12', now, { zone: 'Pacific/Auckland' }), 'overdue');
  assert.equal(due.state('2026-10-13', now, { zone: 'Pacific/Kiritimati' }), 'due', 'UTC+14: it is the 13th, early afternoon, there');
  assert.equal(due.state('2026-10-12', now, { zone: 'Pacific/Kiritimati' }), 'overdue');
});

test('state unknown: no value, broken value, no usable clock — never fresh or overdue by guess', () => {
  for (const v of [null, undefined, '', 'soon', '2026-11-01T17:00', 7, {}]) {
    assert.equal(due.state(v, ms('2026-10-12T10:00:00Z'), { zone: BERLIN }), 'unknown', JSON.stringify(v));
  }
  assert.equal(due.state('2026-10-12', Number.NaN, { zone: BERLIN }), 'unknown');
  assert.deepEqual(Object.values(due.STATE).sort(), ['due', 'fresh', 'overdue', 'unknown']);
});

// ------------------------------------------------------------------ situation / core

test('situationFromOpen: counts per state, separates "no due date" from "unreadable", sorts by due date, unreadable last', () => {
  const now = ms('2026-10-12T10:00:00Z');
  const open = [
    { id: 'a', title: 'fresh', owner: 'human', due: '2026-12-01', ts: '2026-09-01T00:00:00Z' },
    { id: 'b', title: 'overdue', due: '2026-10-01', ts: '2026-09-02T00:00:00Z' },
    { id: 'c', title: 'today', due: '2026-10-12', ts: '2026-09-03T00:00:00Z' },
    { id: 'd', title: 'without', ts: '2026-09-04T00:00:00Z' },
    { id: 'e', title: 'broken', due: 'sometime', ts: '2026-09-05T00:00:00Z' },
    { id: 'f', title: 'more overdue', due: '2026-09-30', ts: '2026-09-06T00:00:00Z' },
  ];
  const s = due.situationFromOpen(open, { now, zone: BERLIN });
  assert.deepEqual([s.open, s.withDue, s.withoutDue], [6, 5, 1]);
  assert.deepEqual([s.fresh, s.due, s.overdue, s.unknown], [1, 1, 2, 1]);
  assert.deepEqual(s.list.map((x) => x.id), ['f', 'b', 'c', 'a', 'e']);
  assert.deepEqual(s.list.map((x) => x.state), ['overdue', 'overdue', 'due', 'fresh', 'unknown']);
  assert.equal(s.list.find((x) => x.id === 'a').who, 'human');
  assert.equal(s.list.find((x) => x.id === 'e').day, null);
  assert.deepEqual([due.situationFromOpen([], { now, zone: BERLIN }).open, due.situationFromOpen(undefined, { now, zone: BERLIN }).open], [0, 0]);
});

test('dueValue / aliasUsed / openSince: the core knows the field name and its older aliases', () => {
  assert.equal(due.dueValue({ due: '2026-10-12' }), '2026-10-12');
  for (const alias of ['due_date', 'until', 'deadline', 'by']) {
    assert.equal(due.dueValue({ [alias]: '2026-10-12' }), '2026-10-12', `${alias} is still read`);
    assert.equal(due.aliasUsed({ [alias]: '2026-10-12' }), alias, `${alias} is named for the doctor`);
  }
  assert.equal(due.aliasUsed({ due: '2026-10-12', deadline: '2026-10-13' }), null, '`due` wins; no alias is "used"');
  assert.equal(due.dueValue({ due: '2026-10-12', deadline: '2026-10-13' }), '2026-10-12');
  for (const d of [{}, { due: null }, { due: '' }, null, undefined]) assert.equal(due.dueValue(d), null);
  assert.equal(due.dueValue({ due: 5 }), 5, 'an unreadable value comes out unchanged (state turns it into unknown)');
  assert.equal(due.openSince({ ts: '2026-10-02T00:00:00Z' }), '2026-10-02T00:00:00Z');
  assert.equal(due.openSince({ ts: '2026-10-02T00:00:00Z', _since: '2026-09-01T00:00:00Z' }), '2026-09-01T00:00:00Z');
});

// ------------------------------------------------ 3. moving: append-only, authority

test('moving: a correction inherits the rest, the original stays byte for byte, --without due removes the date', (t) => {
  const root = world(t);
  const a = cli(root, 'log', 'duty', '--title', 'Tax', '--text', 'documents', '--owner', 'human', '--tags', 'tax', '--due', '2026-11-01');
  assert.equal(a.status, 0, a.stderr);
  const id = lines(root)[0].id;
  const before = raw(root);
  const k = cli(root, 'correction', 'duty', id, '--due', '2026-11-15');
  assert.equal(k.status, 0, k.stderr);
  assert.ok(raw(root).subarray(0, before.length).equals(before), 'the original is untouched, the correction only appended');
  const [old, next] = lines(root);
  assert.equal(old.due, '2026-11-01');
  assert.equal(next.due, '2026-11-15');
  assert.equal(next.replaces_id, id);
  assert.deepEqual([next.title, next.text, next.owner, next.tags], ['Tax', 'documents', 'human', ['tax']], 'the rest is inherited');
  const open = memory.openDuties(root).open;
  assert.equal(open.length, 1, 'one chain, one open duty');
  assert.equal(due.dueValue(open[0]), '2026-11-15');
  const r = cli(root, 'correction', 'duty', next.id, '--without', 'due');
  assert.equal(r.status, 0, r.stderr);
  const last = lines(root).at(-1);
  assert.equal(Object.hasOwn(last, 'due'), false);
  assert.equal(last.title, 'Tax');
  assert.equal(due.dueValue(memory.openDuties(root).open[0]), null);
});

test('authority when moving or removing a due date (owner decision R): only the author or a higher tier counts — not the debtor, not the same tier', (t) => {
  const warnings = [];
  const keep = process.emitWarning;
  const quiet = () => { process.emitWarning = (m, o) => warnings.push(`${o?.code ?? ''} ${m}`); };
  const loud = () => { process.emitWarning = keep; };
  const root = world(t);
  const { entry: p } = memory.logCheckedEntry(root, 'duty', { title: 'Report', owner: 'agent-b', due: '2026-11-01', agent: 'agent-a' });
  const before = raw(root);
  // (a) a stranger of the SAME tier: disputed — the original keeps its date, the writer hears it now
  quiet();
  try { memory.correctionEntry(root, 'duty', p.id, { due: '2026-12-31', agent: 'agent-c' }); } finally { loud(); }
  assert.ok(warnings.some((w) => /CM_STATE_CHANGE_REFUSED/.test(w)), '(a) the writer hears about it now');
  assert.ok(raw(root).subarray(0, before.length).equals(before), 'append-only');
  let st = memory.openDuties(root);
  assert.equal(st.refused.length, 1, '(a) the refusal is on record');
  assert.equal(due.dueValue(st.open.find((d) => d.id === p.id)), '2026-11-01', '(a) the original keeps its date');
  // (b) the debtor (owner) is NOT enough to move the date
  quiet();
  try { memory.correctionEntry(root, 'duty', p.id, { due: '2026-11-20', agent: 'agent-b' }); } finally { loud(); }
  st = memory.openDuties(root);
  assert.equal(st.refused.length, 2, '(b) refused as well');
  assert.equal(due.dueValue(st.open.find((d) => d.id === p.id)), '2026-11-01', '(b) the original keeps its date');
  // removing the date is moving it: the debtor cannot do that either
  quiet();
  try { memory.correctionEntry(root, 'duty', p.id, { agent: 'agent-b' }, { without: ['due'] }); } finally { loud(); }
  assert.equal(memory.openDuties(root).refused.length, 3, '(b2) removing needs the same standing');
  assert.equal(due.dueValue(memory.openDuties(root).open.find((d) => d.id === p.id)), '2026-11-01');
  // (c) the author may
  memory.correctionEntry(root, 'duty', p.id, { due: '2026-11-10', agent: 'agent-a' });
  st = memory.openDuties(root);
  assert.ok(!st.open.some((d) => d.id === p.id), '(c) replaced by the author');
  assert.ok(st.open.some((d) => due.dueValue(d) === '2026-11-10' && d.agent === 'agent-a'));
  // (d) a higher tier may
  const { entry: q } = memory.logCheckedEntry(root, 'duty', { title: 'Other', owner: 'agent-b', due: '2026-11-01', agent: 'agent-a' });
  memory.correctionEntry(root, 'duty', q.id, { due: '2026-11-25', agent: 'agent-d', authority: 'user' });
  st = memory.openDuties(root);
  assert.ok(!st.open.some((d) => d.id === q.id), '(d) replaced by a higher tier');
  assert.ok(st.open.some((d) => due.dueValue(d) === '2026-11-25' && d.agent === 'agent-d'));
});

test('the debtor still closes a duty and still corrects what is not the due date', (t) => {
  const root = world(t);
  const { entry: p } = memory.logCheckedEntry(root, 'duty', { title: 'Mine to do', owner: 'agent-b', due: '2026-11-01', agent: 'agent-a', authority: 'user' });
  // a correction that leaves the due date as it is (here: a tag) is not a due-date change: the closing rule applies as before
  memory.correctionEntry(root, 'duty', p.id, { tags: ['x'], agent: 'agent-b' });
  let st = memory.openDuties(root);
  assert.equal(st.refused.length, 0, 'the debtor may correct everything but the date');
  const stage = st.open.find((d) => d.agent === 'agent-b');
  assert.ok(stage, 'the debtor`s stage holds');
  assert.equal(due.dueValue(stage), '2026-11-01', 'the date was inherited, not changed');
  // closing: the debtor may
  memory.logEntry(root, 'duty', { closes_id: stage.id, state: 'done', why: 'done', agent: 'agent-b' });
  st = memory.openDuties(root);
  assert.equal(st.open.length, 0, 'the debtor closed it');
  assert.equal(st.refused.length, 0);
});

// ------------------------------------------------------------ 4. age doping

test('age doping: "open since" comes from the start of the chain, overdue from the due date', (t) => {
  const root = world(t);
  handWritten(root, [{ id: 'old00001', ts: '2026-08-01T00:00:00Z', title: 'Old', owner: 'human', agent: 'human:t', due: '2026-09-01' }]);
  memory.correctionEntry(root, 'duty', 'old00001', { due: '2026-12-01', agent: 'human:t' });
  const [d] = memory.openDuties(root).open;
  assert.notEqual(d.id, 'old00001');
  assert.equal(d._since, '2026-08-01T00:00:00Z');
  assert.equal(due.openSince(d), '2026-08-01T00:00:00Z');
  const now = ms('2026-10-12T10:00:00Z');
  assert.equal(due.state(due.dueValue(d), now, { zone: BERLIN }), 'fresh', 'a 70-day-old duty with a far due date is fresh');
  handWritten(root, [{ id: 'new00001', ts: '2026-10-01T00:00:00Z', title: 'New', owner: 'human' }]);
  assert.equal(Object.hasOwn(memory.openDuties(root).open.find((x) => x.id === 'new00001'), '_since'), false, 'no chain, no _since');
});

// ------------------------------------------------------------ 5. the readers

test('appointment-today: duties due today / overdue come from the core; the guessed names are gone, aliases still read', (t) => {
  const root = world(t);
  const now = ms('2026-10-12T10:00:00Z');
  handWritten(root, [
    { id: 'p0000001', ts: '2026-09-01T00:00:00Z', title: 'Tax', due: '2026-10-01' },
    { id: 'p0000002', ts: '2026-09-01T00:00:00Z', title: 'Later', due: '2026-12-01' },
    { id: 'p0000003', ts: '2026-09-02T00:00:00Z', title: 'No date' },
    { id: 'p0000004', ts: '2026-09-02T00:00:00Z', title: 'Today', due: '2026-10-12' },
    { id: 'p0000005', ts: '2026-09-02T00:00:00Z', title: 'Old alias', deadline: '2026-10-01' },
    { id: 'p0000006', ts: '2026-09-02T00:00:00Z', title: 'Broken', due: 'soon' },
  ]);
  const d = appointmentToday.today(root, { now, zone: BERLIN }).duties;
  assert.deepEqual(d.due.map((p) => [p.id, p.overdue]), [['p0000001', true], ['p0000005', true], ['p0000004', false]]);
  assert.equal(d.open, 6);
  assert.equal(d.withDate, 4, 'readable due dates: 0001, 0002, 0004 and the alias 0005 (0006 is unknown)');
  // Berlin midnight: at 22:30Z the 12th is already over in Berlin
  const late = appointmentToday.today(root, { now: ms('2026-10-12T22:30:00Z'), zone: BERLIN }).duties;
  assert.deepEqual(late.due.map((p) => [p.id, p.overdue]), [['p0000001', true], ['p0000005', true], ['p0000004', true]]);
  // another zone: the same instant, but in New York the 12th still runs
  const ny = appointmentToday.today(root, { now: ms('2026-10-12T22:30:00Z'), zone: 'America/New_York' }).duties;
  assert.deepEqual(ny.due.map((p) => [p.id, p.overdue]), [['p0000001', true], ['p0000005', true], ['p0000004', false]]);
});

test('today.decisionsForHuman: due and "since" from the core (the start of the chain)', (t) => {
  const root = world(t);
  handWritten(root, [
    { id: 'h0000001', ts: '2026-09-01T00:00:00Z', title: 'A', owner: 'human', agent: 'human:t', due: '2026-11-01' },
    { id: 'h0000002', ts: '2026-09-02T00:00:00Z', title: 'B', owner: 'human', by: '2026-11-01' },
  ]);
  memory.correctionEntry(root, 'duty', 'h0000001', { due: '2026-11-09', agent: 'human:t' });
  const list = todayMod.decisionsForHuman(root, { human: 'human' }).list;
  const a = list.find((x) => x.title === 'A');
  const b = list.find((x) => x.title === 'B');
  assert.equal(a.due, '2026-11-09');
  assert.equal(a.since, '2026-09-01T00:00:00Z', 'not the ts of the correction line');
  assert.equal(b.due, '2026-11-01', 'the older alias `by` is still read');
});

test('mem deadlines: list with states, --json, count without due date; mem duties shows the due column', (t) => {
  const root = world(t);
  for (const [title, d] of [['Long ago', '2020-01-01'], ['Far away', '2099-01-01'], ['No date', null]]) {
    const f = { title, owner: 'human' };
    if (d) f.due = d;
    memory.logCheckedEntry(root, 'duty', f);
  }
  handWritten(root, [{ id: 'hand0002', ts: '2026-09-01T00:00:00Z', title: 'By hand', owner: 'human', due: 'sometime' }]);
  const j = JSON.parse(cli(root, 'deadlines', '--json').stdout);
  assert.deepEqual([j.open, j.with_due, j.without_due], [4, 3, 1]);
  assert.deepEqual([j.fresh, j.due, j.overdue, j.unknown], [1, 0, 1, 1]);
  assert.equal(j.zone, BERLIN);
  assert.deepEqual(j.deadlines.map((x) => [x.title, x.state]), [['Long ago', 'overdue'], ['Far away', 'fresh'], ['By hand', 'unknown']]);
  assert.equal(Object.hasOwn(j.deadlines[0], 'overdueFromMs'), false, 'no internal numbers in the output');
  const text = cli(root, 'deadlines');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /3 open duties with a due date \(1 overdue, 0 due, 1 fresh, 1 unknown\), 1 without/);
  assert.match(text.stdout, /overdue\s+2020-01-01\s+\[\S+\]\s+@human\s+Long ago/);
  const duties = cli(root, 'duties');
  assert.match(duties.stdout, /Long ago\s+due 2020-01-01 \(overdue\)/);
  assert.match(duties.stdout, /Far away\s+due 2099-01-01 \(fresh\)/);
  assert.match(cli(root, 'deadlines', '--help').stdout, /mem deadlines/);
  assert.notEqual(cli(root, 'deadlines', '--nonsense').status, 0, 'unknown flags are refused');
});

test('MCP: mem_duties carries due and due_state, mem_deadlines the whole situation', (t) => {
  const root = world(t);
  memory.logCheckedEntry(root, 'duty', { title: 'With', owner: 'human', due: '2020-01-01' });
  memory.logCheckedEntry(root, 'duty', { title: 'Without', owner: 'human' });
  const [duties, deadlines] = bridge(root, [['mem_duties', {}], ['mem_deadlines', {}]]);
  assert.ok(!duties.isError, textOf(duties));
  const w = duties.structuredContent.duties.find((d) => d.title === 'With');
  const wo = duties.structuredContent.duties.find((d) => d.title === 'Without');
  assert.deepEqual([w.due, w.due_state], ['2020-01-01', 'overdue']);
  assert.deepEqual([wo.due, wo.due_state], [null, 'unknown']);
  assert.match(textOf(duties), /due 2020-01-01: overdue/);
  assert.ok(!deadlines.isError, textOf(deadlines));
  const s = deadlines.structuredContent;
  assert.deepEqual([s.open, s.with_due, s.without_due, s.overdue], [2, 1, 1, 1]);
  assert.equal(s.deadlines[0].title, 'With');
  assert.equal(s.zone, BERLIN);
});

// ------------------------------------------------ 6. output guard, encrypted duty

test('output guard: `deadlines` runs with the guard on and masks a key shape that sits past the write path (text and --json)', (t) => {
  const shell = fs.readFileSync(path.join(REPO, 'src', 'cli', 'shell.mjs'), 'utf8');
  const m = /const UNGUARDED = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\);/.exec(shell);
  assert.ok(m, 'UNGUARDED found');
  assert.doesNotMatch(m[1], /'deadlines'|'duties'/, 'the guard is on for these');
  assert.match(m[1], /'serve'/, 'positive control: the slice is the exception list');
  const root = world(t);
  handWritten(root, [{ id: 'g0000001', ts: '2026-09-01T00:00:00Z', title: `Access ${FAKE_TOKEN} check`, owner: 'human', due: '2099-01-01' }]);
  assert.ok(raw(root).includes(FAKE_TOKEN), 'precondition: the sample key sits unmasked on disk');
  for (const args of [['deadlines'], ['deadlines', '--json'], ['duties']]) {
    const r = cli(root, ...args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(FAKE_TOKEN), `${args.join(' ')}: the key must not appear`);
    assert.match(r.stdout, /Access .* check/);
  }
});

test('an encrypted duty keeps its due date READABLE (owner decision 2026-10-12): title and text in the envelope, the date in the clear', (t) => {
  assert.ok(shred.NEVER_ENCRYPT.includes('due'));
  assert.ok(!shred.SHREDDABLE_FIELDS.includes('due'), 'due is not a body field');
  const root = world(t);
  const CANARY = 'canaryduexq';
  const { entry } = memory.logCheckedEntry(root, 'duty', { title: `Doctor ${CANARY}`, text: `Result ${CANARY}`, owner: 'human', due: '2020-05-05', shred: true });
  const line = lines(root)[0];
  assert.ok(line.body_enc, 'encrypted');
  assert.equal(line.due, '2020-05-05', 'the due date stands in the clear');
  assert.equal(Object.hasOwn(line, 'title'), false);
  assert.equal(raw(root).includes(CANARY), false, 'title and text are not in the log');
  const open = memory.openDuties(root).open;
  assert.equal(open.length, 1);
  assert.equal(entry.id, open[0].id);
  assert.equal(due.state(due.dueValue(open[0]), ms('2026-10-12T10:00:00Z'), { zone: BERLIN }), 'overdue', 'THAT it is overdue can be said without the key');
  const j = JSON.parse(cli(root, 'deadlines', '--json').stdout);
  assert.deepEqual([j.with_due, j.overdue], [1, 1]);
  assert.equal(JSON.stringify(j).includes(CANARY), false);
});

test('old lines with a broken due value (123, true, "soon") stay open duties with the state unknown; only text or null is passed on', (t) => {
  for (const name of ['due', 'due_date', 'until', 'deadline', 'by']) {
    for (const v of [123, true, 'soon']) assert.equal(fieldshape.shapeProblem({ id: 'x', ts: 't', [name]: v }), null, `${name}: ${JSON.stringify(v)} is a scalar, no shape error`);
    // an object or a list of objects is a broken line by the GENERAL rule (accepted): "never vanishes" holds for scalars only
    assert.ok(fieldshape.shapeProblem({ id: 'x', ts: 't', [name]: { a: 1 } }), `${name}: an object is broken by the general rule`);
  }
  const root = world(t);
  handWritten(root, [
    { id: 'k0000001', ts: '2026-09-01T00:00:00Z', title: 'Number', owner: 'human', due: 123 },
    { id: 'k0000002', ts: '2026-09-01T00:00:00Z', title: 'Boolean', owner: 'human', due: true },
    { id: 'k0000003', ts: '2026-09-01T00:00:00Z', title: 'Text', owner: 'human', due: 'soon' },
    { id: 'k0000004', ts: '2026-09-01T00:00:00Z', title: 'Good', owner: 'human', due: '2099-01-01' },
    { id: 'k0000005', ts: '2026-09-01T00:00:00Z', title: 'Alias number', owner: 'human', deadline: 456 },
  ]);
  const open = memory.openDuties(root).open;
  assert.deepEqual(open.map((d) => d.id).sort(), ['k0000001', 'k0000002', 'k0000003', 'k0000004', 'k0000005'], 'no duty vanishes');
  const s = due.situationFromOpen(open, { now: ms('2026-10-12T10:00:00Z'), zone: BERLIN });
  assert.deepEqual([s.withDue, s.unknown, s.fresh], [5, 4, 1]);
  for (const d of open) { const x = due.dueText(d); assert.ok(x === null || typeof x === 'string', `${d.id}: ${typeof x}`); }
  assert.equal(due.dueText(open.find((d) => d.id === 'k0000001')), null);
  assert.equal(due.dueText(open.find((d) => d.id === 'k0000003')), 'soon');
  for (const x of todayMod.decisionsForHuman(root, { human: 'human' }).list) assert.ok(x.due === null || typeof x.due === 'string', `today: ${x.title}`);
  const j = JSON.parse(cli(root, 'deadlines', '--json').stdout);
  assert.deepEqual([j.open, j.with_due, j.unknown], [5, 5, 4]);
  assert.match(cli(root, 'duties').stdout, /Number\s+due \(unreadable\) \(unknown\)/);
});

test('the old due names are no longer WRITTEN: --deadline / --due_date / --until / --by are refused with a hint to use --due (duty and every other type)', (t) => {
  const root = world(t);
  for (const type of ['duty', 'thought']) {
    for (const name of ['deadline', 'due_date', 'until', 'by']) {
      const r = cli(root, 'log', type, '--title', 'T', '--text', 't', `--${name}`, '2026-11-01');
      assert.notEqual(r.status, 0, `${type} --${name}`);
      assert.match(r.stderr, new RegExp(`'${name}'`), r.stderr);
      assert.match(r.stderr, /--due/, 'the hint names the field to use');
      assert.throws(() => memory.logCheckedEntry(root, type, { title: 'T', text: 't', [name]: '2026-11-01' }), /use 'due'/, `${type} ${name} (write core)`);
    }
  }
  const { entry } = memory.logCheckedEntry(root, 'duty', { title: 'Tax', owner: 'human', due: '2026-11-01' });
  const c = cli(root, 'correction', 'duty', entry.id, '--deadline', '2026-11-09');
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /--due/);
  const before = raw(root);
  assert.throws(() => memory.correctionEntry(root, 'duty', entry.id, { until: '2026-11-09' }), /use 'due'/);
  assert.deepEqual(raw(root), before, 'nothing was written');
  assert.deepEqual(fs.readdirSync(path.join(root, 'global')).filter((f) => f.startsWith('thought') && fs.statSync(file(root, f)).size > 0), []);
  // reading stays: a hand-written line with the old name is still a duty with a state
  handWritten(root, [{ id: 'old0000a', ts: '2026-09-01T00:00:00Z', title: 'Old name', owner: 'human', deadline: '2020-01-01' }]);
  const open = memory.openDuties(root).open.find((d) => d.id === 'old0000a');
  assert.equal(due.state(due.dueValue(open), ms('2026-10-12T10:00:00Z'), { zone: BERLIN }), 'overdue');
});

test('situationFromOpen reads every due value only once', () => {
  const real = Date.parse;
  const now = ms('2026-10-12T10:00:00Z');
  const points = [{ id: 'a', due: '2026-12-01T10:00:00Z' }, { id: 'b', due: '2026-10-01T10:00:00+02:00' }];
  let n = 0;
  Date.parse = (...a) => { n += 1; return real(...a); };
  try { due.situationFromOpen(points, { now, zone: BERLIN }); } finally { Date.parse = real; }
  assert.equal(n, points.length, `Date.parse ${n} times for ${points.length} points in time`);
});

// ----------------------------------------------------- 7. one place

test('due-one-place: the calculation catalogue knows it, the anchor holds, no module besides the core reads the field', () => {
  const r = calculations.check(REPO);
  assert.equal(r.measurable, true);
  const x = r.results.find((e) => e.id === 'due-one-place');
  assert.ok(x, 'entry due-one-place in shared/calculations.jsonl');
  assert.equal(x.owner, 'src/due.mjs');
  assert.equal(x.anchorHolds, true, 'positive control: the pattern fires inside the owner itself');
  assert.deepEqual(x.seconds, [], `second calculations: ${JSON.stringify(x.seconds)}`);
});

test('due-one-place: positive control — a reader that guesses the field itself is found; a file named in `except` (other domains with the same words) is not', (t) => {
  const w = tempDir('cheap-mem-due-src-', t);
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.mkdirSync(path.join(w, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(w, 'shared'), { recursive: true });
  const entry = fs.readFileSync(path.join(REPO, 'shared', 'calculations.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"due-one-place"')).join('\n');
  fs.writeFileSync(path.join(w, 'shared', 'calculations.jsonl'), `${entry}\n`);
  fs.writeFileSync(path.join(w, 'src', 'due.mjs'), 'export const f = (p) => p.due ?? p.by;\n');
  fs.writeFileSync(path.join(w, 'src', 'reader-a.mjs'), 'export const a = (p) => p.due ?? p.by;\n');
  fs.writeFileSync(path.join(w, 'src', 'reader-b.mjs'), "for (const f of ['due', 'due_date', 'until', 'deadline']) read(p[f]);\n");
  fs.writeFileSync(path.join(w, 'src', 'reader-c.mjs'), 'export const c = (duty) => duty?.deadline;\n');
  fs.writeFileSync(path.join(w, 'bin', 'mem-mcp'), 'if (d.due) { run(); } const x = s.due; const until = e.until + 1; // claim lines\n');
  fs.writeFileSync(path.join(w, 'src', 'reader-d.mjs'), 'const { due: dueNow } = s; export const d = dueNow;\n');
  const r = calculations.check(w);
  const x = r.results[0];
  assert.equal(x.anchorHolds, true);
  assert.deepEqual(x.seconds.map((s) => s.file).sort(), ['src/reader-a.mjs', 'src/reader-b.mjs', 'src/reader-c.mjs']);
});

// --------------------------------------------- 8. parity table and shared fixture

const jsonl = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('parity table of the field names (shared/field-names-parity.jsonl): well formed, and this house\'s side stands in the code', () => {
  const t = jsonl('shared/field-names-parity.jsonl');
  const names = (kind) => t.filter((x) => x.kind === kind);
  assert.deepEqual(names('field').map((x) => [x.lm, x.cm]).sort(), [['frist', 'due'], ['gueltig_bis', 'valid_until']]);
  assert.deepEqual(names('type').map((x) => [x.lm, x.cm]), [['pflicht', 'duty']]);
  assert.deepEqual(names('state').map((x) => [x.lm, x.cm]).sort(),
    [['faellig', 'due'], ['frisch', 'fresh'], ['ueberfaellig', 'overdue'], ['unbekannt', 'unknown']]);
  assert.equal(new Set(t.map((x) => `${x.kind}:${x.cm}`)).size, t.length, 'no duplicate row');
  for (const x of t) assert.ok(x.lm && x.cm && x.kind && x.meaning, JSON.stringify(x));
  assert.deepEqual(names('state').map((x) => x.cm).sort(), Object.values(due.STATE).sort());
  assert.ok(Object.hasOwn(memory.TYPES, 'duty'));
  assert.ok(bridgefields.ALLOWED_FIELDS.duty.includes('due'));
  assert.ok(bridgefields.ALLOWED_FIELDS.timeline.includes('valid_until'));
  assert.ok(bridgefields.ALLOWED_FIELDS.thought.includes('valid_until'), 'valid_until is a common field');
});

test('shared fixture (shared/due-states.jsonl): every row gives the expected state in this house; the rows cover the state table', () => {
  const fix = jsonl('shared/due-states.jsonl');
  assert.ok(fix.length >= TABLE.length);
  const ids = new Set();
  for (const z of fix) {
    assert.ok(!ids.has(z.id), `duplicate fixture row ${z.id}`);
    ids.add(z.id);
    assert.equal(due.state(z.value, ms(z.now), { zone: z.zone }), z.state, `${z.id}: ${z.value} at ${z.now} in ${z.zone}`);
  }
  for (const [value, now, expected] of TABLE) {
    assert.ok(fix.some((z) => z.value === value && z.now === now && z.zone === BERLIN && z.state === expected), `table row missing in the fixture: ${value} ${now}`);
  }
  for (const [value, now, expected] of TABLE_NY) {
    assert.ok(fix.some((z) => z.value === value && z.now === now && z.zone === 'America/New_York' && z.state === expected), `second-zone row missing: ${value} ${now}`);
  }
  assert.ok(fix.some((z) => z.state === 'unknown'));
  for (const z of fix.filter((x) => x.zone !== BERLIN)) assert.equal(z.only, 'cm', `${z.id}: rows of another zone are marked cm-only (lucky-mem knows only Europe/Berlin)`);
});
