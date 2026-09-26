// eval/echo.mjs — reproduces the finding from src/search.mjs:1031
// ("13 of 18 injected hits were such echoes") at large n.
//
// Set up like real operation: the stop hook files every message as raw
// capture, the retrieval hook searches on every next message. The best
// hit line for a similar question is then the user's own earlier
// question. What is measured is the share of such hits among what
// actually gets fed in (score >= threshold).
//
//   node eval/echo.mjs [--min 5] [--top 3] [--rephrased] [--per-capture N]
//
// CORRECTED 2026-09-06. The first version filed every earlier question
// as a `thought` entry and measured with `isEcho(question,
// compactLine(entry))`. Neither exists in real operation: the stop hook
// writes a gzip file under raw/, and the shipped filter
// (search.isEchoHit) sees ONLY raw capture, and within it only the
// captured text. The measurement therefore described a path nobody
// takes — and its result ("39 of 39 gone") was not a statement about
// what actually gets shipped.
//
// Measured against REAL material (483 raw captures from lucky-mem, 211
// hand-typed user messages as questions): 27 of 535 fed-in hits dropped
// = 5.0% (95%: 3.5-7.2%). 4 of 211 questions lose their entire context
// as a result, 17 lose part of it. That is the order of magnitude, not
// the 72% from the original finding.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import { build, rng } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { PROJECT } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 3);

// Question pool: the tasks plus variants plus everyday questions from a session.
const THEMEN = ['auslieferung', 'protokollierung', 'tests', 'suchfeld', 'rechte', 'bilder',
  'benachrichtigung', 'zeitplan', 'pakete', 'abhaengigkeiten', 'fehlerbilder', 'zwischenspeicher'];
const VORSPANN = ['Wie machen wir das mit', 'Was gilt bei', 'Kannst du kurz erklaeren, wie',
  'Ich haenge fest bei', 'Was war nochmal der Stand zu', 'Gibt es eine Festlegung zu'];
const NACHSPANN = ['?', ' im Projekt?', ' — kurz bitte.', ' und warum?'];

function questions(r, n) {
  const out = TASKS.map((t) => t.prompt);
  while (out.length < n) {
    const v = VORSPANN[Math.floor(r() * VORSPANN.length)];
    const t = THEMEN[Math.floor(r() * THEMEN.length)];
    const na = NACHSPANN[Math.floor(r() * NACHSPANN.length)];
    out.push(`${v} ${t}${na}`);
  }
  return out;
}

/**
 * Only for the sample in the output now. Counting is done with
 * search.isEchoHit — the same call `mem find` and the gateway make. A
 * measurement that invents its own rendering measures its own
 * rendering: an earlier version passed the raw JSON line, whose key
 * names push the overlap below the threshold, and reported 0 of 2532
 * echoes.
 */
function compactLine(e) {
  const parts = [];
  if (e.class) parts.push(`[${e.class}]`);
  if (e.topic) parts.push(`[${e.topic}]`);
  if (e.title) parts.push(e.title);
  if (e.choice) parts.push(`-> ${e.choice}`);
  if (e.text) parts.push(String(e.text).slice(0, 80).replace(/\s+/g, ' '));
  if (e.why) parts.push(`because ${String(e.why).slice(0, 60)}`);
  return parts.join(' - ') || '(no compact text)';
}

/** Wilson interval: more honest than normal-approx for shares near 0 or 1. */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

// Positive control. Without it a null result cannot be told apart from
// a broken probe.
{
  const q = 'Welchen Port trage ich fuer die Erreichbarkeitspruefung ein';
  const rohEcho = { type: 'raw', entry: { title: '[raw] a.jsonl.gz', text: q } };
  const rohFremd = { type: 'raw', entry: { title: '[raw] b.jsonl.gz',
    text: 'Der Zwischenspeicher wird nach sieben Tagen geleert, danach ist er kalt.' } };
  const getippt = { type: 'thought', entry: { title: q, text: q } };
  const a = search.isEchoHit(q, rohEcho), b = search.isEchoHit(q, rohFremd);
  // Third control: the filter must NOT touch typed entries.
  if (search.isEchoHit(q, getippt)) {
    console.log('Positive control: the filter engages on typed entries. Aborting.');
    process.exit(1);
  }
  console.log(`Positive control: real echo detected = ${a}, foreign hit as echo = ${b}`);
  if (!a || b) { console.log('  ==> The probe is not measuring what it should. Aborting.'); process.exit(1); }
}

/** Light rephrasing: add a filler word, drop a content word, keep order. */
function rephrase(q, r) {
  const w = q.split(/\s+/).filter(Boolean);
  if (w.length > 4) w.splice(Math.floor(r() * (w.length - 1)) + 1, 1);
  const zusatz = ['nochmal kurz', 'ich vergesse das immer', 'zur Sicherheit', 'sag mir bitte'];
  return `${zusatz[Math.floor(r() * zusatz.length)]}: ${w.join(' ')}`;
}

const MODE = process.argv.includes('--rephrased') ? 'rephrased' : 'verbatim';
const PER_CAPTURE = Math.max(1, arg('per-capture', 1));
const samples = [];

/** Writes the questions as real raw captures, `per` messages per file. */
function fileCaptures(root, pool, per) {
  const dir = path.join(root, 'raw', '2026', '09');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < pool.length; i += per) {
    const chunk = pool.slice(i, i + per);
    const lines = chunk.map((q, k) => JSON.stringify({
      ts: `2026-09-0${1 + (i % 5)}T10:${String(k % 60).padStart(2, '0')}:00Z`,
      role: 'user', text: q,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `2026-09-01T10-00-${String(i % 60).padStart(2, '0')}Z--f${i}.jsonl.gz`),
      zlib.gzipSync(lines));
  }
}
console.log(`Mode: ${MODE}   threshold ${MIN}, top ${TOP}, ${PER_CAPTURE} message(s) per capture\n`);
console.log('Memory | Questions | Retrievals | fed-in hits | Echoes | Rate  | 95% interval');
console.log('-------+-----------+------------+-------------+--------+-------+----------------');

const rows = [];
for (const size of [50, 200, 600]) {
  const r = rng(11);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-echo-'));
  build(root, { poisoned: false, noise: Math.max(1, Math.round(size / 25)), seed: 11 });
  const pool = questions(r, size);
  // Raw capture, the way the stop hook files it: gzip-JSONL under
  // raw/YYYY/MM/. `--per-capture N` puts N messages into ONE file, like
  // a real session. That is not a detail: a capture with twelve messages
  // is ONE document, and the overlap with a single question drops
  // accordingly. The default of 1 is the ceiling, not everyday reality.
  fileCaptures(root, pool, PER_CAPTURE);

  const idx = search.buildIndex(root);
  let hits_ = 0, echoes = 0, retrievals = 0;
  const byLength = new Map();
  // TWO conditions, and the difference matters:
  //   'verbatim'   the same question again — the CEILING, not everyday reality
  //   'rephrased'  asked similarly — what the comment in search.mjs
  //                actually describes ("something similar is asked")
  // A measurement using only verbatim questions overestimates the effect.
  const phrase = (q) => (MODE === 'verbatim' ? q : rephrase(q, r));
  for (const q0 of pool) {
    const q = phrase(q0);
    retrievals += 1;
    const found = search.search(idx, q, { top: TOP }).filter((h) => h.score >= MIN);
    const bucket = q.length < 60 ? 'short' : q.length < 110 ? 'medium' : 'long';
    const b = byLength.get(bucket) ?? { t: 0, e: 0 };
    for (const h of found) {
      hits_ += 1; b.t += 1;
      if (search.isEchoHit(q, h)) {
        echoes += 1; b.e += 1;
        if (samples.length < 3) samples.push([q, String(h.entry.text ?? compactLine(h.entry))]);
      }
    }
    byLength.set(bucket, b);
  }
  const [lo, hi] = wilson(echoes, hits_);
  console.log(`${String(idx.documents.length).padStart(6)} | ${String(pool.length).padStart(9)} | ${String(retrievals).padStart(10)} | ${String(hits_).padStart(11)} | ${String(echoes).padStart(6)} | ${(echoes / Math.max(1, hits_) * 100).toFixed(1).padStart(5)}% | ${(lo * 100).toFixed(1)}% - ${(hi * 100).toFixed(1)}%`);
  rows.push({ size: idx.documents.length, hits: hits_, echoes, byLength });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\nBy question length (all memory sizes combined):');
const totals = new Map();
for (const z of rows) for (const [k, v] of z.byLength) {
  const g = totals.get(k) ?? { t: 0, e: 0 }; g.t += v.t; g.e += v.e; totals.set(k, g);
}
for (const [k, v] of [...totals].sort()) {
  const [lo, hi] = wilson(v.e, v.t);
  console.log(`  ${k.padEnd(7)} ${String(v.e).padStart(4)}/${String(v.t).padStart(4)} = ${(v.e / Math.max(1, v.t) * 100).toFixed(1).padStart(5)}%  (${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%)`);
}
const T = rows.reduce((n, z) => n + z.hits, 0);
const E = rows.reduce((n, z) => n + z.echoes, 0);
const [lo, hi] = wilson(E, T);
console.log(`\nTotal: ${E}/${T} = ${(E / T * 100).toFixed(1)}%  95% interval ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%`);
console.log(`For comparison, the original finding: 13/18 = 72.2%  (n=18, one session)`);
const [olo, ohi] = wilson(13, 18);
console.log(`  its 95% interval would be: ${(olo * 100).toFixed(1)}%-${(ohi * 100).toFixed(1)}% — at n=18, nearly worthless.`);
