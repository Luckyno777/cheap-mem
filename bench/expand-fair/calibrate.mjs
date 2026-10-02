// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-fair-cm): recalibrate the H3 gate for the
// expansion settings on the CALIBRATION HALF ONLY (questions and decoys with
// half=calib), at the sizes given. Constraint: calib decoy far/near FP at or
// under the expansion-off FP with the shipped gate, at every size.
// Objective: calib everyday @3 + technical @3, summed over sizes.
// Held-out numbers are never read here.
//   node bench/expand-fair/calibrate.mjs <dir> <w03|w05> <sizes,comma>
import { load, score, SHIPPED } from './analyze.mjs';
const [dir, v, sizesArg] = process.argv.slice(2);
const sizes = sizesArg.split(',');
const off = Object.fromEntries(sizes.map((n) => [n, score(load(`${dir}/off-${n}.json`), SHIPPED)]));
const runs = Object.fromEntries(sizes.map((n) => [n, load(`${dir}/${v}-${n}.json`)]));
const pick = (s, k) => s[k]?.at3 ?? 0;
const grid = [];
for (const barScale of [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2])
  for (const strong of [2, 2.5, 3])
    for (const gap of [1.05, 1.1, 1.2, 1.3, 1.5])
      for (const ownMin of [false, true]) grid.push({ barScale, strong, gap, ownMin });
const rows = [];
for (const p of grid) {
  let ok = true; let obj = 0; const fp = [];
  for (const n of sizes) {
    const s = score(runs[n], p);
    for (const k of ['decoy-far/calib', 'decoy-near/calib']) {
      fp.push(`${n}:${k.split('/')[0].slice(6)} ${pick(s, k)}/${pick(off[n], k)}`);
      if (pick(s, k) > pick(off[n], k)) ok = false;
    }
    obj += pick(s, 'everyday/calib') + pick(s, 'technical/calib');
  }
  rows.push({ p, ok, obj, fp: fp.join(' ') });
}
rows.sort((a, b) => (b.ok - a.ok) || (b.obj - a.obj) || (a.p.barScale - b.p.barScale));
const base = sizes.reduce((a, n) => a + pick(off[n], 'everyday/calib') + pick(off[n], 'technical/calib'), 0);
console.log(`off objective (calib everyday+technical hits @3, summed): ${base}`);
for (const r of rows.slice(0, 8)) console.log(r.ok ? 'OK ' : 'NO ', r.obj, JSON.stringify(r.p), r.fp);
console.log('BEST', JSON.stringify(rows[0].ok ? rows[0].p : null));
