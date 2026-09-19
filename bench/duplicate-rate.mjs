// bench/duplicate-rate.mjs — does the digest write variants of the same
// finding, or does it consolidate?
//
// **Why the number was missing.** `DIGEST.md` instructs the digest to
// check with `mem find` before writing. Whether it DOES was unevidenced
// in both directions on 2026-09-08 — and without this number there is no
// deciding whether reconsolidation is a problem here at all. Mem0 solves
// the same thing with one model call per fact; that only pays off if the
// cheap variant measurably fails.
//
// **How this measures, and what it is NOT.** Near-duplicates without a
// model: word-set similarity (Jaccard) over title and text, after
// normalisation. That finds rewordings of the same sentence. It does NOT
// find two entries saying the same thing in entirely different words —
// that would need embeddings, and then you are measuring the embedding
// as well.
//
// A hit is therefore a SUSPICION, not a verdict. The output prints the
// pairs so a human decides.
//
// Usage:
//   node bench/duplicate-rate.mjs [--root <path>] [--min 0.6] [--show 15]

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(flag('root') ?? process.env.CHEAP_MEM_ROOT ?? process.cwd());
const MIN = Number(flag('min', '0.6'));
const SHOW = Number(flag('show', '15'));

const files = [];
(function walk(d) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(ROOT);

// DATA, not prose: the German stop words stay on purpose, next to the
// English ones. A memory may be written in German — the sibling house
// lucky-mem is — and a similarity measure that only strips English
// filler would score two German entries on their articles. Same reason
// `src/thesaurus.mjs` holds German words: the tool is English-facing,
// the memories it measures need not be.
const STOP = new Set(('der die das und oder ein eine einen dem den des ist sind war waren '
  + 'nicht auch noch nur schon dass wie wenn aber im in an auf fuer von zu mit bei aus '
  + 'the a an and or is are was were not only that this with for from to of in on at it')
  .split(' '));

const entries = [];
for (const f of files) {
  // Raw captures out: they are uncurated transcripts in which everything
  // repeats. Counting them measures how people talk, not how the digest
  // writes. Both houses' directory names are matched, for the same
  // reason the stop list is bilingual.
  if (/(^|\/)(raw|captures|rohfang|faenge)\//.test(f)) continue;
  // Mappings are not findings. An alias entry and a link both carry a
  // REASON, and four aliases of one topic share it entirely rightly. On
  // the first run, 2026-09-08, those were exactly the most similar pairs
  // — the raw number would have accused the digest of something that is
  // not a defect.
  if (/(aliasse|aliases|verknuepfungen|links)\.jsonl$/.test(f)) continue;
  const rel = path.relative(ROOT, f);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    const text = [e.title, e.titel, e.text, e.choice, e.wahl, e.why, e.warum]
      .filter(Boolean).join(' ').toLowerCase();
    const words = new Set(text.replace(/[^a-z0-9äöüß ]+/gi, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)));
    // Entries that are too short are out: at five content words Jaccard
    // becomes coin-flipping, and the rate would be an artefact of the
    // threshold rather than a property of the corpus.
    if (words.size < 8) continue;
    entries.push({ source: `${rel}:${i + 1}`, id: e.id ?? null, ts: e.ts ?? '', words, text });
  }
}

const pairs = [];
for (let i = 0; i < entries.length; i += 1) {
  for (let j = i + 1; j < entries.length; j += 1) {
    const a = entries[i].words; const b = entries[j].words;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    if (!shared) continue;
    const jac = shared / (a.size + b.size - shared);
    if (jac >= MIN) pairs.push({ j: jac, a: entries[i], b: entries[j] });
  }
}
pairs.sort((x, y) => y.j - x.j);

const affected = new Set();
for (const p of pairs) { affected.add(p.a.source); affected.add(p.b.source); }

// An empty corpus would otherwise report "0 suspicious pairs, 0.0 %",
// which READS as "no duplicates" and MEANS "nothing measured". Exactly
// the class this repo builds against, in its own instrument.
if (entries.length < 2) {
  console.log(`Nothing to measure: ${entries.length} digested entries with enough `
    + `content (out of ${files.length} files) under ${ROOT}.`);
  console.log('That is NOT a finding about duplicates — it is the statement');
  console.log('that this corpus is too small for the question.');
  process.exit(0);
}

console.log(`${entries.length} digested entries with enough content (out of ${files.length} files)`);
console.log(`Threshold Jaccard >= ${MIN}\n`);
console.log(`Suspicious pairs:        ${pairs.length}`);
console.log(`Entries affected:        ${affected.size}`
  + `  (${((affected.size / (entries.length || 1)) * 100).toFixed(1)}%)\n`);

if (!pairs.length) {
  console.log('No near-duplicates. The digest consolidates — against rewording,');
  console.log('at least. About the same thing said in entirely different words');
  console.log('this measurement says nothing.');
} else {
  console.log(`The ${Math.min(SHOW, pairs.length)} most similar pairs — suspicion, not verdict:\n`);
  for (const p of pairs.slice(0, SHOW)) {
    console.log(`  ${p.j.toFixed(2)}  ${p.a.source}  <->  ${p.b.source}`);
    console.log(`        A: ${p.a.text.slice(0, 100)}`);
    console.log(`        B: ${p.b.text.slice(0, 100)}\n`);
  }
}
