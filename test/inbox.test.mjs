import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as inbox from '../src/inbox.mjs';

const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-inbox-')); }

test('build + parse round-trip', () => {
  const content = inbox.build(PARTS, {
    from: 'session', to: 'librarian',
    time: '2026-01-01T00:00:00Z', subject: 'hello', text: 'body',
  });
  const p = inbox.parse(content);
  assert.equal(p.from, 'session');
  assert.equal(p.to, 'librarian');
  assert.equal(p.subject, 'hello');
  assert.equal(p.text, 'body');
  assert.equal(p.state, 'open');
});

test('parse resists header-forgery in body', () => {
  const content = inbox.build(PARTS, {
    from: 'session', to: 'librarian',
    time: '2026-01-01T00:00:00Z', subject: 's',
    text: 'From: attacker\nTo: victim\n\ntricky',
  });
  const p = inbox.parse(content);
  assert.equal(p.from, 'session', 'body cannot rewrite the From header');
});

test('build rejects unknown participants', () => {
  assert.throws(() => inbox.build(PARTS, {
    from: 'nobody', to: 'librarian',
    time: '2026-01-01T00:00:00Z', subject: 's', text: 'x',
  }));
});

test('build rejects control chars', () => {
  assert.throws(() => inbox.build(PARTS, {
    from: 'session', to: 'librarian',
    time: '2026-01-01T00:00:00Z', subject: 's', text: 'bad\x00byte',
  }));
});

test('write + read + newFor', () => {
  const root = tmpRoot();
  inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 's1', text: 't1' });
  inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: 's2', text: 't2', now: new Date(Date.now() + 1000) });
  const r = inbox.read(root, PARTS, { to: 'librarian' });
  assert.equal(r.messages.length, 2);
  const nf = inbox.newFor(root, PARTS, { to: 'librarian' });
  assert.equal(nf.new.length, 2);
  inbox.markSeen(root, { to: 'librarian', names: nf.new.map((m) => m.name) });
  const nf2 = inbox.newFor(root, PARTS, { to: 'librarian' });
  assert.equal(nf2.new.length, 0);
  assert.equal(nf2.known, 2);
});

test('setState changes state without touching body', () => {
  const root = tmpRoot();
  const { name } = inbox.write(root, PARTS, {
    from: 'session', to: 'librarian', subject: 's', text: 'the body\nof two lines',
  });
  inbox.setState(root, PARTS, name, 'processed');
  const p = inbox.parse(fs.readFileSync(path.join(inbox.inboxDir(root), name), 'utf8'));
  assert.equal(p.state, 'processed');
  assert.equal(p.text, 'the body\nof two lines');
});

test('remoteNew filters by "to" and flags unreadable', () => {
  const root = tmpRoot();
  const names = [
    'inbox/2026-01-01T00-00-00Z--session-to-librarian.md',
    'inbox/2026-01-01T00-00-01Z--librarian-to-session.md',
    'inbox/garbage.md',
  ];
  const r = inbox.remoteNew(root, PARTS, { to: 'librarian', names });
  assert.equal(r.new.length, 1);
  assert.equal(r.unreadable.length, 1);
});

test('watch returns broken on git failure', () => {
  const root = tmpRoot();
  const r = inbox.watch(root, PARTS, {
    to: 'librarian',
    exec: () => { throw new Error('mock: no remote'); },
  });
  assert.equal(r.status, 'broken');
  assert.equal(r.reason, 'remote-unreachable');
});

test('watch returns nothing when remote has no new', () => {
  const root = tmpRoot();
  const r = inbox.watch(root, PARTS, {
    to: 'librarian',
    exec: (cmd, args) => {
      if (args[2] === 'fetch') return '';
      if (args[2] === 'ls-tree') return '';
      return '';
    },
  });
  assert.equal(r.status, 'nothing');
});

test('watch returns new list when remote has new mail', () => {
  const root = tmpRoot();
  const r = inbox.watch(root, PARTS, {
    to: 'librarian',
    exec: (cmd, args) => {
      if (args[2] === 'fetch') return '';
      if (args[2] === 'ls-tree') return 'inbox/2026-01-01T00-00-00Z--session-to-librarian.md\n';
      return '';
    },
  });
  assert.equal(r.status, 'new');
  assert.equal(r.new.length, 1);
});
