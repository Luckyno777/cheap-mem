import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';

// Two search() calls never land in the same microsecond, and the recency
// bonus reads Date.now() — so identical scoring still differs in the
// tenth decimal. assert.equal on that is a test that goes red for no
// reason one day. Compare the ratio, not the bits. (Found when the
// German twin of this file failed on exactly that.)
function sameWithinMeasurement(a, b, why) {
  assert.ok(Math.abs(a / b - 1) < 1e-6, `${why} (${a} vs ${b})`);
}

function corpus(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cov-'));
  for (const [type, e] of entries) memory.logEntry(root, type, e);
  return root;
}

test('a document holding every typed word beats one holding a common word often', () => {
  // Found by using `mem browse` against a real 607-entry memory: for
  // "viewer ausfall" the entry containing BOTH words ranked second,
  // behind one that only carried "ausfall" — repeatedly and prominently.
  // BM25 adds term scores and has no notion of "answered more of the
  // question", so a frequent word can simply out-sum an exact match.
  const root = corpus([
    // Carries only "outage", but a lot of it.
    ['event', { title: 'outage outage outage', text: 'an outage report about the outage after the outage', tags: ['ops'] }],
    ['event', { title: 'another outage', text: 'outage outage outage outage', tags: ['ops'] }],
    ['event', { title: 'outage again', text: 'outage outage outage', tags: ['ops'] }],
    // Carries BOTH words, each once.
    ['error', { title: 'viewer outage traced to the tunnel', text: 'the viewer was unreachable', tags: ['viewer'] }],
  ]);
  try {
    const index = buildIndex(root, { language: 'en' });
    const off = search(index, 'viewer outage', { top: 5, minScore: 0, coverage: 0 });
    const on = search(index, 'viewer outage', { top: 5, minScore: 0 });
    assert.match(on[0].entry.title, /viewer outage traced/,
      'the document covering the whole query must rank first');
    assert.ok(off.length && on.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a one-word query is untouched — there is no coverage to reward', () => {
  const root = corpus([
    ['event', { title: 'outage one', tags: ['ops'] }],
    ['event', { title: 'outage two', tags: ['ops'] }],
  ]);
  try {
    const index = buildIndex(root, { language: 'en' });
    const off = search(index, 'outage', { top: 5, minScore: 0, coverage: 0 });
    const on = search(index, 'outage', { top: 5, minScore: 0 });
    assert.deepEqual(on.map((h) => h.entry.id), off.map((h) => h.entry.id));
    on.forEach((h, i) => sameWithinMeasurement(h.score, off[i].score,
      'a single-word query must score identically with and without coverage'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('coverage counts only typed words, never the thesaurus expansion', () => {
  // Counting expanded terms would reward the expansion rather than the
  // query: a document could "cover" words the user never typed, and a
  // wide synonym group would quietly become a ranking signal.
  //
  // Asserted through behaviour, not through the source. An earlier
  // version of this test matched on the variable name `ownSet`, so it
  // broke the moment the implementation improved while the property it
  // was meant to protect still held. A test that reads the code instead
  // of running it fails for the wrong reasons.
  const root = corpus([
    ['event', { title: 'the checkout crashed', tags: ['shop'] }],
    ['event', { title: 'the checkout crashed again', tags: ['shop'] }],
  ]);
  try {
    const index = buildIndex(root, { language: 'en' });
    // "crashed" expands through the thesaurus; whatever it expands to,
    // the divisor must stay 2 (the words typed), so two documents that
    // both carry both typed words keep the same relative order and full
    // score as with coverage off.
    const on = search(index, 'checkout crashed', { top: 5, minScore: 0 });
    const off = search(index, 'checkout crashed', { top: 5, minScore: 0, coverage: 0 });
    assert.deepEqual(on.map((h) => h.entry.id), off.map((h) => h.entry.id));
    for (let i = 0; i < on.length; i += 1) {
      sameWithinMeasurement(on[i].score, off[i].score,
        'a document covering every typed word must not be scaled at all');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a word the tokenizer splits still counts as ONE typed word', () => {
  // Found by auditing the change the day it shipped. `datastore` is one
  // word; with a lexicon the tokenizer yields `datastore`, `data` and
  // `store`, because every form is a chance to match. Counted flat, that
  // looked like three typed words — so the document saying "data store",
  // the one compound splitting exists to find, covered 2 of 3 and lost a
  // third of its score. Exactly backwards.
  const root = corpus([
    // 'data' and 'store' must be frequent enough to enter the lexicon.
    ...Array.from({ length: 8 }, (_, i) => ['event', { title: `the data pipeline moved ${i}` }]),
    ...Array.from({ length: 8 }, (_, i) => ['event', { title: `the store rebuild finished ${i}` }]),
    ['decision', { title: 'pick a data store', choice: 'the data store service', why: 'it held the load' }],
  ]);
  try {
    const index = buildIndex(root, { language: 'en' });
    assert.ok(index.lexicon?.has?.('data') && index.lexicon?.has?.('store'),
      'precondition: the lexicon must know both parts, or nothing splits');
    const on = search(index, 'datastore', { top: 1, minScore: 0 })[0];
    const off = search(index, 'datastore', { top: 1, minScore: 0, coverage: 0 })[0];
    assert.ok(on && off);
    sameWithinMeasurement(on.score, off.score,
      'one typed word must never be scaled down by its own split parts');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a document matching nothing typed is not resurrected by coverage', () => {
  // covered/size would be 0, and 0 ** 1 is 0 — the guard is that such a
  // document never reaches here, because BM25 already scored it 0.
  const root = corpus([['event', { title: 'completely unrelated', tags: ['x'] }]]);
  try {
    const index = buildIndex(root, { language: 'en' });
    const hits = search(index, 'viewer outage', { top: 5, minScore: 0 });
    assert.equal(hits.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
