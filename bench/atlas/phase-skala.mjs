// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-skala.mjs — what one question costs at 10k, 100k and 1M
// entries, counted instead of timed.
//
// **The phase id.** The id is `skala`, the same string the sister house
// (lucky-mem) uses for its scale phase, so a record `skala.rung100000.…`
// in one atlas lines up with the one in the other. "Skala" is the German
// word for "scale"; the id is a shared name across the two houses, not
// prose. The English ratchet (test/english-ratchet.test.mjs) does not
// reject it (checked 2026-10-11: it is in neither the dictionary nor the
// identifier-word list), so it stays `skala`; the mapping of every phase id
// between the houses is recorded in test/atlas-phase-parity.json.
//
// **What it adds.** Until now no atlas phase had a rung at 100,000 or at
// 1,000,000 entries: `load` stops at 20,000, `ceiling` extrapolates from a
// ladder, and the real answer lived only in bench/scale-gate.mjs, outside
// the atlas. This phase pulls that gate's corpus builder in
// (`buildRoot` in bench/scale-gate.mjs — one owner for how a scale root is
// made, nothing copied) and asks a different question of it: not "how long",
// but "how much did the code READ".
//
// **Counters first, time as a companion.** Per rung, for `mem find`, the
// retrieval hook (bin/mem-retrieve) and `mem context`:
//
//   - lines and bytes read from the entry logs and from the index cache
//     (bench/atlas/io-counter.mjs, a preload; see its header for what it
//     cannot see),
//   - peak RSS of the process,
//   - for `find`: documents visited and candidates (documents that score
//     above zero) per query, in a fresh process (bench/atlas/scale-child.mjs),
//   - the size of the index cache next to the size of the logs.
//
// Wall-clock p50/p95 of the cold `find` processes are recorded next to them
// as a COMPANION value: its verdict goes through the same foreign-load
// sensor as every other timed check in the atlas, and reads `not-measured`
// when the machine was busy. A counter does not care who else is running.
//
// **What a verdict means here.** The design reads every typed log on a
// warm load (src/search.mjs, the comment above `deriveState`: "it re-reads
// every typed file") and scans every document per query. That is the
// documented ceiling, not a bug, so the expectations below are the bounds
// of THAT design: each byte of the logs and of the index at most once per
// call (`READ_ONCE_TOLERANCE`), and growth across rungs no steeper than
// linear (`GROWTH_EXPONENT_MAX`). A call that starts reading twice, or a
// curve that bends upward, turns red. Nothing is graded on how good "linear"
// is; the records print the figures so a reader can disagree.
//
// **Rungs.** `--rungs 100000,1000000` on bench/atlas.mjs. Without the
// option: quick = 1,000 and 4,000 entries (a few seconds); full = 10,000
// and 100,000. The 1,000,000 rung is never a default — it needs about
// 1.5 GB of RAM and, at the gate's measured build speed, the better part
// of an hour — it is asked for with `--rungs`. A reference rung (100,000
// and 1,000,000) that a run did not include is recorded as `not-measured`
// with that reason, never skipped in silence.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  VERDICT, SEVERITY, REPO, MEM, pct, cacheBytes, cacheExists,
  captureQuietCalibrationBaseline, captureForeignLoad, foreignLoadDelta,
  timeVerdictUnderLoad, FOREIGN_LOAD_DENIED_MS_PER_SEC, CALIBRATION_LOAD_FACTOR,
} from './core.mjs';
import {
  buildRoot, removeDir, cleanupAll, loadCriteria, boundFor, precheck, estimateRssBytes, freeRamBytes,
  parseRungs, MAX_ENTRIES,
} from '../scale-gate.mjs';
import { freeBytesAt } from './phase-ceiling.mjs';
import { QUERIES as SCALE_QUERIES } from '../scale.mjs';

const MB = 1048576;
const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

// --- the rungs ------------------------------------------------------------

export const QUICK_RUNGS = Object.freeze([1000, 4000]);
export const FULL_RUNGS = Object.freeze([10000, 100000]);
/** The rungs no atlas phase had before this one; a run without them says so. */
export const REFERENCE_RUNGS = Object.freeze([100000, 1000000]);

// --- thresholds, in the open ----------------------------------------------

/**
 * One call may read each byte of the logs, and each byte of the index, once.
 * 10 % over is tolerated for the tail probes and the hit hydration that
 * read a few lines twice (src/search.mjs, src/append.mjs). More than that
 * means the call reads something more than once.
 */
export const READ_ONCE_TOLERANCE = 1.1;
/**
 * Growth of a counter against the number of entries, as the slope of
 * log(counter) against log(entries) between the smallest and the largest
 * rung. Linear is the design (every log is read, every document visited);
 * above this the cost bends upward. The slope is only computed when the
 * rungs differ by at least `GROWTH_MIN_SPAN`: two neighbours say nothing.
 */
export const GROWTH_EXPONENT_MAX = 1.1;
export const GROWTH_MIN_SPAN = 2;
/** The time companion's fail line, a multiple of its degraded line (the "hung, not slow" convention of the other phases). */
const TIME_FAIL_FACTOR = 4;
/** A p95 from fewer samples is the maximum under another name (same floor as phase-load). */
const PERCENTILE_FLOOR = 5;
/** Disk bytes per entry assumed before any rung has been measured: the gate's own calibration (46.8 MB per 10,000 entries, logs plus index). */
const DEFAULT_BYTES_PER_ENTRY = 5000;

// --- the counting preload and what it wrote -------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IO_COUNTER = path.join(HERE, 'io-counter.mjs');
const SCALE_CHILD = path.join(HERE, 'scale-child.mjs');

/** The `--import` specifier that makes a node process (and its node children, via NODE_OPTIONS) count its reads under `root`. */
export function ioPreloadSpecifier(root, outFile) {
  const u = pathToFileURL(IO_COUNTER);
  u.search = `root=${encodeURIComponent(root)}&out=${encodeURIComponent(outFile)}`;
  return `--import=${u.href}`;
}

/** Sum the lines the counter wrote (one per node process). */
export function readCounters(outFile) {
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* none written */ }
  const sum = {
    processes: 0, linesRead: 0, corpusBytesRead: 0, indexBytesRead: 0, otherBytesRead: 0, maxRssMb: null,
  };
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    sum.processes += 1;
    sum.linesRead += r.linesRead ?? 0;
    sum.corpusBytesRead += r.corpusBytesRead ?? 0;
    sum.indexBytesRead += r.indexBytesRead ?? 0;
    sum.otherBytesRead += r.otherBytesRead ?? 0;
    const mb = r.maxRssKb ? r.maxRssKb / 1024 : null;
    if (mb != null && (sum.maxRssMb == null || mb > sum.maxRssMb)) sum.maxRssMb = round(mb);
  }
  return sum;
}

/**
 * Run a command with the counter loaded, from a fresh counter file.
 * `command` is `node <args>` (`kind: 'node'`) or `bash <script>` (`kind: 'bash'`).
 */
export function countedRun(ctx, command, { kind = 'node', input, env = {}, timeoutMs = 600000 } = {}) {
  const outFile = path.join(ctx.scratch, `io-${process.hrtime.bigint()}.jsonl`);
  const spec = ioPreloadSpecifier(ctx.root, outFile);
  const childEnv = {
    ...process.env, CHEAP_MEM_ROOT: ctx.root, HOME: ctx.home, USERPROFILE: ctx.home, ...env,
  };
  // A cap inherited from the host would change what is measured; the preload goes in through NODE_OPTIONS so the node children of a bash hook count too.
  childEnv.NODE_OPTIONS = spec;
  const t0 = process.hrtime.bigint();
  const r = kind === 'bash'
    ? spawnSync('bash', command, { cwd: ctx.root, env: childEnv, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * MB })
    : spawnSync(process.execPath, command, { cwd: ctx.root, env: childEnv, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * MB });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const io = readCounters(outFile);
  try { fs.rmSync(outFile, { force: true }); } catch { /* scratch is removed anyway */ }
  return {
    status: r.status, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'), ms: round(ms, 2), stdout: r.stdout ?? '', stderr: r.stderr ?? '', io,
  };
}

/** Bytes and newline count of the entry logs under a root (what the counters are compared with). */
export function corpusStats(root) {
  let bytes = 0; let lines = 0; let files = 0;
  const buf = Buffer.allocUnsafe(1 << 20);
  const visit = (dir) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { visit(p); continue; }
      if (!d.name.endsWith('.jsonl')) continue;
      files += 1;
      const fd = fs.openSync(p, 'r');
      try {
        for (;;) {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          if (n <= 0) break;
          bytes += n;
          for (let i = 0; i < n; i += 1) if (buf[i] === 10) lines += 1;
        }
      } finally { fs.closeSync(fd); }
    }
  };
  visit(path.join(root, 'global'));
  visit(path.join(root, 'projects'));
  return { bytes, lines, files };
}

// --- pure helpers (tested without a corpus) -------------------------------

/** Slope of log(y) against log(x) between the first and the last point; null when the span is too small or a value is not positive. */
export function growthExponent(points) {
  const p = points.filter((q) => q.x > 0 && q.y > 0).sort((a, b) => a.x - b.x);
  if (p.length < 2) return null;
  const a = p[0]; const b = p[p.length - 1];
  if (b.x / a.x < GROWTH_MIN_SPAN) return null;
  return round(Math.log(b.y / a.y) / Math.log(b.x / a.x), 3);
}

const median = (v) => pct(v.slice().sort((a, b) => a - b), 50);
const max = (v) => (v.length ? Math.max(...v) : null);

/**
 * Judge the peak RSS of the processes of one rung against the build bound.
 *
 * Three states, never two. The build's peak is read from /proc/<pid>/status
 * (VmHWM, bench/scale-gate.mjs `run`), a Linux-only high-water mark; macOS and
 * Windows have no such file, so there the build's figure is `null`. A null is
 * "not measurable here", not zero and not a pass: the verdict then reads
 * `not-measured` and says why, unless a process that WAS measured is already
 * over the bound (that is a fail whatever the build did). The smaller processes
 * are never stood in for the build: their own peaks stay in `peaks`, labelled.
 * @param {Record<string, number|null>} peaks build, find, context, hook, loadProbe in MB
 * @param {number} boundMb the pre-registered build bound
 * @param {string} [platform]
 */
export function judgePeakRss(peaks, boundMb, platform = process.platform) {
  const present = Object.entries(peaks).filter(([, v]) => v != null);
  const peakMax = max(present.map(([, v]) => v));
  const buildMissing = peaks.build == null;
  const why = platform === 'linux'
    ? 'the build child ended before /proc/<pid>/status could be read'
    : `the build's peak is read from /proc/<pid>/status (VmHWM), which ${platform} does not have`;
  let verdict;
  if (peakMax != null && peakMax > boundMb) verdict = VERDICT.FAIL;
  else if (peakMax == null || buildMissing) verdict = VERDICT.NOT_MEASURED;
  else verdict = VERDICT.PASS;
  const listed = present.map(([k, v]) => `${k} ${v}`).join(', ');
  const actual = peakMax == null
    ? 'no peak read'
    : (buildMissing ? `build peak not measurable here; largest of the others ${peakMax} MB (${listed})` : `largest ${peakMax} MB (${listed})`);
  const evidence = buildMissing
    ? `not measurable here: ${why}. The other processes' own maxRSS at exit is listed, but it is not the build's peak and is not passed off as it.`
    : 'build: VmHWM polled while the child ran; the rest: the process\'s own maxRSS at exit';
  return { verdict, peakMax: buildMissing ? null : peakMax, actual, evidence, buildMeasured: !buildMissing };
}

// --- the phase --------------------------------------------------------------

function bashAvailable() {
  try { return spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0; } catch { return false; }
}

const HOOK = path.join(REPO, 'bin', 'mem-retrieve');

export async function run(atlas, { quick = false, rungs = null } = {}) {
  atlas.phase('skala', 'Scale: what one question reads at 10k, 100k and 1M entries (counters first, time as a companion)');
  const record = (r) => atlas.record(r);
  const ladder = rungs
    ? (Array.isArray(rungs) ? rungs : parseRungs(rungs))
    : (quick ? [...QUICK_RUNGS] : [...FULL_RUNGS]);
  const criteria = loadCriteria();
  // An interrupted run must not leave a million-entry root in the temp directory.
  process.once('exit', cleanupAll);
  const hasBash = bashAvailable();

  // The reference rungs this run does not cover, by name.
  for (const n of REFERENCE_RUNGS) {
    if (ladder.includes(n)) continue;
    const why = n > MAX_ENTRIES ? 'above the container limit'
      : (quick ? 'quick mode runs only the small rungs (pass --rungs to ask for this one)'
        : (n === 1000000 ? 'never a default: about 1.5 GB RAM and, at the gate\'s build speed, the better part of an hour; ask for it with --rungs 1000000 on a quiet machine'
          : 'not in this run\'s --rungs'));
    record({
      id: `skala.rung${n}.not-run`,
      title: `scale rung at ${n} entries`,
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: `rung ${n} not run: ${why}`,
      evidence: `rungs of this run: ${ladder.join(', ')}`,
    });
    atlas.blind(`scale rung at ${n} entries`, why);
  }

  const calibBaseline = captureQuietCalibrationBaseline();
  const finished = [];
  const bashNote = hasBash ? null : 'bash is not available here, so the retrieval hook (a bash script) cannot run';

  for (const n of [...ladder].sort((a, b) => a - b)) {
    const id = (s) => `skala.rung${n}.${s}`;
    // --- pre-check: refuse BEFORE building, as the gate does -------------------
    const bytesPerEntry = Math.max(DEFAULT_BYTES_PER_ENTRY, ...finished.map((f) => f.bytesPerEntry));
    const rss = estimateRssBytes(n, criteria, finished.map((f) => ({ n: f.n, phases: { build: { peakRssMb: f.buildPeakRssMb } } })));
    const pc = precheck({
      n, freeDiskBytes: freeBytesAt(os.tmpdir()), freeRamBytes: freeRamBytes(), bytesPerEntry, rssBytesPerEntry: rss / n,
    });
    if (!pc.ok) {
      record({
        id: id('refused'), title: `scale rung at ${n} entries`, verdict: VERDICT.NOT_MEASURED, expected: null,
        actual: `rung ${n} refused before building`, evidence: pc.reason,
      });
      atlas.blind(`scale rung at ${n} entries`, pc.reason);
      continue;
    }

    // --- build ----------------------------------------------------------------
    const anchors = quick ? 3 : 10;
    let stage = null;
    try {
      stage = await buildRoot(n, { anchors }, (m) => process.stderr.write(`  [skala ${n}] ${m}\n`));
    } catch (e) {
      record({
        id: id('build'), title: `build ${n} entries and the first index`, verdict: VERDICT.FAIL, expected: 'the build finishes',
        actual: `threw: ${String(e && e.message).slice(0, 200)}`, evidence: String(e && e.stack).slice(0, 1500), severity: SEVERITY.MAJOR,
      });
      break; // a failed rung is not a licence to start a larger one
    }
    const { ctx } = stage;
    try {
      const built = stage.build.status === 0 && !stage.build.timedOut && cacheExists(ctx.root);
      const buildBound = boundFor(criteria.criteria.find((k) => k.id === 'build-peak-rss').bound, n, criteria.corpusWeights);
      record({
        id: id('build'),
        title: `build ${n} entries (heaps corpus + gold world) and the first index`,
        verdict: built ? VERDICT.PASS : VERDICT.FAIL,
        expected: 'the first `mem find` exits 0 and leaves an index cache behind',
        actual: built ? `built; peak RSS ${stage.build.peakRssMb == null ? 'not measurable here (no /proc VmHWM)' : `${stage.build.peakRssMb} MB`}` : `exit ${stage.build.status}${stage.build.timedOut ? ' (timed out)' : ''}`,
        severity: SEVERITY.MAJOR,
        evidence: stage.build.stderr ?? 'peak RSS read from /proc VmHWM while the child ran (null where there is no /proc: not measurable, not zero); build time is a companion value, in `measured`',
        measured: { entries: n, buildMs: stage.build.ms, buildPeakRssMb: stage.build.peakRssMb, genMs: stage.genMs, goldEntries: stage.goldN },
      });
      if (!built) {
        record({
          id: id('reads'), title: `reads per call at ${n} entries`, verdict: VERDICT.NOT_MEASURED, expected: null,
          actual: 'no index to ask', evidence: `the build of rung ${n} did not succeed`,
        });
        atlas.blind(`reads per call at ${n} entries`, `the build of rung ${n} did not succeed`);
        break;
      }

      const stats = corpusStats(ctx.root);
      const indexBytes = cacheBytes(ctx.root);
      const questions = [...SCALE_QUERIES, ...stage.filler.anchors.map((a) => a.query)];
      const loadBefore = captureForeignLoad(calibBaseline);

      // --- find, cold process each (the counters AND the companion time) --------
      const finds = questions.map((q) => countedRun(ctx, [MEM, '--root', ctx.root, 'find', q, '--json', '--top', '10']));
      const loadAfter = captureForeignLoad(calibBaseline);
      const load = foreignLoadDelta(loadBefore, loadAfter, calibBaseline);
      const findOk = finds.filter((f) => f.status === 0 && !f.timedOut);
      const per = (key) => findOk.map((f) => f.io[key]);
      const contextRun = countedRun(ctx, [MEM, '--root', ctx.root, 'context']);
      const hookPrompt = JSON.stringify({ prompt: `${SCALE_QUERIES[0]}, what do we know about it`, session_id: 'atlas-skala' });
      const hook = hasBash
        ? countedRun(ctx, [HOOK], { kind: 'bash', input: hookPrompt, env: { MEM_RECALL_SERVER: '0', MEM_RETRIEVE_NO_PULL: '1' } })
        : null;
      const queriesFile = path.join(ctx.scratch, 'queries.json');
      fs.writeFileSync(queriesFile, JSON.stringify(questions));
      const child = spawnSync(process.execPath, [SCALE_CHILD, ctx.root, queriesFile], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * MB });
      let probe = null;
      if (child.status === 0) { try { probe = JSON.parse(child.stdout); } catch { probe = null; } }

      const fraction = (read, whole) => (whole > 0 ? round(read / whole, 3) : null);

      // --- reads per call ---------------------------------------------------------
      const withinOnce = (io) => io.corpusBytesRead <= READ_ONCE_TOLERANCE * stats.bytes
        && io.indexBytesRead <= READ_ONCE_TOLERANCE * indexBytes;
      const one = (label, r) => (r ? {
        label,
        status: r.status,
        processes: r.io.processes,
        linesRead: r.io.linesRead,
        corpusBytesRead: r.io.corpusBytesRead,
        indexBytesRead: r.io.indexBytesRead,
        otherBytesRead: r.io.otherBytesRead,
        corpusShare: fraction(r.io.corpusBytesRead, stats.bytes),
        indexShare: fraction(r.io.indexBytesRead, indexBytes),
        peakRssMb: r.io.maxRssMb,
        outputBytes: Buffer.byteLength(r.stdout),
      } : { label, status: null });

      const findTop = {
        linesRead: { p50: median(per('linesRead')), max: max(per('linesRead')) },
        corpusBytesRead: { p50: median(per('corpusBytesRead')), max: max(per('corpusBytesRead')) },
        indexBytesRead: { p50: median(per('indexBytesRead')), max: max(per('indexBytesRead')) },
        peakRssMb: { p50: median(findOk.map((f) => f.io.maxRssMb).filter((x) => x != null)), max: max(findOk.map((f) => f.io.maxRssMb).filter((x) => x != null)) },
      };
      const findAnswered = findOk.length === finds.length;

      record({
        id: id('find-reads'),
        title: `lines and bytes one warm \`mem find\` reads, at ${n} entries`,
        verdict: !findAnswered ? VERDICT.NOT_MEASURED
          : (findOk.every((f) => withinOnce(f.io)) ? VERDICT.PASS : VERDICT.FAIL),
        expected: `corpus bytes read <= ${READ_ONCE_TOLERANCE}x the logs on disk and index bytes read <= ${READ_ONCE_TOLERANCE}x the index on disk, for every one of the ${questions.length} questions (each byte at most once per call)`,
        actual: findAnswered
          ? `p50 ${findTop.linesRead.p50} lines, ${round(findTop.corpusBytesRead.p50 / MB, 2)} MB of logs (${fraction(findTop.corpusBytesRead.p50, stats.bytes)}x), ${round(findTop.indexBytesRead.p50 / MB, 2)} MB of index (${fraction(findTop.indexBytesRead.p50, indexBytes)}x); logs ${stats.lines} lines / ${round(stats.bytes / MB, 2)} MB, index ${round(indexBytes / MB, 2)} MB`
          : `${finds.length - findOk.length} of ${finds.length} find calls did not exit 0`,
        severity: SEVERITY.MAJOR,
        evidence: findAnswered ? 'counted by bench/atlas/io-counter.mjs inside each fresh `mem find --json --top 10` process; time is the companion record'
          : `the reads of a call that failed say nothing: ${finds.find((f) => f.status !== 0)?.stderr?.slice(0, 200)}`,
        measured: { entries: n, questions: questions.length, answered: findOk.length, logs: stats, indexBytes, find: findTop },
      });

      record({
        id: id('context-reads'),
        title: `lines and bytes \`mem context\` reads, at ${n} entries`,
        verdict: contextRun.status !== 0 ? VERDICT.NOT_MEASURED : (withinOnce(contextRun.io) ? VERDICT.PASS : VERDICT.FAIL),
        expected: `corpus bytes read <= ${READ_ONCE_TOLERANCE}x the logs on disk and index bytes read <= ${READ_ONCE_TOLERANCE}x the index on disk`,
        actual: contextRun.status !== 0 ? `exit ${contextRun.status}`
          : `${contextRun.io.linesRead} lines, ${round(contextRun.io.corpusBytesRead / MB, 2)} MB of logs (${fraction(contextRun.io.corpusBytesRead, stats.bytes)}x), ${round(contextRun.io.indexBytesRead / MB, 2)} MB of index`,
        severity: SEVERITY.MAJOR,
        evidence: contextRun.status !== 0 ? contextRun.stderr.slice(0, 200) : 'counted inside the process',
        measured: { entries: n, ...one('context', contextRun) },
      });

      record({
        id: id('retrieve-hook-reads'),
        title: `lines and bytes the retrieval hook (bin/mem-retrieve) reads for one prompt, at ${n} entries`,
        verdict: hook === null || hook.status !== 0 ? VERDICT.NOT_MEASURED : (withinOnce(hook.io) ? VERDICT.PASS : VERDICT.FAIL),
        expected: `summed over every node process the hook starts: corpus bytes read <= ${READ_ONCE_TOLERANCE}x the logs on disk and index bytes read <= ${READ_ONCE_TOLERANCE}x the index on disk`,
        actual: hook === null ? 'not run' : (hook.status !== 0 ? `exit ${hook.status}`
          : `${hook.io.processes} node processes, ${hook.io.linesRead} lines, ${round(hook.io.corpusBytesRead / MB, 2)} MB of logs (${fraction(hook.io.corpusBytesRead, stats.bytes)}x), ${round(hook.io.indexBytesRead / MB, 2)} MB of index`),
        severity: SEVERITY.MAJOR,
        evidence: hook === null ? bashNote : (hook.status !== 0 ? hook.stderr.slice(0, 200)
          : 'direct path (MEM_RECALL_SERVER=0), no pull; the warm recall server\'s own reads are a named blind spot'),
        measured: hook ? { entries: n, ...one('retrieve-hook', hook) } : { entries: n },
      });
      if (hook === null) atlas.blind(`retrieval hook reads at ${n} entries`, bashNote);

      // --- candidates ---------------------------------------------------------------
      if (probe) {
        const scored = probe.queries.map((q) => q.scored);
        record({
          id: id('candidates'),
          title: `documents visited and candidates per query, at ${n} entries`,
          verdict: probe.documents >= n ? VERDICT.PASS : VERDICT.FAIL,
          expected: `the search visits every document (the design's linear scan): documents visited >= ${n} entries written`,
          actual: `visits ${probe.documents} documents per query; candidates (score > 0) p50 ${median(scored)}, max ${max(scored)} of ${questions.length} queries (${fraction(median(scored), probe.documents)} of the documents at p50)`,
          severity: SEVERITY.MINOR,
          evidence: 'a fresh process loads the index and asks each question with minScore 0 and an unbounded top (bench/atlas/scale-child.mjs); the day this changes to a posting-list walk the expectation is the thing to re-read',
          measured: { entries: n, documents: probe.documents, scored, loadMs: probe.loadMs, loadPeakRssMb: probe.maxRssMb },
        });
      } else {
        record({
          id: id('candidates'), title: `documents visited and candidates per query, at ${n} entries`, verdict: VERDICT.NOT_MEASURED,
          expected: null, actual: `the probe process exited ${child.status}`, evidence: String(child.stderr).slice(0, 300),
        });
        atlas.blind(`candidates per query at ${n} entries`, `the probe process exited ${child.status}`);
      }

      // --- index bytes ----------------------------------------------------------------
      record({
        id: id('index-bytes'),
        title: `index cache next to the logs, at ${n} entries`,
        verdict: VERDICT.NOT_MEASURED,
        expected: null,
        actual: `${round(indexBytes / MB, 2)} MB of index for ${round(stats.bytes / MB, 2)} MB of logs (${fraction(indexBytes, stats.bytes)}x), ${round(indexBytes / n, 1)} bytes per entry`,
        evidence: 'a measurement without a threshold: no document promises a size, so there is nothing to pass or fail; the growth across rungs is judged in skala.growth.*',
        measured: { entries: n, indexBytes, logBytes: stats.bytes, logLines: stats.lines },
      });

      // --- peak RSS ----------------------------------------------------------------------
      const peaks = {
        build: stage.build.peakRssMb,
        find: findTop.peakRssMb.max,
        context: contextRun.io.maxRssMb,
        hook: hook?.io.maxRssMb ?? null,
        loadProbe: probe?.maxRssMb ?? null,
      };
      const judged = judgePeakRss(peaks, buildBound);
      const peakMax = judged.peakMax;
      record({
        id: id('peak-rss'),
        title: `peak RSS of the processes at ${n} entries`,
        verdict: judged.verdict,
        expected: `no process above the gate's pre-registered build bound of ${round(buildBound)} MB (bench/scale-gate-criteria.json, build-peak-rss)`,
        actual: judged.actual,
        severity: SEVERITY.MAJOR,
        evidence: judged.evidence,
        measured: { entries: n, ...peaks, boundMb: round(buildBound) },
      });
      if (!judged.buildMeasured) atlas.blind(`the build's peak RSS at ${n} entries`, judged.evidence);

      // --- the time companion ----------------------------------------------------------------
      const times = finds.map((f) => f.ms).sort((a, b) => a - b);
      const enough = times.length >= PERCENTILE_FLOOR;
      const p50 = pct(times, 50); const p95 = enough ? pct(times, 95) : null;
      const bound = boundFor(criteria.criteria.find((k) => k.id === 'cold-find-p95').bound, n, criteria.corpusWeights);
      let timeVerdict = p95 == null ? VERDICT.NOT_MEASURED : timeVerdictUnderLoad(p95, bound, bound * TIME_FAIL_FACTOR, load);
      if (!calibBaseline.trustworthy && timeVerdict !== VERDICT.NOT_MEASURED) {
        // PSI / steal / cgroup still carry the check; the weaker sensor is named, not hidden.
        atlas.blind('calibration-loop foreign-load signal for the skala phase', `the quiet baseline could not be captured cleanly after ${calibBaseline.attempts} attempt(s)`);
      }
      if (!load.measured) {
        timeVerdict = VERDICT.NOT_MEASURED;
        atlas.blind(`foreign load around the timed finds at ${n} entries`, 'no load sensor could be read here, so a wall-clock figure cannot be trusted');
      }
      record({
        id: id('time-companion'),
        title: `cold \`mem find\` wall time at ${n} entries (companion to the counters)`,
        verdict: timeVerdict,
        expected: `p95 under ${round(bound)} ms, the scale gate's pre-registered cold-find bound (over ${round(bound * TIME_FAIL_FACTOR)} ms means hung, not slow; not-measured instead of either if the calibration loop, PSI, or steal+cgroup showed foreign load: ${FOREIGN_LOAD_DENIED_MS_PER_SEC} ms/s denied, or ${CALIBRATION_LOAD_FACTOR}x the calibration baseline)`,
        actual: `p50 ${round(p50)} ms, p95 ${p95 == null ? `not given (${times.length} samples < ${PERCENTILE_FLOOR})` : `${round(p95)} ms`}`,
        severity: SEVERITY.MINOR,
        ms: p50,
        evidence: load.measured
          ? `foreign load over ${load.wallMs} ms wall: calibration ratio ${load.calibRatio}, PSI ${load.psiMsPerSec} ms/s, steal+cgroup ${load.deniedMsPerSec} ms/s`
          : 'no load sensor readable',
        measured: {
          entries: n, samples: times.length, p50Ms: round(p50), p95Ms: round(p95), boundMs: round(bound), loadAvg1: round(os.loadavg()[0], 2), foreignLoad: load,
        },
      });

      finished.push({
        n,
        bytesPerEntry: (stats.bytes + indexBytes) / n,
        buildPeakRssMb: stage.build.peakRssMb,
        findLines: findTop.linesRead.p50,
        findCorpusBytes: findTop.corpusBytesRead.p50,
        findIndexBytes: findTop.indexBytesRead.p50,
        scoredP50: probe ? median(probe.queries.map((q) => q.scored)) : null,
        documents: probe?.documents ?? null,
        peakRssMb: peakMax,
      });
    } finally {
      removeDir(ctx.root); removeDir(ctx.home); removeDir(ctx.scratch);
    }
  }

  // --- growth across rungs ---------------------------------------------------------------
  const growth = (key, title, pick, max_) => {
    const pts = finished.map((f) => ({ x: f.n, y: pick(f) })).filter((p) => p.y != null);
    const e = growthExponent(pts);
    record({
      id: `skala.growth.${key}`,
      title,
      verdict: e == null ? VERDICT.NOT_MEASURED : (e <= max_ ? VERDICT.PASS : VERDICT.FAIL),
      expected: `slope of log(counter) against log(entries), smallest to largest rung, <= ${max_} (linear is the design)`,
      actual: e == null
        ? (pts.length < 2 ? `${pts.length} measured rung(s); a slope needs two`
          : `the rungs span less than ${GROWTH_MIN_SPAN}x (${pts[0].x} to ${pts[pts.length - 1].x}); a slope between neighbours says nothing`)
        : `slope ${e} over ${pts.map((p) => `${p.x}:${round(p.y, 1)}`).join(', ')}`,
      severity: SEVERITY.MAJOR,
      evidence: 'counters, not time; read the per-rung records for the values',
      measured: { slope: e, points: pts },
    });
    if (e == null) atlas.blind(title, 'fewer than two measured rungs, or rungs too close together, to fit a slope (a figure that was not measurable on this platform leaves its rung out)');
  };
  growth('find-lines-read', 'growth of lines read per warm find with the number of entries', (f) => f.findLines, GROWTH_EXPONENT_MAX);
  growth('find-corpus-bytes-read', 'growth of log bytes read per warm find with the number of entries', (f) => f.findCorpusBytes, GROWTH_EXPONENT_MAX);
  growth('find-index-bytes-read', 'growth of index bytes read per warm find with the number of entries', (f) => f.findIndexBytes, GROWTH_EXPONENT_MAX);
  growth('candidates', 'growth of candidates (score > 0) per query with the number of entries', (f) => f.scoredP50, GROWTH_EXPONENT_MAX);
  growth('peak-rss', 'growth of the largest process\'s peak RSS with the number of entries', (f) => f.peakRssMb, 1.0);

  atlas.blind('the warm recall server\'s reads at scale',
    'the counter sees node processes it was loaded into; the long-lived recall server (mem serve) is not one of them. Its answer time at scale is bench/scale-gate.mjs\'s "service" step');
  atlas.blind('doctor, dashboard, link map and one write at scale',
    'asked of a scale root only by bench/scale-gate.mjs; this phase counts reads of find, retrieve and context');
  atlas.blind('recall quality at scale',
    'whether the right entry survives 100k or 1M entries is judged by the gold set in bench/scale-gate.mjs (and by the load phase up to 20,000); this phase counts, it does not rank');
  atlas.blind('reads the counter cannot see',
    'reads through fs.promises file handles, memory maps and child processes that did not load the preload (bench/atlas/io-counter.mjs header)');
}
