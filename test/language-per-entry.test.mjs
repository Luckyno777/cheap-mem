// test/language-per-entry.test.mjs — P28, end to end.
//
// `test/langdetect.test.mjs` checks the detector in isolation; this file
// checks the thing that actually matters — RECALL — on real indexes
// built through `buildIndex`/`search`, exactly as a memory would use
// them. Every guarantee here carries its own sabotage: the fixture is
// shown to fail (RED) under the pre-P28 behaviour, then to pass (GREEN)
// under the real one, both measured, both reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { buildIndex, search, fieldsOfEntry } from '../src/search.mjs';
import { pack } from '../src/language.mjs';

function corpus(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lang-entry-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const ids = [];
  for (const [type, data] of entries) ids.push(memory.logEntry(root, type, data).entry.id);
  return { root, ids };
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

/**
 * The sabotage: rebuild the SAME index the pre-P28 code produced — one
 * language pack for every document, no exceptions — using nothing but
 * exported primitives. `if (false && ...)`, not `git checkout`: this
 * reproduces the historical defect on purpose so the guarantee below
 * can be shown failing under it, without touching `search.mjs` itself
 * or any version control command.
 *
 * `buildIndex(root, {language: code})` already computes a lexicon for
 * EVERY detectable language (P28 needs both to hedge the UNCERTAIN
 * case) — reused here rather than rebuilt, so the only thing this
 * function changes is which pack tokenises each document.
 */
function forceLanguage(root, code) {
  const base = buildIndex(root, { language: code });
  const forced = pack(code);
  const lexicon = base.lexicons.get(code) ?? new Set();
  const docFreq = new Map();
  const statsDocFreq = new Map();
  let lengthSum = 0;
  let statsLengthSum = 0;
  let statsN = 0;
  const documents = base.documents.map((d) => {
    const weights = fieldsOfEntry(d.entry, { lang: forced, lexicon });
    let length = 0;
    for (const w of weights.values()) length += w;
    lengthSum += length;
    for (const t of weights.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    if (d.type !== 'raw') {
      statsN += 1;
      statsLengthSum += length;
      for (const t of weights.keys()) statsDocFreq.set(t, (statsDocFreq.get(t) ?? 0) + 1);
    }
    return { ...d, lang: code, langCertain: true, weights, length };
  });
  return {
    ...base,
    documents,
    docFreq,
    statsDocFreq,
    avgLength: documents.length ? lengthSum / documents.length : 1,
    statsAvgLength: statsN ? statsLengthSum / statsN : 1,
    N: documents.length,
    statsN: statsN || documents.length,
  };
}

function recallAt1(index, anchors) {
  let hit = 0;
  for (const a of anchors) {
    const hits = search(index, a.query, { top: 5 });
    if (hits[0]?.entry?.id === a.id) hit += 1;
  }
  return hit / anchors.length;
}

// --- The mixed corpus ----------------------------------------------------
//
// Filler entries carry real stopwords so they detect CERTAIN — a
// realistic memory is mostly ordinary prose, not identifiers — and the
// anchors are chosen so the WRONG stemmer provably fails to find them
// (verified against `src/language.mjs` directly, not assumed): an
// English inflection whose stem only collapses under English rules, and
// a German inflection (one of them a compound) whose stem or split only
// works under German rules.
function mixedFixtures() {
  const enFiller = [
    ['learning', { title: 'the deploy hook keeps failing on the second retry', why: 'a timeout was too short' }],
    ['learning', { title: 'the dashboard shows numbers from yesterday', why: 'the cache was never invalidated' }],
    ['learning', { title: 'a feature flag was still on in production', why: 'the cleanup was never done' }],
    ['learning', { title: 'the login form rejected a valid password', why: 'a trailing space was not trimmed' }],
  ];
  const deFiller = [
    ['learning', { title: 'der Cache lief waehrend des Batch-Laufs voll', why: 'niemand hatte die Groesse gemessen' }],
    ['learning', { title: 'das Dashboard zeigt veraltete Zahlen an', why: 'der Cache wurde nie geleert' }],
    ['learning', { title: 'ein altes Feature-Flag war noch aktiv', why: 'die Aufgabe wurde nie erledigt' }],
  ];

  const enAnchors = [
    { title: 'the export job is still running two hours after it started', query: 'run' },
    { title: 'restarting the ingestion service cleared the stuck queue', query: 'restart' },
    { title: 'the retry handlers were skipped four times in a row', query: 'handler' },
    { title: 'three workers crashed during the nightly batch', query: 'worker' },
    { title: 'loading the config on startup now takes twice as long', query: 'load' },
  ];
  // Compound splitting for German already has its own dedicated test
  // ('German compounds split against a lexicon built from the corpus'
  // in test/search.test.mjs) — not reproduced here, per the brief's own
  // "no second source of truth". These five are plain suffix inflections,
  // each verified against the CONTROL test above.
  const deAnchors = [
    { title: 'die Anmeldungen wurden diese Woche nicht bestaetigt', query: 'anmeldung' },
    { title: 'die Einladungen sind noch nicht verschickt worden', query: 'einladung' },
    { title: 'mehrere Meldungen sind ueber Nacht liegen geblieben', query: 'meldung' },
    { title: 'die Sicherungen liefen letzte Nacht nicht durch', query: 'sicherung' },
    { title: 'die Rechnungen wurden noch nicht verschickt', query: 'rechnung' },
  ];

  const entries = [...enFiller, ...deFiller];
  const enEntries = enAnchors.map((a) => ['learning', { title: a.title }]);
  const deEntries = deAnchors.map((a) => ['learning', { title: a.title }]);
  entries.push(...enEntries, ...deEntries);

  const { root, ids } = corpus(entries);
  const anchorStart = enFiller.length + deFiller.length;
  const enIds = ids.slice(anchorStart, anchorStart + enAnchors.length);
  const deIds = ids.slice(anchorStart + enAnchors.length);
  return {
    root,
    enAnchors: enAnchors.map((a, i) => ({ ...a, id: enIds[i] })),
    deAnchors: deAnchors.map((a, i) => ({ ...a, id: deIds[i] })),
  };
}

// **Positive control (2026-09-20).** Before trusting any recall number
// below, confirm the anchor words really do stem differently under the
// two packs — otherwise a passing "sabotage turns it red" test could be
// vacuous (nothing to break in the first place).
test('CONTROL: the anchor pairs really do diverge between the two stemmers', () => {
  const en = pack('en');
  const de = pack('de');
  const enPairs = [['running', 'run'], ['restarting', 'restart'], ['handlers', 'handler'],
    ['workers', 'worker'], ['loading', 'load']];
  for (const [inflected, base] of enPairs) {
    assert.equal(en.stem(en.normalize(inflected)), en.stem(en.normalize(base)),
      `EN stemmer does not collapse "${inflected}" onto "${base}" — the fixture is broken`);
    assert.notEqual(de.stem(de.normalize(inflected)), de.stem(de.normalize(base)),
      `DE stemmer ALSO collapses "${inflected}" onto "${base}" — this pair proves nothing`);
  }
  const dePairs = [['Anmeldungen', 'Anmeldung'], ['Einladungen', 'Einladung'],
    ['Meldungen', 'Meldung'], ['Sicherungen', 'Sicherung'], ['Rechnungen', 'Rechnung']];
  for (const [inflected, base] of dePairs) {
    assert.equal(de.stem(de.normalize(inflected)), de.stem(de.normalize(base)),
      `DE stemmer does not collapse "${inflected}" onto "${base}" — the fixture is broken`);
    assert.notEqual(en.stem(en.normalize(inflected)), en.stem(en.normalize(base)),
      `EN stemmer ALSO collapses "${inflected}" onto "${base}" — this pair proves nothing`);
  }
});

test('a mixed corpus: recall@1 is equally good for both languages', () => {
  const { root, enAnchors, deAnchors } = mixedFixtures();
  try {
    const index = buildIndex(root);
    const enRecall = recallAt1(index, enAnchors);
    const deRecall = recallAt1(index, deAnchors);
    assert.equal(enRecall, 1, `English recall@1 was ${enRecall}, not 1.0 — real numbers: EN ${enRecall}, DE ${deRecall}`);
    assert.equal(deRecall, 1, `German recall@1 was ${deRecall}, not 1.0 — real numbers: EN ${enRecall}, DE ${deRecall}`);
    assert.equal(enRecall, deRecall, `the two languages are not equally well served: EN ${enRecall}, DE ${deRecall}`);
  } finally { cleanup(root); }
});

test('SABOTAGE: forcing every entry to English makes the German half of the mixed-corpus guarantee fail', () => {
  const { root, enAnchors, deAnchors } = mixedFixtures();
  try {
    const forcedEn = forceLanguage(root, 'en');
    const enUnderForcedEn = recallAt1(forcedEn, enAnchors);
    const deUnderForcedEn = recallAt1(forcedEn, deAnchors);
    // RED: this is the historical defect, reproduced. The English half
    // survives (English content forced to English is a no-op), the
    // German half does not — measured, not assumed.
    assert.equal(enUnderForcedEn, 1,
      `sanity check failed: even the English half broke under forced English (${enUnderForcedEn})`);
    assert.ok(deUnderForcedEn < 1,
      `expected the sabotage to break German recall — it stayed at ${deUnderForcedEn}, `
      + 'which means the fixture cannot demonstrate the defect this test exists to guard against');

    // GREEN: the real per-entry detection, on the exact same corpus,
    // recovers full recall for both — this is the restoration half of
    // the sabotage-verified-probe requirement.
    const restored = buildIndex(root);
    const enRestored = recallAt1(restored, enAnchors);
    const deRestored = recallAt1(restored, deAnchors);
    assert.equal(enRestored, 1, `restored EN recall was ${enRestored}, expected 1.0`);
    assert.equal(deRestored, 1, `restored DE recall was ${deRestored}, expected 1.0`);
  } finally { cleanup(root); }
});

test('SABOTAGE, the other direction: forcing every entry to German breaks the English half', () => {
  // Named in the brief as the actual failure mode: "a German company
  // writes German notes about English code" — it is the CONFIGURED
  // default that is German, and the minority language (English, in the
  // code notes) that silently loses. This is that direction, measured.
  const { root, enAnchors, deAnchors } = mixedFixtures();
  try {
    const forcedDe = forceLanguage(root, 'de');
    const enUnderForcedDe = recallAt1(forcedDe, enAnchors);
    const deUnderForcedDe = recallAt1(forcedDe, deAnchors);
    assert.equal(deUnderForcedDe, 1,
      `sanity check failed: even the German half broke under forced German (${deUnderForcedDe})`);
    assert.ok(enUnderForcedDe < 1,
      `expected the sabotage to break English recall — it stayed at ${enUnderForcedDe}`);
  } finally { cleanup(root); }
});

// --- Counter-probe: a single-language corpus must not get worse --------

function englishOnlyFixtures() {
  const filler = [
    ['learning', { title: 'the deploy hook keeps failing on the second retry', why: 'a timeout was too short' }],
    ['learning', { title: 'the dashboard shows numbers from yesterday', why: 'the cache was never invalidated' }],
    ['learning', { title: 'a feature flag was still on in production', why: 'the cleanup was never done' }],
    ['learning', { title: 'the login form rejected a valid password', why: 'a trailing space was not trimmed' }],
    ['learning', { title: 'the scheduler ran the same job twice', why: 'two workers grabbed the same lock' }],
  ];
  const anchors = [
    { title: 'the export job is still running two hours after it started', query: 'run' },
    { title: 'restarting the ingestion service cleared the stuck queue', query: 'restart' },
    { title: 'the retry handlers were skipped four times in a row', query: 'handler' },
    { title: 'three workers crashed during the nightly batch', query: 'worker' },
    { title: 'loading the config on startup now takes twice as long', query: 'load' },
    { title: 'the embeddings-endpoint returns a 500 under load', query: 'endpoint' },
  ];
  const entries = [...filler, ...anchors.map((a) => ['learning', { title: a.title }])];
  const { root, ids } = corpus(entries);
  const anchorIds = ids.slice(filler.length);
  return { root, anchors: anchors.map((a, i) => ({ ...a, id: anchorIds[i] })) };
}

test('COUNTER-PROBE: an English-only corpus does not get worse than it was before P28', () => {
  const { root, anchors } = englishOnlyFixtures();
  try {
    // "Before": every entry forced to English, which is what a
    // single-language English memory always got, and — because this
    // corpus really is entirely English — is also what an honest
    // pre-P28 config-driven build would have produced. It is built with
    // the SAME exported primitive the real index uses, not a separate
    // hand-rolled BM25, so the comparison is apples to apples.
    const before = forceLanguage(root, 'en');
    // "After": real per-entry detection.
    const after = buildIndex(root);

    const beforeRecall = recallAt1(before, anchors);
    const afterRecall = recallAt1(after, anchors);
    assert.equal(beforeRecall, 1, `the "before" fixture itself does not reach 1.0 (${beforeRecall}) — fixture is broken`);
    assert.ok(afterRecall >= beforeRecall,
      `single-language recall@1 got WORSE under P28: before ${beforeRecall}, after ${afterRecall}`);
    assert.equal(afterRecall, 1, `after P28, English-only recall@1 is ${afterRecall}, not 1.0`);

    // Every entry in a genuinely single-language corpus should in fact
    // be detected CERTAIN — an all-English memory should not spend its
    // days in the UNCERTAIN bucket just because P28 exists.
    const uncertainCount = after.documents.filter((d) => d.langCertain === false).length;
    assert.equal(uncertainCount, 0,
      `${uncertainCount} of ${after.documents.length} documents in an all-English corpus `
      + 'came back UNCERTAIN — detection is too conservative for ordinary prose');
  } finally { cleanup(root); }
});

// --- The third state really applies BOTH rule sets ----------------------

test('an UNCERTAIN entry is reachable through EITHER rule set, not silently through only one', () => {
  // A bare identifier-shaped string — the brief's own example — built
  // out of two real, differently-stemming words so this is provable
  // rather than asserted: "sitzungen" only collapses to a shared stem
  // under German, "workers" only under English (see the CONTROL test
  // above for the same pairs, checked directly against the stemmers).
  const { root, ids } = corpus([
    ['learning', { title: 'sitzungen-workers-8f3a-build' }],
  ]);
  try {
    const index = buildIndex(root);
    const doc = index.documents.find((d) => d.entry.id === ids[0]);
    assert.equal(doc.lang, 'uncertain', `expected UNCERTAIN, got "${doc.lang}"`);
    assert.equal(doc.langCertain, false);

    const viaGerman = search(index, 'sitzung', { top: 5 });
    const viaEnglish = search(index, 'worker', { top: 5 });
    assert.ok(viaGerman.some((h) => h.entry.id === ids[0]),
      'the UNCERTAIN entry was not reachable via the GERMAN rule set (sitzung -> sitzungen)');
    assert.ok(viaEnglish.some((h) => h.entry.id === ids[0]),
      'the UNCERTAIN entry was not reachable via the ENGLISH rule set (worker -> workers)');
  } finally { cleanup(root); }
});
