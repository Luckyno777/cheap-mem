// test/register-phase.test.mjs — the register atlas phase holds its own
// rules, and the four verdicts stay four.
//
// **Why this suite exists.** `bench/atlas/phase-register.mjs` turns a
// one-off prototype measurement (sqlite+FTS5, 2026-09-20) into a
// repeatable one, and the one thing that made the FIRST attempt at that
// measurement wrong was invisible from the outside: a 42-word vocabulary
// made every "rare" query match almost the whole corpus, and the
// resulting exponent was honestly computed and answered the wrong
// question. A benchmark whose own defining rules are not held by a test
// can regress to that exact mistake without anything turning red. This
// suite holds three things directly: that the phase's own selectivity
// rule (no latency without its matched-row count) cannot be silently
// dropped, that the generated vocabulary is provably not degenerate, and
// that an unavailable `node:sqlite` is reported, never swallowed.
//
// **Cost, on purpose.** The phase itself runs at `{ quick: true }` here —
// two corpus rungs, 300 and 1,200 rows — which still drives real sqlite
// builds AND roughly two dozen real `mem find` child processes (Node
// startup per call), because "today's path" must be the real CLI, not a
// stand-in. Measured while writing this: ~6-7 s for the one run(), which
// every test below shares (module-level, computed once) rather than
// re-running per test. That is the whole cost of this file; nothing here
// re-runs the phase.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';
import {
  run, withSelectivity, loadSqlite, pickBands, buildZipfCorpus,
  latencyNeedsSelectivity, LATENCY_WITHOUT_SELECTIVITY,
} from '../bench/atlas/phase-register.mjs';

// --- shared fixture: one real quick run, computed once ------------------

const atlas = new Atlas({ label: 'register-phase-test' });
await run(atlas, { quick: true });
const phase = atlas.phases.find((p) => p.id === 'register');

/** Every record whose `measured` block is expected to carry a latency. */
const LATENCY_PREFIXES = [
  'register.query.', 'register.today.', 'register.comparison.',
  'register.law.fixed-count.', 'register.today.fixed-count.',
];

function isLatencyRecord(r) {
  return LATENCY_PREFIXES.some((p) => r.id.startsWith(p));
}

function recordOf(id) {
  const r = phase.records.find((x) => x.id === id);
  assert.ok(r, `phase-register produced no record '${id}'`);
  return r;
}

// --- a small, independent check for "does this phase report ANYTHING" --
//
// Written once here rather than inline in each test, because the same
// question — "did this phase actually run, or did it quietly do
// nothing?" — is asked twice: once of the real phase, once of a
// deliberately empty stand-in built to prove the check itself works.

function assertPhaseProducedRecords(anAtlas, phaseId) {
  const p = anAtlas.phases.find((x) => x.id === phaseId);
  assert.ok(p, `no phase named '${phaseId}' was ever started`);
  assert.ok(p.records.length > 0,
    `the '${phaseId}' phase ran and produced ZERO records — a benchmark that runs `
    + 'and reports nothing must not be mistaken for one that was never run');
}

// =========================================================================
// 1. Positive control: the phase runs and produces records
// =========================================================================

test('CONTROL: an empty phase is caught, not passed', () => {
  const empty = new Atlas({ label: 'empty' });
  empty.phase('register', 'a phase that never records anything');
  assert.throws(() => assertPhaseProducedRecords(empty, 'register'), /ZERO records/);
});

test('the register phase actually runs at quick scale and writes real records', () => {
  assert.doesNotThrow(() => assertPhaseProducedRecords(atlas, 'register'));
  // Not just "more than zero" — a real run touches every stage: build,
  // correctness, four selectivity bands (times two engines, times a
  // comparison), the fixed-count law, and the two corpus-wide checks.
  assert.ok(phase.records.length >= 30,
    `only ${phase.records.length} records from a quick run — too few to be the real phase`);
  const c = atlas.counts();
  assert.equal(c.pass + c.fail + c.degraded + c['not-measured'], phase.records.length,
    'every record must land in exactly one of the four verdict buckets');
  // A green run must be a run that actually measured node:sqlite, not one
  // that fell through to not-measured while looking identical from a
  // record count alone.
  assert.equal(recordOf('register.availability').verdict, VERDICT.PASS,
    'node:sqlite + FTS5 is expected to be available in this environment; if this '
    + 'fails on a real Node < 22 machine, see the not-measured tests below instead');
});

// =========================================================================
// 2. The selectivity rule: no latency without its matched-row count
// =========================================================================

test('withSelectivity() refuses to build a record missing matched or selectivity', () => {
  assert.throws(() => withSelectivity({ selectivity: 0.01, p50Ms: 1 }), /matched-row count/);
  assert.throws(() => withSelectivity({ matched: 5, p50Ms: 1 }), /matched-row count/);
  assert.throws(() => withSelectivity({}), /matched-row count/);
  // matched: 0 is a real, valid value (the no-match band) and must NOT be
  // rejected by an accidental falsy check.
  const ok = withSelectivity({ matched: 0, selectivity: 0, p50Ms: 0.02 });
  assert.equal(ok.matched, 0);
  assert.equal(ok.selectivity, 0);
  assert.equal(ok.p50Ms, 0.02);
});

test('every latency record the real run produced carries its matched-row count and selectivity', () => {
  const latencyRecords = phase.records.filter(isLatencyRecord);
  assert.ok(latencyRecords.length >= 20,
    `only ${latencyRecords.length} latency-shaped records found — the id prefixes may have drifted`);
  for (const r of latencyRecords) {
    assert.ok(r.measured && typeof r.measured === 'object',
      `${r.id} has no 'measured' block at all`);
    // One latency in this phase legitimately has no matched-row count:
    // the startup floor, which asks no question at all. The exemption
    // is declared in the phase module with its reason, and read from
    // there — a second copy of the judgement here would be the second
    // source of truth this house keeps finding.
    if (!latencyNeedsSelectivity(r.id)) {
      assert.ok(Number.isFinite(r.ms) || Number.isFinite(r.measured.p50Ms),
        `${r.id} is exempt from selectivity but carries no latency either — then it is not a floor`);
      continue;
    }
    assert.ok(Number.isFinite(r.measured.matched),
      `${r.id} carries a latency but no numeric 'matched' row count`);
    assert.ok(Number.isFinite(r.measured.selectivity),
      `${r.id} carries a latency but no numeric 'selectivity'`);
    assert.ok(r.measured.selectivity >= 0 && r.measured.selectivity <= 1,
      `${r.id} has a selectivity outside [0, 1]: ${r.measured.selectivity}`);
  }
});

test('SABOTAGE (in-memory): a record smuggled in without its matched-row count is caught', () => {
  // This does not touch bench/atlas/phase-register.mjs — it proves the
  // SCANNING assertion above actually fails on the exact defect it
  // exists to catch, by handing it a fabricated phase that mimics one.
  const fake = new Atlas({ label: 'sabotage' });
  fake.phase('register', 'fake');
  fake.record({
    id: 'register.query.999.rare',
    title: 'fake latency record with the field silently dropped',
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: 'p50 1.0 ms',
    measured: { p50Ms: 1.0 }, // matched/selectivity missing on purpose
  });
  const fakePhase = fake.phases[0];
  assert.throws(() => {
    for (const r of fakePhase.records.filter(isLatencyRecord)) {
      assert.ok(Number.isFinite(r.measured.matched), `${r.id} has no matched-row count`);
      assert.ok(Number.isFinite(r.measured.selectivity), `${r.id} has no selectivity`);
    }
  }, /no matched-row count/);
});

// =========================================================================
// 3. The degenerate-corpus guard
// =========================================================================
//
// Re-derived independently here, not just read off the phase's own
// verdict — a test that only checks "the code agrees with itself" cannot
// catch the code being wrong about its own guarantee.

test('the generated Zipf vocabulary is genuinely not degenerate: rare really is rare', () => {
  const { df, count } = buildZipfCorpus(20000, 42);
  const bands = pickBands(df, count);
  assert.ok(bands.rare.matched > 0, 'the rare band term does not even occur once — pick a broken corpus');
  assert.ok(bands.rare.selectivity < 0.05,
    `rare selectivity is ${bands.rare.selectivity} — a "rare" query should match a small `
    + 'fraction of the corpus, not most of it (the 2026-09-20 mistake this guards against)');
  assert.ok(bands.frequent.selectivity >= bands.rare.selectivity * 20,
    `frequent (${bands.frequent.selectivity}) is not meaningfully rarer than rare `
    + `(${bands.rare.selectivity}) — there is no real spread between the bands`);
  assert.equal(bands.noMatch.matched, 0, 'the no-match control term must match zero rows');
});

test('the real run\'s own non-degenerate check passed', () => {
  assert.equal(recordOf('register.corpus.non-degenerate').verdict, VERDICT.PASS);
});

test('SABOTAGE: a hand-built degenerate corpus (the original 2026-09-20 mistake) is correctly flagged', () => {
  // Forty words, and every row is long enough that most rows contain most
  // words — reproducing the shape of the first, wrong attempt at this
  // measurement by hand, independent of buildZipfCorpus.
  const VOCAB = 40;
  const ROWS = 500;
  const df = new Map();
  for (let t = 0; t < VOCAB; t += 1) df.set(`w${t}`, Math.round(ROWS * 0.9)); // ~90% of rows
  const bands = pickBands(df, ROWS);
  // The guard's own thresholds, re-applied by hand: this is what
  // `register.corpus.non-degenerate` in the phase computes.
  const nonDegenerate = bands.rare.selectivity < 0.05
    && bands.rare.selectivity > 0
    && bands.frequent.selectivity >= bands.rare.selectivity * 20;
  assert.equal(nonDegenerate, false,
    'a 40-word, 90%-coverage vocabulary must be judged degenerate, not passed');
});

// =========================================================================
// 4. not-measured, never a silent skip
// =========================================================================

test('loadSqlite() reports the forced-unavailable reason without touching process.env', async () => {
  await assert.rejects(
    () => loadSqlite({ CHEAP_MEM_ATLAS_FORCE_NO_SQLITE: '1' }),
    /forced unavailable/,
  );
});

test('an unavailable node:sqlite makes the phase record not-measured, never a pass, never nothing', async () => {
  const noSqliteAtlas = new Atlas({ label: 'no-sqlite' });
  const failingLoader = async () => { throw new Error('simulated: node:sqlite not present on this build'); };
  await run(noSqliteAtlas, { quick: true, sqliteLoader: failingLoader });
  const p = noSqliteAtlas.phases.find((x) => x.id === 'register');
  assertPhaseProducedRecords(noSqliteAtlas, 'register'); // never a silent skip
  assert.equal(p.records.length, 1,
    'an unavailable node:sqlite should short-circuit to exactly one honest record');
  const r = p.records[0];
  assert.equal(r.id, 'register.availability');
  assert.equal(r.verdict, VERDICT.NOT_MEASURED);
  assert.match(r.actual, /simulated: node:sqlite not present/);
  const counts = noSqliteAtlas.counts();
  assert.equal(counts.pass, 0, 'unavailability must never be recorded as a pass');
  assert.equal(counts.fail, 0, 'unavailability is not a fail either — it is its own verdict');
  assert.equal(counts['not-measured'], 1);
  assert.ok(noSqliteAtlas.blindSpots.length >= 1,
    'the whole phase being unreachable must be named as a blind spot, not left implicit');
  assert.ok(noSqliteAtlas.blindSpots.some((b) => /register phase/.test(b.what)),
    'the blind spot must name the register phase specifically');
});

// --- the startup floor -------------------------------------------------
//
// **The defect this covers (found 2026-09-20 while verifying this
// phase).** `timeRegisterQuery` times a prepared statement inside the
// running process; `timeCliQuery` spawns a whole `mem` child. Dividing
// one by the other produced factors up to five figures, and the phase
// reported the whole quotient as "what the register gains". A large
// constant part of it is Node's startup plus this CLI's module graph —
// which the register does not remove, because a register query issued
// from the command line would pay it too. A real number attributed to
// the wrong cause: `falsche-ursache`.
//
// The phase now measures that floor with a command that loads the same
// modules and never opens a drawer, and reports both factors.

test('the phase measures what a `mem` call costs before it searches', () => {
  const floors = phase.records.filter((r) => r.id.startsWith('register.today.floor.'));
  assert.ok(floors.length >= 1, 'no startup-floor record was produced at any rung');
  for (const r of floors) {
    assert.ok(Number.isFinite(r.measured.p50Ms) && r.measured.p50Ms > 0,
      `${r.id} reports no positive floor — a floor of zero means it never spawned`);
    assert.equal(r.measured.spawned, true,
      `${r.id} says the probe did not run as a child process`);
  }
});

test('every comparison states both factors, or says why the second is not measurable', () => {
  const comparisons = phase.records.filter((r) => r.id.startsWith('register.comparison.'));
  assert.ok(comparisons.length >= 4, `only ${comparisons.length} comparison records found`);
  for (const r of comparisons) {
    assert.ok(Number.isFinite(r.measured.speedupEndToEnd),
      `${r.id} has no end-to-end factor`);
    assert.ok('speedupSearchOnly' in r.measured,
      `${r.id} does not mention the search-only factor at all`);
    if (r.measured.speedupSearchOnly === null) {
      // Third state, and it has to be legible: a null here must be
      // explained by a CLI time that does not exceed the floor, never
      // by the field having been forgotten.
      assert.ok(
        r.measured.cliFloorMs === null || r.measured.todayMs <= r.measured.cliFloorMs
          || r.measured.todaySearchOnlyMs <= 0,
        `${r.id} reports no search-only factor although the CLI time (${r.measured.todayMs} ms) `
        + `is above the floor (${r.measured.cliFloorMs} ms) — that is a missing number, not an honest unknown`,
      );
      continue;
    }
    // STRICTLY smaller, and that word is the whole test. `<=` also
    // passes when the floor is never subtracted at all — which is the
    // exact defect this measurement was added to fix, so a test that
    // allowed equality would have been green over the bug.
    assert.ok(r.measured.cliFloorMs > 0,
      `${r.id} reports a search-only factor without a positive floor to have removed`);
    assert.ok(r.measured.todaySearchOnlyMs < r.measured.todayMs,
      `${r.id}: the search-only time (${r.measured.todaySearchOnlyMs} ms) is not below the `
      + `full CLI time (${r.measured.todayMs} ms) — the floor was not subtracted`);
    assert.ok(r.measured.speedupSearchOnly < r.measured.speedupEndToEnd,
      `${r.id}: removing a positive floor must make the factor strictly SMALLER — `
      + `${r.measured.speedupSearchOnly}x search-only vs ${r.measured.speedupEndToEnd}x end-to-end`);
  }
});

test('SABOTAGE: the selectivity exemption cannot be widened to cover a real query', () => {
  // The exemption is a declaration, and a declaration nobody checks is
  // a hole. These are the ids the phase actually produces for queries;
  // none of them may match the exempt prefixes, now or after an edit.
  const queryIds = [
    'register.query.1000.rare',
    'register.today.1000.rare',
    'register.law.fixed-count.1000',
    'register.today.fixed-count.1000',
  ];
  for (const id of queryIds) {
    assert.equal(latencyNeedsSelectivity(id), true,
      `${id} is a real query and must not be exempt from stating its selectivity`);
  }
  assert.equal(latencyNeedsSelectivity('register.today.floor.1000'), false,
    'the startup floor must be the one that is exempt');
  // And every exemption carries a written reason, not just a name.
  for (const [prefix, reason] of Object.entries(LATENCY_WITHOUT_SELECTIVITY)) {
    assert.ok(reason.length > 40, `the exemption for ${prefix} has no real reason attached`);
  }
});
