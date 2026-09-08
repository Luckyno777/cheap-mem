// The vocabulary has to hold together, or the counting means nothing.
//
// These probes are built around the ways a closed vocabulary decays:
// an alias pointing at a class that no longer exists, an alias that
// shadows a real name, a normalise() that starts guessing, and a
// coverage() that hides what it could not map.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ec from '../src/errorclass.mjs';

test('every alias points at a class that exists', () => {
  for (const [from, to] of Object.entries(ec.ALIAS)) {
    assert.ok(ec.valid(to), `alias '${from}' -> '${to}', which is not a class`);
  }
});

test('no alias shadows a real class name', () => {
  // An alias with the same name as a class is dead weight at best and a
  // silent redirect at worst — `valid()` answers first, so the alias
  // never fires and nobody would notice it points somewhere else.
  for (const from of Object.keys(ec.ALIAS)) {
    assert.equal(ec.valid(from), false, `'${from}' is both a class and an alias`);
  }
});

test('every class has a short line and a falsifying question', () => {
  for (const n of ec.NAMES) {
    assert.ok(ec.CLASSES[n].short.length > 10, n);
    assert.ok(ec.CLASSES[n].question.endsWith('?'), `${n}: the question is not one`);
  }
});

test('normalise never guesses', () => {
  // The whole point. A near miss must come back null, not the closest
  // string — fuzzy matching is the convenience that produced 212
  // classes in the sibling project.
  assert.equal(ec.normalise('looks-right-does-nothin'), null);
  assert.equal(ec.normalise('silent'), null);
  assert.equal(ec.normalise('LOOKS-RIGHT-DOES-NOTHING'), null);
  assert.equal(ec.normalise(''), null);
  assert.equal(ec.normalise(undefined), null);
});

test('an alias resolves, but is not valid for new entries', () => {
  assert.equal(ec.normalise('silent-failure'), 'looks-right-does-nothing');
  assert.equal(ec.valid('silent-failure'), false);
});

test('normalise is not fooled by a prototype key', () => {
  // `ALIAS[n]` on a plain lookup would answer for 'constructor' and
  // 'toString'. A class name that resolves to a function is the sort of
  // thing that surfaces as a crash three commands later.
  assert.equal(ec.normalise('constructor'), null);
  assert.equal(ec.normalise('toString'), null);
  assert.equal(ec.normalise('__proto__'), null);
});

test('coverage counts the unmapped instead of bucketing them', () => {
  const entries = [
    { class: 'looks-right-does-nothing' },
    { class: 'silent-failure' },        // alias -> same class
    { class: 'something-nobody-defined' },
    { class: 'something-nobody-defined' },
    { },                                 // no class at all
  ];
  const c = ec.coverage(entries);
  assert.equal(c.total, 5);
  assert.equal(c.mapped, 2);
  assert.equal(c.open, 3);
  assert.deepEqual(c.byClass, [['looks-right-does-nothing', 2]]);
  // The unmapped names stay NAMED. A catch-all "other" class would make
  // the open number disappear, and that number is what says how far the
  // ranking may be trusted.
  assert.deepEqual(c.openNames, [['something-nobody-defined', 2], ['(none)', 1]]);
});

test('coverage on nothing is zero, not a crash', () => {
  for (const input of [[], null, undefined]) {
    const c = ec.coverage(input);
    assert.equal(c.total, 0);
    assert.equal(c.mapped, 0);
    assert.equal(c.open, 0);
  }
});

test('help prints one block per class, question included', () => {
  const h = ec.help();
  assert.equal(h.length, ec.NAMES.length);
  for (const block of h) assert.match(block, /\n {6}\? .+\?$/);
});
