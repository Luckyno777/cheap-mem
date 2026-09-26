/**
 * The secret keyword in the MIDDLE of a quoted key.
 *
 * CANARY FILE — contains deliberate sample tokens as probes for the
 * redaction. The scanner and the pre-commit hook skip files carrying
 * this marker; otherwise this test could never be committed.
 *
 * **The finding, 2026-09-26.** `json-secret` accepted the keyword only
 * as the whole key. Measured against main before the change, every
 * shape below went through with its value in plain text. The most
 * common JSON spelling — `secretKey` — was the one that leaked. The same
 * hole was closed in lucky-mem the same day; this is the English
 * rebuild with its own measurement, not a copy.
 *
 * Every assertion here has its counterpart: what must be caught, and
 * what must stay untouched. A guard that reports the innocent gets
 * switched off; one that never reports is worth as little.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as redaction from '../src/redaction.mjs';

const SAMPLE = 'AbCdEf1234567890xyz';

test('the keyword in the middle or at the start of a key is caught', () => {
  for (const line of [
    `{"secretKey": "${SAMPLE}"}`,
    `{"passwordHash": "${SAMPLE}"}`,
    `{"tokenPage": "${SAMPLE}"}`,
    `{"apiKeyId": "${SAMPLE}"}`,
    `{"secret-value": "${SAMPLE}"}`,
    `{"tokenValue": "${SAMPLE}"}`,
    `{"accessToken": "${SAMPLE}"}`,
  ]) {
    const r = redaction.redact(line);
    assert.ok(r.found.length > 0, `slipped through: ${line}`);
    assert.doesNotMatch(r.text, new RegExp(SAMPLE), `value still visible: ${line}`);
  }
});

test('the key name stays readable — a finding nobody can place is useless', () => {
  const r = redaction.redact(`{"secretKey": "${SAMPLE}"}`);
  assert.match(r.text, /secretKey/);
});

test('pagination cursors are not credentials, anchored to the END of the key', () => {
  for (const key of ['nextPageToken', 'pageToken', 'nextToken', 'continuationToken', 'next_page_token']) {
    const r = redaction.redact(`{"${key}": "${SAMPLE}"}`);
    assert.equal(r.found.length, 0, `cursor redacted: ${key}`);
  }
  // Positive control: the same words with more after them are sharp again.
  for (const key of ['pageTokenSecret', 'nextPageTokenValue']) {
    const r = redaction.redact(`{"${key}": "${SAMPLE}"}`);
    assert.ok(r.found.length > 0, `cursor exception swallowed a real key: ${key}`);
  }
});

test('the cursor exception does not reach the environment rule', () => {
  // NEXT_TOKEN in an environment is not a JSON cursor; it was redacted
  // before this change and must stay so.
  const r = redaction.redact(`NEXT_TOKEN=${SAMPLE}`);
  assert.ok(r.found.length > 0);
});

test('a kebab-case key with a slug value is vocabulary, not a secret', () => {
  // The line that widened the key reached in src/errorclass.mjs.
  const r = redaction.redact("  'secret-leak': 'secret-or-permission',");
  assert.equal(r.found.length, 0, r.text);
  // Positive control: under the same kind of key, a credential-shaped
  // value is still caught.
  assert.ok(redaction.redact(`'secret-leak': '${SAMPLE}',`).found.length > 0);
});

test('the named gap stays named: a bare key keeps catching a passphrase', () => {
  // Under `password` the passphrase is caught; only a kebab key lets it
  // through. If someone narrows the bare-key path, this goes red.
  assert.ok(redaction.redact('{"password": "correct-horse-battery"}').found.length > 0);
});
