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

// ---- the PEM patterns (mask-before-cut round, review blocker) ---------------------------------------------------
//
// The open-block pattern first had an ambiguous repetition (143 characters of prose took 37 s), then a second one
// (`: ?` before a value that may start with a space: every header line read two ways, 2^n); the complete-block pattern
// scanned to the end of the text from every BEGIN (2.8 MB took 38 s). Each probe has a time limit; the shapes are the
// ones that blew up.
const PEM_HEAD = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const PEM_LIMIT_MS = 3000;
for (const [name, text, limit] of [
  ['prose after a header, twelve blank lines, more prose', `-----BEGIN CERTIFICATE----- as shown:\n${'    \n'.repeat(12)}then restart`, 500],
  ['header, thirty blank lines, then "!"', `${PEM_HEAD}\n${' \n'.repeat(30)}!`, 500],
  ['header, ten thousand 59-space lines, then "!"', `${PEM_HEAD}${`${' '.repeat(59)}\n`.repeat(1e4)}!`, PEM_LIMIT_MS],
  ['header, ten thousand header lines, no key', `${PEM_HEAD}\n${'Proc-Type: 4,ENCRYPTED\n'.repeat(1e4)}!`, PEM_LIMIT_MS],
  ['header, twenty thousand name-and-colon lines', `${PEM_HEAD}\n${`${'a'.repeat(30)}:${' '.repeat(5)}\n`.repeat(2e4)}`, PEM_LIMIT_MS],
  ['a header every 30 characters, no END line, 1 MB', `${PEM_HEAD} x\n`.repeat(1e6 / 34), 5000],
  ['a header and 19 key characters, repeated, 1 MB', `${PEM_HEAD}\n${'A'.repeat(19)}\n`.repeat(1e6 / 52), 5000],
  ['an open key of 5 MB', `${PEM_HEAD}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'.repeat(160000)}`, PEM_LIMIT_MS],
]) {
  test(`linear: PEM shapes: ${name}`, { timeout: 60000 }, () => {
    const t = performance.now();
    redaction.redact(text);
    const ms = performance.now() - t;
    assert.ok(ms < limit, `${ms.toFixed(0)} ms (limit ${limit}) — a PEM pattern backtracks`);
  });
}

test('PEM: the open block, with headers and JSON-escaped, still falls; a header alone and prose do not', () => {
  const b64 = 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfnygWyF8PbnGy0AHB7MhgH';
  for (const t of [`${PEM_HEAD}\n${b64}\n${b64}`, `${PEM_HEAD}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCDEF0123456789\n\n${b64}\n`,
    `{"k":"${PEM_HEAD}\\n${b64}\\n${b64}"}`]) {
    const r = redaction.redact(t).text;
    assert.ok(!r.includes(b64.slice(0, 30)) && /REDACTED:pem-block/.test(r), `not masked: ${t.slice(0, 60)}`);
  }
  const prose = `see ${PEM_HEAD} in the doc, and -----BEGIN CERTIFICATE----- as shown:\n    \nthen restart`;
  assert.equal(redaction.redact(prose).text, prose);
});

// ---- the whole-string pass of json-secret (finding 2026-10-13, torn-marker round) ---------------------------------
//
// The pass scans from an opening quote to its closing quote in code. Each shape below tries to make it scan the same
// stretch again and again: heads that each find a closer far away, heads of different quote kinds that never find
// theirs, backslash runs in front of every quote, a head per line with no closer. One megabyte each, under the
// ceiling. The old state does not have the pass, so no red proof is possible here; the control is that the shapes
// are real: the first one IS masked.
const MB = 1e6;
const repeatTo = (unit, n = MB) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const JSON_STRING_LIMIT_MS = 3000;
for (const [name, text] of [
  ['a head every ten characters', repeatTo('"token": "')],
  ['valid values with blanks, 1 MB', repeatTo('{"password": "a b c d", "u": 1} ')],
  ['no closing quote, 1 MB of words', `{"password": "${'a '.repeat(MB / 2)}`],
  ['one backslash run of 1 MB, then a quote', `{"password": "${'\\'.repeat(MB)}"`],
  ['backslashes in front of every quote', `{"password": "${repeatTo('\\\\\\"')}`],
  ['four quote kinds, heads that close each other', repeatTo('"token":"x y" \'token\':\'x y\' \\"token\\":\\"x y\\" \\\\\\"token\\\\\\":\\\\\\"x y ')],
  ['single-quote heads, no closer', repeatTo("token:'a ")],
  ['kinds interleaved, none closes', repeatTo('token: "a token: \'b token: \\"c token: \\\\\\"d ')],
  ['a head per line, no closer', repeatTo('token: "a\n')],
  ['a quote run of 1 MB behind a head', `token: ${'"'.repeat(MB)}`],
  ['apostrophes in prose with the keyword', repeatTo("it's a token: don't ")],
  ['markers behind a header name', repeatTo('x-api-key: [REDACTED:x][REDACTED:y] ')],
  ['one value of markers and stumps', `api_key=${repeatTo('Ab3xK9mQAb3xK9mQ[REDACTED:x]')}`],
]) {
  test(`linear: whole-string pass: ${name}, under ${JSON_STRING_LIMIT_MS} ms`, { timeout: 60000 }, () => {
    const t = performance.now();
    redaction.redact(text);
    const ms = performance.now() - t;
    assert.ok(ms < JSON_STRING_LIMIT_MS, `${ms.toFixed(0)} ms (limit ${JSON_STRING_LIMIT_MS}) - the scan repeats itself`);
  });
}

test('whole-string pass: the control: the shapes above are real (a head with a value IS masked, at 1 MB too)', () => {
  assert.match(redaction.redact(`{"password": "${'a '.repeat(MB / 2)}"}`).text, /REDACTED:json-secret/);
  assert.match(redaction.redact(`{"password": "${'\\'.repeat(MB)}"`).text, /REDACTED:json-secret/);
  assert.match(redaction.redact(`api_key=${repeatTo('Ab3xK9mQAb3xK9mQ[REDACTED:x]')}`).text, /REDACTED/);
});
