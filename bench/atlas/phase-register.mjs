// bench/atlas/phase-register.mjs — the REGISTER prototype, turned into a
// repeatable measurement.
//
// **What this phase is for.** The JSON index cache has a hard wall:
// `ceiling.c.wall1` computes it at ~548.7 B/entry against V8's
// `MAX_STRING_LENGTH`, which stops the whole cache from parsing at
// 978,395 entries — not a slow decline, a cliff. The proposed
// replacement is a REGISTER: one derived row per entry, queried on disk
// (sqlite + FTS5) instead of loaded whole into the process. A one-off
// prototype was measured on 2026-09-20 (Node 22.22, 1,000,000 rows,
// 180.8 MB on disk): rare (0.02%) 1.40 ms p50, medium (0.22%) 8.96 ms,
// frequent (25.8%) 294 ms, no-match 0.06 ms — against `find`'s p50 of
// 2,801 ms at 150,008 entries today, paid as a FIXED cost before any
// ranking even starts. This phase is that measurement, made repeatable.
//
// **The law, and the mistake that had to not be repeated.** The claim is
// that latency tracks the number of ROWS MATCHED, not the size of the
// corpus. The first attempt at measuring this got it backwards: it built
// short rows from a 42-word vocabulary, so with 8-16 words per row
// practically every row contained every word — a "rare" query matched
// nearly the whole corpus, bm25 had to rank a million rows regardless of
// which word was typed, and the fitted exponent (1.05, 452 ms at 1M) was
// honestly computed and answered the wrong question: a corpus whose
// vocabulary dictates the answer measures itself. The fix is a
// Zipf-distributed vocabulary of 20,000 terms, generated fresh here (not
// `buildCorpus` in ./core.mjs, whose ~34-word COMMON list plus 6-16
// words/row is exactly that same shape) — and measuring selectivity
// ALONGSIDE every timing, never separately, never assumed.
//
// **Every latency record below carries its matched-row count.** That is
// this phase's own defining rule, enforced by `withSelectivity()`: a
// caller that tries to write a latency record without `matched` and
// `selectivity` gets an exception, not a silently incomplete record. A
// latency without the quantity it depends on is unreadable and this
// phase refuses to produce one.
//
// **Ground truth has exactly one source.** The document-frequency count
// used for every "matched" figure is the one computed while the corpus
// was generated — the same rows are then inserted into the register
// verbatim, so that count is also what the register should return. A
// second, independently-computed count (a live `COUNT(*) MATCH`) is
// taken once per rung, but only as a CORRECTNESS check against the first
// number, never as an alternative source that a report could quote
// instead — this house keeps no second source of truth.
//
// **This is a BENCHMARK of a candidate design.** It builds its own sqlite
// file under a temp root and its own throwaway cheap-mem corpus; it does
// not touch, read the shape of, or change anything this repo ships.
//
// **`node:sqlite` may not be here at all.** It needs Node >= 22 and ships
// as an experimental module. When it — or specifically FTS5 support
// inside it — is not available, this phase records exactly one thing:
// `not-measured`, with the reason, as a real record and a named blind
// spot. Never a pass, and never a silent skip of the whole phase.

import fs from 'node:fs';
import path from 'node:path';
import {
  VERDICT, SEVERITY, mem, tempRoot, pct, timeIt, rng,
} from './core.mjs';

// --- thresholds, in the open --------------------------------------------

/** Terms in the synthetic vocabulary. 20,000, per the fix this phase exists to hold. */
const VOCAB_SIZE = 20000;
/** Classic Zipf exponent: term i's raw weight is 1/i. */
const ZIPF_EXPONENT = 1.0;
/** Row length range, in words — shaped like a real memory entry, not a slogan. */
const ROW_MIN_WORDS = 10;
const ROW_MAX_WORDS = 24;
/** The three selectivity bands, chosen to land near the prototype's own table. */
const SELECTIVITY_TARGETS = { rare: 0.0002, medium: 0.0022, frequent: 0.258 };
/** A term this vocabulary never emits — the empty-query / no-match control. */
const NO_MATCH_TERM = 'zqnomatchoutsidevocab99';
/** Held near-constant across the ladder, to test the law directly: does the
 * SAME number of matched rows cost the same regardless of corpus size? */
const FIXED_MATCHED_TARGET = 10;

/** A vocabulary is degenerate if "rare" isn't actually rare. Named ceiling. */
const DEGENERATE_RARE_CEILING = 0.05; // 5% of the corpus
/** ...and if "frequent" isn't actually much more common than "rare". */
const DEGENERATE_SPREAD_MIN = 20; // frequent must be >= 20x rare's selectivity

/** Power-law fit floor: fewer points than this is a line through noise. */
const MIN_POINTS_FOR_FIT = 4;
/** Growth exponent b in `latency = a * matched^b`. b=1 is the law holding exactly. */
const LAW_EXP_PASS = [0.6, 1.4];
const LAW_EXP_DEGRADED = [0.2, 2.2];

/** How much the register's p50 may drift across corpus sizes at a fixed
 * matched-row count before the "tracks rows, not corpus" claim is doubted. */
const FIXED_COUNT_RATIO_PASS = 4;
const FIXED_COUNT_RATIO_DEGRADED = 10;

function round(v, d = 3) {
  return (v === null || v === undefined || !Number.isFinite(v)) ? null : +v.toFixed(d);
}

// --- the ladder ----------------------------------------------------------
//
// Modest on purpose: this phase runs inside the full atlas, which already
// has a time budget, and every rung here pays for a corpus generation, a
// register build and a clutch of real `mem find` child processes. The
// prototype's 1,000,000-row measurement is the point of comparison, not
// reproduced here — that gap is a named blind spot, not a silent one.

function ladder(quick) {
  return quick ? [300, 1200] : [2000, 10000, 40000];
}

// --- vocabulary and corpus generation -------------------------------------

/** Cumulative Zipf weights over VOCAB_SIZE ranks, rank 0 = most frequent. */
function buildZipfTable(size = VOCAB_SIZE, exponent = ZIPF_EXPONENT) {
  const cum = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    sum += 1 / ((i + 1) ** exponent);
    cum[i] = sum;
  }
  return { cum, total: sum };
}

/** One sample from the Zipf table, as a rank index, via binary search. */
function sampleRank(table, r) {
  const target = r() * table.total;
  let lo = 0; let hi = table.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.cum[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function termOf(rank) { return `zt${rank}`; }

/**
 * Build a synthetic corpus of `count` rows whose vocabulary is genuinely
 * Zipf-distributed over 20,000 terms, and return the DOCUMENT FREQUENCY
 * (rows containing the term at least once) of every term that appears —
 * the ground truth every selectivity figure in this phase is drawn from.
 *
 * Deliberately not `buildCorpus` from ./core.mjs: that generator's
 * ~34-word COMMON vocabulary, at 6-16 words per row, is the exact shape
 * of the first attempt's mistake (see this file's header comment). This
 * one is built fresh, at the scale the fix requires.
 */
export function buildZipfCorpus(count, seed) {
  const table = buildZipfTable();
  const r = rng(seed);
  const rows = [];
  const df = new Map();
  for (let i = 0; i < count; i += 1) {
    const len = ROW_MIN_WORDS + Math.floor(r() * (ROW_MAX_WORDS - ROW_MIN_WORDS + 1));
    const seen = new Set();
    const words = [];
    for (let w = 0; w < len; w += 1) {
      const term = termOf(sampleRank(table, r));
      words.push(term);
      seen.add(term);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    rows.push({ id: i, text: words.join(' ') });
  }
  return { rows, df, count };
}

/** The vocabulary term whose measured selectivity is closest to `target`. */
function nearestBySelectivity(df, count, target) {
  let best = null; let bestDiff = Infinity;
  for (const [term, d] of df) {
    const diff = Math.abs(d / count - target);
    if (diff < bestDiff) { bestDiff = diff; best = { term, matched: d, selectivity: d / count }; }
  }
  return best;
}

/** The vocabulary term whose measured DOCUMENT COUNT is closest to `target`. */
function nearestByCount(df, count, target) {
  let best = null; let bestDiff = Infinity;
  for (const [term, d] of df) {
    const diff = Math.abs(d - target);
    if (diff < bestDiff) { bestDiff = diff; best = { term, matched: d, selectivity: d / count }; }
  }
  return best;
}

/** The four selectivity bands this phase measures at every rung. */
export function pickBands(df, count) {
  return {
    rare: nearestBySelectivity(df, count, SELECTIVITY_TARGETS.rare),
    medium: nearestBySelectivity(df, count, SELECTIVITY_TARGETS.medium),
    frequent: nearestBySelectivity(df, count, SELECTIVITY_TARGETS.frequent),
    noMatch: { term: NO_MATCH_TERM, matched: 0, selectivity: 0 },
  };
}

// --- the selectivity rule, enforced ---------------------------------------
//
// This phase's own defining rule: no latency record without the
// matched-row count and selectivity it depends on. Not a convention
// followed by hand at each call site — a function every latency record's
// `measured` block is built through, so forgetting the field is a thrown
// error during the run, not a quietly incomplete record.

/**
 * The one latency in this phase that does NOT depend on a matched-row
 * count, declared by id rather than waved through by shape.
 *
 * `register.today.floor.<n>` times a `mem` invocation that never
 * searches. Giving it `matched: 0, selectivity: 0` would let it satisfy
 * the rule below while stating something false — it is not a query that
 * found nothing, it is not a query. So the exemption is written down,
 * with the reason attached, and the scanning test reads THIS list
 * instead of carrying a second copy of the judgement.
 *
 * Anything else that wants in has to be argued for here, in public, in
 * a diff.
 */
export const LATENCY_WITHOUT_SELECTIVITY = Object.freeze({
  'register.today.floor': 'process startup and module load, measured with a command that '
    + 'never opens a drawer — it has no matched-row count because it asks no question, and '
    + 'claiming zero matches would be a false statement rather than a missing one',
});

/** Whether `id` names the one latency allowed to carry no selectivity. */
export function latencyNeedsSelectivity(id) {
  return !Object.keys(LATENCY_WITHOUT_SELECTIVITY).some((prefix) => id.startsWith(`${prefix}.`));
}

export function withSelectivity({ matched, selectivity, ...rest }) {
  if (matched === null || matched === undefined || selectivity === null || selectivity === undefined) {
    throw new Error(
      'refusing to record a latency without its matched-row count and selectivity '
      + '(bench/atlas/phase-register.mjs withSelectivity) — a latency without the '
      + 'quantity it depends on is unreadable',
    );
  }
  return { matched, selectivity: round(selectivity, 6), ...rest };
}

// --- node:sqlite availability ---------------------------------------------

/**
 * Load `node:sqlite` and confirm FTS5 actually works, not just that the
 * module imports. `CHEAP_MEM_ATLAS_FORCE_NO_SQLITE=1` simulates absence
 * for the test suite, without needing a different Node binary to prove
 * the not-measured path is real and not vestigial.
 */
export async function loadSqlite(env = process.env) {
  if (env.CHEAP_MEM_ATLAS_FORCE_NO_SQLITE === '1') {
    throw new Error('forced unavailable via CHEAP_MEM_ATLAS_FORCE_NO_SQLITE=1 (test simulation)');
  }
  const mod = await import('node:sqlite');
  const probe = new mod.DatabaseSync(':memory:');
  try {
    probe.exec('CREATE VIRTUAL TABLE probe USING fts5(x)');
  } finally {
    probe.close();
  }
  return mod;
}

// --- the register itself ---------------------------------------------------

/** Build one sqlite+FTS5 register file from `rows`. Returns build cost and size. */
function buildRegister(mod, dbPath, rows) {
  fs.rmSync(dbPath, { force: true });
  const db = new mod.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE'); // one file, so bytes-on-disk means one number
  db.exec('CREATE VIRTUAL TABLE reg USING fts5(text)');
  const insert = db.prepare('INSERT INTO reg(rowid, text) VALUES (?, ?)');
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  for (const row of rows) insert.run(row.id, row.text);
  db.exec('COMMIT');
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  db.close();
  const bytes = fs.statSync(dbPath).size;
  return { buildMs, bytes };
}

/**
 * Quote a term as an FTS5 query-string phrase literal.
 *
 * A bare MATCH argument is parsed by FTS5's own query mini-language, not
 * just tokenized — a term containing a hyphen (measured here: the
 * no-match control, `zqnomatch-outside-vocabulary`) is silently
 * misparsed as a column filter and throws `no such column`. Quoting
 * treats the term as one literal phrase regardless of its shape, which
 * is what every caller here actually means by "this term".
 */
function ftsPhrase(term) { return `"${String(term).replace(/"/g, '""')}"`; }

/** Live `COUNT(*) MATCH` for one term — the correctness cross-check, never the report's own source. */
function liveCount(mod, dbPath, term) {
  const db = new mod.DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM reg WHERE reg MATCH ?').get(ftsPhrase(term)).c;
  } finally {
    db.close();
  }
}

/** Time a realistic top-K ranked register query, in process. */
function timeRegisterQuery(mod, dbPath, term, { n = 25, warmup = 5, top = 20 } = {}) {
  const db = new mod.DatabaseSync(dbPath, { readOnly: true });
  const stmt = db.prepare('SELECT rowid FROM reg WHERE reg MATCH ? ORDER BY bm25(reg) LIMIT ?');
  const phrase = ftsPhrase(term);
  const t = timeIt(() => { stmt.all(phrase, top); }, { n, warmup });
  db.close();
  return t;
}

// --- today's path: the same rows, through the real CLI ---------------------

/** Write `rows` as a cheap-mem corpus so `mem find` answers the identical text. */
function writeCheapMemCorpus(root, rows) {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user', 'agent'], language: 'en' }));
  const start = Date.parse('2026-01-01T00:00:00Z');
  const lines = rows.map((row, i) => JSON.stringify({
    id: `g${i.toString(36)}`,
    ts: new Date(start + i * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    title: `register bench row ${i}`,
    text: row.text,
    tags: ['register-bench'],
  }));
  fs.writeFileSync(path.join(root, 'global', 'learnings.jsonl'), `${lines.join('\n')}\n`);
}

function cliRepsFor(n, quick) {
  if (quick) return 3;
  return n >= 20000 ? 3 : 5;
}

/**
 * What one `mem` invocation costs before it has searched anything.
 *
 * **Why this measurement has to exist.** `timeRegisterQuery` times a
 * prepared statement inside THIS process; `timeCliQuery` times a whole
 * child process. Divide one by the other and the quotient contains
 * Node's startup plus this CLI's module graph — a constant that the
 * register does not remove, because a register query issued from the
 * command line would pay it too. Reporting that quotient as "what the
 * register gains" is `falsche-ursache`: a real number attributed to
 * the wrong thing, and the attribution is the part a reader acts on.
 *
 * So the floor is measured and subtracted, and BOTH factors are
 * reported: end-to-end (what a person waits, which the floor is
 * honestly part of) and over the search work alone (what the register
 * is actually responsible for).
 *
 * An unknown command is deliberate, and it works because `bin/mem`
 * imports its whole command graph — `search.mjs` included — at the top
 * of the file. So the probe pays the identical module load and argument
 * parse and stops before a drawer is opened. Its non-zero exit is
 * expected, and the caller checks the process really ran rather than
 * failing to spawn.
 *
 * Measured on this machine 2026-09-20: probe 123.8 ms, `mem find`
 * against an EMPTY root 156.8 ms. The 33 ms between them is search
 * machinery doing near-nothing, which means the probe is a lower bound
 * on the constant and never swallows search time — the search-only
 * factor below is therefore understated rather than flattering.
 */
function timeCliFloor(root, reps) {
  const runs = [];
  let spawned = true;
  for (let i = 0; i < reps; i += 1) {
    const r = mem(['--atlas-floor-probe'], { root, timeoutMs: 300000 });
    if (r.spawnError || r.timedOut) spawned = false;
    runs.push(r.ms);
  }
  const sorted = [...runs].sort((a, b) => a - b);
  return { p50: pct(sorted, 50), reps, spawned };
}

/** `mem find <term>` p50 over a real cheap-mem root, as a real child process. */
function timeCliQuery(root, term, reps) {
  const runs = [];
  let status = null; let stderr = null;
  for (let i = 0; i < reps; i += 1) {
    const r = mem(['find', term, '--top', '10'], { root, timeoutMs: 300000 });
    runs.push(r.ms);
    status = r.status;
    stderr = (r.stderr || '').slice(0, 200) || null;
  }
  const sorted = [...runs].sort((a, b) => a - b);
  return {
    p50: pct(sorted, 50), reps, status, stderr,
  };
}

// --- fitting the law ---------------------------------------------------

/** Fit `y = a * n^b` by OLS on (ln n, ln y). Needs n>0, y>0 points. */
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
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  return {
    a, b, r2, n: p.length,
  };
}

function verdictForExponent(b) {
  if (b === null || b === undefined || !Number.isFinite(b)) return VERDICT.NOT_MEASURED;
  if (b >= LAW_EXP_PASS[0] && b <= LAW_EXP_PASS[1]) return VERDICT.PASS;
  if (b >= LAW_EXP_DEGRADED[0] && b <= LAW_EXP_DEGRADED[1]) return VERDICT.DEGRADED;
  return VERDICT.FAIL;
}

// --- the phase -------------------------------------------------------------

export async function run(atlas, { quick = false, sqliteLoader = loadSqlite } = {}) {
  const stages = ladder(quick);
  const phaseT0 = Date.now();

  atlas.phase('register',
    'A repeatable register benchmark: sqlite+FTS5 against today\'s linear scan',
    [
      `Ladder: ${stages.join(' / ')} rows, fixed seed 42, a fresh Zipf-distributed`,
      `vocabulary of ${VOCAB_SIZE.toLocaleString('en-US')} terms — not the ~34-word COMMON`,
      'list ./core.mjs uses for other phases, whose short rows are exactly the shape',
      'that made the first attempt at this measurement wrong (see this file\'s header',
      'comment). Every latency record below carries the matched-row count and',
      'selectivity it depends on — this phase\'s own rule, thrown on at the point',
      'a record is built, not merely stated in a comment.',
      '',
      'For every corpus size: a sqlite+FTS5 register is built from the SAME rows',
      'that are written into a throwaway cheap-mem root, so the register and',
      '`mem find` answer literally identical text. Four questions are asked of',
      'both, at bands chosen from the CORPUS\'S OWN measured selectivity (rare',
      `~${(SELECTIVITY_TARGETS.rare * 100).toFixed(2)}%, medium `
        + `~${(SELECTIVITY_TARGETS.medium * 100).toFixed(2)}%, frequent `
        + `~${(SELECTIVITY_TARGETS.frequent * 100).toFixed(1)}%, and no-match): the`,
      'comparison is what a real question against a real design would cost against',
      'what it costs today.',
      '',
      'This is a benchmark of a CANDIDATE design. It changes nothing this repo',
      'ships. If `node:sqlite` or FTS5 inside it is unavailable, this phase',
      'records exactly that and stops — never a pass, never a silent skip.',
    ].join('\n'));

  // =========================================================================
  // Availability — the phase's own hard gate
  //
  // `sqliteLoader` defaults to the real `loadSqlite` above and exists so a
  // test can inject one that always throws, proving the not-measured path
  // is exercised for real rather than trusted on faith — without having
  // to mutate `process.env` (`loadSqlite` also honours
  // `CHEAP_MEM_ATLAS_FORCE_NO_SQLITE` directly, for the same reason).
  // =========================================================================

  let mod = null;
  let unavailableReason = null;
  try {
    mod = await sqliteLoader();
  } catch (e) {
    unavailableReason = String((e && e.message) || e).slice(0, 300);
  }

  if (!mod) {
    atlas.record({
      id: 'register.availability',
      title: 'node:sqlite + FTS5 available to build the register prototype',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'node:sqlite importable and `CREATE VIRTUAL TABLE ... USING fts5(...)` '
        + 'working, on Node >= 22 (it ships behind an experimental flag)',
      actual: `not available here (Node ${process.version}): ${unavailableReason}`,
      severity: SEVERITY.INFO,
    });
    atlas.blind('the whole register phase',
      `node:sqlite or its FTS5 support is not usable here: ${unavailableReason}`);
    return;
  }

  atlas.record({
    id: 'register.availability',
    title: 'node:sqlite + FTS5 available to build the register prototype',
    verdict: VERDICT.PASS,
    expected: 'node:sqlite importable and FTS5 usable, on Node >= 22',
    actual: `available on ${process.version}`,
    measured: { node: process.version },
  });

  // =========================================================================
  // The ladder: build, measure, compare, at every rung
  // =========================================================================

  const regDir = tempRoot('atlas-register-db-');
  const rungResults = [];
  const lawPoints = [];        // { n, matched, p50 } across all bands, all rungs (register)
  const fixedCountSeries = []; // { n, matched, p50 } register, held near FIXED_MATCHED_TARGET
  const fixedCountCliSeries = []; // the same query, through `mem find`

  for (const n of stages) {
    const corpus = buildZipfCorpus(n, 42);
    const bands = pickBands(corpus.df, n);
    const fixedBand = nearestByCount(corpus.df, n, FIXED_MATCHED_TARGET);
    rungResults.push({ n, bands, fixedBand });

    // --- build: time and bytes/row on disk ---------------------------------
    const dbPath = path.join(regDir, `register-${n}.db`);
    const build = buildRegister(mod, dbPath, corpus.rows);
    atlas.record({
      id: `register.build.${n}`,
      title: `register build: ${n.toLocaleString('en-US')} rows, sqlite+FTS5`,
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: `${round(build.buildMs, 1)} ms to build, ${build.bytes.toLocaleString('en-US')} bytes `
        + `on disk = ${round(build.bytes / n, 1)} B/row`,
      measured: {
        rows: n, buildMs: round(build.buildMs, 1), bytes: build.bytes,
        bytesPerRow: round(build.bytes / n, 2),
      },
    });

    // --- correctness: the register's own count against the ground truth ---
    const liveCounts = {};
    for (const [bandName, band] of Object.entries(bands)) liveCounts[bandName] = liveCount(mod, dbPath, band.term);
    const mismatches = Object.entries(bands).filter(([k, b]) => liveCounts[k] !== b.matched);
    atlas.record({
      id: `register.correctness.${n}`,
      title: 'the register\'s live match count agrees with the corpus\'s ground truth, '
        + 'and a term outside the vocabulary matches nothing',
      verdict: mismatches.length ? VERDICT.FAIL : VERDICT.PASS,
      expected: 'FTS5 `COUNT(*) MATCH` for every band equals the document frequency counted '
        + 'while the corpus was generated (the positive control); the no-match control term, '
        + 'which the vocabulary never emits, matches exactly 0 rows (the sabotage counter-probe '
        + '— proof that MATCH is not just returning everything)',
      actual: Object.entries(bands).map(([k, b]) => `${k}: ground truth ${b.matched}, register ${liveCounts[k]}`).join('; '),
      severity: SEVERITY.CRITICAL,
      measured: {
        rows: n,
        groundTruth: Object.fromEntries(Object.entries(bands).map(([k, b]) => [k, b.matched])),
        live: liveCounts,
      },
    });

    // --- the same rows, as a cheap-mem corpus, for today's path -----------
    const root = tempRoot(`atlas-register-cli-${n}-`);
    writeCheapMemCorpus(root, corpus.rows);
    mem(['find', 'warmup'], { root, timeoutMs: 300000 }); // build+warm the cache once, untimed

    // What a `mem` call costs before it searches. Measured per rung
    // rather than once, because the floor is a property of the machine
    // this run happens to be on, and a run can be long.
    const floor = timeCliFloor(root, cliRepsFor(n, quick));
    atlas.record({
      id: `register.today.floor.${n}`,
      title: `what one \`mem\` invocation costs before it searches anything, at ${n.toLocaleString('en-US')} rows`,
      verdict: floor.spawned ? VERDICT.NOT_MEASURED : VERDICT.FAIL,
      expected: null,
      actual: floor.spawned
        ? `p50 ${round(floor.p50, 1)} ms over ${floor.reps} call(s) — process startup and `
          + 'module load, paid by every CLI measurement below and removed from the '
          + '`search-only` factor'
        : 'the floor probe did not run as a child process, so no CLI number below can be split',
      ms: round(floor.p50, 1),
      severity: floor.spawned ? null : SEVERITY.MAJOR,
      measured: { rows: n, p50Ms: round(floor.p50, 1), reps: floor.reps, spawned: floor.spawned },
    });

    // --- per-band: register latency, today's-path latency, and the gain ---
    for (const [bandName, band] of Object.entries(bands)) {
      const regT = timeRegisterQuery(mod, dbPath, band.term);
      atlas.record({
        id: `register.query.${n}.${bandName}`,
        title: `register query, ${bandName} selectivity, at ${n.toLocaleString('en-US')} rows`,
        verdict: VERDICT.NOT_MEASURED,
        expected: null,
        actual: `p50 ${round(regT.p50, 3)} ms over ${regT.n} run(s) (warmup ${regT.warmup}), `
          + `${band.matched.toLocaleString('en-US')} row(s) matched `
          + `(${(band.selectivity * 100).toFixed(4)}% of ${n.toLocaleString('en-US')})`,
        ms: round(regT.p50, 3),
        measured: withSelectivity({
          matched: band.matched,
          selectivity: band.selectivity,
          p50Ms: round(regT.p50, 3),
          p95Ms: round(regT.p95, 3),
          reps: regT.n,
          term: band.term,
          corpusRows: n,
        }),
      });

      if (band.matched > 0) {
        lawPoints.push({ n: band.matched, y: regT.p50 });
      }

      const cliReps = cliRepsFor(n, quick);
      const cliT = timeCliQuery(root, band.term, cliReps);
      atlas.record({
        id: `register.today.${n}.${bandName}`,
        title: `today's path (\`mem find\`), ${bandName} selectivity, at ${n.toLocaleString('en-US')} rows`,
        verdict: VERDICT.NOT_MEASURED,
        expected: null,
        actual: `p50 ${round(cliT.p50, 1)} ms over ${cliT.reps} call(s) — same corpus, same term, `
          + `${band.matched.toLocaleString('en-US')} row(s) actually match`,
        ms: round(cliT.p50, 1),
        measured: withSelectivity({
          matched: band.matched,
          selectivity: band.selectivity,
          p50Ms: round(cliT.p50, 1),
          reps: cliT.reps,
          status: cliT.status,
          term: band.term,
          corpusRows: n,
        }),
      });

      if (regT.p50 > 0 && cliT.p50 != null) {
        // Two factors, because there are two questions. End-to-end is
        // what a person waits for and includes the startup they would
        // still pay. Search-only strips that constant and is the part
        // the register is responsible for. Where the CLI number sits at
        // or below the floor, the subtraction has nothing left to
        // divide by and the search-only factor is honestly null — not
        // clamped to some large number that would read as a result.
        const searchOnlyMs = floor.spawned ? cliT.p50 - floor.p50 : null;
        const searchOnlyFactor = searchOnlyMs != null && searchOnlyMs > 0
          ? round(searchOnlyMs / regT.p50, 2) : null;
        atlas.record({
          id: `register.comparison.${n}.${bandName}`,
          title: `what the register gains over today's path: ${bandName}, ${n.toLocaleString('en-US')} rows`,
          verdict: VERDICT.NOT_MEASURED,
          expected: null,
          actual: `register ${round(regT.p50, 3)} ms vs today ${round(cliT.p50, 1)} ms `
            + `= ${round(cliT.p50 / regT.p50, 1)}x end to end; `
            + (searchOnlyFactor != null
              ? `${searchOnlyFactor}x over the search alone, once the `
                + `${round(floor.p50, 1)} ms startup floor both paths pay is removed`
              : 'the search-only factor is not measurable here — today\'s path costs no more '
                + 'than the startup floor itself, so what is left is not a search time'),
          measured: withSelectivity({
            matched: band.matched,
            selectivity: band.selectivity,
            registerMs: round(regT.p50, 3),
            todayMs: round(cliT.p50, 1),
            cliFloorMs: floor.spawned ? round(floor.p50, 1) : null,
            todaySearchOnlyMs: searchOnlyMs != null ? round(searchOnlyMs, 1) : null,
            speedupEndToEnd: round(cliT.p50 / regT.p50, 2),
            speedupSearchOnly: searchOnlyFactor,
          }),
        });
      }
    }

    // --- the law's sharpest form: hold the MATCHED COUNT near-fixed while
    // the CORPUS grows, and see whether latency moves with the corpus or
    // with the count. ---------------------------------------------------
    const fcRegT = timeRegisterQuery(mod, dbPath, fixedBand.term);
    fixedCountSeries.push({ n, matched: fixedBand.matched, selectivity: fixedBand.selectivity, p50: fcRegT.p50 });
    atlas.record({
      id: `register.law.fixed-count.${n}`,
      title: `register query held near ${FIXED_MATCHED_TARGET} matched rows, `
        + `at ${n.toLocaleString('en-US')} corpus rows`,
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: `p50 ${round(fcRegT.p50, 3)} ms, ${fixedBand.matched} row(s) matched out of `
        + `${n.toLocaleString('en-US')} (target was ${FIXED_MATCHED_TARGET})`,
      measured: withSelectivity({
        matched: fixedBand.matched, selectivity: fixedBand.selectivity,
        p50Ms: round(fcRegT.p50, 3), corpusRows: n,
      }),
    });

    const fcCliReps = cliRepsFor(n, quick);
    const fcCliT = timeCliQuery(root, fixedBand.term, fcCliReps);
    fixedCountCliSeries.push({ n, matched: fixedBand.matched, p50: fcCliT.p50 });
    atlas.record({
      id: `register.today.fixed-count.${n}`,
      title: `today's path, held near ${FIXED_MATCHED_TARGET} matched rows, `
        + `at ${n.toLocaleString('en-US')} corpus rows`,
      verdict: VERDICT.NOT_MEASURED,
      expected: null,
      actual: `p50 ${round(fcCliT.p50, 1)} ms over ${fcCliT.reps} call(s), `
        + `${fixedBand.matched} row(s) actually match`,
      measured: withSelectivity({
        matched: fixedBand.matched, selectivity: fixedBand.selectivity,
        p50Ms: round(fcCliT.p50, 1), corpusRows: n,
      }),
    });

    fs.rmSync(root, { recursive: true, force: true });
  }

  // =========================================================================
  // The degenerate-corpus guard
  // =========================================================================
  //
  // The exact check the task's background warns is missing without it: a
  // "rare" query must actually be rare, and must be much rarer than
  // "frequent" — otherwise the whole ladder above is timing the same
  // near-total scan under three different names, which is precisely how
  // the first attempt at this measurement went wrong.

  const top = rungResults[rungResults.length - 1];
  const rareSel = top.bands.rare.selectivity;
  const freqSel = top.bands.frequent.selectivity;
  const nonDegenerate = rareSel < DEGENERATE_RARE_CEILING
    && rareSel > 0
    && freqSel >= rareSel * DEGENERATE_SPREAD_MIN;
  atlas.record({
    id: 'register.corpus.non-degenerate',
    title: 'the generated vocabulary is not degenerate: "rare" matches a small '
      + 'fraction of the corpus, and is much rarer than "frequent"',
    verdict: nonDegenerate ? VERDICT.PASS : VERDICT.FAIL,
    expected: `rare-band selectivity under ${(DEGENERATE_RARE_CEILING * 100).toFixed(0)}%, `
      + `and at least ${DEGENERATE_SPREAD_MIN}x rarer than the frequent band — the failure `
      + 'mode this replaces (2026-09-20, a 42-word vocabulary) made a "rare" query match '
      + 'almost the whole corpus',
    actual: `at ${top.n.toLocaleString('en-US')} rows: rare ${(rareSel * 100).toFixed(4)}% `
      + `(${top.bands.rare.matched} rows), frequent ${(freqSel * 100).toFixed(2)}% `
      + `(${top.bands.frequent.matched} rows) — frequent is ${round(freqSel / (rareSel || 1), 1)}x rarer's rate`,
    severity: SEVERITY.CRITICAL,
    measured: {
      rungs: rungResults.map((r) => ({
        n: r.n, rare: r.bands.rare, medium: r.bands.medium, frequent: r.bands.frequent,
      })),
    },
  });

  // =========================================================================
  // The law: does latency actually track rows matched?
  // =========================================================================

  if (lawPoints.length < MIN_POINTS_FOR_FIT) {
    atlas.record({
      id: 'register.law.linear-in-matched-rows',
      title: 'register latency as a function of rows matched, across every band and rung',
      verdict: VERDICT.NOT_MEASURED,
      expected: `a power-law fit over at least ${MIN_POINTS_FOR_FIT} (matched, latency) points`,
      actual: `only ${lawPoints.length} usable point(s)`,
    });
    atlas.blind('the matched-rows law fit', `fewer than ${MIN_POINTS_FOR_FIT} usable points`);
  } else {
    const fit = fitPowerLaw(lawPoints);
    const verdict = verdictForExponent(fit ? fit.b : null);
    atlas.record({
      id: 'register.law.linear-in-matched-rows',
      title: 'register latency as a function of rows matched, across every band and rung — '
        + 'the exponent should be ~1, because the claim is that time tracks MATCHED ROWS, '
        + 'not corpus size',
      verdict,
      expected: `growth exponent in [${LAW_EXP_PASS.join(', ')}] for PASS, `
        + `[${LAW_EXP_DEGRADED.join(', ')}] for DEGRADED, else FAIL`,
      actual: fit
        ? `latency = ${round(fit.a, 4)} * matched^${round(fit.b, 3)} `
          + `(R²=${round(fit.r2, 3)}) over ${fit.n} points spanning `
          + `${stages[0].toLocaleString('en-US')}-${stages[stages.length - 1].toLocaleString('en-US')} `
          + 'corpus rows and every selectivity band'
        : 'the fit did not converge',
      severity: SEVERITY.MAJOR,
      measured: { fit, points: lawPoints },
    });
  }

  // --- the sharpest form: same matched count, growing corpus -------------

  const fcP50s = fixedCountSeries.map((r) => r.p50).filter((v) => Number.isFinite(v) && v > 0);
  const cliP50s = fixedCountCliSeries.map((r) => r.p50).filter((v) => Number.isFinite(v) && v > 0);
  if (fixedCountSeries.length < 2 || fcP50s.length < 2) {
    atlas.record({
      id: 'register.law.matched-rows-not-corpus-size',
      title: 'register latency holding matched rows near-fixed while the corpus grows',
      verdict: VERDICT.NOT_MEASURED,
      expected: 'at least two rungs with a usable fixed-count query',
      actual: `only ${fcP50s.length} usable rung(s)`,
    });
    atlas.blind('matched-rows-not-corpus-size law', 'fewer than two rungs produced a usable fixed-count timing');
  } else {
    const latencyRatio = Math.max(...fcP50s) / Math.min(...fcP50s);
    const corpusRatio = stages[stages.length - 1] / stages[0];
    const cliRatio = cliP50s.length >= 2 ? Math.max(...cliP50s) / Math.min(...cliP50s) : null;
    const verdict = latencyRatio <= FIXED_COUNT_RATIO_PASS ? VERDICT.PASS
      : latencyRatio <= FIXED_COUNT_RATIO_DEGRADED ? VERDICT.DEGRADED : VERDICT.FAIL;
    atlas.record({
      id: 'register.law.matched-rows-not-corpus-size',
      title: 'register latency holding matched rows near-fixed while the corpus grows '
        + `${round(corpusRatio, 1)}x — the headline claim, made falsifiable`,
      verdict,
      expected: `register p50 should vary by at most ${FIXED_COUNT_RATIO_PASS}x (PASS) or `
        + `${FIXED_COUNT_RATIO_DEGRADED}x (DEGRADED) across a ${round(corpusRatio, 1)}x corpus-size `
        + 'range, when the number of matched rows is held fixed — if latency tracked corpus '
        + `size instead, it would move by close to ${round(corpusRatio, 1)}x too`,
      actual: `register p50 varied ${round(latencyRatio, 2)}x across `
        + `${fixedCountSeries.map((r) => `${r.n.toLocaleString('en-US')} rows (${r.matched} matched, `
          + `${round(r.p50, 3)} ms)`).join('; ')}`
        + (cliRatio !== null
          ? `. Today's path on the SAME queries varied ${round(cliRatio, 2)}x — `
            + `${fixedCountCliSeries.map((r) => `${round(r.p50, 1)} ms`).join(' / ')}`
          : ''),
      severity: SEVERITY.MAJOR,
      measured: {
        register: fixedCountSeries, todaysPath: fixedCountCliSeries,
        corpusRatio: round(corpusRatio, 2), registerLatencyRatio: round(latencyRatio, 3),
        todaysPathLatencyRatio: round(cliRatio, 3),
      },
    });
  }

  // --- what this phase did not reach ---------------------------------------

  atlas.blind('the register at 1,000,000 rows',
    `this ladder tops out at ${stages[stages.length - 1].toLocaleString('en-US')} rows for the full `
    + 'atlas run\'s time budget. The 2026-09-20 one-off prototype reached 1,000,000 rows and '
    + '180.8 MB on disk; that scale is the point of comparison for this phase, not reproduced here.');
  atlas.blind('concurrent readers or writers on the register',
    'every query above runs against an idle, already-built, read-only register file; nothing '
    + 'here measures a writer appending while a reader queries, which sqlite\'s own '
    + 'concurrency model treats very differently from one JSONL file per type.');
  atlas.blind('a tokenizer other than FTS5\'s default (unicode61)',
    'no attempt is made here to match cheap-mem\'s own tokenization or scoring (BM25 + field '
    + 'weights + recency) — this measures FTS5\'s bm25() as sqlite ships it, which is a '
    + 'DIFFERENT ranking function from src/search.mjs, not merely a faster path to the same one.');

  const wallMs = Date.now() - phaseT0;
  atlas.record({
    id: 'register.env.wall-clock',
    title: 'phase wall-clock cost',
    verdict: VERDICT.NOT_MEASURED,
    expected: null,
    actual: `${(wallMs / 1000).toFixed(1)} s for ${stages.length} rung(s) up to `
      + `${stages[stages.length - 1].toLocaleString('en-US')} rows`,
    severity: SEVERITY.INFO,
    ms: wallMs,
  });
}
