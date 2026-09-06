// eval/echo.mjs — reproduziert den Befund aus src/search.mjs:1031
// ("13 of 18 injected hits were such echoes") mit grossem n.
//
// Aufbau wie im echten Betrieb: der Stop-Hook legt jede Nachricht als
// Rohfang ab, der Abruf-Hook sucht bei jeder naechsten Nachricht. Die
// beste Trefferzeile fuer eine aehnliche Frage ist dann die eigene
// frühere Frage. Gemessen wird der Anteil solcher Treffer an dem, was
// tatsaechlich eingespeist wuerde (Score >= Schwelle).
//
//   node eval/echo.mjs [--min 5] [--top 3]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import { build, rng } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { PROJECT } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 3);

// Fragenpool: die Aufgaben plus Varianten plus Alltagsfragen einer Sitzung.
const THEMEN = ['auslieferung', 'protokollierung', 'tests', 'suchfeld', 'rechte', 'bilder',
  'benachrichtigung', 'zeitplan', 'pakete', 'abhaengigkeiten', 'fehlerbilder', 'zwischenspeicher'];
const VORSPANN = ['Wie machen wir das mit', 'Was gilt bei', 'Kannst du kurz erklaeren, wie',
  'Ich haenge fest bei', 'Was war nochmal der Stand zu', 'Gibt es eine Festlegung zu'];
const NACHSPANN = ['?', ' im Projekt?', ' — kurz bitte.', ' und warum?'];

function fragen(r, n) {
  const out = TASKS.map((t) => t.prompt);
  while (out.length < n) {
    const v = VORSPANN[Math.floor(r() * VORSPANN.length)];
    const t = THEMEN[Math.floor(r() * THEMEN.length)];
    const na = NACHSPANN[Math.floor(r() * NACHSPANN.length)];
    out.push(`${v} ${t}${na}`);
  }
  return out;
}

/**
 * So rendert der Hook einen Treffer (bin/mem:2047 compactLine). NICHT die
 * JSON-Zeile: deren Schluesselnamen (title, tags, author, authority,
 * project) sind Inhaltswoerter, die in keiner Frage vorkommen, und
 * druecken die Ueberlappung unter die Schwelle. Eine erste Fassung dieser
 * Messung tat genau das und meldete 0 von 2532 Echos — ein Nullergebnis,
 * das nur die Sonde beschrieb.
 */
function compactLine(e) {
  const parts = [];
  if (e.class) parts.push(`[${e.class}]`);
  if (e.topic) parts.push(`[${e.topic}]`);
  if (e.title) parts.push(e.title);
  if (e.choice) parts.push(`-> ${e.choice}`);
  if (e.text) parts.push(String(e.text).slice(0, 80).replace(/\s+/g, ' '));
  if (e.why) parts.push(`weil ${String(e.why).slice(0, 60)}`);
  return parts.join(' - ') || '(kein kompakter Text)';
}

/** Wilson-Intervall: bei Anteilen nahe 0 oder 1 ehrlicher als normal-approx. */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

// Positivkontrolle. Ohne sie kann ein Nullergebnis nicht von einer
// kaputten Sonde unterschieden werden.
{
  const q = 'Welchen Port trage ich fuer die Erreichbarkeitspruefung ein';
  const echo = compactLine({ title: q, text: q });
  const fremd = compactLine({ topic: 'zwischenspeicher', choice: 'nach sieben Tagen leeren', why: 'danach ist er kalt' });
  const a = search.isEcho(q, echo), b = search.isEcho(q, fremd);
  console.log(`Positivkontrolle: echtes Echo erkannt = ${a}, fremder Treffer als Echo = ${b}`);
  if (!a || b) { console.log('  ==> Die Sonde misst nicht, was sie messen soll. Abbruch.'); process.exit(1); }
}

/** Leichte Umformulierung: Fuellwort rein, ein Inhaltswort raus, Reihenfolge gleich. */
function umformulieren(q, r) {
  const w = q.split(/\s+/).filter(Boolean);
  if (w.length > 4) w.splice(Math.floor(r() * (w.length - 1)) + 1, 1);
  const zusatz = ['nochmal kurz', 'ich vergesse das immer', 'zur Sicherheit', 'sag mir bitte'];
  return `${zusatz[Math.floor(r() * zusatz.length)]}: ${w.join(' ')}`;
}

const MODUS = process.argv.includes('--umformuliert') ? 'umformuliert' : 'wortgleich';
console.log(`Modus: ${MODUS}   Schwelle ${MIN}, top ${TOP}\n`);
console.log('Memory | Fragen | Abrufe | eingespeiste Treffer | Echos | Rate  | 95%-Intervall');
console.log('-------+--------+--------+----------------------+-------+-------+----------------');

const zeilen = [];
for (const groesse of [50, 200, 600]) {
  const r = rng(11);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-echo-'));
  build(root, { poisoned: false, noise: Math.max(1, Math.round(groesse / 25)), seed: 11 });
  const pool = fragen(r, groesse);
  // Der Rohfang: jede frühere Frage liegt als Eintrag in der Memory.
  pool.forEach((q, i) => memory.logEntry(root, 'thought', {
    id: `Q-${i}`, title: q, text: q, tags: ['fang'],
    author: 'session', authority: 'inferred', project: PROJECT,
  }, { project: PROJECT }));

  const idx = search.buildIndex(root);
  let treffer = 0, echos = 0, abrufe = 0;
  const nachLaenge = new Map();
  // ZWEI Bedingungen, und der Unterschied ist wichtig:
  //   'wortgleich'  dieselbe Frage nochmal — die OBERGRENZE, nicht der Alltag
  //   'umformuliert' aehnlich gestellt — was der Kommentar in search.mjs
  //                  tatsaechlich beschreibt ("something similar is asked")
  // Eine Messung nur mit wortgleichen Fragen ueberschaetzt den Effekt.
  const stellen = (q) => (MODUS === 'wortgleich' ? q : umformulieren(q, r));
  for (const q0 of pool) {
    const q = stellen(q0);
    abrufe += 1;
    const hits = search.search(idx, q, { top: TOP }).filter((h) => h.score >= MIN);
    const bucket = q.length < 60 ? 'kurz' : q.length < 110 ? 'mittel' : 'lang';
    const b = nachLaenge.get(bucket) ?? { t: 0, e: 0 };
    for (const h of hits) {
      const text = compactLine(h.entry);
      treffer += 1; b.t += 1;
      if (search.isEcho(q, text)) { echos += 1; b.e += 1; }
    }
    nachLaenge.set(bucket, b);
  }
  const [lo, hi] = wilson(echos, treffer);
  console.log(`${String(idx.documents.length).padStart(6)} | ${String(pool.length).padStart(6)} | ${String(abrufe).padStart(6)} | ${String(treffer).padStart(20)} | ${String(echos).padStart(5)} | ${(echos / Math.max(1, treffer) * 100).toFixed(1).padStart(5)}% | ${(lo * 100).toFixed(1)}% - ${(hi * 100).toFixed(1)}%`);
  zeilen.push({ groesse: idx.documents.length, treffer, echos, nachLaenge });
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\nNach Fragelaenge (alle Memory-Groessen zusammen):');
const gesamt = new Map();
for (const z of zeilen) for (const [k, v] of z.nachLaenge) {
  const g = gesamt.get(k) ?? { t: 0, e: 0 }; g.t += v.t; g.e += v.e; gesamt.set(k, g);
}
for (const [k, v] of [...gesamt].sort()) {
  const [lo, hi] = wilson(v.e, v.t);
  console.log(`  ${k.padEnd(7)} ${String(v.e).padStart(4)}/${String(v.t).padStart(4)} = ${(v.e / Math.max(1, v.t) * 100).toFixed(1).padStart(5)}%  (${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%)`);
}
const T = zeilen.reduce((n, z) => n + z.treffer, 0);
const E = zeilen.reduce((n, z) => n + z.echos, 0);
const [lo, hi] = wilson(E, T);
console.log(`\nGesamt: ${E}/${T} = ${(E / T * 100).toFixed(1)}%  95%-Intervall ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%`);
console.log(`Vergleich, der urspruengliche Befund: 13/18 = 72,2%  (n=18, eine Sitzung)`);
const [olo, ohi] = wilson(13, 18);
console.log(`  dessen 95%-Intervall waere: ${(olo * 100).toFixed(1)}%-${(ohi * 100).toFixed(1)}% — bei n=18 fast wertlos.`);
