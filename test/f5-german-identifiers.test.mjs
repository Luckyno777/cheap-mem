// F5 / suggestion list item 23 (cheap-mem half): German IDENTIFIERS in the
// English-only product.
//
// **What the two existing probes do, and the gap.** `english-only.test.mjs`
// reads COMMENT lines of src/, bin/, test/, bench/ and flags a line with two
// distinct German function words; `english-ratchet.test.mjs` runs the same
// two-word rule over EVERY line of every tracked text file and ratchets the
// count per file. Both look for German SENTENCES. An identifier carries no
// function word: `const zaehler = 0`, `kurzhash`, `ablage`, `FELD_KANTEN`
// pass both, however German they are (audit 2026-09-30).
//
// **This probe.** It takes the identifiers out of CODE (comments and
// string/template literals removed, so test fixtures and the synonym lists
// in src/thesaurus.mjs -- German on purpose -- are not read), splits them
// at camelCase / snake_case boundaries, and flags an identifier that holds a
// word from GERMAN_IDENTIFIER_WORDS below.
//
// **The list is a list of unmistakable German code words, not a language
// detector.** Words that are also English ("probe", "agent", "stand", "text",
// "rest", "minute", ...) are NOT on it; a German identifier built from other
// words slips through. That is the cost of a rule that never flags English.
//
// **A ceiling, not a rewrite.** The old stock (39 files, 65 identifiers,
// measured 2026-10-01) is capped per file in CEILING below. A file not listed
// must have none; a listed file must not get more; fewer is fine (lower the
// ceiling to keep the gain). Same shape as english-ratchet.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { files, read, stripComments } from './f5-source.mjs';

export const GERMAN_IDENTIFIER_WORDS = new Set([
  'zaehler', 'zaehle', 'kurzhash', 'ablage', 'kanten', 'kante', 'schreibe', 'lese', 'hole', 'pruefe',
  'baue', 'finde', 'suche', 'wurzel', 'fehler', 'eintrag', 'eintraege', 'zeile', 'zeilen', 'datei',
  'dateien', 'schalter', 'befehl', 'ergebnis', 'bericht', 'verzeichnis', 'spiegel', 'sperre',
  'schloss', 'zustand', 'erfahrung', 'entscheidung', 'gedaechtnis', 'nutzung', 'sitzung', 'frage',
  'antwort', 'treffer', 'quelle', 'anzahl', 'summe', 'gesamt', 'frisch', 'schwelle', 'deckel',
  'gruen', 'weg', 'wege', 'pfad', 'gruppe', 'jetzt', 'gestern', 'woche', 'nachricht', 'absender',
  'empfaenger', 'abruf', 'einblendung', 'vorschlag', 'urteil', 'grund', 'aenderung', 'bauteil',
  'hilfe', 'pflicht', 'verfahren', 'lernen', 'kette', 'riegel', 'daten', 'rueckgabe', 'ausgabe',
  'eingabe', 'rumpf', 'koerper', 'inhalt', 'zwischen', 'merken', 'merke', 'gemerkt', 'gefunden',
  'gefundene', 'geschrieben', 'gelesen', 'offen', 'geschlossen', 'erledigt', 'verworfen', 'gueltig',
  'ungueltig', 'vorher', 'nachher', 'abstand', 'schlag', 'stamm', 'staemme', 'wort', 'woerter',
  'nutzer', 'mensch', 'erlaubnis', 'freigabe', 'zahlen',
]);

/** Identifiers of a code text that contain a German word (distinct). */
export function germanIdentifiers(text) {
  const code = stripComments(text)
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, ' ');
  const found = new Set();
  for (const id of new Set(code.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])) {
    const parts = id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split('_').filter(Boolean);
    if (parts.some((p) => p.length >= 5 && GERMAN_IDENTIFIER_WORDS.has(p))) found.add(id);
  }
  return [...found].sort();
}

// Old stock per file: number of distinct German identifiers (2026-10-01).
const CEILING = {
  'bench/atlas/phase-real.mjs': 7,
  'bench/byzantine.mjs': 1,
  'bench/consumption-funnel.mjs': 1,
  'bench/field-without-writer.mjs': 6,
  'bench/mutation.mjs': 1,
  'bench/redteam.mjs': 2,
  'bin/mem-stop': 1,
  'src/archive.mjs': 1,
  'src/clihelp.mjs': 1,
  'src/dashboard-data.mjs': 1,
  'src/doctor.mjs': 2,
  'src/neighbours.mjs': 1,
  'src/net.mjs': 1,
  'src/parity.mjs': 1,
  'src/raw.mjs': 1,
  'src/release.mjs': 1,
  'src/setup.mjs': 1,
  'test/audit-grenzen.test.mjs': 2,
  'test/audit-kanten.test.mjs': 1,
  'test/capture-drop.test.mjs': 3,
  'test/cli-groups.test.mjs': 6,
  'test/context-budget.test.mjs': 2,
  'test/doku-zahlen.test.mjs': 2,
  'test/english-dictionary.mjs': 1,
  'test/entry-content.test.mjs': 1,
  'test/eval-frozen.test.mjs': 1,
  'test/field-without-writer.test.mjs': 1,
  'test/hook-windows-root.test.mjs': 1,
  'test/installer-parity.test.mjs': 3,
  'test/no-log-without-reader.test.mjs': 1,
  'test/package-contents.test.mjs': 1,
  'test/package-size.test.mjs': 2,
  'test/portability.test.mjs': 1,
  'test/powershell-ascii.test.mjs': 1,
  'test/raw-stats.test.mjs': 1,
  'test/real-phase-fields.test.mjs': 1,
  'test/release-dashboard-wiring.test.mjs': 1,
  'test/release.test.mjs': 1,
  'test/tool-count-doc.test.mjs': 1
};

const CANDIDATES = () => ['src', 'bin', 'test', 'bench'].flatMap((d) => files(d,
  (n) => /\.(mjs|js)$/.test(n) || (d === 'bin' && !n.includes('.'))));

test('positive control: German identifiers are seen, English ones and strings are not', () => {
  assert.deepEqual(germanIdentifiers('const zaehler = 0; let kurzHash = x;'), ['zaehler', 'kurzHash']);
  assert.deepEqual(germanIdentifiers('const FELD_KANTEN = 1; function holeEintrag() {}'), ['FELD_KANTEN', 'holeEintrag']);
  assert.deepEqual(germanIdentifiers("const probe = 'zaehler'; // ablage\nconst agent = `kurzhash`;"), []);
  assert.deepEqual(germanIdentifiers('const sleeper = 1; const rest = 2; const stand = 3;'), []);
});

test('German identifiers do not grow (old stock capped per file)', () => {
  const tooMany = []; const seen = {};
  for (const rel of CANDIDATES()) {
    const ids = germanIdentifiers(read(rel));
    if (!ids.length) continue;
    seen[rel] = ids.length;
    const cap = CEILING[rel] ?? 0;
    if (ids.length > cap) tooMany.push(`${rel}: ${ids.length} German identifier(s) (cap ${cap}): ${ids.join(', ')}`);
  }
  assert.deepEqual(tooMany, [], `German identifiers in an English-only product -- rename them:\n${tooMany.join('\n')}`);
  for (const rel of Object.keys(CEILING)) assert.ok(rel in seen || CANDIDATES().includes(rel), `ceiling entry '${rel}' names a file that is gone`);
});
