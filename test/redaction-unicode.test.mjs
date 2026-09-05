// Regression for the U+FF1D bypass measured 2026-09-05: a secret written
// with a fullwidth equals sign passed redaction, reached disk, and passed
// the pre-commit hook. The assignment patterns hang on [:=] and \s, so
// every look-alike of those two is a bypass until proven otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, SEP, SP } from '../src/redaction.mjs';

// Built from parts so this file does not trip the pre-commit hook itself.
const NAME = 'AWS_SECRET' + '_ACCESS_KEY';
const VALUE = 'wJalrXUtnFEMI' + 'K7MDENGbPxRfiCYEXAMPLEKEY';

const SEPARATORS = [
  ['ascii equals', '='],
  ['ascii colon', ':'],
  ['fullwidth equals U+FF1D', '＝'],
  ['fullwidth colon U+FF1A', '：'],
  ['ratio U+2236', '∶'],
  ['modifier colon U+02D0', 'ː'],
  ['two dot punctuation U+205D', '⁝'],
];

const SPACES = [
  ['plain space', ' '],
  ['no-break space U+00A0', ' '],
  ['en quad U+2000', ' '],
  ['zero width space U+200B', '​'],
  ['narrow no-break U+202F', ' '],
  ['ideographic space U+3000', '　'],
  ['BOM U+FEFF', '﻿'],
];

test('every separator look-alike is still redacted', () => {
  for (const [label, sep] of SEPARATORS) {
    const r = redact(`export ${NAME}${sep}${VALUE}`);
    assert.equal(r.found.length, 1, `${label} slipped through`);
    assert.ok(!r.text.includes(VALUE), `${label} left the value in the output`);
  }
});

test('padding the separator with any space look-alike does not help', () => {
  for (const [label, sp] of SPACES) {
    const r = redact(`export ${NAME}${sp}=${sp}${VALUE}`);
    assert.equal(r.found.length, 1, `${label} slipped through`);
    assert.ok(!r.text.includes(VALUE), `${label} left the value in the output`);
  }
});

test('a zero-width character inside the value does not hide it', () => {
  const split = `${VALUE.slice(0, 5)}​${VALUE.slice(5)}`;
  const r = redact(`export ${NAME}=${split}`);
  assert.equal(r.found.length, 1);
});

test('the json form is covered too', () => {
  const r = redact(`{"password"："${VALUE}"}`);
  assert.equal(r.found.length, 1);
  assert.ok(!r.text.includes(VALUE));
});

test('redaction does not rewrite text that merely contains fullwidth characters', () => {
  // The fix widens the pattern rather than normalising the text, precisely
  // so that legitimate content survives byte for byte.
  const prose = 'Der Preis betraegt １２３ Yen　und das ist voellig in Ordnung.';
  const r = redact(prose);
  assert.equal(r.text, prose);
  assert.equal(r.found.length, 0);
});

test('SEP and SP are exported so the pre-commit hook can share them', () => {
  assert.ok(new RegExp(SEP).test('＝'));
  assert.ok(new RegExp(SP).test('　'));
});
