// Child process of the memory probes (test/search-slim.test.mjs and
// test/startblock-slim.test.mjs). Not a test: it runs against a chosen source
// tree (`<tree>/src`) so the same steps run on the OLD (pinned commit) and the
// new code.
//
//   node [--max-old-space-size=N] search-slim-child.mjs <tree> <mode> <root> [N]
//
//   create N   write a deterministic memory (citations, tombstones, links)
//   ask        build the index, then ask the worst question; stats as JSON
//   same       many option combinations, full results as JSON
//   standing   standing() and experiences() in full, as JSON
//   start      memory.core() (the session-start block), stats and block as JSON
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , tree, mode, root, nArg] = process.argv;
const imp = (f) => import(pathToFileURL(path.join(tree, 'src', f)).href);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// Vocabulary: many words, and 'loadplan' in half of the documents (document
// frequency far above any candidate bound: every document is scored).
function create(N, withCites) {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  let s = 12345;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const vocab = Array.from({ length: 30000 }, (_, i) => `word${i.toString(36)}x`);
  const drawers = ['learnings', 'errors', 'events', 'decisions', 'thoughts', 'duties', 'questions', 'skills', 'procedures', 'sources'];
  const lines = new Map(drawers.map((f) => [f, []]));
  const learnings = [];
  for (let i = 0; i < N; i += 1) {
    const ws = [];
    const len = withCites ? 40 + Math.floor(r() * 20) : 3 + Math.floor(r() * 4);
    for (let k = 0; k < len; k += 1) ws.push(vocab[Math.floor(r() * r() * vocab.length)]);
    if (r() < 0.5) ws.push('loadplan');
    const id = `i${i.toString(36).padStart(8, '0')}`;
    const e = {
      id,
      ts: new Date(1.7e12 + i * 1000).toISOString().replace(/\.\d+Z/, 'Z'),
      title: ws.slice(0, 6).join(' '),
      text: ws.join(' '),
      agent: 't',
      authority: 'agent',
    };
    const drawer = withCites ? drawers[i % drawers.length] : 'learnings';
    if (withCites) {
      e.topic = `topic${i % 40}`;
      if (drawer === 'learnings') {
        const k = i / 10;
        // every 3rd learning cites two earlier ones; every 5th also cites an id that does not
        // exist; every 9th repeats the id of an earlier learning (duplicate id: first-found wins);
        // some use the other provenance spelling
        if (k % 3 === 0 && learnings.length > 20) e.origin = { derived_from: [learnings[Math.floor(r() * learnings.length)], learnings[Math.floor(r() * learnings.length)]] };
        if (k % 4 === 0 && learnings.length > 20) e.provenance = { inferred_from: [learnings[Math.floor(r() * learnings.length)]] };
        if (k % 5 === 0 && learnings.length > 20) e.origin = { derived_from: ['does-not-exist', learnings[k % learnings.length]] };
        if (k % 9 === 0 && learnings.length > 20) e.id = learnings[Math.floor(r() * learnings.length)];
        learnings.push(id);
      } else if (i % 13 === 0 && learnings.length > 20) {
        e.origin = { derived_from: [learnings[Math.floor(r() * learnings.length)]] };
      }
    }
    lines.get(drawer).push(JSON.stringify(e));
  }
  for (const [f, z] of lines) {
    if (z.length) fs.writeFileSync(path.join(root, 'global', `${f}.jsonl`), `${z.join('\n')}\n`);
  }
  if (withCites) {
    const v = [];
    for (let i = 0; i < 30; i += 1) {
      v.push(JSON.stringify({ id: `v${i}`, ts: '2026-01-01T00:00:00Z', from: learnings[i * 5 + 3], to: learnings[i * 3 + 1], kind: i % 4 === 0 ? 'contradicts' : 'supports' }));
    }
    fs.writeFileSync(path.join(root, 'global', 'links.jsonl'), `${v.join('\n')}\n`);
    // tombstones: every 11th learning is retired
    const g = [];
    for (let i = 11; i < learnings.length; i += 11) g.push(JSON.stringify({ id: `g${i}`, ts: '2026-02-01T00:00:00Z', retires_id: learnings[i], state: 'done', agent: 't', authority: 'agent' }));
    fs.appendFileSync(path.join(root, 'global', 'learnings.jsonl'), `${g.join('\n')}\n`);
  }
}

const mem = () => {
  const m = process.memoryUsage();
  return { rssMiB: Math.round(m.rss / 2 ** 20), heapMiB: Math.round(m.heapUsed / 2 ** 20) };
};
const NOW = 1_800_000_000_000;

if (mode === 'create') {
  create(Number(nArg), process.env.WITH_CITES === '1');
  out({ created: Number(nArg) });
} else if (mode === 'warm') {
  const search = await imp('search.mjs');
  out({ docs: search.loadIndex(root).N });
} else if (mode === 'ask') {
  const search = await imp('search.mjs');
  const index = search.loadIndex(root);   // from the on-disk cache after `warm`
  if (global.gc) global.gc();
  const before = mem();
  const t0 = Date.now();
  const hits = search.search(index, 'loadplan', { top: 10, mmr: process.env.MMR === '1', now: NOW, minScore: 0 });
  const after = mem();
  out({
    docs: index.N, hits: hits.length, ms: Date.now() - t0,
    heapBeforeMiB: before.heapMiB, heapAfterMiB: after.heapMiB,
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    ids: hits.map((t) => `${t.entry.id}:${t.score}`),
  });
} else if (mode === 'same') {
  const search = await imp('search.mjs');
  const index = search.buildIndex(root);
  const questions = ['loadplan', 'loadplan word5x word9x', 'word1x', 'topic3 loadplan', 'what is the current loadplan topic7', 'word2x word3x word4x', 'still loadplan'];
  const cases = [
    { top: 5 }, { top: 10, mmr: true }, { top: 10, mmr: true, stateWords: undefined },
    { top: 7, minScore: 0.3 }, { top: 10, minScore: 0 }, { top: 3, withRetired: true }, { top: 150, withRetired: true, minScore: 0, type: 'learning' },
    { top: 10, withCoverage: true }, { top: 10, mmr: true, withCoverage: true, withRetired: true },
    { top: 10, type: 'learning' }, { top: 10, noRaw: true }, { top: 4, mmr: true, mmrLambda: 0.2 },
  ];
  const all = [];
  for (const q of questions) {
    for (const c of cases) all.push({ q, c: Object.keys(c).join(','), hits: search.search(index, q, { ...c, now: NOW }) });
  }
  out({ results: all });
} else if (mode === 'standing') {
  const memory = await imp('memory.mjs');
  const exp = (o) => memory.experiences(root, o);
  out({
    standing: [...memory.standing(root)],
    e0: exp({ minCited: 0 }).length, e1: exp({ minCited: 1 }), e2: exp({ minCited: 2 }),
    eErr: exp({ minCited: 1, type: 'error' }), eDefault: exp({}).length,
    byId: memory.entriesById(root).size,
  });
} else if (mode === 'start') {
  const memory = await imp('memory.mjs');
  if (global.gc) global.gc();
  const t0 = Date.now();
  const block = memory.core(root, { now: new Date('2026-10-06T00:00:00Z') });
  out({ ms: Date.now() - t0, ...mem(), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), block });
} else {
  process.stderr.write('mode?\n');
  process.exit(2);
}
