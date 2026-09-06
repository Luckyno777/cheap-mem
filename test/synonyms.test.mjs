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

test('curatedCoverage trennt eine gedeckte von einer ungedeckten Sprache', () => {
  const en = ['deploy', 'error', 'test', 'build', 'slow', 'restart', 'merge', 'branch', 'timeout', 'crash'];
  const de = ['zeitstempel', 'auslieferung', 'ablage', 'anmeldung', 'bildgroesse',
    'aufbewahrung', 'berichtsformat', 'oberflaeche', 'pruefung', 'vorgang'];
  const a = thesaurus.curatedCoverage(en, pack('en'));
  const b = thesaurus.curatedCoverage(de, pack('de'));
  // Positivkontrolle zuerst: ohne sie waere "0 Treffer" nicht von einer
  // kaputten Messung zu unterscheiden.
  assert.equal(a.covered, en.length, 'englische Woerter muessen gedeckt sein — sonst misst die Funktion nichts');
  assert.equal(b.covered, 0, 'deutsche Woerter duerfen nicht gedeckt sein, solange die Liste englisch ist');
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
