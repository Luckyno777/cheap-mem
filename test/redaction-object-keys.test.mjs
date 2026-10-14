// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Object fields under a secret's KEY, and a Bearer/Basic value behind a marker (2026-10-14).
//
// 1. `redactObject` / `redactEntry` / `maskEntry` read each string alone. `{password: "correct horse battery staple"}`
//    and `{token: "abc123def456"}` stayed open as real fields, however plain the key; nested it is the raw capture's
//    normal case (`tool_use.input`: `{headers: {Authorization: ...}}`, `{env: {API_KEY: ...}}`). Now a string under a
//    secret's key falls whole at any depth (the key list is the one of `json-secret`), a number or boolean too; counters
//    (`max_tokens`, `tokens_used`, `usage.input_tokens`) and pagination cursors stay.
// 2. `Bearer [REDACTED:x]<32 characters>` left the value open: the marker ended the pattern. Same for Basic and the
//    `Authorization: Token` scheme.
//
// CANARY FILE: contains deliberate sample secrets as probes for the redaction; the scanner and the pre-commit hook skip
// files with this marker. Tokens are built at run time, nothing here is a real value.
//
// Red proof against a FIXED old commit (never a moving merge-base): the base of this change on kette/cm. Positive
// control: the old tree masks a plain `Bearer <32>` and a `{"password": "..."}` text, so the probe does grip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as redaction from '../src/redaction.mjs';
import { maskEntry, maskOutput, maskText } from '../src/outputguard.mjs';
import * as raw from '../src/raw.mjs';
import { sanitizeForDisplay } from '../src/cli/display.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_STATE = 'e58fb2bbd65b17d8b1681f058e0a742c02fbbf49';
const MARK = '[REDACTED:json-secret]';
const VALUE = 'Ab3xK9mQ7zLpWq5rTn2Yc8Vd4Fh6Jg1S';
const PHRASE = 'correct horse battery staple';

test('a string under a secret key falls whole, at any depth, in the write path and at the output', () => {
  const cases = [
    { password: PHRASE },
    { token: 'abc123def456' },
    { headers: { Authorization: `Basic ${Buffer.from('user:pw').toString('base64')}` } },
    { env: { API_KEY: 'k1' } },
    { a: { b: { c: { d: { secretKey: 'x y' } } } } },
    { list: [{ client_secret: 'zz' }, { refresh_token: 'q' }] },
    { 'x-api-key': 'short' },
    { passphrase: 'pw' },
    { private_key: 'k' },
    { accessToken: 'tiny' },
    { password_hint: 'dog name plus 1' },
  ];
  for (const c of cases) {
    const leaves = JSON.stringify(c);
    for (const r of [redaction.redactObject(c), redaction.redactEntry(c, { secrets: [] }).object, maskEntry(c)]) {
      const s = JSON.stringify(r);
      assert.ok(s.includes(MARK), `not masked: ${leaves} => ${s}`);
      assert.ok(!/horse|abc123|Basic |"k1"|"x y"|"zz"|"tiny"|"short"|dog name/.test(s), `value left: ${leaves} => ${s}`);
    }
  }
  assert.deepEqual(redaction.redactObject({ password: PHRASE }), { password: MARK });
});

test('the context is inherited by what stands below a secret key', () => {
  assert.deepEqual(maskEntry({ secrets: { A: 'x1', B: ['y1', { c: 'z1' }] } }), { secrets: { A: MARK, B: [MARK, { c: MARK }] } });
  assert.deepEqual(maskEntry({ token: ['a1', 'b2'] }), { token: [MARK, MARK] });
  assert.deepEqual(maskEntry({ other: { password: { value: 'v1' } } }), { other: { password: { value: MARK } } });
  // numbers are not inherited through an object: a table of counts named after a kind of key keeps its numbers
  assert.deepEqual(maskEntry({ 'github-token': { n: 5, caught: 5, name: 'ab' } }), { 'github-token': { n: 5, caught: 5, name: MARK } });
  assert.deepEqual(maskEntry({ password: [1, 2, 'a'] }), { password: [MARK, MARK, MARK] });
});

test('numbers and booleans under a secret key are masked; null, empty and blank stay', () => {
  assert.deepEqual(maskEntry({ password: 123456, token: true, secret: false, api_key: 0 }), { password: MARK, token: MARK, secret: MARK, api_key: MARK });
  assert.deepEqual(maskEntry({ password: null, token: '', secret: '   ' }), { password: null, token: '', secret: '   ' });
  assert.deepEqual(maskEntry({ password: undefined }), { password: undefined });
});

test('counters are not secrets: max_tokens, tokens_used, usage.input_tokens stay; singular token and authToken do not', () => {
  const keep = { max_tokens: 4096, tokens_used: 1234, token_count: 5, maxTokens: 9, totalTokens: 10, numTokens: 3, token_limit: 7, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0 }, tokens: 55 };
  assert.deepEqual(maskEntry(keep), keep);
  assert.deepEqual(redaction.redactObject(keep), keep);
  // a counter is a NUMBER: a digit string, a boolean or a list of numbers under a counter key is a value (review 2026-10-14)
  assert.deepEqual(maskEntry({ tokens_used: '1234', max_tokens: '4,096', token_count: true, tokens: [1, 2] }),
    { tokens_used: MARK, max_tokens: MARK, token_count: MARK, tokens: [MARK, MARK] });
  assert.deepEqual(maskEntry({ tokens: 'abc123def456' }), { tokens: MARK });
  assert.deepEqual(maskEntry({ token: 1234, authToken: 1234, access_token: 1 }), { token: MARK, authToken: MARK, access_token: MARK });
});

test('a plural or a counter word is a count: "secrets": 120 and password_length: 12 stay; a number under the singular does not', () => {
  const keep = { secrets: 120, passwords: 3, api_keys: 2, password_length: 12, secret_count: 4, token_limit_per_min: 10, tokensUsed: 5 };
  assert.deepEqual(maskEntry(keep), keep);
  assert.deepEqual(maskEntry({ secret: 120, password: 12 }), { secret: MARK, password: MARK });
});

test('a digit string under a counter-looking key is a value; a counter is a single number (review 2026-10-14)', () => {
  const closed = [
    { passwords: ['1234', '5678'] }, { secrets: '123456' }, { tokens: '123456' }, { password_len: '123456' },
    { api_key_count: '99887766' }, { token_count: '4111 1111 1111 1111' }, { passwords: [1234, 5678] }, { secret_count: true },
  ];
  for (const c of closed) {
    for (const r of [maskEntry(c), redaction.redactObject(c), redaction.redactEntry(c, { secrets: [] }).object]) {
      assert.ok(!/\d{4}/.test(JSON.stringify(r)), `value left: ${JSON.stringify(c)} => ${JSON.stringify(r)}`);
    }
  }
  // the corpus case stays free: one number under a plural
  assert.deepEqual(maskEntry({ kinds: 24, secrets: 120, caughtByRedaction: 1 }), { kinds: 24, secrets: 120, caughtByRedaction: 1 });
});

test('object-only key words: pin, pwd, passcode, credential(s), privateKey, accessKey, access-key; a fetch option stays', () => {
  const c = { pin: '1234', userPin: 4321, pin_code: 'a b', pwd: 'x y', passcode: 99, credential: 'ab', credentials: 'u:p', privateKey: 'k k', accessKey: 'a1', 'access-key': 'a2', clientSecret: 's s' };
  for (const r of [maskEntry(c), redaction.redactObject(c)]) {
    for (const k of Object.keys(c)) assert.equal(r[k], MARK, `${k} => ${JSON.stringify(r[k])}`);
  }
  assert.deepEqual(maskEntry({ credentials: 'include' }), { credentials: 'include' });
  assert.deepEqual(maskEntry({ credentials: 'same-origin', pinned: true, pinball: 'x', spin: 'y', pins: 'z' }), { credentials: 'same-origin', pinned: true, pinball: 'x', spin: 'y', pins: 'z' });
  // the text rule is unchanged: a bare `pin` as text is no finding
  assert.equal(redaction.redact('{"pin": "1234"}').text, '{"pin": "1234"}');
});

test('a key that goes on long behind its keyword spares prose, like the text rule, and masks the rest', () => {
  const prose = 'The study declares ten variables and uses many hex literals, variables cover roughly seven percent of the color decisions, and it is declared and never used by anyone.';
  assert.deepEqual(maskEntry({ token_system_is_a_facade: prose }), { token_system_is_a_facade: prose });
  assert.deepEqual(maskEntry({ token_system_is_a_facade: 'abc123def456' }), { token_system_is_a_facade: MARK });
  assert.deepEqual(maskEntry({ token_system_is_a_facade: 'two words' }), { token_system_is_a_facade: MARK });
  assert.deepEqual(maskEntry({ password: prose }), { password: MARK });
});

test('a pagination cursor stays, as in the text rule', () => {
  assert.deepEqual(maskEntry({ nextPageToken: 'CAESAAAA', page_token: 'x1', next_token: 'y2', continuationToken: 'z3' }),
    { nextPageToken: 'CAESAAAA', page_token: 'x1', next_token: 'y2', continuationToken: 'z3' });
});

test('keys written with look-alikes still count: full-width letters and zero-width characters', () => {
  const wide = [...'password'].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).join('');
  assert.deepEqual(maskEntry({ [wide]: 'a b' }), { [wide]: MARK });
  assert.deepEqual(maskEntry({ ['pass\u200Bword']: 'a b' }), { ['pass\u200Bword']: MARK });
});

test('a marker alone stays (idempotence); a marker with a stump falls; the second pass changes nothing', () => {
  assert.deepEqual(maskEntry({ password: '[REDACTED:x]' }), { password: '[REDACTED:x]' });
  assert.deepEqual(maskEntry({ password: '[REDACTED:x] [REDACTED:y]' }), { password: '[REDACTED:x] [REDACTED:y]' });
  assert.deepEqual(maskEntry({ password: 'T [REDACTED:x] T' }), { password: MARK });
  for (const c of [{ password: PHRASE, a: { token: 7, max_tokens: 3 } }, { env: { API_KEY: 'k1' }, n: [1, 'x'] }]) {
    const once = maskEntry(c);
    assert.deepEqual(maskEntry(once), once);
    const o2 = redaction.redactObject(c);
    assert.deepEqual(redaction.redactObject(o2), o2);
  }
});

test('the write path counts what the key rule masked', () => {
  const found = new Map();
  redaction.redactObject({ password: PHRASE, a: { token: 5 }, text: 'hello' }, found);
  assert.equal(found.get('json-secret'), 2);
  const r = redaction.redactEntry({ headers: { Authorization: 'Basic abc' } }, { secrets: [] });
  assert.ok(r.found.some((f) => f.type === 'json-secret' && f.count === 1), JSON.stringify(r.found));
});

test('what is not under a secret key is untouched; non-plain objects stay at the output', () => {
  const d = new Date(0);
  const plain = { type: 'event', topic: 'logging', n: 5, ok: true, nested: { text: 'we talked about passwords in general' }, d };
  const m = maskEntry(plain);
  assert.deepEqual(m, plain);
  assert.equal(m.d, d);
  // the keyword only in the VALUE is the text rule's business, not the key rule's
  assert.deepEqual(maskEntry({ note: 'my password is a secret' }), { note: 'my password is a secret' });
});

test('a cycle and a runaway depth end in a marker, not in a crash', () => {
  const a = { name: 'x' }; a.self = a; a.list = [a, { back: a }];
  for (const f of [maskEntry, (v) => redaction.redactObject(v), (v) => redaction.redactEntry(v, { secrets: [] }).object]) {
    const r = f(a);
    assert.equal(r.name, 'x');
    assert.equal(r.self, '[REDACTED:cycle]');
    assert.equal(r.list[0], '[REDACTED:cycle]');
    assert.equal(r.list[1].back, '[REDACTED:cycle]');
  }
  let deep = { password: 'x1' }; for (let i = 0; i < 5000; i += 1) deep = { d: deep };
  const r = maskEntry(deep);
  let cur = r; let n = 0;
  while (cur && typeof cur === 'object') { cur = cur.d; n += 1; }
  assert.equal(cur, '[REDACTED:depth]');
  assert.ok(n < 100, `depth cap: ${n}`);
  assert.ok(!JSON.stringify(redaction.redactEntry(deep, { secrets: [] }).object).includes('x1'));
  // a shared, non-cyclic reference is no cycle
  const shared = { token: 'x1' };
  assert.deepEqual(maskEntry({ a: shared, b: shared }), { a: { token: MARK }, b: { token: MARK } });
});

test('a JSON document at the output: values under a secret key are masked, the shape stays', () => {
  const doc = JSON.stringify({ input: { env: { API_KEY: 'k1' } }, max_tokens: 5 }, null, 2);
  const out = maskOutput(doc);
  assert.ok(out.includes(MARK) && !out.includes('k1') && out.includes('"max_tokens": 5'), out);
  assert.equal(maskOutput(JSON.stringify({ a: 1, max_tokens: 5 })), JSON.stringify({ a: 1, max_tokens: 5 }));
});

test('the raw capture masks a secret field in a tool_use input, nested; the usage counters survive', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-objkeys-raw-'));
  try {
    const lines = [];
    for (let i = 0; i < 40; i += 1) lines.push({ timestamp: `2026-10-14T03:00:${String(i).padStart(2, '0')}Z`, message: { content: `talking about deployment ${i}` } });
    lines.push({ timestamp: '2026-10-14T03:10:00Z', message: { usage: { input_tokens: 5, max_tokens: 4096 }, content: [{ type: 'tool_use', name: 'Bash',
      input: { command: 'curl x', headers: { Authorization: 'Basic dXNlcjpw' }, env: { API_KEY: 'k1abc' }, password: PHRASE, token: 'abc123def456' } }] } });
    for (let i = 0; i < 40; i += 1) lines.push({ timestamp: '2026-10-14T03:11:00Z', message: { content: `${'x'.repeat(100)}${i}` } });
    const t = path.join(root, 't.jsonl');
    fs.writeFileSync(t, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    assert.equal(raw.capture(root, t, { minBytes: 1 }).status, 'captured');
    const [cap] = raw.listCaptures(root);
    const stored = raw.readCapture(root, cap).lines;
    const all = JSON.stringify(stored);
    assert.ok(!/k1abc|horse battery|dXNlcjpw|abc123def456/.test(all), 'a field value reached the capture');
    const tu = stored.find((l) => JSON.stringify(l).includes('tool_use')).message;
    assert.deepEqual(tu.content[0].input, { command: 'curl x', headers: { Authorization: MARK }, env: { API_KEY: MARK }, password: MARK, token: MARK });
    assert.deepEqual(tu.usage, { input_tokens: 5, max_tokens: 4096 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an MCP reply that is a JSON document (mem_show) goes through the key rule: sanitizeForDisplay on a JSON string', () => {
  const doc = JSON.stringify({ id: 'x', origin: { env: { API_KEY: 'k1abc' }, headers: { Authorization: 'Basic dXNlcjpw' }, max_tokens: 4096 } }, null, 2);
  const out = sanitizeForDisplay(doc);
  assert.ok(!/k1abc|dXNlcjpw/.test(out), out);
  assert.ok(out.includes('"max_tokens": 4096') && out.includes(MARK), out);
  assert.equal(JSON.parse(out).origin.max_tokens, 4096);
  // plain text and text that merely starts with a bracket take the text mask only
  assert.equal(sanitizeForDisplay('[1] a note about tokens'), '[1] a note about tokens');
  assert.equal(sanitizeForDisplay(`note: Bearer [REDACTED:x]${VALUE}`).includes(VALUE.slice(0, 12)), false);
});

test('scanObject: the key rule counts for the legacy scan, a value is never returned', () => {
  const f = redaction.scanObject({ input: { env: { API_KEY: 'k1' } } });
  assert.deepEqual(f, [{ type: 'json-secret', count: 1 }]);
  assert.deepEqual(redaction.scanObject({ max_tokens: 5, text: 'hello' }), []);
  assert.deepEqual(redaction.scanObject({ password: '[REDACTED:json-secret]' }), []);
});

// ---- Bearer / Basic / Token behind a marker -------------------------------------------------------------------

test('Bearer, Basic and the Token header scheme: a value behind one or more markers falls', () => {
  const b64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZVNlc2FtZTEyMw';
  for (const t of [
    `Bearer [REDACTED:x]${VALUE}`, `Bearer [REDACTED:x][REDACTED:y]${VALUE}`, `Authorization: Bearer [REDACTED:x]${VALUE}`,
    `Bearer [REDACTED:x]${VALUE}[REDACTED:y]${VALUE}`, `Bearer [REDACTED:x]abc`,
    `Basic [REDACTED:x]${b64}`, `Basic [REDACTED:x][REDACTED:y]${b64}`,
    `Authorization: Token [REDACTED:x]${VALUE}`, `Authorization: Token ${VALUE}`, `authorization: token [REDACTED:x][REDACTED:y]${VALUE}`,
  ]) {
    const r = redaction.redact(t).text;
    assert.ok(!r.includes(VALUE.slice(0, 12)) && !r.includes(b64.slice(0, 12)) && !r.includes('abc'), `value left: ${t} => ${r}`);
    assert.equal(redaction.redact(r).text, r, `not idempotent: ${t}`);
    assert.equal(maskText(maskText(t)), maskText(t));
  }
  // two markers in a row inside the value, with a stump behind them
  for (const t of [`Bearer ${VALUE}[REDACTED:x][REDACTED:y]${VALUE}`, `Basic ${VALUE}[REDACTED:x][REDACTED:y]${VALUE}`, `Authorization: Token ${VALUE}[REDACTED:x][REDACTED:y][REDACTED:z]${VALUE}`]) {
    const r = redaction.redact(t).text;
    assert.ok(!r.includes(VALUE.slice(0, 12)) && !r.includes(VALUE.slice(-12)), `value left: ${t} => ${r}`);
    assert.equal(redaction.redact(r).text, r);
  }
  // a value behind the marker AND a stump after the value: the stump is part of it
  assert.ok(!redaction.redact(`Bearer ${VALUE}[REDACTED:x]ZZZZ`).text.includes('ZZZZ'));
});

test('a value of markers alone stays; prose after a marker is no value', () => {
  for (const t of ['Bearer [REDACTED:x]', 'Bearer [REDACTED:x][REDACTED:y]', 'Authorization: Bearer [REDACTED:bearer]', 'Basic [REDACTED:basic-auth]',
    'Bearer [REDACTED:x] is the scheme.', 'Bearer [REDACTED:x].', 'Authorization: Token [REDACTED:x]\nnext line', 'Token [REDACTED:x]abc', `Token ${VALUE}`]) {
    assert.equal(redaction.redact(t).text, t, `must stay: ${t}`);
  }
});

test('a very long key is judged in linear time', () => {
  for (const key of ['token'.repeat(200000), 'x'.repeat(1e6), 'tokens'.repeat(150000)]) {
    const t = performance.now();
    maskEntry({ [key]: 'v v' });
    const ms = performance.now() - t;
    assert.ok(ms < 2500, `${ms.toFixed(0)} ms on a key of ${key.length} characters`);
  }
});

test('an object key made of one long run of punctuation is judged in linear time (review 2026-10-14)', { timeout: 120000 }, () => {
  // the small shapes first: a regression is red at once (about 1.4 s and 5.6 s each), not after minutes on the 1 MB ones
  const keys = ['='.repeat(5e4) + 'x', ' \\'.repeat(5e4) + 'x', '='.repeat(1e6) + 'x', ' \\'.repeat(5e5) + 'x', '\\'.repeat(1e6) + 'x', ':'.repeat(1e6) + 'x',
    '"'.repeat(1e6) + 'x', "'".repeat(1e6) + 'x', ' '.repeat(5e5) + 'x', '=\\'.repeat(2e5)];
  for (const key of keys) {
    for (const [name, f] of [['redactObject', (o) => redaction.redactObject(o)], ['maskEntry', (o) => maskEntry(o)], ['redactEntry', (o) => redaction.redactEntry(o, { secrets: [] }).object],
      ['scanObject', (o) => redaction.scanObject(o)], ['isHarmlessKey', () => redaction.isHarmlessKey(key)]]) {
      const t = performance.now();
      f({ [key]: 'a b' });
      const ms = performance.now() - t;
      assert.ok(ms < 2500, `${name}: ${ms.toFixed(0)} ms on a key of ${key.length} characters starting ${JSON.stringify(key.slice(0, 4))}`);
    }
  }
  // a key past the cap is a secret in doubt
  assert.deepEqual(maskEntry({ ['k'.repeat(2000)]: 'a b' }), { ['k'.repeat(2000)]: MARK });
  // the loop trims what the old class trimmed
  assert.equal(redaction.isHarmlessKey('"nextPageToken":  '), true);
  assert.equal(redaction.isHarmlessKey('\\"next_token\\"='), true);
  assert.equal(redaction.isHarmlessKey('"authToken":'), false);
});

test('Bearer/Basic stay linear with many markers and many schemes', () => {
  const markers = '[REDACTED:x]'.repeat(40000);
  for (const text of [`Bearer ${markers}`, `Bearer ${markers}!`, 'Bearer [REDACTED:x]a '.repeat(40000), `Basic ${markers}`, `Authorization: Token ${markers}`,
    'Bearer '.repeat(100000), `Bearer ${'[REDACTED:x]'.repeat(10)}`.repeat(30000), `Bearer a${'[REDACTED:x]b'.repeat(40000)}`, `Bearer a${'[REDACTED:x]'.repeat(80000)}!`,
    `Bearer a${'[REDACTED:x][REDACTED:y]b'.repeat(30000)}`, `${'Bearer a[REDACTED:x][REDACTED:y] '.repeat(30000)}`]) {
    const t = performance.now();
    redaction.redact(text);
    const ms = performance.now() - t;
    assert.ok(ms < 2500, `${ms.toFixed(0)} ms on ${text.length} characters`);
  }
});

// ---- red proof -------------------------------------------------------------------------------------------------

test('red proof: the old tree left every one of these open; positive control: it did mask the plain forms', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-objkeys-'));
  try {
    exportCommit(REPO, OLD_STATE, ['src/redaction.mjs', 'src/outputguard.mjs'], dir);
    const old = await import(pathToFileURL(path.join(dir, 'src', 'redaction.mjs')).href);
    const oldGuard = await import(pathToFileURL(path.join(dir, 'src', 'outputguard.mjs')).href);
    // the objects: the old walk looked at each string alone
    const objects = [{ passwords: ['1234', '5678'] }, { token_count: '4111 1111 1111 1111' }, { pin: '1234' }, { privateKey: 'k k' }, { password: PHRASE }, { token: 'abc123def456' }, { env: { API_KEY: 'k1' } }, { headers: { Authorization: 'Basic abc' } }, { password: 123456 }, { x: { y: { secret: 'a b' } } }];
    for (const o of objects) {
      assert.ok(!JSON.stringify(old.redactObject(o)).includes(MARK), `the old redactObject masked ${JSON.stringify(o)}`);
      assert.ok(!JSON.stringify(oldGuard.maskEntry(o)).includes(MARK), `the old maskEntry masked ${JSON.stringify(o)}`);
      assert.ok(JSON.stringify(redaction.redactObject(o)).includes(MARK), `the new redactObject keeps ${JSON.stringify(o)}`);
    }
    // the Bearer family
    for (const t of [`Bearer [REDACTED:x]${VALUE}`, `Bearer [REDACTED:x][REDACTED:y]${VALUE}`, `Basic [REDACTED:x]${VALUE}`, `Authorization: Token ${VALUE}`]) {
      assert.ok(old.redact(t).text.includes(VALUE.slice(0, 12)), `the old tree masked ${t}`);
      assert.ok(!redaction.redact(t).text.includes(VALUE.slice(0, 12)), `the new tree leaves ${t}`);
    }
    // positive control: the probe grips, the old tree masks the plain forms
    assert.ok(!old.redact(`Bearer ${VALUE}`).text.includes(VALUE.slice(0, 12)), 'control: old Bearer');
    assert.ok(old.redact('{"password": "correct horse battery staple"}').text.includes('REDACTED'), 'control: old json text');
    assert.ok(old.redactObject({ text: `Bearer ${VALUE}` }).text.includes('REDACTED'), 'control: old redactObject on a text value');
    // the MCP text reply (a JSON document as text) was masked as text only: the short key value stayed
    const docText = JSON.stringify({ origin: { env: { API_KEY: 'k1abc' } } }, null, 2);
    assert.ok(oldGuard.maskText(docText).includes('k1abc'), 'the old text mask masked the field value');
    assert.ok(oldGuard.maskOutput(docText).includes('k1abc'), 'the old document mask kept it, too');
    // counters were never masked and must not be now
    assert.deepEqual(old.redactObject({ max_tokens: 4096 }), { max_tokens: 4096 });
    assert.deepEqual(redaction.redactObject({ max_tokens: 4096 }), { max_tokens: 4096 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
