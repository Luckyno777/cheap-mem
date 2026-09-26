// eval/independence.mjs — does the task give away its own answer?
//
// CRITERION, third and final version. The first two were wrong, and
// both errors ran the same direction: too strict.
//
//   1. "no shared word" -> the tasks were gutted so that BM25 could no
//      longer find the gold AT ALL. Recall fell to nearly zero; an A/B
//      would have wrongly shown memory as ineffective.
//   2. "no shared RARE word" -> also wrong. If a fact appears once in
//      the corpus, its topic word is rare by construction. That a
//      question about the health check contains the word "health
//      check" is not leakage — that is the normal case memory exists for.
//
// Leakage is when the question contains the ANSWER, not when it names
// the topic. That was exactly the finding on bench/tokens.mjs: there
// "duplicate charges" appears as the question and "duplicate charges"
// as the answer, and string equality is what gets measured.
//
// So TWO quantities are measured, and only the first one is a bug:
//
//   GIVEN AWAY   the QUESTION already satisfies the task's scoring rule.
//                Then the answer is in the question, and the task tests
//                nothing. This is exactly checkable, because
//                `must`/`mustNot` already define what counts as correct
//                — a word-share metric would be too crude for this:
//                "Port 9443" has two content words, one of them the
//                topic, and a question about the port would wrongly
//                fail as a result.
//   TOPICAL      the question names the topic, not the answer. Normal.
//
// Alongside that, on equal footing: is the gold findable at all? A task
// whose gold the retriever CANNOT find measures nothing about benefit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as search from '../src/search.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { FACTS } from './world.mjs';

const words = (s) => String(s).toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
const FACT = new Map(FACTS.map((f) => [f.id, f]));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ind-'));
build(root, { poisoned: false });
const idx = search.buildIndex(root);
const N = idx.documents.length;
const texts = idx.documents.map((d) => JSON.stringify(d.entry ?? d));
const df = new Map();
for (const t of texts) for (const w of new Set(words(t))) df.set(w, (df.get(w) ?? 0) + 1);
// CRITERION CORRECTED (2026-09-06). It first said: no shared rare word.
// That gutted the tasks so BM25 could NO LONGER FIND the gold entry AT
// ALL — recall fell to nearly zero and any A/C comparison would have
// wrongly shown memory as ineffective.
//
// A shared word is not the problem. A word that UNIQUELY IDENTIFIES the
// gold entry is the problem. A user says "port" when they mean a port;
// the safeguard is that distractor entries are also about ports.
const IDENTIFYING = 3;   // occurs in <= 3 documents -> points straight at the gold

console.log(`Corpus: ${N} documents\n`);
console.log('Task | Cl | question already satisfies the rule? | topical overlap');
console.log('-----+----+---------------------------------------+-----------------');
let givenAway = 0, topical = 0, noGold = 0;
for (const t of TASKS) {
  if (!t.gold.length) { noGold += 1; continue; }
  // Exact: would the QUESTION itself pass as a correct answer? The
  // formatting instruction at the end is not part of the question.
  // "Answer yes or no" contains the word the rule requires without the
  // question giving anything away.
  const coreQuestion = t.prompt.replace(/\s*(Antworte|Nenne|Nur)\b[^.]*\.?\s*$/i, '').trim();
  const bad = t.must.every((re) => re.test(coreQuestion)) && t.mustNot.every((re) => !re.test(coreQuestion));
  const qw = new Set(words(t.prompt));
  let shared = [];
  for (const gid of t.gold) {
    const f = FACT.get(gid);
    if (f) shared.push(...words(f.kern.wahl).filter((w) => qw.has(w)));
  }
  shared = [...new Set(shared)];
  if (bad) givenAway += 1; else topical += 1;
  console.log(`${t.id.padEnd(4)} | ${t.klasse.padEnd(2)} | ${(bad ? 'YES — the question is the answer' : 'no').padEnd(39)} | ${shared.join(' ') || '—'}`);
}


// Second mandatory number. A task whose gold the retriever CANNOT find
// measures nothing about memory's benefit — it only measures that BM25
// is lexical. Without this number, the first draft would have produced
// a false negative.
const ret = await import('../src/retrieval.mjs');
const { grantProject } = await import('../src/capability.mjs');
const { PROJECT } = await import('./world.mjs');
let findable = 0, withGold = 0;
const scores = [];
console.log('\nFindability (top 5, no threshold):');
for (const t of TASKS) {
  if (!t.gold.length) continue;
  withGold += 1;
  const r = ret.retrieve(root, t.prompt, grantProject(PROJECT), { top: 5 });
  scores.push(...r.claims.map((c) => c.score));
  const hit = t.gold.filter((g) => r.claims.some((c) => c.id === g));
  if (hit.length) findable += 1;
  console.log(`  ${t.id.padEnd(4)} gold ${hit.length ? 'found (' + hit.join(',') + ')' : 'NOT found'}   best score ${(r.claims[0]?.score ?? 0).toFixed(2)}`);
}
scores.sort((a, b) => a - b);
const q = (p) => (scores[Math.floor(scores.length * p)] ?? 0).toFixed(2);
console.log(`\n  Gold findable on ${findable}/${withGold} tasks`);
console.log(`  Score distribution (n=${scores.length}): min ${scores[0]?.toFixed(2)} p50 ${q(0.5)} p90 ${q(0.9)} max ${scores.at(-1)?.toFixed(2)}`);
console.log(`  Share >= 5.0 (default threshold MEM_RETRIEVE_MIN): ${(scores.filter((x) => x >= 5).length / scores.length * 100).toFixed(1)}%`);

console.log('');
console.log(`Tasks with gold: ${TASKS.length - noGold}   of those`);
console.log(`  GIVEN AWAY (question contains the answer): ${givenAway}`);
console.log(`  topical only (normal case):                ${topical}`);
console.log(`Tasks without gold (class F, deliberate): ${noGold}`);
console.log('');
console.log('For comparison, bench/tokens.mjs: there the question is, for several');
console.log('pairs, literally the answer ("duplicate charges").');
if (givenAway) {
  console.log(`\n  ==> ${givenAway} task(s) contain their own answer. Reword them.`);
  process.exitCode = 1;
} else {
  console.log('\n  ==> No task gives away its answer. Topical overlap remains and is');
  console.log('      intended: that is simply what a human would ask about.');
}
fs.rmSync(root, { recursive: true, force: true });
