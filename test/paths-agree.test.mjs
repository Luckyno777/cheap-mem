// Die beiden Abrufwege duerfen nicht auseinanderlaufen.
//
// cheap-mem hat zwei: `mem find` (Mensch) und `retrieve()` (Agent, ueber
// `mem retrieve` und MCP `mem_retrieve`). Sie duerfen verschieden RANKEN
// — der Gateway macht einen Rundlauf ueber Autoritaetsstufen, den `find`
// nicht kennt. Sie duerfen aber nicht verschiedene POLITIK fahren.
//
// Genau das ist zweimal passiert, in einer einzigen Sitzung:
//
//   2026-09-06  `search()` hat mmr:false als Vorgabe. `mem find` schaltet
//               es ein, der Gateway tat es nicht — der Agentenpfad bekam
//               reine BM25-Reihenfolge und fuellte sich mit Fast-
//               Duplikaten. Gemessen: Gold in top-5 bei 7 von 18 Aufgaben
//               ohne MMR, 9 von 18 mit.
//
//   2026-09-06  `isEcho` war implementiert, getestet und mit einer Messung
//               begruendet (13 von 18 eingespeisten Treffern waren Echos)
//               — und wurde von NICHTS aufgerufen. In `mem find` steckte
//               es hinter `--no-echo`, das niemand setzte; der Abruf-Hook,
//               der die 13/18 gemessen hatte, setzte es auch nicht.
//
// Zweimal dieselbe Klasse heisst: es gibt eine dritte Stelle. Dieser Test
// ist nicht gegen die beiden bekannten Faelle gerichtet, sondern gegen die
// naechste.
//
// EIN Unterschied ist Absicht und steht deshalb hier, statt geprueft zu
// werden: die Reserve-Bahn fuer Rohfang (seit 2026-09-06) gilt nur im
// Gateway. `mem find` mischt den Fang weiter nach Punktzahl ein und
// markiert ihn mit `[raw]`.
//
// Der Grund ist der Zweck. Der Gateway FUELLT EIN BUDGET fuer ein Modell,
// das nicht nachfragen kann; da ist ein ungefasstes Protokoll vor einer
// gepruefte Entscheidung ein Fehler. `mem find` legt einem Menschen eine
// Liste hin, der die Markierung sieht und `--only-raw` kennt.
//
// Wer das aendert, aendert also nicht eine Ungereimtheit, sondern eine
// Entscheidung. Faellt der Grund weg, faellt der Unterschied mit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as memory from '../src/memory.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HIER, '..', 'bin', 'mem');
const FRAGE = 'Wie halten wir die Ablage im Repository nachvollziehbar?';

function bau({ dups = 15 } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-wege-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, d.type ?? 'decision',
    { ...d, author: 'lucky', authority: 'user' });

  // (a) Ein Echo als ECHTER Rohfang, nicht als getippter Eintrag.
  //
  // Das ist keine Kosmetik: der Filter greift absichtlich NUR bei
  // Rohmaterial. Ein getippter Eintrag ist per Konstruktion nicht die
  // Frage des Nutzers, und ohne diese Einschraenkung faellt eine kurze
  // Entscheidung, die in seinen eigenen Worten abgelegt wurde. Eine erste
  // Fassung dieser Vorrichtung legte das Echo als `thought` ab und
  // pruefte damit einen Pfad, den es im Betrieb nicht gibt.
  const rohDir = path.join(r, 'raw', '2026', '09');
  fs.mkdirSync(rohDir, { recursive: true });
  const zeilen = [
    JSON.stringify({ ts: '2026-09-06T10:00:00Z', role: 'user', text: FRAGE }),
    JSON.stringify({ ts: '2026-09-06T10:00:01Z', role: 'user', text: FRAGE }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(rohDir, '2026-09-06T10-00-00Z--echo.jsonl.gz'), zlib.gzipSync(zeilen));
  // (b) Fast-Duplikate, die die Frage lexikalisch treffen.
  for (let i = 0; i < dups; i += 1) {
    log({ id: `DUP-${i}`, topic: 'pakete',
      choice: `Abhaengigkeiten im Repository nachvollziehbar festnageln, Runde ${i}`,
      why: 'das Bild des Laufwerks driftete zweimal in einem Monat', tags: ['pakete'] });
  }
  // (c) Genug unbeteiligter Korpus, damit idf etwas bedeutet.
  for (const thema of ['protokoll', 'tests', 'rechte', 'bilder', 'zeitplan', 'suchfeld', 'meldung', 'archiv']) {
    for (let i = 0; i < 3; i += 1) {
      log({ id: `X-${thema}-${i}`, topic: thema, choice: `zu ${thema} gilt Fassung ${i}`,
        why: `entschieden bei Vorgang ${500 + i}, seitdem unveraendert`, tags: [thema] });
    }
  }
  // (d) Eine Antwort mit eigenem Thema.
  log({ id: 'ANTWORT', topic: 'ablage', choice: 'Dateien im Repository statt einer externen Datenbank',
    why: 'ein Dienst, den niemand wartet, ist teurer als eine Datei', tags: ['ablage'] });
  return r;
}

const findIds = (root, extra = []) => {
  const top = extra.includes('--top') ? [] : ['--top', '5'];
  const out = execFileSync('node', [MEM, '--root', root, 'find', FRAGE, ...top, '--json', ...extra],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return (JSON.parse(out).hits ?? []).map((h) => h.entry?.id ?? '?');
};
const gatewayIds = (root, opt = {}) =>
  retrieve(root, FRAGE, grantAll(['read']), { top: 5, ...opt }).claims.map((c) => c.id);

test('beide Wege verwerfen per Vorgabe das Echo der Frage', () => {
  // Wenig gepflegte Konkurrenz, und das ist kein Detail: seit dem
  // 2026-09-06 ist der Rohfang im Gateway die Reserve-Bahn — er kommt
  // erst dran, wenn das Gepflegte die Plaetze nicht fuellt. Mit den
  // fuenfzehn Fast-Duplikaten der anderen Vorrichtung waere gar kein
  // Platz frei, und die Positivkontrolle waere rot, obwohl der Filter
  // nichts falsch macht.
  const r = bau({ dups: 1 });
  try {
    const WEIT = 12;
    const istRoh = (ids) => ids.some((x) => x === null || String(x).includes('raw') || x === '?');
    const ohne = () => findIds(r, ['--with-echo', '--top', String(WEIT)]);
    const mit = () => findIds(r, ['--top', String(WEIT)]);

    // Positivkontrolle zuerst: ohne die Politik MUSS das Echo auftauchen,
    // sonst prueft die Zusicherung darunter nichts.
    assert.ok(istRoh(ohne()), `die Vorrichtung erzeugt kein Rohfang-Echo: ${ohne().join(' ')}`);
    assert.ok(istRoh(gatewayIds(r, { dropEcho: false, top: WEIT })),
      `kein Rohfang-Echo im Gateway: ${gatewayIds(r, { dropEcho: false, top: WEIT }).join(' ')}`);

    assert.ok(!istRoh(mit()), `\`mem find\` speist das Echo ein: ${mit().join(' ')}`);
    assert.ok(!istRoh(gatewayIds(r, { top: WEIT })),
      `der Gateway speist das Echo ein: ${gatewayIds(r, { top: WEIT }).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('der Echo-Filter greift nur am Rohfang, nicht an getippten Eintraegen', () => {
  // Die Einschraenkung auf Rohfang ist kein Detail, sondern die Grenze
  // zwischen zwei Bahnen: Lane 1 (Stop-Hook) legt jede Nachricht ab, also
  // auch die Frage selbst. Was jemand von Hand ablegt, ist per Konstruktion
  // etwas anderes — auch wenn es zufaellig mit denselben Woertern beginnt.
  //
  // Ohne die Grenze faellt ein echter Anspruch. Gemessen: die Frage
  // "zahlung vorkasse entscheidung" gegen die Entscheidung "zahlung nur
  // per vorkasse — meine entscheidung" ergibt 3 von 4 Inhaltswoertern,
  // also 0,75 ueber der Schwelle 0,7.
  const r = bau();
  try {
    memory.logEntry(r, 'thought', {
      id: 'GETIPPT', topic: 'ablage', text: FRAGE,
      author: 'lucky', authority: 'user', tags: ['ablage'],
    });
    assert.ok(findIds(r, ['--top', '10']).includes('GETIPPT'),
      `\`mem find\` unterdrueckt einen getippten Eintrag: ${findIds(r, ['--top', '10']).join(' ')}`);
    assert.ok(gatewayIds(r, { top: 10 }).includes('GETIPPT'),
      `der Gateway unterdrueckt einen getippten Eintrag: ${gatewayIds(r, { top: 10 }).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('beide Wege fuellen die Trefferliste nicht allein mit Fast-Duplikaten', () => {
  const r = bau();
  try {
    const nurDup = (ids) => ids.length > 0 && ids.every((x) => String(x).startsWith('DUP-'));
    assert.ok(!nurDup(findIds(r)), `\`mem find\` liefert nur Duplikate: ${findIds(r).join(' ')}`);
    assert.ok(!nurDup(gatewayIds(r)), `der Gateway liefert nur Duplikate: ${gatewayIds(r).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
