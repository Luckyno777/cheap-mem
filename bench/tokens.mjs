/**
 * tokens.mjs — how many tokens does a session actually spend on memory?
 *
 *   node test/bench/tokens.mjs [--root <a real memory>]
 *
 * The README used to claim "80-95% fewer tokens" against an
 * always-in-context setup. Nobody had measured it. This measures it.
 *
 * Two patterns, same corpus, same questions:
 *
 *   ALWAYS-IN-CONTEXT   the whole memory is pasted into every prompt.
 *                       That is the Obsidian-vault-in-the-system-prompt
 *                       pattern, and the honest baseline: it always has
 *                       the answer, it just pays for everything.
 *
 *   ON-DEMAND           `mem context` once at session start, then one
 *                       `mem find` per question, and only the hits go
 *                       into the prompt.
 *
 * Counting: tokens are estimated, not tokenized. There is no tokenizer
 * here on purpose — adding a dependency to a benchmark that ships with
 * the tool is a bad trade. The estimate is characters/4, the standard
 * rule of thumb for English, applied identically to both sides. That
 * makes the RATIO trustworthy even though the absolute numbers are
 * approximate. Do not quote the absolutes.
 *
 * What this does NOT measure: answer quality. A pattern that puts less
 * in the prompt is only cheaper, not better, if it still contains the
 * answer. The script therefore also reports how often the on-demand
 * path actually retrieved the entry that holds the answer — a cost
 * saving with a miss rate is not a saving.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

const CHARS_PER_TOKEN = 4;
const TOP = Number(process.env.BENCH_TOP ?? 5);
const est = (s) => Math.ceil(String(s).length / CHARS_PER_TOKEN);

/**
 * A synthetic memory that looks like a year of real work.
 *
 * **Variety is the whole point.** The first version of this generator
 * repeated eight templates fifty times each, so every entry carried the
 * tag `deploy` — which made `deploy` appear in 100% of documents and
 * therefore worth almost nothing under BM25 (idf ≈ 0.02). The benchmark
 * then "found" that search could not answer "how do we deploy", which
 * said nothing about the search and everything about the corpus.
 *
 * A benchmark on degenerate data measures the data.
 */
function buildCorpus(root) {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });

  const decisions = [
    ['auth', 'session cookies over JWT', 'revocation matters more than statelessness here', ['auth', 'security']],
    ['storage', 'Postgres over MySQL', 'we need JSONB and partial indexes', ['database', 'architecture']],
    ['ci', 'pin the runner image', 'the hosted image drifted twice in one month', ['ci', 'tooling']],
    ['rollout', 'blue-green over rolling', 'a rollback must not require a rebuild', ['deploy', 'architecture']],
    ['caching', 'Redis with a five minute TTL', 'staleness is cheaper than a thundering herd', ['cache', 'performance']],
    ['messaging', 'at-least-once delivery', 'exactly-once is a lie across a network boundary', ['queue', 'architecture']],
    ['retrieval', 'BM25 before embeddings', 'a model in the read path costs on every single query', ['search', 'cost']],
    ['observability', 'structured JSON lines', 'grep always works, a log viewer might not be installed', ['logging', 'tooling']],
    ['frontend', 'server-rendered HTML', 'the client bundle was larger than the page it rendered', ['ui', 'performance']],
    ['payments', 'Stripe over a direct integration', 'PCI scope we do not want to own', ['billing', 'vendor']],
    ['scheduling', 'cron over a job runner', 'one moving part instead of three', ['ops', 'simplicity']],
    ['testing', 'integration over unit for the API', 'the bugs were all in the wiring', ['test', 'quality']],
    ['secrets', 'env vars over a vault', 'a vault we forget to renew is worse than a file we own', ['security', 'ops']],
    ['migrations', 'expand then contract', 'a deploy must never need a maintenance window', ['database', 'deploy']],
    ['api', 'cursor pagination', 'offset pagination skipped rows under concurrent writes', ['api', 'correctness']],
    ['monorepo', 'one repository, many packages', 'cross-cutting changes were three PRs before', ['tooling', 'process']],
  ];

  const errors = [
    ['the worker leaks memory under sustained load', 'heap climbs about 40MB an hour until the OOM killer steps in', 'performance', ['memory', 'worker']],
    ['integration suite aborts on roughly one run in five', 'always a different test, never reproducible locally', 'ci', ['flake', 'test']],
    ['a schema migration held a lock for eleven minutes', 'it waited behind a long-running analytics query', 'database', ['migration', 'incident']],
    ['the cache stampedes after every restart', 'every request misses at once and lands on the database', 'performance', ['cache', 'incident']],
    ['webhook retries produced duplicate charges', 'the idempotency key was scoped per request, not per intent', 'billing', ['payments', 'correctness']],
    ['the search index served results from before the last write', 'the cache stamp compared the wrong two numbers', 'search', ['index', 'correctness']],
    ['a background job silently stopped after an exception', 'the supervisor treated a non-zero exit as a clean shutdown', 'ops', ['queue', 'silent-failure']],
    ['TLS handshakes failed only from the CI runner', 'the runner image shipped an expired CA bundle', 'ci', ['network', 'tooling']],
    ['login sessions expired at random for some users', 'two app servers had different clock offsets', 'auth', ['session', 'incident']],
    ['the API returned 200 with an empty body under load', 'a proxy buffer filled and the response was truncated', 'api', ['proxy', 'incident']],
    ['a rollback restored the code but not the feature flag', 'the flag lived in a separate system with its own history', 'deploy', ['rollback', 'process']],
    ['disk filled overnight and writes began to fail', 'log rotation was configured but never enabled', 'ops', ['disk', 'incident']],
  ];

  const events = [
    ['first paying customer signed', 'a two-person team on the starter plan', ['milestone', 'business']],
    ['the beta opened to the waiting list', 'four hundred invitations went out over three days', ['launch', 'business']],
    ['moved off the managed queue to a self-hosted one', 'cost fell by two thirds at the same throughput', ['migration', 'cost']],
    ['the on-call rotation grew to four people', 'nights are no longer a single point of failure', ['team', 'ops']],
    ['dropped support for the old API version', 'six months of warnings, eleven remaining callers', ['api', 'deprecation']],
    ['the security review came back clean', 'two low findings, both in dependencies', ['security', 'audit']],
  ];

  const learnings = [
    ['an exit code is not proof of work', 'a headless session that failed on permissions explains itself and exits zero', ['verification', 'tooling']],
    ['a check that reads a setting will eventually lie', 'measure the effect instead: run the hook, count the rows', ['verification', 'process']],
    ['fail closed, not open', 'an unreadable file must count as too large, never as zero', ['safety', 'design']],
    ['porting is the cheapest bug hunt there is', 'you read every line asking why it is there instead of skimming', ['process', 'quality']],
  ];

  let n = 0;
  const round = (i) => (i > 0 ? ` (round ${i})` : '');
  for (let i = 0; i < 6; i += 1) {
    for (const [topic, choice, why, tags] of decisions) {
      memory.logEntry(root, 'decision', { topic, choice: choice + round(i), why, tags });
      n += 1;
    }
    for (const [title, text, cls, tags] of errors) {
      memory.logEntry(root, 'error', { title: title + round(i), class: cls, text, tags });
      n += 1;
    }
    for (const [title, text, tags] of events) {
      memory.logEntry(root, 'event', { title: title + round(i), text, tags });
      n += 1;
    }
    for (const [title, text, tags] of learnings) {
      memory.logEntry(root, 'learning', { title: title + round(i), text, tags });
      n += 1;
    }
  }
  return n;
}

/** Everything a "paste the vault in" pattern would carry. */
function wholeMemory(root) {
  const parts = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      const p = memory.logPath(root, type, project);
      if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf8'));
    }
  }
  return parts.join('\n');
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bench-'));
  try {
    const count = buildCorpus(root);
    const blob = wholeMemory(root);
    const index = search.buildIndex(root, { language: 'en' });

    // Questions a session would actually ask across one working day.
    // Questions a session would actually ask across a working day.
    // Several deliberately share no word with the entry that answers
    // them — that is the case a literal grep cannot do.
    const questions = [
      ['why did we pick postgres', 'Postgres over MySQL'],
      ['what is leaking memory', 'leaks memory'],
      ['how do we roll out releases', 'blue-green'],
      ['tests that fail at random', 'one run in five'],
      ['caching strategy', 'Redis'],
      ['queue delivery guarantees', 'at-least-once'],
      ['why not embeddings', 'BM25 before embeddings'],
      ['a migration held a lock', 'held a lock'],
      ['log format', 'structured JSON lines'],
      ['how does login work', 'session cookies'],
      ['duplicate charges', 'duplicate charges'],
      ['stale search results', 'before the last write'],
      ['what did we learn about exit codes', 'exit code is not proof'],
      ['when did the beta open', 'beta opened'],
      ['disk full incident', 'disk filled'],
    ];

    const contextDump = memory.context(root, { n: 20 });
    let onDemand = est(contextDump);
    let alwaysIn = 0;
    let found = 0;
    const missed = [];

    for (const [q, needle] of questions) {
      // Always-in-context pays for the whole memory on every turn.
      alwaysIn += est(blob) + est(q);

      // On-demand pays for the query and whatever came back.
      const hits = search.search(index, q, { top: TOP });
      const rendered = hits.map((h) => JSON.stringify(h.entry)).join('\n');
      onDemand += est(q) + est(rendered);
      if (hits.some((h) => JSON.stringify(h.entry).includes(needle))) found += 1;
      else missed.push({ q, needle, got: hits[0] ? (hits[0].entry.title ?? hits[0].entry.choice ?? '?') : '(nothing)' });
    }

    const saved = 1 - onDemand / alwaysIn;
    console.log('');
    console.log(`corpus:            ${count} entries, ${(blob.length / 1024).toFixed(0)} KB`);
    console.log(`questions:         ${questions.length}`);
    console.log('');
    console.log(`always-in-context: ${alwaysIn.toLocaleString()} tokens (estimated)`);
    console.log(`on-demand:         ${onDemand.toLocaleString()} tokens (estimated)`);
    console.log(`saved:             ${(saved * 100).toFixed(1)}%`);
    console.log('');
    console.log(`answer retrieved:  ${found}/${questions.length}`);
    if (missed.length) {
      console.log('  A saving with a miss rate is not a saving. Every miss is a');
      console.log('  question the cheap path could not answer at all:');
      for (const m of missed) {
        console.log(`    "${m.q}" wanted "${m.needle}", got "${String(m.got).slice(0, 50)}"`);
      }
    }
    console.log('');
    console.log('Tokens are estimated as characters/4, applied identically to');
    console.log('both sides. Trust the ratio, not the absolute numbers.');
    return { alwaysIn, onDemand, saved, found, total: questions.length, count };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
