// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/small-rest2-cm.test.mjs - leftovers of the masked copy of a transcript and of the pin words.
//
//  1. A private key that lies in the transcript as ONE JSON string (`\n` escapes) is masked to the last character, in
//     the structured form, in a line that no longer parses (cut off), and also when it is longer than the 8 KB bound
//     of the complete-block rule: the short last line of a key (fewer than 20 characters) used to survive there.
//  2. The block of plain lines has a cut (20000 lines or 2 MiB). A key that begins just before the cut is masked
//     across it (the header is carried), up to the END line or the end of the file.
//  3. Plural pin words: `pinhashes` in one word, and the words that stay free (spins, hairpins, kingpins, bare pins).
//  4. The Windows reflector hands the helper its paths as separate arguments (a space and an apostrophe in a path).
//
// Every key here is synthetic and built at run time from a fixed pseudo-random sequence; none is a real key.
// Red proof against the base (008fbef): recorded in the commit message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { maskText, maskEntry } from '../src/outputguard.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASK = path.join(REPO, 'bin', 'mem-mask-copy.mjs');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEAD = `-----BEGIN ${'RSA PRIVATE'} KEY-----`;
const FOOT = `-----END ${'RSA PRIVATE'} KEY-----`;
const TAIL = 'Zq9Xw7Lm2Kp4=';

function b64(n, seed) {
  let x = seed;
  let s = '';
  while (s.length < n) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += ALPHABET[(x >>> 8) % 64]; }
  return s;
}
const keyBody = (lines, seed = 7) => Array.from({ length: lines }, (_, i) => b64(64, seed + i));
// the middle 30 characters of a line: a rest of the key that is found by eye, however the line was cut
const piece = (l) => l.slice(10, 40);
const survivors = (text, body) => body.filter((l) => text.includes(piece(l)));
// Every call of the helper gets this file's OWN temp directory (TMPDIR, TEMP, TMP): its `mem-reflect-*` copies must not show
// up in the count of test/reflect-masked-copy.test.mjs, which may run at the same time (a parallel `node --test`).
const OWN_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-small-rest2-tmp-'));
const OWN_ENV = { ...process.env, TMPDIR: OWN_TMP, TEMP: OWN_TMP, TMP: OWN_TMP };
test.after(() => { fs.rmSync(OWN_TMP, { recursive: true, force: true }); });
const scratch = (name = 'cm-small-rest2-') => fs.mkdtempSync(path.join(OWN_TMP, name));

function maskedCopy(source, args = []) {
  const made = spawnSync(process.execPath, [MASK, ...args, source], { encoding: 'utf8', timeout: 100000, env: OWN_ENV });
  assert.equal(made.status, 0, made.stderr);
  const copy = made.stdout.trim();
  const text = fs.readFileSync(copy, 'utf8');
  spawnSync(process.execPath, [MASK, '--clean', copy], { encoding: 'utf8', env: OWN_ENV });
  return text;
}

test('a key as ONE JSON string with \\n escapes is masked whole: structured line, cut-off line, double escaped', () => {
  const body = keyBody(40);
  const key = [HEAD, ...body, TAIL, FOOT].join('\n');
  const line = JSON.stringify({ type: 'user', message: { content: key } });
  assert.ok(line.includes('\\n') && !line.includes('\n'), 'control: one physical line with escapes');
  const d = scratch();
  try {
    const t = path.join(d, 't.jsonl');
    fs.writeFileSync(t, `${line}\n`);
    const text = maskedCopy(t);
    assert.deepEqual(survivors(text, body), []);
    assert.ok(!text.includes(TAIL));
    // the same line cut off inside the string: not JSON any more, read as text; with and without the END
    for (const cut of [line.slice(0, -3), JSON.stringify({ m: [HEAD, ...body, TAIL].join('\n') }).slice(0, -3)]) {
      const out = maskText(cut);
      assert.deepEqual(survivors(out, body), []);
      assert.ok(!out.includes(TAIL), 'the short last line of the open block is masked');
    }
    // a JSON string inside a JSON string (a tool result that quotes a tool call)
    const twice = maskEntry(JSON.parse(JSON.stringify({ content: JSON.stringify({ k: key }) })));
    assert.deepEqual(survivors(JSON.stringify(twice), body), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a key longer than the 8 KB bound of the complete-block rule leaves no rest, not even its short last line', () => {
  const body = keyBody(200);
  assert.ok(body.join('\n').length > 8192, 'control: past the bound');
  for (const sep of ['\n', '\\n']) {
    for (const withEnd of [true, false]) {
      const out = maskText([HEAD, ...body, TAIL, ...(withEnd ? [FOOT] : [])].join(sep));
      assert.deepEqual(survivors(out, body), [], `body, sep ${JSON.stringify(sep)}, end ${withEnd}`);
      assert.ok(!out.includes(TAIL), `tail, sep ${JSON.stringify(sep)}, end ${withEnd}`);
    }
  }
});

test('the short last line takes only a line of its own: prose after an open block stays', () => {
  const out = maskText([HEAD, ...keyBody(5), TAIL, 'Next steps are listed below.'].join('\n'));
  assert.ok(!out.includes(TAIL));
  assert.match(out, /Next steps are listed below\./);
  // blanks at the end of the short last line do not save it
  for (const pad of [' ', '\t', '  \t ']) {
    const padded = maskText([HEAD, ...keyBody(5), `${TAIL}${pad}`, 'after'].join('\n'));
    assert.ok(!padded.includes(TAIL), `tail with trailing ${JSON.stringify(pad)} is masked`);
    assert.ok(!maskText([HEAD, ...keyBody(5), `${TAIL}${pad}`].join('\n')).includes(TAIL), 'also at the end of the text');
  }
  assert.equal(maskText(`${HEAD} is the header line of a key file.`), `${HEAD} is the header line of a key file.`, 'a header alone in prose is not touched');
});

test('the cut of the plain-line block does not give up an open key: it is masked across the cut, to the END or to the file end', { timeout: 120000 }, () => {
  const d = scratch();
  try {
    const t = path.join(d, 'cut.jsonl');
    const body = keyBody(300);
    // the key begins 10 lines before the 20000-line cut and ends in the second block
    const closed = [...Array(19990).fill('plain line'), HEAD, ...body, TAIL, FOOT, 'plain after the key'];
    fs.writeFileSync(t, `${closed.join('\n')}\n`);
    const text = maskedCopy(t);
    assert.deepEqual(survivors(text, body), [], 'the part of the key behind the cut');
    assert.ok(!text.includes(TAIL));
    assert.match(text, /plain after the key/, 'once the END is seen the block is closed again');
    // no END at all: three blocks, masked to the end of the file
    const body2 = keyBody(45000, 91);
    const open = [...Array(19990).fill('plain line'), HEAD, ...body2, TAIL];
    fs.writeFileSync(t, `${open.join('\n')}\n`);
    const text2 = maskedCopy(t);
    assert.deepEqual(survivors(text2, body2.filter((_, i) => i % 500 === 0)), []);
    assert.ok(!text2.includes(TAIL));
    // the copy keeps every plain line before the key (the carried header is not written into it)
    assert.equal(text2.split('\n').filter((l) => l === 'plain line').length, 19990);
    assert.ok(!text2.includes('BEGIN'), 'no synthetic header line is left in the copy');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pin words: the plural of a compound is a counter key (a string falls, a number stays), the English words stay free', () => {
  const value = 'Hq7-plain-value-xyz';
  const masked = (k) => maskEntry({ [k]: value })[k] !== value;
  for (const k of ['pinhashes', 'pinHashes', 'pin_hashes', 'userpins', 'pincodes', 'pin_codes', 'PINCODES', 'pinnumbers']) assert.ok(masked(k), `${k} is masked`);
  assert.equal(maskEntry({ pinhashes: 4711 }).pinhashes, 4711, 'a number under a plural stays: it is a count');
  for (const k of ['pins', 'spins', 'hairpins', 'kingpins', 'pushpins', 'pines', 'pinned', 'spinhashes', 'spin_hashes']) assert.ok(!masked(k), `${k} stays free`);
});

test('reflector (ps1): the helper gets root and transcript as separate arguments; a trailing separator is cut off the root', () => {
  const ps = fs.readFileSync(path.join(REPO, 'bin', 'mem-reflect.ps1'), 'utf8');
  const call = ps.split('\n').find((l) => l.includes('mem-mask-copy') === false && /& node \$maskScript --root/.test(l));
  assert.ok(call, 'the call is there');
  assert.match(call, /& node \$maskScript --root \$rootArg \$transcriptPath /, 'plain variables, one argument each');
  assert.ok(!/["'`]/.test(call.split('&')[1].split('2>')[0]), 'no quote and no string built around the arguments');
  const m = /\$rootArg = \$env:CHEAP_MEM_ROOT\n\$rootTrim = \$rootArg\.TrimEnd\('\\', '\/'\)\nif \(\$rootTrim -and \$rootTrim -notmatch '([^']+)'\) \{ \$rootArg = \$rootTrim \}/.exec(ps);
  assert.ok(m, 'the root is trimmed in this shape');
  // the drive pattern of the script, read as a JS regex (same syntax for this pattern): a drive root in any spelling stays
  const drive = new RegExp(m[1]);
  const prepared = (root) => { const t = root.replace(/[\\/]+$/, ''); return t && !drive.test(t) ? t : root; };
  for (const r of ['C:\\', 'C:/', 'c:\\\\', 'D:', '\\\\?\\C:\\', '\\\\.\\D:\\']) assert.equal(prepared(r), r, `drive root ${r} stays`);
  assert.equal(prepared('C:\\My Mem\\'), 'C:\\My Mem');
  assert.equal(prepared('\\\\srv\\my share\\'), '\\\\srv\\my share');
  assert.equal(prepared('/home/me/mem/'), '/home/me/mem');
  assert.ok(!/Invoke-Expression|Start-Process/.test(ps), 'no string-built command line anywhere');
  assert.ok(ps.indexOf('$rootArg = ') < ps.indexOf('& node $maskScript --root'), 'the root is prepared before the call');
});

test('bin/mem-mask-copy: a root and a transcript whose paths hold a space and an apostrophe arrive whole', () => {
  const base = scratch();
  try {
    const root = path.join(base, "my mem it's");
    const sub = path.join(base, "tr dir it's");
    fs.mkdirSync(root);
    fs.mkdirSync(sub);
    const t = path.join(sub, "ses sion's.jsonl");
    fs.writeFileSync(t, `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`);
    const made = spawnSync(process.execPath, [MASK, '--root', root, t], { encoding: 'utf8', env: OWN_ENV });
    assert.equal(made.status, 0, made.stderr);
    const copy = made.stdout.trim();
    assert.match(fs.readFileSync(copy, 'utf8'), /hello/);
    spawnSync(process.execPath, [MASK, '--clean', copy], { encoding: 'utf8', env: OWN_ENV });
    // a root with a trailing separator is the same root: a temp dir inside it is still refused
    const inside = path.join(root, 'tmp');
    fs.mkdirSync(inside);
    const refused = spawnSync(process.execPath, [MASK, '--root', `${root}${path.sep}`, t], { encoding: 'utf8', env: { ...OWN_ENV, TMPDIR: inside, TEMP: inside, TMP: inside } });
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, '');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
