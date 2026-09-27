// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/errorsignature.test.mjs — the exact, line-anchored check behind
// bin/mem-catch-fail's cheap bash sieve (M19 port from lucky-mem).
import test from 'node:test';
import assert from 'node:assert/strict';
import { errorSignature, bashOutput } from '../src/errorsignature.mjs';

test('# fail 0 is NOT a failure, # fail N>0 is', () => {
  assert.equal(errorSignature('# tests 5\n# pass 5\n# fail 0'), null);
  assert.equal(errorSignature('ℹ fail 0'), null);
  assert.equal(errorSignature('# fail 00'), null);
  assert.match(errorSignature('# fail 3'), /fail 3/);
  assert.match(errorSignature('ℹ fail 12'), /fail 12/);
});

test('the five signatures, each at the start of its own line', () => {
  for (const line of ['not ok 3 - x', '    not ok 1 - nested', 'Error: ENOENT',
    'TypeError: x is not a function', 'FAIL src/a.test.js', 'fatal: not a git repository']) {
    assert.ok(errorSignature(`before\n${line}\nafter`), `not recognised: ${line}`);
  }
});

test('false-alarm zero on harmless output', () => {
  const harmless = [
    'ok 1 - not ok is just a test name here',
    'not ok 4 - later # TODO not built yet',
    'not ok 5 - platform # SKIP windows only',
    'src/hook.mjs:12:    j?.error,   // Error: sits mid-line',
    '  throw new Error("x")',
    'const t = "fatal: sits in source text";',
    'all good, 0 failures',
    'FAILED_COUNT=0',
  ].join('\n');
  assert.equal(errorSignature(harmless), null);
});

test('errorSignature caps how many lines and how wide each one is', () => {
  const many = Array.from({ length: 12 }, (_, i) => `not ok ${i} - x`).join('\n');
  const sig = errorSignature(many, { max: 3 });
  assert.equal(sig.split('\n').length, 3);
  const wide = errorSignature(`fatal: ${'x'.repeat(500)}`, { width: 20 });
  assert.equal(wide.length, 20);
});

test('bashOutput joins stdout+stderr, accepts a string response, and is empty otherwise', () => {
  assert.equal(bashOutput({ stdout: 'a', stderr: 'b' }), 'a\nb');
  assert.equal(bashOutput({ stdout: '', stderr: 'fatal: x' }), 'fatal: x');
  assert.equal(bashOutput('plain string response'), 'plain string response');
  assert.equal(bashOutput(null), '');
  assert.equal(bashOutput(42), '');
});
