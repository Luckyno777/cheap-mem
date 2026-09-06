// eval/echo.mjs — reproduziert den Befund aus src/search.mjs:1031
// ("13 of 18 injected hits were such echoes") mit grossem n.
//
// Aufbau wie im echten Betrieb: der Stop-Hook legt jede Nachricht als
// Rohfang ab, der Abruf-Hook sucht bei jeder naechsten Nachricht. Die
// beste Trefferzeile fuer eine aehnliche Frage ist dann die eigene
// frühere Frage. Gemessen wird der Anteil solcher Treffer an dem, was
// tatsaechlich eingespeist wuerde (Score >= Schwelle).
//
//   node eval/echo.mjs [--min 5] [--top 3] [--umformuliert] [--je-fang N]
//
// 2026-09-06 KORRIGIERT. Die erste Fassung legte jede frühere Frage als
// `thought`-Eintrag ab und mass mit `isEcho(frage, compactLine(eintrag))`.
// Beides gibt es im Betrieb nicht: der Stop-Hook schreibt eine gzip-Datei
// unter raw/, und der ausgelieferte Filter (search.isEchoHit) sieht NUR
// Rohfang und darin nur den gefangenen Text. Die Messung beschrieb also
// einen Pfad, den niemand geht — und ihr Ergebnis ("39 von 39 weg") war
// keine Aussage ueber das, was ausgeliefert wird.
//
// Gegen ECHTES Material gemessen (483 Rohfaenge aus lucky-mem, 211 von
// Hand getippte Nutzernachrichten als Fragen): 27 von 535 eingespeisten
// Treffern verworfen = 5,0 % (95 %: 3,5-7,2 %). 4 von 211 Fragen verlieren
// dadurch ihren ganzen Kontext, 17 einen Teil. Das ist die Groessenordnung,
// nicht die 72 % aus dem urspruenglichen Befund.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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
 * Nur noch fuer die Stichprobe in der Ausgabe. Gezaehlt wird mit
 * search.isEchoHit — derselbe Aufruf, den `mem find` und der Gateway
 * machen. Eine Messung, die ihre eigene Wiedergabe erfindet, misst ihre
 * eigene Wiedergabe: eine frühere Fassung uebergab die JSON-Zeile, deren
 * Schluesselnamen die Ueberlappung unter die Schwelle druecken, und
 * meldete 0 von 2532 Echos.
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
  const rohEcho = { type: 'raw', entry: { title: '[raw] a.jsonl.gz', text: q } };
  const rohFremd = { type: 'raw', entry: { title: '[raw] b.jsonl.gz',
    text: 'Der Zwischenspeicher wird nach sieben Tagen geleert, danach ist er kalt.' } };
  const getippt = { type: 'thought', entry: { title: q, text: q } };
  const a = search.isEchoHit(q, rohEcho), b = search.isEchoHit(q, rohFremd);
  // Dritte Kontrolle: der Filter DARF getippte Eintraege nicht anfassen.
  if (search.isEchoHit(q, getippt)) {
    console.log('Positivkontrolle: der Filter greift an getippten Eintraegen. Abbruch.');
    process.exit(1);
  }
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
const JE_FANG = Math.max(1, arg('je-fang', 1));
const proben = [];

/** Schreibt die Fragen als echte Rohfaenge, `je` Nachrichten pro Datei. */
function fangAblegen(root, pool, je) {
  const dir = path.join(root, 'raw', '2026', '09');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < pool.length; i += je) {
    const stueck = pool.slice(i, i + je);
    const zeilen = stueck.map((q, k) => JSON.stringify({
      ts: `2026-09-0${1 + (i % 5)}T10:${String(k % 60).padStart(2, '0')}:00Z`,
      role: 'user', text: q,
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `2026-09-01T10-00-${String(i % 60).padStart(2, '0')}Z--f${i}.jsonl.gz`),
      zlib.gzipSync(zeilen));
  }
}
console.log(`Modus: ${MODUS}   Schwelle ${MIN}, top ${TOP}, ${JE_FANG} Nachricht(en) je Rohfang\n`);
console.log('Memory | Fragen | Abrufe | eingespeiste Treffer | Echos | Rate  | 95%-Intervall');
console.log('-------+--------+--------+----------------------+-------+-------+----------------');

const zeilen = [];
for (const groesse of [50, 200, 600]) {
  const r = rng(11);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-echo-'));
  build(root, { poisoned: false, noise: Math.max(1, Math.round(groesse / 25)), seed: 11 });
  const pool = fragen(r, groesse);
  // Der Rohfang, so wie der Stop-Hook ihn anlegt: gzip-JSONL unter
  // raw/JJJJ/MM/. `--je-fang N` legt N Nachrichten in EINE Datei, wie eine
  // echte Sitzung. Das ist kein Detail: ein Fang mit zwoelf Nachrichten ist
  // EIN Dokument, und die Ueberlappung mit einer einzelnen Frage faellt
  // entsprechend. Vorgabe 1 = die Obergrenze, nicht der Alltag.
  fangAblegen(root, pool, JE_FANG);

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
      treffer += 1; b.t += 1;
      if (search.isEchoHit(q, h)) {
        echos += 1; b.e += 1;
        if (proben.length < 3) proben.push([q, String(h.entry.text ?? compactLine(h.entry))]);
      }
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
