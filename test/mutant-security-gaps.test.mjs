// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Guarantees that the risk-ordered mutants in bench/mutation.mjs found
// to have no test of their own (survivors of `node bench/mutation.mjs
// --security`). One test per surviving mutant; each is red on the mutant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as redaction from '../src/redaction.mjs';
import * as login from '../src/login.mjs';
import * as inbox from '../src/inbox.mjs';
import { grant } from '../src/capability.mjs';
import { tempDir } from './temp-dir.mjs';

const STRIPE = 'sk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2';

test('redaction: a Stripe key is masked (and the canary is a real match)', () => {
  const r = redaction.redact(`charge with ${STRIPE} now`);
  assert.ok(!r.text.includes(STRIPE), 'key left the redaction');
  assert.ok(r.found.some((f) => f.type === 'stripe-key'));
});

test('redaction: secrets inside arrays, also nested, are masked', () => {
  const found = new Map();
  const out = redaction.redactObject({ lines: ['ok', `k ${STRIPE}`, [`deep ${STRIPE}`]] }, found);
  assert.ok(!JSON.stringify(out).includes(STRIPE), 'a key survived inside an array');
  assert.equal(found.get('stripe-key'), 2);
});

test('login: a session past its expiry is not signed in, even if the file still lists it', (t) => {
  const dir = tempDir('cm-login-exp-', t);
  login.setPassword(dir, 'a-proper-long-password', 1000);
  const token = login.newSession(dir, 1000);
  assert.equal(login.checkSession(dir, token, 2000).valid, true);
  assert.equal(login.checkSession(dir, token, 1000 + login.LIFETIME_MS + 1).valid, false);
});

test('capability: narrow() cannot take a scope the descendant-less global does not cover', () => {
  const cap = grant({ scopes: ['global'], descendants: false });
  assert.deepEqual([...cap.narrow({ scopes: ['project:a'] }).scopes], []);
  assert.equal(grant({ scopes: ['global'], descendants: true }).narrow({ scopes: ['project:a'] }).scopes.length, 1,
    'positive control: with descendants the same narrow keeps it');
});

test('capability: global is not admitted by a capability without the read right', () => {
  const w = grant({ scopes: ['project:a'], rights: ['write'] });
  assert.equal(w.admits('global'), false);
  assert.equal(grant({ scopes: ['project:a'], rights: ['read'] }).admits('global'), true, 'positive control');
});

test('inbox: a message name carrying a path is refused', () => {
  for (const n of ['../x.md', 'a/b.md', 'a\\b.md', '..']) {
    assert.throws(() => inbox.checkMessageName(n), /path, not a filename/, n);
  }
  assert.doesNotThrow(() => inbox.checkMessageName('2026-01-01-a-to-b.md'));
});

test('inbox: a token in a message never reaches the disk', (t) => {
  const root = tempDir('cm-inbox-red-', t);
  const parts = { user: 'H', session: 'AI', librarian: 'lib' };
  const res = inbox.write(root, parts, {
    from: 'session', to: 'librarian', subject: `key ${STRIPE}`, text: `body ${STRIPE}`,
  });
  assert.ok(res.findings.length > 0);
  const dir = inbox.inboxDir(root);
  for (const f of fs.readdirSync(dir)) {
    assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(STRIPE), `plaintext key in ${f}`);
  }
});
