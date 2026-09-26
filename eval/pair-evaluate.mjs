// eval/pair-evaluate.mjs — evaluates the paired test.
//
//   node eval/pair-evaluate.mjs eval/runs/paar-sauber.jsonl
//
// The unit of the statement is the TASK, not the run. Four runs of the
// same task are not four independent observations — they estimate ONE
// task's success rate. Counting them as n=20 invents certainty.

import fs from 'node:fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('File missing'); process.exit(1); }
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((z) => JSON.parse(z));

const tasks = [...new Set(lines.map((z) => z.task_id))].sort();
const rate = (id, cond) => {
  const s = lines.filter((z) => z.task_id === id && z.bedingung === cond);
  return { k: s.filter((z) => z.erfolg).length, n: s.length };
};

console.log(`${lines.length} calls, ${tasks.length} tasks, corpus ${lines[0]?.korpus}, model ${lines[0]?.model}`);
const errors = lines.filter((z) => z.fehler).length;
if (errors) console.log(`WARNING: ${errors} call(s) with an error — those count as failure.`);
console.log('');
console.log('Task | Cl | removed       | WITH  | W/OUT | Delta | Gates violated');
console.log('-----+----+---------------+-------+-------+-------+----------------');
const deltas = [];
for (const id of tasks) {
  const a = rate(id, 'mit'), b = rate(id, 'ohne');
  const d = a.k / a.n - b.k / b.n;
  deltas.push({ id, d, a, b });
  const z0 = lines.find((z) => z.task_id === id);
  const gates = lines.filter((z) => z.task_id === id)
    .flatMap((z) => Object.entries(z.gates ?? {}).filter(([, v]) => v).map(([k]) => k));
  const gz = [...new Set(gates)].join(',') || '—';
  console.log(`${id.padEnd(4)} | ${String(z0.klasse).padEnd(2)} | ${String(z0.entfernt).slice(0, 13).padEnd(13)} | ${`${a.k}/${a.n}`.padStart(5)} | ${`${b.k}/${b.n}`.padStart(5)} | ${(d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '%'} | ${gz}`);
}

const better = deltas.filter((x) => x.d > 0).length;
const worse = deltas.filter((x) => x.d < 0).length;
const same = deltas.filter((x) => x.d === 0).length;
const withK = deltas.reduce((s, x) => s + x.a.k, 0), withN = deltas.reduce((s, x) => s + x.a.n, 0);
const withoutK = deltas.reduce((s, x) => s + x.b.k, 0), withoutN = deltas.reduce((s, x) => s + x.b.n, 0);

console.log('');
console.log(`Tasks better with memory: ${better}   worse: ${worse}   equal: ${same}`);
console.log(`Overall success   WITH ${withK}/${withN} (${(withK / withN * 100).toFixed(0)}%)   W/OUT ${withoutK}/${withoutN} (${(withoutK / withoutN * 100).toFixed(0)}%)`);

// Sign test over the TASKS. At n<=5 even a perfect result is not
// significant — that belongs in the report, not left unsaid.
const nEff = better + worse;
const binom = (k, n) => { let s = 0; for (let i = k; i <= n; i += 1) { let c = 1; for (let j = 0; j < i; j += 1) c = c * (n - j) / (j + 1); s += c; } return s / 2 ** n; };
const p = nEff ? Math.min(1, 2 * binom(Math.max(better, worse), nEff)) : 1;
console.log(`Sign test over ${nEff} differing task(s): p = ${p.toFixed(3)}`);
console.log(p <= 0.05
  ? '  ==> On this sample, the difference is not explainable by chance.'
  : `  ==> NOT significant. With ${nEff} task(s), even a unanimous result`
    + `\n      is consistent with chance (smallest reachable p would be ${nEff ? (2 / 2 ** nEff).toFixed(3) : '—'}).`);

// --- Pre-registered secondary metric: invented numbers ---------------
// Paired and ordinal instead of binary, so noticeably more discriminating
// than the sign test over success/failure. Class F is excluded: there
// the model rightly computes numbers that appear nowhere.
const withGold = lines.filter((z) => z.klasse !== 'F');
if (withGold.length && withGold[0].erfunden !== undefined) {
  console.log('');
  console.log('Invented numbers (neither in question nor context), pre-registered:');
  console.log('Task | WITH (sum/runs)    | W/OUT | Delta | Examples W/OUT');
  console.log('-----+--------------------+------+-------+----------------');
  let dWith = 0, dWithout = 0, better2 = 0, worse2 = 0;
  for (const id of [...new Set(withGold.map((z) => z.task_id))].sort()) {
    const m = withGold.filter((z) => z.task_id === id && z.bedingung === 'mit');
    const o = withGold.filter((z) => z.task_id === id && z.bedingung === 'ohne');
    const sm = m.reduce((a, z) => a + z.erfunden, 0), so = o.reduce((a, z) => a + z.erfunden, 0);
    dWith += sm; dWithout += so;
    if (sm < so) better2 += 1; else if (sm > so) worse2 += 1;
    const examples = [...new Set(o.flatMap((z) => z.welche ?? []))].slice(0, 4).join(' ') || '—';
    console.log(`${id.padEnd(4)} | ${`${sm}/${m.length}`.padStart(18)} | ${`${so}/${o.length}`.padStart(4)} | ${(sm - so >= 0 ? '+' : '') + (sm - so)}`.padEnd(40) + ` | ${examples}`);
  }
  console.log('');
  console.log(`Total invented numbers  WITH ${dWith}   W/OUT ${dWithout}`);
  console.log(`Tasks with less invention thanks to memory: ${better2}   with more: ${worse2}`);
  const nE = better2 + worse2;
  const binom2 = (k, n) => { let s2 = 0; for (let i = k; i <= n; i += 1) { let c = 1; for (let j = 0; j < i; j += 1) c = c * (n - j) / (j + 1); s2 += c; } return s2 / 2 ** n; };
  const pE = nE ? Math.min(1, 2 * binom2(Math.max(better2, worse2), nE)) : 1;
  console.log(`Sign test over ${nE} differing task(s): p = ${pE.toFixed(3)}`
    + (nE ? `  (smallest reachable p: ${(2 / 2 ** nE).toFixed(3)})` : ''));
}

// Is the pairing even balanced? Without this check, the comparison may
// measure context volume instead of content — that is exactly what
// happened on 2026-09-06: WITH had one more claim in 9 of 12 pairs, and
// the whole measured advantage sat entirely in those 9.
{
  let unbalanced = 0;
  for (const id of tasks) {
    const m = lines.find((z) => z.task_id === id && z.bedingung === 'mit');
    const o = lines.find((z) => z.task_id === id && z.bedingung === 'ohne');
    if (m && o && m.claim_ids.length !== o.claim_ids.length) unbalanced += 1;
  }
  if (unbalanced) {
    console.log(`\n  ==> WARNING: ${unbalanced} of ${tasks.length} pair(s) are NOT balanced.`);
    console.log('      The comparison then also measures context volume. Result not reliable.');
  } else {
    console.log(`\n  (all ${tasks.length} pair(s) carry the same number of claims on both sides)`);
  }
}

const tok = lines.filter((z) => z.bedingung === 'mit').reduce((s, z) => s + z.prompt_tok, 0)
  - lines.filter((z) => z.bedingung === 'ohne').reduce((s, z) => s + z.prompt_tok, 0);
const cost = lines.reduce((s, z) => s + (z.kosten ?? 0), 0);
const ms = lines.reduce((s, z) => s + z.ms, 0) / lines.length;
console.log('');
console.log(`Token difference WITH versus W/OUT: ${tok >= 0 ? '+' : ''}${tok} (paired, so near zero is expected)`);
console.log(`Cost of this run: ${cost.toFixed(2)} USD   mean latency: ${Math.round(ms)} ms`);
