/**
 * Two shapes redaction let through until 2026-10-01.
 *
 * CANARY FILE — contains deliberate sample tokens as probes for the
 * redaction. The scanner and the pre-commit hook skip files carrying
 * this marker; otherwise this test could never be committed.
 *
 * Found by bench/value-report.mjs (docs/value-report/secrets.json): 118 of
 * 120 probe secrets caught; the two misses were
 *
 *   1. a base64 JSON blob (`eyJ...`, a tunnel token) right before a full
 *      stop: the json-blob tail forbade any following dot;
 *   2. a secret in escaped JSON, `{\"secretKey\": \"...\"}`, as it appears
 *      in a JSON log line whose msg is itself JSON.
 *
 * Red proof: both "is redacted" tests fail on the parent of the fix
 * commit; the positive controls pass there and here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redaction.mjs';

const BLOB = `eyJ${'aB3xY9kQ7mZ2pL5w'.repeat(5)}`; // 83 chars, base64url
const VALUE = 'Q8w3Zt7Lp2Xc9Vb4Nm6Kj1Hg';

test('json-blob right before a full stop is redacted', () => {
  for (const line of [
    `tunnel token ${BLOB}. Please keep this private.`,
    `The token was ${BLOB}.`,
    `The token was ${BLOB}==. Nothing after that.`,
    `(${BLOB}.)`,
  ]) {
    const { text, found } = redact(line);
    assert.ok(!text.includes(BLOB.slice(0, 40)), `leaked: ${text}`);
    assert.ok(found.some((f) => f.type === 'json-blob'), line);
    assert.ok(text.includes('[REDACTED:json-blob].'), `full stop stays: ${text}`);
  }
});

test('a JWT stays with the jwt pattern; a dot followed by token chars is not a sentence end', () => {
  const jwt = `eyJ${'hG9cI0aB1'.repeat(3)}.eyJ${'zU7bW2kQ4'.repeat(4)}.${'sX5vN8pR3'.repeat(4)}`;
  const { text, found } = redact(`cookie ${jwt}. End.`);
  assert.equal(text, 'cookie [REDACTED:jwt]. End.');
  assert.deepEqual(found.map((f) => f.type), ['jwt']);
});

test('positive control: ordinary sentences with a full stop are untouched', () => {
  for (const line of [
    'We chose PostgreSQL. Transactions matter for money.',
    'the JWT library was upgraded to a new major version.',
    'eyJ is base64 for {" and rarely shows up in prose.',
    `Short: eyJ${'a'.repeat(20)}. Too short for a blob.`,
  ]) {
    assert.equal(redact(line).text, line);
  }
});

test('a secret in escaped JSON is redacted and the escape sequence stays intact', () => {
  const inner = `{\\"secretKey\\": \\"${VALUE}\\", \\"region\\": \\"eu\\"}`;
  const line = `{"level":"info","msg":"${inner}","ts":1}`;
  const { text, found } = redact(line);
  assert.ok(!text.includes(VALUE), `leaked: ${text}`);
  assert.ok(found.some((f) => f.type === 'json-secret'));
  // Still valid JSON afterwards, the inner object too.
  const o = JSON.parse(text);
  assert.deepEqual(JSON.parse(o.msg), { secretKey: '[REDACTED:json-secret]', region: 'eu' });

  // Escaped twice, and the `=` assignment form.
  for (const z of [
    `"{\\\\\\"password\\\\\\": \\\\\\"${VALUE}\\\\\\"}"`,
    `api_token=\\"${VALUE}\\"`,
  ]) {
    const r = redact(z);
    assert.ok(!r.text.includes(VALUE), `leaked: ${r.text}`);
  }
});

test('positive control: escaped JSON without a secret and cursor keys are untouched', () => {
  for (const line of [
    '{"msg":"{\\"region\\": \\"eu-central-1\\", \\"user\\": \\"alice\\"}"}',
    '{"msg":"{\\"nextPageToken\\": \\"CAESBggDEAEYAQ123abc\\"}"}',
    '{"description": "the password reset flow sends an email"}',
  ]) {
    assert.equal(redact(line).text, line);
  }
});
