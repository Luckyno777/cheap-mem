// test/errorfile.test.mjs — F4 (BAUPLAN-mem-admin_02.md Block F, ported
// from lucky-mem/src/fehlerdatei.mjs): the ONE answer to "which file
// does this error concern".
import test from 'node:test';
import assert from 'node:assert/strict';
import * as errorfile from '../src/errorfile.mjs';

test('an explicit `file` field wins outright', () => {
  assert.deepEqual(errorfile.files({ file: 'src/boiler.mjs', text: 'mentions src/other.mjs too' }),
    ['src/boiler.mjs']);
});

test('an explicit `files` array wins outright, deduplicated', () => {
  assert.deepEqual(
    errorfile.files({ files: ['src/a.mjs', 'src/a.mjs', 'src/b.mjs'] }),
    ['src/a.mjs', 'src/b.mjs']);
});

test('with no explicit field, the path pattern applies to the whole entry', () => {
  assert.deepEqual(errorfile.files({ title: 'boom', text: 'found in src/boiler.mjs' }),
    ['src/boiler.mjs']);
});

test('POSITIVE CONTROL: a URL is not read as a path mention', () => {
  // pathcheck.mjs's own look-behind guard, inherited here rather than
  // reinvented — the exact trap named in src/errorfile.mjs's header.
  assert.deepEqual(
    errorfile.files({ text: 'see https://example.org/src/foreign.mjs for context' }), []);
});

test('an error with no determinable file is [] / null, not a guess', () => {
  assert.deepEqual(errorfile.files({ class: 'concurrency', title: 'two writers raced', text: 'no path here' }), []);
  assert.equal(errorfile.file({ class: 'concurrency', title: 'raced' }), null);
});

test('at most MAX_FILES files, explicit or pattern-derived', () => {
  const many = Array.from({ length: 10 }, (_, i) => `src/f${i}.mjs`);
  assert.equal(errorfile.files({ files: many }).length, errorfile.MAX_FILES);
  const text = many.map((f) => `mentions ${f}`).join(' ');
  assert.equal(errorfile.files({ text }).length, errorfile.MAX_FILES);
});

test('file() returns the first of files(), or null on an empty entry', () => {
  assert.equal(errorfile.file({ file: 'src/x.mjs' }), 'src/x.mjs');
  assert.equal(errorfile.file({}), null);
  assert.equal(errorfile.file(null), null);
});

test('SABOTAGE: an entry that is not an object never throws', () => {
  assert.deepEqual(errorfile.files(null), []);
  assert.deepEqual(errorfile.files(undefined), []);
  assert.deepEqual(errorfile.files('a string'), []);
});
