#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bench/scale-gate.mjs — the scale gate: does cheap-mem still do its job at
 * 10k, 100k and 1,000,000 entries? A pass/fail/unknown verdict per rung
 * against criteria that were written down BEFORE the first run.
 *
 * Owner decision 2026-10-02: "only option 1" — run it in the cloud
 * container only, at most 1,000,000 entries, on a quiet machine later,
 * nothing on the VM. lucky-mem has its own, larger gate (10M, on the VM);
 * this one is the cheap-mem counterpart sized for a container, built on the
 * same shape: real-looking vocabulary, a ladder of rungs, several
 * conditions per rung, pre-fixed limits, and an aborted run is UNKNOWN,
 * never "failed".
 *
 *   node bench/scale-gate.mjs                          # 10k, 100k, 1M
 *   node bench/scale-gate.mjs --rungs 2000,10000       # smoke test
 *   node bench/scale-gate.mjs --resume                 # skip the rungs already done
 *   node bench/scale-gate.mjs --dry-run                # calibrate + resource pre-check only
 *
 * Options: --rungs a,b,c  --out FILE.jsonl  --resume  --dry-run
 *          --criteria FILE  --gold-cases N  --anchors N  --calibration N
 *          --bytes-per-entry B (skip the calibration)  --keep (keep the temp root, debugging only)
 *          --allow-uncommitted-criteria (development only: the verdict says so)
 *
 * ## The three verdicts, and what "unknown" means
 *
 *   pass     every check of the rung measured and inside its pre-registered limit
 *   fail     at least one check measured and outside its limit
 *   unknown  anything else: a value was not measured, the rung was aborted,
 *            or the resource pre-check refused it ("unknown (insufficient
 *            resources)"). A missing number NEVER passes and is never
 *            counted as a failure either.
 *
 * ## What is reused (nothing is re-implemented)
 *
 *   bench/heaps-corpus.mjs     the growing, Zipf-skewed vocabulary (filler)
 *   bench/scale.mjs            the six QUERIES and the corpus the documented timings come from
 *   bench/gold-compare.mjs     the gold world and its judge (the same one bench/value-report.mjs uses)
 *   bench/atlas/core.mjs       mem(), dirBytes, pct, environment
 *   bench/atlas/phase-ceiling  the held-out ladder point (fit on the rungs
 *                              below the top, predict the top rung) and the free-disk read
 *   bench/atlas/phase-doctor   the doctor output parser
 *   bench/cold-find.mjs        the cold/warm definitions (cold = fresh `mem find` process,
 *                              warm = search() on a loaded index, same options)
 *   bench/warm-recall.mjs      the recall server's warm path (same start, same socket protocol)
 *   bench/board-tempo.mjs      the dashboard probe (bin/mem-serve, GET /dashboard.json)
 *
 * ## The pass criteria
 *
 * `bench/scale-gate-criteria.json`, committed before any run. Each
 * criterion names the documented measurement it was derived from. The gate
 * records the SHA-256 of that file in every result row and refuses to run
 * when the file differs from the committed one (`--allow-uncommitted-criteria`
 * lets a developer try a draft; the rows then say `criteriaCommitted: false`).
 *
 * ## Per rung
 *
 *   1  resource pre-check   free disk and RAM against an estimate made from a
 *                           small calibration rung; refuse BEFORE building.
 *   2  build                heaps filler (timestamps end before the gold
 *                           world's), the gold world through the real writer,
 *                           then the first `mem find` builds the index: time and peak RSS.
 *   3  questions, cold      44 gold cases + N heaps anchors, each in a fresh
 *                           `mem find --json` process: p50/p95, recall judged.
 *   4  questions, warm      the same questions on a loaded index, child process.
 *   5  warm service         the recall server (what `mem serve` runs), same questions.
 *   6  time questions       --since (date, duration) and --as-of (twice).
 *   7  doctor               `mem doctor`: does it answer.
 *   8  dashboard            bin/mem-serve: first answer, time to the counters.
 *   9  linking              `mem net` (read only).
 *  10  one write, LAST      `mem log learning`, then the first find must return it.
 *
 * ## Hygiene
 *
 * Every root is a fresh directory under os.tmpdir() (TMPDIR is respected),
 * HOME for the children is a temp directory too, the real store is never
 * touched, and everything is removed at the end and on SIGINT/SIGTERM.
 * Each rung's row is appended to the output JSONL the moment it is done, so
 * an abort loses only the running rung. A shell-quiet machine matters: the
 * documented timings were taken at load 3 to 8 on 4 cores; the row records
 * the load average at the start so a number can be read in context.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { environment, pct, dirBytes } from './atlas/core.mjs';
import { fitPowerLaw, predictPowerLaw, relativeError, freeBytesAt } from './atlas/phase-ceiling.mjs';
import { parseDoctor } from './atlas/phase-doctor.mjs';
import { synthesizeCorpus, BENCH_MARKER } from './heaps-corpus.mjs';
import { QUERIES as SCALE_QUERIES } from './scale.mjs';
import { loadCases, loadWorld, judge } from './gold-compare.mjs';
import { summariseRecall } from './value-report.mjs';
import { loadIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';
import * as place from '../src/recallserver-place.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const SERVE_MODULE = pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href;
const RECALL_MODULE = pathToFileURL(path.join(REPO, 'src', 'recallserver.mjs')).href;
const SELF = fileURLToPath(import.meta.url);

export const CRITERIA_FILE = path.join(HERE, 'scale-gate-criteria.json');
export const DEFAULT_RUNGS = Object.freeze([10000, 100000, 1000000]);
export const MAX_ENTRIES = 1000000; // owner decision 2026-10-02: the container gate stops at 1M
export const MARGIN = 1.25; // on disk and RAM estimates: an estimate from a small rung is not exact
export const DISK_RESERVE_BYTES = 256 * 1048576;
export const RAM_RESERVE_BYTES = 1024 * 1048576;
/** Generator memory per entry (the filler lines are held as strings until written): measured order of magnitude, not a bound. */
export const GENERATOR_BYTES_PER_ENTRY = 1600;
const MB = 1048576;
const ROUND = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
const TOP = 10;
const DASHBOARD_DEADLINE_MS = 1800000;

// ---------------------------------------------------------------------
// Pure part: criteria, bounds, verdicts, pre-check, resume
// ---------------------------------------------------------------------

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Load and validate the criteria file. A criterion without a source, a bound
 * without anchors or a kind nobody evaluates is a refusal here, not a
 * silent skip at the end of a multi-hour run.
 */
export function loadCriteria(file = CRITERIA_FILE) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`scale gate: criteria file ${file} unreadable: ${e.message}`);
  }
  const bad = (m) => { throw new Error(`scale gate: criteria file ${file}: ${m}`); };
  if (c.schema !== 1) bad('schema must be 1');
  if (!Number.isInteger(c.baselineRung) || c.baselineRung < 1) bad('baselineRung missing');
  if (!c.headroom || !(c.headroom.value >= 1)) bad('headroom.value must be a number >= 1');
  if (!c.corpusWeights || typeof c.corpusWeights !== 'object') bad('corpusWeights missing');
  if (!Array.isArray(c.criteria) || c.criteria.length === 0) bad('no criteria');
  const ids = new Set();
  for (const k of c.criteria) {
    if (!k.id || ids.has(k.id)) bad(`criterion id missing or duplicate: ${k.id}`);
    ids.add(k.id);
    if (typeof k.source !== 'string' || k.source.trim().length < 10) bad(`${k.id}: no source (a bound without a documented origin is an invented one)`);
    if (typeof k.metric !== 'string' || !k.metric) bad(`${k.id}: metric missing`);
    if (k.kind === 'max') {
      const b = k.bound;
      if (!b || !Array.isArray(b.anchors) || b.anchors.length < 2) bad(`${k.id}: bound needs at least two anchors`);
      for (let i = 0; i < b.anchors.length; i += 1) {
        const [n, v] = b.anchors[i];
        if (!(n > 0) || !(v > 0)) bad(`${k.id}: anchor ${i} must be positive numbers`);
        if (i > 0 && !(n > b.anchors[i - 1][0])) bad(`${k.id}: anchors must ascend by entries`);
      }
      if (!Number.isFinite(b.extrapolateExponent)) bad(`${k.id}: extrapolateExponent missing`);
      if (b.weight != null && !(c.corpusWeights[b.weight] > 0)) bad(`${k.id}: weight '${b.weight}' is not in corpusWeights`);
      if (!(b.headroom >= 1)) bad(`${k.id}: headroom must be >= 1`);
    } else if (k.kind === 'max-drop') {
      if (!(k.maxDrop >= 0)) bad(`${k.id}: maxDrop missing`);
    } else if (k.kind !== 'true') {
      bad(`${k.id}: unknown kind '${k.kind}'`);
    }
  }
  return c;
}

/** The limit of one `max` criterion at `n` entries. Log-log between anchors, an exponent beyond them. */
export function boundFor(spec, n, weights = {}) {
  const a = spec.anchors;
  const at = (x0, y0, x1, y1) => y0 * (n / x0) ** (Math.log(y1 / y0) / Math.log(x1 / x0));
  let base;
  if (n < a[0][0]) base = a[0][1] * (n / a[0][0]) ** spec.extrapolateExponent;
  else if (n > a[a.length - 1][0]) base = a[a.length - 1][1] * (n / a[a.length - 1][0]) ** spec.extrapolateExponent;
  else {
    let i = 0;
    while (i < a.length - 2 && n > a[i + 1][0]) i += 1;
    base = at(a[i][0], a[i][1], a[i + 1][0], a[i + 1][1]);
  }
  let v = base * (spec.weight ? weights[spec.weight] : 1) * spec.headroom;
  if (spec.floor != null) v = Math.max(v, spec.floor);
  if (spec.ceiling != null) v = Math.min(v, spec.ceiling);
  return v;
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Evaluate one rung's metrics against the criteria. Pure.
 * A metric that is missing (null, undefined, NaN) is `unknown`, never `pass`.
 * Below the baseline rung a drop check is `na` (nothing to compare with yet).
 * `baseline` is the baseline rung's metrics, or null when it was not measured.
 */
export function evaluateRung(n, metrics, criteria, baseline = null) {
  const checks = [];
  for (const k of criteria.criteria) {
    const value = metrics?.[k.metric];
    const row = { id: k.id, metric: k.metric, kind: k.kind, value: value ?? null };
    if (k.kind === 'max') {
      row.bound = ROUND(boundFor(k.bound, n, criteria.corpusWeights), 1);
      if (!finite(value)) { row.state = 'unknown'; row.why = 'not measured'; } else row.state = value <= row.bound ? 'pass' : 'fail';
    } else if (k.kind === 'true') {
      if (value === true) row.state = 'pass';
      else if (value === false) row.state = 'fail';
      else { row.state = 'unknown'; row.why = 'not measured'; }
    } else if (k.kind === 'max-drop') {
      row.maxDrop = k.maxDrop;
      if (n < criteria.baselineRung) { row.state = 'na'; row.why = `below the baseline rung ${criteria.baselineRung}`; }
      else if (!finite(value)) { row.state = 'unknown'; row.why = 'not measured'; }
      else if (n === criteria.baselineRung) { row.state = 'pass'; row.why = 'this is the baseline rung (measured)'; }
      else if (!baseline || !finite(baseline[k.metric])) { row.state = 'unknown'; row.why = `no measured baseline at ${criteria.baselineRung}`; }
      else {
        row.baseline = baseline[k.metric];
        row.drop = ROUND(baseline[k.metric] - value, 2);
        row.state = row.drop <= k.maxDrop ? 'pass' : 'fail';
      }
    }
    checks.push(row);
  }
  return checks;
}

/** fail beats unknown beats pass; `na` counts for nothing; no check at all is unknown. */
export function rungVerdict(checks) {
  if (!checks || checks.length === 0) return 'unknown';
  if (checks.some((c) => c.state === 'fail')) return 'fail';
  if (checks.some((c) => c.state === 'unknown')) return 'unknown';
  return checks.some((c) => c.state === 'pass') ? 'pass' : 'unknown';
}

/** The latest row per rung (a later row replaces an earlier one). */
export function latestRungRows(rows) {
  const by = new Map();
  for (const r of rows) if (r.kind === 'rung') by.set(r.n, r);
  return by;
}

/** Rungs a `--resume` skips: the ones with a finished measurement (pass or fail). Aborted and refused rungs run again. */
export function doneRungs(rows) {
  return new Set([...latestRungRows(rows)].filter(([, r]) => r.status === 'done').map(([n]) => n));
}

/** Overall verdict over the REQUESTED rungs; a rung with no row is unknown (not run). */
export function summarize(rows, rungs) {
  const by = latestRungRows(rows);
  const per = rungs.map((n) => ({ n, verdict: by.get(n)?.verdict ?? 'unknown', status: by.get(n)?.status ?? 'not-run' }));
  const overall = per.some((p) => p.verdict === 'fail') ? 'fail'
    : per.every((p) => p.verdict === 'pass') ? 'pass' : 'unknown';
  return { overall, rungs: per };
}

/**
 * The resource pre-check for one rung. Pure: the caller reads the machine.
 * Unreadable free space is a refusal too (an unverified rung is not started).
 */
export function precheck({ n, freeDiskBytes, freeRamBytes, bytesPerEntry, rssBytesPerEntry }) {
  const diskNeed = Number.isFinite(bytesPerEntry) ? Math.ceil(n * bytesPerEntry * MARGIN) + DISK_RESERVE_BYTES : null;
  const ramNeed = Number.isFinite(rssBytesPerEntry) ? Math.ceil(n * (rssBytesPerEntry + GENERATOR_BYTES_PER_ENTRY) * MARGIN) + RAM_RESERVE_BYTES : null;
  const why = [];
  if (n > MAX_ENTRIES) why.push(`${n} entries is above the container gate's limit of ${MAX_ENTRIES} (owner decision 2026-10-02)`);
  if (diskNeed == null) why.push('no disk estimate (no calibration)');
  else if (!Number.isFinite(freeDiskBytes)) why.push('free disk could not be read');
  else if (freeDiskBytes < diskNeed) why.push(`disk: needs about ${gib(diskNeed)} GiB, ${gib(freeDiskBytes)} GiB free`);
  if (ramNeed == null) why.push('no RAM estimate');
  else if (!Number.isFinite(freeRamBytes)) why.push('free RAM could not be read');
  else if (freeRamBytes < ramNeed) why.push(`RAM: needs about ${gib(ramNeed)} GiB, ${gib(freeRamBytes)} GiB available`);
  return {
    ok: why.length === 0, diskNeedBytes: diskNeed, ramNeedBytes: ramNeed,
    freeDiskBytes: freeDiskBytes ?? null, freeRamBytes: freeRamBytes ?? null,
    reason: why.length ? `unknown (insufficient resources): ${why.join('; ')}` : null,
  };
}

const gib = (b) => (b / 1073741824).toFixed(2);

/** The held-out ladder point (the atlas ceiling phase's counter-check): fit the rungs below the top, predict the top. Informational. */
export function heldOut(points) {
  const p = points.filter((x) => x.n > 0 && x.y > 0).sort((a, b) => a.n - b.n);
  if (p.length < 3) return { ok: false, reason: `${p.length} measured rung(s); at least 3 are needed to hold one back and still fit` };
  const held = p[p.length - 1];
  const fit = fitPowerLaw(p.slice(0, -1));
  if (!fit) return { ok: false, reason: 'the fit did not converge' };
  const predicted = predictPowerLaw(fit, held.n);
  return { ok: true, heldN: held.n, actual: held.y, predicted: ROUND(predicted, 1), relativeError: ROUND(relativeError(held.y, predicted), 3), exponent: ROUND(fit.b, 3) };
}

/**
 * Peak RSS expected for a build of `n` entries, in bytes: the documented anchors (headroom, floor and
 * ceiling left out: this is an estimate, not a limit) or a finished rung's measured peak grown by the
 * documented exponent, whichever is larger.
 */
export function estimateRssBytes(n, criteria, finishedRungs = []) {
  const spec = criteria.criteria.find((k) => k.id === 'build-peak-rss').bound;
  let mb = boundFor({ ...spec, headroom: 1, floor: undefined, ceiling: undefined }, n, criteria.corpusWeights);
  for (const r of finishedRungs) {
    const peak = r.phases?.build?.peakRssMb;
    if (finite(peak) && r.n > 0) mb = Math.max(mb, peak * (n / r.n) ** spec.extrapolateExponent);
  }
  return mb * MB;
}

export function parseRungs(text) {
  const v = String(text).split(',').map((s) => Number(s.trim()));
  if (!v.length || v.some((x) => !Number.isInteger(x) || x < 100)) throw new Error(`--rungs: not a list of entry counts >= 100: ${text}`);
  return [...new Set(v)].sort((a, b) => a - b);
}

export function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${file}:${i + 1}: not JSON`); }
  });
}

/** One row, appended and flushed at once: an abort must lose only the running rung. */
export function appendRow(file, row) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Memory the OS would hand out on macOS, from `vm_stat` text: free + inactive + speculative pages (the
 * file cache is reclaimable there; `os.freemem()` counts only the truly free pages and reads a few hundred
 * MiB on a busy runner with 7 GiB, which refused every rung). null when the text is not vm_stat's.
 */
export function parseVmStat(text) {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  let pages = 0, seen = 0;
  for (const key of ['free', 'inactive', 'speculative']) {
    const m = new RegExp(`^Pages ${key}:\\s+(\\d+)`, 'm').exec(text);
    if (m) { pages += Number(m[1]); seen++; }
  }
  return seen >= 2 ? pages * Number(size[1]) : null;
}

/** Free RAM the gate may use: MemAvailable (Linux), vm_stat (macOS) or os.freemem(), or the cgroup's headroom when that is smaller. */
export function freeRamBytes({ readFile = (f) => fs.readFileSync(f, 'utf8'), platform = process.platform, vmStat = () => spawnSync('vm_stat', { encoding: 'utf8', timeout: 5000 }).stdout, freemem = () => os.freemem() } = {}) {
  let avail = null;
  try { const m = /MemAvailable:\s+(\d+) kB/.exec(readFile('/proc/meminfo')); if (m) avail = Number(m[1]) * 1024; } catch { /* not linux */ }
  if (avail == null && platform === 'darwin') { try { avail = parseVmStat(String(vmStat())); } catch { /* no vm_stat: fall back */ } }
  if (avail == null) avail = freemem();
  try {
    const max = readFile('/sys/fs/cgroup/memory.max').trim();
    const cur = Number(readFile('/sys/fs/cgroup/memory.current').trim());
    if (/^\d+$/.test(max) && Number.isFinite(cur)) avail = Math.min(avail, Number(max) - cur);
  } catch { /* no cgroup v2 limit */ }
  return avail;
}

// ---------------------------------------------------------------------
// Hygiene: temp roots only, cleaned at the end and on a signal
// ---------------------------------------------------------------------

const made = new Set();
const children = new Set();
let abortedBy = null;

export class AbortedError extends Error { constructor(sig) { super(`aborted by ${sig}`); this.name = 'AbortedError'; } }
const checkAbort = () => { if (abortedBy) throw new AbortedError(abortedBy); };

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(d);
  return d;
}
function removeDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* going away */ } made.delete(d); }
function cleanupAll() { for (const d of [...made]) removeDir(d); }

/** Refuse any root that is not under the temp directory: the real store must be impossible to hit. */
export function underTemp(dir) {
  let tmp = os.tmpdir();
  let real = dir;
  try { tmp = fs.realpathSync(tmp); } catch { /* use as is */ }
  try { real = fs.realpathSync(dir); } catch { /* may not exist yet */ }
  const rel = path.relative(tmp, real);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------
// Running things (async, so a signal can reach the children)
// ---------------------------------------------------------------------

function childEnv(root, home, extra = {}) {
  const env = { ...process.env, CHEAP_MEM_ROOT: root, HOME: home, USERPROFILE: home, ...extra };
  delete env.NODE_OPTIONS; // a cap inherited from the host would change what is measured
  return env;
}

const vmhwmKb = (pid) => { try { return Number(/VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]); } catch { return null; } };

/** Run `node <args>`; resolves with timing, output and the child's peak RSS (VmHWM, Linux). */
function run(args, { root, home, timeoutMs = 600000, env = {}, input = null }) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv(root, home, env), stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    children.add(child);
    let out = ''; let err = ''; let hwm = 0; let timedOut = false;
    const poll = setInterval(() => { const k = vmhwmKb(child.pid); if (k && k > hwm) hwm = k; }, 25);
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
    if (input != null) child.stdin.end(input);
    child.on('error', (e) => { err += String(e.message); });
    child.on('exit', () => { const k = vmhwmKb(child.pid); if (k && k > hwm) hwm = k; });
    child.on('close', (status, signal) => {
      clearInterval(poll); clearTimeout(timer); children.delete(child);
      resolve({ status, signal, timedOut, ms: performance.now() - t0, stdout: out, stderr: err, peakRssMb: hwm ? ROUND(hwm / 1024, 1) : null });
    });
  });
}
const memRun = (args, ctx, opt = {}) => run([MEM, '--root', ctx.root, ...args], { ...ctx, ...opt });

// ---------------------------------------------------------------------
// Corpus: heaps filler, then the gold world through the real writer
// ---------------------------------------------------------------------

const GOLD_END = Date.UTC(2025, 11, 31); // the gold world starts 2026-01-02; the filler ends before it

/** Write the filler in chunks (one join of a million lines would meet V8's string limit). Returns bytes and the anchor questions. */
export function writeFiller(root, n, { anchors = 30 } = {}) {
  const tsStart = new Date(GOLD_END - n * 3600000).toISOString();
  const { byFile } = synthesizeCorpus({ targetCount: n, tsStart });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, BENCH_MARKER), 'synthetic corpus from bench/scale-gate.mjs; safe to delete\n');
  let total = 0;
  for (const lines of byFile.values()) total += lines.length;
  // Anchors: evenly spread over every file's lines; the first line of each stride that has a title of four words.
  const stride = Math.max(1, Math.floor(total / anchors));
  const picked = [];
  let seen = 0; let nextAt = Math.floor(stride / 2);
  for (const lines of byFile.values()) {
    for (const line of lines) {
      if (seen >= nextAt && picked.length < anchors && line.includes('"title"')) {
        const e = JSON.parse(line);
        const words = String(e.title ?? '').split(/\s+/).filter(Boolean);
        if (words.length >= 4) { picked.push({ kind: 'anchor', id: e.id, query: words.slice(0, 4).join(' '), expected: [e.id], forbidden: [] }); nextAt += stride; }
      }
      seen += 1;
    }
  }
  let bytes = 0;
  for (const [file, lines] of byFile) {
    const fd = fs.openSync(path.join(root, 'global', file), 'w');
    try {
      for (let i = 0; i < lines.length; i += 20000) {
        const body = `${lines.slice(i, i + 20000).join('\n')}\n`;
        bytes += Buffer.byteLength(body);
        fs.writeSync(fd, body);
      }
    } finally { fs.closeSync(fd); }
    byFile.set(file, null);
  }
  return { bytes, anchors: picked };
}

/** The gold world, written through the real writer (as bench/value-report.mjs does). */
export function writeGold(root) {
  const world = loadWorld();
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify(world.config ?? {}));
  for (const row of world.entries) {
    if (row.project) memory.projectInit(root, row.project);
    memory.logEntry(root, row.type, row.data, { project: row.project ?? null, now: new Date(row.at) });
  }
  return world.entries.length;
}

function questionSet(anchors, { goldCases = Infinity } = {}) {
  const gold = loadCases().filter((c) => !c.gap).slice(0, goldCases)
    .map((c) => ({ kind: 'gold', id: c.id, group: c.category, query: c.query, expected: c.expected, forbidden: c.forbidden ?? [], project: c.project, asOf: c.asOf, category: c.category }));
  return [...gold, ...anchors];
}

// ---------------------------------------------------------------------
// The phases of one rung
// ---------------------------------------------------------------------

const dist = (v) => {
  if (!v.length) return { n: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const s = v.slice().sort((a, b) => a - b);
  return { n: s.length, p50Ms: ROUND(pct(s, 50)), p95Ms: ROUND(pct(s, 95)), maxMs: ROUND(s[s.length - 1]) };
};

async function askOne(ctx, q, timeoutMs) {
  const args = ['find', q.query, '--json', '--top', String(TOP)];
  if (q.project) args.push('--project', q.project);
  if (q.asOf) args.push('--as-of', q.asOf);
  const r = await memRun(args, ctx, { timeoutMs });
  let ids = null;
  if (r.status === 0) { try { const p = JSON.parse(r.stdout); if (Array.isArray(p.hits)) ids = p.hits.slice(0, TOP).map((h) => h?.entry?.id ?? null); } catch { /* ids stay null */ } }
  return { ms: r.timedOut ? timeoutMs : r.ms, ids, status: r.status, timedOut: r.timedOut };
}

/** Cold questions: one fresh process each. Recall is judged from the same answers. */
async function coldPhase(ctx, questions, coldBoundMs) {
  const timeoutMs = Math.min(1800000, Math.max(60000, Math.round(coldBoundMs * 4)));
  const times = []; const judged = []; const anchorHits = []; let unknown = 0; let timeouts = 0;
  for (const q of questions) {
    checkAbort();
    const a = await askOne(ctx, q, timeoutMs);
    if (a.timedOut) timeouts += 1;
    times.push(a.ms); // a timeout counts as the timeout itself: a censored sample can only make p95 worse
    if (a.ids == null) { unknown += 1; if (q.kind === 'gold') judged.push({ id: q.id, group: groupOf(q), state: 'unknown' }); continue; }
    if (q.kind === 'gold') {
      const j = judge({ id: q.id, category: q.category, expected: q.expected, forbidden: q.forbidden }, { ids: a.ids });
      judged.push({ id: q.id, group: groupOf(q), state: j.state, rank: j.rank ?? null, top: j.top ?? [], leakedIds: q.forbidden });
    } else anchorHits.push(a.ids.includes(q.id));
  }
  const gold = summariseRecall(judged).all ?? null;
  const anchorsAsked = questions.filter((q) => q.kind === 'anchor').length;
  const anchorUnknown = anchorsAsked - anchorHits.length;
  return {
    state: 'measured', questions: questions.length, unknownAnswers: unknown, timeouts, firstMs: ROUND(times[0]), ...dist(times),
    gold: gold ? { n: gold.n, unknown: gold.unknown, pass3Pct: gold.pass3Pct, at3Pct: gold.at3Pct, at10Pct: gold.at10Pct } : null,
    anchors: { n: anchorsAsked, unknown: anchorUnknown, at10Pct: anchorUnknown === 0 && anchorsAsked ? ROUND(100 * anchorHits.filter(Boolean).length / anchorsAsked, 1) : null },
  };
}
const groupOf = (q) => q.group ?? q.category;

/** Warm questions: a child loads the index once, round 1 warms, round 2 is timed. */
async function warmPhase(ctx, questions) {
  const file = path.join(ctx.scratch, 'warm-questions.json');
  fs.writeFileSync(file, JSON.stringify(questions.map((q) => q.query)));
  const r = await run([SELF, '--child-warm', ctx.root, file], { ...ctx, timeoutMs: 3600000 });
  if (r.status !== 0) return { state: 'unknown', why: `child exited ${r.status}${r.timedOut ? ' (timed out)' : ''}: ${r.stderr.slice(-200)}` };
  try { const o = JSON.parse(r.stdout); return { state: 'measured', loadMs: o.loadMs, ...dist(o.timesMs), childMaxRssMb: o.maxRssMb }; } catch { return { state: 'unknown', why: 'child output is not JSON' }; }
}

/** The warm service, as `mem serve` runs it: the recall server over its socket. */
async function servicePhase(ctx, questions) {
  const sockDir = tempDir('cmsg-');
  const env = { MEM_RECALL_SERVER_DIR: sockDir };
  const where = place.place(ctx.root, { ...process.env, ...env });
  if (process.platform !== 'win32' && Buffer.byteLength(where.socket) > place.MAX_SOCKET_PATH) {
    removeDir(sockDir);
    return { state: 'unknown', why: `socket path too long (${Buffer.byteLength(where.socket)} bytes > ${place.MAX_SOCKET_PATH}); use a shorter TMPDIR` };
  }
  const code = `import(${JSON.stringify(RECALL_MODULE)}).then((r) => r.start(${JSON.stringify(ctx.root)}))`
    + '.then((x) => { if (!x.running) process.exit(3); process.on("SIGTERM", () => x.close().then(() => process.exit(0))); });';
  const kid = spawn(process.execPath, ['--max-old-space-size=12288', '-e', code], { env: childEnv(ctx.root, ctx.home, env), stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(kid);
  let err = '';
  kid.stderr.on('data', (s) => { err += s; });
  try {
    const until = Date.now() + 60000;
    while (!/listening on/.test(err) && Date.now() < until && kid.exitCode == null) await wait(25);
    if (!/listening on/.test(err)) return { state: 'unknown', why: `server did not start: ${err.slice(-200)}` };
    await wait(200);
    const key = fs.readFileSync(where.key, 'utf8').trim();
    const ms = [];
    let peak = 0;
    for (const q of questions) {
      checkAbort();
      const t = performance.now();
      const a = await ask(ctx.root, key, where.socket, q.query);
      if (!a.ok) return { state: 'unknown', why: `a question was answered ${a.reason ?? 'not ok'}` };
      ms.push(performance.now() - t);
      peak = Math.max(peak, vmhwmKb(kid.pid) ?? 0);
    }
    return { state: 'measured', firstMs: ROUND(ms[0]), ...dist(ms.slice(1)), serverPeakRssMb: peak ? ROUND(peak / 1024, 1) : null };
  } finally {
    const gone = new Promise((r) => kid.once('exit', r));
    try { kid.kill('SIGTERM'); } catch { /* gone */ }
    await Promise.race([gone, wait(15000)]);
    try { kid.kill('SIGKILL'); } catch { /* gone */ }
    children.delete(kid);
    removeDir(sockDir);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(root, key, sock, query) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(`${JSON.stringify({ v: place.VERSION, key, root, query, top: '5', deadline_ms: Date.now() + 600000 })}\n`));
    c.on('data', (s) => { buf += s; });
    c.on('error', reject);
    c.on('end', () => { try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); } });
  });
}

/** Four time questions, from the filler's own date range. `--since` bypasses the index. */
async function timePhase(ctx, n) {
  const mid = new Date(GOLD_END - Math.floor(n / 2) * 3600000).toISOString();
  const late = new Date(GOLD_END - 3600000).toISOString();
  const day = (iso) => iso.slice(0, 10);
  const plan = [
    { name: 'since-date', args: ['find', SCALE_QUERIES[3], '--json', '--top', '5', '--since', day(new Date(GOLD_END - 30 * 86400000).toISOString())] },
    { name: 'since-duration', args: ['find', SCALE_QUERIES[1], '--json', '--top', '5', '--since', '30d'] },
    { name: 'as-of-middle', args: ['find', SCALE_QUERIES[4], '--json', '--top', '5', '--as-of', mid] },
    { name: 'as-of-late', args: ['find', SCALE_QUERIES[2], '--json', '--top', '5', '--as-of', late] },
  ];
  const items = [];
  for (const p of plan) {
    checkAbort();
    const r = await memRun(p.args, ctx, { timeoutMs: 1800000 });
    let ok = false;
    if (r.status === 0) { try { ok = Array.isArray(JSON.parse(r.stdout).hits); } catch { ok = false; } }
    items.push({ name: p.name, ok, ms: ROUND(r.ms), status: r.status, timedOut: r.timedOut, peakRssMb: r.peakRssMb });
  }
  return { state: 'measured', items, allAnswered: items.every((i) => i.ok) };
}

async function doctorPhase(ctx, timeoutMs) {
  const r = await memRun(['doctor'], ctx, { timeoutMs });
  if (r.status == null && !r.timedOut) return { state: 'unknown', why: `doctor did not run: ${r.stderr.slice(-200)}` };
  const p = parseDoctor(r.stdout);
  const answered = !r.timedOut && [0, 1, 2].includes(r.status) && p.order.length > 0;
  return { state: 'measured', answered, status: r.status, timedOut: r.timedOut, ms: ROUND(r.ms), findings: p.order.length, summary: p.summary, peakRssMb: r.peakRssMb };
}

async function linkPhase(ctx, timeoutMs) {
  const r = await memRun(['net'], ctx, { timeoutMs });
  if (r.status == null && !r.timedOut) return { state: 'unknown', why: `net did not run: ${r.stderr.slice(-200)}` };
  return { state: 'measured', answered: !r.timedOut && r.status === 0, status: r.status, timedOut: r.timedOut, ms: ROUND(r.ms), peakRssMb: r.peakRssMb, bytes: r.stdout.length };
}

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

function getJson(url, timeoutMs) {
  return new Promise((ok, no) => {
    const q = http.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: timeoutMs }, (r) => {
      const parts = [];
      r.on('data', (b) => parts.push(b));
      r.on('end', () => {
        try {
          const buf = Buffer.concat(parts);
          const raw = r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(buf) : buf;
          ok({ status: r.statusCode, json: JSON.parse(raw.toString('utf8')), bytes: raw.length });
        } catch (e) { no(e); }
      });
      r.on('error', no);
    });
    q.on('timeout', () => q.destroy(new Error('deadline passed')));
    q.on('error', no);
  });
}

/** The dashboard head: bin/mem-serve as its own process, first GET /dashboard.json, then until the counters are in. */
async function dashboardPhase(ctx, deadlineMs) {
  const port = await freePort();
  const env = { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_PORT: String(port), CHEAP_MEM_SERVE_HOST: '127.0.0.1', MEM_RECALL_SERVER: '0' };
  const cenv = childEnv(ctx.root, ctx.home, env);
  delete cenv.CHEAP_MEM_SERVE_TOKEN;
  const kid = spawn(process.execPath, ['-e', `import(${JSON.stringify(SERVE_MODULE)}).then((m) => m.serve(${JSON.stringify(ctx.root)}, process.env))`], { cwd: ctx.root, env: cenv, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(kid);
  let err = ''; let peak = 0;
  kid.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
  const rssClock = setInterval(() => { peak = Math.max(peak, vmhwmKb(kid.pid) ?? 0); }, 100);
  const base = `http://127.0.0.1:${port}`;
  try {
    const up0 = performance.now();
    for (;;) {
      checkAbort();
      if (performance.now() - up0 > 120000) return { state: 'unknown', why: `server not up in 120 s: ${err.slice(-200)}` };
      if (kid.exitCode != null) return { state: 'unknown', why: `server exited ${kid.exitCode}: ${err.slice(-200)}` };
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not yet */ }
      await wait(50);
    }
    const upMs = performance.now() - up0;
    const t1 = performance.now();
    const first = await getJson(`${base}/dashboard.json`, deadlineMs);
    const firstMs = performance.now() - t1;
    if (first.status !== 200) return { state: 'measured', firstAnswered: false, status: first.status, upMs: ROUND(upMs) };
    let cur = first.json; let countersMs = null;
    while (performance.now() - t1 < deadlineMs) {
      checkAbort();
      if (cur.overview) { countersMs = performance.now() - t1; break; }
      await wait(500);
      cur = (await getJson(`${base}/dashboard.json`, deadlineMs)).json;
    }
    return { state: 'measured', firstAnswered: true, upMs: ROUND(upMs), firstMs: ROUND(firstMs), countersMs: ROUND(countersMs), source: cur.cache?.source ?? null, jsonBytes: first.bytes, serverPeakRssMb: peak ? ROUND(peak / 1024, 1) : null };
  } finally {
    clearInterval(rssClock);
    try { kid.kill('SIGKILL'); } catch { /* gone */ }
    children.delete(kid);
  }
}

/** One write, LAST (it changes the store): the entry must then be found by its own token. */
async function writePhase(ctx) {
  const token = `zq${crypto.randomBytes(5).toString('hex')}`;
  const w = await memRun(['log', 'learning', '--title', `scale gate probe ${token}`, '--text', `a note written after the build, unique token ${token}`], ctx, { timeoutMs: 1800000 });
  if (w.status == null && !w.timedOut) return { state: 'unknown', why: `log did not run: ${w.stderr.slice(-200)}` };
  const out = { state: 'measured', writeOk: !w.timedOut && w.status === 0, writeMs: ROUND(w.ms), writeStatus: w.status };
  if (!out.writeOk) { out.findable = false; return out; }
  const f = await memRun(['find', token, '--json', '--top', String(TOP)], ctx, { timeoutMs: 1800000 });
  let hit = false;
  if (f.status === 0) { try { hit = JSON.parse(f.stdout).hits.some((h) => JSON.stringify(h?.entry ?? {}).includes(token)); } catch { hit = false; } }
  return { ...out, findable: hit, findAfterWriteMs: ROUND(f.timedOut ? 1800000 : f.ms), findStatus: f.status };
}

// ---------------------------------------------------------------------
// One rung
// ---------------------------------------------------------------------

function tryDropCaches() {
  try { spawnSync('sync'); fs.writeFileSync('/proc/sys/vm/drop_caches', '3\n'); return true; } catch { return false; }
}

/** Build the root for `n` entries and the first index. Shared by the rung and the calibration. */
async function buildRoot(n, opts, log) {
  const root = tempDir(`cm-scale-gate-${n}-`);
  const home = tempDir('cm-scale-gate-home-');
  const scratch = tempDir('cm-scale-gate-scratch-');
  if (!underTemp(root)) throw new Error(`root ${root} is not under the temp directory`);
  const ctx = { root, home, scratch };
  const t0 = performance.now();
  log('writing the filler');
  const filler = writeFiller(root, n, { anchors: opts.anchors });
  const genMs = performance.now() - t0;
  log('writing the gold world through the real writer');
  const t1 = performance.now();
  const goldN = writeGold(root);
  const goldWriteMs = performance.now() - t1;
  checkAbort();
  log('building the index (first find)');
  const b = await memRun(['find', SCALE_QUERIES[0], '--json', '--top', String(TOP)], ctx, { timeoutMs: 6 * 3600000 });
  checkAbort(); // a signal kills the child: that is an abort, not a failed build
  const build = { status: b.status, timedOut: b.timedOut, ms: ROUND(b.ms), peakRssMb: b.peakRssMb, stderr: b.status === 0 ? null : b.stderr.slice(-300) };
  return { ctx, filler, goldN, genMs: ROUND(genMs), goldWriteMs: ROUND(goldWriteMs), build, bytes: dirBytes(root) };
}

export async function runRung(n, opts, criteria, baseline, calib) {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const log = (m) => process.stderr.write(`  [${n}] ${m}\n`);
  const phases = {};
  let built = null;
  try {
    const stage = await buildRoot(n, opts, log);
    built = stage;
    const { ctx } = stage;
    phases.build = { genMs: stage.genMs, goldWriteMs: stage.goldWriteMs, goldEntries: stage.goldN, fillerBytes: stage.filler.bytes, ...stage.build };
    const buildOk = stage.build.status === 0 && !stage.build.timedOut;
    const coldBound = boundFor(criteria.criteria.find((k) => k.id === 'cold-find-p95').bound, n, criteria.corpusWeights);
    const questions = questionSet(stage.filler.anchors, { goldCases: opts.goldCases });
    if (buildOk) {
      phases.pageCacheDropped = tryDropCaches();
      log(`cold questions (${questions.length}, one fresh process each)`);
      phases.cold = await coldPhase(ctx, questions, coldBound);
      checkAbort();
      log('warm questions (loaded index)');
      phases.warm = await warmPhase(ctx, questions);
      checkAbort();
      log('warm service');
      phases.service = await servicePhase(ctx, questions);
      checkAbort();
      log('time questions');
      phases.time = await timePhase(ctx, n);
      log('doctor');
      phases.doctor = await doctorPhase(ctx, criteria.criteria.find((k) => k.id === 'doctor-answers').timeoutMs ?? 1800000);
      checkAbort();
      log('dashboard head');
      phases.dashboard = await dashboardPhase(ctx, DASHBOARD_DEADLINE_MS);
      checkAbort();
      log('link map');
      phases.link = await linkPhase(ctx, criteria.criteria.find((k) => k.id === 'link-map-answers').timeoutMs ?? 1800000);
      checkAbort();
      log('one write, last');
      phases.write = await writePhase(ctx);
    } else phases.skipped = `the index build did not succeed (exit ${stage.build.status}${stage.build.timedOut ? ', timed out' : ''}); nothing after it can be measured`;
    const bytesAfter = dirBytes(ctx.root);
    const metrics = {
      goldPass3Pct: phases.cold?.gold?.unknown === 0 ? phases.cold.gold.pass3Pct : null,
      goldAt10Pct: phases.cold?.gold?.unknown === 0 ? phases.cold.gold.at10Pct : null,
      anchorAt10Pct: phases.cold?.anchors?.at10Pct ?? null,
      coldP95Ms: phases.cold?.p95Ms ?? null,
      warmP95Ms: phases.warm?.state === 'measured' ? phases.warm.p95Ms : null,
      serviceP95Ms: phases.service?.state === 'measured' ? phases.service.p95Ms : null,
      buildMs: buildOk ? stage.build.ms : null,
      buildPeakRssMb: buildOk ? stage.build.peakRssMb : null,
      doctorAnswered: phases.doctor?.state === 'measured' ? phases.doctor.answered : null,
      dashboardFirstMs: phases.dashboard?.state === 'measured' && phases.dashboard.firstAnswered ? phases.dashboard.firstMs : null,
      dashboardCountersMs: phases.dashboard?.state === 'measured' ? phases.dashboard.countersMs ?? null : null,
      netAnswered: phases.link?.state === 'measured' ? phases.link.answered : null,
      timeAnswered: phases.time?.state === 'measured' ? phases.time.allAnswered : null,
      writeOk: phases.write?.state === 'measured' ? phases.write.writeOk : null,
      writeFindable: phases.write?.state === 'measured' ? phases.write.findable : null,
      findAfterWriteMs: phases.write?.state === 'measured' && phases.write.writeOk ? phases.write.findAfterWriteMs : null,
    };
    // A dashboard that was measured and never answered is a failure of the first-answer check, not a missing
    // number: the sample is censored at the deadline (a value, like a timed-out cold question).
    if (phases.dashboard?.state === 'measured' && !phases.dashboard.firstAnswered) metrics.dashboardFirstMs = DASHBOARD_DEADLINE_MS;
    const checks = evaluateRung(n, metrics, criteria, baseline);
    return {
      kind: 'rung', n, status: 'done', verdict: rungVerdict(checks), checks, metrics, phases,
      disk: { corpusAndIndexBytes: stage.bytes, afterAllPhasesBytes: bytesAfter, bytesPerEntry: ROUND(stage.bytes / n, 1), bytesPerEntryAfter: ROUND(bytesAfter / n, 1) },
      startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - t0),
      calibrationBytesPerEntry: calib?.bytesPerEntry ?? null,
    };
  } finally {
    if (built && !opts.keep) { removeDir(built.ctx.root); removeDir(built.ctx.home); removeDir(built.ctx.scratch); }
    else if (built) process.stderr.write(`  [${n}] kept: ${built.ctx.root}\n`);
  }
}

async function calibrate(n, opts) {
  process.stderr.write(`calibration: building ${n} entries to measure bytes per entry\n`);
  const stage = await buildRoot(n, { ...opts, anchors: 4 }, (m) => process.stderr.write(`  [calibration] ${m}\n`));
  try {
    if (stage.build.status !== 0) return { kind: 'calibration', n, status: 'failed', why: `build exit ${stage.build.status}` };
    return {
      kind: 'calibration', n, status: 'done', bytesPerEntry: ROUND(stage.bytes / n, 1),
      buildMs: stage.build.ms, buildPeakRssMb: stage.build.peakRssMb, at: new Date().toISOString(),
    };
  } finally { removeDir(stage.ctx.root); removeDir(stage.ctx.home); removeDir(stage.ctx.scratch); }
}

// ---------------------------------------------------------------------
// Children and the main program
// ---------------------------------------------------------------------

async function childWarm(root, file) {
  const queries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t0 = performance.now();
  const index = loadIndex(root, { language: 'en' });
  const loadMs = performance.now() - t0;
  const options = { top: 30, mmr: true, mmrLambda: 0.7 };
  for (const q of queries) search(index, q, options);
  const timesMs = [];
  for (const q of queries) { const s = performance.now(); search(index, q, options); timesMs.push(performance.now() - s); }
  process.stdout.write(`${JSON.stringify({ loadMs: ROUND(loadMs), timesMs, maxRssMb: ROUND(process.resourceUsage().maxRSS / 1024, 1) })}\n`);
}

function criteriaCommitted(file) {
  try {
    const rel = path.relative(REPO, file);
    const tracked = spawnSync('git', ['-C', REPO, 'ls-files', '--error-unmatch', rel], { encoding: 'utf8' });
    if (tracked.status !== 0) return false;
    return spawnSync('git', ['-C', REPO, 'diff', '--quiet', 'HEAD', '--', rel]).status === 0;
  } catch { return null; }
}

function flag(argv, name, fallback = null) { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; }

function line(r) {
  return `  rung ${String(r.n).padStart(8)}  ${r.verdict.toUpperCase().padEnd(7)} ${r.status}${r.reason ? `  ${r.reason}` : ''}`;
}

async function main(argv) {
  const rungs = parseRungs(flag(argv, '--rungs', DEFAULT_RUNGS.join(',')));
  const resume = argv.includes('--resume');
  const dryRun = argv.includes('--dry-run');
  const critFile = path.resolve(flag(argv, '--criteria', CRITERIA_FILE));
  const outFile = path.resolve(flag(argv, '--out', path.join(os.tmpdir(), 'cm-scale-gate-results.jsonl')));
  const opts = {
    goldCases: Number(flag(argv, '--gold-cases', Infinity)), anchors: Number(flag(argv, '--anchors', 30)), keep: argv.includes('--keep'),
  };
  const criteria = loadCriteria(critFile);
  const sha = sha256File(critFile);
  const committed = path.resolve(critFile) === CRITERIA_FILE ? criteriaCommitted(critFile) : null;
  if (committed !== true && !argv.includes('--allow-uncommitted-criteria')) {
    process.stderr.write(`scale gate: refusing to run: ${critFile} is not the committed version (pre-registration means committed first). `
      + 'Commit it, or pass --allow-uncommitted-criteria for a development run (the rows will say so).\n');
    return 2;
  }
  for (const n of rungs) if (n > MAX_ENTRIES) { process.stderr.write(`scale gate: ${n} is above the container limit ${MAX_ENTRIES} (owner decision 2026-10-02)\n`); return 2; }

  const rows = readRows(outFile);
  if (rows.length && !resume) { process.stderr.write(`scale gate: ${outFile} already has ${rows.length} row(s). Use --resume to continue it, or choose another --out.\n`); return 2; }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const env = { ...environment(), loadAvg1: ROUND(os.loadavg()[0], 2), tmpdir: os.tmpdir() };
  const emit = (row) => { appendRow(outFile, { ...row, criteriaSha256: sha, criteriaCommitted: committed, commit: env.gitCommit ?? null }); rows.push(row); };
  const probeFree = () => freeBytesAt(os.tmpdir());

  const measuredRungs = () => [...latestRungRows(rows).values()].filter((r) => r.status === 'done' && r.disk);
  const resolveCalibration = async () => {
    const earlier = [...rows].reverse().find((r) => r.kind === 'calibration' && r.status === 'done');
    if (earlier) return earlier;
    if (argv.includes('--bytes-per-entry')) return { kind: 'calibration', n: 0, status: 'given', bytesPerEntry: Number(flag(argv, '--bytes-per-entry')) };
    const row = await calibrate(Number(flag(argv, '--calibration', 2000)), opts);
    emit({ ...row, env });
    return row;
  };
  const calib = await resolveCalibration();
  if (calib.status !== 'done' && calib.status !== 'given') { process.stderr.write(`scale gate: calibration failed: ${calib.why}\n`); cleanupAll(); return 3; }
  // The estimate: the largest bytes per entry seen so far (calibration or a finished rung); RAM from
  // the documented figure, or a finished rung's measured peak grown by the documented exponent.
  const estimate = (n) => {
    const seen = [calib.bytesPerEntry, ...measuredRungs().map((r) => r.disk.bytesPerEntryAfter)].filter(Number.isFinite);
    return { bytesPerEntry: Math.max(...seen), rssBytesPerEntry: estimateRssBytes(n, criteria, measuredRungs()) / n };
  };

  const done = resume ? doneRungs(rows) : new Set();
  const todo = rungs.filter((n) => !done.has(n));
  process.stderr.write(`scale gate: rungs ${rungs.join(', ')}${resume && done.size ? ` (done already: ${[...done].join(', ')})` : ''}; out ${outFile}\n`);
  process.stderr.write(`  disk estimate: ${estimate(1000).bytesPerEntry} bytes per entry (${calib.status === 'given' ? 'given' : `calibration at ${calib.n} entries`}); free ${gib(probeFree() ?? NaN)} GiB under ${os.tmpdir()}\n`);
  for (const n of rungs) {
    const pc = precheck({ n, freeDiskBytes: probeFree(), freeRamBytes: freeRamBytes(), ...estimate(n) });
    process.stderr.write(`  pre-check ${String(n).padStart(8)}: disk ~${pc.diskNeedBytes == null ? '?' : gib(pc.diskNeedBytes)} GiB (free ${pc.freeDiskBytes == null ? '?' : gib(pc.freeDiskBytes)}), RAM ~${pc.ramNeedBytes == null ? '?' : gib(pc.ramNeedBytes)} GiB (free ${pc.freeRamBytes == null ? '?' : gib(pc.freeRamBytes)}) -> ${pc.ok ? 'fits' : pc.reason}\n`);
  }
  if (dryRun) { cleanupAll(); return 0; }

  let exit = 0;
  for (const n of todo) {
    try { checkAbort(); } catch { exit = 130; break; }
    const pc = precheck({ n, freeDiskBytes: probeFree(), freeRamBytes: freeRamBytes(), ...estimate(n) });
    if (!pc.ok) {
      emit({ kind: 'rung', n, status: 'refused', verdict: 'unknown', reason: pc.reason, precheck: pc, checks: [], at: new Date().toISOString(), env });
      process.stderr.write(`${line(rows[rows.length - 1])}\n`);
      continue;
    }
    const base = latestRungRows(rows).get(criteria.baselineRung);
    const baseline = base?.status === 'done' ? base.metrics : null;
    process.stderr.write(`rung ${n}: start (load ${ROUND(os.loadavg()[0], 2)})\n`);
    try {
      const row = await runRung(n, opts, criteria, baseline, calib);
      emit({ ...row, precheck: pc, env });
      process.stderr.write(`${line(row)}\n`);
    } catch (e) {
      const aborted = e instanceof AbortedError;
      emit({ kind: 'rung', n, status: 'aborted', verdict: 'unknown', reason: aborted ? e.message : `error: ${String(e?.message ?? e).slice(0, 300)}`, checks: [], at: new Date().toISOString(), env });
      process.stderr.write(`${line(rows[rows.length - 1])}\n`);
      exit = aborted ? 130 : 4;
      break; // an unknown rung is not a license to start the next, larger one
    }
  }
  const sum = summarize(rows, rungs);
  const points = measuredRungs().filter((r) => r.metrics?.buildMs > 0).map((r) => ({ n: r.n, y: r.metrics.buildMs }));
  const ho = heldOut(points);
  emit({ kind: 'summary', rungs, ...sum, heldOutBuildTime: ho, at: new Date().toISOString() });
  process.stdout.write(`${JSON.stringify({ overall: sum.overall, rungs: sum.rungs, heldOutBuildTime: ho, out: outFile })}\n`);
  cleanupAll();
  return exit;
}

function onSignal(sig) {
  abortedBy = sig;
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child-warm') {
    childWarm(argv[1], argv[2]).catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exit(1); });
  } else {
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    // Windows has no SIGTERM to deliver: `child.kill('SIGTERM')` there is a hard TerminateProcess and no
    // handler runs. A parent that spawned this gate with an IPC channel can ask for the same abort by
    // message instead. The channel is unref'd: it never keeps a finished gate alive.
    if (typeof process.send === 'function') {
      process.on('message', (m) => { if (m === 'abort:SIGTERM') onSignal('SIGTERM'); });
      process.channel?.unref?.();
    }
    process.on('exit', cleanupAll);
    main(argv).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.stack || e.message}\n`); cleanupAll(); process.exitCode = 1; });
  }
}
