/**
 * The pre-commit gate refuses the commit when its own check crashes.
 *
 * **The finding, audit 2026-09-30, B8.** The staged-diff check runs in
 * an async stdin handler with stderr sent to /dev/null. When it threw,
 * node died with nothing on stdout, the hook read that as "no findings"
 * and exited 0. Measured on 241a8aa with a redaction module whose
 * selfTest passes but whose envSecrets() throws: the commit went
 * through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(PKG_ROOT, 'hooks', 'pre-commit');

function repo(redactionSource) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-hook-'));
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.mkdirSync(path.join(r, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'redaction.mjs'), redactionSource);
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

function tryCommit(r) {
  const p = spawnSync('git', ['commit', '-q', '-m', 'probe'], { cwd: r, encoding: 'utf8' });
  return { code: p.status, text: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}

const CRASHING = [
  'export function selfTest() { return { ok: true, failed: [] }; }',
  "export function envSecrets() { throw new Error('probe: redaction bug'); }",
  'export function redact(t) { return { text: t, found: [] }; }',
  'export function redactAgainstEnv(t) { return { text: t, found: [] }; }',
].join('\n');

test('a crash inside the staged-diff check refuses the commit', () => {
  const { r, git } = repo(CRASHING);
  try {
    fs.writeFileSync(path.join(r, 'notes.txt'), 'an ordinary line\n');
    git('add', 'notes.txt');
    const res = tryCommit(r);
    assert.notEqual(res.code, 0, `commit went through although the check crashed:\n${res.text}`);
    assert.match(res.text, /did not finish/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('positive control: with the real redaction an ordinary commit passes and a token is stopped', () => {
  const { r, git } = repo(fs.readFileSync(path.join(PKG_ROOT, 'src', 'redaction.mjs'), 'utf8'));
  try {
    fs.writeFileSync(path.join(r, 'notes.txt'), 'an ordinary line\n');
    git('add', 'notes.txt');
    const ok = tryCommit(r);
    assert.equal(ok.code, 0, ok.text);
    fs.writeFileSync(path.join(r, 'leak.txt'), `key = ghp_${'a1'.repeat(18)}\n`);
    git('add', 'leak.txt');
    const bad = tryCommit(r);
    assert.notEqual(bad.code, 0);
    assert.match(bad.text, /POSSIBLE SECRETS/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
