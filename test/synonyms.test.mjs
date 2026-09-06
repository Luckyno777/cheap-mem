// Greift die kuratierte Wortliste in DIESER Memory?
//
// Gemessen am 2026-09-06: `THESAURUS` ist englisch (39 Gruppen, 188
// Woerter). Eine deutsche Memory bekommt daraus null Synonyme — 0 aus 198
// Anfrage-Termen ueber 21 Fragen, gegen 53 aus 44 auf Englisch. Der Abruf
// laeuft weiter, aber eine seiner drei Erweiterungsschichten ist stumm,
// und bis hierher sagte das nichts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as thesaurus from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';

test('curatedCoverage trennt gedecktes von ungedecktem Vokabular', () => {
  // Stand 2026-09-06 NACH der Erweiterung: Deutsch steht jetzt mit in den
  // Gruppen. Vorher ergab die kuratierte Schicht fuer deutsche Anfragen
  // null Synonyme (0 aus 342 Termen ueber 39 Fragen, gegen 53 aus 44 auf
  // Englisch) — diese Zusicherung hat den Zustand festgehalten und ist
  // jetzt umgekehrt zu lesen.
  const en = ['deploy', 'error', 'test', 'build', 'slow', 'restart', 'merge', 'branch', 'timeout', 'crash'];
  const de = ['auslieferung', 'fehler', 'pruefung', 'anmeldung', 'datenbank',
    'entscheidung', 'gedaechtnis', 'zeitstempel', 'obergrenze', 'aufbewahrung'];
  // Vokabular, das die Liste bewusst NICHT kennt — die Negativkontrolle.
  // Ohne sie waere "alles gedeckt" nicht von einer kaputten Messung zu
  // unterscheiden, die immer wahr sagt.
  const fremd = ['abrechnungsmodul', 'stundenzettelpuffer', 'aufmasszeile',
    'gewerkstapel', 'nachtragsposten'];
  assert.equal(thesaurus.curatedCoverage(en, pack('en')).covered, en.length,
    'englische Woerter muessen gedeckt sein');
  assert.equal(thesaurus.curatedCoverage(de, pack('de')).covered, de.length,
    'deutsche Woerter muessen seit der Erweiterung gedeckt sein');
  assert.equal(thesaurus.curatedCoverage(fremd, pack('de')).covered, 0,
    'erfundene Fachbegriffe duerfen NICHT gedeckt sein — sonst misst die Funktion nichts');
});

test('eine eigene Wortliste schliesst die Luecke', async () => {
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-syn-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'thesaurus.json'),
      JSON.stringify([['auslieferung', 'ausrollen', 'inbetriebnahme']]));
    const r = thesaurus.loadUserGroups(root, fs, path);
    assert.equal(r.loaded, 1);
    const c = thesaurus.curatedCoverage(['auslieferung'], pack('de'));
    assert.equal(c.covered, 1, 'die eigene Gruppe wird nicht mitgezaehlt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    // Zustand zuruecksetzen: loadUserGroups ist modulweit, und ein
    // liegengebliebener Eintrag faerbt jeden folgenden Test.
    thesaurus.loadUserGroups(os.tmpdir(), fs, path);
  }
});
