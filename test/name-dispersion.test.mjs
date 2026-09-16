// Checks the premise of a work order before anything gets built.
//
// From "845 tag values, 475 used once" the conclusion was drawn to
// build an alias table. The measurement says: 20 to 24 of those 845
// are spelling variants, about 2.5 %. The dispersion sits in the
// vocabulary, not in the spelling.
//
// These tests hold the measurement to what it claims — a too-coarse
// normalisation would make the saving look large while merging things
// that genuinely differ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise, wordSet, values, dispersion } from '../bench/name-dispersion.mjs';

test('real spelling variants collapse', () => {
  assert.equal(normalise('hooks'), normalise('hook'));
  assert.equal(normalise('tools'), normalise('tool'));
  assert.equal(wordSet('error-hook'), wordSet('hook-error'));
});

test('different words do NOT collapse', () => {
  // The more important half. A normalisation that merges "statistics"
  // and "stack" reports a saving that is not there, and justifies a
  // table that does harm.
  const different = ['metrics', 'noise', 'statistics', 'optimisation',
    'diversity', 'gold', 'authority', 'provenance', 'mandate', 'ergonomics'];
  assert.equal(new Set(different.map(normalise)).size, different.length,
    'two different words were merged');
  assert.equal(new Set(different.map(wordSet)).size, different.length);
});

test('two procedures, similar answer', () => {
  // If only one holds, the number is an artefact of the procedure.
  const counter = new Map([['hook', 21], ['hooks', 12], ['metrics', 1],
    ['noise', 1], ['statistics', 1], ['test', 12], ['tests', 3]]);
  const d = dispersion({ counter });
  assert.equal(d.distinct, 7);
  assert.ok(Math.abs(d.variantsNormalise - d.variantsWordSet) <= 1,
    `the procedures diverge: ${d.variantsNormalise} vs ${d.variantsWordSet}`);
  assert.equal(d.variantsNormalise, 2, 'hook/hooks and test/tests, nothing else');
});

test('an absent store is not a pass', () => {
  const v = values('/does/not/exist', 'tags');
  assert.equal(v.counter.size, 0);
  assert.equal(v.entries, 0);
});
