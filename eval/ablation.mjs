// eval/ablation.mjs — why doesn't the sought fact arrive?
//
// On 13 of 18 tasks, gold does not land in the fed context. That can
// have four causes, and they call for completely different consequences:
//
//   (a) my tasks are worded too independently  -> benchmark bug
//   (b) the corpus is too thin per topic        -> benchmark bug
//   (c) the expansion layers don't engage       -> cheap-mem defect
//   (d) the threshold filters too hard           -> calibratable
//
// This file breaks the failures down accordingly. It runs the SAME
// ablation on the English corpus from bench/tokens.mjs as a positive
// control: a layer that contributes nothing there either is not
// disconnected, and only then does the ablation measure the switch
// instead of the thing itself.
//
//   node eval/ablation.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as search from '../src/search.mjs';
import * as thesaurus from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';

const TOP = 5, MIN = 5.0;

// --- 1. Does the curated thesaurus contribute anything at all on German text?
console.log('=== 1. Curated synonyms: German versus English ===\n');
console.log(`THESAURUS: ${thesaurus.THESAURUS.length} groups, ${thesaurus.THESAURUS.flat().length} words\n`);

function expansion(text, langName) {
  const lang = pack(langName);
  const terms = search.tokenizeGroups(text, { lexicon: null, lang }).flat();
  // Only the curated layer: both learned graphs set to null.
  const added = thesaurus.expand(terms, null, lang, null);
  return { terms: terms.length, added: added.length };
}

const DE = TASKS.map((t) => t.prompt);
const EN = ['why did we pick postgres', 'what is leaking memory', 'how do we roll out releases',
  'tests that fail at random', 'caching strategy', 'queue delivery guarantees',
  'why not embeddings', 'a migration held a lock', 'log format', 'how does login work',
  'duplicate charges', 'stale search results', 'what did we learn about exit codes',
  'when did the beta open', 'disk full incident'];

for (const [name, questions, lng] of [['german', DE, 'de'], ['english', EN, 'en']]) {
  let terms = 0, added = 0, withHit = 0;
  for (const q of questions) { const e = expansion(q, lng); terms += e.terms; added += e.added; if (e.added) withHit += 1; }
  console.log(`${name.padEnd(9)}: ${questions.length} questions, ${terms} terms -> ${added} synonyms `
    + `(${(added / Math.max(1, terms)).toFixed(2)} per term), questions with at least one: ${withHit}/${questions.length}`);
}

// --- 2. Recall under ablation, German benchmark corpus
console.log('\n=== 2. Recall of gold claims under ablation (German corpus) ===\n');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-abl-'));
build(root, { poisoned: false, seed: 3 });
const idx = search.buildIndex(root);
const withGold = TASKS.filter((t) => t.gold.length);

const empty = new Map();
const variants = [
  ['full (everything on)', idx, { mmr: true }],
  ['without MMR', idx, { mmr: false }],
  ['without tagGraph', { ...idx, tagGraph: empty }, { mmr: true }],
  ['without termGraph', { ...idx, termGraph: empty }, { mmr: true }],
  ['without both graphs', { ...idx, tagGraph: empty, termGraph: empty }, { mmr: true }],
];

console.log('Variant              | gold in top-5 | gold over threshold | tasks with empty context');
console.log('---------------------+---------------+---------------------+----------------------------');
for (const [name, index, opt] of variants) {
  let inTop = 0, over = 0, emptyCount = 0;
  for (const t of withGold) {
    const h = search.search(index, t.prompt, { top: TOP, ...opt });
    const hits = h.filter((x) => t.gold.includes(x.entry?.id));
    if (hits.length) inTop += 1;
    if (hits.some((x) => x.score >= MIN)) over += 1;
    if (!h.some((x) => x.score >= MIN)) emptyCount += 1;
  }
  console.log(`${name.padEnd(20)} | ${`${inTop}/${withGold.length}`.padStart(13)} | ${`${over}/${withGold.length}`.padStart(19)} | ${String(emptyCount).padStart(27)}`);
}

// --- 3. What does the threshold alone cost?
console.log('\n=== 3. Effect of the threshold alone (full, MMR on) ===\n');
console.log('Threshold | gold in context | claims total | empty context');
console.log('---------+-----------------+---------------+----------------');
for (const s of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
  let g = 0, c = 0, l = 0;
  for (const t of withGold) {
    const h = search.search(idx, t.prompt, { top: TOP, mmr: true }).filter((x) => x.score >= s);
    c += h.length;
    if (h.some((x) => t.gold.includes(x.entry?.id))) g += 1;
    if (!h.length) l += 1;
  }
  console.log(`${String(s).padStart(8)} | ${`${g}/${withGold.length}`.padStart(15)} | ${String(c).padStart(13)} | ${String(l).padStart(14)}`);
}
fs.rmSync(root, { recursive: true, force: true });
