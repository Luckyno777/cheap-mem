// Z3 (plan block Y/Z, ChatGPT letter 2026-09-30T04:26Z, points A5-A11)
// — the cheap-mem half: one projection message+claim (A5), listing
// never consumes (A6), In-Reply-To (A7), state change as an event line
// (A8), broken messages reported everywhere (A9), unpushed-mail finding
// (A10).
//
// Red proof: this file runs red on the fixed start commit
// c603848ae73cf607a6cb9aaefc140623315ab309 (own tree) — see the Z3
// report; the positive controls below run green there and show the
// probes see anything at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as inbox from '../src/inbox.mjs';
import * as c from '../src/claim.mjs';
import * as doctor from '../src/doctor.mjs';
import { tempDir } from './temp-dir.mjs';

const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };
const T0 = new Date('2026-09-30T10:00:00.000Z');
const min = (n) => new Date(T0.getTime() + n * 60_000);
const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function message(t, subject = 'please check') {
  const root = tempDir('cheap-mem-z3-', t);
  const w = inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject, text: 'Body.', now: T0 });
  return { root, name: w.name, file: w.path };
}
const stateLines = (root) => fs.readFileSync(inbox.statesPath(root), 'utf8').trim().split('\n').map((z) => JSON.parse(z));

// ---------------------------------------------------------------- A8

test('A8 positive control: ack leads to processed (old and new)', (t) => {
  const { root, name } = message(t);
  inbox.setState(root, PARTS, name, 'processed');
  assert.equal(inbox.read(root, PARTS, { to: 'librarian' }).messages[0].state, 'processed');
});

test('A8: setState does NOT rewrite the message, it appends an event line', (t) => {
  const { root, name, file } = message(t);
  const before = fs.readFileSync(file, 'utf8');
  inbox.setState(root, PARTS, name, 'replied', { by: 'librarian' });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'message file byte-identical');
  const lines = stateLines(root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].prior, 'open');
  assert.equal(lines[0].state, 'replied');
  assert.equal(lines[0].by, 'librarian');
  const m = inbox.read(root, PARTS).messages[0];
  assert.equal(m.state, 'replied');
  assert.equal(m.headerState, 'open');
  assert.equal(m.stateSource, 'event');
});

test('A8: an old message with the state in its header stays readable without migration', (t) => {
  const { root, file } = message(t);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('State: open', 'State: closed'));
  const m = inbox.read(root, PARTS).messages[0];
  assert.equal(m.state, 'closed');
  assert.equal(m.stateSource, 'header');
});

test('A8: closed -> open without a reason is refused; with a reason it is its own event', (t) => {
  const { root, name } = message(t);
  inbox.setState(root, PARTS, name, 'closed');
  assert.throws(() => inbox.setState(root, PARTS, name, 'open'), /needs a reason/);
  inbox.setState(root, PARTS, name, 'open', { reason: 'one more question' });
  assert.equal(inbox.read(root, PARTS).messages[0].state, 'open');
  assert.equal(stateLines(root).length, 2, 'history complete');
});

test('A8: a stale writer (expected) cannot reset a close', (t) => {
  const { root, name } = message(t);
  inbox.setState(root, PARTS, name, 'replied');
  assert.throws(() => inbox.setState(root, PARTS, name, 'processed', { expected: 'open' }),
    (e) => e.code === 'STATE_CONFLICT');
  assert.equal(inbox.read(root, PARTS).messages[0].state, 'replied');
});

test('A8: a distributed conflict after a merge is visible, not last-writer-wins', (t) => {
  const { root, name } = message(t);
  const z = (state, time, id) => JSON.stringify({ kind: 'state', message: name, prior: 'open', state, by: null, reason: null, time, id });
  fs.writeFileSync(inbox.statesPath(root), `${z('closed', min(2).toISOString(), 'b')}\n${z('replied', min(1).toISOString(), 'a')}\n`);
  const m = inbox.read(root, PARTS).messages[0];
  assert.equal(m.state, 'replied', 'the earlier line counts, regardless of file order');
  assert.equal(m.stateConflicts.length, 1);
  assert.match(m.stateConflicts[0].why, /stale writer/);
});

test('A8: states.jsonl is not a message: read() does not see it', (t) => {
  const { root, name } = message(t);
  inbox.setState(root, PARTS, name, 'closed');
  const r = inbox.read(root, PARTS);
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.broken, []);
});

// ---------------------------------------------------------------- A5

test('A5 positive control: a fresh message is new', (t) => {
  const { root } = message(t);
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: T0 }).new.length, 1);
});

test('A5: claim done -> every reader sees processed, newFor no longer reports it', (t) => {
  const { root, name } = message(t);
  const k = c.claim(root, name, { by: 'librarian', now: T0 });
  c.done(root, name, { by: 'librarian', claimId: k.id, now: min(1) });
  const m = inbox.read(root, PARTS).messages[0];
  assert.equal(m.state, 'processed');
  assert.equal(m.stateSource, 'claim');
  assert.equal(m.headerState, 'open', 'the header stays what it was');
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: min(2) }).new.length, 0);
  assert.equal(inbox.stateOf(root, name).state, 'processed');
});

test('A5: a valid claim shows up in the projection (holder)', (t) => {
  const { root, name } = message(t);
  c.claim(root, name, { by: 'agent-a', now: new Date() });
  const m = inbox.read(root, PARTS).messages[0];
  assert.equal(m.claim.status, 'claimed');
  assert.equal(m.claim.holder, 'agent-a');
  assert.equal(m.state, 'open');
});

// ---------------------------------------------------------------- A6

test('A6: listing (read / newFor) changes no state', (t) => {
  const { root } = message(t);
  inbox.read(root, PARTS, { to: 'librarian' });
  inbox.newFor(root, PARTS, { to: 'librarian', now: T0 });
  assert.equal(fs.existsSync(path.join(root, inbox.SEEN_FILE)), false, 'no seen mark from reading');
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: T0 }).new.length, 1);
});

test('A6: a listed but still open message comes back after the back-off (crash after the listing)', (t) => {
  const { root, name } = message(t);
  inbox.markSeen(root, { to: 'librarian', names: [name], now: T0 });
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: min(5) }).new.length, 0, 'not at once — no endless repeat');
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: min(16) }).new.length, 1, 'but not consumed either');
  inbox.markSeen(root, { to: 'librarian', names: [name], now: min(16) });
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: min(40) }).new.length, 0, 'back-off grows (30 min)');
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: min(47) }).new.length, 1);
  inbox.setState(root, PARTS, name, 'processed');
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: min(600) }).new.length, 0, 'done is done');
});

test('A6: an old seen file (name list) stays readable and is due once more', (t) => {
  const { root, name } = message(t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, inbox.SEEN_FILE), JSON.stringify({ librarian: [name] }));
  assert.equal(inbox.newFor(root, PARTS, { to: 'librarian', now: T0 }).new.length, 1);
  assert.equal(inbox.remoteNew(root, PARTS, { to: 'librarian', names: [`inbox/${name}`] }).known, 1);
});

// ---------------------------------------------------------------- A7

test('A7 positive control: a reply still carries the Re: subject', (t) => {
  const { root, name } = message(t);
  const r = inbox.reply(root, PARTS, { name, as: 'librarian', text: 'Answer.' });
  assert.equal(inbox.parse(fs.readFileSync(r.path, 'utf8')).subject, 'Re: please check');
});

test('A7: reply writes In-Reply-To with the original file name; two same-subject threads stay apart', (t) => {
  const { root, name } = message(t, 'same subject');
  const other = inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 'same subject', text: 'Other.', now: min(1) });
  const r1 = inbox.reply(root, PARTS, { name, as: 'librarian', text: 'A1', now: min(2) });
  const r2 = inbox.reply(root, PARTS, { name: other.name, as: 'librarian', text: 'A2', now: min(3) });
  assert.equal(inbox.parse(fs.readFileSync(r1.path, 'utf8')).inReplyTo, name);
  assert.equal(inbox.parse(fs.readFileSync(r2.path, 'utf8')).inReplyTo, other.name);
});

test('A7: write checks In-Reply-To — it must exist and go the other way', (t) => {
  const { root, name } = message(t);
  assert.throws(() => inbox.write(root, PARTS, { from: 'librarian', to: 'session', subject: 's', text: 't', inReplyTo: '2026-01-01T00-00-00Z--session-to-librarian.md' }), /No message/);
  assert.throws(() => inbox.write(root, PARTS, { from: 'user', to: 'session', subject: 's', text: 't', inReplyTo: name }), /a reply to it goes/);
  const ok = inbox.write(root, PARTS, { from: 'librarian', to: 'session', subject: 's', text: 't', inReplyTo: name });
  assert.equal(inbox.parse(fs.readFileSync(ok.path, 'utf8')).inReplyTo, name);
  assert.equal(inbox.parse(fs.readFileSync(message(t).file, 'utf8')).inReplyTo, null, 'old mail: null, not an error');
});

// ---------------------------------------------------------------- A9

test('A9: newFor passes broken messages on; healthy mail keeps being delivered', (t) => {
  const { root } = message(t);
  fs.writeFileSync(path.join(inbox.inboxDir(root), '2026-09-30T10-05-00Z--session-to-librarian.md'), 'broken, no header');
  const r = inbox.newFor(root, PARTS, { to: 'librarian', now: T0 });
  assert.equal(r.new.length, 1, 'the healthy message stays deliverable');
  assert.equal(r.broken.length, 1);
  assert.match(r.broken[0].name, /10-05-00Z/);
});

test('A9: an unreadable state line is counted, not skipped silently', (t) => {
  const { root } = message(t);
  fs.writeFileSync(inbox.statesPath(root), '{broken\n');
  const r = inbox.newFor(root, PARTS, { to: 'librarian', now: T0 });
  assert.equal(r.eventsBroken.length, 1);
  assert.equal(r.eventsBroken[0].file, 'states.jsonl');
  assert.equal(doctor.checkDelivery(root).level, 'error', 'the doctor says it too');
});

test('A9: CLI inbox new names the broken message even with "Nothing new"', (t) => {
  const root = tempDir('cheap-mem-z3-cli-', t);
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', '2026-09-30T10-05-00Z--session-to-librarian.md'), 'broken');
  const r = spawnSync('node', [MEM, '--root', root, 'inbox', 'new', '--as', 'librarian'], { encoding: 'utf8' });
  assert.match(r.stdout, /Nothing new/, 'positive control: the CLI ran at all');
  assert.match(r.stderr + r.stdout, /unreadable message in the inbox: 2026-09-30T10-05-00Z--session-to-librarian\.md/);
});

// ---------------------------------------------------------------- A10

function gitRepoWithUpstream(t) {
  const base = tempDir('cheap-mem-z3-git-', t);
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'clone');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe', encoding: 'utf8', env });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'x'), 'x\n');
  g('add', 'x'); g('commit', '-q', '-m', 'start');
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'main');
  return { root, g };
}

test('A10 positive control: a fresh clone with no mail is good', (t) => {
  const { root } = gitRepoWithUpstream(t);
  assert.equal(doctor.checkInboxUnpushed(root).level, 'good');
});

test('A10: an unpushed message is warn, after 60 min error; pushed it is good again', (t) => {
  const { root, g } = gitRepoWithUpstream(t);
  inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 's', text: 't' });
  const f1 = doctor.checkInboxUnpushed(root);
  assert.equal(f1.level, 'warn');
  assert.match(f1.text, /1 not committed/);
  g('add', '-A'); g('commit', '-q', '-m', 'inbox');
  const late = new Date(Date.now() + 61 * 60_000);
  const f2 = doctor.checkInboxUnpushed(root, { now: late });
  assert.equal(f2.level, 'error');
  assert.match(JSON.stringify(f2), /1 committed but not pushed/);
  g('push', '-q');
  assert.equal(doctor.checkInboxUnpushed(root, { now: late }).level, 'good');
});

test('A10: an unpushed acknowledgement (states.jsonl) counts too', (t) => {
  const { root, g } = gitRepoWithUpstream(t);
  const w = inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 's', text: 't' });
  g('add', '-A'); g('commit', '-q', '-m', 'inbox'); g('push', '-q');
  inbox.setState(root, PARTS, w.name, 'processed');
  const f = doctor.checkInboxUnpushed(root);
  assert.equal(f.level, 'warn');
  assert.match(JSON.stringify(f), /states\.jsonl/);
});

test('A10: without an upstream it is unknown, never good', (t) => {
  const root = tempDir('cheap-mem-z3-noup-', t);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  assert.equal(doctor.checkInboxUnpushed(root).level, 'unknown');
});

// ---------------------------------------------------------------- A11

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem-mcp');
function bridge(root, calls, agent) {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  let id = 10;
  for (const [name, a] of calls) lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  const r = spawnSync(process.execPath, [MCP], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: agent } });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  assert.ok(replies.length >= calls.length + 1, `bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 400)}`);
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}

test('A11: over MCP the whole lifecycle — failed and claims, identity from the connection', (t) => {
  const root = tempDir('cheap-mem-z3-mcp-', t);
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'pipe' });
  const w = inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 'work', text: 'do it' });
  const [cl] = bridge(root, [['mem_inbox_claim', { name: w.name }]], 'librarian');
  assert.equal(cl.structuredContent.valid, true, 'positive control: the O1 tool works');
  const id = cl.structuredContent.claim_id;
  const [st, foreign, own] = bridge(root, [
    ['mem_inbox_claims', { name: w.name, claim_id: id }],
  ], 'librarian').concat(
    bridge(root, [['mem_inbox_failed', { name: w.name, claim_id: id, reason: 'x' }]], 'session'),
    bridge(root, [['mem_inbox_failed', { name: w.name, claim_id: id, reason: 'cannot' }]], 'librarian'),
  );
  assert.equal(st.structuredContent.mine_valid, true);
  assert.equal(st.structuredContent.holder, 'librarian');
  assert.equal(foreign.isError, true, 'a stranger cannot give up my claim');
  assert.equal(own.structuredContent.valid, true);
  assert.equal(c.status(root, w.name).status, c.STATUS.FREE, 'released at once');
});
