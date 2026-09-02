// test/hybrid.test.mjs — the fusion logic and graceful degradation.
//
// No provider is needed: fusion is a pure function, and hybridSearch takes
// an injectable `semantic` so the semantic side is a mock. This proves the
// two behaviours that matter: (1) an entry found by ONLY one ranker
// survives the fusion, and (2) with no embeddings hybrid is exactly BM25.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rrf, fuse, hybridSearch } from '../src/hybrid.mjs';
import { buildIndex } from '../src/search.mjs';
import { buildCorpus } from '../bench/retrieval.mjs';

const root = buildCorpus();
const index = buildIndex(root, { language: 'en' });
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* fine */ } });

test('rrf: an item in both lists outranks one in a single list', () => {
  const s = rrf([['a', 'b'], ['b', 'c']]);
  assert.ok(s.get('b') > s.get('a'));
  assert.ok(s.get('b') > s.get('c'));
});

test('fuse: a semantic-only hit is recovered into the ranking', () => {
  const bm = [{ source: 'x', line: 1 }, { source: 'x', line: 2 }];
  const sem = [{ source_file: 'x', line_number: 3 }];   // BM25 never had this
  const fused = fuse(bm, sem, { top: 10 });
  const keys = fused.map((f) => f.key);
  assert.ok(keys.includes('x:3'), 'semantic-only entry must survive fusion');
  const semOnly = fused.find((f) => f.key === 'x:3');
  assert.deepEqual(semOnly.found_by, ['semantic']);
});

test('fuse: an entry found by both rankers is marked bm25+semantic', () => {
  const bm = [{ source: 'x', line: 1 }];
  const sem = [{ source_file: 'x', line_number: 1 }];
  const fused = fuse(bm, sem, { top: 10 });
  assert.equal(fused.length, 1);
  assert.deepEqual(fused[0].found_by, ['bm25', 'semantic']);
});

test('hybridSearch with no semantic degrades to exactly BM25', async () => {
  const res = await hybridSearch(index, 'postgresql for billing', { semantic: null, top: 5 });
  assert.ok(res.length > 0);
  assert.ok(res.every((r) => r.found_by.length === 1 && r.found_by[0] === 'bm25'));
  assert.equal(res[0].hit.entry.id, 'd-postgres');
});

test('hybridSearch folds an injected semantic hit into the result', async () => {
  // Mock semantic ranker returns one hit for a learnings entry.
  const semantic = async () => [{ source_file: 'global/learnings.jsonl', line_number: 1, text: 'a learning' }];
  const res = await hybridSearch(index, 'postgresql for billing', { semantic, top: 10 });
  const bySemantic = res.filter((r) => r.found_by.includes('semantic'));
  assert.ok(bySemantic.length >= 1, 'the injected semantic hit must appear');
});

test('a broken semantic ranker never breaks search (falls back to BM25)', async () => {
  const semantic = async () => { throw new Error('provider down'); };
  const res = await hybridSearch(index, 'redis cache for the catalog', { semantic, top: 5 });
  assert.ok(res.length > 0);
  assert.equal(res[0].hit.entry.id, 'd-redis');
});
