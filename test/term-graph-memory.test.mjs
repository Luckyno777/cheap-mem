// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The learned term graph (src/thesaurus.mjs buildTermGraph) at build time:
// its memory must not grow with the number of DISTINCT PAIRS, and the graph
// it returns must be exactly the one the plain pair-counting definition gives.
//
// Why: the scale gate measured build peak RSS 310 MB at 2,000 entries and
// 1,074 MB at 10,000 (about 96 KB per extra entry). The cause, measured with
// --trace-gc and a before/after of this function alone, was the pair Map of
// buildTermGraph: up to 780 pairs per document, almost all seen once, held
// in one Map until the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as thesaurus from '../src/thesaurus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(HERE, '..', 'src', 'thesaurus.mjs')).href;

/** Seeded documents: Zipf-like reuse over a vocabulary that grows with the corpus. */
function makeDocs(n, perDoc, seed) {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const word = (i) => {
    let w = 'w'; let x = i + 1;
    while (x > 0) { w += 'abcdefghij'[x % 10]; x = Math.floor(x / 10); }
    return `${w}x`;
  };
  const docs = [];
  for (let d = 0; d < n; d += 1) {
    const m = new Map();
    const vocab = Math.max(50, Math.round(40 * (d + 1) ** 0.8));
    while (m.size < perDoc) m.set(word(Math.floor((rand() ** 1.5) * vocab)), 0.2 + rand());
    docs.push(m);
  }
  return docs;
}

/** The definition, stated plainly: count every pair in one Map, filter, sort. */
function reference(docs, { minPairs = 3, maxNeighbours = 6, minDocFreq = 3, maxDocFraction = 0.5, termsPerDoc = 40, weightCap = 0.35, minWeight = 0.10 } = {}) {
  const n = docs.length;
  const df = new Map();
  for (const w of docs) for (const t of w.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const maxDF = Math.max(minDocFreq, Math.floor(n * maxDocFraction));
  const usable = (t) => /^\p{L}[\p{L}\-_]{2,}$/u.test(t) && df.get(t) >= minDocFreq && df.get(t) <= maxDF;
  const single = new Map(); const pairs = new Map(); let counted = 0;
  for (const w of docs) {
    const terms = [...w.entries()].filter(([t]) => usable(t)).sort((a, b) => b[1] - a[1]).slice(0, termsPerDoc).map(([t]) => t).sort();
    if (!terms.length) continue;
    counted += 1;
    for (const t of terms) single.set(t, (single.get(t) ?? 0) + 1);
    for (let i = 0; i < terms.length; i += 1) for (let j = i + 1; j < terms.length; j += 1) { const k = `${terms[i]}\u001f${terms[j]}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); }
  }
  const graph = new Map();
  for (const [key, nAB] of pairs) {
    if (nAB < minPairs) continue;
    const [a, b] = key.split('\u001f');
    const pmi = Math.log((nAB / counted) / ((single.get(a) / counted) * (single.get(b) / counted)));
    if (pmi <= 0) continue;
    const weight = Math.min(weightCap, Math.max(0, pmi / -Math.log(nAB / counted)) * weightCap);
    if (weight < minWeight) continue;
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    graph.get(a).push([b, weight]); graph.get(b).push([a, weight]);
  }
  for (const [t, nb] of graph) { nb.sort((x, y) => y[1] - x[1]); graph.set(t, nb.slice(0, maxNeighbours)); }
  return graph;
}

test('buildTermGraph returns exactly what plain pair counting returns (content and order)', () => {
  for (const [n, perDoc, seed, opts] of [[300, 12, 1, {}], [400, 40, 2, {}], [200, 30, 3, { minPairs: 2, termsPerDoc: 10, minDocFreq: 2, maxDocFraction: 0.9 }]]) {
    const docs = makeDocs(n, perDoc, seed);
    const want = reference(docs, opts);
    assert.ok(want.size > 0, 'the fixture must learn something, or this proves nothing');
    assert.equal(JSON.stringify([...thesaurus.buildTermGraph(docs, opts)]), JSON.stringify([...want]));
  }
});

test('buildTermGraph memory does not scale with the number of distinct pairs (child process, RSS)', () => {
  // 6,000 documents x 40 terms: 4.7 million pair occurrences, almost all distinct.
  // Measured here: the pair-Map version adds several hundred MB of resident
  // memory on top of the input; the term-by-term version adds a few tens.
  // The limit sits far from both, so a loaded machine does not flip it.
  const child = `
    import fs from 'node:fs';
    const { buildTermGraph } = await import(${JSON.stringify(MODULE)});
    const docs = ${makeDocs.toString()}(6000, 40, 7);
    const hwm = () => Number(/VmHWM:\\s+(\\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1]) / 1024;
    global.gc?.();
    const before = hwm();
    const g = buildTermGraph(docs);
    console.log(JSON.stringify({ addedMb: hwm() - before, terms: g.size }));
  `;
  const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', child], { encoding: 'utf8', timeout: 300000 });
  if (!fs.existsSync('/proc/self/status')) return; // VmHWM is Linux only; the equality test above covers the rest
  assert.equal(r.status, 0, `child failed: ${r.error ?? r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(out.terms > 0);
  assert.ok(out.addedMb < 150, `buildTermGraph added ${out.addedMb.toFixed(0)} MB of peak RSS on 6,000 documents; limit 150`);
});
