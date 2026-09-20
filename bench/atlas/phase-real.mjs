// bench/atlas/phase-real.mjs — the same measurements, against a memory
// nobody generated.
//
// **Why this phase exists.** Every other phase in this atlas measures
// cheap-mem against a corpus `buildCorpus()` wrote a moment ago: a fixed
// seed, a fixed vocabulary, entries of near-identical shape. That corpus
// is a fair way to compare one run of this code against another, and it
// is not evidence about real use — a generator can only produce the
// skew it was told to produce, and every phase that times or scores
// against it inherits whatever gap sits between the guess and the
// grown thing.
//
// `/home/user/lucky-mem` is the closest thing to ground truth this repo
// can reach: the same design under German names (`TYPEN`, `bin/mem`,
// `LUCKY_MEM_*`), grown by a person's daily use for months. Nobody
// shaped its type mix, its entry lengths or its tag habits to be
// friendly to a benchmark. `core.mjs`'s `mem()` takes `bin` and
// `rootVar` overrides for exactly this — see its own doc comment for
// the 2026-09-05 measurement that first showed a guessed vocabulary
// timing the wrong thing (bench/scale.mjs).
//
// **The constraint that shapes every line below.** This is someone's
// actual memory, and this report is committed to a public repository.
// No entry text, title, id, capture filename, person name, project
// name, tag value or in-tree path may reach `atlas.record()` — only
// distributions, counts, percentiles, ratios, timings and shapes. That
// is enforced in CODE, not by care: every `evidence`, `actual`,
// `expected` and `measured` value passes through `Guard#scrub()` before
// `record()` (this phase's own wrapper, never `atlas.record` directly)
// hands it to the apparatus. A value the guard cannot vouch for is
// replaced and counted, and the count itself becomes a check at the end
// — zero redactions is the only way this phase gets to call itself
// clean, because a redaction means the phase tried to leak and the
// guard happened to catch it, not that everything is fine.
//
// **What "real" buys, concretely.** Section A reads the drawer files
// directly — no CLI, no risk of writing anything — and compares their
// shape against a synthetic corpus of similar size: type concentration,
// entry size, findability, age, tags, and the long tail of huge or
// broken lines. That comparison, not any single number, is the actual
// deliverable: wherever the generated corpus is unlike the grown one,
// every other phase's timing and recall numbers carry that bias
// unlabelled, and naming the gap here is the only place it gets named
// at all.
//
// Section B drives lucky-mem's OWN CLI the way `phase-load.mjs` drives
// cheap-mem's — a real child process, real startup cost, real argument
// parsing. Every one of those commands is documented to write on first
// use (an index cache, a search register), so this phase never points
// them at the original: it copies the memory to a scratch root first,
// after checking the copy will fit in this container's fixed disk
// budget, and says in the record whether a number came from that copy.
//
// Section C is one blind spot named on purpose: retrieval QUALITY
// (does `finde` return the right entry) needs a human-labelled answer
// key, and inventing one from the entries would mean reading them —
// which is exactly what this file exists to not do.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  VERDICT, SEVERITY, mem, buildCorpus, tempRoot, pct, dirBytes,
} from './core.mjs';

// --- where the sister house lives, and how to drive it -----------------

const LUCKY_MEM_ROOT = '/home/user/lucky-mem';
const LUCKY_MEM_BIN = path.join(LUCKY_MEM_ROOT, 'bin', 'mem');

// Verified against that checkout's `bin/mem` (the line reading
// `process.env.LUCKY_MEM_WURZEL`) rather than assumed: a wrong env var
// name would silently run every command against lucky-mem's OWN root
// instead of the scratch copy, which is the one thing this phase must
// never do.
const LUCKY_MEM_ROOT_VAR = 'LUCKY_MEM_WURZEL';

// Top-level entries excluded when copying lucky-mem to a scratch root.
// `.git` and `node_modules` are large and untouched by any command this
// phase runs; `.pipeline` is the mutable runtime state (index cache,
// search register, and a dozen other subsystems' own files) that a
// "cold build" measurement must start without, so seeding it from the
// original would make that number fiction rather than a floor.
const COPY_EXCLUDE_TOP = new Set(['.git', 'node_modules', '.pipeline']);

// A copy is only attempted if the free space at the destination is at
// least this many times the copy's own size — headroom for whatever the
// commands below write (the index cache, the search register, lucky-mem's
// own runtime bookkeeping) without a chance of filling the disk.
const DISK_SAFETY_FACTOR = 3;

// Mirrors `AUFFINDBAR_MIN_WORTE` in that checkout's `src/doktor.mjs`:
// lucky-mem's own doctor uses "at least this many words over three
// letters, across the same weighted fields search ranks on" as its
// definition of findable. Reusing their own threshold, rather than
// inventing one, means this phase's reachability number answers the
// question their own health check asks.
const FINDABLE_MIN_WORDS = 3;

// Mirrors the keys of `FELDGEWICHT` in that checkout's `src/suche.mjs`
// (read directly, not imported — this file stays a plain reader of the
// other house's data, never a caller of its code). These are lucky-mem's
// own field NAMES, which are schema, not content: knowing that a
// document has a field called `titel` says nothing about what is in it.
const WEIGHTED_FIELDS = [
  'titel', 'topic', 'klasse', 'tags', 'frageworte', 'skill', 'wahl',
  'verworfen', 'learning', 'pflicht', 'frage', 'regel', 'warum', 'auszug',
  'beschreibung', 'text', 'fakt',
];

const LARGE_LINE_BYTES = 10 * 1024;
const RECENCY_WINDOWS_DAYS = [7, 30, 90];

// How far a real/synthetic pair may differ before it is named as bias.
// A ratio, not a difference, so it means the same thing whether the
// quantity is a percentage or a byte count. Both are constants so a
// later reader can disagree with them without re-deriving anything.
const BIAS_DEGRADED_RATIO = 1.5;
const BIAS_FAIL_RATIO = 3;

// Wall-clock ceilings for the CLI measurements. Generous on purpose:
// this corpus is a couple of thousand entries, an order of magnitude
// below the ladder `phase-load.mjs` tests cheap-mem against, so these
// exist to catch "hung" or "pathological", not to grade normal latency.
const BUILD_DEGRADED_MS = 15000;
const BUILD_FAIL_MS = 60000;
const FINDE_DEGRADED_MS = 1000;
const FINDE_FAIL_MS = 5000;
const DOCTOR_DEGRADED_MS = 15000;
const DOCTOR_FAIL_MS = 60000;
const KONTEXT_DEGRADED_MS = 5000;
const KONTEXT_FAIL_MS = 20000;

// Below this many sampled queries, a p95 is the slowest of a handful
// dressed up as a tail — see `PERCENTILE_FLOOR` in `phase-load.mjs` for
// the same reasoning applied to repeated calls of one command.
const QUERY_PERCENTILE_FLOOR = 5;

// --- the guard -----------------------------------------------------
//
// **What this is not.** A filter that tries to recognise "personal
// content" is a filter that will eventually see a German sentence that
// happens to look structured and let it through. This guard does the
// opposite: it recognises the SHAPE this phase's own output is allowed
// to have — numbers, booleans, and a two-word closed vocabulary this
// file actually uses — and rejects everything else, including a
// perfectly innocent English sentence nobody defined the guard to
// accept. That is deliberate. A phase that needs to say more than
// "copy" or "original" about a measurement is a phase that has started
// carrying content, and the fix is to say less, not to widen the guard.
//
// **Why a class, not a closure of counters.** Two things must travel
// together for the entire phase run: the running redaction count and
// the substitution function every guarded field goes through. A class
// keeps them one object instead of a module-level counter that would
// leak between runs of this phase inside the same process.

// The only two words this phase's guarded fields ever spell out — see
// the doc comment above for why the set stays this small. Both name
// which of two things a CLI measurement ran against (`copy`) or would
// have run against had it been safe to (`original`); neither carries
// anything about the memory's content.
const ALLOWED_WORDS = new Set(['copy', 'original']);

// A token is numeric-shaped if it is a signed number, optionally with
// internal separators a timing or a ratio would use (`.` `,` `:` `%`
// `/` `(` `)` `<` `>` `~` `+` `-`), and optionally one unit suffix from
// a fixed small set. `12:34.5%`, `(150ms)` and `1.3x` all match; a word
// does not, because a word does not start with a digit or a sign.
const NUMERIC_SHAPE = /^[+-]?\d[\d.,:%/()<>=~-]*(ms|s|kb|mb|gb|b|d|x)?$/i;

function isSafeToken(token) {
  if (token === '') return true;
  if (NUMERIC_SHAPE.test(token)) return true;
  return ALLOWED_WORDS.has(token.toLowerCase());
}

/** A string is safe only if EVERY whitespace-separated token in it is. */
function isSafeString(s) {
  return s.split(/\s+/).every(isSafeToken);
}

class Guard {
  constructor() {
    this.redactions = 0;
  }

  /** Recursively replace anything the allow-list cannot vouch for. */
  scrub(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (isSafeString(value)) return value;
      this.redactions += 1;
      return '[[redacted by content guard]]';
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v));
    if (typeof value === 'object') {
      const out = {};
      // Keys are this phase's OWN field names (English identifiers this
      // file wrote, e.g. `p50Bytes`), never data read from lucky-mem —
      // only values need scrubbing.
      for (const [k, v] of Object.entries(value)) out[k] = this.scrub(v);
      return out;
    }
    // A function, symbol or bigint is not a shape this phase ever
    // legitimately produces for a record. Redact rather than guess.
    this.redactions += 1;
    return '[[redacted: unsupported value shape]]';
  }
}

/**
 * A string this file AUTHORED, with guarded values interpolated into it.
 *
 * **Why this exists, and what the first cut got wrong.** The guard above
 * is right about values and was applied to whole sentences, which made
 * the report useless: an expectation came out as `1.5,3` and a
 * measurement as `5.8`, with nothing left to say what either number
 * meant. That is not caution, it is a different failure — a benchmark
 * whose findings cannot be read is not reproducible by anyone, which is
 * the one thing this report has to be.
 *
 * The distinction the guard was missing: a record's prose is a STRING
 * LITERAL IN THIS FILE. It cannot carry a byte of lucky-mem, because it
 * was written before lucky-mem was opened. Only the interpolated values
 * come from the measurement, and only those need vouching. A tagged
 * template makes that structural rather than a promise: the literal
 * parts are source, every `${...}` goes through `Guard#scrub`, and the
 * result is branded so `record()` can tell a vouched sentence from a
 * raw string somebody built with a plain backtick.
 *
 * So the strictness is unchanged where it matters — anything that came
 * out of the memory is still numbers, booleans or nothing — and a raw
 * string still gets scrubbed whole, which is what catches the mistake
 * this brand exists to catch.
 */
class Vouched {
  constructor(text, guard) { this.text = text; this.guard = guard; }

  /**
   * Append another literal from this file.
   *
   * Deliberately a method and not `+`: `vouched + 'more'` produces a
   * plain string, which `record()` then scrubs whole and redacts. That
   * failure is safe — the guard counter rises and the run goes red —
   * but it is still a broken report, so the long sentences in this file
   * are built with this instead.
   */
  plus(literal) { return new Vouched(this.text + literal, this.guard); }

  /**
   * Append a MEASURED value, scrubbed on the way in.
   *
   * The distinction from `plus` is the whole point of this pair, and it
   * was learned the hard way: the first cut of `ratioLine` took its unit
   * (`'% of entries untagged'`) as a parameter and interpolated it with
   * `${unit}`. A substitution is treated as data, so the guard replaced
   * every unit in the report and the run went red with 14 redactions —
   * correctly. A literal that travels as an argument is still a literal,
   * but only if it arrives through `plus`; anything arriving through a
   * substitution or through here is treated as coming from the memory.
   */
  val(value) {
    const v = this.guard.scrub(value);
    return new Vouched(this.text + (v === null ? 'not measured' : String(v)), this.guard);
  }

  toString() { return this.text; }
}

/** Tagged template: literals pass, every substitution is scrubbed. */
function vouch(guard) {
  return (strings, ...values) => {
    let out = strings[0];
    for (let i = 0; i < values.length; i += 1) {
      const v = guard.scrub(values[i]);
      out += (v === null ? 'not measured' : String(v)) + strings[i + 1];
    }
    return new Vouched(out, guard);
  };
}

// --- small helpers -----------------------------------------------------

function round(v, d = 2) {
  return (v === null || v === undefined || !Number.isFinite(v)) ? null : +v.toFixed(d);
}

/** Bytes free at `dir`, or null if `df` could not be read. */
function freeBytesAt(dir) {
  try {
    const out = execFileSync('df', ['-Pk', dir], { encoding: 'utf8' });
    const last = out.trim().split('\n').pop();
    const kb = Number(last.trim().split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/** Total on-disk size of `root`'s top-level entries, `exclude` skipped. */
function topLevelBytes(root, exclude) {
  let total = 0;
  for (const name of fs.readdirSync(root)) {
    if (exclude.has(name)) continue;
    total += dirBytes(path.join(root, name));
  }
  return total;
}

/** Copy every top-level entry of `srcRoot` except `exclude` into `destRoot`. */
function copyMemory(srcRoot, destRoot, exclude) {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const name of fs.readdirSync(srcRoot)) {
    if (exclude.has(name)) continue;
    fs.cpSync(path.join(srcRoot, name), path.join(destRoot, name), { recursive: true });
  }
}

/** Every `*.jsonl` path under `root/global` and `root/projekte/*`. */
function drawerFiles(root) {
  const files = [];
  const globalDir = path.join(root, 'global');
  if (fs.existsSync(globalDir)) {
    for (const f of fs.readdirSync(globalDir)) {
      if (f.endsWith('.jsonl')) files.push(path.join(globalDir, f));
    }
  }
  const projectsDir = path.join(root, 'projekte');
  if (fs.existsSync(projectsDir)) {
    for (const name of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, name);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
      }
    }
  }
  return files;
}

/**
 * How many words over three letters this entry carries across the
 * fields search ranks on — lucky-mem's own `auffindbareWorte()`
 * (src/doktor.mjs), read here rather than imported.
 */
function weightedWordCount(entry) {
  const parts = [];
  for (const f of WEIGHTED_FIELDS) {
    const v = entry?.[f];
    if (!v) continue;
    parts.push(Array.isArray(v) ? v.join(' ') : String(v));
  }
  return parts.join(' ').split(/[\s,;]+/).filter((w) => w.length > 3).length;
}

/**
 * Read every drawer file once and reduce it to shape only: counts,
 * byte sizes, word counts, tag counts, timestamps. Nothing this
 * function returns is a string that came out of an entry.
 */
function analyzeCorpus(root) {
  const perBasename = new Map();
  const sizesBytes = [];
  const tagCounts = [];
  const timestamps = [];
  const wordCounts = [];
  let totalLines = 0;
  let brokenLines = 0;
  let largestLineBytes = 0;
  let linesOver10KB = 0;

  for (const file of drawerFiles(root)) {
    const base = path.basename(file);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      totalLines += 1;
      const bytes = Buffer.byteLength(line);
      sizesBytes.push(bytes);
      if (bytes > largestLineBytes) largestLineBytes = bytes;
      if (bytes > LARGE_LINE_BYTES) linesOver10KB += 1;
      let entry;
      try { entry = JSON.parse(line); } catch { brokenLines += 1; continue; }
      perBasename.set(base, (perBasename.get(base) ?? 0) + 1);
      const tags = Array.isArray(entry.tags) ? entry.tags : [];
      tagCounts.push(tags.length);
      wordCounts.push(weightedWordCount(entry));
      const t = Date.parse(entry.ts);
      if (Number.isFinite(t)) timestamps.push(t);
    }
  }

  const validEntries = totalLines - brokenLines;
  const ranked = [...perBasename.values()].sort((a, b) => b - a);
  const rankShares = ranked.map((n) => (validEntries ? round((n / validEntries) * 100, 2) : null));

  const sortedSizes = [...sizesBytes].sort((a, b) => a - b);
  const sortedTags = [...tagCounts].sort((a, b) => a - b);
  const now = Date.now();
  const recencyShares = RECENCY_WINDOWS_DAYS.map((days) => {
    if (!timestamps.length) return null;
    const within = timestamps.filter((t) => (now - t) <= days * 86400000).length;
    return round((within / timestamps.length) * 100, 2);
  });
  const spanDays = timestamps.length >= 2
    ? round((Math.max(...timestamps) - Math.min(...timestamps)) / 86400000, 1)
    : null;
  const findable = wordCounts.filter((n) => n >= FINDABLE_MIN_WORDS).length;

  return {
    totalLines,
    brokenLines,
    validEntries,
    fileCount: perBasename.size,
    rankShares,
    sizeP50: pct(sortedSizes, 50),
    sizeP90: pct(sortedSizes, 90),
    sizeP99: pct(sortedSizes, 99),
    sizeMax: sortedSizes[sortedSizes.length - 1] ?? null,
    largestLineBytes,
    linesOver10KB,
    findablePercent: validEntries ? round((findable / validEntries) * 100, 2) : null,
    unfindablePercent: validEntries ? round(100 - (findable / validEntries) * 100, 2) : null,
    recencyShares,
    spanDays,
    tagP50: pct(sortedTags, 50),
    tagP99: pct(sortedTags, 99),
    zeroTagPercent: tagCounts.length
      ? round((tagCounts.filter((n) => n === 0).length / tagCounts.length) * 100, 2) : null,
  };
}

/**
 * The `topN` most frequent words (over three letters) across every
 * weighted field in the corpus at `root`.
 *
 * **These strings never reach `record()`.** They exist only to be
 * handed to `mem finde` as CLI arguments a few lines below, and this
 * function's return value is discarded the moment the timing is taken.
 * If a future edit ever threads one of these into an `evidence` or
 * `measured` field, the guard above will redact it and this phase's own
 * final check will fail — that failure is the backstop, not the plan.
 */
function frequentTokens(root, topN) {
  const freq = new Map();
  for (const file of drawerFiles(root)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      for (const f of WEIGHTED_FIELDS) {
        const v = entry?.[f];
        if (!v) continue;
        const text = Array.isArray(v) ? v.join(' ') : String(v);
        for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
          if (tok.length < 4) continue;
          freq.set(tok, (freq.get(tok) ?? 0) + 1);
        }
      }
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([tok]) => tok);
}

/** max(a,b)/min(a,b), with 0-vs-0 treated as no bias and 0-vs-x as total. */
function biasRatio(a, b) {
  if (a === null || b === null) return null;
  if (a === 0 && b === 0) return 1;
  if (a === 0 || b === 0) return Infinity;
  return Math.max(a, b) / Math.min(a, b);
}


function biasVerdict(ratio) {
  if (ratio === null) return VERDICT.NOT_MEASURED;
  if (ratio > BIAS_FAIL_RATIO) return VERDICT.FAIL;
  if (ratio > BIAS_DEGRADED_RATIO) return VERDICT.DEGRADED;
  return VERDICT.PASS;
}

function timeVerdict(ms, degradedAt, failAt) {
  if (ms === null || ms === undefined) return VERDICT.NOT_MEASURED;
  if (ms > failAt) return VERDICT.FAIL;
  if (ms > degradedAt) return VERDICT.DEGRADED;
  return VERDICT.PASS;
}

// The measurements this phase intends to take, named once so the
// "lucky-mem is absent" branch and the "everything ran" branch report
// the same set of ids under the same titles.
const INTENDED = [
  ['real.shape.scale', 'total entries and lines read from the real drawers'],
  ['real.shape.type-concentration', 'how concentrated real entry types are, against the generated corpus'],
  ['real.shape.entry-size', 'entry size in bytes, against the generated corpus'],
  ['real.shape.large-lines', 'the long tail of oversized lines, against the generated corpus'],
  ['real.shape.reachability', 'the share of entries too thin to ever be found, against the generated corpus'],
  ['real.shape.recency', 'how recent the corpus is, against the generated corpus'],
  ['real.shape.tags', 'how many entries carry no tags, against the generated corpus'],
  ['real.shape.broken-lines', 'unparsable lines, against the generated corpus'],
  ['real.cli.disk-budget', 'whether a safe copy of the real memory fits this container'],
  ['real.cli.index-build', 'cold index build time against the real corpus'],
  ['real.cli.index-size', 'index cache size on disk against the real corpus'],
  ['real.cli.finde-latency', 'mem finde wall time against the real corpus'],
  ['real.cli.doctor-time', 'mem doktor wall time against the real corpus'],
  ['real.cli.doctor-findings', 'mem doktor finding counts against the real corpus'],
  ['real.cli.kontext', 'mem kontext wall time and output size against the real corpus'],
];

// --- the phase -----------------------------------------------------

export async function run(atlas, { quick = false } = {}) {
  atlas.phase('real', 'The same measurements against a real, grown memory',
    [
      'Every other phase measures cheap-mem against a corpus this atlas',
      'generated. This phase measures lucky-mem — a real German-language',
      'memory grown by daily use — against the same shape of questions,',
      'and against a synthetic corpus of similar size, so the gap between',
      '"generated" and "grown" gets a number instead of an assumption.',
      '',
      'No entry text, title, id, tag value or in-tree path from that',
      'memory appears anywhere below. Every value this phase records',
      'passes through a content guard first; the guard\'s own redaction',
      'count is the last check in this phase, and zero is the only value',
      'that means this phase behaved.',
    ].join('\n'));

  const guard = new Guard();

  /** This phase's only path to `atlas.record()` — see the guard above. */
  // A `Vouched` value was built by `say` from literals in this file with
  // its substitutions already scrubbed, so it passes through. Anything
  // else is treated as possibly carrying data and scrubbed whole — which
  // is what catches a sentence somebody later builds with a plain
  // backtick instead of `say`.
  const pass = (v) => (v instanceof Vouched ? v.text : guard.scrub(v ?? null));
  const record = (fields) => atlas.record({
    ...fields,
    expected: pass(fields.expected),
    actual: pass(fields.actual),
    evidence: pass(fields.evidence),
    measured: pass(fields.measured),
  });
  const say = vouch(guard);

  /**
   * The stated expectation every real-against-generated comparison holds
   * itself to, in words rather than as a bare pair of thresholds.
   *
   * The first cut passed `[BIAS_DEGRADED_RATIO, BIAS_FAIL_RATIO]` through
   * the guard, which printed `1.5,3` — technically the thresholds, and
   * unreadable. The numbers are the same; what changed is that the
   * sentence around them is a literal in this file, so it costs the guard
   * nothing to let it through.
   */
  const withinFactor = (what) => say`real and generated within ${BIAS_DEGRADED_RATIO}x of each other on `
    .plus(what)
    .plus(` (over ${BIAS_FAIL_RATIO}x is a bias the rest of this atlas inherits)`);

  /**
   * One comparison, in words, with the two measured values named.
   *
   * `Infinity` — one side exactly zero — used to print as the sentinel
   * 999, a number that looks like a measurement and is not one. It is
   * said instead, because "the generated corpus has none of these at
   * all" is the actual finding and a ratio cannot express it.
   */
  const ratioLine = (realV, synthV, unit, ratio) => {
    if (ratio === null) return say`not measured on one side or the other`;
    // `unit` goes through `plus`, not through a substitution: it is a
    // literal this file passes as an argument, and the difference
    // between the two is what the guard is for.
    const head = say`real ${realV}`.plus(unit).plus(', generated ').val(synthV).plus(unit);
    if (ratio === Infinity) {
      return head.plus(' — one side is exactly zero, so there is no factor to state: '
        + 'the generated corpus does not produce this at all');
    }
    return head.plus(' — a factor of ').val(round(ratio, 2));
  };


  // === sabotage-verify the guard, before anything else ==================
  //
  // A guard nobody tested is a guard that reports clean. The positive
  // control is made up right here — not read from lucky-mem — precisely
  // so this test never depends on the memory this phase is about to
  // protect.
  const fakeMemoryEntry = '{"id":"fake0000","ts":"2020-01-01T00:00:00Z",'
    + '"titel":"Der Testeintrag wurde absichtlich erfunden",'
    + '"text":"Dies ist kein echter Eintrag aus lucky-mem"}';
  const fakeEntryTest = new Guard();
  fakeEntryTest.scrub(fakeMemoryEntry);
  record({
    id: 'real.guard.positive-control',
    title: 'the guard redacts a synthetic string shaped like a memory entry (made up here, not read from lucky-mem)',
    verdict: fakeEntryTest.redactions > 0 ? VERDICT.PASS : VERDICT.FAIL,
    expected: say`the guard replaces it`,
    actual: say`${fakeEntryTest.redactions} value(s) replaced`,
    severity: fakeEntryTest.redactions > 0 ? null : SEVERITY.CRITICAL,
  });

  const numberTest = new Guard();
  const numberBack = numberTest.scrub(42);
  record({
    id: 'real.guard.negative-control',
    title: 'the guard leaves a plain number unchanged',
    verdict: (numberBack === 42 && numberTest.redactions === 0) ? VERDICT.PASS : VERDICT.FAIL,
    expected: say`42 comes back as 42`,
    actual: say`${numberBack} came back, ${numberTest.redactions} replacement(s)`,
    severity: (numberBack === 42 && numberTest.redactions === 0) ? null : SEVERITY.CRITICAL,
  });

  // === is there a sister house to measure at all? ========================

  const present = fs.existsSync(LUCKY_MEM_ROOT) && fs.existsSync(LUCKY_MEM_BIN);

  if (!present) {
    for (const [id, title] of INTENDED) {
      record({
        id, title, verdict: VERDICT.NOT_MEASURED, expected: null, actual: null,
      });
      atlas.blind(title, 'lucky-mem is not present at the expected path in this environment');
    }
    record({
      id: 'real.guard.redactions',
      title: 'the content guard caught zero attempts to leak memory content',
      verdict: guard.redactions === 0 ? VERDICT.PASS : VERDICT.FAIL,
      expected: 0,
      actual: guard.redactions,
      severity: guard.redactions === 0 ? null : SEVERITY.CRITICAL,
    });
    atlas.blind('retrieval quality on lucky-mem',
      'lucky-mem was not present; quality needs a human-labelled answer key in any case, '
      + 'and inventing one from the entries would mean reading them');
    return;
  }

  // === section A — corpus shape, read directly, no CLI, no risk =========

  const real = analyzeCorpus(LUCKY_MEM_ROOT);

  record({
    id: 'real.shape.scale',
    title: 'total entries and lines read from the real drawers',
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: say`${real.validEntries} entries across ${real.fileCount} drawer files `
      .plus(`(${real.totalLines} lines in total)`),
    measured: {
      validEntries: real.validEntries,
      totalLines: real.totalLines,
      brokenLines: real.brokenLines,
      drawerFileCount: real.fileCount,
    },
  });

  // A synthetic corpus of comparable size, built the same way every
  // other phase builds one — same generator, same seed, so this
  // comparison is against what the REST of this atlas actually measures
  // against, not a strawman.
  const syntheticRoot = tempRoot('atlas-real-synthetic-');
  buildCorpus(syntheticRoot, Math.max(real.validEntries, 1), { seed: 42, anchors: 12 });
  const synthetic = analyzeCorpus(syntheticRoot);

  const realMaxShare = real.rankShares[0] ?? null;
  const synthMaxShare = synthetic.rankShares[0] ?? null;
  const typeRatio = biasRatio(realMaxShare, synthMaxShare);
  record({
    id: 'real.shape.type-concentration',
    title: 'the largest entry type holds a bigger share of the real corpus than of a generated one of the same size',
    verdict: biasVerdict(typeRatio),
    expected: withinFactor('the share of entries in the largest type'),
    actual: ratioLine(realMaxShare, synthMaxShare, '% of entries in the largest type', typeRatio),
    severity: SEVERITY.INFO,
    measured: {
      realTopRankSharesPercent: real.rankShares.slice(0, 5),
      syntheticTopRankSharesPercent: synthetic.rankShares.slice(0, 5),
      realTypeCount: real.fileCount,
      syntheticTypeCount: synthetic.fileCount,
    },
  });

  const sizeRatio = biasRatio(real.sizeP50, synthetic.sizeP50);
  record({
    id: 'real.shape.entry-size',
    title: 'real entries are a different size than a generated corpus of the same count',
    verdict: biasVerdict(sizeRatio),
    expected: withinFactor('the median entry size'),
    actual: ratioLine(real.sizeP50, synthetic.sizeP50, ' B at p50', sizeRatio),
    severity: SEVERITY.INFO,
    measured: {
      realSizeBytes: {
        p50: real.sizeP50, p90: real.sizeP90, p99: real.sizeP99, max: real.sizeMax,
      },
      syntheticSizeBytes: {
        p50: synthetic.sizeP50, p90: synthetic.sizeP90, p99: synthetic.sizeP99, max: synthetic.sizeMax,
      },
    },
  });

  const largeLineRatio = biasRatio(
    real.totalLines ? (real.linesOver10KB / real.totalLines) * 100 : 0,
    synthetic.totalLines ? (synthetic.linesOver10KB / synthetic.totalLines) * 100 : 0,
  );
  record({
    id: 'real.shape.large-lines',
    title: 'the generated corpus has no lines anywhere near the real long tail',
    verdict: biasVerdict(largeLineRatio),
    expected: withinFactor('the share of oversized lines'),
    actual: ratioLine(real.linesOver10KB, synthetic.linesOver10KB,
      ' lines over the size threshold', largeLineRatio),
    severity: SEVERITY.INFO,
    measured: {
      realLargestLineBytes: real.largestLineBytes,
      realLinesOver10KB: real.linesOver10KB,
      syntheticLargestLineBytes: synthetic.largestLineBytes,
      syntheticLinesOver10KB: synthetic.linesOver10KB,
      thresholdBytes: LARGE_LINE_BYTES,
    },
  });

  const reachRatio = biasRatio(real.unfindablePercent, synthetic.unfindablePercent);
  record({
    id: 'real.shape.reachability',
    title: 'the share of entries too thin to ever be found differs between real and generated corpora',
    verdict: biasVerdict(reachRatio),
    expected: withinFactor('the share of entries too thin to be found'),
    actual: ratioLine(real.unfindablePercent, synthetic.unfindablePercent,
      '% of entries unreachable by search', reachRatio),
    severity: SEVERITY.INFO,
    measured: {
      realFindablePercent: real.findablePercent,
      realUnfindablePercent: real.unfindablePercent,
      syntheticFindablePercent: synthetic.findablePercent,
      syntheticUnfindablePercent: synthetic.unfindablePercent,
      minWordsToBeFindable: FINDABLE_MIN_WORDS,
    },
  });

  const recencyRatio = biasRatio(real.recencyShares[1], synthetic.recencyShares[1]);
  record({
    id: 'real.shape.recency',
    title: 'how much of the corpus is recent differs between real and generated data',
    verdict: biasVerdict(recencyRatio),
    expected: withinFactor('the share of entries inside the middle recency window'),
    actual: ratioLine(real.recencyShares[1], synthetic.recencyShares[1],
      '% of entries in that window', recencyRatio),
    severity: SEVERITY.INFO,
    measured: {
      recencyWindowsDays: RECENCY_WINDOWS_DAYS,
      realRecentSharesPercent: real.recencyShares,
      syntheticRecentSharesPercent: synthetic.recencyShares,
      realSpanDays: real.spanDays,
      syntheticSpanDays: synthetic.spanDays,
    },
  });

  const tagRatio = biasRatio(real.zeroTagPercent, synthetic.zeroTagPercent);
  record({
    id: 'real.shape.tags',
    title: 'the share of untagged entries differs between real and generated data',
    verdict: biasVerdict(tagRatio),
    expected: withinFactor('the share of entries carrying no tags'),
    actual: ratioLine(real.zeroTagPercent, synthetic.zeroTagPercent,
      '% of entries untagged', tagRatio),
    severity: SEVERITY.INFO,
    measured: {
      realZeroTagPercent: real.zeroTagPercent,
      realTagCount: { p50: real.tagP50, p99: real.tagP99 },
      syntheticZeroTagPercent: synthetic.zeroTagPercent,
      syntheticTagCount: { p50: synthetic.tagP50, p99: synthetic.tagP99 },
    },
  });

  const realBrokenPercent = real.totalLines ? round((real.brokenLines / real.totalLines) * 100, 3) : 0;
  const synthBrokenPercent = synthetic.totalLines
    ? round((synthetic.brokenLines / synthetic.totalLines) * 100, 3) : 0;
  const brokenRatio = biasRatio(realBrokenPercent, synthBrokenPercent);
  record({
    id: 'real.shape.broken-lines',
    title: 'unparsable lines, real against generated',
    verdict: biasVerdict(brokenRatio),
    expected: withinFactor('the share of unparsable lines'),
    actual: ratioLine(realBrokenPercent, synthBrokenPercent,
      '% of lines unparsable', brokenRatio),
    severity: SEVERITY.INFO,
    measured: {
      realBrokenLines: real.brokenLines,
      realBrokenPercent,
      syntheticBrokenLines: synthetic.brokenLines,
      synthBrokenPercent,
    },
  });

  // === section B — the CLI, against a scratch copy only =================

  const copyBytes = topLevelBytes(LUCKY_MEM_ROOT, COPY_EXCLUDE_TOP);
  const scratchParent = tempRoot('atlas-real-copy-parent-');
  const free = freeBytesAt(scratchParent);
  const fits = free !== null && free > copyBytes * DISK_SAFETY_FACTOR;

  record({
    id: 'real.cli.disk-budget',
    title: 'a safe, excluded-state copy of the real memory fits this container\'s disk budget',
    verdict: fits ? VERDICT.PASS : VERDICT.DEGRADED,
    expected: say`a copy of the excluded-state memory plus ${DISK_SAFETY_FACTOR}x headroom fits the free disk`,
    actual: say`the copy needs ${round(copyBytes / 1048576, 1)} MB, `
      .plus(`${free === null ? 'and free space could not be read' : `${round(free / 1048576, 1)} MB free`}`),
    severity: fits ? null : SEVERITY.MAJOR,
    measured: {
      copyBytes, freeBytes: free, safetyFactor: DISK_SAFETY_FACTOR,
    },
  });

  if (!fits) {
    for (const [id, title] of INTENDED) {
      if (id === 'real.cli.disk-budget') continue;
      if (!id.startsWith('real.cli.')) continue;
      record({
        id, title, verdict: VERDICT.NOT_MEASURED, expected: null, actual: null,
      });
      atlas.blind(title, 'the scratch copy of lucky-mem would not fit this container\'s free disk space');
    }
  } else {
    const copyRoot = path.join(scratchParent, 'copy');
    copyMemory(LUCKY_MEM_ROOT, copyRoot, COPY_EXCLUDE_TOP);
    const copyBin = path.join(copyRoot, 'bin', 'mem');
    const runMem = (args, timeoutMs = 120000) => mem(args, {
      root: copyRoot, bin: copyBin, rootVar: LUCKY_MEM_ROOT_VAR, timeoutMs,
    });

    const queryCount = quick ? 4 : 8;
    // Discarded the instant it is used — see the doc comment on
    // `frequentTokens()`. Never assigned to anything this phase records.
    const queries = frequentTokens(LUCKY_MEM_ROOT, queryCount);

    // --- cold index build, via the first query ---------------------
    const pipelineDir = path.join(copyRoot, '.pipeline');
    const indexPath = path.join(pipelineDir, 'suchindex.json');
    const buildQuery = queries.length ? queries[0] : 'warmup';
    const cold = runMem(['finde', buildQuery, '--json', '--top', '5']);
    const indexBytes = fs.existsSync(indexPath) ? fs.statSync(indexPath).size : null;
    const pipelineBytes = fs.existsSync(pipelineDir) ? dirBytes(pipelineDir) : null;

    record({
      id: 'real.cli.index-build',
      title: 'cold search index build time against the real corpus',
      verdict: timeVerdict(cold.ms, BUILD_DEGRADED_MS, BUILD_FAIL_MS),
      expected: say`under ${BUILD_DEGRADED_MS} ms (over ${BUILD_FAIL_MS} ms means hung, not slow)`,
      actual: say`${cold.ms} ms to build the index over ${real.validEntries} real entries`,
      severity: SEVERITY.MINOR,
      ms: cold.ms,
      evidence: say`measured against a scratch copy, never the original`,
      measured: {
        buildMs: cold.ms, entries: real.validEntries, exitStatus: cold.status,
      },
    });

    record({
      id: 'real.cli.index-size',
      title: 'search index cache size on disk against the real corpus',
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: say`${indexBytes === null ? null : round(indexBytes / 1048576, 2)} MB of index `
        .plus(`for ${real.validEntries} entries`),
      evidence: say`measured against a scratch copy, never the original`,
      measured: { indexBytes, pipelineBytes, entries: real.validEntries },
    });

    // --- warm finde latency, one call per remaining frequent token --
    const warmQueries = queries.slice(1).length ? queries.slice(1) : queries;
    const findeRuns = warmQueries.map((q) => runMem(['finde', q, '--json', '--top', '10']));
    const findeMs = findeRuns.map((r) => r.ms).sort((a, b) => a - b);
    const enough = findeMs.length >= QUERY_PERCENTILE_FLOOR;
    const findeP50 = pct(findeMs, 50);
    const findeP95 = enough ? pct(findeMs, 95) : null;

    record({
      id: 'real.cli.finde-latency',
      title: 'mem finde wall time over several real-vocabulary queries (query text never recorded)',
      verdict: enough ? timeVerdict(findeP95, FINDE_DEGRADED_MS, FINDE_FAIL_MS)
        : timeVerdict(findeP50, FINDE_DEGRADED_MS, FINDE_FAIL_MS),
      expected: say`under ${FINDE_DEGRADED_MS} ms (over ${FINDE_FAIL_MS} ms means hung, not slow)`,
      actual: say`${enough ? findeP95 : findeP50} ms at `
        .plus(`${enough ? 'p95' : 'p50'} over ${findeMs.length} queries`),
      severity: SEVERITY.MINOR,
      evidence: say`measured against a scratch copy; the queries came from the corpus's own `
        .plus('frequent words and were used as CLI arguments only, never recorded'),
      measured: {
        queryCount: findeMs.length,
        percentilesFrom: enough ? findeMs.length : null,
        p50: findeP50,
        p95: findeP95,
        min: findeMs[0] ?? null,
        max: findeMs[findeMs.length - 1] ?? null,
      },
    });
    if (!enough) {
      atlas.blind('finde p95 on the real corpus',
        `fewer than ${QUERY_PERCENTILE_FLOOR} distinct queries were available from this corpus's own vocabulary`);
    }

    // --- doktor, warm (the index is already built above) ------------
    const doctor = runMem(['doktor', '--json']);
    let doctorCounts = null;
    try {
      const parsed = JSON.parse(doctor.stdout);
      doctorCounts = parsed.zusammenfassung ?? null;
    } catch { /* left null; the timing record below still stands */ }

    record({
      id: 'real.cli.doctor-time',
      title: 'mem doktor wall time against the real corpus',
      verdict: timeVerdict(doctor.ms, DOCTOR_DEGRADED_MS, DOCTOR_FAIL_MS),
      expected: say`under ${DOCTOR_DEGRADED_MS} ms (over ${DOCTOR_FAIL_MS} ms means hung, not slow)`,
      actual: say`${doctor.ms} ms for a full doctor run over ${real.validEntries} real entries`,
      severity: SEVERITY.MINOR,
      ms: doctor.ms,
      evidence: say`measured against a scratch copy, never the original`,
      measured: { doctorMs: doctor.ms, exitStatus: doctor.status },
    });

    record({
      id: 'real.cli.doctor-findings',
      title: 'mem doktor finding counts against the real corpus (counts only, never finding text)',
      // A pure measurement of composition, not a claim about health — see
      // the doc comment on the apparatus's own `record()` for why that
      // is `not-measured` rather than a graded verdict either way.
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: doctorCounts
        ? say`${doctorCounts.gut ?? null} good, ${doctorCounts.warnung ?? null} warning, `
          .plus(`${doctorCounts.fehler ?? null} error, ${doctorCounts.unbekannt ?? null} unknown`)
        : null,
      evidence: say`counts only — a finding's text is the memory's own words and stays there`,
      measured: doctorCounts ? {
        good: doctorCounts.gut ?? null,
        warning: doctorCounts.warnung ?? null,
        error: doctorCounts.fehler ?? null,
        unknown: doctorCounts.unbekannt ?? null,
      } : null,
    });
    if (!doctorCounts) {
      atlas.blind('doktor finding counts on the real corpus', 'doktor --json output on the copy did not parse');
    }

    // --- kontext ------------------------------------------------------
    const kontext = runMem(['kontext']);
    record({
      id: 'real.cli.kontext',
      title: 'mem kontext wall time and output size against the real corpus',
      verdict: timeVerdict(kontext.ms, KONTEXT_DEGRADED_MS, KONTEXT_FAIL_MS),
      expected: say`under ${KONTEXT_DEGRADED_MS} ms (over ${KONTEXT_FAIL_MS} ms means hung, not slow)`,
      actual: say`${kontext.ms} ms, ${kontext.bytes} bytes of session context`,
      severity: SEVERITY.MINOR,
      ms: kontext.ms,
      evidence: say`measured against a scratch copy, never the original`,
      measured: { kontextMs: kontext.ms, outputBytes: kontext.bytes, exitStatus: kontext.status },
    });

    atlas.blind('doktor findings\' fidelity to the live memory',
      'the copy excludes .pipeline, .git and node_modules, so findings that depend on that '
      + 'runtime state (relay backlog, git cleanliness, hook registration) reflect the copy, '
      + 'not necessarily the memory as it stands right now');
  }

  // === section C — named, not faked ======================================

  record({
    id: 'real.guard.redactions',
    title: 'the content guard caught zero attempts to leak memory content',
    verdict: guard.redactions === 0 ? VERDICT.PASS : VERDICT.FAIL,
    expected: say`0 values replaced`,
    actual: say`${guard.redactions} values replaced by the guard`,
    severity: guard.redactions === 0 ? null : SEVERITY.CRITICAL,
  });

  atlas.blind('retrieval quality on lucky-mem',
    'whether `finde` returns the RIGHT entry cannot be measured without a human-labelled '
    + 'answer key, and building one from the entries would mean reading their content — '
    + 'which this phase exists specifically not to do. No quality number is reported here '
    + 'in its place.');
}
