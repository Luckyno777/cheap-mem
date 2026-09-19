// Raw captures must not decide what counts as a rare word.
//
// Through the stop hook cheap-mem stores EVERY message as a raw
// capture. That is a transcript, not a statement — and it is exactly
// the material that makes the words of the most frequent questions
// frequent. Let it drive idf and the curated entry loses its lead over
// topical neighbours, precisely for the questions asked most often. So
// the memory gets worse exactly where it is used most.
//
// That raw captures should not shape the statistics was already decided
// in search.mjs — `termGraph` excludes them. `docFreq`, `N` and
// `avgLength` did not, until 2026-09-06.
//
// Measured on the eval corpus: 39 raw captures carrying the question
// words drop gold-in-context from 11/33 to 8/33, without a single
// receipt being issued — the gold never even becomes a candidate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');
const QUESTION = 'wie halten wir die ablage im repository nachvollziehbar';

function build({ captures = 0 } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stat-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, 'decision',
    { ...d, author: 'lucky', authority: 'user' });

  log({ id: 'ANTWORT', topic: 'ablage',
    choice: 'die ablage bleibt im repository, nachvollziehbar ueber die historie',
    why: 'ein dienst, den niemand wartet, ist teurer als eine datei' });
  for (const t of ['protokoll', 'tests', 'rechte', 'bilder', 'zeitplan', 'meldung']) {
    for (let i = 0; i < 4; i += 1) {
      log({ id: `X-${t}-${i}`, topic: t, choice: `zu ${t} gilt fassung ${i}`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert` });
    }
  }
  // Neighbours brushing the same words — without them the answer wins
  // even when idf collapses completely.
  for (let i = 0; i < 6; i += 1) {
    log({ id: `NACHBAR-${i}`, topic: 'ablage',
      choice: `ablage und repository runde ${i}, ohne festlegung`,
      why: `damals war tempo das thema, nicht die historie ${i}` });
  }

  if (captures) {
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < captures; i += 1) {
      const line = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user', text: QUESTION });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--f${i}.jsonl.gz`),
        zlib.gzipSync(`${line}\n`));
    }
  }
  return r;
}

// Searched the way production searches: MMR on, with the same lambda
// `mem find` and the gateway use. Without that, 40 identical raw
// captures fill the list and the comparison would have no curated
// entries left to compare.
const curated = (root) => search
  .search(search.buildIndex(root, { language: 'de' }), QUESTION,
    { top: 100, mmr: true, mmrLambda: 0.7 })
  .filter((h) => h.type !== 'raw')
  .map((h) => h.entry?.id);

test('raw captures do not change the order of the curated entries', () => {
  const without = build();
  const with_ = build({ captures: 40 });
  try {
    const a = curated(without);
    const b = curated(with_);
    // Positive control: without raw captures the answer has to win at
    // all, otherwise the comparison below weighs two equally bad lists.
    assert.equal(a[0], 'ANTWORT', `the fixture does not find the answer: ${a.slice(0, 3).join(' ')}`);
    assert.deepEqual(b, a,
      `40 raw captures shifted the curated order:\n  without: ${a.slice(0, 5).join(' ')}\n  with:    ${b.slice(0, 5).join(' ')}`);
  } finally {
    fs.rmSync(without, { recursive: true, force: true });
    fs.rmSync(with_, { recursive: true, force: true });
  }
});

test('the curated counts count exactly the curated entries', () => {
  // Checked against the contract directly, not only through the effect.
  // `statsN` feeds idf and `statsAvgLength` the length normalisation;
  // neither may count raw captures, even where the resulting shift in
  // order is not visible in every corpus.
  const r = build({ captures: 40 });
  try {
    const idx = search.buildIndex(r, { language: 'de' });
    const rawDocs = idx.documents.filter((d) => d.type === 'raw').length;
    assert.equal(rawDocs, 40, `not all captures are in the index: ${rawDocs}`);
    assert.equal(idx.statsN, idx.N - rawDocs,
      `statsN counts raw captures: ${idx.statsN} instead of ${idx.N - rawDocs}`);
    assert.ok(idx.statsAvgLength !== idx.avgLength,
      'statsAvgLength is identical to avgLength — raw captures are still in it');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the append path keeps fresh raw captures out of the statistics too', () => {
  // The path production really takes: the index sits in the cache, the
  // stop hook drops a new capture, `loadIndex` appends it without
  // rebuilding. A full build that gets it right and an append path that
  // gets it wrong would be the same gap as before: correct as long as
  // nobody looks, wrong in every session.
  const r = build();
  try {
    const before = search.loadIndex(r, { fresh: true, language: 'de' });
    const nCurated = before.statsN;
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    // Few captures, on purpose: too many at once trigger a full
    // rebuild, and then this test does not exercise the path it is
    // about. A first version dropped forty and was green without ever
    // entering the append path.
    for (let i = 0; i < 3; i += 1) {
      const line = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user', text: QUESTION });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--a${i}.jsonl.gz`),
        zlib.gzipSync(`${line}\n`));
    }
    const after = search.loadIndex(r, { language: 'de' });
    // Positive control, in two parts: the captures have to be in the
    // index AND to have arrived through the append path, not a rebuild.
    assert.ok(after.N > before.N,
      `the captures never made it into the index: ${before.N} -> ${after.N}`);
    assert.ok(after.fromCache && after.appended > 0,
      `no append path: fromCache=${after.fromCache}, appended=${after.appended}`);
    assert.equal(after.statsN, nCurated,
      `the append path counted raw captures: ${nCurated} -> ${after.statsN}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('raw captures do not decide which eight words carry the question', () => {
  // The same rule one level up — and here it weighs more. BM25 shifts a
  // rank; `retrievalQuery` throws a word away ENTIRELY: out of a long
  // question the eight rarest content words remain. If the carrying
  // word is frequent in the raw captures it drops out, and the search
  // asks for something other than what the user asked.
  const LONG_QUESTION = 'welche festlegung gilt eigentlich fuer den kanarienvogel bei der'
    + ' redaktion der ablage im repository der auswertung';
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-frage-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    const log = (d) => memory.logEntry(r, 'decision',
      { ...d, author: 'lucky', authority: 'user' });
    log({ id: 'ANTWORT', topic: 'redaktion',
      choice: 'der kanarienvogel laeuft vor jedem fang',
      why: 'lieber eine luecke als ein geheimnis in der historie' });
    for (let i = 0; i < 30; i += 1) {
      log({ id: `N-${i}`, topic: 'ablage',
        choice: `zur ablage der auswertung im repository gilt festlegung ${i}`,
        why: `redaktion war damals kein thema, sondern tempo ${i}` });
    }
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      const zeile = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user',
        text: `kanarienvogel kanarienvogel gespraech ${i}` });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--k${i}.jsonl.gz`),
        zlib.gzipSync(`${zeile}\n`));
    }
    const idx = search.buildIndex(r, { language: 'de' });

    // Positive control: with the full counts the word MUST drop out.
    // Otherwise the assertion below checks a case that does not exist.
    const old = search.retrievalQuery(LONG_QUESTION, { index: { ...idx, statsDocFreq: null } });
    assert.ok(!old.includes('kanarienvogel'),
      `the fixture does not produce the damage at all: ${JSON.stringify(old)}`);

    const now = search.retrievalQuery(LONG_QUESTION, { index: idx });
    assert.ok(now.includes('kanarienvogel'),
      `the carrying word fell out of the question: ${JSON.stringify(now)}`);
    const hits = search.search(idx, now, { top: 5, mmr: true, mmrLambda: 0.7 });
    assert.ok(hits.some((h) => h.entry?.id === 'ANTWORT'),
      `the answer is no longer in the top 5: ${hits.map((h) => h.entry?.id ?? h.type).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('raw captures are still found — they only do not shape the statistics', () => {
  // The counter-check to the assertion above. Statistics without raw
  // captures must not mean raw captures become unfindable: on a fresh
  // memory they are often the only material there is.
  const r = build({ captures: 3 });
  try {
    const hits = search.search(search.buildIndex(r, { language: 'de' }), QUESTION, { top: 10 });
    assert.ok(hits.some((h) => h.type === 'raw'),
      `no raw capture among the hits: ${hits.map((h) => h.entry?.id ?? h.type).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a memory made only of raw captures falls back to the full counts', () => {
  // Otherwise statsN would be zero and every idf infinite.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stat-nur-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      const line = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user',
        text: `${QUESTION} teil ${i}` });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--n${i}.jsonl.gz`),
        zlib.gzipSync(`${line}\n`));
    }
    const idx = search.buildIndex(r, { language: 'de' });
    assert.equal(idx.statsN, idx.N, 'without curated entries the full counts have to apply');
    const hits = search.search(idx, QUESTION, { top: 5 });
    assert.ok(hits.length > 0, 'a raw-only memory finds nothing at all any more');
    assert.ok(Number.isFinite(hits[0].score), `score is not finite: ${hits[0].score}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --- Why the first test above used to go red by itself ---------------
//
// **The finding, 2026-09-19.** The first test in this file failed about
// once in sixty runs, and the two lists it compares differed only in the
// order of the six NACHBAR entries — the same six that the tie-break
// finding of 2026-09-17 is about. That earlier finding took the decision
// away from `Math.log` and gave it to `stableKey`. It did not arrive,
// because a much larger noise was still reaching the comparison first.
//
// Measured: `logEntry` stamps `ts` at second resolution, the fixture
// writes its 31 entries within a third of a second, and whenever a
// second boundary happens to fall between two of those writes the
// entries after it carry a ts one second newer. The recency bonus turned
// that second into a relative score difference of about 1.9e-8 — far
// above the MMR tie window, so it decided the order. Since `without` and
// `with_` are built moments apart, the boundary lands at a different
// index in each, and the test then blamed the raw captures for a
// difference its own clock had made. A gate that reports the innocent
// gets switched off.
//
// Reproduced deterministically by walking the boundary through the
// fixture: every position inside the NACHBAR block rotated the six.
//
// The fix is in `search()`: the age is counted in whole UTC days on both
// sides. The two probes below hold it in place.

test('two entries written the same day score exactly equal', () => {
  // The probe. Same text, timestamps one second apart, same UTC day.
  // The scores have to be equal to the last bit, so that nothing but
  // `stableKey` can decide the order — which is what makes the answer
  // independent of the second a write happened to land in.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stat-tag-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    const log = (id, ts) => memory.logEntry(r, 'decision',
      { id, ts, topic: 'ablage', choice: 'ablage und repository',
        why: 'historie', author: 'lucky', authority: 'user' });
    log('SPAETER', '2026-09-18T23:59:59Z');
    log('FRUEHER', '2026-09-18T00:00:00Z');
    const hits = search.search(search.buildIndex(r, { language: 'de' }),
      'ablage repository', { top: 10 });
    assert.equal(hits.length, 2, `not both entries came back: ${hits.length}`);
    assert.equal(hits[0].score, hits[1].score,
      'almost 24 hours inside one day still moved the score: '
      + `${hits[0].score} against ${hits[1].score} — the second of a write `
      + 'decides the order again');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a real difference in days still decides', () => {
  // The sabotage counter-probe. Quantising to days would be cheap green
  // if it had simply turned the recency bonus off. Same two entries, now
  // a hundred days apart: the newer one has to win, and by a margin that
  // is visible rather than in the last bits.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stat-alt-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    const log = (id, ts) => memory.logEntry(r, 'decision',
      { id, ts, topic: 'ablage', choice: 'ablage und repository',
        why: 'historie', author: 'lucky', authority: 'user' });
    log('ALT', '2026-06-01T10:00:00Z');
    log('NEU', '2026-09-18T10:00:00Z');
    const hits = search.search(search.buildIndex(r, { language: 'de' }),
      'ablage repository', { top: 10 });
    assert.equal(hits[0].entry?.id, 'NEU',
      `the newer entry no longer wins: ${hits.map((h) => h.entry?.id).join(' ')}`);
    assert.ok(hits[0].score / hits[1].score > 1.001,
      `the recency bonus has gone flat: ${hits[0].score} against ${hits[1].score}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
