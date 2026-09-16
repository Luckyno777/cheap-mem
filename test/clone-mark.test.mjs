// Two clones, one filename, a drawer nobody can read.
//
// Two clones of the same memory can write the same message in the same
// second: same sender, same recipient, same timestamp — same filename,
// different content. Both are allowed to; each creates the file
// exclusively and cannot see the other.
//
//   git       add/add conflict on the same path
//   rebase    blocked
//   watcher   commits the conflict markers along with everything else
//   parser    throws on the markers
//   drawer    unreadable
//   delivery  silent, and every agent behind it looks dead
//
// Exclusive creation solves collisions WITHIN one clone. Between two
// clones it can do nothing; there the only fix is that two clones do
// not form the same name.
// Covers assurances from shared/invariants.jsonl. The id is the
// shared language between the houses; the prose there names the
// incident that forced it.
// invariant: klon-marke-im-namen
// invariant: zaehler-bleibt-lesbar
// invariant: laufzeitzustand-reist-nicht
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as inbox from '../src/inbox.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHO = { session: 'a session', librarian: 'the curator' };
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mark-'));
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

test('two clones do NOT form the same name for the same message', () => {
  const a = root();
  const b = root();
  try {
    const t = new Date('2026-09-08T12:00:00Z');
    const one = inbox.write(a, WHO, { from: 'session', to: 'librarian', subject: 's', text: 'ONE', now: t });
    const two = inbox.write(b, WHO, { from: 'session', to: 'librarian', subject: 's', text: 'TWO', now: t });
    assert.notEqual(one.name, two.name,
      'both clones formed the same filename — in git that is an add/add '
      + 'conflict, and one of those has already left a drawer unreadable');
    assert.ok(inbox.fromFileName(WHO, one.name), `unreadable: ${one.name}`);
    assert.ok(inbox.fromFileName(WHO, two.name), `unreadable: ${two.name}`);
  } finally { away(a); away(b); }
});

test('the mark stays the same within one clone', () => {
  const r = root();
  try {
    const m = inbox.cloneMark(r);
    assert.match(m, /^[a-z0-9]{1,12}$/);
    assert.equal(inbox.cloneMark(r), m, 'the mark changed between two calls');
    const a = inbox.write(r, WHO, { from: 'session', to: 'librarian', subject: 'a', text: 'x' });
    assert.ok(a.name.includes(`~${m}`), `${a.name} does not carry ${m}`);
  } finally { away(r); }
});

test('the mark gives nothing away about the machine', () => {
  // A message name travels. A hostname, a path or a user name in it
  // would be a disclosure nobody decided on.
  const r = root();
  try {
    const m = inbox.cloneMark(r);
    assert.match(m, /^[a-z0-9]{1,12}$/);
    for (const forbidden of [os.hostname(), os.userInfo().username]) {
      if (!forbidden) continue;
      assert.ok(!m.includes(String(forbidden).toLowerCase().slice(0, 4)),
        `the mark contains part of '${forbidden}'`);
    }
  } finally { away(r); }
});

test('messages without a mark stay readable', () => {
  // Existing drawers are full of unmarked names. A parser that only
  // accepts marked ones makes all of them unreadable at a stroke —
  // the same silence, only bigger.
  const n = '2026-09-07T08-01-46Z--session-to-librarian.md';
  const parts = inbox.fromFileName(WHO, n);
  assert.ok(parts, 'an unmarked message became unreadable');
  assert.equal(parts.to, 'librarian');
});

test('the mark itself must never travel', () => {
  // Played through with two real git clones, the conflict moved from
  // the messages onto the mark FILE: two clones, two marks, one path,
  // add/add. Here `.pipeline/` is ignored, so it does not happen — but
  // the repair rests on that, and an unchecked assumption is the same
  // outage under a new name.
  const ignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.pipeline\/?$/m,
    'the clone mark lives in .pipeline/ and MUST stay ignored — otherwise '
    + 'the add/add conflict moves from the messages onto the mark');
});
