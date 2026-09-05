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

// --- MMR: diversity re-ranking (engram.so-inspired, deterministic) --------

test('docSimilarity: identical vectors 1, disjoint 0, partial in between', () => {
  const a = new Map([['x', 1], ['y', 1]]);
  assert.ok(Math.abs(search.docSimilarity(a, a) - 1) < 1e-9); // float: ~1
  assert.equal(search.docSimilarity(a, new Map([['z', 1]])), 0);
  const partial = search.docSimilarity(a, new Map([['x', 1]]));
  assert.ok(partial > 0.7 && partial < 0.72); // 1/sqrt(2) ~ 0.707
  assert.equal(search.docSimilarity(a, new Map()), 0);
});

test('mmrRerank: prefers a diverse result over a near-duplicate', () => {
  const cands = [{ id: 'a', score: 10 }, { id: 'b', score: 9 }, { id: 'c', score: 8 }];
  const sim = (x, y) => {
    const k = [x.id, y.id].sort().join('');
    return ({ ab: 0.9, ac: 0.1, bc: 0.1 })[k] ?? (x.id === y.id ? 1 : 0);
  };
  // lambda 0.7: b is near-identical to a and gets penalized, c wins the 2nd slot
  const out = search.mmrRerank(cands, { lambda: 0.7, top: 2, simOf: sim });
  assert.deepEqual(out.map((o) => o.id), ['a', 'c']);
  // lambda 1: pure relevance, similarity ignored -> original order
  const pure = search.mmrRerank(cands, { lambda: 1, top: 2, simOf: sim });
  assert.deepEqual(pure.map((o) => o.id), ['a', 'b']);
});

test('search --mmr pulls a distinct relevant hit over a near-duplicate', () => {
  const root = corpus([
    ['event', { title: 'deploy staging cache warmup latency' }],   // e1
    ['event', { title: 'deploy staging cache warmup latency' }],   // e2 == e1 (sim 1.0)
    ['event', { title: 'deploy staging rollback guide manual' }],  // e3 distinct, equally relevant
  ]);
  const idx = search.buildIndex(root, { language: 'en' });

  const plain = search.search(idx, 'deploy staging', { top: 2, mmr: false });
  const plainTitles = plain.map((h) => h.entry.title).join(' | ');
  assert.ok(!/rollback/.test(plainTitles), `no-mmr top2 should be the two near-dupes, got: ${plainTitles}`);

  const diverse = search.search(idx, 'deploy staging', { top: 2, mmr: true });
  const divTitles = diverse.map((h) => h.entry.title).join(' | ');
  assert.ok(/rollback/.test(divTitles), `mmr top2 should include the distinct hit, got: ${divTitles}`);

  // MMR must not leak its internal term-vector helper into results.
  assert.ok(!('__w' in diverse[0]), '__w must be stripped from returned hits');
  fs.rmSync(root, { recursive: true, force: true });
});

// --- The learned co-occurrence thesaurus (third expansion leg) -----------

/** Build term-weight maps from plain word lists, as buildIndex would. */
function docsOf(...wordLists) {
  return wordLists.map((words) => new Map(words.map((w) => [w, 1])));
}

test('buildTermGraph stays silent on a corpus too small to learn from', () => {
  // Three documents cannot tell a real association from a coincidence.
  const g = thesaurus.buildTermGraph(docsOf(
    ['deploy', 'staging'], ['deploy', 'staging'], ['deploy', 'staging'],
  ));
  assert.equal(g.size, 0, 'under the corpus floor it must learn nothing');
});

test('buildTermGraph learns a real pair and ignores a coincidence', () => {
  // 'deploy'+'staging' co-occur in 6 of 10 docs -> real.
  // 'moon' appears with 'deploy' exactly once -> coincidence, must not stick.
  const docs = docsOf(
    ['deploy', 'staging', 'alpha'],
    ['deploy', 'staging', 'beta'],
    ['deploy', 'staging', 'gamma'],
    ['deploy', 'staging', 'delta'],
    ['deploy', 'staging', 'epsilon'],
    ['deploy', 'staging', 'zeta'],
    ['deploy', 'moon', 'eta'],
    ['unrelated', 'theta', 'iota'],
    ['unrelated', 'kappa', 'lambda'],
    ['unrelated', 'mu', 'nu'],
  );
  // maxDocFraction is raised for this toy corpus: with only 10 docs the
  // pair under test is in 60% of them, which the real default would (very
  // reasonably) treat as a stopword. Here we are testing the association
  // maths, not the stopword cutoff — that has its own test below.
  const g = thesaurus.buildTermGraph(docs, { minDocFreq: 2, minPairs: 3, maxDocFraction: 0.9 });
  const neighbours = (t) => (g.get(t) ?? []).map(([n]) => n);
  assert.ok(neighbours('deploy').includes('staging'), 'the real pair must be learned');
  assert.ok(!neighbours('deploy').includes('moon'), 'a single co-occurrence must not stick');
});

test('buildTermGraph drops de-facto stopwords (too common to mean anything)', () => {
  // 'the' is in every document: it carries no association, only noise.
  const docs = docsOf(
    ...Array.from({ length: 10 }, (_, i) => ['the', `w${i}`, `x${i % 3}`]),
  );
  const g = thesaurus.buildTermGraph(docs, { minDocFreq: 2, minPairs: 2 });
  assert.equal(g.has('the'), false, 'a term in every doc must be excluded');
});

test('learned weights never outweigh a literal hit, and are capped below tags', () => {
  const docs = docsOf(
    ...Array.from({ length: 8 }, () => ['deploy', 'staging']),
    ['other', 'thing'], ['more', 'stuff'],
  );
  const g = thesaurus.buildTermGraph(docs, { minDocFreq: 2, minPairs: 3 });
  for (const [, neighbours] of g) {
    for (const [, w] of neighbours) {
      assert.ok(w <= 0.35, `learned weight ${w} must stay under the 0.35 cap`);
      assert.ok(w < 1.0, 'an expansion must never reach a literal hit');
    }
  }
});

test('expand adds term-graph neighbours but never a word already typed', () => {
  const termGraph = new Map([['deploy', [['staging', 0.3], ['deploy', 0.9]]]]);
  const got = new Map(thesaurus.expand(['deploy'], null, pack('en'), termGraph));
  assert.equal(got.get('staging'), 0.3);
  assert.equal(got.has('deploy'), false, 'must not expand onto the original term');
});

test('a multi-word tag makes one node, not two ghosts', () => {
  // Regression: the pair key was joined with a space and split on one, so
  // any tag containing a space broke apart. `class` and `topic` count as
  // tags and are free text, so `class: "auth model"` was ordinary input —
  // it produced ghost nodes "auth" and "model" and lost the real edge.
  const entries = [];
  for (let i = 0; i < 6; i += 1) entries.push({ tags: ['ci'], class: 'auth model' });
  // Filler without the pair: if both tags sat in EVERY document they would
  // be perfectly correlated, pmi would collapse to 0, and nPMI would drop
  // the pair before the separator bug could even show itself.
  for (let i = 0; i < 4; i += 1) entries.push({ tags: ['billing'] });
  const g = thesaurus.buildTagGraph(entries);
  assert.ok(g.has('auth model'), 'the multi-word tag must be one node');
  assert.deepEqual((g.get('ci') ?? []).map(([w]) => w), ['auth model']);
  assert.ok(!g.has('auth') && !g.has('model'), 'no ghost nodes from splitting the tag');
});
