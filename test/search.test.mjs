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

/**
 * A byte-for-byte copy of `mmrRerank` as it read before #122: for every
 * remaining candidate, on every round, rescan the WHOLE `selected` set to
 * find the max similarity. Kept here — not in `src/search.mjs` — purely
 * as a reference to check the incremental version against on small,
 * randomized input. The one thing it must never be is the shipped
 * algorithm again.
 */
function mmrRerankNaive(candidates, { lambda = 0.7, top = 10, simOf }) {
  if (candidates.length <= 1) return candidates.slice(0, top);
  const maxScore = candidates.reduce((m, c) => (c.score > m ? c.score : m), 0);
  const remaining = candidates.map((c) => c);
  const selected = [];
  const GLEICH = 1e-12;
  const key = (h) => `${h.source ?? ''}:${String(h.line ?? 0).padStart(9, '0')}`;
  while (selected.length < top && remaining.length) {
    let bestPos = -1;
    let bestVal = 0;
    for (let p = 0; p < remaining.length; p += 1) {
      const cand = remaining[p];
      const rel = maxScore > 0 ? cand.score / maxScore : 0;
      let maxSim = 0;
      for (const s of selected) {
        const sim = simOf(cand, s);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * rel - (1 - lambda) * maxSim;
      if (bestPos === -1) { bestVal = val; bestPos = p; continue; }
      const spanne = Math.max(Math.abs(val), Math.abs(bestVal), 1) * GLEICH;
      if (val > bestVal + spanne) { bestVal = val; bestPos = p; continue; }
      if (val >= bestVal - spanne && key(cand) < key(remaining[bestPos])) {
        bestVal = val; bestPos = p;
      }
    }
    selected.push(remaining.splice(bestPos, 1)[0]);
  }
  return selected;
}

test('mmrRerank: incremental maxSim matches the naive recomputation', () => {
  // The #122 fix caches the running max similarity to `selected` instead
  // of rescanning it every round. Same greedy rule, same tie-break —
  // this proves the two produce IDENTICAL selections across a spread of
  // random, overlapping candidate sets, so the speed-up in the test
  // below is not silently a behaviour change.
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 30; trial += 1) {
    const n = 5 + Math.floor(rand() * 25);
    const cands = [];
    for (let i = 0; i < n; i += 1) {
      cands.push({
        id: `c${i}`, score: rand() * 10, source: `s${i % 4}`, line: i,
        vec: new Set(Array.from({ length: 3 }, () => Math.floor(rand() * 8))),
      });
    }
    const simOf = (a, b) => {
      let inter = 0;
      for (const v of a.vec) if (b.vec.has(v)) inter += 1;
      return inter / 3;
    };
    const top = 1 + Math.floor(rand() * n);
    const lambda = 0.3 + rand() * 0.6;
    const got = search.mmrRerank(cands, { lambda, top, simOf }).map((c) => c.id);
    const want = mmrRerankNaive(cands, { lambda, top, simOf }).map((c) => c.id);
    assert.deepEqual(got, want, `trial ${trial}: n=${n} top=${top} lambda=${lambda}`);
  }
});

test('mmrRerank: cost is bounded by candidates * top, not candidates * top^2', () => {
  // The #122 finding: `mem explain`/`mem retrieve --top 50` hung past a
  // 60s Atlas timeout on a 2012-document corpus. `node --prof` on the
  // direct repro put 57.5% of ticks in `docSimilarity` and 33.4% in the
  // Map lookups inside it, called from `mmrRerank` — CPU-bound the whole
  // time, so this is superlinear work, not a stuck lock or process. The
  // old code rescanned the whole `selected` set for every remaining
  // candidate on every round: O(candidates * top^2) similarity calls.
  //
  // This asserts a bounded AMOUNT OF WORK (similarity calls), not wall
  // clock — the number is host-independent — and not merely "it
  // returned". At candidates=500, top=200 (comparable in shape to the
  // real corpus's 300-per-tier candidate pool), the naive algorithm this
  // repo shipped before #122 makes ~7.3M similarity calls; the
  // incremental one makes ~80k. The bound below sits between the two by
  // more than an order of magnitude, so it goes RED on the pre-#122
  // algorithm (reverting the `mmrRerank` body while keeping this test
  // reproduces that) and GREEN on the fix.
  const n = 500;
  const top = 200;
  const cands = [];
  for (let i = 0; i < n; i += 1) cands.push({ id: `c${i}`, score: n - i, source: `s${i}`, line: i });
  let calls = 0;
  const simOf = () => { calls += 1; return 0.5; };
  const out = search.mmrRerank(cands, { lambda: 0.7, top, simOf });
  assert.equal(out.length, top);
  const bound = n * top; // O(candidates * top): ~100000 here
  assert.ok(calls <= bound,
    `expected at most ${bound} similarity calls (O(candidates*top)), got ${calls} `
    + '(quadratic-in-top blowup is back)');
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

// --- Content words and the echo filter --------------------------------

test('contentWords keeps the technical terms and drops the connective tissue', () => {
  const w = search.contentWords(
    'could we maybe make this a bit more robust and also have a look at proper '
    + 'memory animations because I noticed the digest slices topics too finely');
  for (const must of ['robust', 'memory', 'animations', 'noticed', 'digest', 'topics']) {
    assert.ok(w.includes(must), `missing: ${must}`);
  }
  for (const gone of ['could', 'maybe', 'this', 'also', 'have', 'because', 'the', 'more']) {
    assert.equal(w.includes(gone), false, `should have been dropped: ${gone}`);
  }
  // Umlauts are folded so they match the index.
  assert.ok(search.contentWords('Gedächtnis').includes('gedaechtnis'));
  // Duplicates go: saying it three times does not make it three times heavier.
  assert.deepEqual(search.contentWords('topic topic topic'), ['topic']);
});

test('short prompts are left alone', () => {
  // With nothing left, the original comes back — better a vague search
  // than none at all.
  for (const short of ['yes do that', 'go on', 'and then?']) {
    assert.equal(search.retrievalQuery(short), short.trim());
  }
});

test('capping is by rarity, not by position', () => {
  // The first draft took the first eight words — and the subject often
  // arrives late in the sentence. Exactly that word fell out.
  const q = 'viewer motion icon rail indicator fade cards topics areas agents '
    + 'store register canary chirps';
  const all = search.contentWords(q);
  assert.ok(all.length > 8, 'the fixture needs more than eight content words');
  // The fake index is built through the SAME tokenisation as the search,
  // or the lookup finds nothing and the ranking is inert — which is the
  // very bug this test exists to catch.
  const docFreq = new Map();
  all.forEach((w, i) => { for (const t of search.tokenize(w)) docFreq.set(t, all.length - i); });
  const picked = search.retrievalQuery(q, { index: { docFreq } }).split(' ');
  assert.ok(picked.includes('chirps'), `last and rarest, yet dropped: ${picked}`);
  assert.equal(picked.includes('viewer'), false, `most common survived: ${picked}`);
});

test('isEcho spots the question itself, not every hit containing it', () => {
  const q = 'the digest slices topics too finely we need subcategories';
  assert.equal(search.isEcho(q, 'digest slices topics too finely, subcategories needed'), true);
  // A long entry that happens to contain the question stays.
  assert.equal(search.isEcho(q,
    'The digest sliced topics too finely — the cause was a missing rule in the spec, '
    + 'which listed topic as required without saying what a topic is, measured across '
    + '553 entries at a ratio of 1.00 and fixed by deriving the area from the project'), false);
  // Too short to judge: leave it standing.
  assert.equal(search.isEcho(q, 'ok'), false);
});
