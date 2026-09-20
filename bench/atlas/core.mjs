// bench/atlas/core.mjs — the measuring apparatus for the full-surface atlas.
//
// **What this is for.** `bench/` already holds two dozen honest probes,
// each printing for itself. What was missing is ONE structure: a run that
// touches the whole surface, records every measurement in the same shape,
// and can be compared against the run before it. Without that, "is the
// memory getting better or worse" is a matter of opinion.
//
// **Four verdicts, never two.** Every record carries `pass`, `fail`,
// `degraded` or `not-measured`. The fourth one is the important one: a
// check that could not run is NOT a pass. A harness that silently drops
// what it cannot reach reports a clean bill of health for a system it
// never looked at — the exact failure this house calls "empty green".
//
// **Nothing here decides what is good.** A record states what was
// measured and what was expected; the report prints both. Thresholds live
// with the phase that owns them, in the open, so a later reader can
// disagree with the threshold without having to re-derive the number.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TYPES as memoryTypes } from '../../src/memory.mjs';
import { CACHE_DIR } from '../../src/search.mjs';

// Re-exported so every phase file imports the search-cache path from ONE
// place (this module already imports it from `src/search.mjs`, its
// canonical source) rather than each phase hardcoding
// `.mem/search-index` a second time. B8 (2026-09-20) moved the cache
// from a single file (the retired `CACHE_FILE`) to this directory of
// shards; see `src/search.mjs` and `src/indexcache.mjs` for why.
export { CACHE_DIR };

/** `manifest.json`'s name within `CACHE_DIR` — small, always present on
 * an intact cache (see `src/indexcache.mjs`'s module doc), absent or
 * unreadable on a cold, torn or missing one. Not exported from
 * `src/indexcache.mjs` itself (it is a `readIndexCache`/`writeIndexCache`
 * implementation detail there), so it is named once, here, rather than
 * spelled out as a string literal at every call site. */
const MANIFEST_FILE = 'manifest.json';

export const SCHEMA_VERSION = 1;

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const MEM = path.join(REPO, 'bin', 'mem');

/** The four states. A harness that only knows two lies about the third. */
export const VERDICT = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  DEGRADED: 'degraded',
  NOT_MEASURED: 'not-measured',
});

/** Severity for findings. Ordered, so a report can sort by it. */
export const SEVERITY = Object.freeze({
  CRITICAL: 'critical',   // wrong answers, data loss, boundary crossed
  MAJOR: 'major',         // a guarantee the docs make does not hold
  MINOR: 'minor',         // works, but worse than documented
  INFO: 'info',           // measured, worth recording, no claim broken
});

// --- timing -----------------------------------------------------------
//
// Percentiles, not averages. An average hides the tail, and the tail is
// where a memory system becomes unusable — one query in twenty taking two
// seconds is felt, a mean of 90 ms is not.

/** Nearest-rank percentile. Empty input gives null, never 0. */
export function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

/**
 * Run `fn` `n` times and report the distribution.
 *
 * `warmup` runs are executed and thrown away: the first call through any
 * path in this codebase pays for module loading, index building and a cold
 * file cache, and mixing that into a latency distribution makes p50 a
 * measurement of Node's startup instead of the code under test. The warmup
 * count is reported, so nobody has to guess whether it happened.
 */
export function timeIt(fn, { n = 20, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i += 1) { try { fn(i); } catch { /* warmup may fail */ } }
  const ms = [];
  let errors = 0;
  let lastError = null;
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    try { fn(i); } catch (e) { errors += 1; lastError = String(e && e.message).slice(0, 300); }
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const s = [...ms].sort((a, b) => a - b);
  return {
    n, warmup, errors: errors, lastError: lastError,
    min: s[0] ?? null, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99),
    max: s[s.length - 1] ?? null,
    mean: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
  };
}

/**
 * Peak heap across a call, in MB.
 *
 * `process.memoryUsage()` is sampled before and after plus on a timer,
 * because a build that allocates and frees inside one synchronous call
 * shows nothing at the edges. The timer cannot fire during synchronous
 * work, so for sync code this degrades to before/after — and says so via
 * `sampled`, rather than presenting a single sample as a peak.
 */
export function heapAround(fn, { everyMs = 5 } = {}) {
  // `globalThis`, not `global`: the latter is a Node-only alias this repo
  // lints against, and a benchmark that cannot be linted is a benchmark
  // nobody keeps clean.
  if (globalThis.gc) { try { globalThis.gc(); } catch { /* --expose-gc not on */ } }
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  let samples = 1;
  const t = setInterval(() => {
    samples += 1;
    const h = process.memoryUsage().heapUsed;
    if (h > peak) peak = h;
  }, everyMs);
  let value; let failure = null;
  try { value = fn(); } catch (e) { failure = e; }
  clearInterval(t);
  const after = process.memoryUsage().heapUsed;
  if (after > peak) peak = after;
  if (failure) throw failure;
  return {
    value: value,
    beforeMB: +(before / 1048576).toFixed(2),
    peakMB: +(peak / 1048576).toFixed(2),
    deltaMB: +((peak - before) / 1048576).toFixed(2),
    sampled: samples,
    // Honest about the limit: with one sample the peak is the endpoint,
    // not a peak. A reader must be able to tell those apart.
    peakIsEndpointOnly: samples <= 2,
  };
}

// --- foreign load: steal, cgroup throttling, PSI, and a calibration loop
//
// **Why not `os.loadavg()`.** Load average rises when a process is
// waiting on disk or network just as readily as when it is waiting for a
// CPU another tenant is using, so a load-average-based guard cannot tell
// "this machine is slow because of us" from "this machine is slow because
// of something else".
//
// **The finding that made this section four sensors instead of two
// (2026-09-20).** CPU steal (time a hypervisor gave to another guest
// instead of this one) and cgroup CFS throttling (time this cgroup was
// runnable but had already spent its quota for the period) both measure
// DENIED compute directly, attributed to a specific decider — but both
// are blind to the exact load that motivated this apparatus. Steal only
// counts time a HYPERVISOR gave to another VM GUEST; a sibling process in
// the SAME container competing for the SAME cores steals nothing by that
// definition, so it reads a real, honestly-measured 0 while the CPU is
// fully contended. cgroup throttling only fires once a QUOTA is set on
// `cpu.cfs_quota_us`; a container with no quota (this one, and many
// others) never throttles no matter how contended its cores are, so it
// too reads a real, honestly-measured 0. Verified here: 8 CPU-bound
// processes pinned against 4 cores in this exact container measured
// 0.00 ms/s on both — a genuinely correct reading of the wrong question.
// `readCpuStealTicks` and `readCgroupThrottle` are kept below (a real VM
// guest sharing a host with noisy neighbours DOES generate steal, and a
// cgroup with a quota DOES throttle, so the signal is real where it
// applies) but neither is trusted as the SOLE gate any more — see
// `FOREIGN_LOAD_DENIED_MS_PER_SEC`'s doc comment for the two sensors
// that now carry the actual detection: PSI and a fixed calibration loop.
//
// Where a container exposes none of the four signals at all, the honest
// answer is `not-measured`, never `0` — a `0` here would claim "no
// foreign load" about a quantity nobody could read. Where SOME signals
// are readable and others are not, only the unreadable ones say
// `not-measured` for themselves (see `readPsiCpuSomeTotal`'s doc
// comment) — a phase must not go blind for every signal just because one
// of four could not be read here.
//
// All readers below are plain `fs.readFileSync` over `/proc` and
// `/sys/fs/cgroup`, never a spawned tool, so a phase can snapshot them on
// either side of a slow measurement at effectively zero cost — except the
// calibration loop, which is itself a few milliseconds of real CPU work
// by construction (see its own doc comment for why that cost is paid
// deliberately, and kept small).

/**
 * CPU ticks stolen from this host's view of the CPU since boot, summed
 * across all CPUs (`/proc/stat`'s top `cpu ` line, the field named
 * `steal` — the 8th number after the `cpu` label: user, nice, system,
 * idle, iowait, irq, softirq, **steal**, guest, guest_nice).
 *
 * `null` when `/proc/stat` cannot be read or does not carry a `steal`
 * field at all (pre-2.6.11 kernels, or a `/proc` this process cannot
 * see) — a container that hides this number gets `not-measured`
 * downstream, not a silent zero.
 */
export function readCpuStealTicks() {
  try {
    const firstLine = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
    const parts = firstLine.trim().split(/\s+/);
    if (parts[0] !== 'cpu' || parts.length < 9) return null;
    const steal = Number(parts[8]);
    return Number.isFinite(steal) ? steal : null;
  } catch {
    return null;
  }
}

// Ticks-per-second, read once via `getconf` rather than assumed: the
// conversion from steal TICKS to steal MILLISECONDS depends on it, and
// hard-coding 100 would be quietly wrong on the rare kernel built with a
// different `CONFIG_HZ`. 100 is kept as the fallback because it is the
// value on every machine this codebase has run on (verified here via
// `getconf CLK_TCK` on 2026-09-20, cheap-mem's own container: 100).
let clkTckCache = null;
function clockTicksPerSecond() {
  if (clkTckCache !== null) return clkTckCache;
  try {
    const out = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim();
    const n = parseInt(out, 10);
    clkTckCache = Number.isFinite(n) && n > 0 ? n : 100;
  } catch {
    clkTckCache = 100;
  }
  return clkTckCache;
}

/** First mountpoint of filesystem type `fstype`, optionally requiring `optionToken` among its mount options. `null` if none matches or `/proc/mounts` cannot be read. */
function firstMountpoint(fstype, optionToken) {
  try {
    const lines = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    for (const line of lines) {
      const fields = line.split(' ');
      const [, mnt, fst, opts] = fields;
      if (!mnt || fst !== fstype) continue;
      if (optionToken && !(opts ?? '').split(',').includes(optionToken)) continue;
      return mnt;
    }
  } catch { /* no /proc/mounts to read */ }
  return null;
}

/**
 * This process's own cgroup path for one hierarchy, from `/proc/self/cgroup`.
 * `controllerToken === null` asks for the unified (cgroup v2) line, which
 * `/proc/self/cgroup` always writes as `0::<path>`; otherwise it asks for
 * the v1 hierarchy whose controller list contains `controllerToken`.
 */
function ownCgroupPath(controllerToken) {
  try {
    const lines = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n');
    for (const line of lines) {
      const [hierId, controllers, sub] = line.split(':');
      if (sub === undefined) continue;
      if (controllerToken === null) {
        if (hierId === '0' && controllers === '') return sub;
      } else if ((controllers ?? '').split(',').includes(controllerToken)) {
        return sub;
      }
    }
  } catch { /* no /proc/self/cgroup to read */ }
  return null;
}

function parseKeyValueFile(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    if (sp < 0) continue;
    out[t.slice(0, sp)] = Number(t.slice(sp + 1));
  }
  return out;
}

/**
 * This process's cgroup CPU throttling counters, cgroup v2 first (where
 * the cpu controller is enabled on this cgroup, `cpu.stat` carries
 * `throttled_usec`/`nr_throttled` directly), falling back to cgroup v1
 * (`cpu.stat` carries `throttled_time` in NANOSECONDS instead, converted
 * to microseconds here so callers never have to know which hierarchy
 * answered). `null` when neither hierarchy is mounted, reachable, or
 * carries throttling fields at all — e.g. this repo's own dev container,
 * where the v2 leaf has no `cpu.max` and the v1 leaf reports real numbers
 * only once something actually sets a quota (see the derivation on
 * `FOREIGN_LOAD_DENIED_MS_PER_SEC` below for what that container showed
 * once a quota was set for the experiment).
 */
export function readCgroupThrottle() {
  const v2Mount = firstMountpoint('cgroup2', null);
  const v2Sub = ownCgroupPath(null);
  if (v2Mount && v2Sub !== null) {
    try {
      const kv = parseKeyValueFile(path.join(v2Mount, v2Sub, 'cpu.stat'));
      if (Number.isFinite(kv.throttled_usec) && Number.isFinite(kv.nr_throttled)) {
        return { source: 'cgroup2', throttledUsec: kv.throttled_usec, nrThrottled: kv.nr_throttled };
      }
    } catch { /* try v1 below */ }
  }
  const v1Mount = firstMountpoint('cgroup', 'cpu');
  const v1Sub = ownCgroupPath('cpu');
  if (v1Mount && v1Sub !== null) {
    try {
      const kv = parseKeyValueFile(path.join(v1Mount, v1Sub, 'cpu.stat'));
      if (Number.isFinite(kv.throttled_time) && Number.isFinite(kv.nr_throttled)) {
        return { source: 'cgroup1', throttledUsec: kv.throttled_time / 1000, nrThrottled: kv.nr_throttled };
      }
    } catch { /* neither hierarchy readable */ }
  }
  return null;
}

/**
 * Read one numeric field off the `some` line of `/proc/pressure/cpu`
 * (Pressure Stall Information — Linux 4.20+, `CONFIG_PSI=y`, mounted at
 * `/proc/pressure` when the kernel supports it). The `some` line covers
 * time where AT LEAST ONE runnable task on this cgroup/host was stalled
 * waiting for CPU — exactly "CPU time wanted and not given", the same
 * quantity steal and cgroup throttling measure, but read from the
 * scheduler's own stall accounting instead of a hypervisor's or a
 * quota's counter, so it sees contention neither of those two can:
 * ordinary sibling processes on the same cores, with no quota in play.
 *
 * Shared by the two exported readers below via the field's own regex,
 * so a caller never parses `/proc/pressure/cpu` by hand. `null` when the
 * file cannot be read (PSI not compiled in, not mounted, or a
 * permission this container does not have) or the `some` line does not
 * carry the requested field — matching `readCpuStealTicks` and
 * `readCgroupThrottle` above: a container that hides this gets
 * `not-measured` for PSI specifically, never a silent zero.
 */
function readPsiCpuSomeField(fieldRegex) {
  try {
    const text = fs.readFileSync('/proc/pressure/cpu', 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('some '));
    if (!line) return null;
    const m = line.match(fieldRegex);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The `some` line's `total=` field: cumulative MICROSECONDS of CPU stall
 * since PSI accounting started for this cgroup, monotonic like
 * `/proc/stat`'s steal field above — callers take two snapshots and
 * DIFFERENCE them (see `foreignLoadDelta`), never read this as a rate on
 * its own.
 */
export function readPsiCpuSomeTotal() {
  return readPsiCpuSomeField(/\btotal=(\d+)\b/);
}

/**
 * The `some` line's `avg10=` field: the kernel's own decaying 10-second
 * average of stall time, as a percentage (0-100, though PSI defines it
 * per-cgroup so in principle it can read slightly differently than a
 * simple percentage of one core). Read as an INSTANTANEOUS snapshot, not
 * a total to difference — used only to sanity-check that a moment was
 * quiet (`captureCalibrationBaselineOnce` below, when taking the
 * calibration loop's baseline), never as this phase's own load gate: a
 * 10-second decaying average lags a real event by design, while the
 * cumulative `total=` field differenced over the phase's own window
 * tracks that window exactly.
 */
export function readPsiCpuSomeAvg10() {
  return readPsiCpuSomeField(/\bavg10=([\d.]+)\b/);
}

// --- foreign load: a fixed calibration loop against its own baseline ---
//
// **Why this is the recommended primary signal.** Steal and cgroup
// throttling are blind exactly where this container's own load is
// (see above), and PSI needs `/proc/pressure` to exist and be readable
// at all. A calibration loop needs neither: it is ordinary synchronous
// JavaScript, timed with `process.hrtime.bigint()`, so it runs — and
// means the same thing — on any machine that can run this benchmark at
// all. It also measures the actual quantity a TIME-BASED check cares
// about directly: "how much slower is a fixed amount of work right now",
// rather than an amount of denied compute this file must then translate
// into a slowdown by assumption.
const CALIBRATION_LOOP_UNREACHABLE = 'unreachable: calibration loop produced NaN';

/**
 * Iteration count for `calibrationLoopMs()`, tuned so the loop takes
 * roughly 5.5 ms on an idle core of this repo's own dev container
 * (measured 2026-09-20: 7 warmed-up reps at this count landed at
 * 5.45-5.69 ms, ratio of max/min 1.04 — see `CALIBRATION_BASELINE_MAX_SPREAD_RATIO`
 * below for why that number is the basis for detecting a corrupted
 * baseline capture). Chosen to resemble the ~5.4 ms unit of work
 * `FOREIGN_LOAD_DENIED_MS_PER_SEC`'s own derivation experiment used,
 * for the same reason that derivation gives: short enough to run
 * before/after a phase's timed section at negligible cost, long enough
 * that `process.hrtime.bigint()`'s own resolution does not dominate it.
 */
export const CALIBRATION_LOOP_ITERATIONS = 400000;

/**
 * A fixed, purely CPU-bound synchronous unit of work — arithmetic plus
 * occasional small string building, no timers, no I/O, no allocation
 * pattern heavy enough to make GC pauses the dominant cost — timed with
 * `process.hrtime.bigint()`. Its wall time is this container's ground
 * truth for "how much slower is fixed work right now": unlike steal or
 * cgroup throttling, it cannot read as a false 0 while the CPU is
 * genuinely contended, because it does not ask the hypervisor or the
 * quota what happened — it simply does the work and times how long that
 * took.
 *
 * `acc`'s final value is folded into a thrown-error condition that can
 * never actually be true (`NaN` cannot arise from this arithmetic) so
 * V8 cannot prove the loop's result is unused and dead-code-eliminate
 * it — a loop the engine is free to skip measures nothing.
 */
export function calibrationLoopMs() {
  const t0 = process.hrtime.bigint();
  let acc = 0;
  for (let i = 0; i < CALIBRATION_LOOP_ITERATIONS; i += 1) {
    acc = (acc + Math.sqrt((i + 1) * 1.0000001)) % 104729;
    if ((i & 1023) === 0) acc += JSON.stringify({ i, acc }).length;
  }
  if (Number.isNaN(acc)) throw new Error(CALIBRATION_LOOP_UNREACHABLE);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/**
 * How many times worse than its own quiet baseline the calibration loop
 * may run before a time-based check is no longer trusted — the same
 * 20 % bound `FOREIGN_LOAD_DENIED_MS_PER_SEC` restates for steal and
 * cgroup, applied here to a ratio instead of a rate: 1.2 IS "at least
 * 20 % slower than this machine's own idle self".
 */
export const CALIBRATION_LOAD_FACTOR = 1.2;

/**
 * How much the calibration loop's own repeated timings, taken back to
 * back while capturing a baseline, may disagree with each other before
 * that CAPTURE is judged to have happened on a machine too busy to
 * trust as "quiet" — see `captureCalibrationBaselineOnce`'s doc comment
 * for why this matters as much as the load threshold itself. 1.15 sits
 * above the idle spread measured here (1.04, seven reps, 2026-09-20) and
 * below `CALIBRATION_LOAD_FACTOR` (1.2), so an ordinary idle capture
 * passes with margin while a capture contaminated by real load — which
 * would show the same kind of spread the loaded-run ROT probe measured
 * (baseline reps swinging between roughly idle and roughly loaded
 * timings) — is caught before it can poison every later comparison.
 */
export const CALIBRATION_BASELINE_MAX_SPREAD_RATIO = 1.15;

/** Default rep count for one baseline capture attempt — enough for a median and a spread check without materially adding to a phase's own runtime (5 reps at ~5.5 ms is ~28 ms). */
export const CALIBRATION_BASELINE_REPS = 5;

/** Default number of throwaway warm-up reps before a baseline capture is measured — the FIRST call through `calibrationLoopMs()` in a process pays JIT warm-up cost the rest do not (measured here: 4.98 ms first call vs 0.6-0.7 ms steady state at a ten-times-smaller iteration count used only for that check), and mixing that into the baseline would inflate it for a reason that has nothing to do with foreign load. */
export const CALIBRATION_BASELINE_WARMUP = 1;

/** Default number of baseline-capture attempts before giving up and reporting the calibration signal itself as unavailable for this run — see `captureQuietCalibrationBaseline`'s doc comment for what "giving up" means and why it is not the dead-line failure this house watches for. */
export const CALIBRATION_BASELINE_MAX_ATTEMPTS = 3;

/**
 * One attempt at capturing this run's "quiet baseline" for the
 * calibration loop: `warmup` throwaway reps, then `reps` measured reps,
 * their median taken as the baseline itself.
 *
 * **The problem this solves (decision named in the brief this fix
 * answers).** A baseline taken once, unconditionally, at the start of a
 * run is cheap — but if the machine is ALREADY busy at that moment, the
 * baseline itself comes out inflated, and every later comparison against
 * it silently under-reports load forever: the exact "quiet line that
 * looks like it does something" failure this house names, just moved one
 * layer down. The fix is not to take the baseline more carefully once —
 * a single capture cannot tell "quiet" from "busy" about itself — it is
 * to make the capture SELF-CHECKING: several reps of a fixed unit of
 * work, on a genuinely quiet machine, should land within a few percent
 * of each other (measured here: max/min 1.04 over 7 reps). A machine
 * already under load produces reps that disagree with EACH OTHER, not
 * just with some external reference, because the load competing for the
 * core does not hold still between reps. `internallyStable` catches
 * that without needing to know anything about this machine in advance.
 * `psiQuiet` is a second, independent check of the same moment — belt
 * and suspenders, and useful specifically when the contamination is a
 * STEADY load that happens to keep all reps similarly slow (stable but
 * uniformly inflated), which the spread check alone cannot see.
 *
 * **`psiQuiet` uses a FRESH delta over the capture's own window, not
 * PSI's `avg10` gauge — found by this fix's own test suite.** The first
 * cut of this function used `readPsiCpuSomeAvg10()` (a kernel-computed,
 * exponentially-decaying 10-second average) as the second check. That
 * failed its own positive-control test: immediately after killing 16
 * real CPU-bound processes on this container's 4 cores, `avg10` was
 * STILL 9.17 (over the ceiling that was tried, 5) even though the
 * machine was, at that exact instant, genuinely idle again — `avg10`'s
 * decay lags real events by design (the same reason its doc comment
 * says it must never be this apparatus's own load GATE), and using it
 * here to judge "was THIS capture quiet" inherited that lag as a false
 * positive for contamination. The fix: read PSI's cumulative `total=`
 * field (see `readPsiCpuSomeTotal`) once before the reps and once after,
 * and rate-check the DELTA over the capture's own short window — the
 * exact same delta-over-a-window pattern `foreignLoadDelta` already uses
 * for the phase's real timed section, reusing `FOREIGN_LOAD_DENIED_MS_PER_SEC`
 * as the same threshold rather than inventing a second number. This
 * responds to the capture's own window only, with no memory of load
 * from moments before it — including moments the same PROCESS caused,
 * such as the loop's own JIT warm-up.
 *
 * `psiQuiet === false` is the only PSI reading allowed to veto an
 * otherwise-stable capture; `null` (PSI unreadable here) does not, or a
 * kernel without PSI would fail every baseline capture on unrelated
 * grounds and take down the one signal — the loop itself — that needs
 * no `/proc` access at all. `psiAvg10AtCapture` is still recorded, for a
 * reader's own reference, but no longer decides `trustworthy`.
 */
export function captureCalibrationBaselineOnce({
  reps = CALIBRATION_BASELINE_REPS, warmup = CALIBRATION_BASELINE_WARMUP,
} = {}) {
  const psiTotalBefore = readPsiCpuSomeTotal();
  const captureStartMs = Date.now();
  for (let i = 0; i < warmup; i += 1) calibrationLoopMs();
  const samples = [];
  for (let i = 0; i < reps; i += 1) samples.push(calibrationLoopMs());
  const captureWallMs = Date.now() - captureStartMs;
  const psiTotalAfter = readPsiCpuSomeTotal();
  const psiAvg10AtCapture = readPsiCpuSomeAvg10();

  const sorted = [...samples].sort((a, b) => a - b);
  const medianMs = pct(sorted, 50);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const spreadRatio = minMs > 0 ? maxMs / minMs : (maxMs === 0 ? 1 : Infinity);
  const internallyStable = Number.isFinite(spreadRatio) && spreadRatio <= CALIBRATION_BASELINE_MAX_SPREAD_RATIO;

  const psiOk = typeof psiTotalBefore === 'number' && typeof psiTotalAfter === 'number';
  const psiDeltaUsec = psiOk ? psiTotalAfter - psiTotalBefore : null;
  const psiRateDuringCaptureMsPerSec = psiOk && captureWallMs > 0
    ? ((psiDeltaUsec / 1000) * 1000) / captureWallMs : (psiOk ? 0 : null);
  const psiQuiet = psiRateDuringCaptureMsPerSec === null
    ? null : psiRateDuringCaptureMsPerSec <= FOREIGN_LOAD_DENIED_MS_PER_SEC;

  const trustworthy = internallyStable && psiQuiet !== false;
  return {
    reps,
    warmup,
    samples,
    medianMs,
    minMs,
    maxMs,
    spreadRatio: Number.isFinite(spreadRatio) ? +spreadRatio.toFixed(3) : null,
    psiAvg10AtCapture,
    psiRateDuringCaptureMsPerSec: psiRateDuringCaptureMsPerSec !== null
      ? +psiRateDuringCaptureMsPerSec.toFixed(2) : null,
    internallyStable,
    psiQuiet,
    trustworthy,
  };
}

/**
 * `captureCalibrationBaselineOnce`, retried up to `maxAttempts` times
 * until one attempt comes back `trustworthy`.
 *
 * **Why retry at all, and why bounded.** A single bad attempt could be a
 * moment's coincidence (a GC pause, a neighbour's brief burst); retrying
 * a few times costs almost nothing (each attempt is ~5 reps of a
 * ~5.5 ms loop) and recovers the common case for free. Bounding it
 * matters for the OTHER decision this answers: if the machine is
 * genuinely, persistently busy, every attempt will keep failing, and
 * `captureCalibrationBaselineOnce` cannot be made to declare a busy
 * machine quiet no matter how many times it is asked — so this gives up
 * after `maxAttempts` and returns the LAST attempt with `gaveUp: true`
 * rather than spinning forever. `gaveUp` is not the dead-line failure
 * this house watches for: it does not silently keep the calibration
 * signal claiming a stale or corrupted number, it hands back a baseline
 * honestly marked `trustworthy: false`, so `foreignLoadDelta` below
 * refuses to use it and the caller can report the calibration signal
 * itself as unavailable for this run — a real `not-measured`, on a
 * machine that earned it, not a permanent one: the very next run, once
 * the machine quiets down, captures cleanly again.
 */
export function captureQuietCalibrationBaseline({
  maxAttempts = CALIBRATION_BASELINE_MAX_ATTEMPTS, reps, warmup,
} = {}) {
  let attempt;
  let attempts = 0;
  do {
    attempts += 1;
    attempt = captureCalibrationBaselineOnce({ reps, warmup });
  } while (!attempt.trustworthy && attempts < maxAttempts);
  return { ...attempt, attempts, gaveUp: !attempt.trustworthy };
}

/**
 * One snapshot of every foreign-load signal, timestamped. Take one
 * before and one after the work being measured, then pass both (plus
 * the run's calibration baseline, if one was captured) to
 * `foreignLoadDelta`.
 *
 * The calibration loop is only run here when `calibBaseline` is both
 * present and `trustworthy` — an untrustworthy baseline has nothing
 * honest to compare a fresh reading against, so running the loop again
 * would only spend CPU time on a number `foreignLoadDelta` is going to
 * discard anyway.
 */
export function captureForeignLoad(calibBaseline = null) {
  return {
    atMs: Date.now(),
    stealTicks: readCpuStealTicks(),
    cgroup: readCgroupThrottle(),
    psiTotal: readPsiCpuSomeTotal(),
    calibMs: (calibBaseline && calibBaseline.trustworthy) ? calibrationLoopMs() : null,
  };
}

/**
 * How much compute this process was denied between two
 * `captureForeignLoad()` snapshots — now four independent readings, not
 * two, each `null` when its own source could not be read rather than
 * treated as zero:
 *
 * - `deniedMsPerSec` — steal + cgroup throttling, summed (a phase can be
 *   denied by both at once), as milliseconds denied per second of wall
 *   time. Kept from the original design (see `FOREIGN_LOAD_DENIED_MS_PER_SEC`'s
 *   doc comment for why these two are no longer trusted alone).
 * - `psiMsPerSec` — the SAME kind of rate, read from PSI's cumulative
 *   `total=` field instead, which sees contention neither steal nor
 *   cgroup throttling can (ordinary sibling processes on shared cores,
 *   with no quota set).
 * - `calibRatio` / `calibOverThreshold` — the calibration loop's fresh
 *   reading (the WORSE of one taken at `before` and one at `after`,
 *   since a spike partway through the window must not be averaged away)
 *   against this run's own quiet baseline. Needs `calibBaseline` (a
 *   `captureQuietCalibrationBaseline()` result) to be both supplied and
 *   `trustworthy` — otherwise this signal reports itself unavailable
 *   rather than compare against a baseline that was never established.
 *
 * `measured` is true if ANY of the four could be read — so a container
 * with neither `/proc/pressure` nor a working cgroup hierarchy still
 * gets a real answer from the calibration loop alone, which needs
 * neither. `timeVerdictUnderLoad` below gates on each independently:
 * one unreadable signal must not blind every other timed check to the
 * signals that DID come back.
 */
export function foreignLoadDelta(before, after, calibBaseline = null) {
  const wallMs = after.atMs - before.atMs;
  const stealTicks = (before.stealTicks !== null && after.stealTicks !== null)
    ? after.stealTicks - before.stealTicks : null;
  const stealMs = stealTicks !== null ? (stealTicks * 1000) / clockTicksPerSecond() : null;

  const cgroupOk = before.cgroup !== null && after.cgroup !== null
    && before.cgroup.source === after.cgroup.source;
  const cgroupThrottledUsec = cgroupOk ? after.cgroup.throttledUsec - before.cgroup.throttledUsec : null;
  const cgroupNrThrottled = cgroupOk ? after.cgroup.nrThrottled - before.cgroup.nrThrottled : null;
  const cgroupMs = cgroupThrottledUsec !== null ? cgroupThrottledUsec / 1000 : null;

  // Steal + cgroup, summed and converted to a per-second rate — unchanged
  // from the original design. `null` only when NEITHER could be read.
  const deniedMs = (stealMs !== null ? stealMs : 0) + (cgroupMs !== null ? cgroupMs : 0);
  const stealOrCgroupMeasured = stealMs !== null || cgroupMs !== null;
  const deniedMsPerSec = stealOrCgroupMeasured && wallMs > 0
    ? (deniedMs * 1000) / wallMs : (stealOrCgroupMeasured ? 0 : null);

  // PSI: a monotonic cumulative counter, exactly like steal ticks — take
  // the delta, convert microseconds to milliseconds, then to a rate.
  const psiOk = typeof before.psiTotal === 'number' && typeof after.psiTotal === 'number';
  const psiDeltaUsec = psiOk ? after.psiTotal - before.psiTotal : null;
  const psiMs = psiDeltaUsec !== null ? psiDeltaUsec / 1000 : null;
  const psiMsPerSec = psiMs !== null && wallMs > 0 ? (psiMs * 1000) / wallMs : (psiMs !== null ? 0 : null);

  // Calibration loop: NOT a delta of a counter — a fresh, direct timing
  // taken at `before` and again at `after` (see `captureForeignLoad`),
  // compared against the run's own baseline. The worse (higher) of the
  // two is used, so a spike confined to one edge of the window is not
  // diluted by averaging it against a quiet other edge.
  const calibReady = !!(calibBaseline && calibBaseline.trustworthy
    && typeof before.calibMs === 'number' && typeof after.calibMs === 'number'
    && calibBaseline.medianMs > 0);
  const calibMsWorst = calibReady ? Math.max(before.calibMs, after.calibMs) : null;
  const calibRatio = calibReady ? calibMsWorst / calibBaseline.medianMs : null;
  const calibOverThreshold = calibRatio !== null && calibRatio > CALIBRATION_LOAD_FACTOR;

  const measured = stealOrCgroupMeasured || psiMs !== null || calibReady;

  return {
    wallMs,
    stealTicks,
    stealMs: stealMs !== null ? +stealMs.toFixed(2) : null,
    cgroupSource: cgroupOk ? after.cgroup.source : null,
    cgroupThrottledUsec,
    cgroupNrThrottled,
    cgroupMs: cgroupMs !== null ? +cgroupMs.toFixed(2) : null,
    deniedMsPerSec: deniedMsPerSec !== null ? +deniedMsPerSec.toFixed(2) : null,
    psiMs: psiMs !== null ? +psiMs.toFixed(2) : null,
    psiMsPerSec: psiMsPerSec !== null ? +psiMsPerSec.toFixed(2) : null,
    calibMs: calibMsWorst !== null ? +calibMsWorst.toFixed(3) : null,
    calibBaselineMs: calibBaseline ? calibBaseline.medianMs : null,
    calibBaselineTrustworthy: calibBaseline ? calibBaseline.trustworthy : null,
    calibRatio: calibRatio !== null ? +calibRatio.toFixed(3) : null,
    calibOverThreshold,
    measured,
  };
}

/**
 * The rate of denied compute (see `foreignLoadDelta`) above which a
 * time-based check can no longer trust its own clock, in milliseconds
 * denied per second of wall time.
 *
 * **Derived, not guessed — 2026-09-20, this repo's own dev container
 * (4 vCPUs, cgroup v1 `cpu` hierarchy writable).** Method: a synchronous
 * ~5.4 ms CPU-bound unit of work (JSON-stringify-heavy loop, chosen to
 * resemble the per-call cost of the search/scoring work the real timed
 * checks in `phase-real.mjs` do), timed 60 times per run with
 * `process.hrtime.bigint()`, run inside a cgroup v1 `cpu` child with
 * `cpu.cfs_period_us=100000` and a swept `cpu.cfs_quota_us`. `cpu.stat`
 * was read immediately before and after each run to get the REAL
 * `throttled_time` delta, converted to a ms/s rate over that run's own
 * wall time (`nr_periods` delta × 100 ms) — the same computation
 * `foreignLoadDelta` does. Unloaded baseline (six runs, no cgroup limit
 * at all): p95 5.59-6.05 ms in five of six runs, one outlier at 10.19 ms
 * — median 5.79 ms, taken as the reference. 20 % over that reference is
 * 6.94 ms.
 *
 * ```
 * quota (of one CPU)   denied ms/s     p95 measured    deviation
 * unlimited (-1)              0 (*)      5.59-6.05 ms   baseline
 * 90 %                     78.7          15.58 ms        +169 %
 * 70 %                    ~330           35.42 ms        +512 %
 * 55 %                    ~455           51.45 ms        +789 %
 * 45 % .. 25 %          580-950          60-80 ms      +940-1280 %
 * ```
 * (*) `nr_throttled` stayed exactly 0 at every unloaded run — no
 * throttling occurred, so there is no rate to compute; 0 is the
 * measurement, not a stand-in for "unknown".
 *
 * **The mechanism is a cliff, not a ramp.** CFS quota throttling freezes
 * the whole process for the remainder of a period once its quota is
 * spent, so the FIRST quota tight enough to throttle at all (90 % of one
 * CPU, ~79 ms/s denied) already blew the 20 % bound by more than 8×.
 * A finer sweep (95 %, 92 %, 91 %...) would only narrow the gap between
 * "0, never throttled" and "79 ms/s, already 8x over" — it would not
 * find a gentler slope, because the underlying mechanism has none. Given
 * that, the threshold below is set well inside the confirmed-safe side
 * (0 ms/s, real, idle) and well below the confirmed-broken side (79 ms/s,
 * real, measured): a round 20 ms/s, one quarter of the lowest rate this
 * container ever measured as already-broken.
 *
 * **CPU steal could not be experimentally induced from inside this
 * container** — steal is the hypervisor denying THIS guest's vCPU time to
 * ANOTHER guest, which requires controlling a second guest on the same
 * host, not available here. Idle steal in this container measured 0
 * ticks over a 10 s window (`awk '/^cpu /{print $9}' /proc/stat`, twice,
 * 10 s apart, 2026-09-20) — consistent with "not currently contended",
 * not with "unmeasurable". The same 20 ms/s rate is applied to steal by
 * analogy rather than by its own derivation: both quantities are "CPU
 * time this process wanted and did not get", differing only in which
 * scheduler denied it, so the same rate is the best available number
 * until a host that can genuinely induce steal is available to check it
 * against. That substitution is a real gap in this derivation and is
 * named here rather than hidden — see the report's "what was wrong with
 * this brief" section.
 *
 * **Confirmed structurally blind in THIS container, and why (2026-09-20,
 * the fix this comment now documents).** 8 CPU-bound processes pinned
 * against this container's 4 cores — the exact shape of load that
 * motivated this whole apparatus — measured 0.00 ms/s on BOTH steal and
 * cgroup throttling, at the same moment PSI (below) read ~800 ms/s and
 * the calibration loop ran at 1.79x its own baseline. This is not a bug
 * in either reader: steal counts only what a HYPERVISOR gives to another
 * VM GUEST, and a sibling process in the SAME container competing for
 * the SAME cores is invisible to that definition by design; cgroup
 * throttling counts only time spent already-over-quota, and this
 * container's `cpu.cfs_quota_us` is unlimited (`-1`), so there is no
 * quota to spend past. Both readers are honest; the question they answer
 * is the wrong one for a shared-container-without-a-quota host. They are
 * kept (a real VM guest with noisy neighbours DOES generate steal, and a
 * cgroup WITH a quota DOES throttle) but are no longer the sole gate —
 * see `timeVerdictUnderLoad` below, and `foreignLoadDelta`'s doc comment
 * for the two signals that now actually detect this container's own
 * load: PSI and the calibration loop in the section above.
 *
 * **PSI reuses this same threshold rather than deriving its own.** PSI's
 * `some total=` field measures the same underlying quantity — CPU time
 * wanted and not given — just via the kernel's own stall accounting
 * instead of a hypervisor's or a quota's counter, so the same "ms
 * denied per second of wall time" unit applies unchanged. Checked
 * against real numbers in this container rather than assumed: idle PSI
 * measured ~1.2 ms/s over a genuinely quiet 3 s window (`sleep 3` while
 * this process did nothing else), and the 8-fressers-on-4-cores run
 * above measured ~800 ms/s — 20 ms/s sits with ample margin on both
 * sides of that gap, the same shape of margin the original derivation
 * used for steal and cgroup.
 */
export const FOREIGN_LOAD_DENIED_MS_PER_SEC = 20;

/**
 * Nearest-rank percentile threshold verdict for a timed measurement,
 * `not-measured` instead of pass/fail whenever the foreign-load delta
 * measured around it shows load on ANY of its independent signals: steal
 * + cgroup combined over `FOREIGN_LOAD_DENIED_MS_PER_SEC`, PSI over the
 * same threshold, or the calibration loop over `CALIBRATION_LOAD_FACTOR`
 * times its own quiet baseline. Each is checked independently — one
 * signal reading `null` (its source unreadable here) never suppresses a
 * REAL reading from another; see `foreignLoadDelta`'s doc comment for
 * why `measured` alone would not be enough (a cgroup that never
 * throttles because it has no quota reads a real, non-null, structurally
 * blind 0 — see this constant's own doc comment above).
 *
 * This only changes TIME-BASED verdicts. A check that does not measure a
 * duration was never affected by how much CPU this process got, and
 * routing it through here would be exactly the "a guard that meddles with
 * things it wasn't asked to grade" mistake this house watches for — such
 * checks keep calling `timeVerdict` (or their own comparison) directly.
 *
 * `load` is a `foreignLoadDelta()` result, or `null` when no load
 * measurement was taken around this check at all (in which case this
 * degrades to plain `timeVerdict` — a phase that never measured foreign
 * load cannot use it as an excuse, it just did not ask the question).
 */
export function timeVerdictUnderLoad(ms, degradedAt, failAt, load) {
  if (load) {
    const stealOrCgroupOver = load.deniedMsPerSec !== null && load.deniedMsPerSec !== undefined
      && load.deniedMsPerSec > FOREIGN_LOAD_DENIED_MS_PER_SEC;
    const psiOver = load.psiMsPerSec !== null && load.psiMsPerSec !== undefined
      && load.psiMsPerSec > FOREIGN_LOAD_DENIED_MS_PER_SEC;
    const calibOver = load.calibOverThreshold === true;
    if (stealOrCgroupOver || psiOver || calibOver) return VERDICT.NOT_MEASURED;
  }
  return timeVerdict(ms, degradedAt, failAt);
}

/** Plain wall-clock threshold verdict, with no load awareness at all. */
export function timeVerdict(ms, degradedAt, failAt) {
  if (ms === null || ms === undefined) return VERDICT.NOT_MEASURED;
  if (ms > failAt) return VERDICT.FAIL;
  if (ms > degradedAt) return VERDICT.DEGRADED;
  return VERDICT.PASS;
}

// --- running the real CLI ---------------------------------------------

/**
 * Run `bin/mem` as a real child process.
 *
 * Deliberately NOT by importing the modules: a benchmark that calls
 * internals measures the internals, while a user types a command. Argument
 * parsing, exit codes, stdout shape and startup cost are part of what is
 * being claimed, so they are part of what is measured. The cost is ~60 ms
 * of Node startup per call, which is reported separately (see
 * `nodeStartupMs` in the environment block) so it can be subtracted by
 * anyone who wants the in-process number.
 *
 * **`bin` and `rootVar` exist so this apparatus can also drive the SISTER
 * HOUSE.** lucky-mem is the same design under German names, and it carries
 * something no generator can produce: a real corpus, grown by daily use.
 * A synthetic corpus guesses the shape of real entries — length
 * distribution, vocabulary reuse, how often the same words come back — and
 * that guess has been wrong here before (bench/scale.mjs, 2026-09-05: its
 * first version used ~70 distinct words and the timings came out WORSE
 * than reality). Measuring the sister house is the counter-probe to the
 * generator itself.
 *
 * It reads that house's memory only to measure it. Nothing an entry SAYS
 * belongs in a benchmark report — the phase that uses this reports
 * distributions, never bodies.
 */
export function mem(args, {
  root, env = {}, input, timeoutMs = 120000, bin = MEM, rootVar = 'CHEAP_MEM_ROOT', cwd,
} = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: cwd ?? root ?? REPO,
    env: { ...process.env, [rootVar]: root ?? '', ...env },
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    args,
    status: r.status,
    signal: r.signal,
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    bytes: Buffer.byteLength(r.stdout ?? ''),
    ms: +ms.toFixed(2),
    spawnError: r.error ? String(r.error.message).slice(0, 300) : null,
  };
}

/** Measure what one bare Node start costs here, so CLI numbers can be read. */
export function nodeStartupMs() {
  const t = timeIt(() => {
    spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  }, { n: 7, warmup: 2 });
  return t.p50;
}

// --- the record --------------------------------------------------------

export class Atlas {
  constructor({ label = 'atlas' } = {}) {
    this.label = label;
    this.startedAt = new Date().toISOString();
    this.t0 = Date.now();
    this.phases = [];
    this.findings = [];
    this.blindSpots = [];
    this.current = null;
  }

  phase(id, title, note = '') {
    this.current = { id, title, note, records: [], startedAt: new Date().toISOString() };
    this.phases.push(this.current);
    return this.current;
  }

  /**
   * Record one measurement.
   *
   * `expected` is mandatory in spirit: a record without a stated
   * expectation is a number, not a check, and a report full of numbers
   * nobody promised anything about reads as success. Where there is
   * genuinely no expectation (a pure measurement), pass `expected: null`
   * and the verdict `not-measured` — that is honest, and it shows up in
   * the counts as something still owed.
   */
  record({ id, title, verdict, expected = null, actual = null, measured = null,
    evidence = null, severity = null, ms = null }) {
    if (!Object.values(VERDICT).includes(verdict)) {
      throw new Error(`unknown verdict "${verdict}" on record ${id}`);
    }
    if (!this.current) throw new Error('record() before phase()');
    const r = {
      id, title, verdict, expected, actual, measured, evidence,
      ms, phase: this.current.id, at: new Date().toISOString(),
    };
    this.current.records.push(r);
    if (verdict === VERDICT.FAIL || verdict === VERDICT.DEGRADED) {
      this.findings.push({
        severity: severity ?? (verdict === VERDICT.FAIL ? SEVERITY.MAJOR : SEVERITY.MINOR),
        phase: this.current.id, id, title, expected, actual, evidence, measured,
      });
    }
    return r;
  }

  /** Something this run could NOT look at, and why. Never silent. */
  blind(what, why) { this.blindSpots.push({ what, why }); }

  counts() {
    const c = { pass: 0, fail: 0, degraded: 0, 'not-measured': 0 };
    for (const p of this.phases) for (const r of p.records) c[r.verdict] += 1;
    return c;
  }

  finish(extra = {}) {
    return {
      schemaVersion: SCHEMA_VERSION,
      tool: 'cheap-mem atlas',
      label: this.label,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.t0,
      environment: environment(),
      counts: this.counts(),
      phases: this.phases,
      findings: this.findings,
      blindSpots: this.blindSpots,
      ...extra,
    };
  }
}

// --- environment -------------------------------------------------------
//
// A benchmark number without the machine it was taken on is not
// comparable, and comparing it anyway is how a "regression" gets chased
// for a day before someone notices the runner changed.

export function environment() {
  let commit = null; let dirty = null; let version = null;
  try {
    commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8' }).trim();
    dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain'],
      { encoding: 'utf8' }).trim().length > 0;
  } catch { /* not a checkout */ }
  try {
    version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version ?? null;
  } catch { /* no package.json */ }
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    loadAvg1: os.loadavg()[0],
    gitCommit: commit,
    workingTreeDirty: dirty,
    packageVersion: version,
    // Measured, not assumed: everything below is timed with this in it.
    nodeStartupMsP50: null,   // filled by the runner
  };
}

// --- corpora -----------------------------------------------------------
//
// Synthetic, but shaped like a real memory. Straight random words make
// every posting list length one and every query miss; a small fixed
// vocabulary makes every query match everything. Real memories sit in
// between: a few dozen recurring topic words, a Zipf-ish tail of rare
// identifiers (file paths, error codes, ids). bench/scale.mjs found this
// out the hard way on 2026-09-05 — its first version used ~70 distinct
// words and the timings came out WORSE than reality.

// **This vocabulary carries almost no stopwords, and that matters for
// one measurement it was never built for.** Every word below is a
// content word; `the`, `we`, `der`, `und` appear nowhere. Language
// detection (src/langdetect.mjs) scores stopword overlap, so it reports
// `uncertain` for 97.6 % of the documents this generator produces —
// against 2.2 % on lucky-mem's 1,889 real entries, measured 2026-09-20.
//
// Nothing noticed for as long as nothing was language-sensitive. Now
// something is: an uncertain document is tokenised under every
// detectable language pack, so a corpus that is almost entirely
// uncertain makes the index build look roughly twice as expensive as it
// is on real prose (1,540 ms at 99.4 % uncertain against 1,045 ms at
// 1.4 %, same corpus size).
//
// Deliberately NOT fixed by sprinkling stopwords in here. The
// generator's job is to reproduce the SHAPE of a real memory — type
// concentration, tag sparsity, recency clustering, reachability — and
// those were each calibrated against a measured real share. Adding
// filler words to make one new measurement look better would change
// every other measurement taken against this corpus, for a number
// nobody has measured on real text. The honest form is this comment:
// any language-sensitive figure taken against this corpus is a worst
// case, and must say so.
const COMMON = ('deploy database index search cache memory session agent error '
  + 'timeout retry config branch commit merge test probe guard boundary redaction '
  + 'capability archive digest inbox duty question skill procedure source store '
  + 'entry ranking corpus token budget latency throughput').split(' ');

// The type -> filename map comes from the code, not from a copy here.
//
// The first draft of this generator pluralised by appending "s" and wrote
// `dutys.jsonl`. The memory read 470 of 512 entries and said nothing: an
// unrecognised .jsonl in `global/` is silently skipped, and `doctor`
// reported `ok drawers 10 files` while eleven lay there. A duplicated list
// would have carried that mistake into every future run of this harness —
// and a benchmark whose corpus the system cannot fully read measures the
// wrong thing while looking fine.
//
// The gap itself is a finding, and it is checked for in the robustness
// phase rather than being quietly worked around here.
const TYPE_FILES = Object.entries(memoryTypes)
  .filter(([t]) => t !== 'link' && t !== 'timeline');

// --- corpus shape, measured against a real memory -----------------------
//
// Every constant below was fit against lucky-mem's real 2,286 entries,
// measured 2026-09-20 by the atlas's own `real` phase
// (bench/atlas/phase-real.mjs) and a further breakdown over that same
// run. They are named, not inlined, so a later reader can see where a
// number came from and argue with it instead of re-deriving it from a
// comment buried inside a loop.

// Share of entries in the single largest type. Real: 31.51% (rank shares
// [31.51, 19.57, 16.33, 9.47, 9.13, ...] across 14 real types). Only the
// MAX share is what the atlas's bias check compares, so `TYPE_FILES[0]`
// gets this share and the rest split it flat — enough to fix the
// measured factor-of-3 gap without inventing a full rank curve nobody
// asked for.
export const DOMINANT_TYPE_SHARE = 0.3151;

// Entry line size, in bytes of the full JSON line — what `analyzeCorpus`
// in phase-real.mjs actually measures. Real: p50 964-979 B, p90 1609 B,
// p99 2482 B, max 3519 B. A long tail, not a narrow band: most entries
// draw a normal word count, a smaller share draw a much longer one, so
// p95 lands several times p50 instead of beside it.
export const ENTRY_LONG_TAIL_SHARE = 0.13;
export const ENTRY_WORDS_NORMAL_MIN = 62;
export const ENTRY_WORDS_NORMAL_RANGE = 48;
export const ENTRY_WORDS_LONG_MIN = 140;
export const ENTRY_WORDS_LONG_RANGE = 240;

// Tags per entry, over ALL entries including the untagged ones. Real
// (further measurement, 2026-09-20): p50 3, p95 5, max 8. Built as a
// small hand-fit discrete curve (see `tagCountFor`) rather than one
// formula, since a real tag count is not one distribution shape — most
// entries get a couple of tags, and progressively fewer get more.
export const UNTAGGED_SHARE = 0.1723; // share of entries with NO tags. Real: 17.23%.

// Share of entries too thin, across the fields search ranks on, to ever
// surface at all. Real: 0.9% — a case the old generator produced exactly
// zero of. `UNREACHABLE_MIN_WORDS` mirrors `FINDABLE_MIN_WORDS` in
// phase-real.mjs (that file's name for the same threshold, over the
// same weighted fields lucky-mem's own doctor uses); kept as a literal
// here rather than imported, so this file stays independent of the
// atlas phases that consume it.
export const UNREACHABLE_SHARE = 0.009;
export const UNREACHABLE_MIN_WORDS = 3;

// Recency. Real entries cluster hard: 46.14% inside the last 7 days,
// 100% inside the last 30 AND the last 90 (span ~25 days total) — a
// memory that is being used, not one written once a year ago and left
// alone. Every ordinary entry's age is drawn as
// `RECENCY_CLUSTER_DAYS * r() ** RECENCY_CLUSTER_SKEW` days: the skew
// pulls the mass toward 0 without changing the 30-day ceiling, and this
// exponent was fit so the 7-day share lands near the real 46.14%.
/**
 * The day a generated corpus clusters around, by default.
 *
 * Fixed on purpose. A generator that reads the wall clock produces a
 * different corpus for the same seed on a different day, and everything
 * quoted against that seed — the committed baseline, every fixture built
 * on `buildCorpus` — then moves for a reason nobody can see in a diff.
 *
 * It does mean the absolute dates age. That is the right trade: the
 * SHAPE (how tightly entries cluster) is what the measurement is about,
 * and the shape is relative to this anchor. Move the constant
 * deliberately when the drift starts to matter, and the move shows up
 * in the history.
 */
export const CORPUS_AS_OF = Date.parse('2026-09-20T00:00:00Z');

export const RECENCY_CLUSTER_DAYS = 30;
export const RECENCY_CLUSTER_SKEW = 1.7;

/**
 * Weighted pick over `TYPE_FILES`: the first entry (`decision`) takes
 * `DOMINANT_TYPE_SHARE`, the remaining share is split flat across
 * everything else. See `DOMINANT_TYPE_SHARE` for why flat is enough.
 */
function pickTypeFile(r) {
  const x = r();
  if (TYPE_FILES.length <= 1 || x < DOMINANT_TYPE_SHARE) return TYPE_FILES[0];
  const rest = TYPE_FILES.length - 1;
  const idx = 1 + Math.min(rest - 1,
    Math.floor(((x - DOMINANT_TYPE_SHARE) / (1 - DOMINANT_TYPE_SHARE)) * rest));
  return TYPE_FILES[idx];
}

/** Tag count for one (already-decided-tagged) entry. See `UNTAGGED_SHARE` doc above. */
function tagCountFor(r) {
  let n = 2 + Math.floor(r() * 2);
  if (r() < 0.45) n += 1;
  if (r() < 0.20) n += 1;
  if (r() < 0.08) n += 1;
  if (r() < 0.02) n += 1;
  if (r() < 0.005) n += 1;
  return Math.min(n, 8);
}

/** Deterministic PRNG: a corpus that differs per run is not a baseline. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function zipfWord(r, i) {
  // Rare identifiers: file-ish, code-ish, id-ish — the long tail that makes
  // selectivity realistic.
  const k = Math.floor(i * r());
  if (k % 3 === 0) return `src/mod${k}.mjs`;
  if (k % 3 === 1) return `ERR-${1000 + (k % 9000)}`;
  return `id${k.toString(36)}`;
}

/**
 * Write a corpus of `count` entries under `root` and return a description.
 *
 * `anchors` are entries with a unique, findable phrase. They are what makes
 * a recall measurement possible at all: without a known-correct answer you
 * can time a query but you cannot say whether it was right — and a
 * benchmark that only times is exactly the kind that confirms the code
 * instead of testing it.
 */
export function buildCorpus(root, count, {
  seed = 42, anchors = 12, project = null, asOfDay = CORPUS_AS_OF,
} = {}) {
  const r = rng(seed);
  const dir = project ? path.join(root, 'projects', project) : path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  if (!fs.existsSync(path.join(root, '.mem', 'config.json'))) {
    fs.writeFileSync(path.join(root, '.mem', 'config.json'),
      JSON.stringify({ participants: ['user', 'agent'], language: 'en' }));
  }

  const streams = new Map();
  const anchorList = [];
  // The day the corpus clusters around — see RECENCY_CLUSTER_DAYS.
  //
  // **A fixed default, not `Date.now()` (2026-09-20).** The first cut of
  // the recency shaping read the wall clock, so seed 42 produced a
  // different corpus on a different calendar day. That is not a small
  // thing here: `bench/atlas-baseline.json` is what later runs are
  // compared against, and a corpus that drifts daily mixes a real
  // regression with a corpus change in the same number. Tests built on
  // this generator would have been flaky BY CALENDAR, which is the
  // hardest kind to find.
  //
  // `asOfDay` keeps both properties. The default is fixed, so the same
  // seed gives the same bytes forever. A caller who genuinely wants
  // "clustered around today" — a one-off measurement, not a baseline —
  // passes `Date.now()` and says so at the call site.
  const nowDay = Math.floor(asOfDay / 86400000) * 86400000;

  for (let i = 0; i < count; i += 1) {
    const [type, file] = pickTypeFile(r);
    const untagged = r() < UNTAGGED_SHARE;
    const unreachable = r() < UNREACHABLE_SHARE;
    const long = !unreachable && r() < ENTRY_LONG_TAIL_SHARE;
    // Unreachable entries carry no body at all — see the `topic` note
    // below for why that has to hold across every field this loop can
    // set, not just `text`.
    const wordCount = unreachable ? 0
      : long ? ENTRY_WORDS_LONG_MIN + Math.floor(r() * ENTRY_WORDS_LONG_RANGE)
        : ENTRY_WORDS_NORMAL_MIN + Math.floor(r() * ENTRY_WORDS_NORMAL_RANGE);
    const words = [];
    for (let w = 0; w < wordCount; w += 1) {
      words.push(r() < 0.75 ? COMMON[Math.floor(r() * COMMON.length)] : zipfWord(r, i + w));
    }
    const tagCount = (untagged || unreachable) ? 0 : tagCountFor(r);
    const tags = [];
    for (let t = 0; t < tagCount; t += 1) tags.push(COMMON[Math.floor(r() * COMMON.length)]);

    // Age drawn from a skewed distribution, not spread flat across a
    // year — see RECENCY_CLUSTER_DAYS/SKEW above for the real numbers
    // this is fit against. Whole seconds, because that is what
    // logEntry writes.
    const ageDays = Math.floor(RECENCY_CLUSTER_DAYS * (r() ** RECENCY_CLUSTER_SKEW));
    const secondsIntoDay = Math.floor(r() * 86400);
    const ts = new Date(nowDay - (ageDays * 86400000) + (secondsIntoDay * 1000))
      .toISOString().replace(/\.\d{3}Z$/, 'Z');

    const title = `${COMMON[Math.floor(r() * COMMON.length)]} ${zipfWord(r, i)}`;
    const e = {
      id: `g${i.toString(36)}`,
      ts,
      title,
      text: words.join(' '),
      tags,
    };
    if (type === 'decision') {
      // `topic` is one of the fields phase-real.mjs's `analyzeCorpus`
      // weighs when it decides whether an entry is findable at all (it
      // mirrors lucky-mem's own field). Filling it with the title for
      // an "unreachable" entry would smuggle real words back into a
      // case that is supposed to have none — so an unreachable decision
      // gets empty strings here exactly as it gets an empty body above.
      e.topic = unreachable ? '' : title;
      e.choice = unreachable ? '' : (words[0] ?? 'x');
      e.why = unreachable ? '' : e.text;
    }
    if (type === 'error') { e.class = 'measurement'; }
    if (!streams.has(file)) streams.set(file, []);
    streams.get(file).push(JSON.stringify(e));
  }

  // The anchors go in last so they are not diluted by the generator, and
  // built by hand rather than through the shaping above: an anchor must
  // never land in the untagged or unreachable share that now exists
  // among the ordinary entries, since every recall measurement in the
  // atlas depends on it being both tagged and findable.
  for (let a = 0; a < anchors; a += 1) {
    const phrase = `anchorphrase${a}zzq`;
    const e = {
      id: `anchor${a}`,
      ts: new Date(nowDay - ((a + 1) * 86400000)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      title: `anchor ${a} ${phrase}`,
      text: `this entry exists so a recall measurement has a known-correct answer ${phrase}`,
      tags: ['anchor'],
    };
    if (!streams.has('learnings.jsonl')) streams.set('learnings.jsonl', []);
    streams.get('learnings.jsonl').push(JSON.stringify(e));
    anchorList.push({ id: e.id, phrase, query: phrase });
  }

  let bytes = 0;
  for (const [file, lines] of streams) {
    const body = `${lines.join('\n')}\n`;
    bytes += Buffer.byteLength(body);
    fs.writeFileSync(path.join(dir, file), body);
  }
  return { root, dir, count: count + anchors, files: streams.size, bytes, anchors: anchorList, seed };
}

/** A throwaway root that cleans itself up at process exit. */
const created = [];
let hookArmed = false;
export function tempRoot(prefix = 'atlas-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  if (!hookArmed) {
    hookArmed = true;
    process.on('exit', () => {
      for (const p of created) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* going away anyway */ }
      }
    });
  }
  return d;
}

/** Recursive size on disk, in bytes. Used for growth measurements. */
export function dirBytes(p) {
  let n = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      for (const k of fs.readdirSync(cur)) stack.push(path.join(cur, k));
    } else n += st.size;
  }
  return n;
}

// --- the search-index cache, as a directory (B8, 2026-09-20) -----------
//
// A shared home for the three questions every phase used to ask of the
// old single `.mem/search-index.json` file — does a cache exist, how
// big is it, when was it last written — now asked of the directory
// `CACHE_DIR` holds instead. One helper per question, used everywhere a
// phase used to `fs.existsSync`/`fs.statSync` the old path directly, so
// the path itself (imported above) is spelled out in exactly one place.

/** Absolute path to the cache directory under a given memory root. */
export function cacheDirPath(root) {
  return path.join(root, CACHE_DIR);
}

/** Absolute path to that cache's manifest. */
export function cacheManifestPath(root) {
  return path.join(root, CACHE_DIR, MANIFEST_FILE);
}

/**
 * Does a cache actually exist at this root? A bare `CACHE_DIR` with no
 * `manifest.json` is a torn write or a directory some other probe left
 * behind, not a usable cache — `readIndexCache` treats a manifest-less
 * directory as `reason: 'no-manifest'`, the same as a cold start, so
 * this checks the manifest specifically rather than the directory alone.
 */
export function cacheExists(root) {
  return fs.existsSync(cacheManifestPath(root));
}

/** Total bytes the cache occupies on disk — every shard, `meta.json`
 * and `manifest.json` — via `dirBytes`, not a second size computation. */
export function cacheBytes(root) {
  return dirBytes(cacheDirPath(root));
}

/** When the cache was last (re)written, or `null` if there is none.
 * `manifest.json` is the last file `writeIndexCache` renames into place
 * as part of the atomic swap, so its mtime is the cache's mtime. */
export function cacheMtimeMs(root) {
  try { return fs.statSync(cacheManifestPath(root)).mtimeMs; } catch { return null; }
}

/** Remove the cache directory entirely (and nothing else), the
 * directory-shaped equivalent of `fs.rmSync(oldSingleFile, { force:
 * true })`. Used to force a rebuild the same way clearing the old file
 * did. */
export function removeCacheDir(root) {
  fs.rmSync(cacheDirPath(root), { recursive: true, force: true });
}

// --- output ------------------------------------------------------------

/** Write the run out as JSON + Markdown + CSV, then a .zip beside them. */
export function writeOut(result, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'atlas.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'report.md'), renderReport(result));
  fs.writeFileSync(path.join(outDir, 'records.csv'), renderCsv(result));
  fs.writeFileSync(path.join(outDir, 'findings.json'),
    `${JSON.stringify(result.findings, null, 2)}\n`);
  return jsonPath;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `"${s.replace(/"/g, '""').replace(/\n/g, ' ')}"`;
}

export function renderCsv(result) {
  const lines = ['phase,id,title,verdict,expected,actual,ms'];
  for (const p of result.phases) {
    for (const r of p.records) {
      lines.push([p.id, r.id, r.title, r.verdict, r.expected, r.actual, r.ms]
        .map(csvCell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

const MARK = { pass: 'PASS', fail: 'FAIL', degraded: 'DEGR', 'not-measured': ' ?  ' };

export function renderReport(result) {
  const L = [];
  const e = result.environment;
  L.push(`# cheap-mem atlas — ${result.label}`);
  L.push('');
  L.push(`Run ${result.startedAt}, ${(result.durationMs / 1000).toFixed(1)} s, `
    + `schema v${result.schemaVersion}.`);
  L.push('');
  L.push('## What this run says in one table');
  L.push('');
  L.push('| verdict | count | meaning |');
  L.push('|---|---:|---|');
  L.push(`| pass | ${result.counts.pass} | measured, and it matched the stated expectation |`);
  L.push(`| fail | ${result.counts.fail} | measured, and it did not |`);
  L.push(`| degraded | ${result.counts.degraded} | works, but worse than documented or than the run before |`);
  L.push(`| not-measured | ${result.counts['not-measured']} | **could not be checked here** — not a pass |`);
  L.push('');
  if (result.blindSpots.length) {
    L.push(`**${result.blindSpots.length} blind spots this run could not reach.** `
      + 'They are listed at the end, by name. A harness that drops what it cannot '
      + 'see reports a clean bill of health for a system it never looked at.');
    L.push('');
  }
  L.push('## Machine');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| node | ${e.node} |`);
  L.push(`| platform | ${e.platform} (${e.arch}) |`);
  L.push(`| cpu | ${e.cpuModel ?? 'unknown'} × ${e.cpuCount} |`);
  L.push(`| memory | ${e.totalMemMB} MB total, ${e.freeMemMB} MB free at start |`);
  L.push(`| load (1 min) | ${e.loadAvg1?.toFixed(2)} |`);
  L.push(`| commit | ${e.gitCommit ?? 'n/a'}${e.workingTreeDirty ? ' (working tree DIRTY)' : ''} |`);
  L.push(`| bare node start | ${e.nodeStartupMsP50?.toFixed?.(1) ?? '?'} ms p50 — every CLI number below includes this |`);
  L.push('');

  if (result.findings.length) {
    L.push('## Findings');
    L.push('');
    const rank = { critical: 0, major: 1, minor: 2, info: 3 };
    const ranked = [...result.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
    L.push('| severity | phase | what | expected | actual |');
    L.push('|---|---|---|---|---|');
    for (const f of ranked) {
      L.push(`| ${f.severity} | ${f.phase} | ${f.title} | ${fmt(f.expected)} | ${fmt(f.actual)} |`);
    }
    L.push('');
    for (const f of ranked.filter((x) => x.evidence)) {
      L.push(`**${f.id}** — ${f.title}`);
      L.push('');
      L.push('```');
      L.push(String(f.evidence).slice(0, 2000));
      L.push('```');
      L.push('');
    }
  } else {
    L.push('## Findings');
    L.push('');
    L.push('None. Read that together with the `not-measured` count above: '
      + 'no findings among the checks that RAN is a different statement from '
      + 'no findings.');
    L.push('');
  }

  for (const p of result.phases) {
    L.push(`## ${p.title}`);
    L.push('');
    if (p.note) { L.push(p.note); L.push(''); }
    L.push('| | check | expected | actual | ms |');
    L.push('|---|---|---|---|---:|');
    for (const r of p.records) {
      L.push(`| ${MARK[r.verdict]} | ${r.title} | ${fmt(r.expected)} | ${fmt(r.actual)} | `
        + `${r.ms === null ? '' : Number(r.ms).toFixed(1)} |`);
    }
    L.push('');
    const withMeasured = p.records.filter((r) => r.measured && typeof r.measured === 'object');
    if (withMeasured.length) {
      L.push('<details><summary>measured values</summary>');
      L.push('');
      L.push('```json');
      L.push(JSON.stringify(Object.fromEntries(withMeasured.map((r) => [r.id, r.measured])), null, 2));
      L.push('```');
      L.push('');
      L.push('</details>');
      L.push('');
    }
  }

  if (result.blindSpots.length) {
    L.push('## Blind spots');
    L.push('');
    L.push('| what | why it could not be measured here |');
    L.push('|---|---|');
    for (const b of result.blindSpots) L.push(`| ${b.what} | ${b.why} |`);
    L.push('');
  }

  L.push('## How to compare two runs');
  L.push('');
  L.push('```');
  L.push('node bench/atlas.mjs --compare bench/atlas-out/<older>/atlas.json');
  L.push('```');
  L.push('');
  L.push('The schema is versioned, the corpus seed is fixed and the machine is '
    + 'recorded, so a difference between two runs is a difference in the code — '
    + 'unless the machine block differs, in which case it is not.');
  L.push('');
  return `${L.join('\n')}\n`;
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return `\`${JSON.stringify(v).slice(0, 80)}\``;
  return String(v).slice(0, 120).replace(/\|/g, '\\|');
}
