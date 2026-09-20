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

// --- foreign load: CPU steal and cgroup throttling ---------------------
//
// **Why not `os.loadavg()`.** Load average rises when a process is
// waiting on disk or network just as readily as when it is waiting for a
// CPU another tenant is using, so a load-average-based guard cannot tell
// "this machine is slow because of us" from "this machine is slow because
// of something else". CPU steal (time a hypervisor gave to another guest
// instead of this one) and cgroup CFS throttling (time this cgroup was
// runnable but had already spent its quota for the period) both measure
// DENIED compute directly, attributed to a specific decider. Where a
// container exposes neither, the honest answer is `not-measured`, never
// `0` — a `0` here would claim "no foreign load" about a quantity nobody
// could read.
//
// Both readers below are plain `fs.readFileSync` over `/proc` and
// `/sys/fs/cgroup`, never a spawned tool, so a phase can snapshot them on
// either side of a slow measurement at effectively zero cost.

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

/** One snapshot of both foreign-load signals, timestamped. Take one before and one after the work being measured, then pass both to `foreignLoadDelta`. */
export function captureForeignLoad() {
  return {
    atMs: Date.now(),
    stealTicks: readCpuStealTicks(),
    cgroup: readCgroupThrottle(),
  };
}

/**
 * How much compute this process was denied between two `captureForeignLoad()`
 * snapshots, as milliseconds denied per second of wall time elapsed — a
 * rate, so a short phase and a long phase are comparable on the same
 * threshold. Either side missing, or the cgroup hierarchy changing
 * between snapshots (should not happen; checked anyway), yields `null`
 * for that source rather than treating it as zero.
 */
export function foreignLoadDelta(before, after) {
  const wallMs = after.atMs - before.atMs;
  const stealTicks = (before.stealTicks !== null && after.stealTicks !== null)
    ? after.stealTicks - before.stealTicks : null;
  const stealMs = stealTicks !== null ? (stealTicks * 1000) / clockTicksPerSecond() : null;

  const cgroupOk = before.cgroup !== null && after.cgroup !== null
    && before.cgroup.source === after.cgroup.source;
  const cgroupThrottledUsec = cgroupOk ? after.cgroup.throttledUsec - before.cgroup.throttledUsec : null;
  const cgroupNrThrottled = cgroupOk ? after.cgroup.nrThrottled - before.cgroup.nrThrottled : null;
  const cgroupMs = cgroupThrottledUsec !== null ? cgroupThrottledUsec / 1000 : null;

  // The rate this phase's checks are gated on: whichever source answered,
  // summed (a phase can be denied by both at once), converted to a
  // per-second rate over the wall time actually elapsed. `null` only when
  // NEITHER source could be read at all — the genuinely blind case.
  const deniedMs = (stealMs !== null ? stealMs : 0) + (cgroupMs !== null ? cgroupMs : 0);
  const measured = stealMs !== null || cgroupMs !== null;
  const deniedMsPerSec = measured && wallMs > 0 ? (deniedMs * 1000) / wallMs : (measured ? 0 : null);

  return {
    wallMs,
    stealTicks,
    stealMs: stealMs !== null ? +stealMs.toFixed(2) : null,
    cgroupSource: cgroupOk ? after.cgroup.source : null,
    cgroupThrottledUsec,
    cgroupNrThrottled,
    cgroupMs: cgroupMs !== null ? +cgroupMs.toFixed(2) : null,
    measured,
    deniedMsPerSec: deniedMsPerSec !== null ? +deniedMsPerSec.toFixed(2) : null,
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
 */
export const FOREIGN_LOAD_DENIED_MS_PER_SEC = 20;

/**
 * Nearest-rank percentile threshold verdict for a timed measurement,
 * `not-measured` instead of pass/fail whenever the foreign-load delta
 * measured around it shows denied compute over `FOREIGN_LOAD_DENIED_MS_PER_SEC`.
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
  if (load && load.deniedMsPerSec !== null && load.deniedMsPerSec > FOREIGN_LOAD_DENIED_MS_PER_SEC) {
    return VERDICT.NOT_MEASURED;
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
