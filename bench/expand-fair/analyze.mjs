// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-fair-cm): replay the H3 gate on run.mjs
// output and score it. The replay is checked against the shipped
// searchlevers.answerHolds on every answer before any number is used.
import fs from 'node:fs';
import { answerHolds, TABLE } from '../../src/searchlevers.mjs';

export const SHIPPED = Object.freeze({ barScale: 1, strong: TABLE.find.strong, gap: TABLE.find.gap });
const scoreOf = (h) => Number(h?.score) || 0;
const isExact = (h) => Array.isArray(h?.exact) ? h.exact.length > 0 : Boolean(h?.exact);
export function holds(hits, bar0, p) {
  if (!hits.length) return true;
  const bar = bar0 * p.barScale;
  const best = Math.max(...hits.map(scoreOf));
  const s2 = hits.map(scoreOf).sort((a, b) => b - a)[1] ?? 0;
  return hits.some((h) => {
    if (isExact(h)) return true;
    if (h.covered === 1 && scoreOf(h) > 0) return true;
    // calibration option: a hit that carries none of the typed words in its
    // OWN fields (covered 0 = matched through asked_as only) is no answer alone
    if (p.ownMin && !(h.covered > 0)) return false;
    const s = scoreOf(h);
    if (!(s >= bar)) return false;
    if (s >= p.strong * bar) return true;
    if (s < best) return false;
    if (hits.some((o) => o !== h && scoreOf(o) === s)) return false;
    return s2 === 0 || s >= p.gap * s2;
  });
}
export function verify(run) {
  let bad = 0;
  for (const r of run.results) {
    if (r.answer.unknown) continue;
    const a = answerHolds(r.answer.hits, { occasion: 'find', bar: (r.answer.trace?.bar ?? 0) });
    if (a !== holds(r.answer.hits, (r.answer.trace?.bar ?? 0), SHIPPED)) bad += 1;
  }
  return bad;
}
const GROUPS = { lexical: 'keywords', paraphrase: 'other-words', scope: 'right-project', temporal: 'latest-fact', status: 'still-valid', 'cross-language': 'other-language' };
const oldGroup = (c) => (c.category === 'paraphrase' && /^plain question/.test(c.note ?? '') ? 'everyday' : GROUPS[c.category]);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);

export function score(run, p = SHIPPED, { strictFiller = false } = {}) {
  const shown = (r) => (r.answer.unknown ? null : holds(r.answer.hits, (r.answer.trace?.bar ?? 0), p) ? r.answer.hits.map((h) => h.id) : []);
  const out = { unknown: run.results.filter((r) => r.answer.unknown).length };
  const tally = (key, ok3, ok10) => { const t = out[key] ?? (out[key] = { n: 0, at3: 0, at10: 0 }); t.n += 1; t.at3 += ok3; t.at10 += ok10; };
  for (const r of run.results) {
    const ids = shown(r);
    if (ids == null) continue;
    if (r.set === 'new') {
      const acc = new Set(r.src === 'filler' && !strictFiller ? r.accept : r.expected);
      const rank = ids.findIndex((id) => acc.has(id));
      const a3 = rank >= 0 && rank < 3 ? 1 : 0; const a10 = rank >= 0 ? 1 : 0;
      for (const h of [r.half, 'all']) { tally(`${r.kind}/${h}`, a3, a10); tally(`${r.kind}-${r.src}/${h}`, a3, a10); }
    } else if (r.set === 'new-decoy' || r.set === 'old-decoy') {
      const idx = Number(r.id.split('-')[1]);
      const half = idx % 2 ? 'calib' : 'held';
      const fp = ids.slice(0, 3).length > 0 ? 1 : 0;
      const pre = r.set === 'new-decoy' ? 'decoy' : 'old-decoy';
      for (const h of r.set === 'new-decoy' ? [half, 'all'] : ['all']) tally(`${pre}-${r.kind}/${h}`, fp, fp);
    } else if (r.set === 'old') {
      if (r.gap) continue;
      const rank = ids.findIndex((id) => r.expected.includes(id));
      const leak = ids.slice(0, 3).some((id) => (r.forbidden ?? []).includes(id));
      const a3 = rank >= 0 && rank < 3 ? 1 : 0;
      const t = out[`old-${oldGroup(r)}`] ?? (out[`old-${oldGroup(r)}`] = { n: 0, at3: 0, at10: 0, pass3: 0 });
      t.n += 1; t.at3 += a3; t.at10 += rank >= 0 ? 1 : 0; t.pass3 += a3 && !leak ? 1 : 0;
    }
  }
  for (const v of Object.values(out)) if (typeof v === 'object') { v.at3Pct = pct(v.at3, v.n); v.at10Pct = pct(v.at10, v.n); if ('pass3' in v) v.pass3Pct = pct(v.pass3, v.n); }
  return out;
}
export const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2)) {
    const run = load(f);
    console.log(f, 'replay mismatches vs shipped answerHolds:', verify(run));
    const s = score(run);
    for (const [k, v] of Object.entries(s)) if (typeof v === 'object') console.log(k.padEnd(26), `n=${v.n}`, `@3 ${v.at3Pct}`, `@10 ${v.at10Pct}`, v.pass3Pct != null ? `pass3 ${v.pass3Pct}` : '');
  }
}
