// eval/query-words-effect.mjs — do the query words help at all?
//
// The lever: while digesting, the digester adds three to five words per
// entry that someone would later ASK with, and that do not occur in the
// entry itself. Cost at retrieval time: zero. The work happens on lane
// 2, where a model runs anyway.
//
// The same corpus is measured twice, with and without the field.
// Everything else is equal: same seed, same tasks, same threshold.
//
// What this canNOT measure: whether the digester in real operation
// writes words as usable as the run that generated these did. There it
// sees whole raw captures instead of one line — more context, but also
// more distraction.
//
// And the number is a LOWER BOUND, not an upper bound: the leakage
// guard in query-words.mjs throws out every word that satisfies a
// scoring rule — 13 of 31 entries were affected. In real operation
// there is no scoring rule; there the digester may write exactly these
// words.
//
//   node eval/query-words-effect.mjs [--min 5] [--top 5]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { PROJECT } from './world.mjs';
import { QUERY_WORDS, safeWords } from './query-words.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 5);

const cap = grantProject(PROJECT);
const withGold = TASKS.filter((t) => t.gold.length);

function measure(queryWords) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fw-'));
  build(root, { seed: 3, queryWords });
  let gold = 0, claims = 0, goldClaims = 0;
  const perClass = new Map();
  const hits = new Set();
  for (const t of withGold) {
    const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP });
    const kept = r.claims.filter((c) => c.score >= MIN || (c.exact && c.exact.length));
    claims += kept.length;
    const matched = t.gold.some((g) => kept.some((c) => c.id === g));
    goldClaims += kept.filter((c) => t.gold.includes(c.id)).length;
    if (matched) { gold += 1; hits.add(t.id); }
    if (!perClass.has(t.klasse)) perClass.set(t.klasse, { n: 0, ok: 0 });
    const k = perClass.get(t.klasse); k.n += 1; if (matched) k.ok += 1;
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { gold, claims, goldClaims, perClass, hits };
}

const covered = Object.keys(QUERY_WORDS).filter((k) => safeWords(k).length);
console.log(`Query words present for ${covered.length} facts`);
if (!covered.length) { console.log('Nothing to measure.'); process.exit(1); }
const raw = Object.keys(QUERY_WORDS).reduce((n, k) => n + QUERY_WORDS[k].length, 0);
const words = covered.reduce((n, k) => n + safeWords(k).length, 0);
console.log(`written by the model ${raw}, after the leakage guard ${words}`);
console.log(`on average ${(words / covered.length).toFixed(1)} per entry\n`);

const withoutWords = measure(false);
const withWords = measure(true);
const p = (k, n) => `${k}/${n} = ${(100 * k / Math.max(1, n)).toFixed(0)} %`;

console.log('                                | without query words | with query words');
console.log('--------------------------------+----------------------+------------------');
console.log(`Gold in fed context             | ${p(withoutWords.gold, withGold.length).padStart(18)} | ${p(withWords.gold, withGold.length).padStart(14)}`);
console.log(`Precision (gold per claim)      | ${p(withoutWords.goldClaims, withoutWords.claims).padStart(18)} | ${p(withWords.goldClaims, withWords.claims).padStart(14)}`);

console.log('\nBy class (gold in context):');
for (const [cls, a] of [...withoutWords.perClass].sort()) {
  const b = withWords.perClass.get(cls);
  const arrow = b.ok > a.ok ? ' +' : (b.ok < a.ok ? ' -' : '  ');
  console.log(`  ${cls}  ${String(`${a.ok}/${a.n}`).padStart(6)} -> ${String(`${b.ok}/${b.n}`).padStart(6)}${arrow}`);
}

const gained = [...withWords.hits].filter((x) => !withoutWords.hits.has(x));
const lost = [...withoutWords.hits].filter((x) => !withWords.hits.has(x));
console.log(`\ngained: ${gained.length ? gained.join(' ') : '(none)'}`);
console.log(`lost: ${lost.length ? lost.join(' ') : '(none)'}`);
console.log(`\nnet ${withWords.gold - withoutWords.gold} tasks out of ${withGold.length}.`);
console.log('For comparison, the headroom from eval/baseline.mjs: only where the fact');
console.log('arrives AND the model fails without it can this have any effect at all.');
