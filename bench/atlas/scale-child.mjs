// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/scale-child.mjs — one fresh process that loads the index of a
// scale root and counts what a query touches.
//
//     node bench/atlas/scale-child.mjs <root> <queries.json>
//
// Prints one JSON line:
//
//   { documents, loadMs, maxRssMb, queries: [ { scored } ... ] }
//
// - `documents` how many documents `search()` walks per query. The search is
//   a linear scan over `index.documents` (src/search.mjs), so this is also
//   the number of documents every query visits.
// - `scored`    how many of them score above zero for that query, i.e. the
//   candidates before the score floor and the top-k cut. Asked with
//   `minScore: 0` and an unbounded `top`, so nothing but "does the document
//   match at all" decides.
//
// A child, not a call inside the atlas process: the atlas keeps its own heap
// small, and the child's peak RSS is the cost of loading the index and nothing else.
import { loadIndex, search } from '../../src/search.mjs';
import fs from 'node:fs';

const [root, file] = process.argv.slice(2);
const queries = JSON.parse(fs.readFileSync(file, 'utf8'));
const t0 = process.hrtime.bigint();
const index = loadIndex(root, { language: 'en' });
const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
const out = queries.map((q) => ({
  scored: search(index, q, { top: Infinity, minScore: 0, mmr: false }).length,
}));
process.stdout.write(`${JSON.stringify({
  documents: index.documents.length,
  loadMs: +loadMs.toFixed(1),
  maxRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
  queries: out,
})}\n`);
