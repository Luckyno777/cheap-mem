// Client-Request-Id — semantics ported from lucky-mem/src/umschlag.mjs
// (Doppel-Marke), not the field name. See src/inbox.mjs for the reasoning.
//
// Three states, never two: 'new' | 'replay' | 'conflict'. The point of
// this file is to prove each state is reachable AND that the boundary
// between them sits on the id, not on the text — the two failure modes
// that matter are collapsing conflict into replay (silently accepting a
// changed body under a reused id) and deduplicating by text instead of
// id (silently dropping a second, differently-intentioned request that
// happens to read the same). Both are sabotage-checked below.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as inbox from '../src/inbox.mjs';

const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-reqid-')); }

test('build + parse round-trip carries Client-Request-Id', () => {
  const content = inbox.build(PARTS, {
    from: 'session', to: 'librarian',
    time: '2026-01-01T00:00:00Z', subject: 's', text: 'body',
    requestId: 'req-abc.1',
  });
  assert.match(content, /^Client-Request-Id: req-abc\.1$/m);
  const p = inbox.parse(content);
  assert.equal(p.requestId, 'req-abc.1');
});

test('build rejects a malformed Client-Request-Id', () => {
  assert.throws(() => inbox.build(PARTS, {
    from: 'session', to: 'librarian',
    time: '2026-01-01T00:00:00Z', subject: 's', text: 'body',
    requestId: 'has a space',
  }), /Client-Request-Id/);
});

test('a message without the field parses exactly as before (schema evolution)', () => {
  // This is the literal shape of a message written before this field
  // existed — no fifth header line at all, not an empty one.
  const old = 'From: session\nTo: librarian\nTime: 2026-01-01T00:00:00Z\n'
    + 'Subject: pre-existing\nState: open\n\nold body\n';
  const p = inbox.parse(old);
  assert.equal(p.requestId, null, 'absence reads as null, never as a thrown parse error');
  assert.equal(p.text, 'old body');
});

test('classifyRequest: no prior message with this id -> new', () => {
  const root = tmpRoot();
  const r = inbox.classifyRequest(root, PARTS, {
    from: 'session', to: 'librarian', requestId: 'r1', text: 'do the thing',
  });
  assert.equal(r, inbox.REQUEST.NEW);
});

test('classifyRequest: same id, same body -> replay (idempotent resend)', () => {
  const root = tmpRoot();
  inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 's', text: 'do the thing', requestId: 'r1',
  });
  const r = inbox.classifyRequest(root, PARTS, {
    from: 'session', to: 'librarian', requestId: 'r1', text: 'do the thing',
  });
  assert.equal(r, inbox.REQUEST.REPLAY);
});

test('classifyRequest: same id, different body -> conflict, never silent dedup', () => {
  const root = tmpRoot();
  inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 's', text: 'do the thing', requestId: 'r1',
  });
  const r = inbox.classifyRequest(root, PARTS, {
    from: 'session', to: 'librarian', requestId: 'r1', text: 'do a DIFFERENT thing',
  });
  assert.equal(r, inbox.REQUEST.CONFLICT);
});

test('positive control: different id, identical text -> both are new (no text-based dedup)', () => {
  const root = tmpRoot();
  inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 's1', text: 'ping', requestId: 'r1',
  });
  // Same wording, different id: two genuinely intended requests must
  // both go through. Deduplicating on text would silently drop this one.
  const r = inbox.classifyRequest(root, PARTS, {
    from: 'session', to: 'librarian', requestId: 'r2', text: 'ping',
  });
  assert.equal(r, inbox.REQUEST.NEW);
});

test('a message with no Client-Request-Id behaves as before: always new', () => {
  const root = tmpRoot();
  inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 's', text: 'no id here' });
  const r = inbox.classifyRequest(root, PARTS, {
    from: 'session', to: 'librarian', requestId: null, text: 'no id here',
  });
  assert.equal(r, inbox.REQUEST.NEW);
});

test('classifyRequest is scoped by sender: another sender reusing the id is still new', () => {
  const root = tmpRoot();
  inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 's', text: 'do the thing', requestId: 'r1',
  });
  const r = inbox.classifyRequest(root, PARTS, {
    from: 'user', to: 'librarian', requestId: 'r1', text: 'do the thing',
  });
  assert.equal(r, inbox.REQUEST.NEW, 'a request id is only meaningful within its own sender');
});
