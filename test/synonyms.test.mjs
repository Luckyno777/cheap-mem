// Does the curated word list reach into THIS memory?
//
// Measured 2026-09-06: `THESAURUS` is English (39 groups, 188 words). A
// German memory gets zero synonyms out of it — 0 of 198 query terms
// across 21 questions, against 53 of 44 in English. Retrieval keeps
// working, but one of its three expansion layers is mute, and until
// here nothing said so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as thesaurus from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';

test('curatedCoverage separates covered from uncovered vocabulary', () => {
  // State 2026-09-06 AFTER the extension: German is now part of the
  // groups. Before that the curated layer produced zero synonyms for
  // German queries (0 of 342 terms across 39 questions, against 53 of
  // 44 in English) — this assertion recorded that state and is now to
  // be read the other way round.
  const en = ['deploy', 'error', 'test', 'build', 'slow', 'restart', 'merge', 'branch', 'timeout', 'crash'];
  const de = ['auslieferung', 'fehler', 'pruefung', 'anmeldung', 'datenbank',
    'entscheidung', 'gedaechtnis', 'zeitstempel', 'obergrenze', 'aufbewahrung'];
  // Vocabulary the list deliberately does NOT know — the negative
  // control. Without it, "everything covered" would be indistinguishable
  // from a broken measurement that always says yes.
  const unknown = ['abrechnungsmodul', 'stundenzettelpuffer', 'aufmasszeile',
    'gewerkstapel', 'nachtragsposten'];
  assert.equal(thesaurus.curatedCoverage(en, pack('en')).covered, en.length,
    'English words have to be covered');
  assert.equal(thesaurus.curatedCoverage(de, pack('de')).covered, de.length,
    'German words have to be covered since the extension');
  assert.equal(thesaurus.curatedCoverage(unknown, pack('de')).covered, 0,
    'invented jargon must NOT be covered — otherwise the function measures nothing');
});

test('a user word list closes the gap', async () => {
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
    assert.equal(c.covered, 1, 'the user group is not counted in');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    // Reset the state: loadUserGroups is module-wide, and a leftover
    // entry colours every test that follows.
    thesaurus.loadUserGroups(os.tmpdir(), fs, path);
  }
});
