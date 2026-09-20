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
export function buildCorpus(root, count, { seed = 42, anchors = 12, project = null } = {}) {
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
  const start = Date.parse('2026-01-01T00:00:00Z');

  for (let i = 0; i < count; i += 1) {
    const [type, file] = TYPE_FILES[Math.floor(r() * TYPE_FILES.length)];
    const words = [];
    for (let w = 0; w < 6 + Math.floor(r() * 10); w += 1) {
      words.push(r() < 0.75 ? COMMON[Math.floor(r() * COMMON.length)] : zipfWord(r, i + w));
    }
    // Spread timestamps across a year so time-range recall has something
    // to bite on. Whole seconds, because that is what logEntry writes.
    const ts = new Date(start + Math.floor(r() * 365 * 86400) * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');
    const e = {
      id: `g${i.toString(36)}`,
      ts,
      title: `${COMMON[Math.floor(r() * COMMON.length)]} ${zipfWord(r, i)}`,
      text: words.join(' '),
      tags: [COMMON[Math.floor(r() * COMMON.length)]],
    };
    if (type === 'decision') { e.topic = e.title; e.choice = words[0]; e.why = e.text; }
    if (type === 'error') { e.class = 'measurement'; }
    if (!streams.has(file)) streams.set(file, []);
    streams.get(file).push(JSON.stringify(e));
  }

  // The anchors go in last so they are not diluted by the generator.
  for (let a = 0; a < anchors; a += 1) {
    const phrase = `anchorphrase${a}zzq`;
    const e = {
      id: `anchor${a}`,
      ts: new Date(start + (a + 1) * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
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
