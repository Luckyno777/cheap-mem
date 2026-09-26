// Redaction stays linear — also on long runs with no separator.
//
// CANARY FILE — contains deliberate sample tokens as probes for the
// redaction. The scanner and the pre-commit hook skip files with this
// marker.
//
// **The finding, 2026-09-26.** Widening `json-secret` with `*` before
// AND after the keyword made test/entry-size-cap hang: 4,000 chars of
// 'tokentoken...' took 4.8 s and grew super-linearly. `env-secret` had
// the same double star, and `url-credentials` an unbounded scheme that
// restarted at every word boundary. Redaction runs on every capture and
// in the pre-commit hook, so one such line stalls both. lucky-mem found
// and fixed the same shapes the same day.
//
// The per-probe ceiling is generous (the machine may be loaded); the old
// state needs minutes for the same input, so these probes turn red there
// instead of passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as redaction from '../src/redaction.mjs';

const LENGTH = 64000;
const CEILING_MS = 1500;

for (const [name, text] of [
  ['letter run', 'a'.repeat(LENGTH)],
  ['repeated keyword', 'token'.repeat(LENGTH / 5)],
  ['keyword in a mix', 'xsecretx'.repeat(LENGTH / 8)],
  ['scheme characters, no ://', 'a.b-c+d'.repeat(LENGTH / 7)],
]) {
  test(`linear: ${name}, ${LENGTH} chars under ${CEILING_MS} ms`, { timeout: 20000 }, () => {
    const t = performance.now();
    redaction.redact(text);
    const ms = performance.now() - t;
    assert.ok(ms < CEILING_MS, `${ms.toFixed(0)} ms — a pattern backtracks`);
  });
}

test('positive control: the bounded patterns still catch what they must', () => {
  for (const line of [
    '{"secretKey": "AbCdEf1234567890xyz"}',
    'export DB_PASSWORD=NotSecret123abc',
    'postgres://user:SecretWord99@host:5432/db',
  ]) {
    assert.ok(redaction.redact(line).found.length > 0, `slipped through: ${line}`);
  }
});
