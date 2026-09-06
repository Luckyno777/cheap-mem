// eval/kennzahlen.mjs — was ueber den Nutzen von cheap-mem OHNE Modell
// entscheidbar ist. Kosten: 0.
//
// Die Frage "macht Memory den Agenten besser?" zerfaellt. Nur EIN Teil
// braucht wirklich ein Modell:
//
//   kommt die benoetigte Information ueberhaupt an?   <- Code. OBERGRENZE
//   wie viel des Eingespeisten ist Muell?             <- Code. UNTERGRENZE
//   wird eine Korrektur wirksam, ein Konflikt gemeldet? <- Code, reiner Zustand
//   was kostet der Kontext?                            <- Code, exakt
//   AENDERT die Information die Antwort?               <- Modell. Nur hier.
//
// Kommt das Gold nie im Kontext an, kann kein Modell davon profitieren —
// dann ist der Modellversuch verschwendetes Geld. Dieses Blatt sagt, ob er
// sich lohnt, und wie schmal das Band ist, in dem der Nutzen liegen kann.
//
//   node eval/kennzahlen.mjs [--min 5] [--top 5]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as retrieval from '../src/retrieval.mjs';
import * as search from '../src/search.mjs';
import { grantProject } from '../src/capability.mjs';
import { build } from './corpus.mjs';
import { TASKS } from './tasks.mjs';
import { PROJECT, FACTS } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN = arg('min', 5.0);
const TOP = arg('top', 5);
const est = (s) => Math.ceil(String(s).length / 4);

function compactLine(e) {
  const p = [];
  if (e.topic) p.push(`[${e.topic}]`);
  if (e.title) p.push(e.title);
  if (e.choice) p.push(`-> ${e.choice}`);
  if (e.text) p.push(String(e.text).slice(0, 80));
  if (e.why) p.push(`weil ${String(e.why).slice(0, 60)}`);
  return p.join(' - ');
}

// Welche Fakten sind ersetzt worden? Deren alte Fassung darf NICHT als
// aktiv im Kontext landen — das ist ohne Modell pruefbar.
const ERSETZT = new Map(FACTS.filter((f) => f.ersetzt).map((f) => [f.ersetzt, f.id]));

function messe(cond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cm-kz-${cond}-`));
  build(root, {
    poisoned: cond === 'vergiftet', seed: 3,
    echoes: cond === 'vergiftet' ? TASKS.map((t) => t.prompt) : [],
  });
  const cap = grantProject(PROJECT);
  const z = {
    aufgaben: 0, mitGold: 0, goldImKontext: 0, kontextLeer: 0,
    claims: 0, goldClaims: 0, echos: 0, veraltetDurch: 0,
    konfliktErwartet: 0, konfliktGemeldet: 0,
    autoritaetsBruch: 0, tok: 0,
  };
  const zeilen = [];
  for (const t of TASKS) {
    z.aufgaben += 1;
    const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP });
    const drin = r.claims.filter((c) => c.score >= MIN);
    if (!drin.length) z.kontextLeer += 1;
    z.claims += drin.length;
    z.tok += est(drin.map((c) => c.body).join('\n'));

    const goldDrin = t.gold.filter((g) => drin.some((c) => c.id === g));
    if (t.gold.length) {
      z.mitGold += 1;
      if (goldDrin.length) z.goldImKontext += 1;
      z.goldClaims += goldDrin.length;
    }
    // Echos: waere das eingespeist worden, obwohl es nur die Frage ist?
    for (const c of drin) if (search.isEcho(t.prompt, compactLine({ text: c.body }))) z.echos += 1;
    // Veraltetes: eine ersetzte Fassung im Kontext, und zwar als aktiv.
    for (const c of drin) if (ERSETZT.has(c.id) && c.status === 'active') z.veraltetDurch += 1;
    // Konflikt: bei Klasse E MUSS contested gemeldet sein.
    if (t.klasse === 'E') { z.konfliktErwartet += 1; if (r.contested.length) z.konfliktGemeldet += 1; }
    // Autoritaetsbruch: ein agent-Claim als aktiv, wo ein user-Claim ersetzt wurde.
    for (const c of drin) if (c.authority !== 'user' && c.status === 'active'
      && drin.some((o) => o.topic === c.topic && o.authority === 'user' && o.status !== 'active')) z.autoritaetsBruch += 1;

    zeilen.push({ id: t.id, klasse: t.klasse, n: drin.length, gold: goldDrin.length,
      soll: t.gold.length, best: drin[0]?.score.toFixed(1) ?? '-' });
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { z, zeilen };
}

const ergebnisse = {};
for (const cond of ['sauber', 'vergiftet']) ergebnisse[cond] = messe(cond);

console.log(`Schwelle ${MIN}, top ${TOP}, ${TASKS.length} Aufgaben\n`);
console.log('Kennzahl                                      |   sauber | vergiftet | entscheidet');
console.log('----------------------------------------------+----------+-----------+-------------------------');
const zeile = (name, f, was) => {
  const a = f(ergebnisse.sauber.z), b = f(ergebnisse.vergiftet.z);
  console.log(`${name.padEnd(45)} | ${String(a).padStart(8)} | ${String(b).padStart(9)} | ${was}`);
};
const pct = (x, y) => (y ? `${(x / y * 100).toFixed(0)}%` : '—');

zeile('Gold im eingespeisten Kontext', (z) => `${z.goldImKontext}/${z.mitGold}`, 'OBERGRENZE des Nutzens');
zeile('  als Anteil', (z) => pct(z.goldImKontext, z.mitGold), '');
zeile('Aufgaben mit LEEREM Kontext', (z) => `${z.kontextLeer}/${z.aufgaben}`, 'da kann Memory nichts bewirken');
zeile('Praezision (Gold je eingespeistem Claim)', (z) => pct(z.goldClaims, z.claims), 'UNTERGRENZE der Verschmutzung');
zeile('davon Echos der Frage', (z) => `${z.echos}/${z.claims}`, 'reiner Ballast');
zeile('veraltete Fassung als aktiv eingespeist', (z) => z.veraltetDurch, 'GATE: Korrekturversagen');
zeile('Konflikt gemeldet, wo erwartet', (z) => `${z.konfliktGemeldet}/${z.konfliktErwartet}`, 'GATE: Widerspruch');
zeile('Autoritaetsbruch (agent ueber user)', (z) => z.autoritaetsBruch, 'GATE: Autoritaet');
zeile('Kontextkosten in Token (alle Aufgaben)', (z) => z.tok, 'marginale Kosten, ohne CLI');

console.log('\nJe Aufgabe (sauber | vergiftet), n = eingespeiste Claims, Gold = davon richtige:');
console.log('Task | Kl | sauber n/Gold/soll best | vergiftet n/Gold/soll best');
console.log('-----+----+-------------------------+---------------------------');
for (let i = 0; i < TASKS.length; i += 1) {
  const a = ergebnisse.sauber.zeilen[i], b = ergebnisse.vergiftet.zeilen[i];
  console.log(`${a.id.padEnd(4)} | ${a.klasse.padEnd(2)} | ${`${a.n}/${a.gold}/${a.soll}`.padStart(9)} ${String(a.best).padStart(13)} | ${`${b.n}/${b.gold}/${b.soll}`.padStart(9)} ${String(b.best).padStart(15)}`);
}

const o = ergebnisse.sauber.z;
console.log('\n=== Was daraus folgt, ohne einen Modellaufruf ===');
console.log(`Memory kann hoechstens ${pct(o.goldImKontext, o.mitGold)} der Aufgaben verbessern —`);
console.log(`bei den uebrigen ${o.mitGold - o.goldImKontext} kommt die benoetigte Angabe gar nicht im Kontext an.`);
console.log(`Gleichzeitig sind ${pct(o.claims - o.goldClaims, o.claims)} des Eingespeisten nicht die gesuchte Angabe.`);
console.log('Ein Modellversuch lohnt nur fuer das Band dazwischen — und nur');
console.log('gepaart (dieselbe Aufgabe mit und ohne genau diesen Claim),');
console.log('weil dann die Aufgabenvarianz herausfaellt statt sie zu messen.');
