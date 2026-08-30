import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as search from '../src/search.mjs';
import * as memory from '../src/memory.mjs';
import * as thesaurus from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';

function corpus(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-search-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  for (const [type, data] of entries) memory.logEntry(root, type, data);
  return root;
}

test('no thesaurus word is unreachable through stemming', () => {
  // The lookup index used to be keyed by the full word while queries
  // arrive stemmed. Every group word whose stem differs from itself
  // was then unreachable — in the German ancestor, 95 of 214, headed
  // by the single most common word in the corpus. They sat in the file
  // and never once produced a hit.
  const en = pack('en');
  const unreachable = [];
  for (const word of new Set(thesaurus.THESAURUS.flat())) {
    const stemmed = en.stem(en.normalize(word));
    if (thesaurus.expand([stemmed], null, en).length === 0) unreachable.push(word);
  }
  assert.deepEqual(unreachable, [],
    `these group words cannot reach their group: ${unreachable.join(', ')}`);
});

test('no word appears in two thesaurus groups', () => {
  // Expansion is transitive through a shared word. A word in two
  // groups silently merges them, and the merge is invisible in the
  // source — you only see it as results that make no sense.
  const seen = new Map();
  for (const group of thesaurus.THESAURUS) {
    for (const w of group) seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  const doubled = [...seen].filter(([, n]) => n > 1).map(([w]) => w);
  assert.deepEqual(doubled, [], `in more than one group: ${doubled.join(', ')}`);
});

test('thesaurus holds single words only', () => {
  // A multi-word entry can never match: queries are split into single
  // tokens, so "pull request" is dead weight while "pull-request" works.
  const multi = thesaurus.THESAURUS.flat().filter((w) => w.includes(' '));
  assert.deepEqual(multi, []);
});

test('finds an entry through a synonym, not just a literal match', () => {
  const root = corpus([
    ['error', { title: 'The integration job aborts intermittently', class: 'ci', tags: ['ci'] }],
    ['event', { title: 'Weekly planning meeting', tags: ['process'] }],
  ]);
  try {
    const idx = search.buildIndex(root, { language: 'en' });
    const hits = search.search(idx, 'flaky', { top: 3 });
    assert.ok(hits.length > 0, 'nothing found for "flaky"');
    assert.match(hits[0].entry.title, /integration job/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an expansion never outranks a literal hit', () => {
  const root = corpus([
    ['error', { title: 'flaky', text: 'literally the word' }],
    ['error', { title: 'intermittent', text: 'a synonym of it' }],
  ]);
  try {
    const idx = search.buildIndex(root, { language: 'en' });
    const hits = search.search(idx, 'flaky', { top: 5 });
    assert.equal(hits[0].entry.title, 'flaky',
      'the synonym outranked the literal hit — expansion weights are wrong');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('title weighs more than body text', () => {
  const root = corpus([
    ['event', { title: 'migration', text: 'unrelated body' }],
    ['event', { title: 'unrelated title', text: 'migration migration migration' }],
  ]);
  try {
    const idx = search.buildIndex(root, { language: 'en' });
    const hits = search.search(idx, 'migration', { top: 5 });
    assert.equal(hits[0].entry.title, 'migration');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the tag graph learns association from co-occurrence', () => {
  const entries = [];
  for (let i = 0; i < 6; i += 1) {
    entries.push(['error', { title: `run ${i}`, tags: ['ci', 'flake'] }]);
  }
  entries.push(['event', { title: 'unrelated', tags: ['billing'] }]);
  const root = corpus(entries);
  try {
    const idx = search.buildIndex(root, { language: 'en' });
    assert.ok(idx.tagGraph.has('ci'), 'ci did not make it into the graph');
    const neighbours = idx.tagGraph.get('ci').map(([w]) => w);
    assert.ok(neighbours.includes('flake'), 'ci and flake were not associated');
    assert.ok(!neighbours.includes('billing'), 'an unrelated tag was associated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('learned weights stay below a literal match', () => {
  const entries = [];
  for (let i = 0; i < 8; i += 1) entries.push(['error', { title: `x${i}`, tags: ['ci', 'flake'] }]);
  const root = corpus(entries);
  try {
    const idx = search.buildIndex(root, { language: 'en' });
    for (const [, ns] of idx.tagGraph) {
      for (const [, w] of ns) assert.ok(w <= 0.5, `learned weight ${w} exceeds the cap`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hyphenated words are findable by their parts', () => {
  const root = corpus([['error', { title: 'the embeddings-endpoint returns 500' }]]);
  try {
    const idx = search.buildIndex(root, { language: 'en' });
    assert.ok(search.search(idx, 'endpoint', { top: 3 }).length > 0);
    assert.ok(search.search(idx, 'embeddings-endpoint', { top: 3 }).length > 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('German compounds split against a lexicon built from the corpus', () => {
  const root = corpus([
    ['event', { title: 'Die Post kam an', text: 'Post ist wichtig, Post kam' }],
    ['event', { title: 'Sitzung beendet', text: 'Die Sitzung war lang, Sitzung vorbei' }],
    ['event', { title: 'Sitzungspost eingetroffen', text: 'neue Nachricht' }],
  ]);
  try {
    const idx = search.buildIndex(root, { language: 'de' });
    const hits = search.search(idx, 'post', { top: 5, language: 'de' });
    const titles = hits.map((h) => h.entry.title);
    assert.ok(titles.some((t) => t.includes('Sitzungspost')),
      'the compound was not split — "post" did not find "Sitzungspost"');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unknown language falls back to neutral, not to English', () => {
  // Guessing English for, say, a Japanese corpus would strip endings
  // that do not exist there and quietly corrupt the index.
  assert.equal(pack('ja').name, 'neutral');
  assert.equal(pack('ja').stem('anything'), 'anything');
});

test('the index cache notices growth within the same millisecond', () => {
  // The stamp used to take Math.max over mtime and size. Size (~10^3)
  // always lost against time in milliseconds (~10^12), so a file that
  // grew inside one millisecond looked unchanged and the cache served
  // stale hits.
  const root = corpus([['event', { title: 'first' }]]);
  try {
    const before = search.corpusStamp(root);
    memory.logEntry(root, 'event', { title: 'second' });
    assert.notEqual(search.corpusStamp(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
