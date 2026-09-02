// bench/retrieval.mjs — measured numbers for cheap-mem's retrieval.
//
// The comparison tables that float around ("~0 ms", "< 20 ms via BM25")
// are guesses. This turns them into facts: it runs the REAL retrieval
// path — buildIndex + search from src/search.mjs — over a fixed, labelled
// corpus and reports latency and recall you can quote.
//
// It is deliberately honest about the one place BM25 is weak: pure
// paraphrase with no shared word. Those queries are labelled 'paraphrase'
// and reported on their own line, so the number motivates the optional
// local-embedding rerank instead of hiding behind an average.
//
// Pure Node, zero dependencies, deterministic. Run:
//   node bench/retrieval.mjs           # human table
//   node bench/retrieval.mjs --json    # + machine-readable result
//
// It writes nothing into any real memory: the corpus is materialised in
// a throwaway directory under the OS temp dir and removed at the end.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildIndex, search } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';

// --- The labelled corpus ------------------------------------------------
//
// A small software team's memory. Each doc has a stable id so queries can
// name the exact entries a human would call correct. Kept plain so the
// redaction pre-commit never trips on it.

export const DOCS = [
  { type: 'decision', id: 'd-postgres', title: 'Chose PostgreSQL over MongoDB for the billing service', choice: 'PostgreSQL', why: 'transactions and strong consistency matter for money; document flexibility was not needed', tags: ['database', 'billing', 'architecture'] },
  { type: 'decision', id: 'd-redis', title: 'Added Redis as a cache in front of the product catalog', choice: 'Redis', why: 'catalog reads dominate traffic and the data rarely changes', tags: ['cache', 'performance'] },
  { type: 'error', id: 'e-oom', class: 'crash', title: 'Node process killed by OOM during CSV import', text: 'importing a 2 GB CSV loaded the whole file into memory; streaming it row by row fixed the crash', tags: ['memory', 'import'] },
  { type: 'error', id: 'e-timeout', class: 'outage', title: 'Checkout timed out under load', text: 'the payment call blocked the event loop; moving it to a worker restored response time', tags: ['checkout', 'latency', 'payments'] },
  { type: 'event', id: 'ev-launch', title: 'Launched the mobile app version 1 on the App Store', tags: ['release', 'mobile'] },
  { type: 'event', id: 'ev-hire', title: 'Maria joined the company as lead designer', tags: ['team', 'hiring'] },
  { type: 'learning', id: 'l-flake', title: 'A failing test is never just a flake', learning: 'a test we nearly quarantined was catching a real race condition', tags: ['testing', 'ci'] },
  { type: 'learning', id: 'l-secrets', title: 'Never paste credentials into a chat window', learning: 'rotate the keys, do not rewrite history, and keep the value out of logs', tags: ['security'] },
  { type: 'decision', id: 'd-tailwind', title: 'Adopted Tailwind for the new dashboard', choice: 'Tailwind CSS', why: 'utility classes kept the team consistent without a full design system', tags: ['frontend'] },
  { type: 'error', id: 'e-cors', class: 'bug', title: 'CORS blocked the API from the staging domain', text: 'the allowlist missed the new preview URLs so the browser rejected every request', tags: ['cors', 'api', 'staging'] },
  { type: 'decision', id: 'd-monorepo', title: 'Moved the services into a single monorepo', choice: 'monorepo', why: 'shared types drifted across separate repos and broke releases', tags: ['tooling'] },
  { type: 'event', id: 'ev-incident', title: 'Payment provider outage took checkout down for forty minutes', tags: ['incident', 'payments'] },
  { type: 'learning', id: 'l-cache', title: 'Cache invalidation needs an explicit key, not a TTL guess', learning: 'users were shown stale prices for hours after a change because the entry only expired on a timer', tags: ['cache', 'correctness'] },
  { type: 'error', id: 'e-migration', class: 'data-loss', title: 'A migration truncated the orders table', text: 'a filtered script ran without its where clause and removed rows it should have kept', tags: ['database', 'migration'] },
  { type: 'decision', id: 'd-login', title: 'Chose email one-time codes over passwords for login', choice: 'one-time codes', why: 'fewer support tickets and no password database to leak', tags: ['auth', 'login'] },
  { type: 'skill', id: 's-playwright', skill: 'Set up Playwright end-to-end tests in CI', text: 'headless Chromium, a single worker, screenshots captured on failure', tags: ['testing', 'playwright'] },
  { type: 'event', id: 'ev-customer', title: 'First paying customer signed up', tags: ['milestone', 'revenue'] },
  { type: 'error', id: 'e-disk', class: 'outage', title: 'Server ran out of disk from unrotated logs', text: 'log files filled the volume until writes failed; logrotate now caps them', tags: ['ops', 'disk'] },
  { type: 'decision', id: 'd-queue', title: 'Introduced a job queue for sending email', choice: 'job queue', why: 'sending inline slowed requests and lost mail whenever a process crashed', tags: ['queue', 'email'] },
  { type: 'learning', id: 'l-runbook', title: 'Write the runbook before the on-call rotation, not after', learning: 'the first incident is a bad time to discover the steps were never written down', tags: ['ops', 'oncall'] },
  { type: 'thought', id: 't-vendor', title: 'We may be too dependent on a single payment vendor', text: 'one outage there stops all revenue, so a fallback provider is worth exploring', tags: ['payments', 'risk'] },
  { type: 'error', id: 'e-race', class: 'bug', title: 'A shopper was billed twice from a race condition', text: 'two quick clicks created two separate charges; an idempotency key now prevents it', tags: ['payments', 'concurrency'] },
];

// kind: 'lexical'  — shares words with the target (BM25's home turf)
//       'paraphrase'— little or no shared word; the honest hard case
//       'concept'   — broad query, several entries count as correct
export const QUERIES = [
  { q: 'postgresql for billing', gold: ['d-postgres'], kind: 'lexical' },
  { q: 'redis cache for the catalog', gold: ['d-redis'], kind: 'lexical' },
  { q: 'out of memory during csv import', gold: ['e-oom'], kind: 'lexical' },
  { q: 'cors blocked on staging', gold: ['e-cors'], kind: 'lexical' },
  { q: 'playwright tests in ci', gold: ['s-playwright'], kind: 'lexical' },
  { q: 'disk full from logs', gold: ['e-disk'], kind: 'lexical' },
  { q: 'monorepo decision', gold: ['d-monorepo'], kind: 'lexical' },
  { q: 'login without passwords', gold: ['d-login'], kind: 'lexical' },

  { q: 'a shopper paid two times for one order', gold: ['e-race'], kind: 'paraphrase' },
  { q: 'we rely too heavily on one billing provider', gold: ['t-vendor'], kind: 'paraphrase' },
  { q: 'someone accidentally deleted order records', gold: ['e-migration'], kind: 'paraphrase' },
  { q: 'customers kept seeing outdated amounts after an update', gold: ['l-cache'], kind: 'paraphrase' },
  { q: 'keeping secret keys out of harm', gold: ['l-secrets'], kind: 'paraphrase' },
  { q: 'who did we bring onto the team', gold: ['ev-hire'], kind: 'paraphrase' },

  { q: 'problems with our payment system', gold: ['e-timeout', 'ev-incident', 'e-race', 't-vendor'], kind: 'concept' },
  { q: 'things we learned the hard way', gold: ['l-flake', 'l-secrets', 'l-cache', 'l-runbook'], kind: 'concept' },
];

const KS = [1, 3, 5, 10];

// --- Materialise the corpus in a throwaway root -------------------------

export function buildCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-bench-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ language: 'en' }));
  // Deterministic timestamps so ordering never depends on the clock.
  let t = Date.parse('2026-01-01T00:00:00Z');
  for (const doc of DOCS) {
    const { type, ...data } = doc;
    memory.logEntry(root, type, data, { now: new Date(t) });
    t += 60_000;
  }
  return root;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// --- The benchmark ------------------------------------------------------

export function runBenchmark({ repeats = 200 } = {}) {
  const root = buildCorpus();
  try {
    const tBuild0 = performance.now();
    const index = buildIndex(root, { language: 'en' });
    const buildMs = performance.now() - tBuild0;

    const perQuery = [];
    const latencies = [];
    for (const { q, gold, kind } of QUERIES) {
      // rank of the first gold id in the top-10, or Infinity if missed
      const hits = search(index, q, { top: 10, minScore: 0 });
      let rank = Infinity;
      for (let i = 0; i < hits.length; i += 1) {
        if (gold.includes(hits[i].entry.id)) { rank = i + 1; break; }
      }
      // time only the search call, many times, to get a stable figure
      for (let r = 0; r < repeats; r += 1) {
        const t0 = performance.now();
        search(index, q, { top: 10, minScore: 0 });
        latencies.push(performance.now() - t0);
      }
      perQuery.push({ q, kind, rank });
    }

    const byKind = {};
    for (const row of perQuery) {
      (byKind[row.kind] ??= []).push(row);
    }

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

function round(x) { return Math.round(x * 1000) / 1000; }
function pct(x) { return (x * 100).toFixed(0) + '%'; }

function printReport(res) {
  const L = res.latencyMs;
  console.log('cheap-mem retrieval benchmark');
  console.log('='.repeat(52));
  console.log(`corpus:   ${res.corpus.docs} docs -> ${res.corpus.indexedDocs} indexed, ${res.corpus.queries} queries`);
  console.log(`latency:  build ${L.buildIndex} ms | search median ${L.searchMedian} ms | p95 ${L.searchP95} ms  (${L.samples} samples)`);
  console.log('');
  const head = `${'set'.padEnd(12)} ${'n'.padStart(3)}  ${'R@1'.padStart(5)} ${'R@3'.padStart(5)} ${'R@5'.padStart(5)} ${'R@10'.padStart(5)}  ${'MRR'.padStart(5)}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  const row = (name, s) =>
    `${name.padEnd(12)} ${String(s.n).padStart(3)}  ${pct(s['r@1']).padStart(5)} ${pct(s['r@3']).padStart(5)} ${pct(s['r@5']).padStart(5)} ${pct(s['r@10']).padStart(5)}  ${s.mrr.toFixed(2).padStart(5)}`;
  for (const kind of ['lexical', 'paraphrase', 'concept']) {
    if (res.byKind[kind]) console.log(row(kind, res.byKind[kind]));
  }
  console.log('-'.repeat(head.length));
  console.log(row('overall', res.overall));
  if (res.misses.length) {
    console.log('');
    console.log('missed (no gold entry in top 10):');
    for (const q of res.misses) console.log(`  - "${q}"`);
  }
  console.log('');
  console.log('Reading it: lexical is BM25\'s home turf and should be near 100%.');
  console.log('paraphrase is the honest hard case (no shared word) — the gap');
  console.log('there is what an optional local-embedding rerank would close.');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const res = runBenchmark();
  printReport(res);
  if (process.argv.includes('--json')) {
    console.log('');
    console.log(JSON.stringify(res, null, 2));
  }
}
