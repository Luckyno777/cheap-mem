// bench/scale.mjs — what actually happens at 10k, 100k and 1M entries.
//
// The question "how does this behave with a million memories" is usually
// answered by estimating. It does not have to be: the code is right here,
// so this generates real corpora, builds the real index, runs the real
// search, and reports what it measured.
//
// Entries are synthesized to have the SHAPE of a real memory: a handful
// of common topic words, plus a Zipf-ish long tail of rare identifiers
// (error codes, file names, ticket ids) — because vocabulary size is not
// a cosmetic detail here. A first version of this file used ~70 distinct
// words; every query term then matched a large fraction of the corpus and
// the timings came out worse than they should. Random noise is the other
// extreme: every query would miss and every posting list would be length
// one. Real memories sit in between, so this does too.
//
// **What it measured on 2026-09-05** (this container, Node 22):
//
//   entries   corpus     build      heap    search p50     p95
//      1000   0.2 MB     82 ms    4.7 MB      0.785 ms   1.13 ms
//     10000   2.5 MB    570 ms   24.1 MB      7.414 ms   8.87 ms
//    100000  25.1 MB   5626 ms  212.2 MB    114.515 ms 142.25 ms
//   1000000 251.2 MB  66442 ms 1524.7 MB   1766.904 ms   2.46 s
//
// Search is LINEAR in corpus size, because search() scans every document
// (src/search.mjs:453) instead of walking posting lists. There is a
// docFreq map but no inverted index. That is the ceiling of this design.
//
// Before rewriting anything, two measurements that put it in proportion:
//
//   - On the real 611-entry memory, an average query already touches 34%
//     of all documents, because the thesaurus, tag graph and term graph
//     expand it. So posting lists would cut the work by about 3x, not by
//     orders of magnitude. Selectivity is spent on expansion, not on the
//     scan.
//   - That memory grows at ~48 entries/day. 10k is half a year away,
//     100k is six years, 1M is a lifetime. The million-entry number above
//     is a property of the design, not a problem anyone here has.
//
// The number that DOES bite sooner is the cache: any single new entry
// changes the corpus stamp and forces a full rebuild, so the first search
// after any write pays the cold path — 143 ms at 5k entries, 665 ms at
// 20k. A memory that captures every session writes constantly, and the
// recall hook runs on every prompt. That is the thing to fix first, and
// it is an incremental-update problem, not an index-structure one.
//
//   node bench/scale.mjs            # 1k, 10k, 100k
//   node bench/scale.mjs --million  # adds 1M (slow, needs ~2 GB)
//   node bench/scale.mjs --json
//
// Writes nothing into a real memory: everything goes into a throwaway
// directory under the OS temp dir and is removed at the end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildIndex, search } from '../src/search.mjs';

const TOPICS = ['billing', 'auth', 'database', 'ci', 'ops', 'frontend', 'security',
  'cache', 'payments', 'search', 'deploy', 'testing', 'mobile', 'api', 'queue'];
const VERBS = ['chose', 'reverted', 'migrated', 'fixed', 'broke', 'measured',
  'shipped', 'rolled back', 'profiled', 'rewrote'];
const NOUNS = ['the connection pool', 'the token refresh', 'the retry policy',
  'the index build', 'the migration', 'the rate limiter', 'the worker queue',
  'the session store', 'the upload path', 'the health check'];
const WHYS = ['it blocked the event loop', 'the numbers did not survive review',
  'a simpler shape held the same load', 'the old one lost data on restart',
  'latency doubled under real traffic', 'nobody could explain the failure mode'];
const TYPES = ['decision', 'error', 'event', 'learning', 'thought'];

// A deterministic PRNG: the same corpus every run, so two measurements
// are comparable. Math.random would make every number a fresh sample of
// a different corpus.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function buildCorpus(n, seed = 42) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cm-scale-${n}-`));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });

  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  // The long tail: identifiers a real memory is full of and a synthetic
  // one usually lacks. Drawn Zipf-ishly so a few recur and most appear
  // once or twice, which is what makes a posting list realistic.
  const tail = (bias) => {
    const k = Math.floor(Math.pow(r(), bias) * 20000);
    return `ref${k.toString(36)}`;
  };
  const streams = new Map();
  const start = Date.UTC(2024, 0, 1);
  const span = 2 * 365 * 86400000;

  // Buffer per file and write once: a million appendFileSync calls would
  // measure the filesystem, not the memory.
  for (let i = 0; i < n; i += 1) {
    const type = pick(TYPES);
    const topic = pick(TOPICS);
    const e = {
      id: `s${i.toString(36)}`,
      ts: new Date(start + Math.floor(r() * span)).toISOString(),
      topic,
      title: `${pick(VERBS)} ${pick(NOUNS)} in ${topic} (${tail(2)})`,
      text: `${pick(WHYS)}; seen again in ${pick(TOPICS)} near ${tail(1.2)} `
        + `and ${tail(1.2)}, tracked as ${tail(3)}`,
      tags: [topic, pick(TOPICS)],
    };
    if (type === 'decision') { e.choice = pick(NOUNS); e.why = pick(WHYS); }
    const file = `${type}s.jsonl`;
    if (!streams.has(file)) streams.set(file, []);
    streams.get(file).push(JSON.stringify(e));
  }
  let bytes = 0;
  for (const [file, lines] of streams) {
    const body = `${lines.join('\n')}\n`;
    bytes += Buffer.byteLength(body);
    fs.writeFileSync(path.join(root, 'global', file), body);
  }
  return { root, bytes };
}

const QUERIES = [
  'connection pool blocked the event loop',
  'billing',
  'why did we revert the migration',
  'rate limiter latency',
  'auth token refresh',
  'nobody could explain the failure',
];

function mb(x) { return Math.round(x / 1048576 * 10) / 10; }
function ms(x) { return Math.round(x * 1000) / 1000; }

export function measure(n) {
  const t0 = performance.now();
  const { root, bytes } = buildCorpus(n);
  const genMs = performance.now() - t0;
  try {
    if (global.gc) global.gc();
    const memBefore = process.memoryUsage().heapUsed;
    const t1 = performance.now();
    const index = buildIndex(root, { language: 'en' });
    const buildMs = performance.now() - t1;
    const memAfter = process.memoryUsage().heapUsed;

    // Warm up, then time. The first search pays for lazy allocation.
    for (const q of QUERIES) search(index, q, { top: 10 });
    const lat = [];
    for (let rep = 0; rep < 20; rep += 1) {
      for (const q of QUERIES) {
        const s = performance.now();
        search(index, q, { top: 10 });
        lat.push(performance.now() - s);
      }
    }
    lat.sort((a, b) => a - b);

    return {
      entries: n,
      indexed: index.N,
      corpusMB: mb(bytes),
      generateMs: Math.round(genMs),
      buildIndexMs: Math.round(buildMs),
      indexHeapMB: mb(memAfter - memBefore),
      searchMedianMs: ms(lat[Math.floor(lat.length / 2)]),
      searchP95Ms: ms(lat[Math.floor(lat.length * 0.95)]),
      searchMaxMs: ms(lat[lat.length - 1]),
      vocabulary: index.docFreq.size,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sizes = process.argv.includes('--million')
  ? [1000, 10000, 100000, 1000000]
  : [1000, 10000, 100000];

const rows = [];
for (const n of sizes) {
  process.stderr.write(`measuring ${n} ...\n`);
  rows.push(measure(n));
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('cheap-mem scale benchmark');
  console.log('='.repeat(78));
  console.log(
    'entries'.padStart(9), 'corpus'.padStart(8), 'build'.padStart(9),
    'heap'.padStart(8), 'search p50'.padStart(11), 'p95'.padStart(8),
    'vocab'.padStart(9));
  for (const r of rows) {
    console.log(
      String(r.entries).padStart(9),
      `${r.corpusMB} MB`.padStart(8),
      `${r.buildIndexMs} ms`.padStart(9),
      `${r.indexHeapMB} MB`.padStart(8),
      `${r.searchMedianMs} ms`.padStart(11),
      `${r.searchP95Ms} ms`.padStart(8),
      String(r.vocabulary).padStart(9));
  }
  console.log('');
  console.log('Index build is a cold start; normal runs read .mem/search-index.json.');
  console.log('Search is the number that matters — it runs on every prompt.');
}
