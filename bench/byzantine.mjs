// bench/byzantine.mjs — the writer who breaks no rule.
//
// Every defence built so far stops a writer who VIOLATES something:
// superseding another's claim, reading another scope, repeating a body
// verbatim, exceeding a tier. This one violates nothing.
//
//   - writes only in its own scope
//   - claims only its own authority
//   - never supersedes anyone
//   - uses fresh ids and plausible timestamps
//   - every body is syntactically distinct
//
// It simply writes a great many plausible, wrong, mutually contradictory
// claims. The question the final audit put: can such a writer make the
// memory practically useless without breaking a single rule — and if so,
// is that a ranking problem or an INTEGRITY problem?
//
//   node bench/byzantine.mjs [--flood 20000]
//
// 20k rather than 1M: the effect is a RATIO between genuine and flood
// claims, and it saturates long before a million. A million-line run costs
// minutes and measures the same thing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retrieve } from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';

const FLOOD = Number(process.argv[process.argv.indexOf('--flood') + 1]) || 20000;
const z = (o) => JSON.stringify(o) + '\n';
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }

const CITIES = ['Frankfurt', 'Berlin', 'Hamburg', 'Muenchen', 'Koeln', 'Zuerich', 'Wien'];
const HEDGES = ['currently', 'as of the last review', 'per the runbook', 'after the migration',
  'according to the deployment notes', 'since the incident', 'in the new setup'];
const SHAPES = [
  (c, h) => `the production server runs in ${c}, ${h}`,
  (c, h) => `${h}, production is hosted in ${c}`,
  (c, h) => `we moved production to ${c} — ${h}`,
  (c, h) => `production location: ${c} (${h})`,
  (c, h) => `${c} is where the production server lives, ${h}`,
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byz-'));
fs.mkdirSync(path.join(root, 'projects', 'ops'), { recursive: true });
const file = path.join(root, 'projects', 'ops', 'decisions.jsonl');
const out = [];

// 100 genuine claims about other things, by a legitimate agent.
const r = rng(7);
for (let i = 0; i < 100; i += 1) {
  out.push(z({ id: `real${i}`, ts: '2026-02-01T00:00:00Z', author: 'alice', authority: 'agent',
    topic: 'ops', choice: `the deploy pipeline step ${i} waits for the readiness probe`,
    why: `established during the ${i} review` }));
}

// THE ANSWER: one genuine claim, at the highest authority, about the thing
// that will be asked. Deliberately worded plainly, as a person would.
out.push(z({ id: 'TRUTH', ts: '2026-03-01T00:00:00Z', author: 'lucky', authority: 'user',
  topic: 'ops', choice: 'the production server runs in Frankfurt',
  why: 'I set it up there myself' }));

// The Byzantine writer. Same tier as any agent, own scope, no supersession.
for (let i = 0; i < FLOOD; i += 1) {
  const c = CITIES[Math.floor(r() * CITIES.length)];
  const h = HEDGES[Math.floor(r() * HEDGES.length)];
  const shape = SHAPES[Math.floor(r() * SHAPES.length)];
  out.push(z({ id: `w${i}`, ts: `2026-0${4 + Math.floor(r() * 5)}-01T00:00:00Z`.replace('-010', '-10'),
    author: 'byz', authority: 'agent', topic: 'ops',
    choice: shape(c, h), why: `noted while reviewing ticket ${1000 + i}` }));
}
fs.writeFileSync(file, out.join(''));

const t0 = Date.now();
const res = retrieve(root, 'where does the production server run', grantProject('ops'), { top: 10 });
const ms = Date.now() - t0;

const rank = res.claims.findIndex((c) => c.id === 'TRUTH') + 1;
const byz = res.claims.filter((c) => c.author === 'byz').length;
const cities = new Set(res.claims.map((c) => (c.body.match(/Frankfurt|Berlin|Hamburg|Muenchen|Koeln|Zuerich|Wien/) || [])[0]).filter(Boolean));

console.log(`corpus: 100 genuine + 1 truth + ${FLOOD} byzantine, all rule-abiding`);
console.log(`query:  "where does the production server run"   (${ms} ms)\n`);
for (const c of res.claims) {
  const tag = c.id === 'TRUTH' ? '  <== the answer' : '';
  console.log(`  ${String(c.id).padEnd(8)} [${c.authority}/${c.author}]  ${c.score.toFixed(3)}  ${c.body.slice(0, 62)}${tag}`);
}
console.log(`\n  the true claim ranked: ${rank || 'NOT RETURNED'} of ${res.claims.length}`);
console.log(`  byzantine claims in the answer: ${byz}/${res.claims.length}`);
console.log(`  distinct contradictory locations offered: ${cities.size}`);
console.log(`  share of the answer from one author: ${(byz/res.claims.length*100).toFixed(0)}% (cap is ${res.limits.perAuthorShare*100}% of the CANDIDATES, not of the answer)`);
console.log(`  potential conflicts flagged: ${res.contested.length}`
  + (res.contested.length ? ` (${res.contested[0].authors.join(' vs ')}, ${res.contested[0].ids.length} claims)` : ''));

// What this bench is allowed to conclude, and what it is not.
//
// The share cap bounds one author's take of the CANDIDATES, not of the
// answer — the filtering shrinks its own denominator, so a 50% cap here
// delivers about 83%. That is documented at enforceAuthorShare and is not
// a bug to be caught below; bounded domination is not a guarantee.
//
// What IS guaranteed under a flood, and gated here:
//   1. the genuine user claim is still returned  (user tier is exempt)
//   2. the contradiction is reported as contested (the caller is told)
//   3. the cap actually ran           (or 1 and 2 hold for the wrong reason)
const capped = res.excluded.filter((e) => /author share/.test(e.why || '')).length;
const fehler = [];
if (rank === 0) fehler.push('the genuine claim is no longer returned at all');
if (!res.contested.length) fehler.push('the contradiction was not reported as contested');
if (!capped) fehler.push(`the share cap excluded nothing (${FLOOD} flood claims and no candidate dropped) — this run proves less than it looks`);

console.log('');
console.log(`  share cap excluded: ${capped} candidate(s)`);
console.log(fehler.length
  ? '  ==> ' + fehler.join('\n  ==> ')
  : byz > res.claims.length / 2
    ? '  ==> the answer survives and is flagged contested, but the context is mostly false. Caller must judge.'
    : '  ==> the answer survives and the flood is bounded.');
fs.rmSync(root, { recursive: true, force: true });
if (fehler.length) process.exitCode = 1;
