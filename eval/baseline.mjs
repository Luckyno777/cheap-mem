// eval/baseline.mjs — what does the model answer WITHOUT any memory?
//
// The ceiling from metrics.mjs ("for 36% of tasks the needed fact makes
// it into the context") only says whether the fact ARRIVES. It does not
// say whether the model would have known it anyway. For "UTC,
// ISO-8601" or "cookies instead of browser storage" it guesses
// right — and on tasks like that the whole benchmark measures nothing.
//
// Arm A is exactly this case: the prompt is the bare question, no
// context, no history. This script reads the run and holds it against
// the `guessable` PREDICTION from world.mjs.
//
// The point is disprovability. `guessable` is a judgment call, and how
// uncertain that judgment is was measured: two independent assessments
// of the same 15 facts agreed on 9. A label with 60% agreement may not
// carry a metric — the measurement has to be able to correct it.
//
//   node eval/baseline.mjs eval/runs/zustandslos-sonnet5.jsonl

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { FACTS, PROJECT } from './world.mjs';

const file = process.argv[2] ?? 'eval/runs/zustandslos-sonnet5.jsonl';
const lines = fs.readFileSync(file, 'utf8').split('\n')
  .filter((z) => z.trim()).map((z) => JSON.parse(z));

const armAOnly = lines.filter((r) => r.arm === 'A');
if (!armAOnly.length) { console.log('No arm-A records in', file); process.exit(1); }

const FACT = new Map(FACTS.map((f) => [f.id, f]));
const TASK = new Map(TASKS.map((t) => [t.id, t]));

/** Task prediction: guessable if ALL of its gold facts are guessable. */
function predicted(t) {
  if (!t.gold?.length) return null;             // class F: deliberately without gold
  const f = t.gold.map((g) => FACT.get(g)).filter(Boolean);
  if (!f.length) return null;
  return f.every((x) => x.guessable === true);
}

const wilson = (k, n, z = 1.96) => {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const sd = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - sd) / d), Math.min(1, (c + sd) / d)];
};

const groups = new Map([['guessable', []], ['not guessable', []], ['no gold', []]]);
const classes = new Map();
const results = [];
for (const r of armAOnly) {
  const t = TASK.get(r.task_id);
  if (!t) continue;
  const v = predicted(t);
  const g = v === null ? 'no gold' : (v ? 'guessable' : 'not guessable');
  groups.get(g).push(r);
  if (!classes.has(t.klasse)) classes.set(t.klasse, []);
  classes.get(t.klasse).push(r);
  results.push({ id: r.task_id, klasse: t.klasse, predicted: v, measured: r.success });
}

const p = (k, n) => `${k}/${n} = ${(100 * k / Math.max(1, n)).toFixed(0)} %`;
console.log(`Stateless run: ${armAOnly.length} tasks, model ${armAOnly[0].model}\n`);

console.log('Group          | right without memory | 95% interval');
console.log('----------------+----------------------+---------------');
for (const [name, rs] of groups) {
  if (!rs.length) continue;
  const k = rs.filter((r) => r.success).length;
  const [lo, hi] = wilson(k, rs.length);
  console.log(`${name.padEnd(15)} | ${p(k, rs.length).padStart(21)} | ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)} %`);
}

console.log('\nBy class:');
for (const [cls, rs] of [...classes].sort()) {
  const k = rs.filter((r) => r.success).length;
  console.log(`  ${cls}  ${p(k, rs.length)}`);
}

// Where the label and the measurement disagree: the label is disproved,
// not the measurement. Both directions count, and both are interesting.
const wronglyGuessable = results.filter((x) => x.predicted === true && !x.measured);
const wronglyNot = results.filter((x) => x.predicted === false && x.measured);
console.log(`\nPrediction checked (${results.filter((x) => x.predicted !== null).length} tasks with gold):`);
console.log(`  labeled guessable, but WRONG without memory:     ${wronglyGuessable.length}  ${wronglyGuessable.map((x) => x.id).join(' ')}`);
console.log(`  labeled not guessable, but guessed RIGHT anyway: ${wronglyNot.length}  ${wronglyNot.map((x) => x.id).join(' ')}`);

const withGold = results.filter((x) => x.predicted !== null);
const matches = withGold.filter((x) => x.predicted === x.measured).length;
console.log(`  label matches the measurement on ${p(matches, withGold.length)}`);

// The headroom: only where the fact ARRIVES and the model fails
// WITHOUT it can memory have any effect at all. Reporting either alone
// overestimates the benefit — the two sets overlap.
const cap = grantProject(PROJECT);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-head-'));
build(root, { seed: 3 });
let arrives = 0, headroom = 0, freebie = 0;
const headroomIds = [];
for (const r of armAOnly) {
  const t = TASK.get(r.task_id);
  if (!t?.gold?.length) continue;
  const rr = retrieval.retrieve(root, t.prompt, cap, { top: 5 });
  const kept = rr.claims.filter((c) => c.score >= 5 || (c.exact && c.exact.length));
  const matched = t.gold.some((g) => kept.some((c) => c.id === g));
  if (matched) arrives += 1;
  if (matched && !r.success) { headroom += 1; headroomIds.push(r.task_id); }
  if (!matched && r.success) freebie += 1;
}
fs.rmSync(root, { recursive: true, force: true });

const withGoldN = armAOnly.filter((r) => TASK.get(r.task_id)?.gold?.length).length;
console.log('\nThe headroom — where memory CAN have any effect at all:');
console.log(`  fact arrives in context:                    ${p(arrives, withGoldN)}`);
console.log(`  model answers right without memory:         ${p(armAOnly.filter((r) => r.success && TASK.get(r.task_id)?.gold?.length).length, withGoldN)}`);
console.log(`  BOTH: fact present AND failed without it:   ${p(headroom, withGoldN)}   ${headroomIds.join(' ')}`);
console.log(`  right anyway without the fact (world knowledge): ${p(freebie, withGoldN)}`);

console.log('\nWhat follows from this:');
const notGuessable = groups.get('not guessable');
const notGuessableOk = notGuessable.filter((r) => r.success).length;
console.log(`  On the ${notGuessable.length} not-guessable tasks the model answers ${p(notGuessableOk, notGuessable.length)}`);
console.log('  with no memory at all. Only the REST can be improved by memory —');
console.log('  everything above that measures world knowledge, not recall.');
