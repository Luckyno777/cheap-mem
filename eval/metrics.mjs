// eval/metrics.mjs — what can be decided about cheap-mem's benefit
// WITHOUT a model. Cost: 0.
//
// The question "does memory make the agent better?" splits apart. Only
// ONE part actually needs a model:
//
//   does the needed information arrive at all?      <- code. CEILING
//   how much of what's fed in is junk?               <- code. FLOOR
//   does a correction take effect, a conflict get flagged? <- code, pure state
//   what does the context cost?                      <- code, exact
//   does the information CHANGE the answer?           <- model. Only here.
//
// If the gold never arrives in context, no model can benefit from it —
// then the model trial is wasted money. This sheet says whether it is
// worth it, and how narrow the band is in which the benefit can lie.
//
//   node eval/metrics.mjs [--min 5] [--top 5]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import * as search from '../src/search.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { PROJECT, FACTS } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 5);
const est = (s) => Math.ceil(String(s).length / 4);

function compactLine(e) {
  const p = [];
  if (e.topic) p.push(`[${e.topic}]`);
  if (e.title) p.push(e.title);
  if (e.choice) p.push(`-> ${e.choice}`);
  if (e.text) p.push(String(e.text).slice(0, 80));
  if (e.why) p.push(`because ${String(e.why).slice(0, 60)}`);
  return p.join(' - ');
}

// Which facts have been replaced? Their old version must NOT land in
// context as active — that is checkable without a model.
const REPLACED = new Map(FACTS.filter((f) => f.ersetzt).map((f) => [f.ersetzt, f.id]));

function measure(cond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cm-kz-${cond}-`));
  build(root, {
    poisoned: cond === 'poisoned', seed: 3,
    echoes: cond === 'poisoned' ? TASKS.map((t) => t.prompt) : [],
  });
  const cap = grantProject(PROJECT);
  const z = {
    tasks: 0, withGold: 0, goldInContext: 0, emptyContext: 0,
    claims: 0, goldClaims: 0, echoes: 0, echoesDropped: 0, staleActive: 0,
    conflictExpected: 0, conflictReported: 0, conflictImpossible: 0,
    authorityBreach: 0, tok: 0,
  };
  const rows = [];
  for (const t of TASKS) {
    z.tasks += 1;
    const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP });
    const kept = r.claims.filter((c) => c.score >= MIN);
    if (!kept.length) z.emptyContext += 1;
    z.claims += kept.length;
    z.tok += est(kept.map((c) => c.body).join('\n'));

    const goldKept = t.gold.filter((g) => kept.some((c) => c.id === g));
    if (t.gold.length) {
      z.withGold += 1;
      if (goldKept.length) z.goldInContext += 1;
      z.goldClaims += goldKept.length;
    }
    // Echoes, in two numbers, and the difference is the whole point:
    //
    //   echoesDropped  what the gateway ACTUALLY threw out — from its
    //                  own receipts (r.excluded), not from a rebuilt rule.
    //   echoes         what is still in and resembles the question. This
    //                  has not been a failure since 2026-09-06: the
    //                  filter deliberately applies only to raw capture,
    //                  and a typed entry in the user's own words SHOULD
    //                  stay.
    //
    // Until 2026-09-06 only the second number stood here, measured with
    // the loose rule — and was reported as "pure noise," even though the
    // gateway was not filtering at all at that time.
    z.echoesDropped += r.excluded.filter((e) => e.why?.startsWith('echo of the question')).length;
    for (const c of kept) if (search.isEcho(t.prompt, compactLine({ text: c.body }))) z.echoes += 1;
    // Stale: a replaced version in context, and specifically as active.
    for (const c of kept) if (REPLACED.has(c.id) && c.status === 'active') z.staleActive += 1;
    // Conflict — done right. The first version required a flag on every
    // class-E task and counted 1/3. That was unfair: potentialConflicts
    // can only report what is among the CANDIDATES, and on two of the
    // three tasks both sides were never both present. So what is
    // measured is: reported, WHEN both sides were candidates.
    if (t.klasse === 'E') {
      const both = t.gold.every((g) => r.claims.some((c) => c.id === g));
      if (both) { z.conflictExpected += 1; if (r.contested.length) z.conflictReported += 1; }
      else z.conflictImpossible += 1;
    }
    // Authority breach: an agent claim active where a user claim was replaced.
    for (const c of kept) if (c.authority !== 'user' && c.status === 'active'
      && kept.some((o) => o.topic === c.topic && o.authority === 'user' && o.status !== 'active')) z.authorityBreach += 1;

    rows.push({ id: t.id, klasse: t.klasse, n: kept.length, gold: goldKept.length,
      target: t.gold.length, best: kept[0]?.score.toFixed(1) ?? '-' });
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { z, rows };
}

const results = {};
for (const cond of ['clean', 'poisoned']) results[cond] = measure(cond);

console.log(`Threshold ${MIN}, top ${TOP}, ${TASKS.length} tasks\n`);
console.log('Metric                                         |    clean | poisoned  | decides');
console.log('----------------------------------------------+----------+-----------+-------------------------');
const row = (name, f, decides) => {
  const a = f(results.clean.z), b = f(results.poisoned.z);
  console.log(`${name.padEnd(45)} | ${String(a).padStart(8)} | ${String(b).padStart(9)} | ${decides}`);
};
const pct = (x, y) => (y ? `${(x / y * 100).toFixed(0)}%` : '—');

row('Gold in fed context', (z) => `${z.goldInContext}/${z.withGold}`, 'CEILING on the benefit');
row('  as a share', (z) => pct(z.goldInContext, z.withGold), '');
row('Tasks with EMPTY context', (z) => `${z.emptyContext}/${z.tasks}`, 'memory can do nothing there');
row('Precision (gold per fed claim)', (z) => pct(z.goldClaims, z.claims), 'FLOOR on the pollution');
row('dropped by the gateway as echo', (z) => `${z.echoesDropped}`, 'from the receipts');
row('of those, echoes of the question', (z) => `${z.echoes}/${z.claims}`,
  'resembles the question, but deliberately stays (not raw capture)');
row('stale version fed in as active', (z) => z.staleActive, 'GATE: correction failure');
row('conflict reported, when both sides present', (z) => `${z.conflictReported}/${z.conflictExpected}`, 'GATE: contradiction');
row('  conflict not even detectable (only one side)', (z) => z.conflictImpossible, 'retrieval limit, not a defect');
row('authority breach (agent over user)', (z) => z.authorityBreach, 'GATE: authority');
row('context cost in tokens (all tasks)', (z) => z.tok, 'marginal cost, without the CLI');

console.log('\nPer task (clean | poisoned), n = fed claims, gold = correct among them:');
console.log('Task | Cl | clean n/gold/target best | poisoned n/gold/target best');
console.log('-----+----+-------------------------+---------------------------');
for (let i = 0; i < TASKS.length; i += 1) {
  const a = results.clean.rows[i], b = results.poisoned.rows[i];
  console.log(`${a.id.padEnd(4)} | ${a.klasse.padEnd(2)} | ${`${a.n}/${a.gold}/${a.target}`.padStart(9)} ${String(a.best).padStart(13)} | ${`${b.n}/${b.gold}/${b.target}`.padStart(9)} ${String(b.best).padStart(15)}`);
}

const o = results.clean.z;
console.log('\n=== What follows from this, without a single model call ===');
console.log(`Memory can improve at most ${pct(o.goldInContext, o.withGold)} of tasks —`);
console.log(`on the remaining ${o.withGold - o.goldInContext}, the needed fact never arrives in context at all.`);
console.log(`At the same time, ${pct(o.claims - o.goldClaims, o.claims)} of what's fed in is not the fact being sought.`);
console.log('A model trial is only worth it for the band in between — and only');
console.log('paired (the same task with and without exactly this claim),');
console.log('because that is what makes task variance drop out instead of being measured.');
