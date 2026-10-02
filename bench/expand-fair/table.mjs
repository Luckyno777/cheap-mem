// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY: one table, rows = metrics, columns = setting x size.
//   node bench/expand-fair/table.mjs <dir> <sizes,comma> [half=held] [params json]
import fs from 'node:fs';
import { load, score, verify, SHIPPED } from './analyze.mjs';
const [dir, sizesArg, half = 'held', pj] = process.argv.slice(2);
const p = pj ? { ...SHIPPED, ...JSON.parse(pj) } : SHIPPED;
const cols = [];
for (const n of sizesArg.split(',')) for (const v of ['off', 'w03', 'w05']) {
  const f = `${dir}/${v}-${n}.json`;
  if (!fs.existsSync(f)) continue;
  const run = load(f);
  if (verify(run)) throw new Error(`replay mismatch in ${f}`);
  // a recalibrated row applies to the expansion settings only
  cols.push({ name: `${v} ${Number(n) / 1000}k`, s: score(run, v === 'off' ? SHIPPED : p), u: score(run, SHIPPED).unknown });
}
const rows = [
  [`everyday ${half} @3`, `everyday/${half}`, 'at3Pct'], [`everyday ${half} @10`, `everyday/${half}`, 'at10Pct'],
  [`  gold notes @3`, `everyday-gold/${half}`, 'at3Pct'], [`  filler notes @3`, `everyday-filler/${half}`, 'at3Pct'],
  [`technical ${half} @3`, `technical/${half}`, 'at3Pct'], [`technical ${half} @10`, `technical/${half}`, 'at10Pct'],
  [`keywords ${half} @3`, `keywords/${half}`, 'at3Pct'], [`keywords ${half} @10`, `keywords/${half}`, 'at10Pct'],
  [`decoy far ${half} FP`, `decoy-far/${half}`, 'at3Pct'], [`decoy near ${half} FP`, `decoy-near/${half}`, 'at3Pct'],
  ['old everyday @3', 'old-everyday', 'at3Pct'], ['old other-words @3', 'old-other-words', 'at3Pct'], ['old keywords @3', 'old-keywords', 'at3Pct'],
  ['old right-project pass3', 'old-right-project', 'pass3Pct'], ['old latest-fact pass3', 'old-latest-fact', 'pass3Pct'],
  ['old still-valid pass3', 'old-still-valid', 'pass3Pct'], ['old other-language @3', 'old-other-language', 'at3Pct'],
  ['old decoy far FP', 'old-decoy-far/all', 'at3Pct'], ['old decoy near FP', 'old-decoy-near/all', 'at3Pct'],
];
console.log(`| metric (${half}) | ${cols.map((c) => c.name).join(' | ')} |`);
console.log(`|---|${cols.map(() => '---:').join('|')}|`);
for (const [label, k, f] of rows) console.log(`| ${label} | ${cols.map((c) => c.s[k]?.[f] ?? '-').join(' | ')} |`);
console.log(`| unknown answers | ${cols.map((c) => c.u).join(' | ')} |`);
