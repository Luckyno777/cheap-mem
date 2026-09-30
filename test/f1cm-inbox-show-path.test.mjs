/**
 * `mem inbox show <name>` reads a message, never an arbitrary file.
 *
 * **The finding, audit 2026-09-30, B4.** `inbox show` joined the name
 * onto the inbox directory itself instead of going through
 * `checkMessageName` (which `ack` and `claim` use), so `../../x`
 * reached any file the process could read. Measured on 241a8aa: a
 * message-shaped file outside the inbox was printed in full, and for
 * any other file the parse error echoed its first line on stderr.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MEM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function mem(root, argv) {
  return spawnSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8' });
}

test('inbox show refuses a name that walks out of the inbox', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-inbox-show-'));
  const root = path.join(base, 'mem');
  fs.mkdirSync(root);
  try {
    execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(outside, 'From: session\nTo: librarian\nTime: 2026-09-30T00:00:00Z\n'
      + 'Subject: x\nState: open\n\nOUTSIDE-SENTINEL-7731\n');
    const plain = path.join(base, 'plain.txt');
    fs.writeFileSync(plain, 'FIRSTLINE-SENTINEL-5520\n');
    for (const [file, sentinel] of [[outside, /OUTSIDE-SENTINEL-7731/], [plain, /FIRSTLINE-SENTINEL-5520/]]) {
      const rel = path.relative(path.join(root, 'inbox'), file);
      assert.ok(rel.startsWith('..'), `probe setup: ${rel}`);
      const r = mem(root, ['inbox', 'show', rel, '--as', 'librarian']);
      assert.doesNotMatch(r.stdout + r.stderr, sentinel, `content of ${rel} leaked`);
      assert.notEqual(r.status, 0);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('positive control: a real message is still shown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-inbox-show-ok-'));
  try {
    execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
    mem(root, ['inbox', 'write', '--as', 'session', '--to', 'librarian',
      '--subject', 'hello', '--text', 'BODY-SENTINEL-4410']);
    const listed = mem(root, ['inbox', 'all', '--as', 'librarian']).stdout;
    const name = (listed.match(/\S+--session-to-librarian\S*\.md/) || [])[0];
    assert.ok(name, listed);
    const r = mem(root, ['inbox', 'show', name, '--as', 'librarian']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /BODY-SENTINEL-4410/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
