// eval/grundwert.mjs — was beantwortet das Modell OHNE jedes Gedaechtnis?
//
// Die Obergrenze aus kennzahlen.mjs ("bei 36 % der Aufgaben kommt die
// noetige Angabe im Kontext an") sagt nur, ob die Angabe ANKOMMT. Sie
// sagt nicht, ob das Modell sie ohnehin gewusst haette. Bei "UTC,
// ISO-8601" oder "Cookies statt Browserspeicher" raet es richtig — und
// an solchen Aufgaben misst der ganze Benchmark nichts.
//
// Arm A ist genau dieser Fall: der Prompt ist die blosse Frage, kein
// Kontext, kein Verlauf. Dieses Skript liest den Lauf und stellt ihn
// gegen die VORHERSAGE `erratbar` aus world.mjs.
//
// Der Sinn ist die Widerlegbarkeit. `erratbar` ist ein Urteil, und wie
// unsicher dieses Urteil ist, wurde gemessen: zwei unabhaengige
// Einschaetzungen derselben 15 Fakten stimmten bei 9 ueberein. Ein Label
// mit 60 % Uebereinstimmung darf keine Kennzahl tragen — die Messung
// muss es koennen korrigieren.
//
//   node eval/grundwert.mjs eval/runs/zustandslos-sonnet5.jsonl

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { FACTS, PROJECT } from './world.mjs';

const datei = process.argv[2] ?? 'eval/runs/zustandslos-sonnet5.jsonl';
const zeilen = fs.readFileSync(datei, 'utf8').split('\n')
  .filter((z) => z.trim()).map((z) => JSON.parse(z));

const nurA = zeilen.filter((r) => r.arm === 'A');
if (!nurA.length) { console.log('Kein Arm-A-Datensatz in', datei); process.exit(1); }

const FAKT = new Map(FACTS.map((f) => [f.id, f]));
const AUFGABE = new Map(TASKS.map((t) => [t.id, t]));

/** Vorhersage der Aufgabe: ratbar, wenn ALLE ihre Gold-Fakten ratbar sind. */
function vorhergesagt(t) {
  if (!t.gold?.length) return null;             // Klasse F: absichtlich ohne Gold
  const f = t.gold.map((g) => FAKT.get(g)).filter(Boolean);
  if (!f.length) return null;
  return f.every((x) => x.erratbar === true);
}

const wilson = (k, n, z = 1.96) => {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const sd = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - sd) / d), Math.min(1, (c + sd) / d)];
};

const gruppen = new Map([['ratbar', []], ['nicht ratbar', []], ['ohne Gold', []]]);
const klassen = new Map();
const treffer = [];
for (const r of nurA) {
  const t = AUFGABE.get(r.task_id);
  if (!t) continue;
  const v = vorhergesagt(t);
  const g = v === null ? 'ohne Gold' : (v ? 'ratbar' : 'nicht ratbar');
  gruppen.get(g).push(r);
  if (!klassen.has(t.klasse)) klassen.set(t.klasse, []);
  klassen.get(t.klasse).push(r);
  treffer.push({ id: r.task_id, klasse: t.klasse, vorhergesagt: v, gemessen: r.success });
}

const p = (k, n) => `${k}/${n} = ${(100 * k / Math.max(1, n)).toFixed(0)} %`;
console.log(`Zustandsloser Lauf: ${nurA.length} Aufgaben, Modell ${nurA[0].model}\n`);

console.log('Gruppe        | ohne Memory richtig | 95%-Intervall');
console.log('--------------+---------------------+---------------');
for (const [name, rs] of gruppen) {
  if (!rs.length) continue;
  const k = rs.filter((r) => r.success).length;
  const [lo, hi] = wilson(k, rs.length);
  console.log(`${name.padEnd(13)} | ${p(k, rs.length).padStart(19)} | ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)} %`);
}

console.log('\nNach Klasse:');
for (const [kl, rs] of [...klassen].sort()) {
  const k = rs.filter((r) => r.success).length;
  console.log(`  ${kl}  ${p(k, rs.length)}`);
}

// Wo Label und Messung auseinandergehen: das Label ist widerlegt, nicht
// die Messung. Beide Richtungen zaehlen, und beide sind interessant.
const falschRatbar = treffer.filter((x) => x.vorhergesagt === true && !x.gemessen);
const falschNicht = treffer.filter((x) => x.vorhergesagt === false && x.gemessen);
console.log(`\nVorhersage geprueft (${treffer.filter((x) => x.vorhergesagt !== null).length} Aufgaben mit Gold):`);
console.log(`  als ratbar gelabelt, aber ohne Memory FALSCH:   ${falschRatbar.length}  ${falschRatbar.map((x) => x.id).join(' ')}`);
console.log(`  als nicht ratbar gelabelt, aber RICHTIG geraten: ${falschNicht.length}  ${falschNicht.map((x) => x.id).join(' ')}`);

const mitGold = treffer.filter((x) => x.vorhergesagt !== null);
const stimmt = mitGold.filter((x) => x.vorhergesagt === x.gemessen).length;
console.log(`  Label trifft die Messung bei ${p(stimmt, mitGold.length)}`);

// Der Kopfraum: nur wo die Angabe ANKOMMT und das Modell OHNE sie
// scheitert, kann Memory ueberhaupt etwas bewirken. Beides einzeln zu
// berichten ueberschaetzt den Nutzen — die beiden Mengen ueberlappen.
const cap = grantProject(PROJECT);
const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-kopf-'));
build(wurzel, { seed: 3 });
let kommtAn = 0, kopfraum = 0, geschenkt = 0;
const kopfIds = [];
for (const r of nurA) {
  const t = AUFGABE.get(r.task_id);
  if (!t?.gold?.length) continue;
  const rr = retrieval.retrieve(wurzel, t.prompt, cap, { top: 5 });
  const drin = rr.claims.filter((c) => c.score >= 5 || (c.exact && c.exact.length));
  const hat = t.gold.some((g) => drin.some((c) => c.id === g));
  if (hat) kommtAn += 1;
  if (hat && !r.success) { kopfraum += 1; kopfIds.push(r.task_id); }
  if (!hat && r.success) geschenkt += 1;
}
fs.rmSync(wurzel, { recursive: true, force: true });

const mitGoldN = nurA.filter((r) => AUFGABE.get(r.task_id)?.gold?.length).length;
console.log('\nDer Kopfraum — wo Memory ueberhaupt wirken KANN:');
console.log(`  Angabe kommt im Kontext an:                 ${p(kommtAn, mitGoldN)}`);
console.log(`  Modell antwortet ohne Memory richtig:       ${p(nurA.filter((r) => r.success && AUFGABE.get(r.task_id)?.gold?.length).length, mitGoldN)}`);
console.log(`  BEIDES: Angabe da UND ohne sie gescheitert: ${p(kopfraum, mitGoldN)}   ${kopfIds.join(' ')}`);
console.log(`  ohne Angabe trotzdem richtig (Weltwissen):  ${p(geschenkt, mitGoldN)}`);

console.log('\nWas daraus folgt:');
const kNicht = gruppen.get('nicht ratbar');
const kNichtOk = kNicht.filter((r) => r.success).length;
console.log(`  Auf den ${kNicht.length} nicht-ratbaren Aufgaben beantwortet das Modell ${p(kNichtOk, kNicht.length)}`);
console.log('  ohne jedes Gedaechtnis. Nur der REST kann durch Memory besser werden —');
console.log('  alles darueber misst Weltwissen, nicht Erinnerung.');
