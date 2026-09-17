// The same data must give the same order — on every machine.
//
// **The finding, 2026-09-17.** `test/raw-stats.test.mjs` failed on the
// macOS runners and nowhere else, twice, on two different node
// versions. Each time the BASELINE list differed from the previous run
// too, so what moved was not the thing under test but the yardstick.
//
// Measured cause: six fixture entries score exactly the same, to the
// last bit — 1.6907827160660296, all six. Their order was decided by
// nothing but sort stability and, inside MMR, by which of two
// floating-point values happened to come out larger. `Math.log` and
// friends may differ by one unit in the last place between platforms,
// and one ULP is enough to flip that comparison.
//
// For a memory whose claim is "the same data gives the same answer",
// an order that depends on the C library is a defect.
//
// **What these probes do NOT do:** they cannot run macOS maths here.
// They simulate the only thing that matters about it — a similarity
// function whose last bit differs — and assert the order does not
// move. That is the mechanism, reproduced, not the platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as search from '../src/search.mjs';

/** Candidates that are exactly tied, as the real corpus produces them. */
function tied(n = 6) {
  return Array.from({ length: n }, (_, i) => ({
    score: 1.6907827160660296,
    source: 'global/decisions.jsonl',
    line: n - i,                       // deliberately NOT in key order
    entry: { id: `TIE-${i}` },
    __w: new Map([['ablage', 1], [`wort${i}`, 1]]),
  }));
}

test('exactly tied hits sort into ONE order, whatever order they arrive in', () => {
  const a = tied().sort(search.byScoreThenIdentity).map((h) => h.entry.id);
  const b = tied().reverse().sort(search.byScoreThenIdentity).map((h) => h.entry.id);
  assert.deepEqual(b, a, 'the same tied hits sorted into two different orders');
  // And it is a real order, not just a stable accident: the key decides.
  assert.deepEqual(a, ['TIE-5', 'TIE-4', 'TIE-3', 'TIE-2', 'TIE-1', 'TIE-0'],
    'ties are not ordered by their identity key');
});

test('ONE ULP in the similarity does not move the MMR result', () => {
  // **This probe took four attempts, and three of them measured
  // nothing.** Worth writing down, because each failure was a
  // different way to be green for the wrong reason:
  //
  //  1. Perturbing the similarity "somewhere" never reaches MMR's
  //     comparison: on the FIRST pick nothing is selected yet, every
  //     maxSim is 0, and the values are exactly equal regardless.
  //  2. Perturbing from the second pick on, but in the same direction
  //     the identity key would have chosen anyway — both mechanisms
  //     agreed, so removing one changed nothing.
  //
  // So the perturbation has to push AGAINST the key. Then, and only
  // then, does the run show which mechanism decided.
  const c = tied(3);
  const key = (h) => h.entry.id;
  const [erst, zweiter] = c.slice().sort(search.byScoreThenIdentity);

  const genau = (a, b) => (a === b ? 1 : 0.5);
  // `zweiter` is the one the key picks next. Give exactly IT the higher
  // similarity, so a raw value comparison would drop it in favour of
  // the other — one unit in the last place is all it takes.
  const einUlpDaneben = (a, b) => {
    if (a === b) return 1;
    // **A full Number.EPSILON, not half of it — measured, not assumed.**
    // `Number.EPSILON * 0.5` (one ULP at 0.5) does produce a different
    // double, but `0.7 - 0.3 * it` rounds back to the same value:
    // 0.5499999999999999 either way. The perturbation vanished inside
    // the arithmetic, and the probe was green without measuring
    // anything. A full EPSILON survives.
    return a === zweiter ? 0.5 + Number.EPSILON : 0.5;
  };

  const lauf = (simOf) => search
    .mmrRerank(c.slice(), { lambda: 0.7, top: 3, simOf }).map(key);

  const a = lauf(genau);
  const b = lauf(einUlpDaneben);
  assert.equal(a[1], key(zweiter), 'the fixture does not do what it claims');
  assert.deepEqual(b, a,
    `one ULP changed the order:\n  exact: ${a.join(' ')}\n  +1ulp: ${b.join(' ')}`);
});

test('a REAL difference in similarity still decides — the threshold is no blanket', () => {
  // A tie-break that swallows genuine differences would be worse than
  // the bug it fixes: MMR exists to prefer the DIFFERENT candidate, and
  // a threshold wide enough to call everything equal turns it off while
  // leaving it looking switched on.
  const c = tied(3);
  const key = (h) => h.entry.id;
  const [erst, zweiter, dritter] = c.slice().sort(search.byScoreThenIdentity);

  // `dritter` is the one the key would take LAST — and the one that is
  // clearly least similar to the first pick. MMR must take it second.
  const simOf = (a, b) => {
    if (a === b) return 1;
    return a === dritter ? 0.05 : 0.95;
  };

  const rang = search.mmrRerank(c.slice(), { lambda: 0.7, top: 3, simOf }).map(key);
  assert.notEqual(key(dritter), key(zweiter), 'the fixture is degenerate');
  assert.equal(rang[1], key(dritter),
    `MMR did not prefer the clearly less similar candidate: ${rang.join(' ')}`);
});

test('a clearly higher score still comes first', () => {
  const c = tied(3);
  c[2].score = 5;
  const rang = c.sort(search.byScoreThenIdentity).map((h) => h.entry.id);
  assert.equal(rang[0], 'TIE-2', 'a clearly higher score did not come first');
});
