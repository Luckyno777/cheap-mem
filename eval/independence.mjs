// eval/independence.mjs — verraet die Aufgabe ihre eigene Antwort?
//
// KRITERIUM, dritte und letzte Fassung. Die ersten beiden waren falsch,
// und beide Fehler in derselben Richtung: zu streng.
//
//   1. "kein gemeinsames Wort"  -> die Aufgaben wurden so entkernt, dass
//      BM25 das Gold gar nicht mehr finden KONNTE. Recall fiel auf fast
//      null; ein A/B haette Memory faelschlich als wirkungslos gezeigt.
//   2. "kein gemeinsames SELTENES Wort" -> auch falsch. Wenn ein Fakt
//      einmal im Korpus steht, ist sein Themenwort per Konstruktion
//      selten. Dass eine Frage nach der Gesundheitspruefung das Wort
//      "Gesundheitspruefung" enthaelt, ist keine Leckage — das ist der
//      Normalfall, fuer den ein Gedaechtnis existiert.
//
// Leckage ist, wenn die Frage die ANTWORT enthaelt, nicht wenn sie das
// Thema nennt. Genau das war der Befund an bench/tokens.mjs: dort steht
// "duplicate charges" als Frage und "duplicate charges" als Antwort, und
// gemessen wird Zeichenkettengleichheit.
//
// Gemessen werden deshalb ZWEI Groessen, und nur die erste ist ein Fehler:
//
//   VERRATEN   die FRAGE erfuellt bereits die Bewertungsregel der Aufgabe.
//              Dann ist die Antwort in der Frage, und die Aufgabe testet
//              nichts. Das ist exakt pruefbar, weil `must`/`mustNot`
//              ohnehin definieren, was als richtig gilt — ein Wortanteil
//              ist dafuer zu grob: "Port 9443" hat zwei Inhaltswoerter,
//              eines davon das Thema, und eine Frage nach dem Port faellt
//              damit faelschlich durch.
//   THEMATISCH die Frage nennt das Thema, nicht die Antwort. Normal.
//
// Dazu, gleichrangig: ist das Gold ueberhaupt auffindbar? Eine Aufgabe,
// deren Gold der Retriever nicht finden KANN, misst nichts ueber Nutzen.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as search from '../src/search.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { FACTS } from './world.mjs';

const words = (s) => String(s).toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
const FAKT = new Map(FACTS.map((f) => [f.id, f]));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ind-'));
build(root, { poisoned: false });
const idx = search.buildIndex(root);
const N = idx.documents.length;
const texts = idx.documents.map((d) => JSON.stringify(d.entry ?? d));
const df = new Map();
for (const t of texts) for (const w of new Set(words(t))) df.set(w, (df.get(w) ?? 0) + 1);
// KRITERIUM KORRIGIERT (2026-09-06). Erst hiess es: kein gemeinsames
// seltenes Wort. Damit wurden die Aufgaben so entkernt, dass BM25 den
// Gold-Eintrag GAR NICHT MEHR FINDEN KONNTE — Recall fiel auf fast null und
// jeder A/C-Vergleich haette Memory faelschlich als wirkungslos gezeigt.
//
// Ein gemeinsames Wort ist nicht das Problem. Ein Wort, das den Gold-Eintrag
// EINDEUTIG IDENTIFIZIERT, ist das Problem. Ein Nutzer sagt "Port", wenn er
// einen Port meint; die Absicherung ist, dass auch Ablenkungseintraege von
// Ports handeln.
const IDENTIFIZIEREND = 3;   // kommt in <= 3 Dokumenten vor -> zeigt aufs Gold

console.log(`Korpus: ${N} Dokumente\n`);
console.log('Task | Kl | Frage erfuellt schon die Regel? | thematische Ueberlappung');
console.log('-----+----+---------------------------------+-------------------------');
let verraten = 0, thematisch = 0, ohneGold = 0;
for (const t of TASKS) {
  if (!t.gold.length) { ohneGold += 1; continue; }
  // Exakt: wuerde die FRAGE selbst als richtige Antwort durchgehen?
  // Die Formatanweisung am Ende gehoert nicht zur Frage. "Antworte mit ja
  // oder nein" enthaelt das Wort, das die Regel verlangt, ohne dass die
  // Frage irgendetwas verraet.
  const sachfrage = t.prompt.replace(/\s*(Antworte|Nenne|Nur)\b[^.]*\.?\s*$/i, '').trim();
  const schlimm = t.must.every((re) => re.test(sachfrage)) && t.mustNot.every((re) => !re.test(sachfrage));
  const qw = new Set(words(t.prompt));
  let geteilt = [];
  for (const gid of t.gold) {
    const f = FAKT.get(gid);
    if (f) geteilt.push(...words(f.kern.wahl).filter((w) => qw.has(w)));
  }
  geteilt = [...new Set(geteilt)];
  if (schlimm) verraten += 1; else thematisch += 1;
  console.log(`${t.id.padEnd(4)} | ${t.klasse.padEnd(2)} | ${(schlimm ? 'JA — die Frage ist die Antwort' : 'nein').padEnd(31)} | ${geteilt.join(' ') || '—'}`);
}


// Zweite Pflichtzahl. Eine Aufgabe, deren Gold der Retriever nicht finden
// KANN, misst nichts ueber Memory-Nutzen — sie misst nur, dass BM25 lexikalisch
// ist. Ohne diese Zahl haette der erste Entwurf ein falsches Negativ geliefert.
const ret = await import('../src/retrieval.mjs');
const { grantProject } = await import('../src/capability.mjs');
const { PROJECT } = await import('./world.mjs');
let erreichbar = 0, mitGold = 0;
const scores = [];
console.log('\nAuffindbarkeit (top 5, ohne Schwelle):');
for (const t of TASKS) {
  if (!t.gold.length) continue;
  mitGold += 1;
  const r = ret.retrieve(root, t.prompt, grantProject(PROJECT), { top: 5 });
  scores.push(...r.claims.map((c) => c.score));
  const hit = t.gold.filter((g) => r.claims.some((c) => c.id === g));
  if (hit.length) erreichbar += 1;
  console.log(`  ${t.id.padEnd(4)} Gold ${hit.length ? 'gefunden (' + hit.join(',') + ')' : 'NICHT gefunden'}   bester Score ${(r.claims[0]?.score ?? 0).toFixed(2)}`);
}
scores.sort((a, b) => a - b);
const q = (p) => (scores[Math.floor(scores.length * p)] ?? 0).toFixed(2);
console.log(`\n  Gold auffindbar bei ${erreichbar}/${mitGold} Aufgaben`);
console.log(`  Score-Verteilung (n=${scores.length}): min ${scores[0]?.toFixed(2)} p50 ${q(0.5)} p90 ${q(0.9)} max ${scores.at(-1)?.toFixed(2)}`);
console.log(`  Anteil >= 5.0 (Vorgabe-Schwelle MEM_RETRIEVE_MIN): ${(scores.filter((x) => x >= 5).length / scores.length * 100).toFixed(1)}%`);

console.log('');
console.log(`Aufgaben mit Gold: ${TASKS.length - ohneGold}   davon`);
console.log(`  VERRATEN (Frage enthaelt die Antwort): ${verraten}`);
console.log(`  nur thematisch (Normalfall):           ${thematisch}`);
console.log(`Aufgaben ohne Gold (Klasse F, absichtlich): ${ohneGold}`);
console.log('');
console.log('Zum Vergleich, bench/tokens.mjs: dort ist die Frage bei mehreren');
console.log('Paaren woertlich die Antwort ("duplicate charges").');
if (verraten) {
  console.log(`\n  ==> ${verraten} Aufgabe(n) enthalten ihre eigene Antwort. Umformulieren.`);
  process.exitCode = 1;
} else {
  console.log('\n  ==> Keine Aufgabe verraet ihre Antwort. Thematische Ueberlappung');
  console.log('      bleibt und ist gewollt: danach fragt ein Mensch nun einmal.');
}
fs.rmSync(root, { recursive: true, force: true });
