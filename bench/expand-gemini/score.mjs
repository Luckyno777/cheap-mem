// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-gemini-cm): score the Gemini runs with the
// gate FIXED in advance, nothing fitted on these questions:
//   off       -> the shipped H3 row (searchlevers TABLE.find)
//   w03 / w05 -> the row recalibrated on expand-fair's calib half
//                (commit ceec087: bar x1.3, strong 2, gap 1.05)
//   node bench/expand-gemini/score.mjs <dir> <sizes,comma>
// Every run is first checked against the shipped answerHolds (replay = 0
// mismatches) before a number is used.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { holds, verify, SHIPPED, load } from '../expand-fair/analyze.mjs';
import { validate } from './validate.mjs';

export const RECAL = Object.freeze({ ...SHIPPED, barScale: 1.3, strong: 2, gap: 1.05, ownMin: false });
const pct = (a, b) => (b ? (Math.round((1000 * a) / b) / 10).toFixed(1) : '-');
const badLines = new Set(validate().decoyBad.map((d) => d.line));

/** per item: shown ids (gate applied), rank of the target, decoy FP */
export function judge(run, p, { strictFiller = false } = {}) {
  const out = new Map();
  for (const r of run.results) {
    if (r.answer.unknown) { out.set(r.line, { unknown: true }); continue; }
    const ids = holds(r.answer.hits, r.answer.trace?.bar ?? 0, p) ? r.answer.hits.map((h) => h.id) : [];
    if (r.kind.startsWith('decoy')) { out.set(r.line, { fp: ids.length > 0 ? 1 : 0 }); continue; }
    const acc = new Set(r.src === 'filler' && !strictFiller ? r.accept : r.expected);
    const rank = ids.findIndex((id) => acc.has(id));
    out.set(r.line, { at3: rank >= 0 && rank < 3 ? 1 : 0, at10: rank >= 0 ? 1 : 0 });
  }
  return out;
}
const GROUPS = [
  ['everyday @3', (r) => r.kind === 'everyday', 'at3'], ['everyday @10', (r) => r.kind === 'everyday', 'at10'],
  ['  gold targets (en) @3', (r) => r.kind === 'everyday' && r.src === 'gold' && !r.de, 'at3'],
  ['  filler targets (s*) @3', (r) => r.kind === 'everyday' && r.src === 'filler', 'at3'],
  ['  filler targets (s*) @3, strict id', (r) => r.kind === 'everyday' && r.src === 'filler', 'at3', true],
  ['technical @3', (r) => r.kind === 'technical', 'at3'], ['technical @10', (r) => r.kind === 'technical', 'at10'],
  ['  gold targets (en) @3', (r) => r.kind === 'technical' && r.src === 'gold' && !r.de, 'at3'],
  ['  filler targets (s*) @3', (r) => r.kind === 'technical' && r.src === 'filler', 'at3'],
  ['German g-de-* (ev+tech) @3', (r) => r.de && !r.kind.startsWith('decoy'), 'at3'],
  ['German g-de-* (ev+tech) @10', (r) => r.de && !r.kind.startsWith('decoy'), 'at10'],
  ['decoy far FP (all 60)', (r) => r.kind === 'decoy-far', 'fp'], ['decoy near FP (all 60)', (r) => r.kind === 'decoy-near', 'fp'],
  ['decoy far FP (clean)', (r) => r.kind === 'decoy-far' && !badLines.has(r.line), 'fp'],
  ['decoy near FP (clean)', (r) => r.kind === 'decoy-near' && !badLines.has(r.line), 'fp'],
];
// exact two-sided McNemar (binomial on discordant pairs)
function mcnemar(b, c) {
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c); let s = 0; let coef = 1;
  for (let i = 0; i <= n; i += 1) { if (i <= k) s += coef; coef = (coef * (n - i)) / (i + 1); }
  return Math.min(1, (2 * s) / 2 ** n);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir, sizesArg] = process.argv.slice(2);
  const cols = [];
  for (const n of sizesArg.split(',')) for (const v of ['off', 'w03', 'w05']) {
    const f = `${dir}/${v}-${n}.json`;
    if (!fs.existsSync(f)) continue;
    const run = load(f);
    const mm = verify(run);
    if (mm) throw new Error(`replay mismatch in ${f}: ${mm}`);
    const p = v === 'off' ? SHIPPED : RECAL;
    cols.push({ name: `${v} ${Number(n) / 1000}k`, v, n, run, j: judge(run, p), js: judge(run, p, { strictFiller: true }), jShip: judge(run, SHIPPED) });
  }
  const items = cols[0].run.results;
  const cell = (c, f, m, strict, which = 'j') => {
    const sel = items.filter(f); const j = strict ? c.js : c[which];
    const v = sel.map((r) => j.get(r.line)).filter((x) => x && !x.unknown);
    return `${pct(v.reduce((a, x) => a + x[m], 0), v.length)}`;
  };
  console.log(`| metric (n) | ${cols.map((c) => c.name).join(' | ')} |`);
  console.log(`|---|${cols.map(() => '---:').join('|')}|`);
  for (const [label, f, m, strict] of GROUPS) console.log(`| ${label} (${items.filter(f).length}) | ${cols.map((c) => cell(c, f, m, strict)).join(' | ')} |`);
  console.log(`| unknown answers | ${cols.map((c) => [...c.j.values()].filter((x) => x.unknown).length).join(' | ')} |`);
  console.log('\nSame expansion runs under the SHIPPED gate (no recalibration), for reference:');
  for (const [label, f, m] of GROUPS.filter((g) => /@3$|FP \(all/.test(g[0]) && !g[0].startsWith(' '))) console.log(`| ${label} | ${cols.map((c) => cell(c, f, m, false, 'jShip')).join(' | ')} |`);
  console.log('\nPaired vs off at the same size (everyday+technical @3, lenient filler): won / lost, exact McNemar p');
  for (const c of cols.filter((x) => x.v !== 'off')) {
    const off = cols.find((x) => x.v === 'off' && x.n === c.n); if (!off) continue;
    let won = 0; let lost = 0;
    for (const r of items.filter((x) => !x.kind.startsWith('decoy'))) {
      const a = off.j.get(r.line); const b = c.j.get(r.line);
      if (!a || !b || a.unknown || b.unknown) continue;
      if (b.at3 && !a.at3) won += 1; if (a.at3 && !b.at3) lost += 1;
    }
    let fpUp = 0; let fpDown = 0;
    for (const r of items.filter((x) => x.kind.startsWith('decoy'))) { const a = off.j.get(r.line); const b = c.j.get(r.line); if (b.fp && !a.fp) fpUp += 1; if (a.fp && !b.fp) fpDown += 1; }
    console.log(`  ${c.name}: questions won ${won}, lost ${lost}, p=${mcnemar(won, lost).toPrecision(2)}; decoys newly FP ${fpUp}, no longer FP ${fpDown}, p=${mcnemar(fpUp, fpDown).toPrecision(2)}`);
  }
}
