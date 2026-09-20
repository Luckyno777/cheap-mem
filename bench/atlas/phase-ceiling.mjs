// bench/atlas/phase-ceiling.mjs — where this design stops working, and why,
// extrapolated up to 5,000,000 log entries.
//
// **What this phase is for, and why it is not phase-load.** `phase-load`
// measures 1k -> 20k and says so honestly — the ladder stops there because
// the full atlas has a time budget. Nobody who reads "n^1.02" from a
// three-point ladder learns anything about 5 million entries; they learn
// what the exponent looked like between 1k and 20k. This phase exists to
// say the two things `phase-load` cannot afford to: how far the measured
// ladder actually reaches on THIS machine, and what a fitted curve, when
// it is honestly asked to predict a point it did not see, gets wrong.
//
// **The prediction counter-check is the whole point of section B.** A
// power-law fit through five points always has an R² close to 1 — that is
// what a monotone curve through few points looks like, not evidence the
// model is right. The only test that means anything is holding one rung
// back, fitting on the rest, and checking whether the fit would have
// guessed the held-back rung. When it cannot, the extrapolation to 5M is
// printed anyway (an extrapolation is not a measurement and is never
// silently dropped), but it carries the failed counter-check as evidence
// so nobody mistakes a curve for a fact.
//
// **The five walls (section C) are not a story about the code.** Each one
// is measured where a real number is reachable, computed from a measured
// ratio where a run of that size is not (V8's string limit and 5M
// projections), and marked `not-measured` plus `atlas.blind()` where it
// is neither. None of the five are asserted from having read the source
// alone.
//
// **Disk is a hard constraint here, not a formality.** This runs in a
// container with a fixed writable allowance shared with everything else in
// it. Every rung is sized against `fs.statfsSync` free space, using the
// PREVIOUS rung's own measured bytes-per-entry — the generator's ratio does
// not change, so the last real measurement is a better predictor than any
// constant written in this file. When the next rung would not fit, the
// ladder stops there, on purpose, loudly.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants as bufferConstants } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import {
  VERDICT, SEVERITY, MEM, REPO, mem, buildCorpus, tempRoot, dirBytes, pct,
  cacheDirPath, cacheManifestPath,
} from './core.mjs';
import { MAX_SHARD_BYTES, META_SIZE_LIMIT } from '../../src/indexcache.mjs';

// --- thresholds, in the open -------------------------------------------
//
// Named here, not buried in a comparison, so a later reader can disagree
// with a specific number without re-deriving the measurement it decides.

/** Counter-check: relative error under this is a clean prediction. */
const PREDICT_PASS = 0.25;
/** Counter-check: relative error above this means the model is wrong. */
const PREDICT_FAIL = 1.0;
/** A fit made from fewer rungs than this is not a fit, whatever its R². */
const MIN_RUNGS_FOR_FIT = 4;
/**
 * The same floor for a straight line `y = base + slope*n`.
 *
 * Lower than the power-law floor on purpose, and the difference is the
 * degrees of freedom, not a softer standard: a power law fitted on
 * log-log has two free parameters AND a shape assumption, so four points
 * is the first count that can embarrass it. A straight line has two free
 * parameters and no shape assumption; three points already leave one
 * degree of freedom, which is what makes its R² mean something. Two
 * would not, and that is the number this floor exists to refuse.
 */
const MIN_RUNGS_FOR_LINE = 3;
/** Below this R², the fit does not describe the data it came from. */
const R2_FLOOR = 0.9;
/** The target every extrapolation in this phase reasons toward. */
const TARGET_N = 5_000_000;
/**
 * How much spare room a rung must leave, on top of its own estimated
 * bytes, before it is attempted.
 *
 * Not 1x: the estimate is a straight-line projection from one earlier
 * point and the generator's own zipf tail makes bytes-per-entry drift a
 * little as `TYPE_FILES` cycles unevenly, so a rung sized to exactly the
 * estimate can still overshoot it. 3x buys margin for that drift, for the
 * index cache the rung itself has not built yet, and for whatever else
 * this container is holding at the time.
 */
const DISK_SAFETY_MARGIN = 3;
/**
 * Bytes-per-entry guess for the FIRST rung, before anything has been
 * measured at all. Generous on purpose — corpus text plus a search-index
 * cache roughly three times its size (measured below, not assumed) — so
 * the very first estimate errs toward stopping early rather than filling
 * the disk on a guess.
 */
const FIRST_RUNG_BYTES_PER_ENTRY_GUESS = 1024;
/** A typical small-container memory limit, for reading the RSS projection. */
const TYPICAL_CONTAINER_RSS_LIMIT_MB = 512;

// --- the ladder ----------------------------------------------------------

function ladder(quick) {
  return quick ? [500, 2000, 8000] : [1000, 5000, 20000, 60000, 150000];
}

// --- small numeric helpers ------------------------------------------------

function round(v, d = 3) {
  return (v === null || v === undefined || !Number.isFinite(v)) ? null : +v.toFixed(d);
}

/**
 * Fit `y = a * n^b` by ordinary least squares on (ln n, ln y).
 *
 * Needs at least two points with n > 0 and y > 0; a caller that wants the
 * `MIN_RUNGS_FOR_FIT` floor enforces it itself, because two callers here
 * want that floor at different places (the reported fit, and the smaller
 * fit inside the counter-check).
 */
/**
 * Fit `y = base + slope * n` by ordinary least squares, with R².
 *
 * **Why wall 2 needs this and not a ratio.** The first cut of that wall
 * took peak RSS at the top rung, divided by the corpus bytes at that
 * rung, and multiplied the result by the projected corpus bytes at 5 M.
 * Measured here on 2026-09-20 that ratio was 93x — because RSS at 8,008
 * entries is ~127 MB of which the overwhelming part is a Node process
 * existing at all, and the corpus is 1.4 MB. Scaling a number that is
 * mostly a CONSTANT as if it were proportional projected ~82 GB, which
 * is not a measurement of anything. A straight line separates the two:
 * the intercept is what the process costs empty, the slope is what each
 * entry adds, and only the slope may be extrapolated.
 */
function fitLine(points) {
  const p = points.filter((pt) => Number.isFinite(pt.n) && Number.isFinite(pt.y));
  if (p.length < 2) return null;
  const n = p.length;
  const mx = p.reduce((s2, pt) => s2 + pt.n, 0) / n;
  const my = p.reduce((s2, pt) => s2 + pt.y, 0) / n;
  let sxy = 0; let sxx = 0;
  for (const pt of p) { sxy += (pt.n - mx) * (pt.y - my); sxx += (pt.n - mx) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const base = my - slope * mx;
  let ssRes = 0; let ssTot = 0;
  for (const pt of p) {
    const yh = base + slope * pt.n;
    ssRes += (pt.y - yh) ** 2;
    ssTot += (pt.y - my) ** 2;
  }
  return { base, slope, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot, points: n };
}

function fitPowerLaw(points) {
  const p = points.filter((pt) => pt.n > 0 && pt.y > 0);
  if (p.length < 2) return null;
  const xs = p.map((pt) => Math.log(pt.n));
  const ys = p.map((pt) => Math.log(pt.y));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0; let den = 0;
  for (let i = 0; i < xs.length; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  const b = num / den;
  const lnA = my - b * mx;
  const a = Math.exp(lnA);
  let ssRes = 0; let ssTot = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const pred = lnA + b * xs[i];
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  // A single distinct y-value makes ssTot 0 and R² undefined, not 1 — a
  // horizontal line through one repeated value is not a fit worth trusting.
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  return { a, b, r2, n: p.length };
}

function predictPowerLaw(fit, n) {
  if (!fit) return null;
  return fit.a * (n ** fit.b);
}

function relativeError(actual, predicted) {
  if (!(actual > 0) || predicted === null || !Number.isFinite(predicted)) return null;
  return Math.abs(predicted - actual) / actual;
}

/**
 * Fit on every rung but the last, predict the last, compare.
 *
 * This is the counter-check the task calls the point of the phase: an R²
 * taken on the same points a fit was made from is nearly meaningless for
 * three or four points on a monotone curve. Holding one rung back and
 * asking the fit to name it is the only test here that can actually fail.
 */
function counterCheck(points) {
  const p = points.filter((pt) => pt.n > 0 && pt.y > 0);
  if (p.length < MIN_RUNGS_FOR_FIT) {
    return {
      ok: false, reason: `only ${p.length} usable rung(s); at least ${MIN_RUNGS_FOR_FIT} `
        + 'are needed to hold one back and still fit on the rest',
    };
  }
  const held = p[p.length - 1];
  const trainFit = fitPowerLaw(p.slice(0, -1));
  if (!trainFit) return { ok: false, reason: 'the training fit did not converge' };
  const predicted = predictPowerLaw(trainFit, held.n);
  const err = relativeError(held.y, predicted);
  return {
    ok: true, heldOutN: held.n, heldOutActual: held.y, predicted: round(predicted, 3),
    relativeError: round(err, 4), trainFit,
  };
}

// --- disk budgeting --------------------------------------------------------

/** Free bytes on the filesystem that holds `dir`, or null if unreadable. */
function freeBytesAt(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Combined corpus + index-cache bytes actually spent on one rung, divided
 * by its entry count — the number the NEXT rung's estimate is built from.
 */
function bytesPerEntry(rung) {
  const total = (rung.corpusBytes ?? 0) + (rung.cacheBytes ?? 0);
  return rung.entries > 0 ? total / rung.entries : null;
}

// --- timing a real CLI call, kept deliberately small --------------------
//
// `phase-load` earns an adaptive, budget-fitting repeat count because it
// times eleven commands at every stage and needs the tail. This phase asks
// a narrower question — where does the curve bend — so a fixed, small
// repeat count that shrinks as the corpus grows is enough, and it keeps a
// run at the top of the ladder from spending its whole budget on p99 of a
// number nobody downstream needs past p50/p95.
function repsFor(n, quick) {
  if (n >= 60000) return quick ? 3 : 3;
  if (n >= 8000) return quick ? 3 : 4;
  return quick ? 3 : 6;
}

function timeCli(args, root, reps, { timeoutMs = 300000 } = {}) {
  const runs = [];
  let lastStatus = null;
  let lastStderr = null;
  for (let i = 0; i < reps; i += 1) {
    const r = mem(args, { root, timeoutMs });
    runs.push(r.ms);
    lastStatus = r.status;
    lastStderr = (r.stderr || '').slice(0, 200) || null;
  }
  const sorted = [...runs].sort((a, b) => a - b);
  const enough = reps >= 5;
  return {
    reps, p50: pct(sorted, 50), p95: enough ? pct(sorted, 95) : null,
    min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null,
    status: lastStatus, stderr: lastStderr,
  };
}

// --- peak RSS of one child process, sampled from /proc -------------------
//
// `heapAround` in core.mjs measures the CURRENT process's V8 heap; it
// cannot see a child's resident memory at all, and `mem()` runs the
// command with `spawnSync`, which blocks until exit and gives no chance to
// sample anything while it runs. This phase needs the CHILD's peak
// resident set, because that is what actually gets a process OOM-killed —
// so it spawns asynchronously and polls `/proc/<pid>/status` for
// `VmHWM`, the kernel's own running high-water mark, which is Linux-only
// and therefore guarded: anywhere else this returns `null` and the caller
// records `not-measured`.
/**
 * Peak RSS of one throwaway ES-module script, sampled the same way.
 *
 * Wall 2 is a claim about ONE function — `memory.readLog` holding a whole
 * drawer in memory — and the CLI numbers above cannot settle it: a `mem
 * find` process peaks on the search index, which is a different and much
 * larger structure, so attributing that peak to `readLog` would be a
 * probe measuring the wrong thing under the right name. This runs the
 * function alone, against a control that loads the same module and reads
 * nothing, so the difference is the drawer and not the interpreter.
 */
function peakRssOfScript(code, cwd, { pollMs = 10, timeoutMs = 300000 } = {}) {
  if (os.platform() !== 'linux') return Promise.resolve({ peakKB: null, sampled: 0, status: null });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd });
    let peakKB = 0;
    let sampled = 0;
    let out = '';
    let stderr = '';
    const readOnce = () => {
      try {
        const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const m = status.match(/VmHWM:\s+(\d+) kB/);
        if (m) { peakKB = Math.max(peakKB, Number(m[1])); sampled += 1; }
      } catch { /* gone between spawn and read */ }
    };
    const poll = setInterval(readOnce, pollMs);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('exit', readOnce);
    child.on('close', (code2) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({
        peakKB: sampled ? peakKB : null, sampled, status: code2,
        stdout: out.trim(), stderr: stderr.slice(0, 300) || null,
      });
    });
  });
}

/**
 * What `memory.readLog` costs in memory for a drawer of `targetBytes`,
 * over a control that loads the same module and reads nothing.
 *
 * **Why this builds its own drawer instead of using the ladder's.** The
 * first cut measured the biggest drawer each rung happened to have. At
 * quick-mode sizes those are a few hundred kilobytes, the marginal RSS
 * is inside the noise of one process start, and two of three rungs came
 * back with a non-positive difference — so the wall reported
 * not-measured, correctly but uselessly. A wall is a claim about a
 * mechanism, and the honest way to measure a mechanism is at sizes where
 * its signal is larger than the noise floor, not at whatever size some
 * other part of the run produced.
 *
 * Returns the drawer's size on disk and the MARGINAL peak RSS, so the
 * caller can state a multiplier that means "bytes held per byte on disk"
 * rather than "bytes held per byte on disk, plus a whole interpreter".
 */
async function readLogCost(targetBytes) {
  const root = tempRoot('atlas-readlog-');
  try {
    fs.mkdirSync(path.join(root, 'global'), { recursive: true });
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'),
      JSON.stringify({ participants: ['user', 'agent'], language: 'en' }));
    const file = path.join(root, 'global', 'learnings.jsonl');
    // Entries shaped like the real thing — an id, a timestamp, a title, a
    // body, tags — because readLog parses each line and holds the parsed
    // object, and the object graph is most of what it holds.
    const out = fs.openSync(file, 'w');
    let written = 0;
    let i = 0;
    const chunk = [];
    while (written < targetBytes) {
      const line = `${JSON.stringify({
        id: `r${(i += 1).toString(36)}`,
        ts: '2026-01-01T00:00:00Z',
        title: `drawer entry ${i}`,
        text: `body of drawer entry ${i} written so readLog has something to hold`,
        tags: ['drawer', 'probe'],
      })}\n`;
      chunk.push(line);
      written += Buffer.byteLength(line);
      if (chunk.length >= 4096) { fs.writeSync(out, chunk.join('')); chunk.length = 0; }
    }
    if (chunk.length) fs.writeSync(out, chunk.join(''));
    fs.closeSync(out);

    const modUrl = pathToFileURL(path.join(REPO, 'src', 'memory.mjs')).href;
    const head = `import * as m from ${JSON.stringify(modUrl)};\n`
      + `const root = ${JSON.stringify(root)};\n`;
    const control = await peakRssOfScript(`${head}process.stdout.write('0');`, root);
    const loaded = await peakRssOfScript(
      `${head}const r = m.readLog(root, 'learning');\nprocess.stdout.write(String(r.entries.length));`,
      root,
    );
    const entriesRead = Number(loaded.stdout);
    if (control.peakKB === null || loaded.peakKB === null || !Number.isFinite(entriesRead)) return null;
    return {
      drawerBytes: fs.statSync(file).size,
      entriesWritten: i,
      entriesRead,
      controlKB: control.peakKB,
      loadedKB: loaded.peakKB,
      marginalKB: loaded.peakKB - control.peakKB,
    };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* going away anyway */ }
  }
}

/** Drawer sizes, in bytes, the readLog wall measures itself at. */
function readLogLadder(quick) {
  const MB = 1048576;
  return quick ? [2 * MB, 8 * MB, 32 * MB] : [4 * MB, 16 * MB, 64 * MB, 128 * MB];
}

function peakRssDuringCli(args, root, { pollMs = 15, timeoutMs = 300000 } = {}) {
  if (os.platform() !== 'linux') return Promise.resolve({ peakKB: null, sampled: 0, ms: null, status: null });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [MEM, ...args], {
      cwd: root,
      env: { ...process.env, CHEAP_MEM_ROOT: root },
    });
    let peakKB = 0;
    let sampled = 0;
    const readOnce = () => {
      try {
        const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const m = status.match(/VmHWM:\s+(\d+) kB/);
        if (m) { peakKB = Math.max(peakKB, Number(m[1])); sampled += 1; }
      } catch { /* the process may already be gone between spawn and read */ }
    };
    const poll = setInterval(readOnce, pollMs);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('exit', readOnce); // one last read before the /proc entry disappears
    child.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({
        peakKB: sampled ? peakKB : null, sampled, ms: Date.now() - t0,
        status: code, stderr: stderr.slice(0, 200) || null,
      });
    });
  });
}

// --- append throughput: one type, one file, one writer at a time --------
//
// `mem log` does not measure a bare append: `src/cli/commands/write.mjs`
// runs `neighbours.neighbours()` — a scan of what already stands on the
// same topic — BEFORE `memory.logEntry()` ever touches the file. That
// scan is real cost every writer of this design pays on every write, so
// timing it through the CLI (not by calling `memory.logEntry` directly) is
// the honest number: it is what a user or an agent actually waits for,
// per this codebase's own convention for `mem()` in core.mjs.
function appendOnce(root, i) {
  return mem(['log', 'learning', '--title', `ceiling append probe ${i}`,
    '--text', `measuring single-file append throughput, sample ${i}`], { root, timeoutMs: 300000 });
}

// --- the phase -------------------------------------------------------------

export async function run(atlas, { quick = false } = {}) {
  const stages = ladder(quick);
  const phaseT0 = Date.now();

  atlas.phase('ceiling',
    'Where this design stops working, and why',
    [
      `Ladder (target): ${stages.join(' / ')} entries. Each rung is sized against`,
      'free disk before it is built, using the previous rung\'s own measured',
      'bytes-per-entry — not a constant written in this file — and the ladder',
      'stops, loudly, the moment the next rung would not fit.',
      '',
      'Section A is the measured curve. Section B fits a power law per series',
      'and then does the one thing that makes a fit meaningful: it holds the',
      'last rung back, fits on the rest, and checks whether the fit would have',
      `guessed it (PASS under ${PREDICT_PASS * 100}% error, DEGRADED under `
        + `${PREDICT_FAIL * 100}%, FAIL above). Every number extrapolated to `
        + `${TARGET_N.toLocaleString('en-US')} entries is recorded `,
      'NOT_MEASURED with `expected: null` — an extrapolation is not a',
      'measurement, whatever the counter-check said about it. Section C names',
      'five hard walls and measures, computes, or declares blind on each.',
    ].join('\n'));

  // =========================================================================
  // A — the measured ladder
  // =========================================================================

  const rungs = [];
  const stopped = [];
  let prevBytesPerEntry = null;

  for (const n of stages) {
    const freeDir = os.tmpdir();
    const free = freeBytesAt(freeDir);
    const guess = prevBytesPerEntry ?? FIRST_RUNG_BYTES_PER_ENTRY_GUESS;
    const estimated = n * guess * DISK_SAFETY_MARGIN;
    if (free !== null && estimated > free) {
      stopped.push({ n, free, estimated, guess });
      break;
    }

    const root = tempRoot(`atlas-ceiling-${n}-`);
    const corpus = buildCorpus(root, n, { seed: 42, anchors: 8 });
    const anchorPhrase = corpus.anchors[0]?.phrase ?? 'anchorphrase0zzq';

    // One untimed warm-up so the first timed command is not charged for
    // the very first cache build.
    mem(['find', anchorPhrase, '--top', '10'], { root, timeoutMs: 300000 });

    const reps = repsFor(n, quick);
    const findT = timeCli(['find', anchorPhrase, '--top', '10'], root, reps);
    const doctorT = timeCli(['doctor'], root, reps);
    const contextT = timeCli(['context'], root, reps);

    // Index build time: `--fresh` skips the cache read unconditionally
    // (src/search.mjs loadIndex — `if (!fresh && ...)`) and always
    // rewrites it afterward, so one call is the full cost of building the
    // index from the log and writing it back out. One sample, not a
    // distribution: at the top of the ladder this alone can take minutes,
    // and paying for it seven times to get a p95 nobody asked about would
    // eat the disk-safety margin's time budget for nothing.
    const cacheDir = cacheDirPath(root);
    const manifestPath = cacheManifestPath(root);
    const buildR = mem(['find', anchorPhrase, '--fresh', '--top', '1'], { root, timeoutMs: 300000 });
    // `null`, not 0, when the build above produced no readable cache —
    // "not measurable is not zero" applies to a rung's cache size the
    // same as anywhere else.
    let cacheBytes = null;
    // The one JSON document B8 still reads and writes as a single
    // string (see Wall 1 below); `null` when there is no manifest to
    // read it from.
    let metaBytes = null;
    let maxShardBytes = null;
    if (fs.existsSync(manifestPath)) {
      cacheBytes = dirBytes(cacheDir);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        metaBytes = manifest.meta?.bytes ?? null;
        const shardSizes = (manifest.documents ?? []).map((d) => d.bytes ?? 0);
        maxShardBytes = shardSizes.length ? Math.max(...shardSizes) : 0;
      } catch { /* manifest present but unreadable; cacheBytes stands, the rest stay null */ }
    }

    const rssResult = await peakRssDuringCli(['find', anchorPhrase, '--top', '10'], root);

    const corpusBytes = dirBytes(corpus.dir);

    const rung = {
      n, entries: corpus.count,
      corpusBytes, cacheBytes, metaBytes, maxShardBytes,
      findP50: findT.p50, findP95: findT.p95, findReps: findT.reps,
      doctorP50: doctorT.p50, doctorP95: doctorT.p95,
      contextP50: contextT.p50, contextP95: contextT.p95,
      indexBuildMs: round(buildR.ms, 1),
      peakRssKB: rssResult.peakKB, peakRssSamples: rssResult.sampled,
      status: {
        find: findT.status, doctor: doctorT.status, context: contextT.status, build: buildR.status,
      },
    };
    rungs.push(rung);
    prevBytesPerEntry = bytesPerEntry(rung);

    // Cleaned before the next rung is built, per the task's own budget —
    // this is not relying on tempRoot's exit-time sweep, which only runs
    // once the whole process ends and would let every rung's bytes sit on
    // disk at once in the meantime.
    fs.rmSync(root, { recursive: true, force: true });
  }

  for (const [i, n] of stages.entries()) {
    if (rungs.some((r) => r.n === n)) continue;
    const stop = stopped.find((s) => s.n === n);
    atlas.record({
      id: `ceiling.a.rung.${n}`,
      title: `corpus rung at ${n.toLocaleString('en-US')} entries`,
      verdict: VERDICT.NOT_MEASURED,
      expected: 'a full set of timings and sizes at this rung',
      actual: stop
        ? `not attempted: estimated ${(stop.estimated / 1048576).toFixed(0)} MB needed `
          + `(${stop.guess.toFixed(0)} B/entry x ${DISK_SAFETY_MARGIN}x margin) against `
          + `${stop.free === null ? 'an unreadable free-space read' : `${(stop.free / 1048576).toFixed(0)} MB free`}`
        : `not reached: the ladder stopped at a smaller rung (index ${i} of ${stages.length})`,
      severity: SEVERITY.INFO,
    });
    atlas.blind(`corpus rung at ${n.toLocaleString('en-US')} entries`,
      stop ? 'the disk-space check refused to build it (see actual)'
        : 'an earlier rung in the ladder was itself refused, so this one was never reached');
  }

  if (!rungs.length) {
    atlas.record({
      id: 'ceiling.a.no-rungs',
      title: 'the ladder produced no measured rungs at all',
      verdict: VERDICT.NOT_MEASURED,
      expected: `at least ${stages[0]} entries measured`,
      actual: 'the very first rung was refused by the disk-space check',
    });
    atlas.blind('the entire ceiling ladder', 'no rung fit inside the estimated disk budget');
    return;
  }

  atlas.record({
    id: 'ceiling.a.ladder',
    title: `rungs actually measured: ${rungs.map((r) => r.entries).join(', ')}`,
    verdict: VERDICT.PASS,
    expected: `up to ${stages[stages.length - 1].toLocaleString('en-US')} entries, disk allowing`,
    actual: `reached ${rungs[rungs.length - 1].entries.toLocaleString('en-US')} entries `
      + `(${rungs.length} of ${stages.length} planned rungs)`,
    measured: { rungs },
    evidence: rungs.map((r) => `${r.entries}: find p50 ${round(r.findP50, 1)} ms, `
      + `doctor p50 ${round(r.doctorP50, 1)} ms, context p50 ${round(r.contextP50, 1)} ms, `
      + `index build ${r.indexBuildMs} ms, corpus ${(r.corpusBytes / 1024).toFixed(0)} KB, `
      + `cache ${r.cacheBytes === null ? 'n/a' : `${(r.cacheBytes / 1024).toFixed(0)} KB`}, `
      + `peak RSS ${r.peakRssKB === null ? 'n/a' : `${(r.peakRssKB / 1024).toFixed(1)} MB`}`).join('\n'),
  });

  // =========================================================================
  // B — fit, counter-check, extrapolate
  // =========================================================================

  const SERIES = [
    { key: 'find', label: 'mem find p50', get: (r) => r.findP50 },
    { key: 'doctor', label: 'mem doctor p50', get: (r) => r.doctorP50 },
    { key: 'context', label: 'mem context p50', get: (r) => r.contextP50 },
    { key: 'indexBuild', label: 'index build time', get: (r) => r.indexBuildMs },
    { key: 'indexBytes', label: 'index cache size on disk', get: (r) => r.cacheBytes },
  ];

  for (const s of SERIES) {
    const points = rungs.map((r) => ({ n: r.entries, y: s.get(r) })).filter((p) => p.y != null);
    if (points.length < MIN_RUNGS_FOR_FIT) {
      atlas.record({
        id: `ceiling.b.fit.${s.key}`,
        title: `${s.label}: power-law fit`,
        verdict: VERDICT.NOT_MEASURED,
        expected: `at least ${MIN_RUNGS_FOR_FIT} rungs, so a fit is not just a line `
          + 'through however many points happen to exist',
        actual: `only ${points.length} usable rung(s) reached — two points make an `
          + 'R\u00b2 of exactly 1 and mean nothing, so this is refused rather than reported',
        measured: { points },
      });
      atlas.blind(`${s.label}: fit and extrapolation`,
        `fewer than ${MIN_RUNGS_FOR_FIT} rungs were measured for this series`);
      continue;
    }

    const fullFit = fitPowerLaw(points);
    const cc = counterCheck(points);

    if (fullFit) {
      const r2Verdict = fullFit.r2 === null ? VERDICT.NOT_MEASURED
        : fullFit.r2 < R2_FLOOR ? VERDICT.DEGRADED : VERDICT.PASS;
      atlas.record({
        id: `ceiling.b.fit.${s.key}`,
        title: `${s.label}: power-law fit a*n^b over the measured rungs`,
        verdict: r2Verdict,
        expected: `R\u00b2 >= ${R2_FLOOR} — DEGRADED below it, because a fit that does `
          + 'not describe the data it was made from is not a basis for a ceiling',
        actual: fullFit.r2 === null
          ? 'every measured value was identical; R\u00b2 is undefined, not 1'
          : `a=${round(fullFit.a, 4)}, b=${round(fullFit.b, 3)}, R\u00b2=${round(fullFit.r2, 4)} `
            + `over ${fullFit.n} rungs`,
        severity: SEVERITY.MINOR,
        measured: { fit: fullFit, points },
      });
    }

    if (!cc.ok) {
      atlas.record({
        id: `ceiling.b.counter-check.${s.key}`,
        title: `${s.label}: prediction counter-check`,
        verdict: VERDICT.NOT_MEASURED,
        expected: `fit on all rungs but the last, predict the last, within `
          + `${PREDICT_PASS * 100}% for PASS`,
        actual: `not run: ${cc.reason}`,
      });
      atlas.blind(`${s.label}: prediction counter-check`, cc.reason);
    } else {
      const verdict = cc.relativeError === null ? VERDICT.NOT_MEASURED
        : cc.relativeError <= PREDICT_PASS ? VERDICT.PASS
          : cc.relativeError <= PREDICT_FAIL ? VERDICT.DEGRADED : VERDICT.FAIL;
      atlas.record({
        id: `ceiling.b.counter-check.${s.key}`,
        title: `${s.label}: prediction counter-check (held-out rung ${cc.heldOutN.toLocaleString('en-US')})`,
        verdict,
        expected: `relative error <= ${PREDICT_PASS * 100}% is PASS, `
          + `<= ${PREDICT_FAIL * 100}% is DEGRADED, above that is FAIL — a model that `
          + 'cannot predict one rung it did not see has no business predicting '
          + `${TARGET_N.toLocaleString('en-US')}`,
        actual: `trained on ${cc.trainFit.n} smaller rung(s) (a=${round(cc.trainFit.a, 4)}, `
          + `b=${round(cc.trainFit.b, 3)}), predicted ${round(cc.predicted, 3)} at `
          + `${cc.heldOutN.toLocaleString('en-US')} entries, measured ${round(cc.heldOutActual, 3)} `
          + `— ${cc.relativeError === null ? 'no error computable' : `${(cc.relativeError * 100).toFixed(1)}% off`}`,
        severity: verdict === VERDICT.FAIL ? SEVERITY.MAJOR : SEVERITY.MINOR,
        measured: { counterCheck: cc, points },
      });
    }

    // The extrapolation itself. Always recorded, always NOT_MEASURED, and
    // when the counter-check above did not pass, that failure is named
    // directly in this record's own evidence — not just alongside it —
    // so nobody can read this row on its own and mistake a curve for a
    // fact.
    const predicted5M = fullFit ? predictPowerLaw(fullFit, TARGET_N) : null;
    const ccFailed = cc.ok && cc.relativeError !== null && cc.relativeError > PREDICT_PASS;
    atlas.record({
      id: `ceiling.b.extrapolate.${s.key}`,
      title: `${s.label}: extrapolated to ${TARGET_N.toLocaleString('en-US')} entries`,
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: predicted5M === null
        ? 'no fit was available to extrapolate from'
        : `~${round(predicted5M, 1)} ${s.key === 'indexBytes' ? 'bytes'
          : s.key === 'indexBuild' ? 'ms' : 'ms'} at ${TARGET_N.toLocaleString('en-US')} `
          + `entries — an EXTRAPOLATION from a*n^b fitted on rungs up to `
          + `${rungs[rungs.length - 1].entries.toLocaleString('en-US')}, never observed`,
      measured: { fit: fullFit, predicted5M: round(predicted5M, 3) },
      evidence: `highest rung actually measured: ${rungs[rungs.length - 1].entries.toLocaleString('en-US')} entries.`
        + (ccFailed
          ? ` The prediction counter-check for this series FAILED or DEGRADED `
            + `(${(cc.relativeError * 100).toFixed(1)}% error on the held-out rung), so this `
            + 'number should not be trusted at 5M — the model it comes from could not '
            + 'even predict a rung it had already seen the neighbours of.'
          : ' The prediction counter-check for this series passed within its stated '
            + 'threshold, which is evidence the model generalises one rung past what it '
            + 'was fit on — not evidence it holds four orders of magnitude further out.'),
    });
  }

  // =========================================================================
  // C — the five hard walls
  // =========================================================================

  const topRung = rungs[rungs.length - 1];
  const combinedBytesPerEntry = bytesPerEntry(topRung);

  // --- Wall 1: JSON.parse on the whole index cache -------------------------
  //
  // **Superseded by B8 (2026-09-20), not just relocated.** This wall used
  // to be `loadIndex` reading the entire cache file into one string and
  // calling `JSON.parse` on it whole — V8 refuses to build a string past
  // `buffer.constants.MAX_STRING_LENGTH` regardless of available memory,
  // so the cache became simply unreadable past that many bytes
  // (`src/indexcache.mjs`'s module doc: measured at ~978k entries). B8
  // replaced that single file with a directory of shards, each capped at
  // `MAX_SHARD_BYTES` BY CONSTRUCTION (`planShards` in
  // `src/indexcache.mjs`) — an order of magnitude under the string
  // limit — so no single read can ever again approach it, independent of
  // corpus size. Projecting the OLD per-entry-linear model onto the new
  // total cache-directory bytes would score a wall that no longer exists
  // (every shard is already bounded, not growing toward a limit) — so
  // this checks the two things that actually could still hit a limit,
  // measured rather than assumed:
  //   shard cap    every observed shard, at every rung reached, stays
  //                at or under `MAX_SHARD_BYTES` — the structural
  //                guarantee `planShards` is supposed to provide.
  //   meta.json    the one part of the cache still written and read as
  //                ONE JSON string (`docFreq`/`lexicon`/`tagGraph`/
  //                `termGraph`/`entityIndex`). It is bounded by
  //                VOCABULARY size, not entry count (Heaps' law: growth
  //                is sub-linear in the corpus) — extrapolating it
  //                linearly to 5M would OVERSTATE its growth, so this
  //                reports it measured at the largest rung reached
  //                instead of projecting it. `src/indexcache.mjs`'s own
  //                module doc already names this NOT-MEASURED: "whether
  //                a real corpus can grow a termGraph or entityIndex
  //                large enough to matter".
  const shardCapRungs = rungs.filter((r) => r.maxShardBytes != null);
  const overShardCap = shardCapRungs.find((r) => r.maxShardBytes > MAX_SHARD_BYTES);
  if (topRung.metaBytes != null && shardCapRungs.length) {
    const metaBytesPerEntry = topRung.metaBytes / topRung.entries;
    const metaVsStringLimit = topRung.metaBytes / bufferConstants.MAX_STRING_LENGTH;
    const metaVsSizeLimit = topRung.metaBytes / META_SIZE_LIMIT;
    const nearAWall = metaVsStringLimit > 0.5 || metaVsSizeLimit > 0.5;
    atlas.record({
      id: 'ceiling.c.wall1.json-parse-limit',
      title: 'wall 1: JSON.parse on the whole index cache hits V8\'s max string length',
      verdict: overShardCap ? VERDICT.FAIL : (nearAWall ? VERDICT.DEGRADED : VERDICT.PASS),
      expected: `every shard stays at or under MAX_SHARD_BYTES (${MAX_SHARD_BYTES.toLocaleString('en-US')} `
        + `B) at every rung reached, and meta.json stays well under both V8's max string `
        + `length (${bufferConstants.MAX_STRING_LENGTH.toLocaleString('en-US')} B) and `
        + `META_SIZE_LIMIT (${META_SIZE_LIMIT.toLocaleString('en-US')} B)`,
      actual: overShardCap
        ? `a shard of ${overShardCap.maxShardBytes.toLocaleString('en-US')} B exceeded `
          + `MAX_SHARD_BYTES at ${overShardCap.entries.toLocaleString('en-US')} entries — `
          + 'the structural cap did not hold'
        : `largest shard observed: ${Math.max(...shardCapRungs.map((r) => r.maxShardBytes))
          .toLocaleString('en-US')} B, at or under the ${MAX_SHARD_BYTES.toLocaleString('en-US')} `
          + `B cap at every rung reached (${shardCapRungs.length} rung(s)); meta.json at `
          + `${topRung.entries.toLocaleString('en-US')} entries: `
          + `${topRung.metaBytes.toLocaleString('en-US')} B `
          + `(${metaBytesPerEntry.toFixed(2)} B/entry, NOT extrapolated to `
          + `${TARGET_N.toLocaleString('en-US')} — vocabulary growth is sub-linear, see evidence)`,
      severity: SEVERITY.CRITICAL,
      measured: {
        maxShardBytesByRung: shardCapRungs.map((r) => ({ entries: r.entries, maxShardBytes: r.maxShardBytes })),
        maxShardBytesCap: MAX_SHARD_BYTES,
        metaBytesAtTopRung: topRung.metaBytes,
        metaBytesPerEntry: round(metaBytesPerEntry, 2),
        metaVsStringLimit: round(metaVsStringLimit, 4),
        metaVsSizeLimit: round(metaVsSizeLimit, 4),
        maxStringLength: bufferConstants.MAX_STRING_LENGTH,
        metaSizeLimit: META_SIZE_LIMIT,
      },
      evidence: 'B8 (2026-09-20, src/indexcache.mjs) retired the single whole-cache '
        + '`JSON.parse` this wall used to project against: `writeIndexCache`\'s '
        + '`planShards` caps every document shard at `MAX_SHARD_BYTES` before it is ever '
        + 'written, so no shard read can approach the string limit at any corpus size — '
        + 'a structural guarantee, checked here rather than assumed. `meta.json` is the '
        + 'one remaining single-JSON-string read (`readIndexCache`); it holds vocabulary '
        + 'structures that grow sub-linearly with the corpus (Heaps\' law), so this '
        + 'reports its measured size at the largest rung reached and does not extrapolate '
        + 'it to 5M the way the retired per-entry model did for the whole cache.',
    });
  } else {
    atlas.record({
      id: 'ceiling.c.wall1.json-parse-limit',
      title: 'wall 1: JSON.parse on the whole index cache hits V8\'s max string length',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'a manifest.json to read shard sizes and meta.json size from',
      actual: 'no rung produced a readable index cache (manifest.json missing or unparsable)',
    });
    atlas.blind('wall 1: JSON.parse string-length ceiling', 'no cache manifest was measured');
  }

  // --- Wall 2: whole-file read of a drawer ---------------------------------
  //
  // `src/memory.mjs` readLog(): `fs.readFileSync(p, 'utf8')` then
  // `.split('\n')` — the whole drawer, in memory, twice over (once as the
  // read buffer/string, once as the array of lines) before a single entry
  // is parsed. Projected here from the measured corpus-bytes-per-entry and
  // the measured RSS-to-corpus-bytes ratio at the largest rung reached.
  // The wall is a claim about ONE function, so it is measured on that
  // function, at its own sizes: `readLogCost` builds a drawer of a given
  // size, runs `memory.readLog` on it in a fresh process, and subtracts a
  // control that imports the same module and reads nothing.
  const readSamples = [];
  for (const bytes of readLogLadder(quick)) {
    const free = freeBytesAt(os.tmpdir());
    if (free !== null && free < bytes * DISK_SAFETY_MARGIN) {
      atlas.blind(`wall 2 drawer of ${(bytes / 1048576).toFixed(0)} MB`,
        `only ${(free / 1048576).toFixed(0)} MB free, and a drawer needs its own size `
        + `times ${DISK_SAFETY_MARGIN} of room`);
      break;
    }
    const sample = await readLogCost(bytes);
    if (sample) readSamples.push(sample);
  }
  const readPoints = readSamples
    .filter((r) => r.drawerBytes > 0 && r.marginalKB > 0)
    .map((r) => ({ n: r.drawerBytes / 1048576, y: (r.marginalKB * 1024) / 1048576 }));
  const readFit = readPoints.length >= MIN_RUNGS_FOR_LINE ? fitLine(readPoints) : null;
  const topRead = readSamples.length ? readSamples[readSamples.length - 1] : null;

  if (combinedBytesPerEntry && readFit && readFit.slope > 0) {
    const corpusBytesPerEntry = topRung.corpusBytes / topRung.entries;
    // One type, one project, is ONE file — so the wall's drawer at 5 M
    // entries is the whole corpus text, not a share of it.
    const drawerBytesAt5M = corpusBytesPerEntry * TARGET_N;
    const projectedRssMB = readFit.base + readFit.slope * (drawerBytesAt5M / 1048576);
    const weakFit = readFit.r2 < R2_FLOOR;
    atlas.record({
      id: 'ceiling.c.wall2.whole-file-read',
      title: 'wall 2: readLog() holds a whole drawer in memory before parsing it',
      // A line that does not describe its own points is not a basis for
      // a CRITICAL verdict, however large the number it produces.
      verdict: (projectedRssMB > TYPICAL_CONTAINER_RSS_LIMIT_MB && !weakFit)
        ? VERDICT.FAIL : VERDICT.DEGRADED,
      expected: `reading one drawer at ${TARGET_N.toLocaleString('en-US')} entries should stay `
        + `under a typical small-container limit (${TYPICAL_CONTAINER_RSS_LIMIT_MB} MB, named `
        + 'here rather than assumed universal)',
      actual: `measured over ${readFit.points} rung(s), readLog alone (control subtracted): `
        + `${(readFit.slope).toFixed(2)} MB held per MB of drawer on disk `
        + `(R²=${round(readFit.r2, 3)}); largest drawer measured `
        + `${(topRead.drawerBytes / 1048576).toFixed(2)} MB -> `
        + `${(topRead.marginalKB / 1024).toFixed(1)} MB. EXTRAPOLATED: a `
        + `${(drawerBytesAt5M / 1048576).toFixed(0)} MB drawer at `
        + `${TARGET_N.toLocaleString('en-US')} entries -> ~${projectedRssMB.toFixed(0)} MB`
        + (weakFit ? ' — but the line does not describe its own points, so read this as a shape, not a figure' : ''),
      severity: weakFit ? SEVERITY.MAJOR : SEVERITY.CRITICAL,
      measured: {
        corpusBytesPerEntry: round(corpusBytesPerEntry, 2),
        heldMBPerDrawerMB: round(readFit.slope, 3),
        fitInterceptMB: round(readFit.base, 2),
        fitR2: round(readFit.r2, 4),
        rungs: readSamples.map((r) => ({
          drawerMB: round(r.drawerBytes / 1048576, 2),
          heldMB: round(r.marginalKB / 1024, 1),
          entriesRead: r.entriesRead,
        })),
        projectedDrawerMBAt5M: round(drawerBytesAt5M / 1048576, 1),
        projectedHeldMBAt5M: round(projectedRssMB, 1),
      },
      evidence: 'src/memory.mjs readLog(): `const raw = fs.readFileSync(p, \'utf8\'); '
        + 'for (const line of raw.split(\'\\n\'))` — the file as one string, then as '
        + 'an array of lines, then as parsed objects, all live at once. Measured by '
        + 'running that function alone in a fresh process and subtracting a control '
        + 'that imports the same module and reads nothing, so the number is the '
        + 'drawer and not the interpreter. An earlier cut of this wall divided a `mem '
        + 'find` process peak by the corpus bytes and scaled the result: that ratio '
        + 'was ~93x because it folded in ~70 MB of fixed process cost, and it '
        + 'projected about two orders of magnitude too high. Cross-checked once with '
        + 'a second instrument (2026-09-20, 32 MB drawer, 191,100 entries): '
        + '`process.memoryUsage().heapUsed` around the same call grew 3.1x the '
        + 'drawer, against 4.6x by VmHWM. The two agree on the shape and differ as '
        + 'they should — VmHWM is a high-water mark and catches the whole string and '
        + 'the split array before either is collected, which is the number that '
        + 'decides whether a container survives the call. The remaining assumption '
        + 'is that the slope stays linear far past the largest drawer measured here, '
        + 'which is a design claim this phase cannot verify — that is what makes it a '
        + 'wall rather than a figure.',
    });
  } else {
    const why = !combinedBytesPerEntry
      ? 'no corpus-bytes-per-entry ratio was measured'
      : (readPoints.length < MIN_RUNGS_FOR_LINE
        ? `only ${readPoints.length} of ${readSamples.length} drawer size(s) produced a `
          + `positive marginal cost; at least ${MIN_RUNGS_FOR_LINE} are needed for a line `
          + 'with any residual'
        : 'the fitted per-byte slope was not positive — at these drawer sizes the '
          + 'measurement is inside process noise, and a non-positive slope cannot be projected');
    atlas.record({
      id: 'ceiling.c.wall2.whole-file-read',
      title: 'wall 2: readLog() holds a whole drawer in memory before parsing it',
      verdict: VERDICT.NOT_MEASURED,
      expected: `a held-bytes-per-disk-byte slope over at least ${MIN_RUNGS_FOR_LINE} rungs`,
      actual: why,
      evidence: 'peak RSS is read from /proc/<pid>/status (VmHWM), so this is Linux-only.',
    });
    atlas.blind('wall 2: whole-file-read memory projection', why);
  }

  // The whole-process peak is a different and coarser question, kept as
  // its own record rather than folded into the wall above: what a `mem`
  // invocation costs end to end is dominated by the search index, not by
  // readLog, and reporting it under readLog's name was exactly the
  // mistake this pair of records replaces. Never a FAIL — it has no
  // stated expectation to miss.
  const rssPoints = rungs
    .filter((r) => r.peakRssKB)
    .map((r) => ({ n: r.entries, y: (r.peakRssKB * 1024) / 1048576 }));
  const rssFit = rssPoints.length >= MIN_RUNGS_FOR_LINE ? fitLine(rssPoints) : null;
  if (rssFit && rssFit.slope > 0) {
    atlas.record({
      id: 'ceiling.c.process-rss',
      title: 'what one `mem` invocation costs in memory, empty and per entry',
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: `${rssFit.base.toFixed(1)} MB for a process that finds nothing, plus `
        + `${(rssFit.slope * 1024).toFixed(2)} KB per entry in the corpus `
        + `(straight line over ${rssFit.points} rung(s), R²=${round(rssFit.r2, 3)}); `
        + `EXTRAPOLATED ~${(rssFit.base + rssFit.slope * TARGET_N).toFixed(0)} MB at `
        + `${TARGET_N.toLocaleString('en-US')} entries`,
      severity: SEVERITY.INFO,
      measured: {
        baseMB: round(rssFit.base, 2),
        slopeKBPerEntry: round(rssFit.slope * 1024, 4),
        r2: round(rssFit.r2, 4),
        rungs: rssPoints.map((pt) => ({ entries: pt.n, peakRssMB: round(pt.y, 1) })),
      },
      evidence: `Per-entry cost here is ${(rssFit.slope * 1024).toFixed(2)} KB against `
        + `${(topRung.corpusBytes / topRung.entries).toFixed(0)} B on disk — the difference `
        + 'is the search index, which is the structure a `mem find` process actually peaks '
        + 'on. That is why this is NOT the readLog wall above, and why it carries no '
        + 'expectation: it is a property of the whole command, not of one guarantee.',
    });
  } else {
    atlas.blind('per-invocation RSS line',
      `only ${rssPoints.length} rung(s) carried a peak-RSS sample, or the slope was not positive`);
  }

  // --- Wall 3: linear scan per query ----------------------------------------
  //
  // This is exactly the `find` exponent already fit in section B — named
  // again here as a wall in its own right, with the number a user would
  // actually feel: what p95 becomes at 5M, honestly labelled as computed.
  //
  // Gated on the SAME `MIN_RUNGS_FOR_FIT` floor as `ceiling.b.fit.find`,
  // deliberately: this is not a second, independent fit, it is the same
  // curve read for a different question. Printing a number here that
  // section B just refused to print would be two conflicting answers to
  // "is there a fit" inside one report.
  const findPoints = rungs.map((r) => ({ n: r.entries, y: r.findP50 })).filter((p) => p.y != null);
  const findFit = findPoints.length >= MIN_RUNGS_FOR_FIT ? fitPowerLaw(findPoints) : null;
  const findP95Points = rungs.map((r) => ({ n: r.entries, y: r.findP95 })).filter((p) => p.y != null);
  const findP95Fit = findP95Points.length >= MIN_RUNGS_FOR_FIT ? fitPowerLaw(findP95Points) : null;
  if (findFit) {
    const predictedP50At5M = predictPowerLaw(findFit, TARGET_N);
    const predictedP95At5M = findP95Fit ? predictPowerLaw(findP95Fit, TARGET_N) : null;
    atlas.record({
      id: 'ceiling.c.wall3.linear-scan',
      title: 'wall 3: find time against corpus size — is the scan linear, and what does it cost at 5M',
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: `measured growth exponent b=${round(findFit.b, 3)} over `
        + `${rungs.length} rung(s) up to ${topRung.entries.toLocaleString('en-US')} entries `
        + `(b=1 is linear); EXTRAPOLATED p50 at ${TARGET_N.toLocaleString('en-US')} entries `
        + `~${round(predictedP50At5M / 1000, 2)} s`
        + (predictedP95At5M !== null ? `, extrapolated p95 ~${round(predictedP95At5M / 1000, 2)} s` : ', p95 not separately fittable — see the p95 fit blind spot'),
      severity: SEVERITY.INFO,
      measured: {
        findFit, findP95Fit, predictedP50MsAt5M: round(predictedP50At5M, 1),
        predictedP95MsAt5M: round(predictedP95At5M, 1),
      },
      evidence: `see ceiling.b.fit.find and ceiling.b.counter-check.find for whether this `
        + 'exponent is a trustworthy basis for the number above.',
    });
    if (!findP95Fit) {
      atlas.blind('wall 3: find p95 extrapolation',
        `fewer than ${MIN_RUNGS_FOR_FIT} rungs produced a usable p95 (reps fell below the `
        + 'percentile floor at the larger rungs, or the ladder itself stopped short)');
    }
  } else {
    atlas.record({
      id: 'ceiling.c.wall3.linear-scan',
      title: 'wall 3: find time against corpus size',
      verdict: VERDICT.NOT_MEASURED,
      expected: `a growth exponent for \`mem find\` over at least ${MIN_RUNGS_FOR_FIT} rungs`,
      actual: `only ${findPoints.length} usable rung(s) — see ceiling.b.fit.find, which refuses `
        + 'the same fit for the same reason',
    });
    atlas.blind('wall 3: linear-scan exponent',
      `fewer than ${MIN_RUNGS_FOR_FIT} rungs produced a usable \`mem find\` p50`);
  }

  // --- Wall 4: single-file append contention --------------------------------
  //
  // One append, timed through the real CLI (see appendOnce's comment for
  // why not a bare memory.logEntry call), at the largest rung actually
  // reached. Every writer of the `learning` type serialises on
  // `learnings.jsonl`, so this is also the number that would be split
  // across N concurrent writers if this design ever grew one queue per
  // writer instead of one file per type.
  try {
    const root = tempRoot('atlas-ceiling-append-');
    buildCorpus(root, topRung.entries, { seed: 42, anchors: 8 });
    mem(['find', 'warmup'], { root, timeoutMs: 300000 });
    const appendReps = quick ? 3 : 5;
    const times = [];
    for (let i = 0; i < appendReps; i += 1) {
      const r = appendOnce(root, i);
      if (r.status === 0) times.push(r.ms);
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (times.length) {
      const meanMs = times.reduce((a, b) => a + b, 0) / times.length;
      const perSec = 1000 / meanMs;
      const secondsFor5M = TARGET_N / perSec;
      atlas.record({
        id: 'ceiling.c.wall4.append-contention',
        title: 'wall 4: single-file append throughput, and the wall-clock cost of 5M writes at that rate',
        verdict: VERDICT.NOT_MEASURED,
        expected: null,
        actual: `measured: ${meanMs.toFixed(1)} ms/append (mean of ${times.length} calls to `
          + `\`mem log\`) at ${topRung.entries.toLocaleString('en-US')} existing entries in the `
          + `drawer = ${perSec.toFixed(2)} entries/sec through one writer. EXTRAPOLATED: writing `
          + `${TARGET_N.toLocaleString('en-US')} entries at that rate would take `
          + `~${(secondsFor5M / 86400).toFixed(1)} days of wall clock, serialised through a `
          + 'single writer of one type — never observed at that scale',
        severity: SEVERITY.CRITICAL,
        measured: {
          meanAppendMs: round(meanMs, 2), reps: times.length, entriesInDrawer: topRung.entries,
          entriesPerSecond: round(perSec, 3), secondsFor5M: round(secondsFor5M, 0),
        },
        evidence: 'src/cli/commands/write.mjs `log`: `neighbours.neighbours(root, type, data, ...)` '
          + 'runs before `memory.logEntry()` on every write, so this number already includes a '
          + `corpus-dependent lookup, not a bare append — it is measured with `
          + `${topRung.entries.toLocaleString('en-US')} entries already in the drawer, which is `
          + 'itself a driver of the cost this wall names. One file per type means every writer '
          + 'of that type serialises on it; this measures one writer, not contention between several.',
      });
    } else {
      atlas.record({
        id: 'ceiling.c.wall4.append-contention',
        title: 'wall 4: single-file append throughput',
        verdict: VERDICT.NOT_MEASURED,
        expected: 'at least one successful `mem log` call to time',
        actual: `all ${appendReps} attempts exited non-zero`,
      });
      atlas.blind('wall 4: append throughput', 'every `mem log` probe call failed');
    }
  } catch (e) {
    atlas.record({
      id: 'ceiling.c.wall4.append-contention',
      title: 'wall 4: single-file append throughput',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'a measured append rate',
      actual: `threw: ${String(e.message).slice(0, 200)}`,
    });
    atlas.blind('wall 4: append throughput', String(e.message).slice(0, 200));
  }

  // --- Wall 5: git as the transport ------------------------------------------
  //
  // Only measured when git is actually usable here: a rung root this
  // phase itself turned into a repository, never the real checkout this
  // benchmark runs from. `git add` + `git commit` on the largest rung's
  // own drawer file names the cost of one commit at that size; the
  // drawer-size-at-5M projection reuses the same corpus-bytes-per-entry
  // ratio as wall 2.
  try {
    const gitRoot = tempRoot('atlas-ceiling-git-');
    const corpus = buildCorpus(gitRoot, Math.min(topRung.entries, quick ? 4000 : 40000), { seed: 42, anchors: 8 });
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.email', 'atlas@localhost'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.name', 'atlas'], { cwd: gitRoot });
    const t0 = Date.now();
    execFileSync('git', ['add', '-A'], { cwd: gitRoot });
    const addMs = Date.now() - t0;
    const t1 = Date.now();
    execFileSync('git', ['commit', '-q', '-m', 'atlas ceiling probe'], { cwd: gitRoot });
    const commitMs = Date.now() - t1;
    const drawerFile = path.join(corpus.dir, 'learnings.jsonl');
    const drawerBytes = fs.existsSync(drawerFile) ? fs.statSync(drawerFile).size : 0;
    const drawerEntries = drawerBytes > 0
      ? fs.readFileSync(drawerFile, 'utf8').split('\n').filter(Boolean).length : 0;
    const drawerBytesPerEntry = drawerEntries > 0 ? drawerBytes / drawerEntries : null;
    fs.rmSync(gitRoot, { recursive: true, force: true });
    if (drawerBytesPerEntry) {
      const projectedDrawerMBAt5M = (drawerBytesPerEntry * TARGET_N) / 1048576;
      atlas.record({
        id: 'ceiling.c.wall5.git-transport',
        title: 'wall 5: one file per type means a 5M-entry drawer is one enormous file in every clone',
        verdict: VERDICT.NOT_MEASURED,
        expected: null,
        actual: `measured: ${drawerBytesPerEntry.toFixed(1)} B/entry in learnings.jsonl `
          + `(${drawerEntries.toLocaleString('en-US')} entries, ${(drawerBytes / 1024).toFixed(1)} KB), `
          + `git add ${addMs} ms, git commit ${commitMs} ms at this size. PROJECTED: a `
          + `single drawer type at ${TARGET_N.toLocaleString('en-US')} entries would be `
          + `~${projectedDrawerMBAt5M.toFixed(0)} MB, present whole in every clone and every `
          + 'checkout — never observed at that scale',
        severity: SEVERITY.MAJOR,
        measured: {
          drawerBytesPerEntry: round(drawerBytesPerEntry, 2), drawerEntries, drawerBytes,
          addMs, commitMs, projectedDrawerMBAt5M: round(projectedDrawerMBAt5M, 1),
        },
        evidence: 'One JSONL file per type (src/memory.mjs TYPES), append-only, tracked in git. '
          + `git add/commit timed on a ${corpus.count.toLocaleString('en-US')}-entry corpus this `
          + 'phase built and committed for the purpose, in its own throwaway repository — never '
          + 'the checkout this benchmark itself runs from.',
      });
    } else {
      atlas.record({
        id: 'ceiling.c.wall5.git-transport',
        title: 'wall 5: git as the transport for a growing drawer',
        verdict: VERDICT.NOT_MEASURED,
        expected: 'a readable drawer file to measure bytes-per-entry from',
        actual: 'the drawer file was empty or unreadable after the commit',
      });
      atlas.blind('wall 5: git transport', 'the committed drawer file could not be read back');
    }
  } catch (e) {
    atlas.record({
      id: 'ceiling.c.wall5.git-transport',
      title: 'wall 5: git as the transport for a growing drawer',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'git available and usable to init/add/commit a throwaway rung',
      actual: `not measured: ${String(e.message).slice(0, 200)}`,
    });
    atlas.blind('wall 5: git transport', String(e.message).slice(0, 200));
  }

  // --- what this phase did not reach ---------------------------------------

  if (rungs[rungs.length - 1].entries < TARGET_N) {
    atlas.blind(`direct measurement above ${topRung.entries.toLocaleString('en-US')} entries`,
      `every number against ${TARGET_N.toLocaleString('en-US')} entries in this phase is an `
      + 'extrapolation or a computation from a measured ratio, never an observation — the '
      + `ladder stops at ${topRung.entries.toLocaleString('en-US')} entries on this machine, by `
      + 'disk, by time budget, or both.');
  }
  atlas.blind('peak RSS attribution',
    'the RSS sample in section A and wall 2 covers the whole `mem find` process — Node itself, '
    + 'every module it loads, and the search path — not readLog() in isolation; wall 2\'s '
    + 'projection assumes the ratio observed there carries over to a plain drawer read, which '
    + 'this phase does not measure separately.');
  atlas.blind('concurrent writers on wall 4',
    'the append-throughput measurement is one writer against an idle drawer; contention between '
    + 'several simultaneous writers on the same file is named as the wall but not produced here.');

  const wallBudgetMs = quick ? 180000 : 900000;
  const wallMs = Date.now() - phaseT0;
  atlas.record({
    id: 'ceiling.env.wall-clock',
    title: 'phase wall-clock budget',
    verdict: wallMs <= wallBudgetMs ? VERDICT.PASS : VERDICT.DEGRADED,
    expected: `under ${(wallBudgetMs / 1000).toFixed(0)} s for the whole phase in `
      + `${quick ? 'quick' : 'full'} mode`,
    actual: `${(wallMs / 1000).toFixed(1)} s for ${rungs.length} rung(s) `
      + `up to ${topRung.entries.toLocaleString('en-US')} entries`,
    severity: SEVERITY.INFO,
    ms: wallMs,
  });
}
