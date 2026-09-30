// G1b (C): a KNOWN GAP in the gold set is reported on its own line, not
// counted as a failure of its category — and not hidden either.
//
// time-08 (an unlinked newer decision without topic) has no ranking rule
// by design; it is addressed in the write path. Counted in `temporal` it
// kept that category permanently one short, so a real regression there
// read as "it was already red". The case itself stays unchanged; an
// appended marker line carries the reason (the set is append-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, loadWorld, checkSet, summarise, compareSides } from '../bench/gold-compare.mjs';

test('time-08 is loaded as a known gap, with its reason; the case itself is unchanged', () => {
  const cases = loadCases();
  const t8 = cases.find((c) => c.id === 'time-08');
  assert.ok(t8, 'time-08 vanished from the set');
  assert.match(t8.gap ?? '', /no ranking rule by design/);
  assert.deepEqual(t8.expected, ['g-css-new']);
  assert.deepEqual(t8.forbidden, ['g-css-old']);
  // The marker line is not a case of its own.
  assert.ok(!cases.some((c) => c.gap_of), 'a gap marker was loaded as a case');
  assert.deepEqual(checkSet(cases, loadWorld()), []);
});

test('the M9 twin of time-08 exists: shared topic + state word', () => {
  const t9 = loadCases().find((c) => c.id === 'time-09');
  assert.ok(t9 && t9.category === 'temporal' && !t9.gap);
  assert.match(t9.query, /\bcurrently\b/);
  const world = loadWorld();
  const topics = ['g-apidocs-old', 'g-apidocs-new'].map((id) => world.entries.find((e) => e.data?.id === id)?.data?.topic);
  assert.ok(topics[0] && topics[0] === topics[1], `the two decisions must share a topic: ${topics}`);
});

test('summary and verdict leave known gaps out; a gap flip is still reported', () => {
  const r = (id, state, gap) => ({ id, category: 'temporal', state, ...(gap ? { gap } : {}) });
  const base = [r('a', 'pass'), r('g', 'fail', 'by design')];
  const head = [r('a', 'pass'), r('g', 'pass', 'by design')];
  const s = summarise(base);
  assert.equal(s.byCategory.temporal.n, 1, 'the gap was counted in its category');
  assert.equal(s.total.fail, 0, 'the gap was counted in the total');
  assert.equal(s.gaps.fail, 1, 'the gap vanished instead of standing on its own line');
  const cmp = compareSides(base, head);
  assert.equal(cmp.byCategory.temporal, 'same', 'a gap moved the category verdict');
  assert.deepEqual(cmp.gapFlips, [{ id: 'g', category: 'temporal', from: 'fail', to: 'pass' }]);
  // Positive control: the same flip WITHOUT the gap marker does move it.
  assert.equal(compareSides([r('a', 'pass'), r('g', 'fail')], [r('a', 'pass'), r('g', 'pass')]).byCategory.temporal, 'better');
});

test('guard: a gap marker for a case that does not exist is a defect of the set', () => {
  const cases = loadCases();
  const probe = Object.assign([...cases], { orphanGaps: ['no-such-case'] });
  assert.ok(checkSet(probe, loadWorld()).some((p) => p.includes("'no-such-case'")));
});
