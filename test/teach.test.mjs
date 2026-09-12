import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, short, collect, asText } from '../src/teach.mjs';

test('without a derivation it stays empty and says so', () => {
  const r = collect('/whatever', {});
  for (const s of SECTIONS) assert.deepEqual(r.sections[s], []);
  assert.equal(r.missing.length, 2);
  const t = asText(r);
  assert.match(t, /without experiences\(\)/);
  assert.match(t, /without readLog\(\)/);
  assert.match(t, /which means empty, not "fine"/);
});

test('the three strength grades come from ONE derivation', () => {
  const r = collect('/whatever', {
    experiences: () => [
      { id: 'a', title: 'cited and quiet', cited: 3, contested: false },
      { id: 'b', title: 'nothing on it yet', cited: 0, contested: false },
      { id: 'c', title: 'someone disagrees', cited: 5, contested: true },
    ],
  });
  assert.deepEqual(r.sections.established.map((x) => x.id), ['a']);
  assert.deepEqual(r.sections.tentative.map((x) => x.id), ['b']);
  assert.deepEqual(r.sections.contested.map((x) => x.id), ['c']);
});

test('contested beats cited — even at high citation', () => {
  const r = collect('/whatever', {
    experiences: () => [{ id: 'c', title: 'x', cited: 99, contested: true }],
  });
  assert.equal(r.sections.established.length, 0);
  assert.equal(r.sections.contested.length, 1);
});

test('a dead end is an error that has a learning on it', () => {
  const books = {
    error: [{ id: 'f1', title: 'path with spaces', class: 'quoting' },
      { id: 'f2', title: 'nobody learned from this' }],
    learning: [{ id: 'l1', title: 'always quote', provenance: { derived_from: ['f1'] } }],
  };
  const r = collect('/whatever', {
    TYPES: { error: 1, learning: 1 },
    readLog: (root, type) => ({ entries: books[type] ?? [] }),
    holds: () => true,
  });
  assert.deepEqual(r.sections.deadends.map((x) => x.id), ['f1']);
  assert.equal(r.sections.deadends[0].class, 'quoting');
});

test('a correction is counted, not skipped', () => {
  const entries = [{ id: 'old' }, { id: 'new', replaces_id: 'old' }];
  const retired = new Map([['old', { by: 'new' }]]);
  const r = collect('/whatever', {
    TYPES: { error: 1 },
    readLog: () => ({ entries }),
    retiredMap: () => retired,
    holds: (e, m) => !(e.id && m?.has(e.id)),
  });
  assert.deepEqual(r.sections.corrections, [{ id: 'old', text: 'old', by: 'new' }]);
});

test('the same result twice, whatever the read order', () => {
  const raw = [
    { id: 'a', title: 'A', cited: 1, contested: false },
    { id: 'b', title: 'B', cited: 1, contested: false },
    { id: 'c', title: 'C', cited: 1, contested: false },
  ];
  assert.deepEqual(collect('/w', { experiences: () => raw }),
    collect('/w', { experiences: () => [...raw].reverse() }));
});

test('there is no half-life factor on age', () => {
  const older = { id: 'a', title: 'old', ts: '2020-01-01T00:00:00Z', cited: 1, contested: false };
  const newer = { id: 'b', title: 'new', ts: '2026-09-12T00:00:00Z', cited: 1, contested: false };
  const r = collect('/w', { experiences: () => [older, newer] });
  assert.equal(r.sections.established.length, 2, 'age weighed something away');
});

test('project filtering computes nothing new', () => {
  const r = collect('/w', {
    project: 'alpha',
    experiences: () => [
      { id: 'a', title: 'A', _project: 'alpha', cited: 1 },
      { id: 'b', title: 'B', _project: 'beta', cited: 1 },
    ],
  });
  assert.deepEqual(r.sections.established.map((x) => x.id), ['a']);
});

test('short(): title before text, and never both', () => {
  assert.equal(short({ title: 'T', text: 'X' }), 'T');
  assert.equal(short({ text: 'X' }), 'X');
  assert.equal(short({ choice: 'C', text: 'X' }), 'C');
  assert.equal(short({ id: 'just-id' }), 'just-id');
  assert.equal(short({ title: 'a'.repeat(200) }).length, 110);
});

test('short() folds line breaks into one line', () => {
  assert.equal(short({ title: 'first\n  second' }), 'first second');
});

test('the section order is fixed and closed', () => {
  assert.deepEqual([...SECTIONS],
    ['established', 'tentative', 'contested', 'deadends', 'corrections']);
});
