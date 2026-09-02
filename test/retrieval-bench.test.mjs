// test/retrieval-bench.test.mjs — guards the retrieval benchmark so its
// numbers can't silently regress. It does not assert a wall-clock latency
// bound (that is machine-dependent), only that latency is measured and
// that recall stays where it should: lexical queries must be perfect,
// and overall recall@10 must stay high.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, DOCS } from '../bench/retrieval.mjs';

const res = runBenchmark({ repeats: 20 });

test('every doc is indexed', () => {
  assert.equal(res.corpus.indexedDocs, DOCS.length);
});

test('lexical queries are perfect — BM25 must find exact-keyword matches', () => {
  assert.equal(res.byKind.lexical['r@1'], 1);
  assert.equal(res.byKind.lexical['r@5'], 1);
});

test('overall recall@10 stays high', () => {
  assert.ok(res.overall['r@10'] >= 0.9, `recall@10 dropped to ${res.overall['r@10']}`);
});

test('latency is actually measured (finite, positive)', () => {
  assert.ok(Number.isFinite(res.latencyMs.searchMedian));
  assert.ok(res.latencyMs.searchMedian >= 0);
  assert.ok(res.latencyMs.buildIndex > 0);
});
