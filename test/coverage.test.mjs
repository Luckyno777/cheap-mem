import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';

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
    assert.deepEqual(on.map((h) => h.score), off.map((h) => h.score),
      'a single-word query must score identically with and without coverage');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('coverage counts only typed words, never the thesaurus expansion', () => {
  // Counting expanded terms would reward the expansion rather than the
  // query: a document could "cover" words the user never typed, and a
  // wide synonym group would quietly become a ranking signal.
  const src = fs.readFileSync(new URL('../src/search.mjs', import.meta.url), 'utf8');
  assert.match(src, /const ownSet = new Set\(own\)/);
  assert.match(src, /if \(ownSet\.has\(term\)\) covered \+= 1/);
  const block = src.slice(src.indexOf('if (coverage > 0'), src.indexOf('if (coverage > 0') + 200);
  assert.match(block, /ownSet\.size/, 'the divisor must be the typed terms, not all terms');
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
