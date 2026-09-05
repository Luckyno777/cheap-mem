// Property tests for the invariants the whole design rests on.
//
// I2  deterministic replay      same log, same semantics -> same state
// I8  idempotent replay         reading twice changes nothing
// I9  index equivalence         rebuild == incremental
//     order independence        identical timestamps must not decide state
//
// These are not examples. Each generates many random logs from a SEEDED
// generator, so a failure is reproducible from the seed printed in the
// assertion, and a passing run means the property held over the shapes the
// generator can produce — not over the one case someone thought of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { buildIndex, loadIndex, search, REBUILD_AFTER_FRACTION } from '../src/search.mjs';
import { scanIntegrity, replacementGraph } from '../src/integrity.mjs';

/** Deterministic PRNG — a failing run must be reproducible from its seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const WORDS = ['deploy', 'billing', 'auth', 'cache', 'index', 'merge', 'scope',
  'claim', 'ranking', 'redaction', 'timer', 'hook', 'digest', 'topic'];
const TOPICS = ['deploy', 'retrieval', 'security', 'operations'];

/**
 * A random but well-formed log. Deliberately includes the shapes that
 * break naive implementations: repeated timestamps, corrections,
 * closing lines, and entries in an order that does not match their ts.
 */
function randomEntries(r, n) {
  const out = [];
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const id = `e${i}`;
    // Only a handful of distinct timestamps, so collisions are the norm
    // rather than a rare case: identical ts must never decide state.
    const day = 1 + Math.floor(r() * 5);
    const ts = `2026-0${day}-01T00:00:00Z`;
    const e = {
      id,
      ts,
      topic: TOPICS[Math.floor(r() * TOPICS.length)],
      choice: `${WORDS[Math.floor(r() * WORDS.length)]} ${WORDS[Math.floor(r() * WORDS.length)]} ${i}`,
      why: `${WORDS[Math.floor(r() * WORDS.length)]} because ${WORDS[Math.floor(r() * WORDS.length)]}`,
    };
    // ~20% of entries correct an earlier one.
    if (ids.length && r() < 0.2) e.replaces_id = ids[Math.floor(r() * ids.length)];
    ids.push(id);
    out.push(e);
  }
  return out;
}

function writeMemory(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-prop-'));
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}

/**
 * The derived state, as a comparable value. Everything the read path
 * computes from the log and nothing it stores.
 */
function derivedState(root) {
  return JSON.stringify({
    retired: [...memory.retiredMap(memory.readLog(root, 'decision', { project: 'p' }).entries)]
      .map(([k, v]) => [k, v?.by ?? v?.id ?? true]).sort(),
    topics: memory.topics(root).map((t) => [t.topic, t.count, t.area]).sort(),
    quality: memory.topicQuality(root),
    integrity: (() => {
      const r = scanIntegrity(root);
      return {
        entries: r.entries,
        broken: r.broken.length,
        dupes: r.duplicateIds.map((d) => d.id).sort(),
        cycles: r.replacement.cycles.map((c) => c.join(',')).sort(),
        forks: r.replacement.forks.map((f) => `${f.target}:${f.by.join(',')}`).sort(),
        maxDepth: r.replacement.maxDepth,
      };
    })(),
  });
}

const RUNS = 40;
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

test('I2/I8 — replaying the same log twice yields the identical state', () => {
  for (let seed = 1; seed <= RUNS; seed += 1) {
    const root = writeMemory(randomEntries(rng(seed), 30 + (seed % 20)));
    const a = derivedState(root);
    const b = derivedState(root);
    assert.equal(a, b, `state is not stable for seed ${seed}`);
    cleanup(root);
  }
});

test('order independence — identical timestamps must not let file order decide state', () => {
  for (let seed = 1; seed <= RUNS; seed += 1) {
    const r = rng(seed);
    const entries = randomEntries(r, 30);
    // A correction must still come after what it corrects; shuffling only
    // entries that share a timestamp keeps the log meaningful while
    // removing any accidental reliance on file position.
    const byTs = new Map();
    for (const e of entries) {
      const arr = byTs.get(e.ts) ?? [];
      arr.push(e);
      byTs.set(e.ts, arr);
    }
    const shuffled = [];
    for (const ts of [...byTs.keys()].sort()) {
      const group = byTs.get(ts).slice();
      for (let i = group.length - 1; i > 0; i -= 1) {
        const j = Math.floor(r() * (i + 1));
        [group[i], group[j]] = [group[j], group[i]];
      }
      shuffled.push(...group);
    }
    const sorted = [...entries].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));

    const rootA = writeMemory(sorted);
    const rootB = writeMemory(shuffled);
    const qa = memory.topicQuality(rootA);
    const qb = memory.topicQuality(rootB);
    assert.deepEqual(qa, qb, `topic quality depends on within-timestamp order, seed ${seed}`);

    const ga = replacementGraph(new Map(sorted.filter((e) => e.id)
      .map((e) => [e.id, { replaces: e.replaces_id ?? null, file: 'f', line: 1 }])));
    const gb = replacementGraph(new Map(shuffled.filter((e) => e.id)
      .map((e) => [e.id, { replaces: e.replaces_id ?? null, file: 'f', line: 1 }])));
    assert.deepEqual(ga.cycles, gb.cycles, `cycles depend on order, seed ${seed}`);
    assert.deepEqual(ga.forks, gb.forks, `forks depend on order, seed ${seed}`);
    assert.equal(ga.maxDepth, gb.maxDepth, `depth depends on order, seed ${seed}`);
    cleanup(rootA); cleanup(rootB);
  }
});

test('I9a — the EXACT layer of an incremental index matches a full rebuild', () => {
  // Documents, docFreq, lexicon, avgLength. This is what "an appended
  // entry is findable immediately, with the same term statistics" means,
  // and it must hold without exception.
  for (let seed = 1; seed <= 12; seed += 1) {
    const r = rng(seed);
    const base = 60;
    const root = writeMemory(randomEntries(r, base));
    loadIndex(root);

    // Stay inside REBUILD_AFTER_FRACTION; past it loadIndex deliberately
    // does a full rebuild and this test would compare a full build against
    // a full build and prove nothing. The first version of it did exactly
    // that — appended 37% and never touched the append path at all.
    const grow = Math.floor(base * REBUILD_AFTER_FRACTION) - 1;
    const more = randomEntries(r, grow).map((e, i) => ({ ...e, id: `later${i}` }));
    fs.appendFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'),
      more.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const incremental = loadIndex(root);
    const rebuilt = buildIndex(root);

    // The teeth: without these the test can silently degrade again.
    assert.equal(incremental.fromCache, true, `seed ${seed}: cache was not used`);
    assert.equal(incremental.appended, grow, `seed ${seed}: append path did not run`);

    assert.equal(incremental.N, rebuilt.N, `document count differs, seed ${seed}`);
    assert.equal(incremental.avgLength, rebuilt.avgLength, `avgLength differs, seed ${seed}`);
    assert.equal(incremental.lexicon.size, rebuilt.lexicon.size, `vocabulary differs, seed ${seed}`);
    for (const [term, df] of rebuilt.docFreq) {
      assert.equal(incremental.docFreq.get(term), df, `docFreq differs for "${term}", seed ${seed}`);
    }
    const ids = (idx) => idx.documents.map((d) => d.entry.id).sort();
    assert.deepEqual(ids(incremental), ids(rebuilt), `document set differs, seed ${seed}`);
    cleanup(root);
  }
});

test('I9b — the APPROXIMATE layer is declared, not hidden', () => {
  // The learned graphs are not extended on append, so ranking can lag
  // until the next full build. That is a deliberate trade — recomputing a
  // global co-occurrence graph is the cost the append path exists to
  // avoid — but an undeclared approximation is how a memory ends up
  // giving two different answers to the same question. So the index says
  // whether its graphs are current.
  const r = rng(4);              // the seed whose ranking actually diverged
  const base = 60;
  const root = writeMemory(randomEntries(r, base));
  const cold = loadIndex(root);
  assert.equal(cold.graphsStale, false, 'a fresh build must not claim stale graphs');

  const grow = Math.floor(base * REBUILD_AFTER_FRACTION) - 1;
  const more = randomEntries(r, grow).map((e, i) => ({ ...e, id: `later${i}` }));
  fs.appendFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'),
    more.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const incremental = loadIndex(root);
  assert.equal(incremental.graphsStale, true, 'an appended index must admit its graphs lag');

  // And the drift is real, not theoretical: this exact case ranks
  // differently. Asserting it keeps the claim honest — if a future change
  // makes the graphs exact, this test fails and the docs must follow.
  const rebuilt = buildIndex(root);
  const a = search(incremental, 'redaction hook', { top: 3 }).map((h) => h.entry.id);
  const b = search(rebuilt, 'redaction hook', { top: 3 }).map((h) => h.entry.id);
  assert.notDeepEqual(a, b, 'the documented drift did not occur — re-check the doc comment');
  cleanup(root);
});

test('I9c — a fresh load removes the drift entirely', () => {
  const r = rng(4);
  const base = 60;
  const root = writeMemory(randomEntries(r, base));
  loadIndex(root);
  const grow = Math.floor(base * REBUILD_AFTER_FRACTION) - 1;
  const more = randomEntries(r, grow).map((e, i) => ({ ...e, id: `later${i}` }));
  fs.appendFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'),
    more.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const fresh = loadIndex(root, { fresh: true });
  const rebuilt = buildIndex(root);
  assert.equal(fresh.graphsStale, false);
  for (const q of ['deploy billing', 'cache index merge', 'redaction hook', 'later3']) {
    const a = search(fresh, q, { top: 10 }).map((h) => `${h.entry.id}:${h.score.toFixed(6)}`);
    const b = search(rebuilt, q, { top: 10 }).map((h) => `${h.entry.id}:${h.score.toFixed(6)}`);
    assert.deepEqual(a, b, `"${q}" still differs after a fresh load`);
  }
  cleanup(root);
});

test('past the rebuild fraction loadIndex falls back to a full build, and says so', () => {
  const root = writeMemory(randomEntries(rng(99), 40));
  loadIndex(root);
  const tooMuch = randomEntries(rng(98), 20).map((e, i) => ({ ...e, id: `flood${i}` }));
  fs.appendFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'),
    tooMuch.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const idx = loadIndex(root);
  assert.equal(idx.fromCache, false, 'a 50% grow should have forced a rebuild');
  assert.equal(idx.appended, 0);
  assert.equal(idx.N, 60);
  cleanup(root);
});

test('the exhaustive scan is stable — the same query twice gives the same ranking', () => {
  for (let seed = 1; seed <= RUNS; seed += 1) {
    const root = writeMemory(randomEntries(rng(seed), 40));
    const idx = buildIndex(root);
    for (const q of ['deploy cache', 'auth scope claim']) {
      const a = search(idx, q, { top: 10 }).map((h) => h.entry.id);
      const b = search(idx, q, { top: 10 }).map((h) => h.entry.id);
      assert.deepEqual(a, b, `ranking is unstable for "${q}", seed ${seed}`);
    }
    cleanup(root);
  }
});

test('ties break deterministically — equal scores must not depend on Map iteration luck', () => {
  // Twenty entries with identical text and identical timestamps: every
  // score is equal, so only the tie-break decides. Whatever it is, it has
  // to be the same on every build of the same log.
  const same = Array.from({ length: 20 }, (_, i) => ({
    id: `t${i}`, ts: '2026-01-01T00:00:00Z', topic: 'deploy',
    choice: 'deploy to production', why: 'identical on purpose',
  }));
  const root = writeMemory(same);
  const first = search(buildIndex(root), 'deploy production', { top: 10 }).map((h) => h.entry.id);
  for (let i = 0; i < 5; i += 1) {
    const again = search(buildIndex(root), 'deploy production', { top: 10 }).map((h) => h.entry.id);
    assert.deepEqual(again, first, 'tie-break is not deterministic across builds');
  }
  cleanup(root);
});

test('integrity analysis is pure — scanning does not change what it scans', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const root = writeMemory(randomEntries(rng(seed), 25));
    const file = path.join(root, 'projects', 'p', 'decisions.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    scanIntegrity(root);
    scanIntegrity(root);
    assert.equal(fs.readFileSync(file, 'utf8'), before, `scan mutated the log, seed ${seed}`);
    cleanup(root);
  }
});
