// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/cold-find.mjs — the ONLY source of latency figures for the README.
//
// **Why it exists (finding of 2026-09-29, at 5081616).** The README said
// "0.027 ms median" and "~3 ms" for a search; docs/benchmarks said 0.048 ms
// for the same thing; docs/scale.md showed fresh processes needing 430-1719
// ms just to load the index. All true of something, none labelled cold or
// warm, none tied to a commit. A latency number without its state, its
// corpus size and its commit is a rumour.
//
// **What is measured.** Per corpus size (bench/scale.mjs's synthetic
// corpus, fixed seed 42):
//   cold  a FRESH `bin/mem find` process per run, N runs (default 30). The
//         on-disk index cache is primed by one unmeasured run first, so
//         "cold" means cold PROCESS (Node start + index read from cache),
//         which is what the recall hook pays per prompt. It is NOT a
//         cache rebuild — that is a different, larger number, named in
//         docs/scale.md.
//   warm  the index already loaded in this process, N `search()` calls
//         (after 3 unmeasured), i.e. the search itself.
// Both report median and P95 (nearest rank, bench/atlas/core.mjs `pct`).
//
// The artifact (bench/cold-find.json) carries commit, dirty flag, CPU,
// cores, Node and the query. The README block between the perf markers is
// RENDERED from it (`--readme`), and test/readme-perf.test.mjs holds the
// README to it.
//
//   node bench/cold-find.mjs                # measure, write the artifact
//   node bench/cold-find.mjs --sizes 1000,20000 --runs 30
//   node bench/cold-find.mjs --readme       # re-render README block from artifact
//
// 200k is included only while the whole size stays under --max-minutes
// (default 10); a size that would not fit is recorded as not measured,
// never as a number.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { environment, pct, mem, REPO } from './atlas/core.mjs';
import { buildCorpus } from './scale.mjs';
import { loadIndex, search } from '../src/search.mjs';

export const ARTIFACT = path.join(REPO, 'bench', 'cold-find.json');
export const PERF_BEGIN = '<!-- perf:begin -->';
export const PERF_END = '<!-- perf:end -->';
export const QUERY = 'rate limiter latency';
export const DEFAULT_SIZES = [1000, 20000, 200000];

const fmt = (x) => (x == null ? 'n/a' : x < 10 ? x.toFixed(3) : x < 100 ? x.toFixed(1) : String(Math.round(x)));
const stats = (v) => {
  const s = v.slice().sort((a, b) => a - b);
  return { n: s.length, medianMs: +pct(s, 50).toFixed(3), p95Ms: +pct(s, 95).toFixed(3), minMs: +s[0].toFixed(3), maxMs: +s[s.length - 1].toFixed(3) };
};

export function measureSize(n, { runs = 30, maxMs = 10 * 60 * 1000 } = {}) {
  const t0 = performance.now();
  const { root } = buildCorpus(n);
  try {
    const prime = mem(['find', QUERY], { root, timeoutMs: maxMs });   // writes the cache
    if (prime.status !== 0) return [{ entries: n, state: 'not-measured', why: `prime run exited ${prime.status}: ${prime.stderr.slice(0, 200)}` }];
    const cold = [];
    for (let i = 0; i < runs; i += 1) {
      if (performance.now() - t0 > maxMs) {
        return [{ entries: n, state: 'not-measured', why: `over the ${Math.round(maxMs / 60000)} min budget after ${cold.length} cold runs` }];
      }
      const r = mem(['find', QUERY], { root, timeoutMs: maxMs });
      if (r.status !== 0) return [{ entries: n, state: 'not-measured', why: `cold run exited ${r.status}` }];
      cold.push(r.ms);
    }
    const index = loadIndex(root, { language: 'en' });
    for (let i = 0; i < 3; i += 1) search(index, QUERY, { top: 10 });
    const warm = [];
    for (let i = 0; i < runs; i += 1) {
      const s = performance.now();
      search(index, QUERY, { top: 10 });
      warm.push(performance.now() - s);
    }
    return [
      { entries: n, state: 'cold', what: 'fresh `mem find` process, index read from cache', ...stats(cold) },
      { entries: n, state: 'warm', what: 'search() on an already loaded index', ...stats(warm) },
    ];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The README block, from the artifact alone. Pure. Not measured is not zero. */
export function renderPerfBlock(a) {
  const e = a.environment;
  const commit = e.gitCommit ?? 'unknown';
  const L = [PERF_BEGIN, ''];
  L.push('Latency of one `mem find`, measured, not estimated. Each figure names its state');
  L.push('(**cold** = a fresh process, index read from the cache on disk; **warm** = index');
  L.push(`already loaded, the search alone), its corpus size and the commit it was measured at (\`${commit}\`).`);
  L.push('');
  L.push('| entries | state | median | P95 | runs | commit |');
  L.push('|---:|---|---:|---:|---:|---|');
  for (const r of a.results) {
    if (r.state === 'not-measured') L.push(`| ${r.entries} | not measured | n/a | n/a | 0 | ${commit} |`);
    else L.push(`| ${r.entries} | ${r.state} | ${fmt(r.medianMs)} ms | ${fmt(r.p95Ms)} ms | ${r.n} | ${commit} |`);
  }
  L.push('');
  L.push(`Measured ${a.finishedAt.slice(0, 10)} on ${e.cpuModel ?? 'unknown CPU'} × ${e.cpuCount}, Node ${e.node}`
    + `${e.workingTreeDirty ? ', working tree dirty' : ''}; a bare Node start is ${fmt(e.nodeStartupMsP50)} ms of every cold figure.`);
  L.push('Capture and digest durations are not measured and therefore not stated here.');
  L.push('Re-measure: `node bench/cold-find.mjs`. Source: `bench/cold-find.json`.');
  L.push('', PERF_END);
  return L.join('\n');
}

/** Replace the marked block of `readme` with the block rendered from `a`. */
export function applyToReadme(readme, a) {
  const i = readme.indexOf(PERF_BEGIN);
  const j = readme.indexOf(PERF_END);
  if (i < 0 || j < i) throw new Error('README has no perf:begin/perf:end markers');
  return readme.slice(0, i) + renderPerfBlock(a) + readme.slice(j + PERF_END.length);
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--readme')) {
    const a = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
    const p = path.join(REPO, 'README.md');
    fs.writeFileSync(p, applyToReadme(fs.readFileSync(p, 'utf8'), a));
    console.log('README perf block rendered from bench/cold-find.json');
    return;
  }
  const sizes = opt('--sizes', DEFAULT_SIZES.join(',')).split(',').map(Number);
  const runs = Number(opt('--runs', 30));
  const maxMs = Number(opt('--max-minutes', 10)) * 60000;
  const env = environment();
  const startedAt = new Date().toISOString();
  env.nodeStartupMsP50 = +pct(Array.from({ length: 15 }, () => {
    const s = performance.now();
    spawnSync(process.execPath, ['-e', '0']);
    return performance.now() - s;
  }).sort((x, y) => x - y), 50).toFixed(2);
  const results = [];
  for (const n of sizes) {
    process.stderr.write(`measuring ${n} ...\n`);
    results.push(...measureSize(n, { runs, maxMs }));
  }
  const artifact = {
    schemaVersion: 1, tool: 'cheap-mem cold-find', startedAt, finishedAt: new Date().toISOString(),
    query: QUERY, runsPerCell: runs, corpus: 'bench/scale.mjs buildCorpus, seed 42', environment: env, results,
  };
  fs.writeFileSync(ARTIFACT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(renderPerfBlock(artifact));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
