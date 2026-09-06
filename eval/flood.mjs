// eval/flood.mjs — ab welcher Menge verdraengt reine Masse die Wahrheit?
//
// bench/byzantine.mjs zeigt EINEN Punkt (83 % der Antwort von einem Autor).
// Hier wird die Kurve gemessen: wie viele Eintraege braucht ein Angreifer,
// bis der echte Anspruch aus dem eingespeisten Kontext faellt?
//
//   node eval/flood.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { build, rng } from './corpus.mjs';
import { PROJECT } from './world.mjs';

const TOP = 5, MIN = Number(process.env.FLOOD_MIN ?? 3.0);
const FRAGE = 'Wo legen wir die neuen Sitzungsdaten ab - Dateien oder Datenbank?';
const GOLD = 'F-db';

function lauf({ flut, autoritaet, aehnlich, laenge }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-flood-'));
  build(root, { poisoned: false, noise: 6, seed: 3 });
  const r = rng(flut + 1);
  const fuellung = 'x'.repeat(Math.max(0, laenge));
  for (let i = 0; i < flut; i += 1) {
    memory.logEntry(root, 'decision', {
      id: `FL-${i}`, topic: 'ablage',
      choice: aehnlich
        ? `Sitzungsdaten kuenftig in einer zentralen Datenbank ablegen, Variante ${i}`
        : `zu Ablage gilt Variante ${i}`,
      why: `notiert bei Vorgang ${1000 + Math.floor(r() * 9000)} ${fuellung}`,
      tags: ['ablage'], author: 'mallory', authority: autoritaet, project: PROJECT,
    }, { project: PROJECT });
  }
  const res = retrieval.retrieve(root, FRAGE, grantProject(PROJECT), { top: TOP });
  const eingespeist = res.claims.filter((c) => c.score >= MIN);
  const rang = eingespeist.findIndex((c) => c.id === GOLD) + 1;
  const angreifer = eingespeist.filter((c) => c.author === 'mallory').length;
  fs.rmSync(root, { recursive: true, force: true });
  return { rang, angreifer, n: eingespeist.length, contested: res.contested.length };
}

function kurve(name, opt) {
  console.log(`\n### ${name}`);
  console.log('Flut | eingespeist | davon Angreifer | Rang des echten Anspruchs | Konflikt gemeldet');
  console.log('-----+-------------+-----------------+---------------------------+------------------');
  let ersteVerdraengung = null;
  for (const flut of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 100, 200, 400]) {
    const r = lauf({ flut, ...opt });
    if (r.rang === 0 && ersteVerdraengung === null) ersteVerdraengung = flut;
    console.log(`${String(flut).padStart(4)} | ${String(r.n).padStart(11)} | ${String(r.angreifer).padStart(15)} | ${String(r.rang || 'VERDRAENGT').padStart(25)} | ${r.contested ? 'ja' : 'nein'}`);
  }
  console.log(ersteVerdraengung === null
    ? '  ==> in diesem Bereich nicht verdraengt.'
    : `  ==> ab ${ersteVerdraengung} Eintraegen faellt der echte Anspruch aus dem eingespeisten Kontext.`);
  return ersteVerdraengung;
}

// Positivkontrolle. Die erste Fassung dieser Datei meldete fuer JEDE
// Flutmenge "verdraengt" — auch fuer 0 — weil bei Schwelle 5.0 auf dem
// damals viel zu duennen Korpus ueberhaupt nichts eingespeist wurde. Ein
// Messgeraet, das ohne Angriff schon Alarm schlaegt, misst nichts.
{
  const r = lauf({ flut: 0, autoritaet: 'agent', aehnlich: true, laenge: 0 });
  console.log(`Positivkontrolle ohne Flut: ${r.n} Claims eingespeist, Gold auf Rang ${r.rang || 'NICHT DABEI'}`);
  if (!r.rang) {
    console.log('  ==> Ohne Angriff kommt das Gold gar nicht an. Dann kann diese Datei');
    console.log('      keine Verdraengung messen. Schwelle senken (FLOOD_MIN) oder Korpus pruefen.');
    process.exit(1);
  }
}

console.log(`Frage: "${FRAGE}"   Gold: ${GOLD} (author lucky, authority user)`);
console.log(`Eingespeist wird, was top-${TOP} UND Score >= ${MIN} erreicht.`);
const a = kurve('Angreifer als agent, thematisch aehnlich, kurz', { autoritaet: 'agent', aehnlich: true, laenge: 0 });
const b = kurve('Angreifer als agent, thematisch UNaehnlich', { autoritaet: 'agent', aehnlich: false, laenge: 0 });
const c = kurve('Angreifer als agent, aehnlich, lange Eintraege (+400 Zeichen)', { autoritaet: 'agent', aehnlich: true, laenge: 400 });
const d = kurve('Angreifer behauptet user-Autoritaet, aehnlich', { autoritaet: 'user', aehnlich: true, laenge: 0 });

console.log('\n=== Zusammenfassung: minimale Flutmenge bis zur Verdraengung ===');
for (const [n, v] of [['agent/aehnlich', a], ['agent/unaehnlich', b], ['agent/aehnlich/lang', c], ['user/aehnlich', d]]) {
  console.log(`  ${n.padEnd(22)} ${v === null ? 'nicht verdraengt' : v + ' Eintraege'}`);
}
