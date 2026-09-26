// eval/pair-a-c.mjs — does memory help an agent? Paired, per task.
//
// THE QUESTION this was all leading up to. So far it has been measured
// that the fact ARRIVES (gold in context) and that it is NOT guessable
// without memory (arm A). Whether it changes the answer has not been
// shown by that.
//
// Setup: the same task twice, once with no context (arm A) and once
// with the fed context (arm C). The task is the unit of observation, not
// the run — hence a sign test over the tasks where the outcome differs.
//
// WHAT THIS TEST CANNOT DO: it measures ONE run per condition. A
// difference on a single task can be noise; only the balance across
// many tasks carries weight. And it measures Sonnet 5 on a synthetic
// corpus — not every model, not every memory.
//
//   node eval/pair-a-c.mjs [without.jsonl] [with.jsonl]

import fs from 'node:fs';
import { TASKS } from './tasks.mjs';

const read = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n')
  .filter((z) => z.trim()).map((z) => JSON.parse(z))
  .map((r) => [r.task_id, r]));

const withoutMemory = read(process.argv[2] ?? 'eval/runs/zustandslos-sonnet5.jsonl');
const withMemory = read(process.argv[3] ?? 'eval/runs/mit-memory-sonnet5.jsonl');
const TASK = new Map(TASKS.map((t) => [t.id, t]));

/**
 * Sign test, two-sided. Under the null hypothesis every deviation is a
 * coin flip; p is the probability of landing at least this one-sided.
 *
 * Why this and not a t-test: the measurement per task is a yes/no, not
 * a quantity. A mean of that would fake a precision the data does not have.
 */
function signTest(better, worse) {
  const n = better + worse;
  if (!n) return 1;
  const fac = (k) => { let r = 1; for (let i = 2; i <= k; i += 1) r *= i; return r; };
  const binom = (k) => fac(n) / (fac(k) * fac(n - k));
  let p = 0;
  const bound = Math.min(better, worse);
  for (let k = 0; k <= bound; k += 1) p += binom(k);
  return Math.min(1, 2 * p / 2 ** n);
}

const rows = [];
for (const t of TASKS) {
  const a = withoutMemory.get(t.id);
  const c = withMemory.get(t.id);
  if (!a || !c) continue;
  // `gold_retrieved` is a LIST of the gold ids found, not a yes/no. An
  // empty array is truthy in JavaScript — reading it as a boolean gets
  // "yes" everywhere. That is exactly what happened while writing this
  // script, and the `=== true` comparison then silently skipped the
  // sub-analysis instead of complaining. Either way it would have gone
  // unnoticed.
  const g = c.retrieval?.gold_retrieved;
  if (g !== undefined && !Array.isArray(g)) {
    throw new Error(`gold_retrieved has an unexpected shape (${typeof g}) — `
      + 'the analysis below it would be guessing, not measuring');
  }
  rows.push({ id: t.id, klasse: t.klasse, without: a.success, withM: c.success,
    goldPresent: Array.isArray(g) ? g.length > 0 : null });
}
if (!rows.length) { console.log('No tasks in common between the two runs.'); process.exit(1); }

const better = rows.filter((z) => z.withM && !z.without);
const worse = rows.filter((z) => !z.withM && z.without);
const same = rows.filter((z) => z.withM === z.without);
const p = signTest(better.length, worse.length);
const q = (k) => `${k}/${rows.length} = ${(100 * k / rows.length).toFixed(0)} %`;

console.log(`Paired over ${rows.length} tasks, one run per condition\n`);
console.log(`  right without memory: ${q(rows.filter((z) => z.without).length)}`);
console.log(`  right with memory:    ${q(rows.filter((z) => z.withM).length)}`);
console.log(`\n  better with memory:  ${better.length}  ${better.map((z) => z.id).join(' ')}`);
console.log(`  worse:               ${worse.length}  ${worse.map((z) => z.id).join(' ')}`);
console.log(`  unchanged:           ${same.length}`);
console.log(`\n  Sign test over the ${better.length + worse.length} differing tasks: p = ${p.toFixed(4)}`);
console.log(`  ${p < 0.05 ? 'Significant at the 5% level.' : 'NOT significant at the 5% level.'}`);

console.log('\nBy class (without -> with):');
const perClass = new Map();
for (const z of rows) {
  if (!perClass.has(z.klasse)) perClass.set(z.klasse, { n: 0, o: 0, m: 0 });
  const k = perClass.get(z.klasse);
  k.n += 1; if (z.without) k.o += 1; if (z.withM) k.m += 1;
}
for (const [cls, k] of [...perClass].sort()) {
  const arrow = k.m > k.o ? ' +' : (k.m < k.o ? ' -' : '  ');
  console.log(`  ${cls}  ${String(`${k.o}/${k.n}`).padStart(6)} -> ${String(`${k.m}/${k.n}`).padStart(6)}${arrow}`);
}

// Tasks where the fact never arrived at all can show nothing — they
// don't belong in the balance, but alongside it.
const withGold = rows.filter((z) => z.goldPresent === true);
if (!withGold.length) {
  console.log('\nNo task with gold in context — that is a finding, not a reason to');
  console.log('skip it. If the receipt is empty, something is wrong with the run.');
} else {
  const b2 = withGold.filter((z) => z.withM && !z.without).length;
  const s2 = withGold.filter((z) => !z.withM && z.without).length;
  console.log(`\nOnly the ${withGold.length} tasks where the fact arrived:`);
  console.log(`  better ${b2}, worse ${s2}, p = ${signTest(b2, s2).toFixed(4)}`);
  console.log('  (This subset is formed AFTER retrieval, not before —');
  console.log('   it describes where the lever engages, and does not replace the balance above.)');
}
