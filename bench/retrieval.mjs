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
// **What the learned co-occurrence thesaurus is actually worth** (measured
// here on 2026-09-05, 67 docs / 42 queries, by running the same corpus with
// and without it):
//
//   lexical      R@1 100% -> 100%   MRR 1.000 -> 1.000   (no harm)
//   paraphrase   R@1  50% ->  50%   MRR 0.646 -> 0.638   (marginally worse)
//   concept      R@1  50% ->  67%   MRR 0.660 -> 0.774   (the real gain)
//   overall                          MRR 0.817 -> 0.830
//
// So it earns its place on BROAD queries, where corpus-learned associations
// are exactly what is missing, and it is not a paraphrase cure — that gap
// stays open and honest. Worth recording, because the earlier 22-document
// version of this corpus moved by exactly zero in either direction and
// could not have told us any of this.
//
// **Coordination (`coverage`), found by using the tool** (2026-09-05).
// Browsing a real 607-entry memory for "viewer ausfall", the entry
// containing BOTH words sat at rank 2 (score 15.16) behind one carrying
// only "ausfall" (16.10). BM25 sums term scores and has no notion of
// "answered more of the question", so a frequent word out-sums an exact
// match. Multiplying by (typed terms matched / typed terms)^1 fixes it:
//
//   here        MRR 0.830 -> 0.834, lexical R@1 stays 100%, flat across
//               the exponent, never worse at any setting
//   real corpus 1 of 9 hand queries changed its top hit — the broken one,
//               from wrong to right; the other 8 did not move
//
// On by default, because unlike the experiment below it helped on both
// corpora and harmed neither. Only the words actually TYPED count:
// rewarding coverage of the thesaurus expansion would reward the
// expansion, not the query.
//
// **Pseudo-relevance feedback: measured, and deliberately NOT shipped**
// (2026-09-05). PRF borrows the words shared by the first pass's own top
// hits and searches again. Built it, measured it, threw it away:
//
//   on this corpus   3 of 42 queries moved: 2 up, 1 down (net +1 on R@1)
//   drift curve      borrowed-term weight 0.35 -> lexical R@1 100%
//                    weight 1.0 -> 95%, weight 2.0 -> 80%, weight 5.0 -> 75%
//
// A wash here. What killed it was the REAL corpus (601 entries): the guard
// against drift was agreement — only borrow a word that several of the top
// hits share. On a real memory that guard inverts. Asked "where are the
// secrets and how are they protected", two of the three top hits happened
// to come from the largest topic cluster, so the borrowed words were
// `fass, faellig, timer, befund, faelligkeits-logik` — every one of them
// about a digest timer, none about secrets — and the one genuinely correct
// hit was pushed down. Agreement among top hits is not agreement with the
// query; in a memory dominated by one busy topic they are opposites.
//
// Recorded here rather than deleted, because "we tried it, here is the
// number, here is why not" is worth more than a knob nobody should turn.
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

  // --- Grown on 2026-09-05 -----------------------------------------------
  //
  // Twenty-two documents were too few to measure anything: a change to the
  // ranking moved no number at all, in either direction, so the benchmark
  // could not do the one job it exists for. These are written as a real
  // team's memory would accumulate — in THREADS (payments, auth, database,
  // ci, ops, frontend) whose entries naturally share vocabulary, because
  // that is what a real corpus looks like.
  //
  // Written before measuring, and deliberately NOT tuned to flatter the
  // learned co-occurrence thesaurus. If it does not help here, the table
  // below will say so.

  // auth thread
  { type: 'error', id: 'e-session', class: 'bug', title: 'Sessions were dropped whenever the API restarted', text: 'session state lived in process memory, so every deploy logged everyone out', tags: ['auth', 'session'] },
  { type: 'decision', id: 'd-oauth', title: 'Added Google sign-in alongside our own login', choice: 'OAuth with Google', why: 'most signups already had a Google account and abandoned the form at the password step', tags: ['auth', 'login'] },
  { type: 'decision', id: 'd-mfa', title: 'Made two-factor mandatory for admin accounts only', choice: 'MFA for admins', why: 'forcing it on everyone cost signups; the admin blast radius is what actually matters', tags: ['auth', 'security'] },
  { type: 'error', id: 'e-reset', class: 'bug', title: 'Password reset links stayed valid after being used', text: 'the token was never consumed, so an old mail could take over an account days later', tags: ['auth', 'security'] },
  { type: 'learning', id: 'l-session', title: 'Anything kept in process memory disappears on deploy', learning: 'sessions, counters and caches all bit us the same way before we moved them out', tags: ['auth', 'architecture'] },

  // payments thread
  { type: 'decision', id: 'd-refund', title: 'Refunds go through the original payment method only', choice: 'same-method refunds', why: 'paying back to a different account turned into a fraud vector', tags: ['payments', 'fraud'] },
  { type: 'error', id: 'e-rounding', class: 'bug', title: 'Currency rounding lost a cent on split invoices', text: 'floating point maths on money; amounts are integer minor units now', tags: ['payments', 'billing'] },
  { type: 'decision', id: 'd-adyen', title: 'Started migrating from the single payment vendor to a second one', choice: 'second provider', why: 'the forty-minute outage stopped all revenue and made the risk concrete', tags: ['payments', 'vendor'] },
  { type: 'error', id: 'e-chargeback', class: 'process', title: 'Chargebacks were not reconciled for two months', text: 'nobody owned the report, so disputed charges silently stayed in revenue', tags: ['payments', 'billing'] },
  { type: 'learning', id: 'l-money', title: 'Never store money as a floating point number', learning: 'every rounding bug we had came from the same shortcut', tags: ['payments', 'correctness'] },

  // database thread
  { type: 'error', id: 'e-index', class: 'performance', title: 'A missing index made the orders list take nine seconds', text: 'a sequential scan over every row; the query planner showed it immediately', tags: ['database', 'performance'] },
  { type: 'error', id: 'e-pool', class: 'outage', title: 'Connection pool exhaustion during the sale', text: 'long transactions held connections open and new requests queued until they timed out', tags: ['database', 'latency'] },
  { type: 'decision', id: 'd-replica', title: 'Reporting queries moved to a read replica', choice: 'read replica', why: 'analytics scans were competing with checkout for the same database', tags: ['database', 'reporting'] },
  { type: 'event', id: 'ev-restore', title: 'Practised a full database restore from backup', tags: ['database', 'ops'] },
  { type: 'learning', id: 'l-backup', title: 'A backup nobody has restored is not a backup', learning: 'the first drill found the dump was missing a schema entirely', tags: ['database', 'ops'] },

  // ci / testing thread
  { type: 'decision', id: 'd-retry', title: 'CI retries a failed job once, and never silently', choice: 'one visible retry', why: 'unlimited retries hid real breakage; one retry with a marker keeps it honest', tags: ['ci', 'testing'] },
  { type: 'error', id: 'e-seed', class: 'bug', title: 'Tests passed locally and failed in CI on seed data', text: 'the local database kept rows from earlier runs that the pipeline never had', tags: ['ci', 'testing'] },
  { type: 'decision', id: 'd-coverage', title: 'Coverage gate set at a floor, not a target', choice: 'floor not target', why: 'a target invited tests written only to move the number', tags: ['ci', 'testing'] },
  { type: 'error', id: 'e-cicost', class: 'cost', title: 'CI minutes tripled after the monorepo move', text: 'every push ran every package; path filters brought it back down', tags: ['ci', 'tooling'] },
  { type: 'skill', id: 's-profiling', skill: 'Profiling a Node service under load', text: 'flame graphs from the running process pointed at JSON serialisation, not the database', tags: ['performance', 'profiling'] },

  // ops / infra thread
  { type: 'error', id: 'e-tls', class: 'outage', title: 'An expired TLS certificate took the site down on a Sunday', text: 'renewal was manual and the reminder went to someone who had left', tags: ['ops', 'tls'] },
  { type: 'decision', id: 'd-alerts', title: 'Deleted every alert nobody had acted on', choice: 'fewer alerts', why: 'the channel was noise, so the one real page was missed', tags: ['ops', 'oncall'] },
  { type: 'decision', id: 'd-k8s', title: 'Stayed on plain containers instead of Kubernetes', choice: 'no Kubernetes', why: 'three services do not need a cluster and nobody on the team wanted to operate one', tags: ['ops', 'infrastructure'] },
  { type: 'event', id: 'ev-postmortem', title: 'First blameless postmortem after the checkout outage', tags: ['ops', 'process'] },
  { type: 'learning', id: 'l-alert', title: 'An alert nobody acts on trains people to ignore all of them', learning: 'we missed a real page because the channel had cried wolf for months', tags: ['ops', 'oncall'] },
  { type: 'error', id: 'e-clock', class: 'bug', title: 'Scheduled jobs fired twice during the daylight saving change', text: 'local time was used for scheduling; everything runs in UTC now', tags: ['ops', 'time'] },

  // frontend thread
  { type: 'error', id: 'e-bundle', class: 'performance', title: 'The dashboard bundle grew past two megabytes', text: 'a date library was imported whole for one function; the tree shook after the import changed', tags: ['frontend', 'performance'] },
  { type: 'decision', id: 'd-i18n', title: 'Translations live in the repository, not in a service', choice: 'files in the repo', why: 'a missing translation should break the build, not appear as a blank label in production', tags: ['frontend', 'i18n'] },
  { type: 'error', id: 'e-a11y', class: 'accessibility', title: 'The checkout form was unusable with a keyboard', text: 'focus order jumped and the error text was never announced', tags: ['frontend', 'accessibility'] },
  { type: 'learning', id: 'l-ssr', title: 'Server rendering paid off for the catalog, not for the dashboard', learning: 'public pages needed the first paint; a tool people keep open all day did not', tags: ['frontend', 'performance'] },

  // security thread
  { type: 'event', id: 'ev-pentest', title: 'External penetration test found two medium issues', tags: ['security', 'audit'] },
  { type: 'error', id: 'e-cve', class: 'security', title: 'A transitive dependency shipped a known vulnerability for weeks', text: 'nothing watched the tree, so the advisory sat unread until the audit', tags: ['security', 'dependencies'] },
  { type: 'decision', id: 'd-scanning', title: 'Secret scanning runs before the commit, not in review', choice: 'pre-commit scanning', why: 'catching it in review means it already exists in a branch somebody can fetch', tags: ['security'] },
  { type: 'learning', id: 'l-rotate', title: 'Rotating is cheaper than proving nothing happened', learning: 'we spent a day reading logs when twenty minutes of rotation would have closed it', tags: ['security'] },

  // cache / queue threads
  { type: 'error', id: 'e-stampede', class: 'outage', title: 'Every cache entry expired at once and buried the database', text: 'identical time to live for all keys; a random spread fixed the thundering herd', tags: ['cache', 'performance'] },
  { type: 'decision', id: 'd-dlq', title: 'Failed jobs go to a dead letter queue instead of retrying forever', choice: 'dead letter queue', why: 'a poison message spun the workers for a whole night', tags: ['queue', 'ops'] },
  { type: 'error', id: 'e-mailorder', class: 'bug', title: 'Welcome mail arrived after the first invoice', text: 'two queues with different speeds and no ordering guarantee between them', tags: ['queue', 'email'] },

  // product / team thread
  { type: 'event', id: 'ev-pricing', title: 'Changed pricing from per seat to usage based', tags: ['pricing', 'product'] },
  { type: 'thought', id: 't-selfhost', title: 'Larger customers keep asking to run it themselves', text: 'a self-hosted edition would open the enterprise deals but doubles the support surface', tags: ['product', 'strategy'] },
  { type: 'decision', id: 'd-standup', title: 'Replaced the daily standup with a written update', choice: 'written update', why: 'half the team is in another timezone and the meeting only served the other half', tags: ['team', 'process'] },
  { type: 'event', id: 'ev-churn', title: 'Two enterprise customers left in the same quarter', tags: ['churn', 'revenue'] },
  { type: 'thought', id: 't-support', title: 'Support load grows faster than the customer count', text: 'the same five questions repeat, which points at the product rather than the team size', tags: ['support', 'product'] },
  { type: 'learning', id: 'l-onboarding', title: 'Customers who finish setup in the first day almost never churn', learning: 'the ones we lost had all stalled somewhere in the first hour', tags: ['product', 'churn'] },
  { type: 'duty', id: 'du-soc2', title: 'Collect evidence for the SOC 2 audit', who: 'ops', tags: ['compliance', 'audit'] },
  { type: 'update', id: 'up-node', title: 'Upgraded the runtime to Node 22 across all services', text: 'the old version left long term support and the test suite passed unchanged', tags: ['tooling', 'dependencies'] },
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

  { q: 'problems with our payment system', gold: ['e-timeout', 'ev-incident', 'e-race', 't-vendor', 'e-rounding', 'e-chargeback', 'd-adyen'], kind: 'concept' },
  { q: 'things we learned the hard way', gold: ['l-flake', 'l-secrets', 'l-cache', 'l-runbook', 'l-money', 'l-backup', 'l-alert', 'l-session', 'l-rotate', 'l-ssr', 'l-onboarding'], kind: 'concept' },

  // --- Added with the corpus growth on 2026-09-05 ------------------------

  { q: 'missing index sequential scan', gold: ['e-index'], kind: 'lexical' },
  { q: 'connection pool exhaustion', gold: ['e-pool'], kind: 'lexical' },
  { q: 'tls certificate expired', gold: ['e-tls'], kind: 'lexical' },
  { q: 'read replica for reporting', gold: ['d-replica'], kind: 'lexical' },
  { q: 'dead letter queue', gold: ['d-dlq'], kind: 'lexical' },
  { q: 'kubernetes decision', gold: ['d-k8s'], kind: 'lexical' },
  { q: 'coverage gate', gold: ['d-coverage'], kind: 'lexical' },
  { q: 'daylight saving scheduled jobs', gold: ['e-clock'], kind: 'lexical' },
  { q: 'dashboard bundle size', gold: ['e-bundle'], kind: 'lexical' },
  { q: 'two factor for admins', gold: ['d-mfa'], kind: 'lexical' },
  { q: 'node 22 upgrade', gold: ['up-node'], kind: 'lexical' },
  { q: 'soc 2 evidence', gold: ['du-soc2'], kind: 'lexical' },

  { q: 'everyone got logged out when we shipped', gold: ['e-session'], kind: 'paraphrase' },
  { q: 'a cent went missing on split invoices', gold: ['e-rounding'], kind: 'paraphrase' },
  { q: 'the site was down because nobody renewed something', gold: ['e-tls'], kind: 'paraphrase' },
  { q: 'we get paged too often for nothing', gold: ['d-alerts', 'l-alert'], kind: 'paraphrase' },
  { q: 'an old mail could still take over an account', gold: ['e-reset'], kind: 'paraphrase' },
  { q: 'the form cannot be used without a mouse', gold: ['e-a11y'], kind: 'paraphrase' },
  { q: 'everything expired at the same moment and overwhelmed us', gold: ['e-stampede'], kind: 'paraphrase' },
  { q: 'big clients want to run it on their own machines', gold: ['t-selfhost'], kind: 'paraphrase' },
  { q: 'we never checked whether the dump could be brought back', gold: ['l-backup', 'ev-restore'], kind: 'paraphrase' },
  { q: 'people who stall at the beginning tend to leave', gold: ['l-onboarding'], kind: 'paraphrase' },

  { q: 'why is checkout slow', gold: ['e-timeout', 'e-pool', 'e-index', 'e-stampede'], kind: 'concept' },
  { q: 'how do we keep credentials safe', gold: ['l-secrets', 'd-scanning', 'l-rotate', 'e-cve'], kind: 'concept' },
  { q: 'what did we change about the database', gold: ['d-postgres', 'd-replica', 'e-index', 'e-migration', 'e-pool'], kind: 'concept' },
  { q: 'why are customers leaving', gold: ['ev-churn', 'l-onboarding', 't-support'], kind: 'concept' },
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

export function runBenchmark({ repeats = 200, opts = {} } = {}) {
  // `opts` is merged into every search call, so an A/B (with and without
  // a retrieval feature) is one flag away and reproducible by anyone —
  // rather than a temporary edit that leaves no trace of how a number in
  // the header block was produced.
  const searchOpts = { top: 10, minScore: 0, ...opts };
  const root = buildCorpus();
  try {
    const tBuild0 = performance.now();
    const index = buildIndex(root, { language: 'en' });
    const buildMs = performance.now() - tBuild0;

    const perQuery = [];
    const latencies = [];
    for (const { q, gold, kind } of QUERIES) {
      // rank of the first gold id in the top-10, or Infinity if missed
      const hits = search(index, q, searchOpts);
      let rank = Infinity;
      for (let i = 0; i < hits.length; i += 1) {
        if (gold.includes(hits[i].entry.id)) { rank = i + 1; break; }
      }
      // time only the search call, many times, to get a stable figure
      for (let r = 0; r < repeats; r += 1) {
        const t0 = performance.now();
        search(index, q, searchOpts);
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
      perQuery,   // per-query ranks, so an A/B can say WHICH query moved
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
