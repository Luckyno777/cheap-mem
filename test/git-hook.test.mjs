import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(PKG_ROOT, 'hooks', 'pre-commit');

// A throwaway repo wired to this exact hook. The gate is the third line
// of defence and had no test at all until now — which is why two bugs
// stood for days: the whole-file check (which locked append-only logs
// forever) and reading the working tree instead of the index (which let
// staged secrets through).
function repo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hook-'));
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.mkdirSync(path.join(r, 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'src', 'redaction.mjs'), path.join(r, 'src', 'redaction.mjs'));
  fs.copyFileSync(HOOK, path.join(r, 'hooks', 'pre-commit'));
  fs.chmodSync(path.join(r, 'hooks', 'pre-commit'), 0o755);
  fs.writeFileSync(path.join(r, 'package.json'), '{"type":"module"}\n');
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.hooksPath', 'hooks');
  git('add', '-A');
  git('commit', '-q', '-m', 'init', '--no-verify');
  return { r, git };
}
function tryCommit(r, msg) {
  const p = spawnSync('git', ['commit', '-q', '-m', msg], { cwd: r, encoding: 'utf8' });
  return { code: p.status, text: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}
const token = (c) => `ghp_${c.repeat(36)}`;

test('an old false positive does not lock the file against new lines', async () => {
  // A redaction pattern added later matches, retroactively, prose that
  // was committed before it existed. JSONL is append-only, so the file
  // could only be committed with --no-verify — that is, unchecked.
  const { r, git } = repo();
  try {
    const log = path.join(r, 'log.jsonl');
    fs.writeFileSync(log, '{"id":"old","text":"the KEY=consent principle"}\n');
    fs.appendFileSync(log, `{"id":"old2","text":"export API_KEY=${token('Z')}"}\n`);
    git('add', 'log.jsonl');
    git('commit', '-q', '-m', 'old', '--no-verify');   // how it got in back then

    // Prove the WHOLE file would be red today — otherwise this test only
    // proves that a harmless file is harmless.
    const red = await import(path.join(r, 'src', 'redaction.mjs'));
    assert.ok(red.redact(fs.readFileSync(log, 'utf8')).found.length > 0,
      'precondition: the whole file must carry a finding');

    fs.appendFileSync(log, '{"id":"new","text":"a harmless new line"}\n');
    git('add', 'log.jsonl');
    const e = tryCommit(r, 'new line');
    assert.equal(e.code, 0, `the new line was blocked:\n${e.text}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a secret on a NEW line is still blocked, and never printed', () => {
  const { r, git } = repo();
  try {
    fs.writeFileSync(path.join(r, 'log.jsonl'), `export GITHUB_TOKEN=${token('A')}\n`);
    git('add', 'log.jsonl');
    const e = tryCommit(r, 'bad');
    assert.notEqual(e.code, 0);
    assert.match(e.text, /POSSIBLE SECRETS/);
    assert.ok(!e.text.includes(token('A')), 'the value must never appear in the finding');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('staged secret with a cleaned working tree is still blocked', () => {
  // The second hole: the file on disk was read, but the index is what
  // gets committed. Staging a secret and then cleaning the file got
  // through — exactly backwards from the intent.
  const { r, git } = repo();
  try {
    const p = path.join(r, 'secret.env');
    fs.writeFileSync(p, `export GITHUB_TOKEN=${token('B')}\n`);
    git('add', 'secret.env');
    fs.writeFileSync(p, 'harmless\n');          // index still holds the secret
    const e = tryCommit(r, 'disguised');
    assert.notEqual(e.code, 0, 'the index carries the secret; that must block');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a CANARY FILE stays exempt even when the marker is not in the diff', () => {
  const { r, git } = repo();
  try {
    const p = path.join(r, 'canary.mjs');
    fs.writeFileSync(p, `// CANARY${' '}FILE\nconst a = 1;\n`);
    git('add', 'canary.mjs');
    git('commit', '-q', '-m', 'add canary');
    fs.appendFileSync(p, `const sample = "${token('C')}";\n`);   // marker NOT in the diff
    git('add', 'canary.mjs');
    const e = tryCommit(r, 'add a sample');
    assert.equal(e.code, 0, `the canary file was blocked:\n${e.text}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('REMOVING a secret does not block', () => {
  // Deleted lines appear in the diff with '-'. Read as content, a secret
  // could never be taken back out of a file.
  const { r, git } = repo();
  try {
    const p = path.join(r, 'old.txt');
    fs.writeFileSync(p, `one\nexport GITHUB_TOKEN=${token('D')}\nthree\n`);
    git('add', 'old.txt');
    git('commit', '-q', '-m', 'old', '--no-verify');
    fs.writeFileSync(p, 'one\nthree\n');
    git('add', 'old.txt');
    const e = tryCommit(r, 'remove the secret');
    assert.equal(e.code, 0, `removing it was blocked:\n${e.text}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('with the redaction broken, nothing gets through', () => {
  // A broken guard that says "all clear" is worse than no guard.
  const { r, git } = repo();
  try {
    fs.writeFileSync(path.join(r, 'src', 'redaction.mjs'), 'export function broken(){}\n');
    fs.writeFileSync(path.join(r, 'whatever.txt'), 'harmless\n');
    git('add', '-A');
    const e = tryCommit(r, 'with a broken redaction');
    assert.notEqual(e.code, 0);
    assert.match(e.text, /redaction (has failed|is broken|failed)/i);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
