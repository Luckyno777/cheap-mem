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
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERDICT, timeVerdict, timeVerdictUnderLoad, foreignLoadDelta, captureForeignLoad,
  readCpuStealTicks, readCgroupThrottle, FOREIGN_LOAD_DENIED_MS_PER_SEC,
} from '../bench/atlas/core.mjs';
import { biasVerdict } from '../bench/atlas/phase-real.mjs';

const DEGRADED_AT = 1000;
const FAIL_AT = 5000;

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
