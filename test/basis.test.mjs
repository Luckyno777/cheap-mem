import test from 'node:test';
import assert from 'node:assert/strict';
import { BASIS, markOf, mayReplace, set, defects, asMark, overview } from '../src/basis.mjs';

test('first-hand is not overwritten', () => {
  assert.equal(mayReplace(BASIS.STATED, BASIS.INFERRED), false);
  assert.equal(mayReplace(BASIS.STATED, BASIS.GUESSED), false);
  assert.equal(mayReplace(BASIS.MEASURED, BASIS.INFERRED), false);
  assert.equal(mayReplace(BASIS.MEASURED, BASIS.GUESSED), false);
});

test('a measurement does not replace a statement — it stands beside it', () => {
  assert.equal(mayReplace(BASIS.STATED, BASIS.MEASURED), false);
  assert.equal(mayReplace(BASIS.MEASURED, BASIS.STATED), false);
  assert.equal(mayReplace(BASIS.STATED, BASIS.STATED), true);
});

test('second-hand may be overwritten', () => {
  assert.equal(mayReplace(BASIS.GUESSED, BASIS.MEASURED), true);
  assert.equal(mayReplace(BASIS.INFERRED, BASIS.STATED), true);
  assert.equal(mayReplace(null, BASIS.INFERRED), true);
});

test('set() leaves a stated mark alone', () => {
  const e = { id: 'a', basis: BASIS.STATED, text: 'timezone Europe/Berlin' };
  const n = set(e, BASIS.GUESSED);
  assert.equal(n.basis, BASIS.STATED);
  assert.equal(n, e, 'an unnecessary copy was made');
});

test('without a mark none is invented', () => {
  assert.equal(markOf({ id: 'a', text: 'x' }), null);
  assert.equal(markOf({ basis: 'pretty sure' }), null, 'free text got through');
  assert.equal(markOf(null), null);
  assert.equal(asMark({ id: 'a' }), '');
});

test('a mark without evidence is a defect', () => {
  assert.deepEqual(defects({ basis: BASIS.INFERRED }),
    ['inferred without provenance.derived_from — concluded from WHAT?']);
  assert.deepEqual(defects({ basis: BASIS.INFERRED, provenance: { derived_from: ['x1'] } }), []);
  assert.equal(defects({ basis: BASIS.MEASURED, text: 'fast' }).length, 1);
  assert.equal(defects({ basis: BASIS.MEASURED, text: '299 ms' }).length, 0);
  assert.equal(defects({ basis: BASIS.GUESSED }).length, 1);
  assert.equal(defects({ basis: BASIS.GUESSED, what_is_missing: 'check on the host' }).length, 0);
});

test('an entry without a mark has no defects either', () => {
  assert.deepEqual(defects({ id: 'a', text: 'x' }), []);
});

test('GUESSED is written loudly, the rest quietly', () => {
  assert.equal(asMark({ basis: BASIS.GUESSED }), '[GUESSED]');
  assert.equal(asMark({ basis: BASIS.MEASURED }), '[measured]');
});

test('there is no confidence number, and that is deliberate', () => {
  for (const b of Object.values(BASIS)) assert.equal(typeof b, 'string');
  assert.equal(Object.values(BASIS).some((b) => /\d/.test(b)), false);
});

test('overview counts the unmarked separately', () => {
  const o = overview([
    { basis: BASIS.STATED }, { basis: BASIS.GUESSED, what_is_missing: 'x' },
    { id: 'c' }, { id: 'd', basis: BASIS.INFERRED },
  ]);
  assert.equal(o.count.stated, 1);
  assert.equal(o.count.without, 1);
  assert.equal(o.defects.length, 1);
  assert.equal(o.defects[0].id, 'd');
});
