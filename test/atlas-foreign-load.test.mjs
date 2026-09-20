// bench/atlas — B3: the atlas must know its own foreign load.
//
// **The finding this answers (bauplan 2, 2026-09-20).** A full atlas run
// under ~3.9 foreign load on 4 cores let five time-based checks flip from
// `pass` to `degraded`/`fail`; on a quiet re-run two were real and three
// were not, and nothing in the report could tell the two apart. The fix
// is not "detect load and skip the check" — a skipped check reports
// nothing, which is worse than a wrong answer nobody can spot. It is
// `not-measured`: a fourth state that says "this clock could not be
// trusted here", printed instead of a pass or fail that would otherwise
// look identical to a clean run.
//
// **Why the tests below inject the load through a PARAMETER.** This
// house's rule for sabotage probes: prefer a parameter over a source
// patch, and cheap-mem's own ESLint config rejects the `if (false && …)`
// shape a source patch would need anyway. `timeVerdictUnderLoad` takes
// its foreign-load reading as an explicit argument for exactly this
// reason — a test can hand it a fabricated `foreignLoadDelta`-shaped
// object without needing a single busy-loop process or a real cgroup
// quota. The THRESHOLD itself (`FOREIGN_LOAD_DENIED_MS_PER_SEC`) was
// derived from a real, controlled cgroup-quota experiment — see the long
// comment on that constant in `bench/atlas/core.mjs` for the numbers —
// but verifying the GATING LOGIC that consumes it does not need to
// reproduce that experiment every time this suite runs.
//
// **Addendum, 2026-09-20: the sensors themselves were wrong.** Steal and
// cgroup throttling measured a real, honestly-computed 0.00 ms/s under
// 8 CPU-bound processes pinned against this container's 4 cores — the
// exact load this guard exists to catch — because steal only counts a
// HYPERVISOR denying another VM guest, and this container's cgroup has
// no quota to be throttled against. `core.mjs` now also reads PSI
// (`/proc/pressure/cpu`, sees ordinary sibling contention neither of the
// other two can) and runs a fixed calibration loop against its own
// self-checked quiet baseline (needs no `/proc` access at all, so it
// works everywhere). The gating-logic tests above still use fabricated
// `foreignLoadDelta`-shaped objects for the reason given above; the
// tests below this line additionally exercise the new sensors against
// REAL spawned CPU load, because the finding they answer ("the sensor
// itself reads 0 under real load") cannot be reproduced by a fabricated
// object — a fake can only prove the gate reacts to a number, not that
// the number is the right one.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import {
  VERDICT, timeVerdict, timeVerdictUnderLoad, foreignLoadDelta, captureForeignLoad,
  readCpuStealTicks, readCgroupThrottle, FOREIGN_LOAD_DENIED_MS_PER_SEC,
  readPsiCpuSomeTotal, readPsiCpuSomeAvg10, calibrationLoopMs,
  captureCalibrationBaselineOnce, captureQuietCalibrationBaseline, CALIBRATION_LOAD_FACTOR,
} from '../bench/atlas/core.mjs';
import { biasVerdict } from '../bench/atlas/phase-real.mjs';

const DEGRADED_AT = 1000;
const FAIL_AT = 5000;

/** Spawn `count` CPU-bound child processes that spin until killed, for tests that need REAL foreign load rather than a fabricated `foreignLoadDelta`. Always killed in the caller's `finally`. */
function spawnCpuFressers(count) {
  const children = [];
  for (let i = 0; i < count; i += 1) {
    children.push(spawn(process.execPath, ['-e', 'let x = 0; while (true) { x += Math.sqrt(x + 1); }']));
  }
  return children;
}

function killAll(children) {
  for (const p of children) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
}

/** A `foreignLoadDelta()`-shaped object with a chosen denied-ms/s rate, without touching /proc or a cgroup. */
function fakeLoad(deniedMsPerSec) {
  return {
    wallMs: 1000,
    stealTicks: 0,
    stealMs: 0,
    cgroupSource: 'cgroup1',
    cgroupThrottledUsec: deniedMsPerSec * 1000,
    cgroupNrThrottled: deniedMsPerSec > 0 ? 1 : 0,
    cgroupMs: deniedMsPerSec,
    measured: true,
    deniedMsPerSec,
  };
}

test('ROT: forced high foreign load turns a clean pass into not-measured', () => {
  const ms = 50; // comfortably under DEGRADED_AT — would be a plain pass
  const withoutLoad = timeVerdictUnderLoad(ms, DEGRADED_AT, FAIL_AT, fakeLoad(0));
  const withHighLoad = timeVerdictUnderLoad(
    ms, DEGRADED_AT, FAIL_AT, fakeLoad(FOREIGN_LOAD_DENIED_MS_PER_SEC * 5),
  );
  assert.equal(withoutLoad, VERDICT.PASS, 'sanity: unloaded stays a plain pass');
  assert.equal(withHighLoad, VERDICT.NOT_MEASURED,
    'a check under forced high foreign load must not report pass or fail');
});

test('GRUEN (positive control): the same measurement without load still passes', () => {
  const ms = 50;
  assert.equal(
    timeVerdictUnderLoad(ms, DEGRADED_AT, FAIL_AT, fakeLoad(0)),
    VERDICT.PASS,
    'a guard that never comes back green on a clean run is not measuring anything',
  );
});

test('a load reading exactly AT the threshold still passes (the gate is "over", not "at or over")', () => {
  assert.equal(
    timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, fakeLoad(FOREIGN_LOAD_DENIED_MS_PER_SEC)),
    VERDICT.PASS,
  );
  assert.equal(
    timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, fakeLoad(FOREIGN_LOAD_DENIED_MS_PER_SEC + 0.01)),
    VERDICT.NOT_MEASURED,
  );
});

test('foreign load cannot manufacture a pass out of a genuinely slow call', () => {
  // High load must not paper over a real failure either — it forces
  // not-measured regardless of which way `ms` would otherwise have gone.
  const reallySlowMs = FAIL_AT + 1000;
  assert.equal(
    timeVerdictUnderLoad(reallySlowMs, DEGRADED_AT, FAIL_AT, fakeLoad(FOREIGN_LOAD_DENIED_MS_PER_SEC * 5)),
    VERDICT.NOT_MEASURED,
  );
  assert.equal(
    timeVerdictUnderLoad(reallySlowMs, DEGRADED_AT, FAIL_AT, fakeLoad(0)),
    VERDICT.FAIL,
    'sanity: without load this stays a real fail',
  );
});

test('no load measurement at all (`null`) degrades to plain timeVerdict, never a free pass', () => {
  for (const ms of [50, DEGRADED_AT + 1, FAIL_AT + 1]) {
    assert.equal(timeVerdictUnderLoad(ms, DEGRADED_AT, FAIL_AT, null), timeVerdict(ms, DEGRADED_AT, FAIL_AT));
  }
});

test('a foreign-load reading that could not be measured at all (both sources null) does not gate anything', () => {
  const unmeasurable = { wallMs: 1000, measured: false, deniedMsPerSec: null };
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, unmeasurable), VERDICT.PASS,
    '"could not tell if there was load" must fall back to the ordinary verdict, not force not-measured — '
    + 'otherwise a container with no /proc/stat steal and no cgroup access would report not-measured on '
    + 'every timed check forever, which is the abort criterion this house named for this exact guard');
});

test('non-time-based verdicts are structurally untouched: biasVerdict takes no load parameter at all', () => {
  // The other half of "nicht-zeitbasierte Pruefungen bleiben unberuehrt":
  // this function, which grades every `real.shape.*` comparison, has one
  // parameter. If a future edit threads foreign load into it, this
  // arity pin breaks and says exactly why.
  assert.equal(biasVerdict.length, 1);
  // And its answer for a fixed ratio cannot depend on load, because load
  // is not even in scope here.
  assert.equal(biasVerdict(1.2), VERDICT.PASS);
  assert.equal(biasVerdict(2), VERDICT.DEGRADED);
  assert.equal(biasVerdict(10), VERDICT.FAIL);
});

test('foreignLoadDelta: arithmetic is a straightforward rate, not a guess', () => {
  const before = { atMs: 0, stealTicks: 100, cgroup: { source: 'cgroup1', throttledUsec: 0, nrThrottled: 0 } };
  // +50 steal ticks over 2000 ms wall time, at the machine's own CLK_TCK
  // (typically 100 on Linux, read via `getconf CLK_TCK` inside core.mjs
  // rather than assumed) — at 100 ticks/s that is 500 ms of steal over
  // 2 s of wall time, i.e. 250 ms/s.
  const after = {
    atMs: 2000, stealTicks: 150, cgroup: { source: 'cgroup1', throttledUsec: 300000, nrThrottled: 2 },
  };
  const delta = foreignLoadDelta(before, after);
  assert.equal(delta.wallMs, 2000);
  assert.equal(delta.stealTicks, 50);
  assert.equal(delta.cgroupThrottledUsec, 300000);
  assert.equal(delta.cgroupNrThrottled, 2);
  assert.equal(delta.cgroupMs, 300); // 300000 us -> 300 ms
  assert.ok(delta.measured);
  // steal contributes stealTicks*1000/CLK_TCK ms; cgroup contributes 300ms;
  // summed and divided by wallMs/1000 seconds. Rather than hard-code an
  // assumed CLK_TCK, check consistency: deniedMsPerSec * (wallMs/1000)
  // must equal stealMs + cgroupMs to within rounding.
  const totalDeniedMs = delta.deniedMsPerSec * (delta.wallMs / 1000);
  assert.ok(Math.abs(totalDeniedMs - (delta.stealMs + delta.cgroupMs)) < 0.1,
    `rate must reconstruct the sum of both sources; got stealMs=${delta.stealMs} cgroupMs=${delta.cgroupMs} `
    + `deniedMsPerSec=${delta.deniedMsPerSec}`);
});

test('foreignLoadDelta: a source that could not be read on either side is null, never 0', () => {
  const before = { atMs: 0, stealTicks: null, cgroup: null };
  const after = { atMs: 1000, stealTicks: null, cgroup: null };
  const delta = foreignLoadDelta(before, after);
  assert.equal(delta.stealTicks, null);
  assert.equal(delta.cgroupThrottledUsec, null);
  assert.equal(delta.measured, false);
  assert.equal(delta.deniedMsPerSec, null,
    '"nicht messbar ist nicht null" — an unreadable source must not silently score as zero foreign load');
});

test('foreignLoadDelta: the cgroup hierarchy changing between snapshots is treated as unmeasured, not subtracted', () => {
  const before = { atMs: 0, stealTicks: 0, cgroup: { source: 'cgroup1', throttledUsec: 1000, nrThrottled: 1 } };
  const after = { atMs: 1000, stealTicks: 0, cgroup: { source: 'cgroup2', throttledUsec: 50, nrThrottled: 0 } };
  const delta = foreignLoadDelta(before, after);
  assert.equal(delta.cgroupThrottledUsec, null);
  assert.equal(delta.cgroupNrThrottled, null);
  assert.equal(delta.cgroupSource, null);
});

// --- the new sensors: PSI and the calibration loop ----------------------
//
// The gating tests below still inject through the `load` PARAMETER
// `timeVerdictUnderLoad` takes (this house's rule for sabotage probes —
// see the file header), now exercising the two NEW independent fields
// (`psiMsPerSec`, `calibOverThreshold`) the same way the original tests
// above exercise `deniedMsPerSec`. Real-sensor behaviour (does PSI
// actually see contention steal and cgroup cannot; does a corrupted
// baseline capture actually get caught) is proven further down with
// real spawned processes, because a fabricated object can only prove
// the gate reacts to a number, never that the number is the right one.

/** A `foreignLoadDelta()`-shaped object naming exactly ONE signal as over threshold, all others quiet — for testing that each signal gates independently. */
function fakeLoadOn(signal, value) {
  const base = {
    wallMs: 1000,
    stealTicks: 0,
    stealMs: 0,
    cgroupSource: 'cgroup1',
    cgroupThrottledUsec: 0,
    cgroupNrThrottled: 0,
    cgroupMs: 0,
    deniedMsPerSec: 0,
    psiMs: 0,
    psiMsPerSec: 0,
    calibMs: 5.5,
    calibBaselineMs: 5.5,
    calibBaselineTrustworthy: true,
    calibRatio: 1,
    calibOverThreshold: false,
    measured: true,
  };
  if (signal === 'stealCgroup') return { ...base, deniedMsPerSec: value };
  if (signal === 'psi') return { ...base, psiMsPerSec: value };
  if (signal === 'calib') {
    return {
      ...base, calibMs: 5.5 * value, calibRatio: value, calibOverThreshold: value > CALIBRATION_LOAD_FACTOR,
    };
  }
  throw new Error(`unknown signal ${signal}`);
}

test('ROT: PSI alone, over threshold, forces not-measured even with steal/cgroup and the calibration loop quiet', () => {
  const load = fakeLoadOn('psi', FOREIGN_LOAD_DENIED_MS_PER_SEC * 5);
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, load), VERDICT.NOT_MEASURED);
});

test('GRUEN (positive control): the same PSI-only load object, with PSI quiet, passes', () => {
  const load = fakeLoadOn('psi', 0);
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, load), VERDICT.PASS);
});

test('ROT: the calibration loop alone, over its own baseline by more than CALIBRATION_LOAD_FACTOR, forces not-measured', () => {
  const load = fakeLoadOn('calib', CALIBRATION_LOAD_FACTOR * 2);
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, load), VERDICT.NOT_MEASURED);
});

test('GRUEN (positive control): the same calibration-ratio object, at 1.0x baseline, passes', () => {
  const load = fakeLoadOn('calib', 1.0);
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, load), VERDICT.PASS);
});

test('a calibration ratio exactly AT CALIBRATION_LOAD_FACTOR still passes (the gate is "over", not "at or over")', () => {
  assert.equal(
    timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, fakeLoadOn('calib', CALIBRATION_LOAD_FACTOR)),
    VERDICT.PASS,
  );
  assert.equal(
    timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, fakeLoadOn('calib', CALIBRATION_LOAD_FACTOR + 0.01)),
    VERDICT.NOT_MEASURED,
  );
});

test('decision #2: PSI unreadable (null) does not force not-measured, and does not hide a real reading from another signal', () => {
  const psiUnreadableButQuiet = {
    ...fakeLoadOn('psi', 0), psiMsPerSec: null,
  };
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, psiUnreadableButQuiet), VERDICT.PASS,
    'PSI reading null (unreadable here) must fall back to the other signals, not force not-measured on its own');

  const psiUnreadableButCalibOver = {
    ...fakeLoadOn('calib', CALIBRATION_LOAD_FACTOR * 2), psiMsPerSec: null,
  };
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, psiUnreadableButCalibOver), VERDICT.NOT_MEASURED,
    'PSI being unreadable must not suppress a genuine over-threshold reading from the calibration loop');
});

test('decision #3: steal+cgroup are kept and still gate on their own, unaffected by the new signals', () => {
  // Backward-compatibility pin: the pre-existing `fakeLoad()` helper
  // (steal/cgroup only, no psi/calib fields at all) must still gate
  // exactly as it did before this fix — old callers that never learn
  // about the new fields are not silently weakened.
  assert.equal(
    timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, fakeLoad(FOREIGN_LOAD_DENIED_MS_PER_SEC * 5)),
    VERDICT.NOT_MEASURED,
  );
});

test('all three signals over threshold at once still yields exactly one not-measured, never a crash from double-gating', () => {
  const load = {
    ...fakeLoadOn('stealCgroup', FOREIGN_LOAD_DENIED_MS_PER_SEC * 3),
    psiMsPerSec: FOREIGN_LOAD_DENIED_MS_PER_SEC * 3,
    calibRatio: CALIBRATION_LOAD_FACTOR * 3,
    calibOverThreshold: true,
  };
  assert.equal(timeVerdictUnderLoad(50, DEGRADED_AT, FAIL_AT, load), VERDICT.NOT_MEASURED);
});

test('readCpuStealTicks and readCgroupThrottle each return a number/object or null, never throw', () => {
  // This is the third state in practice: whatever this container can or
  // cannot expose, the reader must say so cleanly rather than crash the
  // whole phase over a missing /proc or /sys/fs/cgroup path.
  const steal = readCpuStealTicks();
  assert.ok(steal === null || (typeof steal === 'number' && Number.isFinite(steal)));
  const throttle = readCgroupThrottle();
  if (throttle !== null) {
    assert.ok(['cgroup1', 'cgroup2'].includes(throttle.source));
    assert.equal(typeof throttle.throttledUsec, 'number');
    assert.equal(typeof throttle.nrThrottled, 'number');
  }
});

test('captureForeignLoad -> foreignLoadDelta round-trips on THIS machine without throwing, over a real (tiny) interval', () => {
  const before = captureForeignLoad();
  // Busy-wait a couple of milliseconds so wallMs > 0 without pulling in
  // a sleep primitive — this is not a load simulation, just a
  // non-zero-duration window for the round trip.
  const until = Date.now() + 5;
  while (Date.now() < until) { /* spin briefly */ }
  const after = captureForeignLoad();
  const delta = foreignLoadDelta(before, after);
  assert.ok(delta.wallMs >= 0);
  // On THIS container idle steal/throttle deltas are expected to be 0 or
  // null, never negative — a negative delta would mean the counters were
  // misread (e.g. wrapped or read from two different cgroups).
  if (delta.stealTicks !== null) assert.ok(delta.stealTicks >= 0);
  if (delta.cgroupThrottledUsec !== null) assert.ok(delta.cgroupThrottledUsec >= 0);
});

test('readPsiCpuSomeTotal and readPsiCpuSomeAvg10 each return a number or null, never throw', () => {
  const total = readPsiCpuSomeTotal();
  assert.ok(total === null || (typeof total === 'number' && Number.isFinite(total) && total >= 0));
  const avg10 = readPsiCpuSomeAvg10();
  assert.ok(avg10 === null || (typeof avg10 === 'number' && Number.isFinite(avg10) && avg10 >= 0));
});

test('calibrationLoopMs returns a positive, finite, small number of milliseconds', () => {
  const ms = calibrationLoopMs();
  assert.ok(Number.isFinite(ms) && ms > 0, `expected a positive finite ms, got ${ms}`);
  // Generous ceiling: this is a fixed unit of work meant to run in single-
  // digit milliseconds on an idle core; even heavily contended it should
  // not run for full seconds inside one test's own budget.
  assert.ok(ms < 2000, `calibration loop took implausibly long (${ms} ms) — iteration count may need retuning`);
});

test('captureCalibrationBaselineOnce on THIS (idle) machine reports a trustworthy baseline', () => {
  const baseline = captureCalibrationBaselineOnce();
  assert.equal(baseline.reps, 5);
  assert.ok(Number.isFinite(baseline.medianMs) && baseline.medianMs > 0);
  assert.ok(Number.isFinite(baseline.spreadRatio) && baseline.spreadRatio >= 1);
  // A genuinely flaky assertion would be "always trustworthy on any CI
  // box" — this is instead the GRUEN half of the baseline-corruption
  // pair below: on an otherwise-idle machine (this suite's own default
  // condition, not a claim about every possible CI runner) capture
  // should succeed cleanly. If this ever flakes on a shared CI runner,
  // that is itself useful evidence about the runner, not a reason to
  // weaken the check the ROT test below depends on.
  assert.equal(baseline.trustworthy, true,
    `expected an idle-machine baseline capture to be trustworthy; got ${JSON.stringify(baseline)}`);
});

test('captureQuietCalibrationBaseline reports attempts and never exceeds maxAttempts', () => {
  const baseline = captureQuietCalibrationBaseline({ maxAttempts: 2 });
  assert.ok(baseline.attempts >= 1 && baseline.attempts <= 2);
  assert.equal(baseline.gaveUp, !baseline.trustworthy);
});

test('decision #1, ROT: a baseline captured WHILE under real load is flagged, not silently accepted', { timeout: 20000 }, () => {
  const cpuCount = os.cpus().length || 4;
  const fressers = spawnCpuFressers(cpuCount * 2);
  try {
    execFileSync('sleep', ['1.5']); // let the fressers actually ramp up
    const baseline = captureCalibrationBaselineOnce();
    assert.equal(baseline.trustworthy, false,
      `a baseline captured under ${cpuCount * 2} CPU fressers on ${cpuCount} cores must not be accepted as `
      + `quiet — got ${JSON.stringify(baseline)}`);
    assert.ok(!baseline.internallyStable || baseline.psiQuiet === false,
      'a corrupted capture must be caught by internal rep-to-rep disagreement, PSI\'s avg10, or both — '
      + 'not silently pass both checks');
  } finally {
    killAll(fressers);
  }
});

test('decision #1, GRUEN (positive control): captureQuietCalibrationBaseline recovers once the load is gone', { timeout: 20000 }, () => {
  // Same machine, no fressers this time — proves the check above is not
  // simply broken/always-false; it responds to the actual condition.
  const baseline = captureQuietCalibrationBaseline();
  assert.equal(baseline.trustworthy, true,
    `expected recovery to a trustworthy baseline once no load is present; got ${JSON.stringify(baseline)}`);
});

test('ROT (the real finding this whole fix answers): under 2x-oversubscribed real CPU load, the OLD sensors '
  + '(steal + cgroup) stay blind while the NEW sensors correctly force not-measured', { timeout: 30000 }, () => {
  const cpuCount = os.cpus().length || 4;
  const fressers = spawnCpuFressers(cpuCount * 2);
  try {
    execFileSync('sleep', ['1.5']); // ramp-up, matching the brief's own measurement method
    const calibBaseline = captureQuietCalibrationBaseline(); // captured before the timed window, per B3
    const before = captureForeignLoad(calibBaseline);
    // A longer window than the "0.2s" a real timed CLI call might take, deliberately: a single
    // stray host-level steal tick (this sandbox itself sits on a shared host, so a tick every
    // so often is real, not a bug) produces a LARGE rate over a short window and a small one over
    // a longer window — this dilutes that noise without hiding the sustained load under test.
    execFileSync('sleep', ['1.5']); // stand-in for a timed CLI call running while the fressers churn
    const after = captureForeignLoad(calibBaseline);
    const load = foreignLoadDelta(before, after, calibBaseline);

    // This is the exact bug reported: steal + cgroup read close to zero
    // even while the machine is genuinely, heavily contended. Documented
    // as a fact about this container's sensors, not asserted away.
    assert.ok((load.deniedMsPerSec ?? 0) < FOREIGN_LOAD_DENIED_MS_PER_SEC,
      `expected the OLD sensors to stay under threshold in this container even under real load `
      + `(this is the bug the fix answers) — got deniedMsPerSec=${load.deniedMsPerSec}`);

    // The new sensors must catch what the old ones missed: EITHER PSI or
    // the calibration loop (or, if the baseline capture itself could not
    // stay trustworthy under this much sustained contention, that is
    // reported too — checked below) must show the load.
    const newSensorsCaughtIt = (load.psiMsPerSec !== null && load.psiMsPerSec > FOREIGN_LOAD_DENIED_MS_PER_SEC)
      || load.calibOverThreshold === true;
    assert.ok(newSensorsCaughtIt,
      `expected PSI or the calibration loop to detect real load that steal/cgroup missed — got ${JSON.stringify({
        psiMsPerSec: load.psiMsPerSec, calibRatio: load.calibRatio, calibOverThreshold: load.calibOverThreshold,
      })}`);

    // The end-to-end effect this whole apparatus exists for: a fast
    // (comfortably-under-threshold) measurement must come back
    // not-measured, never a false pass, while this load is present.
    const verdict = timeVerdictUnderLoad(10, DEGRADED_AT, FAIL_AT, load);
    assert.equal(verdict, VERDICT.NOT_MEASURED,
      `a fast, otherwise-passing measurement must be not-measured under real foreign load — got ${verdict}`);
  } finally {
    killAll(fressers);
  }
});

test('GRUEN (positive control): the identical real measurement, with the fressers gone, passes cleanly', { timeout: 20000 }, () => {
  const calibBaseline = captureQuietCalibrationBaseline();
  const before = captureForeignLoad(calibBaseline);
  execFileSync('sleep', ['1.5']); // same longer window as the ROT test above, for the same reason
  const after = captureForeignLoad(calibBaseline);
  const load = foreignLoadDelta(before, after, calibBaseline);
  const verdict = timeVerdictUnderLoad(10, DEGRADED_AT, FAIL_AT, load);
  assert.equal(verdict, VERDICT.PASS,
    `a guard that never comes back green on a genuinely quiet run is not measuring anything — got ${verdict}, `
    + `load=${JSON.stringify(load)}`);
});

test('an unrelated, non-time-based check is untouched by real load: biasVerdict never sees a load argument', () => {
  // The "unschuldiger" probe from the brief, restated with the real
  // sensors in scope: real.shape.* comparisons go through `biasVerdict`,
  // which — per the arity pin above — cannot even receive a load value,
  // so no amount of real contention changes its answer for a fixed ratio.
  const cpuCount = os.cpus().length || 4;
  const fressers = spawnCpuFressers(cpuCount * 2);
  try {
    execFileSync('sleep', ['0.5']);
    assert.equal(biasVerdict(1.2), VERDICT.PASS);
    assert.equal(biasVerdict(2), VERDICT.DEGRADED);
  } finally {
    killAll(fressers);
  }
});
