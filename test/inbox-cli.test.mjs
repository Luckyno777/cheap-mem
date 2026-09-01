// test/inbox-cli.test.mjs
//
// Reading an inbox is not a receipt: `inbox new`/`inbox all` mark a message
// locally seen but never change its State, so the sender sees 'open' forever
// until the recipient runs `inbox ack`. That gap is invisible because the two
// feel like one mechanism. The CLI closes it with a hint (not a silent write —
// auto-acking on read would turn every poll into a git write). These tests pin
// that the hint appears while mail is open and is gone once it is acked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MEM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function mem(root, argv) {
  return execFileSync('node', [MEM, '--root', root, ...argv],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function freshMemoryWithOpenMail() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inbox-cli-'));
  mem(root, ['init']);
  mem(root, ['inbox', 'write', '--as', 'session', '--to', 'librarian',
    '--subject', 'hello', '--text', 'a body']);
  return root;
}

const HINT = /reading is not a receipt/;

test('inbox new nudges toward a receipt while mail is open', () => {
  const root = freshMemoryWithOpenMail();
  try {
    const out = mem(root, ['inbox', 'new', '--as', 'librarian']);
    assert.match(out, HINT, 'the read did not point at inbox ack');
    assert.match(out, /inbox ack <name>/, 'the hint omits the actual command');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('once acked, the message no longer counts as open and the hint is gone', () => {
  const root = freshMemoryWithOpenMail();
  try {
    // Learn the file name from a read, then ack it.
    const listed = mem(root, ['inbox', 'all', '--as', 'librarian']);
    const name = (listed.match(/\S+--session-to-librarian\.md/) || [])[0];
    assert.ok(name, 'could not find the message name in the listing');
    mem(root, ['inbox', 'ack', name, 'processed']);

    const after = mem(root, ['inbox', 'all', '--as', 'librarian']);
    assert.match(after, /\[processed\]/, 'ack did not change the state');
    assert.doesNotMatch(after, HINT, 'the hint still shows with nothing open');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a memory with no open mail shows no receipt hint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inbox-cli-empty-'));
  try {
    mem(root, ['init']);
    const out = mem(root, ['inbox', 'new', '--as', 'librarian']);
    assert.doesNotMatch(out, HINT, 'hint appeared with an empty inbox');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
