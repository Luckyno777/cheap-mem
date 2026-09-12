import test from 'node:test';
import assert from 'node:assert/strict';
import { LINK_KINDS, linksOf, build, layers, asText } from '../src/net.mjs';

const body = (list) => ({ readAll: () => list });

test('no link is invented from similarity', () => {
  const n = build(body([
    { project: 'p', drawer: 'error', entry: { id: 'a', tags: ['x'], text: 'tunnel broken' } },
    { project: 'p', drawer: 'learning', entry: { id: 'b', tags: ['x'], text: 'tunnel broken' } },
  ]));
  assert.equal(n.links, 0);
  assert.equal(n.pairs.length, 0);
});

test('the layout is the same twice, even with reversed input', () => {
  const entries = [
    { project: 'p', drawer: 'learning', entry: { id: 'l1', provenance: { derived_from: ['f1'] } } },
    { project: 'p', drawer: 'error', entry: { id: 'f1' } },
    { project: 'p', drawer: 'learning', entry: { id: 'l2', provenance: { derived_from: ['f2'] } } },
    { project: 'p', drawer: 'error', entry: { id: 'f2' } },
  ];
  assert.deepEqual(layers(build(body(entries))), layers(build(body([...entries].reverse()))));
});

test('what points at others stands on top', () => {
  const n = build(body([
    { project: 'p', drawer: 'learning', entry: { id: 'l1', provenance: { derived_from: ['f1'] } } },
    { project: 'p', drawer: 'error', entry: { id: 'f1' } },
  ]));
  const l = layers(n);
  const level = (name) => l.assignment.find((x) => x.name === name)?.level;
  assert.equal(level('p/learning'), 0);
  assert.equal(level('p/error'), 1);
});

test('a cycle is reported, not cut', () => {
  const n = build(body([
    { project: 'p', drawer: 'a', entry: { id: 'x', provenance: { derived_from: ['y'] } } },
    { project: 'p', drawer: 'b', entry: { id: 'y', provenance: { derived_from: ['x'] } } },
  ]));
  const l = layers(n);
  assert.deepEqual(l.in_cycle, ['p/a', 'p/b']);
  assert.equal(l.assignment.length, 0, 'the cycle was cut');
  assert.match(asText(n), /in a cycle/);
});

test('a box without any link is unconnected, not "on top"', () => {
  const n = build(body([
    { project: 'p', drawer: 'learning', entry: { id: 'l1', provenance: { derived_from: ['f1'] } } },
    { project: 'p', drawer: 'error', entry: { id: 'f1' } },
    { project: 'p', drawer: 'lonely', entry: { id: 'e1', text: 'hangs on nothing' } },
  ]));
  const l = layers(n);
  assert.deepEqual(l.unlinked, ['p/lonely']);
  assert.ok(!l.assignment.some((x) => x.name === 'p/lonely'));
  assert.match(asText(n), /not "on top", but unconnected/);
});

test('a dangling link is counted, not swallowed', () => {
  const n = build(body([
    { project: 'p', drawer: 'learning', entry: { id: 'l1', provenance: { derived_from: ['gone'] } } },
  ]));
  assert.equal(n.dangling, 1);
  assert.equal(n.links, 0);
  assert.match(asText(n), /point out of the body/);
});

test('only declared kinds count — an invented one does not', () => {
  assert.deepEqual(linksOf({ id: 'a', kind: 'resembles', from: 'a', to: 'b' }), []);
  assert.equal(linksOf({ id: 'a', kind: 'contradicts', from: 'a', to: 'b' }).length, 1);
  assert.ok(LINK_KINDS.includes('contradicts'));
});

test('all four pointer fields are read', () => {
  assert.equal(linksOf({ id: 'a', replaces_id: 'b' })[0].kind, 'replaces');
  assert.equal(linksOf({ id: 'a', closes_id: 'b' })[0].kind, 'closes');
  assert.equal(linksOf({ id: 'a', retires_id: 'b' })[0].kind, 'closes');
  assert.equal(linksOf({ id: 'a', provenance: { inferred_from: ['b'] } })[0].kind, 'derived_from');
});

test('an entry without an id carries no links', () => {
  assert.deepEqual(linksOf({ replaces_id: 'b' }), []);
  assert.deepEqual(linksOf(null), []);
});

test('self-reference is its own statement, not a layer', () => {
  const n = build(body([
    { project: 'p', drawer: 'duty', entry: { id: 'p1' } },
    { project: 'p', drawer: 'duty', entry: { id: 'p2', closes_id: 'p1' } },
  ]));
  assert.deepEqual(layers(n).self_reference, ['p/duty']);
  assert.equal(n.pairs[0].from, n.pairs[0].to);
});

test('pairs carry the kinds, not just the count', () => {
  const n = build(body([
    { project: 'p', drawer: 'learning', entry: { id: 'l1', provenance: { derived_from: ['f1'] } } },
    { project: 'p', drawer: 'learning', entry: { id: 'l2', kind: 'causes', from: 'l2', to: 'f1' } },
    { project: 'p', drawer: 'error', entry: { id: 'f1' } },
  ]));
  const p = n.pairs.find((x) => x.from === 'p/learning' && x.to === 'p/error');
  assert.equal(p.count, 2);
  assert.deepEqual(p.kinds, { derived_from: 1, causes: 1 });
});
