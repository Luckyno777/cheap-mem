// eval/paar-a-c.mjs — nuetzt Memory einem Agenten? Gepaart, je Aufgabe.
//
// DIE FRAGE, um die es die ganze Zeit ging. Bisher ist gemessen, dass
// die Angabe ANKOMMT (Gold im Kontext) und dass sie ohne Gedaechtnis
// NICHT zu erraten ist (Arm A). Ob sie die Antwort aendert, ist damit
// nicht gezeigt.
//
// Aufbau: dieselbe Aufgabe zweimal, einmal ohne Kontext (Arm A) und
// einmal mit dem eingespeisten Kontext (Arm C). Die Aufgabe ist die
// Beobachtungseinheit, nicht der Lauf — deshalb Vorzeichentest ueber die
// Aufgaben, bei denen sich das Ergebnis unterscheidet.
//
// WAS DER TEST NICHT KANN: er misst EINEN Lauf je Bedingung. Ein
// Unterschied bei einer einzelnen Aufgabe kann Rauschen sein; nur die
// Bilanz ueber viele Aufgaben traegt. Und er misst Sonnet 5 auf einem
// synthetischen Korpus — nicht jedes Modell, nicht jede Memory.
//
//   node eval/paar-a-c.mjs [ohne.jsonl] [mit.jsonl]

import fs from 'node:fs';
import { TASKS } from './tasks.mjs';

const lies = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n')
  .filter((z) => z.trim()).map((z) => JSON.parse(z))
  .map((r) => [r.task_id, r]));

const ohne = lies(process.argv[2] ?? 'eval/runs/zustandslos-sonnet5.jsonl');
const mit = lies(process.argv[3] ?? 'eval/runs/mit-memory-sonnet5.jsonl');
const AUFGABE = new Map(TASKS.map((t) => [t.id, t]));

/**
 * Vorzeichentest, zweiseitig. Unter der Nullhypothese ist jede
 * Abweichung ein Muenzwurf; p ist die Wahrscheinlichkeit, mindestens so
 * einseitig auszufallen.
 *
 * Warum das und kein t-Test: die Messung je Aufgabe ist ein Ja/Nein,
 * kein Messwert. Ein Mittelwert daraus taeuscht Genauigkeit vor, die die
 * Daten nicht haben.
 */
function vorzeichen(besser, schlechter) {
  const n = besser + schlechter;
  if (!n) return 1;
  const fak = (k) => { let r = 1; for (let i = 2; i <= k; i += 1) r *= i; return r; };
  const binom = (k) => fak(n) / (fak(k) * fak(n - k));
  let p = 0;
  const grenze = Math.min(besser, schlechter);
  for (let k = 0; k <= grenze; k += 1) p += binom(k);
  return Math.min(1, 2 * p / 2 ** n);
}

const zeilen = [];
for (const t of TASKS) {
  const a = ohne.get(t.id);
  const c = mit.get(t.id);
  if (!a || !c) continue;
  // `gold_retrieved` ist eine LISTE der gefundenen Gold-Ids, kein
  // Ja/Nein. Ein leeres Array ist in JavaScript truthy — wer es als
  // Wahrheitswert liest, bekommt ueberall "ja". Genau das ist beim
  // Schreiben dieses Skripts passiert, und der Vergleich `=== true` hat
  // die Teilauswertung dann still uebersprungen statt zu klagen. Beides
  // waere unbemerkt geblieben.
  const g = c.retrieval?.gold_retrieved;
  if (g !== undefined && !Array.isArray(g)) {
    throw new Error(`gold_retrieved hat eine unerwartete Form (${typeof g}) — `
      + 'die Auswertung darunter wuerde raten statt messen');
  }
  zeilen.push({ id: t.id, klasse: t.klasse, ohne: a.success, mit: c.success,
    goldDa: Array.isArray(g) ? g.length > 0 : null });
}
if (!zeilen.length) { console.log('Keine gemeinsamen Aufgaben in beiden Laeufen.'); process.exit(1); }

const besser = zeilen.filter((z) => z.mit && !z.ohne);
const schlechter = zeilen.filter((z) => !z.mit && z.ohne);
const gleich = zeilen.filter((z) => z.mit === z.ohne);
const p = vorzeichen(besser.length, schlechter.length);
const q = (k) => `${k}/${zeilen.length} = ${(100 * k / zeilen.length).toFixed(0)} %`;

console.log(`Gepaart ueber ${zeilen.length} Aufgaben, ein Lauf je Bedingung\n`);
console.log(`  ohne Memory richtig: ${q(zeilen.filter((z) => z.ohne).length)}`);
console.log(`  mit Memory richtig:  ${q(zeilen.filter((z) => z.mit).length)}`);
console.log(`\n  besser mit Memory:   ${besser.length}  ${besser.map((z) => z.id).join(' ')}`);
console.log(`  schlechter:          ${schlechter.length}  ${schlechter.map((z) => z.id).join(' ')}`);
console.log(`  unveraendert:        ${gleich.length}`);
console.log(`\n  Vorzeichentest ueber die ${besser.length + schlechter.length} abweichenden Aufgaben: p = ${p.toFixed(4)}`);
console.log(`  ${p < 0.05 ? 'Signifikant auf dem 5-%-Niveau.' : 'NICHT signifikant auf dem 5-%-Niveau.'}`);

console.log('\nNach Klasse (ohne -> mit):');
const proKlasse = new Map();
for (const z of zeilen) {
  if (!proKlasse.has(z.klasse)) proKlasse.set(z.klasse, { n: 0, o: 0, m: 0 });
  const k = proKlasse.get(z.klasse);
  k.n += 1; if (z.ohne) k.o += 1; if (z.mit) k.m += 1;
}
for (const [kl, k] of [...proKlasse].sort()) {
  const pfeil = k.m > k.o ? ' +' : (k.m < k.o ? ' -' : '  ');
  console.log(`  ${kl}  ${String(`${k.o}/${k.n}`).padStart(6)} -> ${String(`${k.m}/${k.n}`).padStart(6)}${pfeil}`);
}

// Die Aufgaben, bei denen die Angabe gar nicht ankam, koennen nichts
// zeigen — sie gehoeren nicht in die Bilanz, sondern daneben.
const mitGold = zeilen.filter((z) => z.goldDa === true);
if (!mitGold.length) {
  console.log('\nKeine Aufgabe mit Gold im Kontext — das ist ein Befund, kein Grund');
  console.log('zum Ueberspringen. Ist die Quittung leer, stimmt der Lauf nicht.');
} else {
  const b2 = mitGold.filter((z) => z.mit && !z.ohne).length;
  const s2 = mitGold.filter((z) => !z.mit && z.ohne).length;
  console.log(`\nNur die ${mitGold.length} Aufgaben, bei denen die Angabe ankam:`);
  console.log(`  besser ${b2}, schlechter ${s2}, p = ${vorzeichen(b2, s2).toFixed(4)}`);
  console.log('  (Diese Teilmenge ist NACH dem Abruf gebildet, nicht vorher —');
  console.log('   sie beschreibt, wo der Hebel ansetzt, und ersetzt die Bilanz oben nicht.)');
}
