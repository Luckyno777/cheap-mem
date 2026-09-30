// X4: the CLI surface of src/claim.mjs (`mem inbox claim|done|failed|claims`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const mem = (root, ...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root], { encoding: 'utf8', input: 'body\n' });

test('claim, a second claim that does not count, failed, and who holds it', (t) => {
  const root = tempDir('cheap-mem-claim-cli-', t);
  assert.equal(mem(root, 'init').status, 0);
  assert.equal(mem(root, 'inbox', 'write', '--as', 'session', '--to', 'librarian', '--subject', 'hi').status, 0);
  const name = fs.readdirSync(path.join(root, 'inbox')).find((f) => f.endsWith('.md'));

  const a = mem(root, 'inbox', 'claim', name, '--as', 'librarian');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /claimed by 'librarian'/);

  const b = mem(root, 'inbox', 'claim', name, '--as', 'session');
  assert.equal(b.status, 1, 'a claim that does not count says so with a non-zero exit');
  assert.match(b.stdout, /does NOT count/);

  const s = mem(root, 'inbox', 'claims', name);
  assert.match(s.stdout, /claimed — librarian until/);
  assert.match(s.stdout, /does not count: session/);

  const f = mem(root, 'inbox', 'failed', name, '--as', 'librarian', '--reason', 'boom');
  assert.equal(f.status, 0, f.stderr);
  assert.match(mem(root, 'inbox', 'claims', name).stdout, /: free/);
  assert.notEqual(mem(root, 'inbox', 'failed', name, '--as', 'librarian').status, 0, 'a reason is required');
});

test('positive control: without any claim the inbox commands work as before', (t) => {
  const root = tempDir('cheap-mem-claim-cli-', t);
  assert.equal(mem(root, 'init').status, 0);
  assert.equal(mem(root, 'inbox', 'write', '--as', 'session', '--to', 'librarian', '--subject', 'hi').status, 0);
  const r = mem(root, 'inbox', 'all', '--as', 'librarian');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hi/);
  assert.equal(fs.existsSync(path.join(root, 'inbox', 'claims.jsonl')), false);
});
