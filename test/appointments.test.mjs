// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// appointments: the store, the rights, the clock (exactly once, late, cap, repair), the day list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as A from '../src/appointments.mjs';
import * as C from '../src/appointment-clock.mjs';
import * as T from '../src/appointment-today.mjs';
import * as tm from '../src/appointment-time.mjs';
import * as inbox from '../src/inbox.mjs';
import * as cfgmod from '../src/config.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const ZONE = 'Europe/Berlin';
const clock = tm.clockFor(ZONE);
const wall = (y, mo, d, h = 0, mi = 0) => clock.wallToUtc(y, mo, d, h, mi);
const NOW = wall(2026, 10, 5, 8, 0); // Monday 08:00
const ENV = {}; // no MEM_HEADLESS, no ceiling

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function world({ human = true, timezone = ZONE } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-appt-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  const participants = { alex: human ? { role: 'the human', human: true } : 'the human', 'vm-admin': 'operator agent', librarian: 'curator' };
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ version: 1, participants, language: 'en', timezone }));
  return r;
}
const HUMAN = A.actorFrom({ name: 'human:alex', authority: 'user', env: ENV });
const AGENT = { name: 'vm-admin', human: false, reason: 'agent' };
const lines = (r, f) => fs.readFileSync(path.join(r, A.DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const letters = (r, to) => inbox.read(r, cfgmod.readConfig(r).participants, to ? { to } : {}).messages;
const mk = (r, o) => A.create(r, { actor: HUMAN, now: NOW - 3600000, env: ENV, ...o });

test('actorFrom: only an explicit user claim counts; headless and a lowered ceiling refuse it', () => {
  assert.equal(A.actorFrom({ name: 'x', env: ENV }).human, false);
  assert.equal(A.actorFrom({ name: 'x', authority: 'agent', env: ENV }).human, false);
  assert.equal(A.actorFrom({ name: 'x', authority: 'user', env: ENV }).human, true);
  assert.match(A.actorFrom({ name: 'x', authority: 'user', env: { MEM_HEADLESS: 'watcher' } }).reason, /headless/);
  assert.match(A.actorFrom({ name: 'x', authority: 'user', env: { CHEAP_MEM_MAX_AUTHORITY: 'agent' } }).reason, /ceiling/);
});

test('create: a human reminder is active, an agent action and an agent reminder are proposals', () => {
  const r = world();
  const a = mk(r, { title: 'Dentist', atMs: NOW + 86400000 });
  assert.equal(a.status, 'active');
  const w = A.create(r, { title: 'Backup', atMs: NOW + 86400000, wake: 'vm-admin', task: 'check', actor: AGENT, now: NOW, env: ENV });
  assert.equal(w.status, 'proposed');
  const rem = A.create(r, { title: 'Agent reminder', atMs: NOW + 90000000, reminderActive: false, actor: AGENT, now: NOW, env: ENV });
  assert.equal(rem.status, 'proposed');
  const st = A.load(r);
  assert.equal(st.items.get(a.id).armed.how, 'creation');
  assert.equal(st.items.get(w.id).armed, null);
});

test("create: a quoted user request makes an agent's plain reminder active, never its action", () => {
  const r = world();
  const wish = { by: 'user', quote: 'remind me tomorrow about the dentist' };
  const a = A.create(r, { title: 'Dentist', atMs: NOW + 86400000, requestedBy: wish, reminderActive: true, actor: AGENT, now: NOW, env: ENV });
  assert.equal(a.status, 'active');
  const w = A.create(r, { title: 'Backup', atMs: NOW + 86400000, wake: 'vm-admin', task: 't', requestedBy: wish, reminderActive: true, actor: AGENT, now: NOW, env: ENV });
  assert.equal(w.status, 'proposed', 'a quote never arms an action');
  assert.throws(() => A.create(r, { title: 'x', atMs: NOW + 1, requestedBy: { by: 'user', quote: '' }, actor: AGENT, now: NOW, env: ENV }), /in their words/);
});

test('create: validation and duplicates', () => {
  const r = world();
  const bad = [
    [{ title: '', atMs: NOW + 1 }, /title is missing/],
    [{ title: 'x', atMs: NaN }, /not a point in time/],
    [{ title: 'x', atMs: NOW + 1, repeat: 'hourly' }, /repeat is one of/],
    [{ title: 'x', atMs: NOW + 1, beforeMin: 0 }, /remind-before/],
    [{ title: 'x', atMs: NOW + 1, wake: 'nobody', task: 't' }, /no inbox/],
    [{ title: 'x', atMs: NOW + 1, wake: 'alex', task: 't' }, /is the human/],
    [{ title: 'x', atMs: NOW + 1, wake: 'vm-admin' }, /task is missing/],
    [{ title: 'x', atMs: NOW + 1, task: 't' }, /task without wake/],
    [{ title: 'x', atMs: NOW + 1, maxMinutes: 5 }, /max-minutes without wake/],
    [{ title: 'x', atMs: NOW + 1, wake: 'vm-admin', task: 't', maxMinutes: 999 }, /max-minutes/],
    [{ title: 'x', atMs: NOW + 1, kind: 'briefing', wake: 'vm-admin', task: 't' }, /wakes nobody/],
    [{ title: 'bell\u0007', atMs: NOW + 1 }, /control characters/],
    [{ title: 'x', atMs: NOW + 1, source: 'carrier-pigeon' }, /source is one of/],
    [{ title: 'x', atMs: NOW + 1, isPrivate: true, wake: 'vm-admin', task: 't' }, /private appointment cannot wake/],
  ];
  for (const [o, re] of bad) assert.throws(() => mk(r, o), re, JSON.stringify(o));
  assert.equal(fs.existsSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE)), false, 'nothing is written for a refused appointment');
  const a = mk(r, { title: 'Call Dr. Who', atMs: NOW + 86400000 });
  const dup = A.create(r, { title: 'call dr who', atMs: NOW + 86400000 + 9 * 60000, actor: AGENT, now: NOW, env: ENV });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, a.id);
  const far = mk(r, { title: 'Call Dr. Who', atMs: NOW + 86400000 + 11 * 60000 });
  assert.equal(far.duplicate, false, '11 minutes apart is another appointment');
  assert.equal(lines(r, A.APPOINTMENTS_FILE).length, 2);
});

test('rights: confirm, cap, cancel and move', () => {
  const r = world();
  const w = A.create(r, { title: 'Backup', atMs: NOW + 86400000, wake: 'vm-admin', task: 't', actor: AGENT, now: NOW, env: ENV });
  assert.throws(() => A.confirm(r, w.id, { actor: AGENT }), /human/);
  assert.throws(() => A.setCap(r, 3, { actor: AGENT }), /Only the user sets the cap/);
  A.confirm(r, w.id, { actor: HUMAN, now: NOW });
  assert.equal(A.load(r).items.get(w.id).status, 'active');
  assert.equal(A.confirm(r, w.id, { actor: HUMAN }).already, true);
  // An armed action: the agent can neither cancel nor move it; the attempt is not written as a valid line.
  assert.throws(() => A.cancel(r, w.id, { actor: AGENT }), /only the user cancels/);
  assert.throws(() => A.move(r, w.id, { atMs: NOW + 2 * 86400000, actor: AGENT, now: NOW }), /only the user moves/);
  // The agent's own proposal: it can cancel it.
  const p = A.create(r, { title: 'Mine', atMs: NOW + 86400000, wake: 'vm-admin', task: 't', actor: AGENT, now: NOW, env: ENV });
  assert.equal(A.cancel(r, p.id, { actor: AGENT, now: NOW }).already, false);
  assert.equal(A.load(r).items.get(p.id).status, 'cancelled');
  // A forged line in the file (a cancel without the user's authority on an armed appointment) is listed, changes nothing.
  fs.appendFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), `${JSON.stringify({ type: 'cancel', id: 'f1', ts: A.iso(NOW), target: w.id, by: 'evil' })}\n`);
  const st = A.load(r);
  assert.equal(st.items.get(w.id).status, 'active');
  assert.equal(st.disputed.length, 1);
  // Cap: the human sets it with who/when/previous; out of range is refused.
  const line = A.setCap(r, 3, { actor: HUMAN, now: NOW });
  assert.equal(line.previous, 10);
  assert.equal(A.load(r).cap.value, 3);
  assert.throws(() => A.setCap(r, 9999, { actor: HUMAN }), /whole number 0 to/);
  A.setCap(r, 4, { actor: HUMAN, now: NOW, key: 'proposals' });
  assert.equal(A.load(r).proposalCap.value, 4);
  // A forged settings line without the user's authority is ignored.
  fs.appendFileSync(path.join(r, A.DIR, A.SETTINGS_FILE), `${JSON.stringify({ type: 'setting', id: 'f2', ts: A.iso(NOW), key: 'wake', value: 500, by: 'evil' })}\n`);
  assert.equal(A.load(r).cap.value, 3);
});

test('append-only: nothing already written is ever changed', () => {
  const r = world();
  const a = mk(r, { title: 'One', atMs: NOW + 3600000 });
  const before = fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8');
  A.move(r, a.id, { atMs: NOW + 7200000, actor: HUMAN, now: NOW });
  A.cancel(r, a.id, { actor: HUMAN, now: NOW });
  const after = fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8');
  assert.ok(after.startsWith(before));
  assert.equal(after.split('\n').filter(Boolean).length, 3);
});

test('tick: no appointment file, no side effect at all', () => {
  const r = world();
  const t = C.tick(r, { now: NOW, env: ENV });
  assert.equal(t.state, 'empty');
  assert.equal(fs.existsSync(path.join(r, A.DIR)), false);
  assert.equal(fs.existsSync(path.join(r, 'inbox')), false);
});

test('tick: a reminder fires exactly once, as a note to the human, with the pre-reminder before it', () => {
  const r = world();
  const at = NOW + 3600000; // 09:00
  const a = mk(r, { title: 'Dentist', text: 'bring the card', atMs: at, beforeMin: 15 });
  assert.deepEqual(C.tick(r, { now: NOW, env: ENV }).fired, [], 'nothing is due yet');
  const early = C.tick(r, { now: at - 10 * 60000, env: ENV });
  assert.equal(early.fired.length, 1);
  assert.equal(lines(r, A.FIRED_FILE).find((z) => z.type === 'intent').stage, 'before');
  const main = C.tick(r, { now: at + 30000, env: ENV });
  assert.equal(main.fired.length, 1);
  assert.equal(C.tick(r, { now: at + 60000, env: ENV }).fired.length, 0, 'the second tick does nothing');
  const mail = letters(r, 'alex');
  assert.equal(mail.length, 2);
  const m = mail.find((x) => /^Appointment:/.test(x.subject));
  assert.equal(m.from, 'alex');
  assert.equal(m.intent, 'information');
  assert.match(m.text, /Title: Dentist/);
  assert.match(m.text, /bring the card/);
  assert.match(m.text, /Tue|Mon/);
  const f = lines(r, A.FIRED_FILE);
  assert.equal(f.filter((z) => z.type === 'intent').length, 2);
  assert.equal(f.filter((z) => z.type === 'delivered').length, 2);
  assert.equal(a.status, 'active');
});

test('tick: two ticks at the same moment in two processes send ONE letter', async () => {
  const r = world();
  const at = Date.now() - 20000;
  A.create(r, { title: 'Now-ish', atMs: at, actor: HUMAN, now: at - 3600000, env: ENV });
  const run = () => new Promise((res) => {
    const p = spawn('node', [MEM, 'appointment', 'tick', '--root', r], { env: { ...process.env, MEM_HEADLESS: '' } });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
  const [x, y] = await Promise.all([run(), run()]);
  assert.equal(x.code, 0, x.out);
  assert.equal(y.code, 0, y.out);
  assert.equal(letters(r, 'alex').length, 1, `${x.out}\n${y.out}`);
  assert.equal(lines(r, A.FIRED_FILE).filter((z) => z.type === 'intent').length, 1);
});

test('tick: a run that died between the intent and the letter is repaired, without a second letter', () => {
  const r = world();
  const at = NOW + 3600000;
  mk(r, { title: 'Dentist', atMs: at });
  const boom = () => { throw new Error('disk full'); };
  const t1 = C.tick(r, { now: at + 1000, env: ENV, send: boom });
  assert.equal(t1.errors.length, 1);
  assert.equal(lines(r, A.FIRED_FILE).filter((z) => z.type === 'delivered').length, 0);
  assert.equal(letters(r).length, 0);
  const t2 = C.tick(r, { now: at + 2000, env: ENV });
  assert.equal(t2.repaired, 1);
  assert.equal(letters(r, 'alex').length, 1);
  // The harder half: the letter was written but `delivered` was not.
  const r2 = world();
  mk(r2, { title: 'Dentist', atMs: at });
  const parts = cfgmod.readConfig(r2).participants;
  let wrote = null;
  const flaky = (l) => {
    wrote = inbox.write(r2, parts, { from: l.from, to: l.to, subject: l.subject, text: l.text, now: new Date(at + 1000), requestId: l.requestId, intent: l.intent });
    throw new Error('died after the letter');
  };
  C.tick(r2, { now: at + 1000, env: ENV, send: flaky });
  assert.ok(wrote);
  const t3 = C.tick(r2, { now: at + 2000, env: ENV });
  assert.equal(t3.repaired, 1);
  assert.equal(letters(r2, 'alex').length, 1, 'found by its request id, not written again');
  assert.equal(lines(r2, A.FIRED_FILE).filter((z) => z.type === 'delivered').length, 1);
});

test('late: after a pause only the latest occurrence of a repeat fires, once, marked late with the skipped count', () => {
  const r = world();
  const first = wall(2026, 10, 5, 9, 0);
  mk(r, { title: 'Stand-up', atMs: first, repeat: 'daily', now: first - 3600000 });
  C.tick(r, { now: first + 1000, env: ENV });
  const later = wall(2026, 10, 12, 9, 30);
  const t = C.tick(r, { now: later, env: ENV });
  assert.equal(t.fired.length, 1);
  assert.equal(t.fired[0].late, true);
  assert.equal(t.fired[0].skipped, 6);
  const m = letters(r, 'alex').find((x) => /\(late\)/.test(x.subject));
  assert.match(m.text, /6 further missed occurrence/);
  assert.equal(C.tick(r, { now: later + 1000, env: ENV }).fired.length, 0);
});

test('recorded late: a past reminder arrives once at once; a past action never fires and the human is told', () => {
  const r = world();
  const past = NOW - 7200000;
  const rem = A.create(r, { title: 'Forgot', atMs: past, actor: HUMAN, now: NOW, env: ENV });
  assert.match(rem.warnings.join(' '), /recorded late/);
  const act = A.create(r, { title: 'Too late task', atMs: past, wake: 'vm-admin', task: 't', actor: HUMAN, now: NOW, env: ENV });
  assert.match(act.warnings.join(' '), /NEVER fires afterwards/);
  const t = C.tick(r, { now: NOW, env: ENV });
  assert.deepEqual(t.fired.map((x) => x.outcome).sort(), ['missed', 'reminder']);
  assert.equal(letters(r, 'vm-admin').length, 0, 'no letter to the agent');
  assert.equal(letters(r, 'alex').length, 2);
  assert.ok(letters(r, 'alex').some((m) => /RECORDED LATE/.test(m.text)));
  // Confirming a proposal after its time has passed does not fire it either.
  const p = A.create(r, { title: 'Proposal', atMs: NOW + 600000, wake: 'vm-admin', task: 't', actor: AGENT, now: NOW, env: ENV });
  A.confirm(r, p.id, { actor: HUMAN, now: NOW + 3600000 });
  const t2 = C.tick(r, { now: NOW + 3600000 + 1000, env: ENV });
  assert.ok(t2.fired.some((x) => x.outcome === 'missed' && x.appointment === p.id));
  assert.equal(letters(r, 'vm-admin').length, 0);
});

test('an action: a letter with the task to the agent, which may wake it (a grant), with no budget; an unarmed one sends nothing', () => {
  const r = world();
  const at = NOW + 3600000;
  const a = mk(r, { title: 'Check backup', atMs: at, wake: 'vm-admin', task: 'Check that the backup finished.', maxMinutes: 20 });
  A.create(r, { title: 'Proposed only', atMs: at, wake: 'vm-admin', task: 'secret plan', actor: AGENT, now: NOW, env: ENV });
  const t = C.tick(r, { now: at + 1000, env: ENV });
  assert.equal(t.fired.length, 1);
  const mail = letters(r, 'vm-admin');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].intent, 'request');
  assert.equal(mail[0].from, 'alex');
  assert.match(mail[0].text, /Check that the backup finished/);
  assert.match(mail[0].text, /at most 20 minutes/);
  assert.match(mail[0].text, /NO extra rights/);
  assert.doesNotMatch(mail[0].text, /secret plan/);
  const d = inbox.wakeDecisions(r, cfgmod.readConfig(r).participants, { to: 'vm-admin', now: new Date(at + 2000) });
  assert.equal(d.wake.length, 1, 'the user planned it, so it may wake');
  assert.equal(d.wake[0].decision.permit.reason, 'single-grant');
  const ledger = fs.readFileSync(path.join(r, 'inbox', 'permissions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].by, `appointment:${a.id}`);
  // Positive control: the same kind of letter WITHOUT the clock's grant waits for permission.
  const parts = cfgmod.readConfig(r).participants;
  inbox.write(r, parts, { from: 'alex', to: 'vm-admin', subject: 'hand-written request', text: 'do it', now: new Date(at + 5000), intent: 'request' });
  const d2 = inbox.wakeDecisions(r, parts, { to: 'vm-admin', now: new Date(at + 6000) });
  assert.equal(d2.waiting.length, 1);
});

test('cap: the 11th wake-up is held with a letter, caught up the same day, never the next day', () => {
  const r = world();
  const base = wall(2026, 10, 5, 9, 0);
  A.setCap(r, 2, { actor: HUMAN, now: base - 7200000 });
  for (let i = 0; i < 3; i += 1) mk(r, { title: `Task ${i}`, atMs: base + i * 60000, wake: 'vm-admin', task: `t${i}`, now: base - 3600000 });
  const t = C.tick(r, { now: base + 5 * 60000, env: ENV });
  assert.deepEqual(t.fired.map((x) => x.outcome).sort(), ['held', 'woke', 'woke']);
  assert.equal(letters(r, 'vm-admin').length, 2);
  assert.ok(letters(r, 'alex').some((m) => /^Held \(cap\)/.test(m.subject)));
  assert.equal(C.tick(r, { now: base + 6 * 60000, env: ENV }).fired.length, 0, 'held and told: quiet');
  A.setCap(r, 5, { actor: HUMAN, now: base + 7 * 60000 });
  const t2 = C.tick(r, { now: base + 8 * 60000, env: ENV });
  assert.deepEqual(t2.fired.map((x) => x.outcome), ['woke']);
  assert.match(letters(r, 'vm-admin').map((m) => m.text).join('\n'), /Caught up/);
  // Another world: held, the cap is raised only the next day: it is NOT fired.
  const r2 = world();
  A.setCap(r2, 0, { actor: HUMAN, now: base - 7200000 });
  mk(r2, { title: 'Never', atMs: base, wake: 'vm-admin', task: 't', now: base - 3600000 });
  assert.equal(C.tick(r2, { now: base + 1000, env: ENV }).fired[0].outcome, 'held');
  A.setCap(r2, 10, { actor: HUMAN, now: base + 86400000 });
  assert.equal(C.tick(r2, { now: base + 86400000 + 1000, env: ENV }).fired.length, 0);
  assert.equal(letters(r2, 'vm-admin').length, 0);
});

test('proposal cap: beyond N an agent proposal is only counted; one summary letter after 20:00, once', () => {
  const r = world();
  A.setCap(r, 2, { actor: HUMAN, now: NOW, key: 'proposals' });
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(A.create(r, { title: `Idea ${i}`, atMs: NOW + (i + 1) * 86400000, wake: 'vm-admin', task: 't', actor: AGENT, now: NOW, env: ENV }));
  }
  assert.deepEqual(ids.map((x) => x.status), ['proposed', 'proposed', 'dropped', 'dropped']);
  assert.equal(ids[2].id, null);
  assert.equal(A.load(r).items.size, 2);
  // With the user's quoted request it is free.
  const free = A.create(r, { title: 'Asked for', atMs: NOW + 5 * 86400000, requestedBy: { by: 'user', quote: 'remind me' }, reminderActive: true, actor: AGENT, now: NOW, env: ENV });
  assert.equal(free.status, 'active');
  assert.equal(C.tick(r, { now: wall(2026, 10, 5, 19, 0), env: ENV }).fired.filter((x) => x.outcome === 'dropped-reported').length, 0, 'before 20:00 the day is not over');
  const t = C.tick(r, { now: wall(2026, 10, 5, 20, 5), env: ENV });
  assert.equal(t.fired.filter((x) => x.outcome === 'dropped-reported').length, 1);
  assert.equal(C.tick(r, { now: wall(2026, 10, 5, 21, 0), env: ENV }).fired.length, 0);
  const l = letters(r, 'alex').filter((m) => /dropped/.test(m.subject));
  assert.equal(l.length, 1);
  assert.match(l[0].text, /2 appointment proposal/);
});

test('a briefing: the day list as a letter, never for a past day, never counted against the cap', () => {
  const r = world();
  const seven = wall(2026, 10, 5, 7, 0);
  mk(r, { title: 'Briefing', atMs: seven, repeat: 'weekdays', kind: 'briefing', now: seven - 86400000 });
  mk(r, { title: 'Dentist', atMs: wall(2026, 10, 5, 14, 30), now: seven - 86400000 });
  mk(r, { title: 'Backup', atMs: wall(2026, 10, 5, 17, 0), wake: 'vm-admin', task: 't', now: seven - 86400000 });
  const t = C.tick(r, { now: seven + 1000, env: ENV });
  assert.equal(t.fired.filter((x) => x.outcome === 'briefing').length, 1);
  const m = letters(r, 'alex').find((x) => /^Today in the calendar/.test(x.subject));
  assert.match(m.subject, /Monday, 2026-10-05/);
  assert.match(m.text, /14:30 Dentist/);
  assert.match(m.text, /17:00 Backup \[wakes vm-admin: planned\]/);
  assert.equal(letters(r, 'vm-admin').length, 0);
  // Two days later the repeat resumes with that day, and the missed Tuesday does not come back.
  const thu = wall(2026, 10, 8, 7, 0);
  const t2 = C.tick(r, { now: thu + 1000, env: ENV });
  assert.equal(t2.fired.filter((x) => x.outcome === 'briefing').length, 1);
  assert.match(letters(r, 'alex').map((x) => x.subject).join('\n'), /Thursday, 2026-10-08/);
  // A briefing whose day is over falls away.
  const r2 = world();
  mk(r2, { title: 'Briefing', atMs: seven, kind: 'briefing', now: seven - 86400000 });
  assert.equal(C.tick(r2, { now: seven + 86400000 + 3600000, env: ENV }).fired.length, 0);
});

test('tick: without a human participant it refuses to guess one', () => {
  const r = world({ human: false });
  mk(r, { title: 'x', atMs: NOW + 1000 });
  const t = C.tick(r, { now: NOW + 5000, env: ENV });
  assert.equal(t.state, 'blocked');
  assert.match(t.errors[0], /human/);
  assert.equal(fs.existsSync(path.join(r, A.FIRED_FILE)), false);
});

test('a recipient that no longer exists is reported, not silently dropped', () => {
  const r = world();
  const at = NOW + 3600000;
  mk(r, { title: 'Ghost task', atMs: at, wake: 'vm-admin', task: 't' });
  const t = C.tick(r, { now: at + 1000, env: ENV, canWake: () => false });
  assert.equal(t.fired[0].outcome, 'undeliverable');
  assert.ok(letters(r, 'alex').some((m) => /^Not deliverable/.test(m.subject)));
});

test('private: only the neutral title is stored, no text, no quote wording, in the letter either', () => {
  const r = world();
  const a = mk(r, { title: 'Therapy at 5', text: 'the details', atMs: NOW + 3600000, isPrivate: true, requestedBy: { by: 'user', quote: 'remind me about therapy' }, reminderActive: true, actor: AGENT });
  const line = lines(r, A.APPOINTMENTS_FILE)[0];
  assert.equal(line.title, A.PRIVATE_TITLE);
  assert.equal(line.text, undefined);
  assert.doesNotMatch(JSON.stringify(line), /Therapy|therapy|the details/);
  C.tick(r, { now: NOW + 3600000 + 1000, env: ENV });
  assert.doesNotMatch(letters(r, 'alex').map((m) => m.subject + m.text).join('\n'), /Therapy|therapy|the details/);
  assert.equal(a.status, 'active');
});

test('the day list: deterministic, machine form with `empty`, and the session line within its byte cap', () => {
  const r = world();
  const day = wall(2026, 10, 5, 12, 0);
  assert.equal(T.today(r, { now: day }).appointments.length, 0);
  assert.equal(T.machine(T.today(r, { now: day })).empty, true);
  mk(r, { title: 'Briefing', atMs: wall(2026, 10, 6, 7, 0), repeat: 'weekdays', kind: 'briefing', now: day - 86400000 });
  mk(r, { title: 'Dentist äöü '.repeat(12), atMs: wall(2026, 10, 5, 14, 30), now: day - 86400000 });
  mk(r, { title: 'Lunch', atMs: wall(2026, 10, 5, 12, 30), now: day - 86400000 });
  const h = T.today(r, { now: day });
  const m1 = JSON.stringify(T.machine(h));
  assert.equal(m1, JSON.stringify(T.machine(T.today(r, { now: day }))), 'same state and time give the same answer');
  assert.equal(JSON.parse(m1).empty, false);
  assert.deepEqual(JSON.parse(m1).appointments.map((x) => x.time), ['12:30', '14:30']);
  const line = T.sessionLine(r, { now: day });
  assert.match(line, /^Today: 2 appointments, next 12:30 Lunch$/);
  assert.ok(Buffer.byteLength(T.sessionLine(r, { now: wall(2026, 10, 5, 13, 0) })) <= T.LINE_MAX_BYTES);
  assert.match(T.sessionLine(r, { now: wall(2026, 10, 5, 13, 0) }), /next 14:30 Dentist/);
  assert.equal(T.sessionLine(world(), { now: day }), '', 'no briefing, no line');
  assert.match(T.briefingText(h), /Appointments today: 2/);
});

test('overview: the contract the dashboard reads', () => {
  const r = world();
  const at = NOW + 3600000;
  mk(r, { title: 'Dentist', atMs: at });
  A.create(r, { title: 'Idea', atMs: at + 1, wake: 'vm-admin', task: 't', actor: AGENT, now: NOW, env: ENV });
  const v = T.overview(r, { now: NOW });
  for (const k of ['state', 'zone', 'nowText', 'cap', 'proposalCap', 'appointments', 'occurrences', 'banner', 'held', 'actions', 'today', 'briefingActive', 'proposed']) assert.ok(k in v, k);
  assert.equal(v.proposed, 1);
  assert.equal(v.zone, ZONE);
  assert.equal(v.cap.value, 10);
  assert.equal(v.appointments.length, 2);
  assert.equal(v.occurrences.length, 2);
});

test('the zone comes from the config, else the environment; an unknown one is refused loudly', () => {
  const r = world({ timezone: 'America/New_York' });
  assert.equal(A.zoneOf(r, {}), 'America/New_York');
  const r2 = world({ timezone: null });
  assert.equal(A.zoneOf(r2, { CHEAP_MEM_TZ: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.throws(() => A.zoneOf(world({ timezone: 'Nowhere/Land' }), {}), /not a zone/);
});

test('a headless run (digest, reflector) only ever proposes, even with a quoted user request', () => {
  const r = world();
  const wish = { by: 'user', quote: 'remind me tomorrow' };
  const a = A.create(r, { title: 'From a digest', atMs: NOW + 86400000, requestedBy: wish, reminderActive: true, actor: AGENT, now: NOW, env: { MEM_HEADLESS: 'digest' } });
  assert.equal(a.status, 'proposed');
  assert.equal(a.line.source, 'reflector');
  assert.equal(a.line.quote, wish.quote, 'the quote stays as evidence');
  // Positive control: the same call outside a headless run is active.
  const b = A.create(r, { title: 'From a session', atMs: NOW + 90000000, requestedBy: wish, reminderActive: true, actor: AGENT, now: NOW, env: ENV });
  assert.equal(b.status, 'active');
});
