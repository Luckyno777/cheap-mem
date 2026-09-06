// Der Agentenpfad darf nicht schlechter sein als der Menschenpfad.
//
// Befund vom 2026-09-06: `search()` hat `mmr: false` als Vorgabe.
// `bin/mem find` schaltet die Vielfalts-Neuordnung ein, `src/retrieval.mjs`
// tat es nicht — also bekamen `mem retrieve` und das MCP-Werkzeug
// `mem_retrieve`, die ein Agent benutzt, reine BM25-Reihenfolge. Fast
// gleiche Eintraege desselben Themas fuellen damit die Trefferliste, und
// die Antwort auf die eigentliche Frage liegt darunter.
//
// Gemessen am eval-Korpus (189 Dokumente, 18 Aufgaben mit bekanntem Gold):
// das gesuchte Claim war in den top-5 bei 7 von 18 Aufgaben ohne MMR und
// bei 9 von 18 mit MMR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';

// Gross genug, dass idf etwas bedeutet. Eine erste Fassung dieses Tests
// benutzte 13 Dokumente — dort steht das gemeinsame Wort in 12 davon, hat
// also fast kein Gewicht, und die Duplikate erreichten die Trefferliste
// nie. Der Test haette dann die Groesse des Korpus geprueft, nicht den Code.
function bau() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-div-'));
  fs.mkdirSync(path.join(r, 'projects', 'p'), { recursive: true });
  const log = (d) => memory.logEntry(r, 'decision', { ...d, author: 'lucky', authority: 'user', project: 'p' }, { project: 'p' });

  // 15 fast gleiche Eintraege, die die Frage lexikalisch treffen.
  for (let i = 0; i < 15; i += 1) {
    log({ id: `DUP-${i}`, topic: 'pakete',
      choice: `Abhaengigkeiten im Repository nachvollziehbar festnageln, Runde ${i}`,
      why: 'das Bild des Laufwerks driftete zweimal in einem Monat und kostete jedes Mal einen halben Tag Arbeit',
      tags: ['pakete'] });
  }
  // 24 unbeteiligte Eintraege, damit der Korpus nicht aus zwei Themen besteht.
  const rest = ['protokollierung', 'tests', 'suchfeld', 'rechte', 'bilder', 'benachrichtigung', 'zeitplan', 'fehlerbilder'];
  rest.forEach((thema, k) => {
    for (let i = 0; i < 3; i += 1) {
      log({ id: `X-${thema}-${i}`, topic: thema,
        choice: `zu ${thema} gilt Fassung ${i}`,
        why: `entschieden bei Vorgang ${500 + k * 10 + i}, und seitdem unveraendert geblieben`,
        tags: [thema] });
    }
  });
  // Genau EIN Eintrag beantwortet die Frage, mit einem anderen Thema.
  log({ id: 'ANTWORT', topic: 'ablage',
    choice: 'Dateien im Repository statt einer externen Datenbank',
    why: 'ein Dienst, den niemand wartet, ist teurer als eine Datei, und die Ablage bleibt nachvollziehbar',
    tags: ['ablage'] });
  return r;
}

const FRAGE = 'Wie halten wir die Ablage im Repository nachvollziehbar?';

test('die Vorgabe des Gateways ist dieselbe wie die von `mem find`', () => {
  // Der eigentliche Befund war kein Rankingproblem, sondern eine ABWEICHUNG:
  // zwei Abrufwege mit verschiedenen Vorgaben, und der Agentenweg hatte die
  // schlechtere. Genau das wird hier festgenagelt — nicht ueber ein
  // Verhaltensmerkmal, das von der Vorrichtung abhaengt, sondern direkt.
  //
  // Eine erste Fassung dieses Tests prueft, ob Fast-Duplikate die
  // Trefferliste fuellen. Sie war auch mit der ALTEN Vorgabe gruen und
  // haette die Regression nicht gefangen.
  const r = bau();
  try {
    const vorgabe = retrieve(r, FRAGE, grantProject('p'), { top: 5 });
    const anMmr = retrieve(r, FRAGE, grantProject('p'), { top: 5, mmr: true });
    const ohneMmr = retrieve(r, FRAGE, grantProject('p'), { top: 5, mmr: false });
    const ids = (x) => x.claims.map((c) => c.id);
    assert.deepEqual(ids(vorgabe), ids(anMmr),
      'die Vorgabe entspricht nicht `mem find` (mmr an)');
    assert.notDeepEqual(ids(ohneMmr), ids(anMmr),
      'auf dieser Vorrichtung aendert MMR nichts — dann prueft der Vergleich oben nichts');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('MMR aendert die AUSWAHL, und ohne MMR ist sie eintoeniger', () => {
  // Ohne diesen Vergleich koennte der Test oben auch gruen sein, wenn MMR
  // gar nichts tut und BM25 zufaellig schon vielfaeltig antwortet.
  const r = bau();
  try {
    const ohne = retrieve(r, FRAGE, grantProject('p'), { top: 5, mmr: false });
    const mit = retrieve(r, FRAGE, grantProject('p'), { top: 5, mmr: true });
    const themen = (x) => new Set(x.claims.map((c) => c.topic)).size;
    assert.ok(themen(mit) >= themen(ohne),
      `MMR verschlechtert die Vielfalt: ohne ${themen(ohne)} Themen, mit ${themen(mit)}`);
    assert.notDeepEqual(ohne.claims.map((c) => c.id), mit.claims.map((c) => c.id),
      'MMR aendert die Auswahl nicht — dann ist die Vorrichtung wirkungslos und der Test ohne Zaehne');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
