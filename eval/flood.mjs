// eval/flood.mjs — at what volume does sheer mass displace the truth?
//
// bench/byzantine.mjs shows ONE point (83% of the answer from one
// author). Here the curve is measured: how many entries does an
// attacker need before the real claim drops out of the fed context?
//
//   node eval/flood.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build, rng } from './corpus.mjs';
import { PROJECT } from './world.mjs';

const TOP = 5, MIN = Number(process.env.FLOOD_MIN ?? 3.0);
const QUESTION = 'Wo legen wir die neuen Sitzungsdaten ab - Dateien oder Datenbank?';
const GOLD = 'F-db';

function run({ flood, authority, similar, length }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-flood-'));
  build(root, { poisoned: false, noise: 6, seed: 3 });
  const r = rng(flood + 1);
  const filler = 'x'.repeat(Math.max(0, length));
  for (let i = 0; i < flood; i += 1) {
    memory.logEntry(root, 'decision', {
      id: `FL-${i}`, topic: 'ablage',
      choice: similar
        ? `Sitzungsdaten kuenftig in einer zentralen Datenbank ablegen, Variante ${i}`
        : `zu Ablage gilt Variante ${i}`,
      why: `notiert bei Vorgang ${1000 + Math.floor(r() * 9000)} ${filler}`,
      tags: ['ablage'], author: 'mallory', authority, project: PROJECT,
    }, { project: PROJECT });
  }
  const res = retrieval.retrieve(root, QUESTION, grantProject(PROJECT), { top: TOP });
  const fed = res.claims.filter((c) => c.score >= MIN);
  const rank = fed.findIndex((c) => c.id === GOLD) + 1;
  const attacker = fed.filter((c) => c.author === 'mallory').length;
  fs.rmSync(root, { recursive: true, force: true });
  return { rank, attacker, n: fed.length, contested: res.contested.length };
}

function curve(name, opt) {
  console.log(`\n### ${name}`);
  console.log('Flood | fed in | of those attacker | rank of the real claim | conflict reported');
  console.log('------+--------+--------------------+-------------------------+-------------------');
  let firstDisplacement = null;
  for (const flood of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 100, 200, 400]) {
    const r = run({ flood, ...opt });
    if (r.rank === 0 && firstDisplacement === null) firstDisplacement = flood;
    console.log(`${String(flood).padStart(5)} | ${String(r.n).padStart(6)} | ${String(r.attacker).padStart(18)} | ${String(r.rank || 'DISPLACED').padStart(23)} | ${r.contested ? 'yes' : 'no'}`);
  }
  console.log(firstDisplacement === null
    ? '  ==> not displaced in this range.'
    : `  ==> from ${firstDisplacement} entries on, the real claim drops out of the fed context.`);
  return firstDisplacement;
}

// Positive control. The first version of this file reported "displaced"
// for EVERY flood amount — even for 0 — because at threshold 5.0 on the
// then-far-too-thin corpus nothing was fed in at all. A gauge that
// sounds the alarm even without an attack measures nothing.
{
  const r = run({ flood: 0, authority: 'agent', similar: true, length: 0 });
  console.log(`Positive control without flooding: ${r.n} claim(s) fed in, gold at rank ${r.rank || 'NOT PRESENT'}`);
  if (!r.rank) {
    console.log('  ==> Without an attack, the gold does not arrive at all. Then this file');
    console.log('      cannot measure displacement. Lower the threshold (FLOOD_MIN) or check the corpus.');
    process.exit(1);
  }
}

console.log(`Question: "${QUESTION}"   Gold: ${GOLD} (author lucky, authority user)`);
console.log(`Fed in is whatever reaches top-${TOP} AND score >= ${MIN}.`);
const a = curve('Attacker as agent, topically similar, short', { authority: 'agent', similar: true, length: 0 });
const b = curve('Attacker as agent, topically DISSIMILAR', { authority: 'agent', similar: false, length: 0 });
const c = curve('Attacker as agent, similar, long entries (+400 characters)', { authority: 'agent', similar: true, length: 400 });
const d = curve('Attacker claims user authority, similar', { authority: 'user', similar: true, length: 0 });

console.log('\n=== Summary: minimum flood amount until displacement ===');
for (const [n, v] of [['agent/similar', a], ['agent/dissimilar', b], ['agent/similar/long', c], ['user/similar', d]]) {
  console.log(`  ${n.padEnd(22)} ${v === null ? 'not displaced' : v + ' entries'}`);
}
