// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A string value under a secret's key falls WHOLE, blanks, escaped quotes and markers inside it included
// (finding 2026-10-13, torn-marker round): the old `json-secret` rule took a value without blanks only, so
// a passphrase in JSON stayed in the clear, and so did the stump behind a marker an earlier rule had left.
//
// CANARY FILE: contains deliberate sample secrets as probes for the redaction; the scanner and the pre-commit hook
// skip files with this marker.
//
// Red proof against a FIXED old commit (never a moving merge-base): on it every masked case below leaves its
// plant in the clear. Positive controls: values under other keys, prose about passwords, placeholders and
// a value of markers alone stay as they are. Idempotence: masking twice is masking once.
// No path, no POSIX tool, no exit-code assumption: the plants are strings, the scratch memory sits in os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { redact } from '../src/redaction.mjs';
import { maskText, maskOutput } from '../src/outputguard.mjs';
import * as dashboard from '../src/dashboard.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The state before this change (the tip of kette/cm at 2026-10-13). Pinned, never `merge-base`. */
const OLD_STATE = '7a46a3ae5c787f0a80e51fb07a04480532e141cf';
const MARK = (type) => `[REDACTED:${type}]`;
const PHRASE = ['correct', 'horse', 'battery', 'staple'].join(' ');
const TAIL = 'Zq9';
const BS = '\\';
const Q = '"';

/** [name, text, plant]: the plant must be gone from the masked text; `masked` says what must be there instead. */
const MASKED = [
  ['phrase in JSON', `{"password": "${PHRASE}"}`, PHRASE],
  ['blank inside a key-shaped value', `{"api_key": "Ab3x Ab3xK9mQAb3xK9mQ"}`, 'Ab3xK9mQAb3xK9mQ'],
  ['escaped quote inside', `{"password": "pa${BS}${Q}ss word ${TAIL}"}`, `word ${TAIL}`],
  ['marker and a stump inside (JSON)', `{"api_key": "T ${MARK('x')} ${TAIL}…"}`, TAIL],
  ['marker and a stump, no blank (JSON)', `{"api_key": "${MARK('x')}${TAIL}"}`, TAIL],
  ['nested one level (escaped quotes)', `{"msg":"{${BS}"password${BS}": ${BS}"${PHRASE}${BS}", ${BS}"user${BS}": ${BS}"bob${BS}"}"}`, PHRASE],
  ['nested, with an escaped quote in the value', `{"msg":"{${BS}"password${BS}": ${BS}"horse ${BS}${BS}${BS}"${TAIL}${BS}${BS}${BS}" x${BS}"}"}`, TAIL],
  ['single quotes (Python repr)', `{'password': '${PHRASE}', 'user': 'bob'}`, PHRASE],
  ['quoted value in an env file', `export DB_PASSWORD='${PHRASE}'\necho done`, PHRASE],
  ['YAML key, double-quoted value', `password: "${PHRASE}" # note`, PHRASE],
  ['key behind the opening quote of a JSON string, value escaped once (env line)', `{"env":"PASSWORD=${BS}"${PHRASE}${BS}""}`, PHRASE],
  ['same, a command line with more behind it', `{"cmd":"password=${BS}"${PHRASE}${BS}" run"}`, PHRASE],
  ['same, the key is the first thing in the string', `"password: ${BS}"${PHRASE}${BS}""`, PHRASE],
  ['same, escaped twice', `{"a":"{${BS}"msg${BS}":${BS}"PASSWORD=${BS}${BS}${BS}"${PHRASE}${BS}${BS}${BS}"${BS}"}"}`, PHRASE],
  ['passphrase (new key word)', `{"passphrase": "two words ${TAIL}"}`, TAIL],
  ['api-key as a kebab key', `{"api-key": "${PHRASE}"}`, PHRASE],
  ['cut text: no closing quote', `{"password": "${PHRASE}`, PHRASE],
  ['cut text, then a new line', `{"password": "${PHRASE}\nnext line`, PHRASE],
  ['key=value, value starts with a marker', `api_key=${MARK('x')}${TAIL}`, TAIL],
  ['key=value, marker in the middle', `api_key=Qw12${MARK('x')}${TAIL}`, TAIL],
  ['flag form, value starts with a marker', `--token ${MARK('x')}${TAIL}ab12cd34`, `${TAIL}ab12cd34`],
  ['x-api-key header, value starts with a marker', `x-api-key: ${MARK('x')}${TAIL}`, TAIL],
  ['x-api-key header, marker in the middle', `x-api-key: Ab3xK9mQAb3xK9mQ${MARK('x')}${TAIL}`, TAIL],
  ['signed URL parameter, value starts with a marker', `https://h.test/p?X-Amz-Signature=${MARK('x')}${TAIL}1234`, `${TAIL}1234`],
];

/** Text that must come back byte for byte. */
const KEPT = [
  ['a value under another key', `{"note": "${PHRASE}"}`],
  ['prose about passwords', 'The password is required and the token: it expired'],
  ['a placeholder phrase', '{"password": "your password"}'],
  ['a bracketed placeholder with blanks', '{"password": "<your password here>"}'],
  ['markers alone, JSON', `{"password": "${MARK('a')} ${MARK('b')}"}`],
  ['one marker, JSON', `{"password": "${MARK('a')}"}`],
  ['one marker, key=value', `api_key=${MARK('a')}`],
  ['a marker and closing punctuation', `(api_key=${MARK('a')}).`],
  ['a marker, then the JSON-escaped ampersand of the next parameter', `X-Amz-Credential=${MARK('a')}${BS}u0026X-Amz-Expires=3600`],
  ['a pagination cursor', '{"nextPageToken": "abc def ghi jkl mno"}'],
  ['a code literal that ends with the equals sign', "assert.ok(code.indexOf('MY_TOKEN=') < code.indexOf('node '), 'the line');"],
  ['a code literal at the end of a line', "const cases = [['export DB_PASSWORD=', 'x'],\n  ['y', 'z']];"],
  ['a sentence under a key with the keyword at its front', `{"token_system_is_a_facade": "${PHRASE} and then some more words after it, all of them plain"}`],
  ['a long sentence behind a bare keyword key', `secrets: '${'plain words in a row '.repeat(5)}'`],
  ['a GitHub Actions reference', 'token: "${{ secrets.GITHUB_TOKEN }}"'],
  ['a nested-bracket reference in JSON', '{"token": "${{ secrets.DEPLOY_KEY }}"}'],
  ['a short word', '{"password": "ab cd"}'],
  ['a raw line break inside the value (not JSON)', `{"password": "one two\nthree four"}`],
];

test('masked: a string value under a secret key falls whole', () => {
  for (const [name, text, plant] of MASKED) {
    const out = redact(text).text;
    assert.ok(!out.includes(plant), `${name}: the plant survived: ${out}`);
    assert.ok(/\[REDACTED:/.test(out), `${name}: no marker: ${out}`);
  }
});

test('masked: the text around the value is untouched, the key and the quotes stay', () => {
  assert.equal(redact(`{"password": "${PHRASE}", "user": "bob"}`).text, `{"password": "${MARK('json-secret')}", "user": "bob"}`);
  assert.equal(redact(`{"a":1,"token":"x ${TAIL} yy","b":2}`).text, `{"a":1,"token":"${MARK('json-secret')}","b":2}`);
  assert.equal(redact(`{'password': '${PHRASE}', 'user': 'bob'}`).text, `{'password': '${MARK('json-secret')}', 'user': 'bob'}`);
  assert.equal(redact(`{"msg":"{${BS}"password${BS}": ${BS}"${PHRASE}${BS}", ${BS}"user${BS}": ${BS}"bob${BS}"}"}`).text,
    `{"msg":"{${BS}"password${BS}": ${BS}"${MARK('json-secret')}${BS}", ${BS}"user${BS}": ${BS}"bob${BS}"}"}`);
  assert.equal(redact(`export DB_PASSWORD='${PHRASE}'\necho done`).text, `export DB_PASSWORD='${MARK('json-secret')}'\necho done`);
  // The JSON that holds the masked value is still JSON.
  assert.doesNotThrow(() => JSON.parse(redact(`{"password": "pa${BS}${Q}ss word", "n": 1}`).text));
});

test('the code-literal guard holds (and only for an unescaped quote: the escaped forms are in the masked list)', () => {
  const lit = "assert.ok(code.indexOf('FOO_TOKEN=') < code.indexOf('node '), 'the line');";
  assert.equal(redact(lit).text, lit);
});

test('a stray quote behind a bare key in a long line of prose takes nothing with it; a short bare value without a closer still falls', () => {
  const prose = ' so it goes on and on with plain words, none of them a secret'.repeat(2000);
  for (const n of [4100, 10000, 100000]) {
    const text = `Note: password: "see below.${prose.slice(0, n)}`;
    assert.equal(redact(text).text, text, `${n} characters: the text must stay`);
    assert.equal(redact(redact(text).text).text, redact(text).text);
  }
  // Control: up to the cap the bare value falls to the end of the text, as before, and masking twice is masking once.
  const key = 'Ab3xK9mQ7zLpWq5r ';
  for (const value of [`${PHRASE}`, key.repeat(200)]) {
    const text = `Note: password: "${value}`;
    assert.equal(redact(text).text, `Note: password: "${MARK('json-secret')}`, `${value.length} characters`);
    assert.equal(redact(redact(text).text).text, `Note: password: "${MARK('json-secret')}`);
  }
  // A quoted key keeps the old rule: a cut JSON line falls whole, however long.
  assert.equal(redact(`{"password": "${prose.slice(0, 10000)}`).text, `{"password": "${MARK('json-secret')}`);
});

test('brackets: a reference stays, a key or a phrase in brackets falls', () => {
  const k = 'Ab3xK9mQ7zLpWq5r';
  for (const v of [`\${{ ${k} }}`, `\${{ ${PHRASE} }}`, `{{${k}}}`, `\${${k}}`, `<${k}>`, `{{ ${k} }}`, `{{ ${PHRASE} }}`, `[${k}]`]) {
    assert.equal(redact(`{"password": "${v}"}`).text, `{"password": "${MARK('json-secret')}"}`, `must fall: ${v}`);
  }
  for (const v of ['${{ secrets.DB_PASSWORD }}', '${{ secrets.GITHUB_TOKEN }}', "{{ lookup('env','X') }}", "{{ vault.secret | default('x') }}",
    '${DB_PASSWORD}', '<your password here>']) {
    assert.equal(redact(`{"password": "${v}"}`).text, `{"password": "${v}"}`, `must stay: ${v}`);
  }
  assert.equal(redact('token: "${{ secrets.GITHUB_TOKEN }}"').text, 'token: "${{ secrets.GITHUB_TOKEN }}"');
});

test('kept: values without a secret key, prose, placeholders, markers alone', () => {
  for (const [name, text] of KEPT) assert.equal(redact(text).text, text, `${name}: changed`);
});

test('key=value with blanks in the value is NOT widened: the value ends at the blank (prose proximity)', () => {
  assert.equal(redact('password=hunterxxx9 two more words').text, 'password=[REDACTED:env-secret] two more words');
  assert.equal(redact('the password=short and the rest').text, 'the password=short and the rest');
});

test('the cap: the first 4096 characters AND the rest up to the closing quote fall; without a closing quote, to the end of the text or line', () => {
  const long = `${PHRASE} `.repeat(400);
  assert.ok(long.length > 4096 + 100);
  const closed = redact(`{"password": "${long}", "after": "ok"}`).text;
  assert.equal(closed, `{"password": "${MARK('json-secret')}", "after": "ok"}`, 'no stump of a long value');
  // No closing quote: all of it falls (to the end of the text, or of the line), however long, and masking twice is masking once.
  for (const n of [4097, 5000, 20000]) {
    const value = 'ab '.repeat(Math.ceil(n / 3)).slice(0, n);
    for (const [name, text, expected] of [
      ['to the end of the text', `{"password": "${value}`, `{"password": "${MARK('json-secret')}`],
      ['to the end of the line', `{"password": "${value}\nnext "x"`, `{"password": "${MARK('json-secret')}\nnext "x"`],
    ]) {
      const once = redact(text).text;
      assert.equal(once, expected, `${n} characters, ${name}`);
      assert.equal(redact(once).text, once, `${n} characters, ${name}: not idempotent`);
    }
  }
  // A closing quote far beyond the cap still ends the value; what follows it is not touched.
  const huge = redact(`{"token": "${'x y '.repeat(50000)}", "keep": "this"}`).text;
  assert.equal(huge, `{"token": "${MARK('json-secret')}", "keep": "this"}`);
});

test('idempotent: masking twice is masking once; a value of markers alone stays', () => {
  for (const [name, text] of [...MASKED, ...KEPT]) {
    const once = maskText(text);
    assert.equal(maskText(once), once, `${name}: not idempotent`);
    assert.equal(redact(once).text, once, `${name}: redact(redact(x)) differs`);
  }
});

test('the output paths: maskText, maskOutput (a JSON document stays valid JSON)', () => {
  // An entry's text carries the JSON as text; the document around it is an ordinary object.
  const doc = JSON.stringify({ title: 'x', text: `{"password": "${PHRASE}"} {"note": "${PHRASE}"}`, list: [`{"api_key": "T ${MARK('x')} ${TAIL}"}`] });
  const out = maskOutput(doc);
  const parsed = JSON.parse(out);
  assert.equal(parsed.text, `{"password": "${MARK('json-secret')}"} {"note": "${PHRASE}"}`, 'the value under the key falls, the note stays');
  assert.equal(parsed.list[0], `{"api_key": "${MARK('json-secret')}"}`);
  assert.ok(!out.includes(TAIL));
});

test('red proof: on the old state every masked case leaves its plant in the clear (key=value and header shapes included)', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-json-string-'));
  try {
    exportCommit(REPO, OLD_STATE, ['src/redaction.mjs'], dir);
    const old = await import(pathToFileURL(path.join(dir, 'src', 'redaction.mjs')).href);
    const survived = MASKED.filter(([, text, plant]) => old.redact(text).text.includes(plant)).map(([name]) => name);
    for (const must of ['phrase in JSON', 'blank inside a key-shaped value', 'escaped quote inside', 'marker and a stump inside (JSON)',
      'marker and a stump, no blank (JSON)', 'nested one level (escaped quotes)', 'single quotes (Python repr)', 'cut text: no closing quote',
      'key=value, value starts with a marker', 'x-api-key header, value starts with a marker', 'signed URL parameter, value starts with a marker']) {
      assert.ok(survived.includes(must), `the old tree should have let "${must}" through; it let through: ${survived.join(', ')}`);
    }
    // Control: the old tree kept what must be kept, so "masks more" is a difference and not a broken probe.
    for (const [name, text] of KEPT.slice(0, 6)) assert.equal(old.redact(text).text, text, `control: the old tree kept "${name}" too`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the surfaces that show entries (a scratch memory, written past the write path) -------------------------------

function run(root, args) {
  return spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem'), ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_NO_PULL: '1' },
  });
}

test('mem find, mem today / when today, mem show --json and the dashboard hand out no part of the value', (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-json-string-mem-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root, ['init']).status, 0);
  const word = 'flaechenwort';
  const body = `${word} {"password": "${PHRASE}"} and {"api_key": "T ${MARK('x')} ${TAIL}"} end`;
  const line = {
    id: 'plantjson1', ts: new Date().toISOString(), v: 1, title: `Sentinel ${word}`, text: body, topic: word,
    agent: 'human:root', authority: 'agent',
  };
  fs.appendFileSync(path.join(root, 'global', 'learnings.jsonl'), `${JSON.stringify(line)}\n`);
  const surfaces = {
    'mem find': run(root, ['find', word]),
    'mem find --json': run(root, ['find', word, '--json']),
    'mem show': run(root, ['show', 'plantjson1']),
    'mem show --json': run(root, ['show', 'plantjson1', '--json']),
    'mem when today': run(root, ['when', 'today']),
    'mem today': run(root, ['today']),
    'mem context': run(root, ['context']),
  };
  let shown = 0;
  for (const [name, r] of Object.entries(surfaces)) {
    const text = `${r.stdout}${r.stderr}`;
    if (text.includes(word)) shown += 1;
    assert.ok(!text.includes('battery staple') && !text.includes(TAIL), `${name}: part of the value in the output`);
  }
  assert.ok(shown >= 4, `positive control: the entry is shown on the surfaces (${shown})`);
  const rows = JSON.stringify(dashboard.readPass(root).rows);
  assert.ok(rows.includes(word), 'positive control: the dashboard rows hold the entry');
  assert.ok(!rows.includes('battery staple') && !rows.includes(TAIL), 'dashboard rows');
  const card = JSON.stringify(dashboard.getEntryFast(root, 'plantjson1'));
  assert.ok(card.includes(word) && !card.includes('battery staple') && !card.includes(TAIL), 'the entry card');
});
