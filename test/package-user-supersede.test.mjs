// Paket (2026-09-30): rank alignment with lucky-mem Y4c (src/rang.mjs
// darfAendern). `user` is ONE person: two user-tier lines written down by
// different sessions (session A recorded the rule, session B the
// correction) are the same author — the writer is only the scribe. Before
// this, maySupersede refused every correction of a user rule made by a
// different scribe ("same tier (user) but different authors").
//
// Red on the old state (authority.mjs before this change): the first test
// fails with "same tier (user) but different authors". Positive control:
// agent against a different agent stays strict, and a lower tier still
// cannot replace a user claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maySupersede, mayChangeState } from '../src/authority.mjs';
import { retiredMap } from '../src/memory.mjs';

const RULE = { id: 'u1', ts: '2026-01-01T00:00:00Z', author: 'session-a', authority: 'user', text: 'rule' };
const FIX = { id: 'u2', ts: '2026-01-02T00:00:00Z', author: 'session-b', authority: 'user', text: 'rule, fixed', replaces_id: 'u1' };

test('user replaces user across scribes (one person)', () => {
  const v = maySupersede(FIX, RULE);
  assert.equal(v.ok, true, v.reason);
  assert.equal(mayChangeState(FIX, RULE, 'replaces_id').status, 'allowed');
  const m = retiredMap([RULE, FIX]);
  assert.equal(m.get('u1')?.state, 'superseded', JSON.stringify(m.get('u1')));
  assert.equal(m.get('u1')?.by, 'u2');
});

test('positive control: agent against a different agent stays strict', () => {
  const a = { id: 'a1', author: 'session-a', authority: 'agent', text: 'x' };
  const b = { id: 'a2', author: 'session-b', authority: 'agent', text: 'y', replaces_id: 'a1' };
  const v = maySupersede(b, a);
  assert.equal(v.ok, false);
  assert.match(v.reason, /same tier \(agent\) but different authors/);
  assert.equal(retiredMap([a, b]).get('a2')?.state, 'disputed');
});

test('positive control: a lower tier still cannot replace a user claim', () => {
  const low = { ...FIX, authority: 'agent' };
  assert.equal(maySupersede(low, RULE).ok, false);
  const inferred = { ...FIX, authority: 'inferred', author: 'digest' };
  assert.equal(maySupersede(inferred, RULE).ok, false);
  // and a user claim does not ride on another user's line for a lower target
  assert.equal(maySupersede(FIX, { ...RULE, authority: 'agent' }).ok, true, 'user outranks agent anyway');
});
