// X4: claim with expiry (src/claim.mjs).
//
// Red proof (rule 12): at the fixed start commit ea4d78c there is no
// such module; the first test records that, with a pinned hash (never
// merge-base). Positive control: the normal path without a claim works
// as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as inbox from '../src/inbox.mjs';
import * as c from '../src/claim.mjs';
import { tempDir } from './temp-dir.mjs';

const START_COMMIT = 'ea4d78c25a1f386a7f005ab8f569234f371215e8';
const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };
const T0 = new Date('2026-09-30T10:00:00.000Z');
const min = (n) => new Date(T0.getTime() + n * 60_000);

function message(t) {
  const root = tempDir('cheap-mem-claim-', t);
  const w = inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 'please check', text: 'Body.', now: T0,
  });
  return { root, name: w.name };
}

test('red proof: the fixed start commit has no claim module', (t) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${START_COMMIT}:src/inbox.mjs`], { stdio: 'ignore' });
  } catch { t.skip('start commit not in this clone (shallow) — unknown, not green'); return; }
  let found = true;
  try {
    execFileSync('git', ['cat-file', '-e', `${START_COMMIT}:src/claim.mjs`], { stdio: 'pipe' });
  } catch { found = false; }
  assert.equal(found, false, 'before X4 there was no claim');
});

test('positive control: without a claim everything behaves as before', (t) => {
  const { root, name } = message(t);
  const s = c.status(root, name, { now: T0 });
  assert.equal(s.status, c.STATUS.FREE);
  assert.equal(s.claimable, true);
  assert.equal(fs.existsSync(c.filePath(root)), false, 'reading writes nothing');
  inbox.setState(root, PARTS, name, inbox.STATE.PROCESSED);
  assert.equal(inbox.read(root, PARTS, { to: 'librarian' }).messages[0].state, 'processed');
});

test('the claims file is not a message: read() does not see it', (t) => {
  const { root, name } = message(t);
  c.claim(root, name, { by: 'a', now: T0 });
  const r = inbox.read(root, PARTS);
  assert.equal(r.messages.length, 1);
  assert.deepEqual(r.broken, []);
});

test('the first claim counts, default 30 minutes', (t) => {
  const { root, name } = message(t);
  assert.equal(c.claim(root, name, { by: 'a', now: T0 }).valid, true);
  const s = c.status(root, name, { now: min(29) });
  assert.equal(s.status, c.STATUS.CLAIMED);
  assert.equal(s.holder.until, '2026-09-30T10:30:00.000Z');
  assert.equal(c.status(root, name, { now: min(30) }).status, c.STATUS.EXPIRED);
});

test('a second claim during a valid one: written, not valid, visible', (t) => {
  const { root, name } = message(t);
  c.claim(root, name, { by: 'a', now: T0 });
  const b = c.claim(root, name, { by: 'b', now: min(5) });
  assert.equal(b.valid, false);
  assert.match(b.reason, /second, not valid/);
  const s = c.status(root, name, { now: min(6) });
  assert.equal(s.holder.claimed_by, 'a');
  assert.equal(s.invalid.length, 1, 'never silently dropped');
  assert.equal(s.invalid[0].claimed_by, 'b');
  assert.equal(c.readLines(root).lines.length, 2, 'both lines are in the file');
});

test('after expiry the next one counts (resumption)', (t) => {
  const { root, name } = message(t);
  const a = c.claim(root, name, { by: 'a', minutes: 10, now: T0 });
  const b = c.claim(root, name, { by: 'b', now: min(11) });
  assert.equal(b.valid, true);
  const s = c.status(root, name, { now: min(12) });
  assert.equal(s.holder.claimed_by, 'b');
  assert.equal(s.resumptions, 1);
  assert.equal(c.check(root, name, a.id, { now: min(12) }).valid, false, 'the old one no longer counts');
});

test('failed releases at once, with a reason', (t) => {
  const { root, name } = message(t);
  const ca = c.claim(root, name, { by: 'a', now: T0 });
  const f = c.failed(root, name, { by: 'a', claimId: ca.id, reason: 'network gone', now: min(1) });
  assert.equal(f.status, c.STATUS.FREE);
  assert.equal(f.failures[0].reason, 'network gone');
  assert.equal(c.claim(root, name, { by: 'b', now: min(2) }).valid, true, 'before a expired, but released');
  assert.throws(() => c.failed(root, name, { by: 'b', claimId: 'bbbbbbbbbbbb', reason: '  ', now: min(3) }), /reason/);
});

test('done ends it; later claims and a foreign done are visibly invalid', (t) => {
  const { root, name } = message(t);
  const ca = c.claim(root, name, { by: 'a', now: T0 });
  c.done(root, name, { by: 'x', claimId: ca.id, now: min(1) });
  assert.equal(c.status(root, name, { now: min(2) }).status, c.STATUS.CLAIMED, 'a stranger cannot finish it');
  c.done(root, name, { by: 'a', claimId: ca.id, now: min(3) });
  assert.equal(c.claim(root, name, { by: 'b', now: min(60) }).valid, false);
  const s = c.status(root, name, { now: min(61) });
  assert.equal(s.status, c.STATUS.DONE);
  assert.equal(s.claimable, false);
  assert.equal(s.invalid.length, 2);
});

test('merge of two hosts: line order in the file does not matter, both read the same', (t) => {
  const { root, name } = message(t);
  // Two hosts claim in the same millisecond, each in its own clone; after
  // `merge=union` both lines are there, in either order.
  const line = (by, id) => ({ kind: 'claim', message: name, claimed_by: by,
    until: min(30).toISOString(), time: T0.toISOString(), id });
  const a = line('host-a', 'aaaaaaaaaaaa');
  const b = line('host-b', 'bbbbbbbbbbbb');
  const holder = (lines) => c.fold(lines, { now: min(1) }).holder.claimed_by;
  assert.equal(holder([a, b]), 'host-a');
  assert.equal(holder([b, a]), 'host-a', 'stable key on a tie');
  const later = { ...b, time: min(2).toISOString() };
  assert.equal(holder([later, a]), 'host-a');
  assert.equal(c.fold([later, { ...a, time: min(3).toISOString() }], { now: min(4) }).holder.claimed_by, 'host-b');
  // through the file: the loser sees it at its next read
  fs.mkdirSync(inbox.inboxDir(root), { recursive: true });
  fs.writeFileSync(c.filePath(root), `${JSON.stringify(b)}\n${JSON.stringify(a)}\n`);
  assert.equal(c.check(root, name, 'bbbbbbbbbbbb', { now: min(1) }).valid, false);
  assert.equal(c.check(root, name, 'aaaaaaaaaaaa', { now: min(1) }).valid, true);
});

test('broken lines are counted, not silently skipped; the file only grows', (t) => {
  const { root, name } = message(t);
  c.claim(root, name, { by: 'a', now: T0 });
  const before = fs.readFileSync(c.filePath(root), 'utf8');
  fs.appendFileSync(c.filePath(root), 'not json\n{"kind":"claim"}\n');
  c.claim(root, name, { by: 'b', now: min(1) });
  assert.equal(c.status(root, name, { now: min(2) }).broken.length, 2);
  assert.ok(fs.readFileSync(c.filePath(root), 'utf8').startsWith(before), 'append-only');
});

test('orphaned: expired with neither done nor failed', (t) => {
  const { root, name } = message(t);
  const ca = c.claim(root, name, { by: 'a', minutes: 5, now: T0 });
  assert.deepEqual(c.orphaned(root, { now: min(4) }), []);
  assert.equal(c.orphaned(root, { now: min(6) })[0].holder, 'a');
  c.failed(root, name, { by: 'a', claimId: ca.id, reason: 'crash reported', now: min(7) });
  assert.deepEqual(c.orphaned(root, { now: min(8) }), []);
});

test('inputs: unknown message, bad name, bad claimant', (t) => {
  const { root, name } = message(t);
  assert.throws(() => c.claim(root, 'nope.md', { by: 'a' }), /No message/);
  assert.throws(() => c.claim(root, '../x', { by: 'a' }), /not a filename|is a path/);
  assert.throws(() => c.claim(root, name, { by: 'a b' }), /Claimant/);
});
