// P16 · "one writer manages 8.91 entries/sec" — where the ms actually go.
//
// The section gate is "append exponent 0": the cost of one write must not
// grow with how much is already there. Measured 2026-09-20, three
// components fed by one `mem log <type>` call, at 1,000 / 10,000 / 100,000
// pre-existing `learning` entries (median of 3 fresh-process samples per
// rung, single call each — a repeated in-process loop over a
// multi-ten-megabyte array measures GC pressure from the LOOP, not the
// cost of one real call, and inflated an early draft of this measurement
// by roughly 2x):
//
//   memory.logEntry()          1.15 ms -> 1.50 ms -> 1.58 ms   exponent ~0.07
//   neighbours.neighbours()    3.74 ms -> 31.6 ms -> 317  ms   exponent ~0.96
//   cli/display.countLines()   0.86 ms -> 10.5 ms -> 103  ms   exponent ~1.04
//
// `memory.logEntry` — the ONLY function this build point is scoped to
// (see the build brief: "Files you may touch: src/memory.mjs's write
// path") — already sits at the gate. It does one `fs.appendFileSync`, two
// small, corpus-independent `.mem/config.json` reads, and returns. The
// two functions that actually grow linearly with the corpus are not in
// `src/memory.mjs` at all:
//
//   - `neighbours.neighbours()` (src/neighbours.mjs), called from
//     `src/cli/commands/write.mjs` BEFORE `memory.logEntry()` runs. It
//     does `memory.readLog()` — read the whole drawer, JSON.parse every
//     line — plus a `retiredMap` pass over every parsed entry. It runs
//     whenever the type's subject field (topic/scope/key — see
//     `neighbours.SUBJECT_FIELD`) is set on the write, which `mem log
//     learning --topic ...` and the like do routinely.
//   - `display.countLines()` (src/cli/display.mjs), called from
//     `write.mjs` right AFTER `memory.logEntry()` returns, purely to
//     print "Appended: <file>:<N>" — it reads and re-splits the WHOLE
//     drawer a second time, unconditionally, on every write regardless
//     of type or fields.
//
// Both run once per write, in `src/cli/commands/write.mjs`, which this
// build point's file scope does not include — see the report for the
// exact diff this file's evidence implies.
//
// This file only makes claims about `memory.logEntry` (in scope) and
// documents, with the same measurement method, that the other two named
// functions are the actual source of growth (out of scope, evidence
// only — no assertion is made that would require editing them).
//
// **Addendum, 2026-09-20 (#157): the neighbours()-is-bounded probe below
// was reporting an innocent.** It passed alone and in a quiet full run,
// then failed in the very next one, with nothing in between that touches
// `src/neighbours.mjs`. Measured directly: a SINGLE call to
// `neighbours()` at n=60000 occasionally lands 3-4x its own typical cost
// (2.9 ms -> 9-13 ms) even on an otherwise idle instance of this
// container, with steal, cgroup and PSI in `bench/atlas/core.mjs` ALL
// reading quiet during that exact window — see the report for the
// numbers. That is a real, reproducible property of a single sample at
// this magnitude on this shared/virtualised host, not a defect in
// `neighbours()`: 9 independent repeated samples per rung, median taken,
// land at a stable ~0.15-0.24 exponent across six separate quiet-machine
// experiments (well under the 0.4 gate) even though individual samples
// inside those same experiments ranged as high as 3-6x the median.
// Spawning real CPU fressers confirms the shape: on this 4-core
// container the median-of-9 design stays clean through 0-3 fressers and
// only starts flipping at 4 (full core oversubscription) and above — and
// at every load level where it DOES flip, PSI (and, at heavier levels,
// steal+cgroup) was ALSO reading over threshold, so gating on that half
// of the `bench/atlas/core.mjs` apparatus — reused exactly as
// `test/atlas-foreign-load.test.mjs` already established for this
// identical problem, not a second convention — turns every one of those
// flips into an honest `t.skip()` with the real numbers instead of a
// false red. The apparatus's THIRD signal, the calibration loop's ratio
// to its own quiet baseline, is deliberately NOT used as part of this
// gate — measured to read 1.4-1.6x its own baseline from this test's own
// ordinary GC alone, with zero foreign load present, often enough to
// make the gate fire on nearly every run; see `measureUnderLoadGate`'s
// own doc comment below for the numbers and why. The isolated
// single-sample noise (present even with zero fressers, from this
// host's own virtualisation jitter) is what the median-of-9 fixes; PSI
// and steal+cgroup are what catch genuine, sustained contention (a full
// parallel `node --test` run, or deliberate fressers) that could
// otherwise skew the median itself. Neither change touches how
// `neighbours()` is timed — every sample is still one real, unmodified
// call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as memory from '../src/memory.mjs';
import * as neighbours from '../src/neighbours.mjs';
import { countLines } from '../src/cli/display.mjs';
import {
  captureQuietCalibrationBaseline, captureForeignLoad, foreignLoadDelta,
  FOREIGN_LOAD_DENIED_MS_PER_SEC,
} from '../bench/atlas/core.mjs';

/** A fresh root with `n` pre-existing `learning` entries, written directly
 * (no CLI, no logEntry) so building the fixture never pollutes the thing
 * being timed. */
function rootWith(n) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-exp-'));
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      id: `seed${String(i).padStart(8, '0')}`,
      ts: new Date(Date.now() - (n - i) * 1000).toISOString(),
      v: 1,
      agent: 'human:seed',
      topic: `topic-${i % 500}`,
      title: `seeded learning entry ${i}`,
      text: `filler text for a synthetic P16 corpus, entry ${i} of ${n}`,
    }));
  }
  fs.writeFileSync(path.join(r, 'global', 'learnings.jsonl'), lines.length ? `${lines.join('\n')}\n` : '');
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

const RUNGS = [1000, 10000, 60000];

/** log-log least-squares fit of t = a * n^b. Returns b (the exponent). A
 * flat cost fits b near 0; a linear-in-corpus cost fits b near 1. */
function fitExponent(points) {
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(Math.max(p.ms, 1e-6)));
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** One timed call each of `logEntryFn` and `neighboursFn`/`countLinesFn`,
 * against a fresh corpus of size `n`. A single call per fixture, not a
 * loop — see the header comment on why a loop over a large array
 * measures the loop's own GC, not the call. */
function measureAt(n, { sabotageExtraReads = 0 } = {}) {
  const r = rootWith(n);
  try {
    const drawer = path.join(r, 'global', 'learnings.jsonl');

    const t0 = performance.now();
    // Sabotage hook: when > 0, re-reads the whole drawer this many extra
    // times before the real call, standing in for "logEntry grew a
    // corpus-scan it should not have". Zero in every real measurement
    // below; only flipped on inside the RED half of the sabotage test.
    for (let s = 0; s < sabotageExtraReads; s += 1) fs.readFileSync(drawer, 'utf8');
    memory.logEntry(r, 'learning', { title: 'probe', text: 'measuring logEntry cost alone' });
    const logEntryMs = performance.now() - t0;

    const t1 = performance.now();
    neighbours.neighbours(r, 'learning', { topic: 'topic-0' });
    const neighboursMs = performance.now() - t1;

    const t2 = performance.now();
    countLines(drawer);
    const countLinesMs = performance.now() - t2;

    return { n, logEntryMs, neighboursMs, countLinesMs };
  } finally {
    away(r);
  }
}

/** How many independent, real calls to `neighbours()` are medianed per
 * rung below — see the file-header addendum for why a single call is not
 * enough for THIS function specifically. Odd, for a clean median. Kept
 * small on purpose: 21 reps and 9 reps gave the same ~0.15-0.24 answer
 * across six independent quiet-machine experiments (see the report), so
 * more reps buy nothing but a slower suite. */
const NEIGHBOURS_MEDIAN_REPS = 9;

/**
 * `neighbours()`'s own cost at corpus size `n`, as the MEDIAN of
 * `NEIGHBOURS_MEDIAN_REPS` independent real calls against ONE freshly
 * built root.
 *
 * This is not the "repeated in-process loop" the file header warns
 * against: that warning is about looping over a growing, multi-megabyte
 * in-memory array, which piles up allocation across iterations and times
 * the loop's own GC. `neighbours()` is a pure, side-effect-free read
 * against a root that is built once and never mutated between calls, so
 * repeating the call `reps` times draws `reps` i.i.d. samples of the
 * SAME one real cost — no iteration compounds into the next, and each
 * sample is still one full, unmodified, real invocation of
 * `neighbours()`, exactly as before. Only the STATISTIC drawn from those
 * real calls changes, from "trust the one sample you happened to get" to
 * "take the middle of nine".
 *
 * `opts` is forwarded to `neighbours.neighbours()` unchanged — used by
 * the sabotage test below to pass `{ tailBytes: Infinity }` and force a
 * full-file read at every rung, without touching `src/neighbours.mjs`.
 */
function neighboursMedianAt(n, reps = NEIGHBOURS_MEDIAN_REPS, opts = {}) {
  const r = rootWith(n);
  try {
    const samples = [];
    for (let i = 0; i < reps; i += 1) {
      const t0 = performance.now();
      neighbours.neighbours(r, 'learning', { topic: 'topic-0' }, opts);
      samples.push(performance.now() - t0);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return {
      n, medianMs, minMs: sorted[0], maxMs: sorted[sorted.length - 1], samples: samples.map((s) => +s.toFixed(3)),
    };
  } finally {
    away(r);
  }
}

/**
 * Runs `work()` once, bracketed by `bench/atlas/core.mjs`'s own
 * quiet-calibration baseline and before/after foreign-load snapshots —
 * the SAME apparatus `test/atlas-foreign-load.test.mjs` already
 * establishes and sabotage-verifies for exactly this class of problem
 * (PSI, CPU steal + cgroup throttling, and a fixed calibration loop
 * checked against its own quiet baseline), reused here rather than
 * reinvented. See `FOREIGN_LOAD_DENIED_MS_PER_SEC` in that file for
 * where the threshold below comes from.
 *
 * **Deliberately NOT gated on `calibOverThreshold` — measured, not
 * assumed.** The calibration loop's own doc comment says its
 * `before`/`after` readings bracket "a phase's timed section", which in
 * every existing atlas phase is a real CLI child process or a `sleep`
 * — nothing CPU- or GC-heavy running in the SAME process as the
 * calibration loop itself. `work()` here is the opposite: dozens of
 * real, in-process `neighbours()` calls plus multi-megabyte fixture
 * writes, all sharing this process's own heap and GC with the
 * calibration loop's `after` reading. Measured directly (see the
 * report): calling `calibrationLoopMs()` right after an equivalent
 * workload, with ZERO other process on the machine, read 1.4-1.6x its
 * own quiet baseline in roughly a fifth of trials, purely from this
 * workload's OWN ordinary GC — and inside the real `node --test` file
 * (which runs two more `rootWith(60000)`-sized tests first, growing the
 * heap further before this one runs) that rate was high enough to skip
 * this test in 5 of 6 straight alone-on-a-quiet-machine runs, EVERY
 * time on `calibRatio` alone, with PSI and steal+cgroup reading quiet
 * throughout. A gate that fires that often on a genuinely idle machine
 * is the "guard that reports innocents" this house switches off — so
 * for THIS probe specifically, `calibOverThreshold` is left out: it
 * cannot tell this workload's own GC from a sibling process's CPU use,
 * which is exactly the distinction the gate exists to draw. PSI and
 * steal+cgroup are kernel-computed from OTHER runnable tasks contending
 * for the CPU; a single process doing its own GC does not manufacture
 * a reading on either of them, so they stay as the gate, along with the
 * baseline's own `trustworthy` flag (captured BEFORE `work()` runs, so
 * this workload cannot have polluted it either).
 *
 * Returns `{ result, load, calibBaseline, notMeasuredReason }`.
 * `notMeasuredReason` is a human-readable string carrying the real
 * numbers whenever the window could not be shown quiet — either the
 * baseline itself never stabilised, or steal+cgroup or PSI read over
 * threshold during this exact window. `null` means the window measured
 * clean and `result` may be trusted. This function never decides
 * pass/fail on its own — that stays with the caller's own assertion,
 * exactly as `timeVerdictUnderLoad` leaves non-time-based verdicts
 * alone.
 */
function measureUnderLoadGate(work) {
  const calibBaseline = captureQuietCalibrationBaseline();
  const before = captureForeignLoad(calibBaseline);
  const result = work();
  const after = captureForeignLoad(calibBaseline);
  const load = foreignLoadDelta(before, after, calibBaseline);

  if (!calibBaseline.trustworthy) {
    return {
      result,
      load,
      calibBaseline,
      notMeasuredReason: `this run's own quiet-calibration baseline never stabilised in `
        + `${calibBaseline.attempts} attempt(s) (spreadRatio=${calibBaseline.spreadRatio}, `
        + `psiQuiet=${calibBaseline.psiQuiet}) — the machine cannot be shown quiet here, so nothing `
        + 'downstream of it can be trusted either.',
    };
  }
  const stealCgroupOver = load.deniedMsPerSec !== null && load.deniedMsPerSec > FOREIGN_LOAD_DENIED_MS_PER_SEC;
  const psiOver = load.psiMsPerSec !== null && load.psiMsPerSec > FOREIGN_LOAD_DENIED_MS_PER_SEC;
  // calibOverThreshold is intentionally NOT part of this gate — see the
  // doc comment above. `load.calibRatio` is still carried into the report
  // string below for a reader's own reference, exactly as
  // `psiAvg10AtCapture` is kept-but-not-gating in `captureCalibrationBaselineOnce`.
  if (stealCgroupOver || psiOver) {
    return {
      result,
      load,
      calibBaseline,
      notMeasuredReason: `foreign load was measured during this window (deniedMsPerSec=${load.deniedMsPerSec}, `
        + `psiMsPerSec=${load.psiMsPerSec}, threshold ${FOREIGN_LOAD_DENIED_MS_PER_SEC} ms/s; for reference, `
        + `calibRatio=${load.calibRatio}, not gated on here) — this window's timings cannot be trusted to `
        + 'reflect the real cost being measured.',
    };
  }
  return {
    result, load, calibBaseline, notMeasuredReason: null,
  };
}

test('memory.logEntry: per-write cost does not grow with corpus size (append exponent ~0)', () => {
  const points = RUNGS.map((n) => ({ n, ms: measureAt(n).logEntryMs }));
  const exponent = fitExponent(points);
  // Generous threshold: neighbours()/countLines() below sit at ~1.0 for
  // the SAME corpus, so anything under 0.4 is unambiguously a different
  // shape, not just a lucky noisy run. logEntry measured ~0.07 in the
  // session that produced this file.
  assert.ok(
    exponent < 0.4,
    `logEntry's per-write cost grew with corpus size (exponent ${exponent.toFixed(2)}) `
    + `at points ${JSON.stringify(points)} — the P16 gate ("append exponent 0") is broken.`,
  );
});

test('sabotage: the exponent fit actually catches an O(n) write path, restored exactly after', (t) => {
  // RED: reintroduce a corpus-dependent cost in front of the timed call —
  // never by editing src/memory.mjs, only inside this measurement, exactly
  // the way `if (false && ...)` stands in for a real code change without
  // touching the file another agent is mid-edit on (src/memory.mjs).
  //
  // **Gated on the same shared load sensor as the neighbours() sabotage
  // test further below (`measureUnderLoadGate`, `bench/atlas/core.mjs`) —
  // measured 2026-09-26, not assumed.** Alone, or in a quiet full run,
  // this test passed every time. Run alongside four SIBLING copies of
  // itself (five parallel `node --test` processes on this file, standing
  // in for the brief's "5 agents in parallel") it went red on the RED
  // half: `sabotageExtraReads: 1`'s own single extra `fs.readFileSync`
  // per call is a tiny, CONSTANT cost next to real contention from four
  // other processes' GC and I/O, so the fitted exponent came back 0.47
  // (below the 0.6 gate) — real foreign load hiding the sabotage's
  // signal, not a broken sabotage. `measureAt()` here still takes one
  // real, unmodified sample per rung (same as `neighbours()`'s own
  // ungated first test above, which pins logEntry itself and is wide
  // enough at these magnitudes to survive ordinary noise); it is this
  // probe's much smaller RED-vs-GREEN gap — one `readFileSync` of a
  // dozen KB, at millisecond magnitudes — that real contention can
  // swamp. Per this house's rule, the fix is the SAME not-measured
  // branch every other timing probe in this file already uses, never a
  // loosened threshold: under real contention this reports "not
  // measurable" via `t.skip()` with the numbers, while the sabotage
  // guarantee itself (asserted below, unchanged) still fires for real
  // whenever the window is quiet — proven by the plain, ungated runs
  // above going green on every one of five parallel repeats.
  const red = measureUnderLoadGate(
    () => RUNGS.map((n) => ({ n, ms: measureAt(n, { sabotageExtraReads: 1 }).logEntryMs })),
  );
  if (red.notMeasuredReason) {
    t.skip(`not measured (RED half): ${red.notMeasuredReason} points: ${JSON.stringify(red.result)}`);
    return;
  }
  const redExponent = fitExponent(red.result);
  assert.ok(
    redExponent >= 0.6,
    `sabotage did not turn red: exponent ${redExponent.toFixed(2)} at ${JSON.stringify(red.result)} — `
    + 'this probe would not have caught a real regression either.',
  );

  // GREEN: restored exactly — sabotageExtraReads defaults to 0, no file
  // was touched, this is the same call as the test above.
  const green = measureUnderLoadGate(() => RUNGS.map((n) => ({ n, ms: measureAt(n).logEntryMs })));
  if (green.notMeasuredReason) {
    t.skip(`not measured (GREEN half): ${green.notMeasuredReason} points: ${JSON.stringify(green.result)}`);
    return;
  }
  const greenExponent = fitExponent(green.result);
  assert.ok(
    greenExponent < 0.4,
    `did not return to green after sabotage: exponent ${greenExponent.toFixed(2)}`,
  );
});

test('the write path no longer grows with the drawer: neighbours() is bounded', (t) => {
  // **This test used to assert the opposite, and that is the point.**
  //
  // It was written as EVIDENCE: neighbours() and countLines() each ran
  // a full drawer scan on every single write, so the cost of writing
  // one entry grew with everything already written. Measured then:
  // neighbours 2.3 ms at 1k rows, 15.9 ms at 10k, 205.6 ms at 100k,
  // fitted exponent 0.96.
  //
  // The defect it recorded is fixed, so the test turns around: the same
  // measurement now guards against the regression instead of pinning
  // the defect. neighbours() reads only the tail of the drawer (see
  // TAIL_BYTES in src/neighbours.mjs), which is flat from the point the
  // file exceeds the window. Measured after: 2.3 / 6.7 / 8.5 ms over
  // the same rungs.
  //
  // A defect-recording test that is left asserting the defect after the
  // repair is worse than no test: it goes red on the fix and teaches
  // whoever sees it to revert.
  //
  // **Why the neighbours() half is measured differently from the
  // countLines() half below — see the file-header addendum for the
  // full story.** In short: a single call to neighbours() is noisy
  // enough at this magnitude (single-digit ms) that one unlucky sample
  // can fail this assertion with nothing wrong in `src/neighbours.mjs`
  // at all. The fix is two independent layers, both reused from
  // established apparatus rather than invented here: `neighboursMedianAt`
  // takes the median of several real calls per rung (fixes the
  // brief, single-sample noise this host produces even when idle), and
  // `measureUnderLoadGate` wraps the whole window in `bench/atlas/core.mjs`'s
  // own foreign-load sensors (fixes genuine, sustained contention that
  // could skew the median itself — a full parallel `node --test` run,
  // or real CPU fressers). Neither layer changes what is being timed.
  const {
    result: neighboursRungs, load, calibBaseline, notMeasuredReason,
  } = measureUnderLoadGate(() => RUNGS.map((n) => neighboursMedianAt(n)));

  // countLines() keeps the original single-call-per-rung measurement:
  // it was never the flaky half of this test (it is asserted `> 0.6`,
  // i.e. "did not flatten" — foreign load inflating it further cannot
  // manufacture a false pass, only push the window into the not-measured
  // branch below alongside neighbours()).
  const points = RUNGS.map((n) => measureAt(n));

  if (notMeasuredReason) {
    t.skip(
      `not measured: ${notMeasuredReason} neighbours rungs (median of ${NEIGHBOURS_MEDIAN_REPS} reps each): `
      + `${JSON.stringify(neighboursRungs)}; load: ${JSON.stringify(load)}; `
      + `calibration baseline: ${JSON.stringify(calibBaseline)}`,
    );
    return;
  }

  const neighboursExponent = fitExponent(neighboursRungs.map((p) => ({ n: p.n, ms: p.medianMs })));
  assert.ok(
    neighboursExponent < 0.4,
    `neighbours() grows with corpus size again (exponent ${neighboursExponent.toFixed(2)}). `
    + `The tail bound in src/neighbours.mjs is the thing to look at. Rungs (median of `
    + `${NEIGHBOURS_MEDIAN_REPS} reps each): ${JSON.stringify(neighboursRungs)}`,
  );

  // countLines() is still linear, and is NOT asserted flat — an exact
  // line number cannot be had without seeing every line break. What
  // changed there is the constant (16 ms -> 7 ms at 100k rows, same
  // answer) by counting newline bytes instead of allocating one string
  // per line. Recorded, not claimed as solved.
  const countLinesExponent = fitExponent(points.map((p) => ({ n: p.n, ms: p.countLinesMs })));
  assert.ok(
    countLinesExponent > 0.6,
    `countLines() stopped growing (exponent ${countLinesExponent.toFixed(2)}) — if that is real, `
    + `this comment is stale and the claim above needs re-measuring. Points: ${JSON.stringify(points)}`,
  );
});

test('sabotage: breaking the tail bound turns neighbours() red again on a quiet machine', (t) => {
  // This is the house rule in force: "a guard that reports innocents
  // gets switched off" cuts both ways — the fix above must not have
  // quietly turned this probe into a check that can no longer fail.
  //
  // RED: force a full-file read at EVERY rung via the `tailBytes`
  // PARAMETER `neighbours()` already exposes (src/neighbours.mjs) —
  // this house's rule for sabotage probes, a parameter over a source
  // patch, and this one already exists for exactly this purpose, no
  // `if (false && ...)` needed. `tailBytes: Infinity` disables the tail
  // window outright, so n=60000 must parse all ~60,000 lines instead of
  // the ~2,650-line tail — reintroducing the O(n) shape this whole test
  // exists to catch.
  const red = measureUnderLoadGate(
    () => RUNGS.map((n) => neighboursMedianAt(n, NEIGHBOURS_MEDIAN_REPS, { tailBytes: Infinity })),
  );
  if (red.notMeasuredReason) {
    t.skip(`not measured (RED half): ${red.notMeasuredReason} rungs: ${JSON.stringify(red.result)}`);
    return;
  }
  const redExponent = fitExponent(red.result.map((p) => ({ n: p.n, ms: p.medianMs })));
  assert.ok(
    redExponent >= 0.6,
    `sabotage did not turn red: exponent ${redExponent.toFixed(2)} at ${JSON.stringify(red.result)} — `
    + 'a guard that cannot fail is not a guard.',
  );

  // GREEN: restored exactly — default tailBytes, the same call the real
  // test above makes.
  const green = measureUnderLoadGate(() => RUNGS.map((n) => neighboursMedianAt(n)));
  if (green.notMeasuredReason) {
    t.skip(`not measured (GREEN half): ${green.notMeasuredReason} rungs: ${JSON.stringify(green.result)}`);
    return;
  }
  const greenExponent = fitExponent(green.result.map((p) => ({ n: p.n, ms: p.medianMs })));
  assert.ok(
    greenExponent < 0.4,
    `did not return to green after sabotage: exponent ${greenExponent.toFixed(2)} at ${JSON.stringify(green.result)}`,
  );
});
