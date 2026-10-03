// test/capture-rejected-session-id.test.mjs — error 1rmp6w45nul6, mirrored
// from lucky-mem d341ee2b. The raw capture of cloud sessions never reached
// the repo: the pre-commit matched the diff against every env value, and
// the session's own id (CLAUDE_CODE_SESSION_ID) is in raw-record.jsonl by
// design. Now exactly that id is no secret; real secrets stay rejected.
// All fakes are assembled at runtime, never written as literals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { envSecrets, redact } from '../src/redaction.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'hooks', 'pre-commit');
// Fixed state before the fix (never a merge-base: that moves).
const OLD_STATE = '5ca8415';

const UUID = ['cfb467dc', '1a2b', '4c3d', '8e9f', '0a1b2c3d4e5f'].join('-');
const CSE = 'cse_' + '01' + 'AbCdEfGhJkMnPqRsTuVwXy';
const SES = 'session_' + '01' + 'AbCdEfGhJkMnPqRsTuVwXy';

const made = [];
process.on('exit', () => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

function repo(old) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-caprej-'));
  made.push(r);
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.mkdirSync(path.join(r, 'hooks'), { recursive: true });
  const src = old
    ? execFileSync('git', ['show', `${OLD_STATE}:src/redaction.mjs`], { cwd: ROOT, encoding: 'utf8' })
    : fs.readFileSync(path.join(ROOT, 'src', 'redaction.mjs'), 'utf8');
  fs.writeFileSync(path.join(r, 'src', 'redaction.mjs'), src);
  fs.copyFileSync(HOOK, path.join(r, 'hooks', 'pre-commit'));
  fs.chmodSync(path.join(r, 'hooks', 'pre-commit'), 0o755);
  fs.writeFileSync(path.join(r, 'package.json'), '{"type":"module"}\n');
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', 'hooks');
  git('add', '-A');
  git('commit', '-q', '-m', 'init', '--no-verify');
  return r;
}

function attempt(r, content, env) {
  fs.writeFileSync(path.join(r, 'raw-record.jsonl'), content + '\n');
  execFileSync('git', ['add', 'raw-record.jsonl'], { cwd: r });
  const p = spawnSync('git', ['commit', '-q', '-m', 'probe'], {
    cwd: r, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: p.status, stderr: p.stderr ?? '' };
}

const record = (id) => JSON.stringify({
  stamp: { session_id: id, surface: 'cloud' },
  path: `raw/2026/10/2026-10-03T12-54-56Z--${id}.jsonl.gz`,
});
const NO_IDS = { CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_REMOTE_SESSION_ID: '' };

test('red: on the old state the hook rejects a raw record carrying the session id', () => {
  const e = attempt(repo(true), record(UUID), { ...NO_IDS, CLAUDE_CODE_SESSION_ID: UUID });
  assert.notEqual(e.code, 0, 'old state should have rejected (red proof)');
  assert.match(e.stderr, /POSSIBLE SECRETS/);
  assert.match(e.stderr, /env:CLAUDE_CODE_SESSION_ID/);
});

test('green: on the new state the same raw record passes (UUID, cse_, session_)', () => {
  for (const [name, id] of [
    ['CLAUDE_CODE_SESSION_ID', UUID],
    ['CLAUDE_CODE_REMOTE_SESSION_ID', CSE],
    ['CLAUDE_CODE_REMOTE_SESSION_ID', SES],
  ]) {
    const e = attempt(repo(false), record(id), { ...NO_IDS, [name]: id });
    assert.equal(e.code, 0, `${name}: ${e.stderr}`);
  }
});

test('positive control: a real key in the same record is still rejected', () => {
  const fakes = {
    anthropic: 'sk-ant-api03-' + 'Q'.repeat(28),
    github: 'ghp_' + 'Q'.repeat(36),
    aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nQQQQ==\n-----END RSA PRIVATE KEY-----',
  };
  for (const [k, v] of Object.entries(fakes)) {
    const e = attempt(repo(false), record(UUID) + '\n' + v, { ...NO_IDS, CLAUDE_CODE_SESSION_ID: UUID });
    assert.notEqual(e.code, 0, `${k} went through`);
    assert.match(e.stderr, /POSSIBLE SECRETS/, k);
  }
});

test('positive control: a secret placed in the session-id variable names is still rejected', () => {
  const tok = 'ghp_' + 'Q'.repeat(36);
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID']) {
    const e = attempt(repo(false), record(UUID) + ' ' + tok, { ...NO_IDS, [name]: tok });
    assert.notEqual(e.code, 0, name);
    assert.match(e.stderr, new RegExp(`env:${name}`));
  }
});

test('positive control: a secret in another env variable stays rejected', () => {
  const val = 'Zq9' + 'X'.repeat(20) + '7mK';
  const e = attempt(repo(false), record(UUID) + ' ' + val, { ...NO_IDS, CLAUDE_CODE_SESSION_ID: UUID, MY_THING: val });
  assert.notEqual(e.code, 0);
  assert.match(e.stderr, /env:MY_THING/);
});

test('narrow exception: right name wrong shape, or wrong name right shape, stays a secret', () => {
  const tok = 'ghp_' + 'Q'.repeat(36);
  const names = (env) => envSecrets(env).map((s) => s.name);
  assert.deepEqual(names({ CLAUDE_CODE_SESSION_ID: UUID }), []);
  assert.deepEqual(names({ CLAUDE_CODE_REMOTE_SESSION_ID: CSE }), []);
  assert.deepEqual(names({ CLAUDE_CODE_SESSION_ID: tok }), ['CLAUDE_CODE_SESSION_ID']);
  assert.deepEqual(names({ CLAUDE_CODE_MESSAGING_TOKEN: UUID }), ['CLAUDE_CODE_MESSAGING_TOKEN']);
  assert.deepEqual(names({ CLAUDE_CODE_CONTAINER_ID: UUID }), ['CLAUDE_CODE_CONTAINER_ID']);
});

test('pattern layer untouched: redact() still finds real keys, ids are no pattern hit', () => {
  assert.ok(redact('x ghp_' + 'Q'.repeat(36)).found.length > 0);
  assert.equal(redact(record(UUID)).found.length, 0);
});
