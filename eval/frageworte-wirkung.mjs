// eval/frageworte-wirkung.mjs — bringen die Frageworte etwas?
//
// Der Hebel: der Fasser schreibt beim Verdichten je Eintrag drei bis
// fuenf Woerter dazu, mit denen jemand danach FRAGEN wuerde und die im
// Eintrag selbst nicht vorkommen. Kosten im Abruf: null. Die Arbeit
// passiert auf Bahn 2, wo ohnehin ein Modell laeuft.
//
// Gemessen wird derselbe Korpus zweimal, mit und ohne das Feld. Alles
// andere ist gleich: gleicher Seed, gleiche Aufgaben, gleiche Schwelle.
//
// Was hier NICHT gemessen werden kann: ob der Fasser im Betrieb ebenso
// brauchbare Woerter schreibt wie der Lauf, der diese hier erzeugt hat.
// Er sieht dort ganze Rohfaenge statt einer Zeile — mehr Kontext, aber
// auch mehr Ablenkung.
//
// Und die Zahl ist eine UNTERGRENZE, nicht eine Obergrenze: der
// Leckage-Riegel in frageworte.mjs wirft jedes Wort heraus, das eine
// Bewertungsregel erfuellt — 13 von 31 Eintraegen waren betroffen. Im
// Betrieb gibt es keine Bewertungsregel, dort darf der Fasser genau
// diese Woerter schreiben.
//
//   node eval/frageworte-wirkung.mjs [--min 5] [--top 5]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { PROJECT } from './world.mjs';
import { FRAGEWORTE, sicher } from './frageworte.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 5);

const cap = grantProject(PROJECT);
const mitGold = TASKS.filter((t) => t.gold.length);

function messe(frageworte) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fw-'));
  build(root, { seed: 3, frageworte });
  let gold = 0, claims = 0, goldClaims = 0;
  const proKlasse = new Map();
  const treffer = new Set();
  for (const t of mitGold) {
    const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP });
    const drin = r.claims.filter((c) => c.score >= MIN || (c.exact && c.exact.length));
    claims += drin.length;
    const hat = t.gold.some((g) => drin.some((c) => c.id === g));
    goldClaims += drin.filter((c) => t.gold.includes(c.id)).length;
    if (hat) { gold += 1; treffer.add(t.id); }
    if (!proKlasse.has(t.klasse)) proKlasse.set(t.klasse, { n: 0, ok: 0 });
    const k = proKlasse.get(t.klasse); k.n += 1; if (hat) k.ok += 1;
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { gold, claims, goldClaims, proKlasse, treffer };
}

const belegt = Object.keys(FRAGEWORTE).filter((k) => sicher(k).length);
console.log(`Frageworte vorhanden fuer ${belegt.length} Fakten`);
if (!belegt.length) { console.log('Nichts zu messen.'); process.exit(1); }
const roh = Object.keys(FRAGEWORTE).reduce((n, k) => n + FRAGEWORTE[k].length, 0);
const woerter = belegt.reduce((n, k) => n + sicher(k).length, 0);
console.log(`vom Modell geschrieben ${roh}, nach dem Leckage-Riegel ${woerter}`);
console.log(`im Schnitt ${(woerter / belegt.length).toFixed(1)} je Eintrag\n`);

const ohne = messe(false);
const mit = messe(true);
const p = (k, n) => `${k}/${n} = ${(100 * k / Math.max(1, n)).toFixed(0)} %`;

console.log('                                | ohne Frageworte | mit Frageworten');
console.log('--------------------------------+-----------------+----------------');
console.log(`Gold im eingespeisten Kontext   | ${p(ohne.gold, mitGold.length).padStart(15)} | ${p(mit.gold, mitGold.length).padStart(15)}`);
console.log(`Praezision (Gold je Claim)      | ${p(ohne.goldClaims, ohne.claims).padStart(15)} | ${p(mit.goldClaims, mit.claims).padStart(15)}`);

console.log('\nNach Klasse (Gold im Kontext):');
for (const [kl, a] of [...ohne.proKlasse].sort()) {
  const b = mit.proKlasse.get(kl);
  const pfeil = b.ok > a.ok ? ' +' : (b.ok < a.ok ? ' -' : '  ');
  console.log(`  ${kl}  ${String(`${a.ok}/${a.n}`).padStart(6)} -> ${String(`${b.ok}/${b.n}`).padStart(6)}${pfeil}`);
}

const gewonnen = [...mit.treffer].filter((x) => !ohne.treffer.has(x));
const verloren = [...ohne.treffer].filter((x) => !mit.treffer.has(x));
console.log(`\ngewonnen: ${gewonnen.length ? gewonnen.join(' ') : '(keine)'}`);
console.log(`verloren: ${verloren.length ? verloren.join(' ') : '(keine)'}`);
console.log(`\nnetto ${mit.gold - ohne.gold} Aufgaben von ${mitGold.length}.`);
console.log('Zum Vergleich der Kopfraum aus eval/grundwert.mjs: nur wo die Angabe');
console.log('ankommt UND das Modell ohne sie scheitert, kann das ueberhaupt wirken.');
