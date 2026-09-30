#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bench/heaps-corpus.mjs — an English Heaps-law corpus builder for
 * cheap-mem, ported from lucky-mem's `bench/korpus-heaps.mjs`.
 *
 * **Why this exists.** cheap-mem's COVERAGE_FLOOR (`src/search.mjs`,
 * decision `34oxttv96z3u`, 2026-09-20) was calibrated against
 * `bench/atlas/core.mjs`'s `buildCorpus`. That generator picks its
 * filler vocabulary from a FIXED 24-word pool (`COMMON`) plus rare
 * per-entry identifiers that are effectively unbounded in cardinality
 * (`zipfWord`, keyed on the running index) — so the corpus's vocabulary
 * either never grows past 24 common words or grows without any bound at
 * all. Neither is what a real, used memory looks like: a real
 * vocabulary grows, but SUBLINEARLY, in the shape Heaps' law describes
 * — `V(n) = K * n^beta`. lucky-mem found and fixed the equivalent defect
 * on its own real corpus (error `1czzbds7x7qy`, its `bench/echt-
 * vielfach.mjs` flattened past ~2600 documents because it repeated real
 * entries verbatim). This file is the same fix, ported for a house that
 * has no large real corpus of its own to fit against.
 *
 * **What this is NOT.** cheap-mem is a tool, not a populated personal
 * memory — there is no real English corpus here to measure K and beta
 * from (lucky-mem's `mess` mode fits them from `global/`+`projekte/`;
 * this file keeps that mode, `measure`, for the day such a corpus
 * exists, but it has nothing to run against today). So the defaults
 * below are lucky-mem's OWN fitted values, carried over as a starting
 * point, not a measurement of English or of cheap-mem:
 *
 *   K = 138.6, beta = 0.618 — fitted on a German personal memory
 *   (lucky-mem's real corpus, 2286 entries, 2026-09-25). Transferability
 *   to English, or to any cheap-mem installation, is UNMEASURED. Anyone
 *   with a real corpus to fit against should run `measure` and pass
 *   `--K`/`--beta` explicitly rather than trust these numbers.
 *
 * **Words are synthetic, not modelled on real English text.**
 * lucky-mem's generator builds a character-transition (order-2 Markov)
 * model from ITS real corpus, so its synthetic words carry that
 * corpus's letter statistics without quoting a single real word. cheap-
 * mem has no equivalent real text to model transitions from — using a
 * generic English corpus instead would fit a different distribution
 * than any real cheap-mem memory ever has, which is worse than being
 * honest about not knowing. So words here are built from plain
 * consonant-vowel syllables (see `englishSyllable`/`englishWord`) —
 * pronounceable-looking ASCII tokens, English in CHARACTER SET and
 * shape, carrying no claim of matching real English word-frequency
 * statistics. What this file ports faithfully from lucky-mem is the
 * part that is language-independent and does the actual work for a
 * dilution/bait measurement: the Heaps-law GROWTH RATE of the
 * vocabulary, and the Zipf-like reuse skew of older words (see
 * `buildVocabMotor`) — both of which shape a real document-frequency
 * distribution, which is what a coverage-floor sweep needs.
 *
 * ## Usage
 *
 *   node bench/heaps-corpus.mjs measure --source <path> [--json]
 *   node bench/heaps-corpus.mjs build   <root> <count> [--seed N] [--K N] [--beta N] [--budget N]
 *   node bench/heaps-corpus.mjs check   <root> <count> [--seed N] [--K N] [--beta N] [--budget N]
 *
 * `measure` only measures (writes nothing) and prints K, beta and the
 * fit table for an existing cheap-mem root (`global/*.jsonl`). `build`
 * writes the corpus under `<root>/global/*.jsonl`, in the same flat
 * per-type-file shape `bench/atlas/core.mjs`'s `buildCorpus` uses, so
 * `loadIndex()` reads it unmodified. `check` builds AND self-verifies:
 * measures its own generated V(n) against the target curve, PASS/FAIL
 * at +-15%.
 *
 * Abort: `<count>` above `--budget` (default 50000) exits 1 BEFORE any
 * write, same rule as lucky-mem's generator.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TYPES } from '../src/memory.mjs';

import { pathToFileURL } from 'node:url';
// ---------------------------------------------------------------------
// Deterministic RNG (mulberry32) — one seed, one output, forever. Kept
// separate from `bench/atlas/core.mjs`'s own `rng()` (a different
// algorithm) so a seed here never depends on which generator the caller
// also happens to have imported.
// ---------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * lucky-mem's fitted Heaps parameters (see the file banner above for
 * exactly what they are and are not evidence of).
 */
export const HEAPS_DEFAULTS = Object.freeze({ K: 138.6, beta: 0.618 });

// ---------------------------------------------------------------------
// Load an existing cheap-mem corpus for `measure` — same traversal
// shape as lucky-mem's `ladeBestand`: every `.jsonl` line under
// `global/` (and `projects/`, cheap-mem's plural-English spelling),
// sorted by `ts` because "vocabulary after n documents" is only a
// growth statement in the order the corpus actually grew.
// ---------------------------------------------------------------------
function loadCorpusLines(source) {
  const files = [];
  for (const area of ['global', 'projects']) {
    const dir = path.join(source, area);
    if (!fs.existsSync(dir)) continue;
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q);
        else if (e.name.endsWith('.jsonl')) files.push(q);
      }
    };
    walk(dir);
  }
  const lines = [];
  for (const f of files) {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      if (o && typeof o === 'object') lines.push({ ts: typeof o.ts === 'string' ? o.ts : '', obj: o });
    }
  }
  lines.sort((a, b) => {
    if (a.ts && b.ts) return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    if (a.ts) return -1;
    if (b.ts) return 1;
    return 0;
  });
  return lines;
}

// Metadata keys that are not prose — same rationale as lucky-mem's
// `METADATEN_SCHLUESSEL`: a repeated, small-cardinality field (a status
// string, an author name) would flatten the curve for the same reason
// the defect this file fixes exists in the first place. Only string
// prose fields count toward the vocabulary.
const META_KEYS = new Set([
  'id', 'ts', 'type', 'status', 'author', 'authority', 'project', 'scope',
  'source', 'related', 'replaces_id', 'supersedes', 'valid_from',
  'valid_until', 'confidence', 'tags', 'class', 'symbols', 'asked',
]);

function proseFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (META_KEYS.has(k)) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const WORD_RE = /[a-z]+/gi;
function tokenize(text) {
  return (text.match(WORD_RE) ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
}

/**
 * Fit Heaps' law (`V(n) = K * n^beta`) over `lines` (as returned by
 * `loadCorpusLines`, or any array of `{ obj }`), via log-log least
 * squares over 15 log-spaced sample points — same shape as lucky-mem's
 * `heapsMessen`.
 */
export function measureHeaps(lines) {
  const total = lines.length;
  const samplePoints = 15;
  const minN = Math.min(50, total);
  const points = [];
  for (let i = 0; i < samplePoints; i += 1) {
    const frac = samplePoints === 1 ? 1 : i / (samplePoints - 1);
    const n = Math.round(minN * (total / minN) ** frac);
    points.push(Math.max(1, Math.min(total, n)));
  }
  const samples = [...new Set(points)].sort((a, b) => a - b);

  const vocab = new Set();
  const table = [];
  let cursor = 0;
  for (let i = 0; i < total; i += 1) {
    const n = i + 1;
    for (const w of tokenize(Object.values(proseFields(lines[i].obj)).join(' '))) vocab.add(w);
    while (cursor < samples.length && samples[cursor] === n) {
      table.push({ n, v: vocab.size });
      cursor += 1;
    }
  }
  while (cursor < samples.length) { table.push({ n: total, v: vocab.size }); cursor += 1; }

  const pts = table.filter((p) => p.n > 0 && p.v > 0);
  const xs = pts.map((p) => Math.log(p.n));
  const ys = pts.map((p) => Math.log(p.v));
  const nP = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / nP;
  const meanY = ys.reduce((a, b) => a + b, 0) / nP;
  let num = 0; let den = 0;
  for (let i = 0; i < nP; i += 1) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const beta = den === 0 ? 0 : num / den;
  const K = Math.exp(meanY - beta * meanX);
  return { total, K, beta, table };
}

// ---------------------------------------------------------------------
// Synthetic English-shaped words (see file banner: character SET and
// shape, no claim of matching real English statistics).
// ---------------------------------------------------------------------
const CONSONANTS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p',
  'r', 's', 't', 'v', 'w', 'y', 'th', 'ch', 'sh', 'st', 'tr', 'cl', 'br', 'gr', 'pl', 'cr'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'oo', 'ou', 'ee', 'ie'];

function englishSyllable(rand) {
  return CONSONANTS[Math.floor(rand() * CONSONANTS.length)]
    + VOWELS[Math.floor(rand() * VOWELS.length)];
}

function englishWord(rand, { minSyl = 1, maxSyl = 3 } = {}) {
  const n = minSyl + Math.floor(rand() * (maxSyl - minSyl + 1));
  let w = '';
  for (let i = 0; i < n; i += 1) w += englishSyllable(rand);
  return w;
}

/**
 * The vocabulary motor: grows by `newWord()`, reuses by `oldWord()`,
 * older (earlier-introduced) words reused more often — the Zipf-like
 * skew (exponent 2.2) is lucky-mem's own, unchanged, because it is what
 * turns "unique words introduced at the Heaps rate" into "a document-
 * frequency distribution shaped like a real one", which is the actual
 * property a dilution/bait measurement needs.
 */
export function buildVocabMotor(rand) {
  const vocab = [];
  const seen = new Set();
  function newWord() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const w = englishWord(rand);
      if (!seen.has(w)) { seen.add(w); vocab.push(w); return w; }
    }
    const w = `${englishWord(rand)}${vocab.length}`;
    seen.add(w); vocab.push(w); return w;
  }
  function oldWord() {
    const idx = Math.floor(vocab.length * rand() ** 2.2);
    return vocab[Math.min(idx, vocab.length - 1)];
  }
  return { vocab, newWord, oldWord };
}

// ---------------------------------------------------------------------
// Field/length shape. Borrowed from `bench/atlas/core.mjs`'s own
// constants (already fit against a real corpus — see that file's own
// comments) rather than re-derived here: the defect this file fixes is
// the VOCABULARY, not the field or length distribution, and a second
// independent fit of the same shape is exactly the kind of drift
// BUILDING.md warns against ("a second calculation over the same
// question").
// ---------------------------------------------------------------------
const DOMINANT_TYPE_SHARE = 0.3151;
const ENTRY_WORDS_NORMAL_MIN = 62;
const ENTRY_WORDS_NORMAL_RANGE = 48;
const ENTRY_WORDS_LONG_MIN = 140;
const ENTRY_WORDS_LONG_RANGE = 240;
const ENTRY_LONG_TAIL_SHARE = 0.13;
const UNTAGGED_SHARE = 0.1723;

function tagCountFor(rand) {
  let n = 2 + Math.floor(rand() * 2);
  if (rand() < 0.45) n += 1;
  if (rand() < 0.20) n += 1;
  if (rand() < 0.08) n += 1;
  return Math.min(n, 6);
}

const TYPE_FILES = Object.entries(TYPES).filter(([t]) => t !== 'link' && t !== 'timeline');

/**
 * Generate `targetCount` synthetic entries whose vocabulary grows at
 * `K * n^beta`. Each entry's word budget is drawn fresh against the
 * CURRENT vocabulary size, exactly like lucky-mem's `erzeugeKorpus`:
 * whatever new-word budget one entry does not use falls through to the
 * next automatically, no manual top-up needed.
 */
export function synthesizeCorpus({
  targetCount, seed = 1337, K = HEAPS_DEFAULTS.K, beta = HEAPS_DEFAULTS.beta,
  tsStart = '2025-01-01T00:00:00Z',
} = {}) {
  const rand = mulberry32(seed);
  const wordMotor = buildVocabMotor(rand);
  const tagMotor = buildVocabMotor(rand);
  const tagVocabTarget = Math.max(20, Math.round(Math.sqrt(targetCount)));
  for (let i = 0; i < tagVocabTarget; i += 1) tagMotor.newWord();

  const byFile = new Map();
  let tMs = Date.parse(tsStart) || Date.now();
  const STEP_MS = 3600_000; // one entry per synthetic hour — ordering only, no claim.

  for (let i = 0; i < targetCount; i += 1) {
    const n = i + 1;
    const target = Math.round(K * n ** beta);
    let need = Math.max(0, target - wordMotor.vocab.length);

    const x = rand();
    const [type, file] = x < DOMINANT_TYPE_SHARE || TYPE_FILES.length <= 1
      ? TYPE_FILES[0]
      : TYPE_FILES[1 + Math.min(TYPE_FILES.length - 2,
        Math.floor(((x - DOMINANT_TYPE_SHARE) / (1 - DOMINANT_TYPE_SHARE)) * (TYPE_FILES.length - 1)))];

    const long = rand() < ENTRY_LONG_TAIL_SHARE;
    const wordCount = long
      ? ENTRY_WORDS_LONG_MIN + Math.floor(rand() * ENTRY_WORDS_LONG_RANGE)
      : ENTRY_WORDS_NORMAL_MIN + Math.floor(rand() * ENTRY_WORDS_NORMAL_RANGE);
    const words = [];
    for (let w = 0; w < wordCount; w += 1) {
      if (need > 0) { words.push(wordMotor.newWord()); need -= 1; } else words.push(wordMotor.oldWord());
    }
    const titleWords = words.slice(0, 4 + Math.floor(rand() * 3));
    const bodyWords = words.slice(titleWords.length);

    const untagged = rand() < UNTAGGED_SHARE;
    const tagCount = untagged ? 0 : tagCountFor(rand);
    const tags = [];
    for (let t = 0; t < tagCount; t += 1) tags.push(tagMotor.oldWord());

    tMs += STEP_MS;
    const ts = new Date(tMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const id = `hp${n.toString(36)}`;
    const e = { id, ts, title: titleWords.join(' '), text: bodyWords.join(' ') };
    if (type === 'decision') {
      e.topic = titleWords.join(' ');
      e.choice = bodyWords.slice(0, Math.max(1, Math.floor(bodyWords.length / 2))).join(' ') || 'x';
      e.why = bodyWords.join(' ') || 'x';
      delete e.title; delete e.text;
    }
    if (tags.length) e.tags = tags;

    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(JSON.stringify(e));
  }

  return { byFile, vocabSize: wordMotor.vocab.length, targetVocab: Math.round(K * targetCount ** beta) };
}

/** Write a `synthesizeCorpus()` result to `<root>/global/*.jsonl`. */
/** Written into every corpus this script builds: proof the directory is ours to wipe. */
export const BENCH_MARKER = '.heaps-corpus-bench';

/**
 * May `build`/`check` wipe `root`? Only when losing it costs nothing:
 * it does not exist, it is empty, it sits under the system temp
 * directory, or it carries BENCH_MARKER from an earlier build. Anything
 * else — `build ~/my-memory 1000` typed by mistake — is refused before
 * a single byte is deleted (audit 2026-09-30, B27: the rmSync below had
 * no guard at all).
 */
export function disposableRoot(root) {
  let real;
  try { real = fs.realpathSync(root); } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, why: 'does not exist' };
    return { ok: false, why: `cannot inspect: ${e.message}` };
  }
  if (!fs.statSync(real).isDirectory()) return { ok: false, why: 'not a directory' };
  if (fs.readdirSync(real).length === 0) return { ok: true, why: 'empty' };
  if (fs.existsSync(path.join(real, BENCH_MARKER))) return { ok: true, why: 'bench marker' };
  let tmp = os.tmpdir();
  try { tmp = fs.realpathSync(tmp); } catch { /* no such temp dir: nothing lies under it */ }
  const rel = path.relative(tmp, real);
  if (fs.existsSync(tmp) && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return { ok: true, why: 'under the temp directory' };
  }
  return { ok: false, why: `not empty, not under ${tmp}, no ${BENCH_MARKER} marker` };
}

export function writeCorpus(root, byFile) {
  const dir = path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, BENCH_MARKER), 'synthetic corpus from bench/heaps-corpus.mjs — safe to delete\n');
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  const cfgPath = path.join(root, '.mem', 'config.json');
  if (!fs.existsSync(cfgPath)) {
    fs.writeFileSync(cfgPath, JSON.stringify({ participants: ['user', 'agent'], language: 'en' }));
  }
  let bytes = 0;
  for (const [file, lines] of byFile) {
    const body = `${lines.join('\n')}\n`;
    bytes += Buffer.byteLength(body);
    fs.writeFileSync(path.join(dir, file), body);
  }
  return { root, files: byFile.size, bytes };
}

/** Vocabulary of an already-built-and-written corpus's word fields, for self-check. */
function vocabOfByFile(byFile) {
  const v = new Set();
  for (const lines of byFile.values()) {
    for (const line of lines) {
      const obj = JSON.parse(line);
      for (const w of tokenize(Object.values(proseFields(obj)).join(' '))) v.add(w);
    }
  }
  return v.size;
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------
const BUDGET_DEFAULT = 50_000;
function flagNum(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(process.argv[i + 1]);
}
function flagStr(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
}

function formatMeasurement(m) {
  return [
    `corpus: ${m.total} entries`,
    `Heaps fit: K=${m.K.toFixed(3)} beta=${m.beta.toFixed(4)}`,
    'sample points (n -> V(n)):',
    ...m.table.map((p) => `  ${String(p.n).padStart(6)} -> ${p.v}`),
  ].join('\n');
}

const mode = process.argv[2];

// Only run the CLI when this file is the entry point — otherwise an
// import from another script (`bench/coverage-floor-sweep.mjs`) would
// hit this block with argv meant for the OTHER script and exit early.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (!isMain) {
  // imported as a module — nothing to do here.
} else if (mode === 'measure') {
  const source = flagStr('source', process.cwd());
  const lines = loadCorpusLines(source);
  if (lines.length === 0) {
    process.stderr.write(`heaps-corpus: no lines under ${source}/global or /projects — unknown.\n`);
    process.exit(2);
  }
  const m = measureHeaps(lines);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ total: m.total, K: m.K, beta: m.beta, table: m.table })}\n`);
  } else {
    process.stdout.write(`${formatMeasurement(m)}\n`);
  }
} else if (mode === 'build' || mode === 'check') {
  const root = process.argv[3];
  const targetCount = Number(process.argv[4]);
  const seed = flagNum('seed', 1337);
  const K = flagNum('K', HEAPS_DEFAULTS.K);
  const beta = flagNum('beta', HEAPS_DEFAULTS.beta);
  const budget = flagNum('budget', BUDGET_DEFAULT);
  if (!root || !Number.isFinite(targetCount) || targetCount <= 0) {
    process.stderr.write(`Usage: node bench/heaps-corpus.mjs ${mode} <root> <count> [--seed N] [--K N] [--beta N] [--budget N]\n`);
    process.exit(2);
  }
  if (targetCount > budget) {
    process.stderr.write(`ABORT: count ${targetCount} > budget ${budget} — before any write.\n`);
    process.exit(1);
  }
  const { byFile, vocabSize, targetVocab } = synthesizeCorpus({ targetCount, seed, K, beta });
  if (mode === 'check') {
    const measuredVocab = vocabOfByFile(byFile);
    const deviation = targetVocab === 0 ? 0 : (measuredVocab - targetVocab) / targetVocab;
    const band = Math.abs(deviation) <= 0.15;
    process.stdout.write(`${JSON.stringify({
      phase: 'check', targetCount, targetVocab, measuredVocab, deviation, band, verdict: band ? 'PASS' : 'FAIL',
    })}\n`);
    if (!band) process.exitCode = 1;
  }
  const wipe = disposableRoot(root);
  if (!wipe.ok) {
    process.stderr.write(`ABORT: refusing to delete ${root} (${wipe.why}) — pass an empty or temp directory.\n`);
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
  const { files, bytes } = writeCorpus(root, byFile);
  process.stderr.write(`${targetCount} synthetic entries written -> ${root} `
    + `(${files} files, ${bytes} bytes, vocabulary ${vocabSize}, target ${targetVocab})\n`);
} else {
  process.stderr.write('Usage: node bench/heaps-corpus.mjs measure|build|check ...\n');
  process.exit(2);
}
