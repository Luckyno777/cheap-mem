// eval/independence.mjs — wie stark verrät die Aufgabe ihre eigene Antwort?
//
// Pflichtmessung vor jedem Lauf. Wenn die Aufgabe ein seltenes Wort mit dem
// Gold-Eintrag teilt, misst der Benchmark Keyword-Matching. Gemessen am
// vorhandenen bench/tokens.mjs: 10 von 15 Fragen tun genau das, und die
// Trefferquote zerfaellt in 9/10 (trivial) gegen 3/5 (nicht trivial).
//
//   node eval/independence.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as search from '../src/search.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';

const words = (s) => String(s).toLowerCase().match(/[a-zaeoeuess0-9]{3,}/g) ?? [];

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

console.log(`Korpus: ${N} Dokumente. "identifizierend" = kommt in <= ${IDENTIFIZIEREND} Dokumenten vor.\n`);
console.log('Task | Klasse | Gold          | gemeinsame Woerter mit Gold | selten? ');
console.log('-----+--------+---------------+-----------------------------+---------');

let trivial = 0, ok = 0, ohneGold = 0;
for (const t of TASKS) {
  if (!t.gold.length) { ohneGold++; console.log(`${t.id.padEnd(4)} | ${t.klasse.padEnd(6)} | (keins)       | —                           | n/a`); continue; }
  const qw = new Set(words(t.prompt));
  const shared = new Set();
  for (const gid of t.gold) {
    const gtext = texts.find((x) => x.includes(`"${gid}"`));
    if (!gtext) { console.log(`${t.id}: GOLD ${gid} NICHT IM KORPUS`); continue; }
    for (const w of new Set(words(gtext))) if (qw.has(w)) shared.add(w);
  }
  const rare = [...shared].filter((w) => (df.get(w) ?? 0) <= IDENTIFIZIEREND);
  if (rare.length) trivial++; else ok++;
  const desc = [...shared].map((w) => `${w}(${df.get(w)})`).join(' ') || '—';
  console.log(`${t.id.padEnd(4)} | ${t.klasse.padEnd(6)} | ${t.gold.join(',').slice(0, 13).padEnd(13)} | ${desc.slice(0, 27).padEnd(27)} | ${rare.length ? 'JA: ' + rare.join(',') : 'nein'}`);
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
console.log(`Aufgaben mit Gold:                          ${TASKS.length - ohneGold}`);
console.log(`  davon lexikalisch trivial (seltenes Wort): ${trivial}`);
console.log(`  davon nicht trivial:                       ${ok}`);
console.log(`Aufgaben ohne Gold (Klasse F, absichtlich):  ${ohneGold}`);
console.log('');
console.log('Zum Vergleich, bench/tokens.mjs: 10 von 15 trivial.');
if (trivial > (TASKS.length - ohneGold) * 0.34) {
  console.log('\n  ==> WARNUNG: mehr als ein Drittel der Aufgaben verraet ihre Antwort');
  console.log('      lexikalisch. Umformulieren, bevor Ergebnisse etwas heissen.');
  process.exitCode = 1;
} else {
  console.log('\n  ==> Leckage unter einem Drittel. Ergebnisse messen mehrheitlich Nutzen,');
  console.log('      nicht Wortgleichheit. Die Zahl gehoert trotzdem in den Bericht.');
}
fs.rmSync(root, { recursive: true, force: true });
