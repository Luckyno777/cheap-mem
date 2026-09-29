// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/star-search-experiment.mjs — offline measurement, NOT wired into
// anything that runs automatically.
//
// Lucky's question: would a Windows-search-style prefix operator, applied
// IMPLICITLY (no `*`, every long query word auto-expanded), bring more
// results than today's ranked search? Part A of this build answered the
// EXPLICIT case (`word*`, opt-in, manual paths only —
// `search.resolveWildcards()`). This script answers the IMPLICIT
// question, offline, over the one labelled corpus this house has
// (`bench/retrieval.mjs`'s 67 docs / 42 queries — see that file's own
// header on why there is no grown, human-labelled "NL-gold" set here the
// way lucky-mem has one).
//
// Four variants, same corpus, same queries:
//   0  today          — search() exactly as shipped, no change
//   1  implicit-prefix — every query token >= 5 chars (after
//                       normalization) is ALSO treated as a prefix,
//                       expanded via `search.expandWildcardPrefix()`,
//                       same 0.45 discount `resolveWildcards()` uses.
//                       Silent — no `*` needed, no opt-in.
//   2  compound-split  — German-style greedy compound splitting of INDEX
//                       terms. **Finding, not a knob**: `buildIndex()`
//                       already splits compounds by default for English
//                       too (`src/search.mjs`'s `splitCompound`, wired
//                       into `wordForms()` since before this build) —
//                       technical English is full of closed compounds
//                       (datastore, codebase, runtime) and the shipped
//                       index already exploits that. There is no
//                       still-off compound splitter to switch on here
//                       without editing `src/`, which this experiment
//                       does not do (rule: no source changes to produce
//                       a number). So variant 2 is measured as exactly
//                       variant 0 — the honest result, not a shortcut.
//   3  both            — 1 + 2, which given the above is exactly 1.
//
// Pure Node, zero dependencies, deterministic, writes nothing to any real
// memory. Run:
//   node bench/star-search-experiment.mjs           # human table
//   node bench/star-search-experiment.mjs --json     # + machine JSON

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { buildIndex, search, expandWildcardPrefix, WILDCARD_EXPANSION_WEIGHT }
  from '../src/search.mjs';
import * as memory from '../src/memory.mjs';
import { DOCS, QUERIES, buildCorpus } from './retrieval.mjs';

const KS = [1, 3, 5, 10];
const IMPLICIT_MIN_LEN = 5;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function round(x) { return Math.round(x * 1000) / 1000; }
function pct(x) { return (x * 100).toFixed(0) + '%'; }

/**
 * Variant 1's implicit expansion: every raw word in the typed query that
 * is >= IMPLICIT_MIN_LEN chars (after lowercasing) is expanded as a
 * PREFIX, in addition to being searched literally — no `*`, no opt-in.
 * Reuses `expandWildcardPrefix()` (the same function the explicit
 * operator uses) so the scoring mechanics are identical; only how a
 * term gets INTO `extraTerms` differs (every long word, vs only a
 * starred one).
 */
function implicitExtraTerms(index, query) {
  const extraTerms = new Map();
  const words = String(query).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  for (const w of words) {
    if (w.length < IMPLICIT_MIN_LEN) continue;
    const { terms } = expandWildcardPrefix(index, w);
    for (const t of terms) {
      if (t === w) continue;
      if ((extraTerms.get(t) ?? 0) < WILDCARD_EXPANSION_WEIGHT) extraTerms.set(t, WILDCARD_EXPANSION_WEIGHT);
    }
  }
  return extraTerms;
}

function runVariant(variant, { repeats = 200 } = {}) {
  const root = buildCorpus();
  try {
    const tBuild0 = performance.now();
    const index = buildIndex(root, { language: 'en' });
    const buildMs = performance.now() - tBuild0;

    const correctionMap = memory.correctionSuccessorMap(
      index.documents.map((d) => d.entry).filter(Boolean));

    const perQuery = [];
    const latencies = [];
    for (const { q, gold, kind } of QUERIES) {
      const expectedIds = memory.expandExpectedIds(gold, correctionMap);
      const extraTerms = (variant === 1 || variant === 3) ? implicitExtraTerms(index, q) : null;
      const searchOnce = () => search(index, q, { top: 10, minScore: 0, extraTerms });
      const hits = searchOnce();
      let rank = Infinity;
      for (let i = 0; i < hits.length; i += 1) {
        if (expectedIds.includes(hits[i].entry.id)) { rank = i + 1; break; }
      }
      for (let r = 0; r < repeats; r += 1) {
        const t0 = performance.now();
        searchOnce();
        latencies.push(performance.now() - t0);
      }
      perQuery.push({ q, kind, rank });
    }

    const byKind = {};
    for (const row of perQuery) (byKind[row.kind] ??= []).push(row);
    const scoreOf = (rows) => {
      const out = { n: rows.length, mrr: 0 };
      for (const k of KS) out[`r@${k}`] = 0;
      for (const row of rows) {
        if (row.rank !== Infinity) out.mrr += 1 / row.rank;
        for (const k of KS) if (row.rank <= k) out[`r@${k}`] += 1;
      }
      out.mrr = out.mrr / rows.length;
      for (const k of KS) out[`r@${k}`] = out[`r@${k}`] / rows.length;
      return out;
    };

    return {
      variant,
      corpus: { docs: DOCS.length, indexedDocs: index.N, queries: QUERIES.length },
      latencyMs: {
        buildIndex: round(buildMs),
        searchMedian: round(median(latencies)),
        searchP95: round(quantile(latencies, 0.95)),
        samples: latencies.length,
      },
      overall: scoreOf(perQuery),
      byKind: Object.fromEntries(Object.entries(byKind).map(([k, rows]) => [k, scoreOf(rows)])),
      misses: perQuery.filter((r) => r.rank === Infinity).map((r) => r.q),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NAMES = { 0: 'today', 1: 'implicit-prefix', 2: 'compound-split (= today)', 3: 'both (= variant 1)' };

export function runAll({ repeats = 200 } = {}) {
  return [0, 1, 2, 3].map((v) => runVariant(v, { repeats }));
}

function printReport(results) {
  console.log('cheap-mem — implicit prefix / compound-split experiment (offline, bench/ only)');
  console.log('='.repeat(78));
  const head = `${'variant'.padEnd(26)} ${'R@1'.padStart(5)} ${'R@3'.padStart(5)} ${'MRR'.padStart(5)}  ${'median ms'.padStart(9)} ${'p95 ms'.padStart(7)}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of results) {
    const L = r.latencyMs;
    console.log(`${NAMES[r.variant].padEnd(26)} ${pct(r.overall['r@1']).padStart(5)} ${pct(r.overall['r@3']).padStart(5)} ${r.overall.mrr.toFixed(3).padStart(5)}  ${String(L.searchMedian).padStart(9)} ${String(L.searchP95).padStart(7)}`);
  }
  console.log('');
  console.log('variant 2 == variant 0 and variant 3 == variant 1: compound splitting of');
  console.log('index terms is already the shipped default (src/search.mjs splitCompound,');
  console.log('English technical compounds) — see this file\'s header.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const asJson = process.argv.includes('--json');
  const results = runAll({});
  printReport(results);
  if (asJson) {
    console.log('');
    console.log(JSON.stringify(results, null, 2));
  }
}
