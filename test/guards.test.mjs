import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as inbox from '../src/inbox.mjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-guard-')); }

// --- the project name is a name, not a path ---------------------------

test('a project name that walks upwards is refused', () => {
  // Verified live before the fix: `mem log --project ../../../../tmp/x`
  // created directories and wrote the entry OUTSIDE the memory root.
  // What makes it matter is who could do it — the permission the docs
  // call narrow, `Bash(node <root>/bin/mem:*)`, granted to the unattended
  // digest, was enough on its own.
  for (const bad of ['../evil', '../../../../tmp/x', 'a/b', 'a\\b', '.', '..']) {
    assert.throws(() => memory.logPath('/some/root', 'decision', bad),
      /invalid|reserved|missing/, `'${bad}' was accepted as a project name`);
  }
});

test('logPath is the chokepoint — every caller inherits the guard', () => {
  // The old checkProjectName existed and was correct; it was called only
  // from projectInit. Putting it where the path is built means the CLI,
  // the MCP server and any library caller are covered at once, and no
  // future entry point can forget it.
  const r = root();
  try {
    assert.throws(() => memory.logEntry(r, 'decision', { title: 'x' }, { project: '../out' }),
      /invalid/);
    const before = fs.existsSync(path.join(path.dirname(r), 'out'));
    assert.equal(before, false, 'a directory was created outside the root');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the CLI refuses it too, and writes nothing', () => {
  const r = root();
  try {
    execFileSync('node', [path.join(PKG_ROOT, 'bin', 'mem'), '--root', r, 'init'], { encoding: 'utf8' });
    let failed = false;
    try {
      execFileSync('node', [path.join(PKG_ROOT, 'bin', 'mem'), '--root', r, 'log', 'decision',
        '--project', '../../ESCAPED', '--title', 'out'], { encoding: 'utf8', stdio: 'pipe' });
    } catch { failed = true; }
    assert.ok(failed, 'the CLI accepted a traversing project name');
    assert.ok(!fs.existsSync(path.join(path.dirname(r), 'ESCAPED')));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a project literally named "global" is refused rather than silently shadowed', () => {
  // Every filter reads project 'global' as "the root bucket, not a
  // project", so such a project would be unreachable through its own
  // name and the query would answer about somewhere else.
  assert.throws(() => memory.checkProjectName('global'), /reserved/);
  assert.throws(() => memory.checkProjectName('raw'), /reserved/);
  assert.doesNotThrow(() => memory.checkProjectName('global-corp'));
});

test('an unreadable project directory is skipped, not fatal', () => {
  // listProjects feeds logPath. A stray directory that logPath rejects
  // must not make every cross-project read throw.
  const r = root();
  try {
    fs.mkdirSync(path.join(r, 'projects', 'Weird Name'), { recursive: true });
    fs.mkdirSync(path.join(r, 'projects', 'ok-one'), { recursive: true });
    assert.deepEqual(memory.listProjects(r), ['ok-one']);
    assert.doesNotThrow(() => memory.context(r, { n: 5 }));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --- a message name is a filename, not a path -------------------------

test('reading a message by name cannot leave the inbox', () => {
  const r = root();
  try {
    for (const bad of ['../../../../etc/passwd', '..', 'sub/dir.md', 'a\\b']) {
      assert.throws(() => inbox.readMessage(r, bad), /path, not a filename/,
        `'${bad}' was accepted as a message name`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the MCP server reads messages through that guard, not around it', () => {
  // It used to build the path itself, so the guard sitting in setState
  // right beside it never applied.
  const src = fs.readFileSync(path.join(PKG_ROOT, 'bin', 'mem-mcp'), 'utf8');
  const handler = src.slice(src.indexOf("case 'mem_inbox_show'"),
    src.indexOf("case 'mem_inbox_write'"));
  assert.match(handler, /inbox\.readMessage/);
  assert.ok(!/path\.join\(inbox\.inboxDir/.test(handler),
    'the handler still joins the path itself');
});

// --- two messages in one second ---------------------------------------

test('a second message in the same second gets its own file', () => {
  // Verified through the CLI before the fix: both calls reported
  // "Written", one file existed, the first message was gone.
  const r = root();
  try {
    const t = new Date('2026-09-05T10:00:00Z');
    const parts = { user: 'the human', librarian: 'the curator' };
    const a = inbox.write(r, parts, { from: 'user', to: 'librarian', subject: 'first', text: 'CONTENT ONE', now: t });
    const b = inbox.write(r, parts, { from: 'user', to: 'librarian', subject: 'second', text: 'CONTENT TWO', now: t });
    assert.notEqual(a.name, b.name, 'both messages landed on the same filename');
    assert.equal(fs.readdirSync(inbox.inboxDir(r)).length, 2);
    const all = fs.readdirSync(inbox.inboxDir(r))
      .map((f) => fs.readFileSync(path.join(inbox.inboxDir(r), f), 'utf8')).join('');
    assert.match(all, /CONTENT ONE/, 'the first message was overwritten');
    assert.match(all, /CONTENT TWO/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the first message carries the clone mark but no counter', () => {
  // This used to read "keeps the plain name". The plain name IS the
  // problem: it is exactly the name a second clone also forms, and two
  // clones writing it in the same second produce an add/add conflict
  // that can leave the whole drawer unparseable.
  //
  // The intent of the old test survives and is checked here: the
  // collision counter is added ONLY on a real collision.
  const r = root();
  try {
    const t = new Date('2026-09-05T10:00:00Z');
    const who = { user: 'the human', librarian: 'the curator' };
    const a = inbox.write(r, who, { from: 'user', to: 'librarian', subject: 's', text: 'x', now: t });
    assert.match(a.name, /^2026-09-05T10-00-00Z--user-to-librarian~[a-z0-9]{1,12}\.md$/);
    assert.ok(!/-\d+\.md$/.test(a.name), `no collision, no counter: ${a.name}`);
    assert.ok(inbox.fromFileName(who, a.name), 'a name we write must be one we can read');

    const b = inbox.write(r, who, { from: 'user', to: 'librarian', subject: 's2', text: 'y', now: t });
    assert.match(b.name, /~[a-z0-9]{1,12}-2\.md$/, `a collision needs the counter: ${b.name}`);
    assert.ok(inbox.fromFileName(who, b.name),
      'the second message of a second must be READABLE — it used to parse as null, '
      + 'which files it as unreadable and it is never announced as new');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
