// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A placeholder is a placeholder only as a WHOLE value (owner decision 2026-10-13, both houses).
//
// The exception list of src/redaction.mjs excused every value that merely STARTED with `your`, `my`, `test`,
// `example` ...: `password=mySecret123!` and `password=test1234` went through unmasked, and a random value that
// happened to begin with `my` or `test` made a test flake (headline-rule, one run in ten). Now the whole value must
// be a placeholder word, alone or with exactly one generic word behind it.
//
// Red proof against a FIXED old commit (never a moving merge-base). Positive control: the placeholders stay
// unmasked, otherwise "masks more" would be a redaction that eats its own documentation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { redact } from '../src/redaction.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_STATE = 'acff04e377dcc729e6f390c94338570c0dedf58d';

const MASKED = [
  'password=mySecret123!', 'password=test1234', 'password=testing123', 'password=myPassw0rd', 'password=example1234',
  'api_key=sample-value-123', 'token=your_token_here', 'secret=dummyvalue99', 'password=fakeSecret_9', 'passwd=placeholder_text',
  'password=my_password_2', 'DB_PASSWORD=yourSecret77',
];
const KEPT = [
  'password=your_password', 'password=<TOKEN>', 'password=${VAR}', 'token=my-token', 'api_key=example', 'secret=dummy_value',
  'password=placeholder', 'password=beispiel_passwort', 'password=dein-passwort', 'password=ihr_passwort', 'token=your-key', 'password=[redacted]',
  'password=changeme', 'password=xxxxxxxx',
];

test('a value that only STARTS with a placeholder word is masked; a whole placeholder is not', () => {
  for (const v of MASKED) assert.ok(/REDACTED/.test(redact(v).text), `must be masked: ${v}`);
  for (const v of KEPT) assert.equal(redact(v).text, v, `must stay: ${v}`);
});

test('red proof: the old exception list let the prefixed values through', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-placeholder-'));
  try {
    exportCommit(REPO, OLD_STATE, ['src/redaction.mjs'], dir);
    const old = await import(pathToFileURL(path.join(dir, 'src', 'redaction.mjs')).href);
    const through = MASKED.filter((v) => !/REDACTED/.test(old.redact(v).text));
    assert.ok(through.includes('password=mySecret123!') && through.includes('password=test1234'), `the old list excused: ${through.join(', ')}`);
    for (const v of ['password=your_password', 'password=<TOKEN>', 'password=${VAR}', 'token=my-token', 'api_key=example']) assert.equal(old.redact(v).text, v, `control: the old list kept ${v} too`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one source: the commit scan runs the same redact(), it keeps no placeholder list of its own', () => {
  const hook = fs.readFileSync(path.join(REPO, 'hooks', 'pre-commit'), 'utf8');
  assert.match(hook, /src\/redaction\.mjs/, 'the hook imports the redaction module');
  assert.match(hook, /r\.redact\(content\)/, 'and calls its redact()');
  assert.doesNotMatch(hook, /\b(your|placeholder|dummy|changeme)\b\s*[|)]/i, 'no list of placeholder words in the hook');
  for (const rel of ['hooks/pre-push', 'hooks/append-only.mjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, rel), 'utf8'), /\b(your|my|example|sample|dummy|fake)\s*\|\s*(my|example|sample|dummy|fake|placeholder)/i, `${rel}: no placeholder list`);
  }
});
