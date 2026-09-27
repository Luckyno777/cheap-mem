// bench/lang-bridge.mjs — M18b: questions in the user's language against
// a memory the agents wrote in English.
//
// The corpus is bench/retrieval.mjs's labelled team memory (67 English
// entries). The gold sets are bench/lang-gold/<asked>-<written>.tsv:
// per line a question, the id of the entry that answers it, and a
// SECOND phrasing of the same need. They were written before any
// bridge file existed.
//
// Three arms, all through the real search():
//
//   off      as shipped before M18b
//   bridge   the shipped starter dictionary for the pair switched on
//            (src/langbridge/<pair>.tsv)
//   learned  every first-phrasing question that missed the top 3 is
//            treated as a recorded miss after which the session fetched
//            the gold entry; src/askedlearn.mjs picks the words and
//            writes the correction line exactly as `mem asked-learn
//            --write` would. Then the SECOND phrasing is asked — so the
//            arm measures what a learned word is worth on the next,
//            differently worded question, not on the one it came from.
//
// And the precision side: bench/retrieval.mjs's 42 English queries
// (R@1, MRR) before and after learning, with every pair switched on.
//
//   node bench/lang-bridge.mjs          -> table
//   node bench/lang-bridge.mjs --json   -> + machine-readable result
//
// Recorded 2026-09-27 (first phrasing = the question that missed; second
// = the retest after learning), top 3 / top 1 of 14:
//
//   pair   phrasing  off    bridge  learned  learned+bridge
//   de-en  first     3/3    3/3     -        -
//   de-en  second    7/7    8/7     12/12    13/12   (11/11 cases learned)
//   es-en  first     1/1    5/4     -        -
//   es-en  second    2/2    6/4     11/10    13/10   (13/9 cases learned)
//
//   English queries (42): R@1 76% MRR 0.833 off and with every pair on;
//   after learning 0.834-0.846 — no arm below the off state.
//
// The learned arm is an UPPER bound on the mechanism: it assumes every
// miss was followed by the session fetching the right entry by id. What
// share of real misses are, only the journal on a real machine can say
// (`mem asked-learn` prints that denominator). And the second phrasing
// is written by the same person as the first, so it reuses some of its
// words — the realistic case for one user, not a paraphrase benchmark.
//
// Reading it: the starter dictionary holds core terms only (types,
// fields, thesaurus concepts), so it helps where the thesaurus does not
// already bridge (Spanish), and barely for German. The words that carry
// a real team's questions — billing, invoice, order, certificate — are
// not guessable core terms; they come from the misses themselves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, QUERIES } from './retrieval.mjs';
import { buildIndex, search } from '../src/search.mjs';
import * as lb from '../src/langbridge.mjs';
import * as al from '../src/askedlearn.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAIRS = fs.readdirSync(path.join(HERE, 'lang-gold')).filter((f) => f.endsWith('.tsv')).map((f) => f.slice(0, -4));

export function gold(pair) {
  return fs.readFileSync(path.join(HERE, 'lang-gold', `${pair}.tsv`), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { const [q, id, q2] = l.split('\t'); return { q, id, q2 }; });
}

// After a correction the answering entry carries a new id; it is the one
// that `replaces_id` points back to the gold id (transitively).
function answers(index, hit, id) {
  let e = hit.entry;
  const byId = index.__byId ??= new Map(index.documents.map((d) => [d.entry?.id, d.entry]));
  for (let hops = 0; e && hops < 50; hops += 1) {
    if (e.id === id) return true;
    e = byId.get(e.replaces_id);
  }
  return false;
}

function score(index, rows, key, bridge) {
  let t3 = 0;
  let t1 = 0;
  for (const r of rows) {
    const k = search(index, r[key], { top: 3, bridge }).findIndex((h) => answers(index, h, r.id));
    if (k >= 0) t3 += 1;
    if (k === 0) t1 += 1;
  }
  return { top3: t3, top1: t1, n: rows.length };
}

function english(index, bridge) {
  let r1 = 0;
  let rr = 0;
  for (const { q, gold: g } of QUERIES) {
    const k = search(index, q, { top: 10, minScore: 0, bridge }).findIndex((h) => g.some((id) => answers(index, h, id)));
    if (k === 0) r1 += 1;
    if (k >= 0) rr += 1 / (k + 1);
  }
  return { r1: r1 / QUERIES.length, mrr: rr / QUERIES.length };
}

/** Learn from every first-phrasing miss, as `mem asked-learn --write` would. */
function learn(root, rows, bridge) {
  const index = buildIndex(root, { language: 'en' });
  const list = [];
  for (const r of rows) {
    if (search(index, r.q, { top: 3, bridge }).some((h) => answers(index, h, r.id))) continue;
    const doc = index.documents.find((d) => d.entry?.id === r.id);
    const words = al.learnWords(index, r.q, doc, { bridges: bridge });
    if (!words.length) continue;
    list.push({
      journal: `bench:${r.id}`, ts: null, session: 'bench', words,
      entry: { id: r.id, type: doc.type, project: doc.project ?? null, place: `${doc.source}:${doc.line}` },
      use: { kind: al.KIND.MENTION_TOOL, ts: null },
    });
  }
  const { cases } = al.withoutAmbiguous(list);
  for (const c of cases) al.write(root, c);
  return cases.length;
}

export function run() {
  const out = { pairs: {}, english: {} };
  const all = lb.loadBridges(null, { pairs: PAIRS });
  const base = buildCorpus();
  try {
    const index = buildIndex(base, { language: 'en' });
    out.english.off = english(index, null);
    out.english.bridges = english(index, all);
    for (const pair of PAIRS) {
      const rows = gold(pair);
      const bridge = lb.loadBridges(null, { pairs: [pair] });
      out.pairs[pair] = {
        first: { off: score(index, rows, 'q', null), bridge: score(index, rows, 'q', bridge) },
        second: { off: score(index, rows, 'q2', null), bridge: score(index, rows, 'q2', bridge) },
      };
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }

  // The learned arm: a fresh corpus per pair, so one pair's words cannot
  // help the other's questions.
  for (const pair of PAIRS) {
    const rows = gold(pair);
    const bridge = lb.loadBridges(null, { pairs: [pair] });
    for (const [arm, b] of [['learned', null], ['learnedBridge', bridge]]) {
      const root = buildCorpus();
      try {
        const learnedCases = learn(root, rows, b);
        const index = buildIndex(root, { language: 'en' });
        out.pairs[pair].second[arm] = { ...score(index, rows, 'q2', b), cases: learnedCases };
        out.english[`${pair}:${arm}`] = english(index, b);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
  return out;
}

function print(r) {
  const f = (s) => (s ? `${s.top3}/${s.top1}` : '-');
  console.log('M18b language bench — top 3 / top 1 of 14, English corpus of 67 entries\n');
  console.log('pair   phrasing  off    bridge  learned  learned+bridge');
  for (const [pair, p] of Object.entries(r.pairs)) {
    console.log(`${pair}  first     ${f(p.first.off).padEnd(6)} ${f(p.first.bridge).padEnd(7)} -        -`);
    console.log(`${pair}  second    ${f(p.second.off).padEnd(6)} ${f(p.second.bridge).padEnd(7)} ${f(p.second.learned).padEnd(8)} ${f(p.second.learnedBridge)}`
      + `   (${p.second.learned.cases}/${p.second.learnedBridge.cases} cases learned)`);
  }
  console.log('\nEnglish queries (precision side):');
  for (const [arm, e] of Object.entries(r.english)) {
    console.log(`  ${arm.padEnd(20)} R@1 ${(e.r1 * 100).toFixed(0)}%  MRR ${e.mrr.toFixed(3)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = run();
  print(r);
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
}
