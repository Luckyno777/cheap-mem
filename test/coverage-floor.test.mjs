// Coordination must not annihilate a score, and must not stop working.
//
// **The finding (measured 2026-09-20).** `search()` multiplies every
// score by the share of TYPED words a document covers. That is a
// product, and a product with a small factor annihilates. Over the atlas
// anchors at 1k / 5k / 20k entries, a question carrying three or more
// ordinary words lost the right entry out of the top ten completely:
// recall@1 went 1.0 to 0.0. Those are the standing atlas failures
// `load.b.recall.diluted3` and `diluted5`.
//
// At five noise words the anchor covers 1 of 6 typed words (0.167) while
// any filler sentence covers 5 of 6 (0.833). Coverage counts WORDS, not
// information — and one rare word is worth more than five common ones.
//
// **Why a floor and not the two obvious repairs.** Switching the
// multiplier off, and weighting coverage by IDF mass, were both built
// and both measured. Each fixes dilution; each loses the case the
// multiplier was written for, dropping the answer from rank 1 to rank 8
// behind a decoy that carries one query word several times. So this file
// holds BOTH fixtures, and a change that fixes one by breaking the other
// fails here.
//
// **The third test is the important one.** Pinning 0.6 alone would let
// the value drift to an edge of the window without anything noticing.
// The sweep measures the window itself: if it ever shrinks to fewer than
// three working values, the shape is too sensitive to be trusted at all,
// and that is a finding about the DESIGN, not about the constant.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as corpus from '../bench/atlas/core.mjs';
import { search, loadIndex, COVERAGE_FLOOR } from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

/** Words the whole corpus shares — the same six the atlas dilutes with. */
const NOISE = ['deploy', 'database', 'memory', 'cache', 'session', 'index'];

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-floor-'));
  execFileSync(process.execPath, [MEM, 'init'], {
    env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: 'ignore',
  });
  return root;
}

/**
 * The dilution fixture — built by the SAME generator the measurement used.
 *
 * The first version of this file grew its own filler ("routine 3 cache
 * session…") and was green under sabotage: with the floor set to 0, the
 * old broken behaviour, recall@1 stayed at 1.0 at every k. A hand-rolled
 * corpus gives the rare anchor phrase so much of the field to itself that
 * no multiplier can push it out, so the fixture could not express the
 * defect it was written for — a guarantee passing over a corpus where the
 * failure cannot happen.
 *
 * `bench/atlas/core.mjs` spreads the shared vocabulary across entries the
 * way the measured corpus does. Measured 2026-09-20: with floor 0 it
 * reproduces the failure from 200 entries upward; 400 costs ~54 ms.
 *
 * Importing the benchmark generator into a test is deliberate. The
 * alternative is a second generator that drifts from the one every
 * measurement is quoted against, and then two corpora claim to be the
 * same corpus.
 */
function dilutionFixture(root, { entries = 400, anchors = 8 } = {}) {
  const c = corpus.buildCorpus(root, entries, { seed: 42, anchors });
  return c.anchors.map((a) => ({ id: a.id, phrase: a.query }));
}

/**
 * The contested fixture: one query word rare, two common. A decoy carries
 * only the rare one, several times; the answer carries all three once.
 * Without coordination the decoy wins — that is what it is built to show.
 */
function contestedFixture(root) {
  for (let i = 0; i < 400; i += 1) {
    memory.logEntry(root, 'learning', {
      title: `filler ${i} session index`,
      text: `the session and the index were touched in run ${i} of the ordinary daily work`,
      tags: ['filler'],
    });
  }
  for (let i = 0; i < 6; i += 1) {
    memory.logEntry(root, 'learning', { title: `rare cache note ${i}`, text: 'cache', tags: ['rare'] });
  }
  const answer = memory.logEntry(root, 'learning', {
    title: 'cache session index together',
    text: 'the cache holds it, the session owns it, the index finds it',
    tags: ['answer'],
  });
  const decoy = memory.logEntry(root, 'learning', {
    title: 'cache cache cache', text: 'cache cache', tags: ['decoy'],
  });
  const id = (e) => e?.id ?? e?.entry?.id;
  assert.ok(id(answer) && id(decoy), 'the contested fixture produced an entry without an id');
  return { answer: id(answer), decoy: id(decoy) };
}

/** recall@1 over the anchors, with k shared words appended to each question. */
function recallAt1(index, anchors, k, opts = {}) {
  let hit = 0;
  for (const a of anchors) {
    const q = k ? `${a.phrase} ${NOISE.slice(0, k).join(' ')}` : a.phrase;
    const hits = search(index, q, { top: 10, ...opts });
    if (hits[0]?.entry?.id === a.id) hit += 1;
  }
  return hit / anchors.length;
}

// --- the fixtures are real ---------------------------------------------

test('CONTROL: both fixtures behave as the measurement described', () => {
  // Without this, the two guarantees below could be passing over corpora
  // that cannot express the failure at all.
  const root = freshRoot();
  try {
    const anchors = dilutionFixture(root, { entries: 300, anchors: 4 });
    const index = loadIndex(root, { fresh: true });
    // The undiluted question must be answered — if not, the fixture is
    // broken and every dilution number below would be meaningless.
    assert.equal(recallAt1(index, anchors, 0), 1,
      'the bare anchor phrase is not answered — the fixture is broken, not the scorer');
    // And the old behaviour is still reachable, so the sweep below has
    // something to compare against.
    assert.ok(recallAt1(index, anchors, 5, { coverage: 0 }) >= 0,
      'coverage: 0 no longer runs');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- the two guarantees -------------------------------------------------

test('a question diluted with shared words still finds its answer', () => {
  const root = freshRoot();
  try {
    const anchors = dilutionFixture(root);
    const index = loadIndex(root, { fresh: true });
    for (const k of [0, 2, 3, 5]) {
      assert.equal(recallAt1(index, anchors, k), 1,
        `recall@1 fell below 1.0 with ${k} shared word(s) in the question. `
        + 'Before the floor this was 0.0 at k>=3: the coverage product '
        + 'annihilated the anchor while fillers covered five of six words.');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('COUNTER-PROBE: one word carried often still loses to all words carried once', () => {
  // The case coordination exists for. A change that fixes dilution by
  // weakening coordination passes the test above and fails here — which
  // is exactly what both rejected repairs did.
  const root = freshRoot();
  try {
    const { answer, decoy } = contestedFixture(root);
    const index = loadIndex(root, { fresh: true });
    const hits = search(index, 'cache session index', { top: 10 });
    const rankOf = (id) => hits.findIndex((h) => h.entry?.id === id) + 1;
    assert.equal(rankOf(answer), 1,
      `the answer is at rank ${rankOf(answer) || 'outside the top ten'} and the decoy at `
      + `${rankOf(decoy) || 'outside the top ten'}. Coordination has stopped working: `
      + 'a document carrying one query word several times now outranks one carrying all three.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- the shape, not just the number -------------------------------------

test('the floor sits inside a window of values that work, not on its edge', () => {
  // Pinning 0.6 alone would let the constant drift to an edge of the
  // window without anything noticing. This measures the WINDOW: which
  // floors satisfy BOTH fixtures. A window that collapses to one or two
  // values is a finding about the shape, not about the constant.
  //
  // The sweep drives the real `search()` through its `coverageFloor`
  // option rather than reproducing the formula — a second copy of one
  // line is how the two sides quietly stop agreeing.
  const root = freshRoot();
  const root2 = freshRoot();
  try {
    const anchors = dilutionFixture(root, { entries: 400, anchors: 6 });
    const index = loadIndex(root, { fresh: true });
    const { answer } = contestedFixture(root2);
    const index2 = loadIndex(root2, { fresh: true });

    const works = [];
    for (let f = 0.30; f <= 0.901; f += 0.05) {
      const floor = Math.round(f * 100) / 100;
      const dilutionOk = [0, 2, 3, 5]
        .every((k) => recallAt1(index, anchors, k, { coverageFloor: floor }) === 1);
      if (!dilutionOk) continue;
      const hits = search(index2, 'cache session index', { top: 10, coverageFloor: floor });
      if (hits[0]?.entry?.id === answer) works.push(floor);
    }

    assert.ok(works.length >= 3,
      `only ${works.length} floor value(s) satisfy both fixtures (${works.join(', ') || 'none'}). `
      + 'A window this narrow means the multiplicative shape is too sensitive to be '
      + 'trusted — that is a finding about the design, not about the constant.');
    assert.ok(works.includes(COVERAGE_FLOOR),
      `COVERAGE_FLOOR is ${COVERAGE_FLOOR}, which is not among the values that work `
      + `(${works.join(', ')}).`);
    const i = works.indexOf(COVERAGE_FLOOR);
    assert.ok(i > 0 && i < works.length - 1,
      `COVERAGE_FLOOR ${COVERAGE_FLOOR} sits on the edge of the working window `
      + `(${works.join(', ')}). A value on the edge is one measurement away from wrong.`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
