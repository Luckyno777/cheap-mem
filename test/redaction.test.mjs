/**
 * Tests for the redaction. This file deliberately contains sample
 * secrets, so it carries the marker below — the pre-commit hook skips
 * files with it, otherwise these tests could never be committed.
 *
 * CANARY FILE
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as redaction from '../src/redaction.mjs';

test('self-test passes and counts its canaries', () => {
  const t = redaction.selfTest();
  assert.equal(t.ok, true, JSON.stringify(t.failed ?? []));
  assert.ok(t.checked >= redaction.CANARY_COUNT,
    `only ${t.checked} canaries, CANARY_COUNT says ${redaction.CANARY_COUNT}`);
});

test('catches the known secret shapes', () => {
  const cases = [
    ['anthropic key', `sk-ant-api03-${'K'.repeat(30)}`],
    ['openai key', `sk-${'K'.repeat(34)}`],
    ['github token', `ghp_${'K'.repeat(36)}`],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4'],
    ['bearer header', `Authorization: Bearer ${'K'.repeat(40)}`],
    ['url credentials', 'postgres://user:SecretWord99@host:5432/db'],
    ['env assignment', 'export DB_PASSWORD=NotSecret123abc'],
  ];
  for (const [name, sample] of cases) {
    const r = redaction.redact(sample);
    assert.notEqual(r.text, sample, `not caught: ${name}`);
    assert.ok(r.found.length > 0, `no finding reported for ${name}`);
  }
});

test('the two gaps found in real captures stay closed', () => {
  // Both found by a digest run over real transcripts and logged as
  // secret-leak. A closed gap without a test reopens at the next
  // refactor.

  // A Cloudflare tunnel token: base64 JSON in ONE piece. The jwt
  // pattern demands three dot-separated segments and let it through.
  const tunnel = `cloudflared tunnel run --token eyJ${'hIjoiMWEyYjNjNGQ1ZTZmN2c4aDlpMGoxazJsM200bjVvNnA3cThyOXMwdDF1MnYzdzR4NXk2eiJ9'}`;
  const a = redaction.redact(tunnel);
  assert.notEqual(a.text, tunnel, 'eyJ blob without dots must be caught');
  assert.ok(a.found.some((f) => f.type === 'json-blob'));

  // A bare `token=` in a URL. The env pattern required at least one
  // character BEFORE the keyword, so a variable named exactly "token"
  // never matched.
  const url = 'curl https://api.example.test/v1/x?token=aB3xY9kQ7mZ2pL5w';
  assert.notEqual(redaction.redact(url).text, url, 'bare token= must be caught');
});

test('leaves harmless text alone', () => {
  for (const harmless of [
    'TOKEN=${GITHUB_TOKEN}',
    'api_key: <your-key-here>',
    'commit 4ace88d3f21b9c0e77aa1b2c3d4e5f6a7b8c9d0e',
    '/usr/local/lib/node_modules/cheap-mem/src/redaction.mjs',
    'The token concept is explained below.',
    'password: changeme',
  ]) {
    assert.equal(redaction.redact(harmless).text, harmless, `touched: ${harmless}`);
  }
});

test('never returns the redacted value', () => {
  const secret = `ghp_${'Z'.repeat(36)}`;
  const r = redaction.redact(`here it is: ${secret}`);
  assert.ok(!r.text.includes(secret), 'the value survived in the text');
  assert.ok(!JSON.stringify(r.found).includes(secret), 'the value leaked into the findings');
});

test('the env layer catches values the patterns do not know', () => {
  // A secret in a variable with an innocent name has no recognisable
  // shape. Only an exact match against the real environment finds it.
  const secrets = [{ name: 'MY_THING', value: 'qwertyuiop1234567890' }];
  const text = 'the config says qwertyuiop1234567890 which is private';
  const r = redaction.redactAgainstEnv(text, secrets);
  assert.ok(!r.text.includes('qwertyuiop1234567890'));
  assert.equal(r.found[0].type, 'env:MY_THING');
});

test('CANARY_COUNT makes removing a rule with its canary detectable', () => {
  // Without the count, deleting a rule TOGETHER with its canary would
  // pass unnoticed, because nobody is left to ask.
  assert.equal(typeof redaction.CANARY_COUNT, 'number');
  assert.ok(redaction.CANARY_COUNT >= 12);
});

test('git and CI variables are not treated as secrets', () => {
  // git sets GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n itself while running
  // a hook. Those hold configuration — a branch name, a path. This
  // repository's own first commit was refused because one of those
  // values also appeared in the README.
  //
  // Layer 2 matches VALUES, so any long-ish ordinary env value can
  // produce a false positive. Naming the specific offenders is the
  // honest fix; shortening the list generally would not be.
  const env = {
    GIT_CONFIG_VALUE_1: 'claude/some-branch-name',
    GIT_CONFIG_KEY_0: 'user.email',
    GITHUB_REPOSITORY: 'someone/some-repo',
    GITHUB_REF_NAME: 'refs/heads/main',
    MY_TOKEN: 'aB3xY9kQ7mZ2pL5wQ1',
  };
  const flagged = redaction.envSecrets(env).map((s) => s.name);
  assert.deepEqual(flagged, ['MY_TOKEN'],
    `wrongly flagged: ${flagged.filter((n) => n !== 'MY_TOKEN').join(', ')}`);
});

test('prose about secrets is not treated as a secret', () => {
  // Writing down which patterns are still missing — `token=/api_key=` —
  // makes the env pattern match itself. Without this exception you can
  // never commit your own bug report about the redaction. It happened.
  for (const prose of [
    'the patterns token=/api_key= are still missing',
    'set GITHUB_TOKEN=<your-token> before running',
    'we match on password: and secret= in assignments',
  ]) {
    assert.equal(redaction.redact(prose).text, prose, `redacted prose: ${prose}`);
  }

  // But a real secret whose VALUE happens to contain the word must
  // still be caught — the exception requires a second assignment.
  const real = 'MY_TOKEN=supersecrettoken123';
  assert.notEqual(redaction.redact(real).text, real, 'a real secret slipped through');
});
