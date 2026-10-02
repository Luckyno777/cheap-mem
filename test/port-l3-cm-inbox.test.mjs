// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/port-l3-cm-inbox.test.mjs — the session-mail rests of lucky-mem's
// Block S, ported (lm 14c8d20f S4, part of 84197d20 S2b/S2c):
//
//   - doctor finding `inbox-waiting-permission` (lm `post-wartet-erlaubnis`):
//     messages that would wake but lack the owner's permission;
//   - dashboard task `inbox-permit` (lm task `post-freigeben`): the CLI's
//     `mem inbox permit <name> --authority user --json`, `--authority user`
//     ONLY from a password session, refused without one;
//   - `picked-up` events: the recipient's `mem inbox new`/`show` writes one
//     line per message in states.jsonl; a `read` request is then processed.
//
// Red on the fixed base 2930909: the finding, the task kind, `--json` on
// `inbox permit` and `inbox.markPickedUp` do not exist; a `read` request
// stayed open forever after it was read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as inbox from '../src/inbox.mjs';
import * as tasks from '../src/tasks.mjs';
import * as doctor from '../src/doctor.mjs';
import * as mailpermit from '../src/mailpermit.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const PARTS = { user: { role: 'H', human: true }, session: 'AI', librarian: 'lib' };
const NO_ID = { CLAUDE_CODE_SESSION_ID: '' };
const ENV = { ...process.env, MEM_HEADLESS: '', CLAUDE_CODE_SESSION_ID: '', CHEAP_MEM_MAX_AUTHORITY: '' };

function send(r, { to = 'librarian', intent = null, offset = 0 } = {}) {
  return inbox.write(r, PARTS, {
    from: 'session', to, subject: `s${offset}`, text: `body ${offset}`, intent,
    now: new Date(Date.parse('2026-10-01T10:00:00Z') + offset * 1000), env: NO_ID,
  });
}
const run = (r, ...a) => spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8', env: ENV, timeout: 30000 });

// --- doctor: inbox-waiting-permission ---------------------------------------

test('inbox-waiting-permission: good without waiting mail, warn with a request, good again once permitted', (t) => {
  const r = tempDir('cm-l3-in-', t);
  send(r, { intent: 'information' });
  const quiet = doctor.checkInboxWaitingPermission(r);
  assert.equal(quiet.name, 'inbox-waiting-permission');
  assert.equal(quiet.level, 'good', 'an information note never waits');
  const { name } = send(r, { intent: 'request', offset: 1 });
  const w = doctor.checkInboxWaitingPermission(r);
  assert.equal(w.level, 'warn', 'positive control: the request waits');
  assert.match(w.text, /1 message\(s\) waiting-for-permission/);
  assert.match(w.advice, /mem inbox permit/);
  mailpermit.grantMessage(r, { message: name, authority: 'user', env: { MEM_HEADLESS: '' } });
  assert.equal(doctor.checkInboxWaitingPermission(r).level, 'good');
});

test('inbox-waiting-permission: a broken ledger line is unknown (it may hide a budget), never good', (t) => {
  const r = tempDir('cm-l3-in-', t);
  send(r, { intent: 'request' });
  fs.mkdirSync(path.dirname(mailpermit.ledgerPath(r)), { recursive: true });
  fs.writeFileSync(mailpermit.ledgerPath(r), '{not json\n');
  const f = doctor.checkInboxWaitingPermission(r);
  assert.equal(f.level, 'unknown', f.text);
  assert.match(f.text, /unreadable/);
});

test('inbox-waiting-permission is part of mem doctor', (t) => {
  const r = tempDir('cm-l3-in-', t);
  assert.equal(run(r, 'init').status, 0);
  assert.ok(doctor.checkAll(r).findings.some((f) => f.name === 'inbox-waiting-permission'));
});

// --- dashboard task inbox-permit -----------------------------------------------

test('task inbox-permit: --authority user only from a password session; humanOnly refuses without one', (t) => {
  const spec = tasks.KINDS['inbox-permit'];
  assert.ok(spec, 'the task kind exists');
  assert.equal(spec.humanOnly, true);
  const p = { name: '2026-10-01T10-00-00Z--session-to-librarian.md' };
  assert.deepEqual(spec.command('/r', 'x', p, { user: true }).args,
    ['inbox', 'permit', p.name, '--json', '--authority', 'user']);
  assert.ok(!spec.command('/r', 'x', p, {}).args.includes('user'), 'no session, no authority');
  assert.throws(() => tasks.checkParams('inbox-permit', { name: '../../etc/passwd' }), /INVALID|name/i);
  assert.throws(() => tasks.checkParams('inbox-permit', { name: 'x.md', authority: 'user' }), /authority|unknown|INVALID/i,
    'the form can never carry authority');
  const r = tempDir('cm-l3-in-', t);
  assert.throws(() => tasks.start(r, 'inbox-permit', p, {}), (e) => e.code === 'NOT_A_PERSON');
});

test('CLI: mem inbox permit --json names the new line (what the task classifies); without authority refused', (t) => {
  const r = tempDir('cm-l3-in-', t);
  assert.equal(run(r, 'init').status, 0);
  const w = run(r, 'inbox', 'write', '--as', 'session', '--to', 'librarian', '--subject', 'do', '--text', 'x', '--intent', 'request');
  const name = /Written: inbox\/(\S+)/.exec(w.stdout)[1];
  const no = run(r, 'inbox', 'permit', name, '--json');
  assert.equal(no.status, 1);
  const ok = run(r, 'inbox', 'permit', name, '--authority', 'user', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.equal(j.new, j.id);
  assert.equal(j.message, name);
  assert.deepEqual(tasks.KINDS['inbox-permit'].classify(j), { state: 'ok', reason: null });
});

// --- picked-up events -------------------------------------------------------------

test('picked-up: a read request is processed once its RECIPIENT picked it up; a request stays open', (t) => {
  const r = tempDir('cm-l3-in-', t);
  const rd = send(r, { intent: 'read' });
  const rq = send(r, { intent: 'request', offset: 1 });
  assert.equal(inbox.stateOf(r, rd.name).state, 'open');
  // Someone else looking is no pickup.
  assert.equal(inbox.markPickedUp(r, { to: 'session', names: [rd.name] }).written.length, 0);
  assert.equal(inbox.stateOf(r, rd.name).state, 'open');
  const first = inbox.markPickedUp(r, { to: 'librarian', names: [rd.name, rq.name] });
  assert.equal(first.written.length, 2);
  const again = inbox.markPickedUp(r, { to: 'librarian', names: [rd.name, rq.name] });
  assert.equal(again.written.length, 0, 'at most one line per message and recipient');
  const a = inbox.stateOf(r, rd.name);
  assert.equal(a.state, 'processed');
  assert.equal(a.stateSource, 'picked-up');
  assert.ok(a.pickedUp);
  const b = inbox.stateOf(r, rq.name);
  assert.equal(b.state, 'open', 'a request asks for an answer: picking it up does not close it');
  assert.ok(b.pickedUp, 'but the pickup is visible');
  assert.equal(inbox.readStateLines(r).broken.length, 0, 'event lines are readable, not broken');
});

test('picked-up: the recipient\'s mem inbox new writes it, and the read request leaves the open list', (t) => {
  const r = tempDir('cm-l3-in-', t);
  assert.equal(run(r, 'init').status, 0);
  const w = run(r, 'inbox', 'write', '--as', 'session', '--to', 'librarian', '--subject', 'read this', '--text', 'x', '--intent', 'read');
  const name = /Written: inbox\/(\S+)/.exec(w.stdout)[1];
  const n = run(r, 'inbox', 'new', '--as', 'librarian');
  assert.equal(n.status, 0, n.stderr);
  assert.match(n.stdout, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const ev = inbox.readStateLines(r).events;
  assert.deepEqual(ev.map((e) => [e.event, e.message, e.by]), [['picked-up', name, 'librarian']]);
  assert.equal(inbox.stateOf(r, name).state, 'processed');
});
