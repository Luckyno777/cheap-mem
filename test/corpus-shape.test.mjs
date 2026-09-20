// The generator's job is to look like lucky-mem's real memory, not just
// to produce SOME corpus.
//
// **The finding (measured 2026-09-20, bench/atlas/phase-real.mjs `real`
// phase, against lucky-mem's real 2,286 entries).** `buildCorpus` in
// bench/atlas/core.mjs failed four of the atlas's five shape comparisons
// and degraded the fifth. Two were exactly zero on the generated side —
// the generator did not produce untagged entries or unreachable-by-search
// entries AT ALL, which means every measurement taken against it (recall,
// latency, coverage) was optimistic by an unknown amount.
//
// This file holds the generator to the five real numbers, within a
// stated tolerance, and checks the two things a shaped corpus must not
// lose along the way: the anchors stay tagged, findable and phrase-
// bearing even though the corpus around them now deliberately contains
// untagged and unreachable entries, and the same seed still produces
// the same bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCorpus, UNREACHABLE_MIN_WORDS, CORPUS_AS_OF } from '../bench/atlas/core.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-corpus-shape-'));
}

/** One corpus, flattened to a single string, so two can be compared as bytes. */
function buildAndRead(count, anchors, opts = {}) {
  const root = tmpRoot();
  try {
    const c = buildCorpus(root, count, { seed: 42, anchors, ...opts });
    return fs.readdirSync(c.dir).sort()
      .map((f) => `${f}\n${fs.readFileSync(path.join(c.dir, f), 'utf8')}`).join('\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Mirrors `WEIGHTED_FIELDS` / `FINDABLE_MIN_WORDS` in
// bench/atlas/phase-real.mjs (that file exports only `run`, so this list
// cannot be imported without importing that whole phase and its lucky-mem
// side effects). Duplicated here, once, for measurement only — never
// referenced by buildCorpus itself, which stays independent of any atlas
// phase. If phase-real.mjs's list ever moves, this file's notion of
// "unreachable" and that phase's will quietly start meaning different
// things; the tolerance below is wide enough that a small drift would
// not silently look fine, but a rewrite of that list would need this one
// checked by hand.
const WEIGHTED_FIELDS = [
  'titel', 'topic', 'klasse', 'tags', 'frageworte', 'skill', 'wahl',
  'verworfen', 'learning', 'pflicht', 'frage', 'regel', 'warum', 'auszug',
  'beschreibung', 'text', 'fakt',
];

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

/** Words over three letters across every weighted field. See the list above. */
function weightedWordCount(entry) {
  const parts = [];
  for (const f of WEIGHTED_FIELDS) {
    const v = entry?.[f];
    if (!v) continue;
    parts.push(Array.isArray(v) ? v.join(' ') : String(v));
  }
  return parts.join(' ').split(/[\s,;]+/).filter((w) => w.length > 3).length;
}

/** Read every .jsonl file directly under `dir` and reduce it to shape only. */
function analyze(dir) {
  const perFile = new Map();
  const sizes = []; const tagCounts = []; const timestamps = []; const wordCounts = [];
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      total += 1;
      sizes.push(Buffer.byteLength(line));
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
      const e = JSON.parse(line);
      const tags = Array.isArray(e.tags) ? e.tags : [];
      tagCounts.push(tags.length);
      wordCounts.push(weightedWordCount(e));
      const t = Date.parse(e.ts);
      if (Number.isFinite(t)) timestamps.push(t);
    }
  }
  const now = Date.now();
  const rankShares = [...perFile.values()].sort((a, b) => b - a)
    .map((n) => (total ? (n / total) * 100 : null));
  const sortedSizes = [...sizes].sort((a, b) => a - b);
  const findable = wordCounts.filter((n) => n >= UNREACHABLE_MIN_WORDS).length;
  return {
    total,
    maxTypeSharePercent: rankShares[0] ?? null,
    sizeP50: pct(sortedSizes, 50),
    sizeP95: pct(sortedSizes, 95),
    zeroTagPercent: tagCounts.length
      ? (tagCounts.filter((n) => n === 0).length / tagCounts.length) * 100 : null,
    unreachablePercent: total ? 100 - (findable / total) * 100 : null,
    recencyMiddleWindowPercent: timestamps.length
      ? (timestamps.filter((t) => (now - t) <= 30 * 86400000).length / timestamps.length) * 100
      : null,
  };
}

// --- the real figures this generator is fit against ---------------------
//
// Measured 2026-09-20 against lucky-mem's real 2,286 entries. See
// bench/atlas/core.mjs's own constants for the same numbers next to the
// mechanism that targets them.
const REAL = {
  maxTypeSharePercent: 31.51,
  sizeP50: 970, // real measured as both 964 B and 979 B across two runs
  zeroTagPercent: 17.23,
  unreachablePercent: 0.9,
  recencyMiddleWindowPercent: 100,
};

// How far a shaped value may drift from the real one before the
// guarantee below calls it broken. This is not picked fresh: it is
// `BIAS_DEGRADED_RATIO` in bench/atlas/phase-real.mjs, the same factor
// that phase itself uses to grade real-vs-generated bias. Reusing it
// means a corpus that passes this test also stays out of that phase's
// own DEGRADED/FAIL bucket — one number governing "close enough", not
// two files quietly disagreeing about it.
const TOLERANCE_RATIO = 1.5;

/** max(a,b)/min(a,b); 0-vs-0 is no bias, 0-vs-x is total (mirrors phase-real.mjs). */
function ratio(a, b) {
  if (a === 0 && b === 0) return 1;
  if (a === 0 || b === 0) return Infinity;
  return Math.max(a, b) / Math.min(a, b);
}

function shapeChecks(a) {
  return [
    ['share of entries in the largest type', a.maxTypeSharePercent, REAL.maxTypeSharePercent],
    ['entry size at p50 (bytes)', a.sizeP50, REAL.sizeP50],
    ['share of entries with no tags', a.zeroTagPercent, REAL.zeroTagPercent],
    ['share of entries unreachable by search', a.unreachablePercent, REAL.unreachablePercent],
    ['share of entries inside the 30-day recency window',
      a.recencyMiddleWindowPercent, REAL.recencyMiddleWindowPercent],
  ];
}

// "a few thousand", per the brief that opened this file. Large enough
// that the rarest shaped property (0.9%) is ~50+ entries rather than a
// small count the RNG could tip either way — though there is no
// run-to-run chance here regardless: seed 42 is deterministic, so this
// file's numbers are exactly reproducible, not merely likely.
const N = 6000;

// --- positive control -----------------------------------------------

test('POSITIVE CONTROL: buildCorpus produces a corpus at all, with the counts asked for', () => {
  const root = tmpRoot();
  try {
    const c = buildCorpus(root, N, { seed: 42, anchors: 12 });
    assert.equal(c.count, N + 12, 'reported count must include the anchors');
    assert.equal(c.anchors.length, 12);
    assert.ok(fs.existsSync(c.dir));
    assert.ok(fs.existsSync(path.join(root, '.mem', 'config.json')));
    const a = analyze(c.dir);
    assert.equal(a.total, N + 12, 'every generated line must parse and be counted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- the guarantee -----------------------------------------------------

test('THE GUARANTEE: each shaped property lands within 1.5x of the real figure', () => {
  const root = tmpRoot();
  try {
    const c = buildCorpus(root, N, { seed: 42, anchors: 12 });
    const a = analyze(c.dir);
    for (const [label, got, want] of shapeChecks(a)) {
      const r = ratio(got, want);
      assert.ok(r <= TOLERANCE_RATIO,
        `${label}: generated ${got}, real ${want} — ratio ${r.toFixed(2)}x exceeds `
        + `the ${TOLERANCE_RATIO}x tolerance`);
    }
    // The long tail itself, not just where the middle of it sits: p95
    // several times p50, not a narrow band beside it. "Several" is
    // pinned at 2x here — loose on purpose, since this checks the SHAPE
    // (a tail exists at all) rather than trying to reproduce real's own
    // p95/p50 ratio (~1.7x on the last measured run, itself none too
    // heavy a tail) to the decimal.
    assert.ok(a.sizeP95 >= a.sizeP50 * 2,
      `p95 (${a.sizeP95}) is not several times p50 (${a.sizeP50}) — `
      + 'the generator is back to a narrow band');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- sabotage: the guarantee actually has teeth -------------------------

test('SABOTAGE COUNTER-PROBE: a corpus shaped the OLD way fails this same guarantee', () => {
  // Not buildCorpus with a flag flipped — a hand-built stand-in for
  // exactly what the generator produced before this file existed:
  // uniform type pick, one narrow word-count band, every entry tagged
  // once, timestamps flat across a full calendar year. If the checks
  // above cannot tell this apart from a shaped corpus, they have no
  // teeth regardless of what buildCorpus itself does.
  const root = tmpRoot();
  const dir = path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  const OLD_TYPE_FILES = ['decisions', 'errors', 'events', 'thoughts', 'learnings',
    'duties', 'questions', 'skills', 'procedures', 'sources', 'updates'];
  let s = 99 >>> 0;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const start = Date.parse('2026-01-01T00:00:00Z');
  const streams = new Map();
  for (let i = 0; i < N; i += 1) {
    const file = `${OLD_TYPE_FILES[Math.floor(r() * OLD_TYPE_FILES.length)]}.jsonl`;
    const words = [];
    for (let w = 0; w < 6 + Math.floor(r() * 10); w += 1) words.push(`word${Math.floor(r() * 40)}`);
    const ts = new Date(start + Math.floor(r() * 365 * 86400) * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');
    const e = { id: `o${i}`, ts, title: 'entry', text: words.join(' '), tags: ['t'] };
    if (!streams.has(file)) streams.set(file, []);
    streams.get(file).push(JSON.stringify(e));
  }
  for (const [file, lines] of streams) fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);

  try {
    const a = analyze(dir);
    const broken = shapeChecks(a).filter(([, got, want]) => ratio(got, want) > TOLERANCE_RATIO);
    assert.ok(broken.length > 0,
      'the old, flat-shaped corpus passed every check above — the guarantee has no teeth');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- anchor integrity ----------------------------------------------------

test('ANCHOR INTEGRITY: every anchor is tagged, findable, and carries its own phrase', () => {
  const root = tmpRoot();
  try {
    const c = buildCorpus(root, N, { seed: 42, anchors: 12 });
    const byId = new Map();
    for (const f of fs.readdirSync(c.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(c.dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        const e = JSON.parse(line);
        byId.set(e.id, e);
      }
    }
    assert.equal(c.anchors.length, 12);
    for (const anchor of c.anchors) {
      const e = byId.get(anchor.id);
      assert.ok(e, `anchor ${anchor.id} is not in the corpus at all`);
      assert.ok(Array.isArray(e.tags) && e.tags.length > 0,
        `anchor ${anchor.id} carries no tags — it landed in the corpus's own untagged share`);
      assert.ok(String(e.text).includes(anchor.phrase) || String(e.title).includes(anchor.phrase),
        `anchor ${anchor.id} lost its own phrase`);
      // Anchors write into `text`, one of the weighted fields both this
      // file and phase-real.mjs count — so this is the exact test the
      // corpus's own unreachable share is built to fail on purpose.
      const wc = weightedWordCount(e);
      assert.ok(wc >= UNREACHABLE_MIN_WORDS,
        `anchor ${anchor.id} has only ${wc} weighted word(s) — it landed in the `
        + "corpus's own unreachable share");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- determinism -----------------------------------------------------

test('DETERMINISM: same seed, same corpus, byte for byte', () => {
  const root1 = tmpRoot(); const root2 = tmpRoot();
  try {
    const c1 = buildCorpus(root1, 500, { seed: 42, anchors: 5 });
    const c2 = buildCorpus(root2, 500, { seed: 42, anchors: 5 });
    const files1 = fs.readdirSync(c1.dir).sort();
    const files2 = fs.readdirSync(c2.dir).sort();
    assert.deepEqual(files1, files2, 'the two builds wrote different sets of files');
    for (const f of files1) {
      assert.equal(
        fs.readFileSync(path.join(c1.dir, f), 'utf8'),
        fs.readFileSync(path.join(c2.dir, f), 'utf8'),
        `${f} differs between two same-seed builds`);
    }
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('DETERMINISM COUNTER-PROBE: a different seed produces a different corpus', () => {
  const root1 = tmpRoot(); const root2 = tmpRoot();
  try {
    const c1 = buildCorpus(root1, 500, { seed: 42, anchors: 5 });
    const c2 = buildCorpus(root2, 500, { seed: 43, anchors: 5 });
    const dump = (dir) => fs.readdirSync(dir).sort()
      .map((f) => `${f}\u0000${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\u0000');
    assert.notEqual(dump(c1.dir), dump(c2.dir),
      'two different seeds produced byte-identical corpora — the seed is not doing anything');
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test('DETERMINISM ACROSS DAYS: the calendar cannot move the corpus', () => {
  // The determinism test above builds twice in the same process,
  // milliseconds apart. That cannot see the failure this one is for:
  // the first cut of the recency shaping anchored the corpus on
  // `Date.now()`, so seed 42 produced different bytes on a different
  // calendar day — and every fixture and baseline built on it would
  // have drifted with the wall clock, flaky BY CALENDAR.
  //
  // Faking the clock is the direct way to ask. `Date.now` is replaced
  // for the duration of the second build and restored in a `finally`,
  // so a failure here cannot leave a broken clock behind for the rest
  // of the file.
  const a = buildAndRead(600, 7);
  const real = Date.now;
  let b;
  try {
    // A year and a day later. If anything in the generator reads the
    // clock, these bytes differ.
    Date.now = () => real() + 366 * 86400000;
    b = buildAndRead(600, 7);
  } finally { Date.now = real; }

  assert.equal(b, a,
    'the corpus changed when the clock moved — something in buildCorpus reads '
    + 'the wall clock, and every seed-quoted measurement drifts with the calendar');
});

test('but a caller may still ask for a corpus around a day of their choosing', () => {
  // The escape hatch, and the counter-probe for the test above: if
  // `asOfDay` had no effect, the determinism guarantee would be
  // satisfied by a generator that ignores the parameter entirely.
  const a = buildAndRead(400, 5);
  const b = buildAndRead(400, 5, { asOfDay: CORPUS_AS_OF - 400 * 86400000 });
  assert.notEqual(b, a, 'asOfDay was accepted and ignored');
});
