// eval/nur-roh.mjs — was kostet die Reserve-Bahn?
//
// Seit dem 2026-09-06 kommt Rohfang im Gateway erst dran, wenn das
// Gepflegte die Plaetze nicht fuellt. Das hat gemessen genutzt (Gold im
// vergifteten Korpus 8/33 -> 11/33). Der Preis stand daneben als Satz,
// nicht als Zahl:
//
//   "Steht eine Angabe nur im Fang und liefert das Gepflegte fuenf
//    mittelmaessige Treffer, kommt der Fang nicht mehr durch."
//
// Genau diese Lage baut diese Messung. Ein Teil der Fakten existiert NUR
// als Rohfang — ungefasst, so wie der Stop-Hook sie ablegt, bevor der
// Fasser gelaufen ist. Das ist keine Randlage: zwischen Fang und Fasser
// liegen im Betrieb Stunden, und in dieser Zeit ist der Fang die einzige
// Quelle.
//
// Gemessen wird nicht ueber die id — ein Rohfang hat keine —, sondern
// ueber die Frage, ob die WAHL des Fakts im eingespeisten Kontext steht.
//
//   node eval/nur-roh.mjs [--min 5] [--top 5]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { FACTS, PROJECT } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 5);

const cap = grantProject(PROJECT);
const FAKT = new Map(FACTS.map((f) => [f.id, f]));
const mitGold = TASKS.filter((t) => t.gold.length);

/** Inhaltswoerter der WAHL — daran wird der Fakt im Kontext erkannt. */
function kennworte(id) {
  const f = FAKT.get(id);
  if (!f) return [];
  return String(f.kern.wahl).toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
}

/**
 * Steht der Fakt im Kontext? Mehrheit seiner Kennworte muss vorkommen.
 *
 * Nicht "ein Wort reicht": die Woerter der Wahl sind Fachbegriffe des
 * Themas und stehen auch in Nachbareintraegen. Nicht "alle": der Fang
 * bricht bei RAW_CAP ab und die Wiedergabe kuerzt.
 */
function drinnen(id, koerper) {
  const w = kennworte(id);
  if (!w.length) return false;
  const text = koerper.toLowerCase();
  let n = 0;
  for (const x of w) if (text.includes(x)) n += 1;
  return n / w.length > 0.5;
}

// Welche Fakten wandern in den Rohfang? Jeder dritte, deterministisch —
// keine Auswahl nach Gefallen.
const NUR_ROH = FACTS.filter((_, i) => i % 3 === 0).map((f) => f.id);
const betroffen = mitGold.filter((t) => t.gold.some((g) => NUR_ROH.includes(g)));

function messe(label, bauOpt, retrOpt = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nurroh-'));
  build(root, { seed: 3, ...bauOpt });
  let treffer = 0, rohImKontext = 0, claims = 0, betroffenTreffer = 0;
  const verloren = [];
  for (const t of mitGold) {
    const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP, ...retrOpt });
    const drin = r.claims.filter((c) => c.score >= MIN);
    claims += drin.length;
    rohImKontext += drin.filter((c) => !c.id).length;
    const koerper = drin.map((c) => c.body).join('\n');
    const hat = t.gold.some((g) => drinnen(g, koerper));
    if (hat) treffer += 1; else verloren.push(t.id);
    if (betroffen.some((b) => b.id === t.id) && hat) betroffenTreffer += 1;
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { label, treffer, claims, rohImKontext, verloren, betroffenTreffer };
}

console.log(`Fakten nur als Rohfang: ${NUR_ROH.length} von ${FACTS.length}`);
console.log(`davon betroffene Aufgaben: ${betroffen.length} von ${mitGold.length} (${betroffen.map((t) => t.id).join(' ')})\n`);

const zeilen = [
  messe('alles gepflegt (Grundlinie)', {}),
  messe('ein Drittel nur als Rohfang, Reserve-Bahn', { nurRoh: NUR_ROH }),
  // Die Gegenprobe, und sie entscheidet die Deutung: kommt der Fang nicht
  // durch, WEIL er Reserve ist — oder weil ein ungefasstes Protokoll
  // ohnehin schlechter auffindbar ist als ein gepflegter Eintrag?
  messe('dieselbe Verlagerung, Rohfang gleichberechtigt', { nurRoh: NUR_ROH },
    { rawReserve: false }),
];

console.log('Bedingung                                   | Fakt im Kontext | davon betroffene | Rohfang-Claims');
console.log('--------------------------------------------+-----------------+------------------+---------------');
for (const z of zeilen) {
  console.log(`${z.label.padEnd(43)} | ${String(`${z.treffer}/${mitGold.length}`).padStart(15)} | ${String(`${z.betroffenTreffer}/${betroffen.length}`).padStart(16)} | ${String(z.rohImKontext).padStart(14)}`);
}

const [grund, reserve, offen] = zeilen;
console.log(`\nPreis der Reserve-Bahn, insgesamt: ${grund.treffer - reserve.treffer} Aufgaben von ${mitGold.length}.`);
console.log(`Preis auf den betroffenen Aufgaben: ${grund.betroffenTreffer - reserve.betroffenTreffer} von ${betroffen.length}.`);
console.log(`Was die Gegenprobe holt: ${offen.betroffenTreffer - reserve.betroffenTreffer} von ${betroffen.length} — mehr ist mit dieser Regel nicht zu verlieren.`);
const neuVerloren = reserve.verloren.filter((x) => !grund.verloren.includes(x));
console.log(`neu verloren gegenueber der Grundlinie: ${neuVerloren.length ? neuVerloren.join(' ') : '(keine)'}`);
