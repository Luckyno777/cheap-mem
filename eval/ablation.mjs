// eval/ablation.mjs — warum kommt die gesuchte Angabe nicht an?
//
// Bei 13 von 18 Aufgaben landet das Gold nicht im eingespeisten Kontext.
// Das kann vier Ursachen haben, und sie verlangen voellig verschiedene
// Konsequenzen:
//
//   (a) meine Aufgaben sind zu unabhaengig formuliert  -> Benchmark-Fehler
//   (b) der Korpus ist zu duenn je Thema               -> Benchmark-Fehler
//   (c) die Erweiterungsschichten greifen nicht        -> cheap-mem-Defekt
//   (d) die Schwelle filtert zu hart                   -> kalibrierbar
//
// Diese Datei zerlegt die Fehlschlaege danach. Sie faehrt DIESELBE Ablation
// auf dem englischen Korpus aus bench/tokens.mjs als Positivkontrolle: eine
// Schicht, die dort auch nichts beitraegt, ist nicht angeschlossen, und
// dann misst die Ablation den Schalter statt die Sache.
//
//   node eval/ablation.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as search from '../src/search.mjs';
import * as thesaurus from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';

const TOP = 5, MIN = 5.0;

// --- 1. Traegt der kuratierte Thesaurus bei deutschem Text ueberhaupt bei?
console.log('=== 1. Kuratierte Synonyme: deutsch gegen englisch ===\n');
console.log(`THESAURUS: ${thesaurus.THESAURUS.length} Gruppen, ${thesaurus.THESAURUS.flat().length} Woerter\n`);

function erweiterung(text, langName) {
  const lang = pack(langName);
  const terme = search.tokenizeGroups(text, { lexicon: null, lang }).flat();
  // Nur die kuratierte Schicht: beide gelernten Graphen auf null.
  const nur = thesaurus.expand(terme, null, lang, null);
  return { terme: terme.length, neu: nur.length };
}

const DE = TASKS.map((t) => t.prompt);
const EN = ['why did we pick postgres', 'what is leaking memory', 'how do we roll out releases',
  'tests that fail at random', 'caching strategy', 'queue delivery guarantees',
  'why not embeddings', 'a migration held a lock', 'log format', 'how does login work',
  'duplicate charges', 'stale search results', 'what did we learn about exit codes',
  'when did the beta open', 'disk full incident'];

for (const [name, fragen, lng] of [['deutsch', DE, 'de'], ['englisch', EN, 'en']]) {
  let terme = 0, neu = 0, mitTreffer = 0;
  for (const q of fragen) { const e = erweiterung(q, lng); terme += e.terme; neu += e.neu; if (e.neu) mitTreffer += 1; }
  console.log(`${name.padEnd(9)}: ${fragen.length} Fragen, ${terme} Terme -> ${neu} Synonyme `
    + `(${(neu / Math.max(1, terme)).toFixed(2)} je Term), Fragen mit mindestens einem: ${mitTreffer}/${fragen.length}`);
}

// --- 2. Recall unter Ablation, deutscher Benchmark-Korpus
console.log('\n=== 2. Recall der Gold-Claims unter Ablation (deutscher Korpus) ===\n');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-abl-'));
build(root, { poisoned: false, seed: 3 });
const idx = search.buildIndex(root);
const mitGold = TASKS.filter((t) => t.gold.length);

const leer = new Map();
const varianten = [
  ['voll (alles an)', idx, { mmr: true }],
  ['ohne MMR', idx, { mmr: false }],
  ['ohne tagGraph', { ...idx, tagGraph: leer }, { mmr: true }],
  ['ohne termGraph', { ...idx, termGraph: leer }, { mmr: true }],
  ['ohne beide Graphen', { ...idx, tagGraph: leer, termGraph: leer }, { mmr: true }],
];

console.log('Variante             | Gold in top-5 | Gold ueber Schwelle | Aufgaben mit leerem Kontext');
console.log('---------------------+---------------+---------------------+----------------------------');
for (const [name, index, opt] of varianten) {
  let inTop = 0, ueber = 0, leerK = 0;
  for (const t of mitGold) {
    const h = search.search(index, t.prompt, { top: TOP, ...opt });
    const treffer = h.filter((x) => t.gold.includes(x.entry?.id));
    if (treffer.length) inTop += 1;
    if (treffer.some((x) => x.score >= MIN)) ueber += 1;
    if (!h.some((x) => x.score >= MIN)) leerK += 1;
  }
  console.log(`${name.padEnd(20)} | ${`${inTop}/${mitGold.length}`.padStart(13)} | ${`${ueber}/${mitGold.length}`.padStart(19)} | ${String(leerK).padStart(27)}`);
}

// --- 3. Was kostet allein die Schwelle?
console.log('\n=== 3. Wirkung der Schwelle allein (voll, MMR an) ===\n');
console.log('Schwelle | Gold im Kontext | Claims gesamt | leerer Kontext');
console.log('---------+-----------------+---------------+----------------');
for (const s of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
  let g = 0, c = 0, l = 0;
  for (const t of mitGold) {
    const h = search.search(idx, t.prompt, { top: TOP, mmr: true }).filter((x) => x.score >= s);
    c += h.length;
    if (h.some((x) => t.gold.includes(x.entry?.id))) g += 1;
    if (!h.length) l += 1;
  }
  console.log(`${String(s).padStart(8)} | ${`${g}/${mitGold.length}`.padStart(15)} | ${String(c).padStart(13)} | ${String(l).padStart(14)}`);
}
fs.rmSync(root, { recursive: true, force: true });
