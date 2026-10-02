// test/s1-cm-mail-permission.test.mjs
//
// Block S, ported from lucky-mem (S1/S2/S4: test/s1-lm-erlaubnis,
// s1-lm-weckregel, s1-lm-routen). The guarantees:
//
//   S1  a message that asks for work (request/read/clarification) wakes
//       its recipient only with the user's permission or a budget;
//       information, results and receipts never wake anyone and never
//       need permission. Only the user (authority user, not headless)
//       grants.
//   S2  a reply budget (Turn n of max): past the maximum nothing in the
//       chain wakes anyone, whatever the permission says.
//   S4  routes: a session registers when it picks up mail; a reply goes
//       to the session that asked, and another session of the same role
//       does not get it offered.
//
// Red on the old code (2a79040): `inbox.watch()` reported every new
// name as `new` (exit 1 = start the paid handler), so an information
// note woke a model; the wake/permit/route API did not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as inbox from '../src/inbox.mjs';
import * as envelope from '../src/envelope.mjs';
import * as mailpermit from '../src/mailpermit.mjs';
import * as routes from '../src/routes.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const PARTS = {
  user: { role: 'H', human: true },
  session: 'AI',
  librarian: 'lib',
};
const USER = { MEM_HEADLESS: '' };
const NO_ID = { CLAUDE_CODE_SESSION_ID: '' };

function root(t) { return tempDir('cm-s1-', t); }

function send(r, { from = 'session', to = 'librarian', intent = null, inReplyTo = null, offset = 0, env = NO_ID } = {}) {
  return inbox.write(r, PARTS, {
    from, to, subject: `s${offset}`, text: `body ${offset}`, intent, inReplyTo,
    now: new Date(Date.parse('2026-10-01T10:00:00Z') + offset * 1000), env,
  });
}

/** Stub for `git` against a fake remote holding `files` (name -> content). */
function remote(files) {
  return (cmd, args) => {
    if (args[2] === 'fetch') return '';
    if (args[2] === 'ls-tree') return Object.keys(files).map((n) => `inbox/${n}`).join('\n');
    if (args[2] === 'show') {
      const name = args[3].split(':inbox/')[1];
      if (!Object.hasOwn(files, name)) throw new Error(`fatal: path '${name}' does not exist`);
      return files[name];
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function contentOf(r, name) { return fs.readFileSync(path.join(inbox.inboxDir(r), name), 'utf8'); }

// --- S1: the watcher stops waking for mail that asks nothing -------------

test('S1 watch: an information note on the remote does not wake (old code: status new, exit 1)', (t) => {
  const r = root(t);
  const { name } = send(r);
  const res = inbox.watch(r, PARTS, { to: 'librarian', exec: remote({ [name]: contentOf(r, name) }) });
  assert.equal(res.status, 'quiet', JSON.stringify(res));
  assert.deepEqual(res.quiet.map((q) => q.reason), ['intent-information']);
});

test('S1 watch: a request without permission waits; the remote ledger copy can permit it', (t) => {
  const r = root(t);
  const { name } = send(r, { intent: 'request' });
  const files = { [name]: contentOf(r, name) };
  const before = inbox.watch(r, PARTS, { to: 'librarian', exec: remote(files) });
  assert.equal(before.status, 'quiet');
  assert.equal(before.waiting[0].name, name);
  // A grant that exists only on the remote (given on another clone).
  const grant = JSON.stringify({ kind: 'grant', id: 'abcdef012345', ts: '2026-10-01T10:05:00Z', message: name, authority: 'user', by: null });
  const after = inbox.watch(r, PARTS, { to: 'librarian', exec: remote({ ...files, 'permissions.jsonl': `${grant}\n` }) });
  assert.equal(after.status, 'new', 'positive control: a permitted request does wake');
  assert.deepEqual(after.new, [name]);
});

test('S1 wake rule: intents, the human, fail closed without a checker', () => {
  const allow = () => ({ allowed: true, reason: 'test' });
  const m = (intent, extra = {}) => ({ name: 'x.md', to: 'librarian', state: 'open', intent, ...extra });
  for (const i of ['information', 'result', 'cancel', 'unknown']) {
    assert.equal(envelope.wakes(m(i), { permit: allow }).wakes, false, i);
  }
  for (const i of ['request', 'read', 'clarification']) {
    assert.equal(envelope.wakes(m(i), { permit: allow }).wakes, true, i);
    assert.equal(envelope.wakes(m(i)).reason, envelope.WAITING, `${i} without a checker`);
  }
  assert.equal(envelope.wakes(m('request', { to: 'user' }), { permit: allow, human: (n) => n === 'user' }).reason, 'to-human');
  assert.equal(envelope.wakes(m('request', { state: 'processed' }), { permit: allow }).wakes, false);
});

test('S1 derived intent: no Intent header -> information; In-Reply-To -> result', (t) => {
  const r = root(t);
  const q = send(r, { intent: 'request' });
  const a = send(r, { from: 'librarian', to: 'session', inReplyTo: q.name, offset: 1 });
  const plain = inbox.parse(contentOf(r, send(r, { offset: 2 }).name));
  const reply = inbox.parse(contentOf(r, a.name));
  assert.equal(plain.intent, 'information');
  assert.equal(plain.intentSource, 'default');
  assert.equal(reply.intent, 'result');
  assert.equal(reply.intentSource, 'derived');
  assert.equal(inbox.parse(contentOf(r, q.name)).intent, 'request');
  assert.throws(() => send(r, { intent: 'urgent', offset: 3 }), /Intent is one of/);
});

test('S1 only the user grants: authority user, not headless, not under a lower ceiling', (t) => {
  const r = root(t);
  const { name } = send(r, { intent: 'request' });
  assert.throws(() => mailpermit.grantMessage(r, { message: name, env: USER }), (e) => e.code === 'AUTHORITY_MISSING');
  assert.throws(() => mailpermit.grantMessage(r, { message: name, authority: 'agent', env: USER }), (e) => e.code === 'AUTHORITY_MISSING');
  assert.throws(() => mailpermit.grantBudget(r, { letters: 1, authority: 'user', env: { MEM_HEADLESS: 'watcher' } }), (e) => e.code === 'HEADLESS');
  assert.throws(() => mailpermit.grantBudget(r, { letters: 1, authority: 'user', env: { CHEAP_MEM_MAX_AUTHORITY: 'inferred' } }), (e) => e.code === 'AUTHORITY_CAPPED');
  assert.equal(fs.existsSync(mailpermit.ledgerPath(r)), false, 'a refused grant wrote nothing');
  const g = mailpermit.grantMessage(r, { message: name, authority: 'user', env: USER });
  assert.equal(g.kind, 'grant');
});

test('S1 a forged grant without authority user is disputed and does not count', (t) => {
  const r = root(t);
  const { name } = send(r, { intent: 'request' });
  fs.appendFileSync(mailpermit.ledgerPath(r),
    `${JSON.stringify({ kind: 'grant', id: 'f00000000001', ts: '2026-10-01T10:00:00Z', message: name, authority: 'agent' })}\n`);
  const st = mailpermit.status(r);
  assert.equal(st.disputed.length, 1);
  const d = inbox.wakeDecisions(r, PARTS, { to: 'librarian' });
  assert.equal(d.wake.length, 0);
  assert.equal(d.waiting.length, 1);
});

test('S1 a letter budget: reserved within one decision, charged at most once per message', (t) => {
  const r = root(t);
  send(r, { intent: 'request', offset: 0 });
  send(r, { intent: 'clarification', offset: 1 });
  send(r, { offset: 2 }); // information: never charged
  mailpermit.grantBudget(r, { letters: 1, authority: 'user', env: USER });
  const d = inbox.wakeDecisions(r, PARTS, { to: 'librarian' });
  assert.equal(d.wake.length, 1, 'one letter left, one wake');
  assert.equal(d.waiting.length, 1);
  assert.equal(d.waiting[0].decision.detail, 'budget spent');
  assert.equal(d.quiet.length, 1);
  assert.equal(inbox.chargeWakes(r, d.wake).length, 1);
  assert.equal(inbox.chargeWakes(r, d.wake).length, 0, 'the same message is never charged twice');
  const st = mailpermit.status(r);
  assert.equal(st.budgets[0].status, 'spent');
  assert.equal(st.spends[0].estimate, true, 'spend lines are marked as estimates');
  // The charged message still counts as permitted (already-spent), the other still waits.
  const again = inbox.wakeDecisions(r, PARTS, { to: 'librarian' });
  assert.equal(again.wake.length, 1);
  assert.equal(again.wake[0].decision.permit.reason, 'already-spent');
  assert.equal(again.waiting.length, 1);
});

test('S1 a token budget only lets a wake through while the estimate still fits; budgets for another role do not count', (t) => {
  const r = root(t);
  send(r, { intent: 'request', offset: 0 });
  send(r, { intent: 'request', offset: 1 });
  mailpermit.grantBudget(r, { tokens: 150, to: 'session', authority: 'user', env: USER });
  const est = { tokens: 100, source: 'test', runs: 1 };
  let d = inbox.wakeDecisions(r, PARTS, { to: 'librarian', permit: mailpermit.checker(r, { estimateValue: est }) });
  assert.equal(d.wake.length, 0, 'a budget for session does not pay for librarian');
  mailpermit.grantBudget(r, { tokens: 150, to: 'librarian', authority: 'user', env: USER });
  d = inbox.wakeDecisions(r, PARTS, { to: 'librarian', permit: mailpermit.checker(r, { estimateValue: est }) });
  assert.equal(d.wake.length, 1);
  assert.match(d.waiting[0].decision.detail, /token budget spent/);
});

test('S1 an expired budget does not count', (t) => {
  const r = root(t);
  send(r, { intent: 'request' });
  mailpermit.grantBudget(r, { letters: 5, until: '2026-01-01', authority: 'user', env: USER });
  const d = inbox.wakeDecisions(r, PARTS, { to: 'librarian' });
  assert.equal(d.wake.length, 0);
  assert.equal(d.waiting[0].decision.detail, 'budget expired');
});

test('S1 a headless run is not handed a request still waiting; a human-started session is', (t) => {
  const r = root(t);
  const q = send(r, { intent: 'request' });
  const note = send(r, { offset: 1 });
  const headless = inbox.newFor(r, PARTS, { to: 'librarian', holdWaiting: true });
  assert.deepEqual(headless.new.map((m) => m.name), [note.name]);
  assert.deepEqual(headless.waiting.map((m) => m.name), [q.name]);
  const human = inbox.newFor(r, PARTS, { to: 'librarian' });
  assert.equal(human.new.length, 2, 'positive control: the person sees everything');
});

test('S1 CLI: wake exits 0 while nothing may wake, 1 once permitted; allow refuses without authority', (t) => {
  const r = root(t);
  const env = { ...process.env, MEM_HEADLESS: '', CLAUDE_CODE_SESSION_ID: '', CHEAP_MEM_MAX_AUTHORITY: '' };
  const run = (...a) => spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8', env });
  assert.equal(run('init').status, 0);
  const w = run('inbox', 'write', '--as', 'session', '--to', 'librarian', '--subject', 'do it', '--text', 'x', '--intent', 'request');
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /waiting-for-permission/);
  const name = /Written: inbox\/(\S+)/.exec(w.stdout)[1];
  assert.equal(run('inbox', 'wake', '--as', 'librarian').status, 0);
  const refused = run('inbox', 'allow', '--letters', '1');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /--authority user/);
  assert.equal(run('inbox', 'permit', name, '--authority', 'user').status, 0);
  const woke = run('inbox', 'wake', '--as', 'librarian');
  assert.equal(woke.status, 1, woke.stdout + woke.stderr);
  assert.match(woke.stdout, /charged: 1/);
});

test('S1 mem-watch asks `inbox wake` after the pull and before the handler (bash and PowerShell)', () => {
  for (const f of ['bin/mem-watch', 'bin/mem-watch.ps1']) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    const pull = src.indexOf('pull --ff-only');
    const wake = src.search(/inbox wake/);
    const handler = f.endsWith('.ps1') ? src.indexOf('Start-Job') : src.indexOf('capped "$HANDLER_TIMEOUT"');
    assert.ok(pull > 0 && wake > pull && handler > wake, `${f}: pull ${pull}, wake ${wake}, handler ${handler}`);
  }
});

// --- S2: the reply budget -------------------------------------------------

test('S2 a reply is one turn deeper and, without an intent, a result that wakes nobody', (t) => {
  const r = root(t);
  const q = send(r, { intent: 'request' });
  const a = inbox.reply(r, PARTS, { name: q.name, as: 'librarian', text: 'done', env: NO_ID });
  const m = { name: a.name, ...inbox.parse(contentOf(r, a.name)) };
  assert.equal(m.turn, 1);
  assert.equal(m.turnMax, envelope.TURN_MAX);
  assert.equal(m.intent, 'result');
  assert.equal(envelope.wakes(m, { permit: () => ({ allowed: true }) }).reason, 'intent-result');
});

test('S2 two agents cannot ping-pong: past the turn maximum nothing wakes, budget or not', (t) => {
  const r = root(t);
  mailpermit.grantBudget(r, { letters: 50, authority: 'user', env: USER });
  let prev = send(r, { intent: 'request' });
  let from = 'librarian';
  let to = 'session';
  const verdicts = [];
  for (let i = 1; i <= envelope.TURN_MAX + 1; i += 1) {
    prev = send(r, { from, to, intent: 'request', inReplyTo: prev.name, offset: i });
    const m = { name: prev.name, ...inbox.parse(contentOf(r, prev.name)) };
    verdicts.push([m.turn, envelope.wakes(m, { permit: mailpermit.checker(r) }).reason]);
    [from, to] = [to, from];
  }
  assert.deepEqual(verdicts.at(-2), [envelope.TURN_MAX, 'yes'], 'positive control: the last turn inside the budget wakes');
  assert.deepEqual(verdicts.at(-1), [envelope.TURN_MAX + 1, 'turn-budget-spent']);
});

// --- S4: routes ------------------------------------------------------------

test('S4 pickup registers a route once, by fingerprint, never the raw session id; headless or anonymous: none', (t) => {
  const r = root(t);
  const raw = 'sess-raw-id-0001';
  const a = routes.registerOnPickup(r, { role: 'session', env: { CLAUDE_CODE_SESSION_ID: raw } });
  assert.equal(a.fresh, true);
  assert.equal(a.route.fingerprint, routes.fingerprint(raw));
  assert.equal(routes.registerOnPickup(r, { role: 'session', env: { CLAUDE_CODE_SESSION_ID: raw } }).fresh, false);
  assert.ok(!fs.readFileSync(routes.registerPath(r), 'utf8').includes(raw), 'the raw id must not be stored');
  assert.equal(routes.registerOnPickup(r, { role: 'session', env: { CLAUDE_CODE_SESSION_ID: 'y', MEM_HEADLESS: 'watcher' } }).reason, 'headless');
  assert.equal(routes.registerOnPickup(r, { role: 'session', env: {} }).reason, 'no-identity');
});

test('S4 a reply reaches the session that asked; another session of the role is not offered it', (t) => {
  const r = root(t);
  const envA = { CLAUDE_CODE_SESSION_ID: 'session-a' };
  const envB = { CLAUDE_CODE_SESSION_ID: 'session-b' };
  const routeA = routes.registerOnPickup(r, { role: 'session', env: envA }).route;
  const routeB = routes.registerOnPickup(r, { role: 'session', env: envB }).route;
  const q = send(r, { intent: 'request', env: envA });
  assert.equal(inbox.parse(contentOf(r, q.name)).fromRoute, routeA.routeId);
  const a = inbox.reply(r, PARTS, { name: q.name, as: 'librarian', text: 'answer', env: {} });
  assert.equal(inbox.parse(contentOf(r, a.name)).toRoute, routeA.routeId, 'To-Route comes from the original');
  const forB = inbox.newFor(r, PARTS, { to: 'session', mine: routeB });
  assert.equal(forB.new.length, 0);
  assert.equal(forB.elsewhere.length, 1);
  const forA = inbox.newFor(r, PARTS, { to: 'session', mine: routeA });
  assert.deepEqual(forA.new.map((m) => m.name), [a.name], 'positive control: the asking session gets it');
  assert.equal(inbox.newFor(r, PARTS, { to: 'session' }).new.length, 1, 'without a route nothing is hidden');
});

test('S4 an explicit To-Route must be a registered route of the recipient role', (t) => {
  const r = root(t);
  const lib = routes.register(r, { role: 'librarian', provider: 'claude', fingerprint: routes.fingerprint('L') });
  const ses = routes.register(r, { role: 'session', provider: 'claude', fingerprint: routes.fingerprint('S') });
  assert.throws(() => inbox.write(r, PARTS, { from: 'session', to: 'librarian', subject: 's', text: 't', toRoute: ses.routeId, env: NO_ID }), /not a registered route of role 'librarian'/);
  assert.throws(() => inbox.write(r, PARTS, { from: 'session', to: 'librarian', subject: 's', text: 't', toRoute: '00000000-0000-4000-8000-000000000000', env: NO_ID }), /not a registered route/);
  const ok = inbox.write(r, PARTS, { from: 'session', to: 'librarian', subject: 's', text: 't', toRoute: lib.routeId, env: NO_ID });
  assert.equal(inbox.parse(contentOf(r, ok.name)).toRoute, lib.routeId);
});

test('S1 the token estimate: measured mean of the last 30 days, else the named assumption', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  assert.deepEqual(mailpermit.estimateFrom([], { now }), { tokens: mailpermit.TOKEN_ASSUMPTION, source: 'assumption', runs: 0 });
  const rows = [
    { ts: '2026-09-30T00:00:00Z', inputTokens: 100, outputTokens: 50 },
    { ts: '2026-09-29T00:00:00Z', inputTokens: 300, outputTokens: null },
    { ts: '2026-01-01T00:00:00Z', inputTokens: 9e9, outputTokens: 0 }, // too old
    { ts: '2026-09-29T00:00:00Z', inputTokens: null, outputTokens: null }, // nothing measured
  ];
  assert.deepEqual(mailpermit.estimateFrom(rows, { now }), { tokens: 225, source: 'modelcost-mean-30d', runs: 2 });
  assert.equal(mailpermit.untilFrom('2026-10-03'), '2026-10-03T23:59:59.000Z', 'a date means the end of that day');
  assert.throws(() => mailpermit.untilFrom('soon'), /not a readable date/);
});
