// Parity with lucky-mem (2026-10-01): the digest prompt step 3 makes --asked
// LATER QUESTIONS in other words than the title. Three promises: other words
// than the title, at most six, no time words. Red proof against the PINNED
// start commit d302da33b373e424b8acbd3d473f9ec4ff139c74.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = 'd302da33b373e424b8acbd3d473f9ec4ff139c74';
const old = execFileSync('git', ['-C', ROOT, 'show', `${START}:bin/mem-digest`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const cur = fs.readFileSync(path.join(ROOT, 'bin/mem-digest'), 'utf8');
const step3 = (t) => {
  const a = t.indexOf('3. Sort into drawers');
  const b = t.indexOf('4. Close any duty');
  assert.ok(a > 0 && b > a, 'step 3 found');
  return t.slice(a, b);
};
const promises = (s) => {
  const flat = s.replace(/\s+/g, ' ');
  return {
    otherWords: /LATER ask with, in other words than the title/.test(flat),
    six: /3-6 phrasings/.test(flat) && /at most six/.test(flat) && !/at most five/.test(flat),
    noTime: /no time words \(today, yesterday, a date\)/.test(flat),
  };
};

test('digest prompt step 3: the three promises are present', () => {
  assert.deepEqual(promises(step3(cur)), { otherWords: true, six: true, noTime: true });
});

test('red proof: pinned start commit has none of the three promises', () => {
  assert.deepEqual(promises(step3(old)), { otherWords: false, six: false, noTime: false });
  const flat = step3(old).replace(/\s+/g, ' ');
  assert.ok(/3-5 words someone would ASK with/.test(flat) && /at most five/.test(flat), 'positive control: the probe reads the old wording');
});

test('no other place still states the old limit', () => {
  assert.ok(!/--asked[^\n]{0,80}3-5/.test(cur));
});

test('bin/mem-digest stays syntactically valid', () => {
  execFileSync('bash', ['-n', path.join(ROOT, 'bin/mem-digest')]);
});
