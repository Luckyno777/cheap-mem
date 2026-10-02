// test/english-dictionary.mjs — the one German-recognition dictionary,
// extracted from test/english-only.test.mjs on 2026-09-26 so that
// test/english-ratchet.test.mjs (a much wider scan: every tracked text
// file, not just src/bin/test/bench comments) can reuse it rather than
// copy it. A second copy of GERMAN_WORDS is a second place for the two
// probes to drift apart the day someone adds a word to only one of
// them — the exact failure mode this file exists to close.
//
// This module holds only the RECOGNITION rule: the word list, the
// two-distinct-word threshold, and backtick stripping. It deliberately
// does NOT hold KNOWN_SRC_GERMAN_DATA, KNOWN_GERMAN_DATA or any other
// file-specific exception list — those name specific lines in specific
// files for reasons specific to the scan that names them, and belong
// next to that scan, not in the shared dictionary.
//
// See test/english-only.test.mjs's own header for the full reasoning
// behind the threshold (why one word is not enough — "die", "man" and
// "sein" are English words too), the excluded homographs ("was", "so"),
// and why a backtick-quoted span is stripped before counting (an
// identifier or a shared invariant id is not prose).

/**
 * The required dictionary, plus real German function words this
 * translation pass actually found causing false negatives. Deliberately
 * excludes "was" and "so" — genuine German/English homographs that
 * produced false positives during calibration against this repo's own
 * English text.
 */
export const GERMAN_WORDS = Object.freeze([
  'der', 'die', 'das', 'und', 'nicht', 'wird', 'werden', 'ist', 'sind',
  'eine', 'einen', 'keine', 'dass', 'weil', 'wenn', 'dann', 'noch',
  'schon', 'auch', 'aber', 'oder', 'durch', 'ueber', 'über', 'unter',
  'nach', 'vor', 'bei', 'mit', 'zum', 'zur', 'vom', 'beim', 'sich',
  'ihre', 'seine', 'hier', 'damit', 'sonst', 'immer', 'nie', 'jede',
  'jeder', 'alle', 'etwas', 'nichts', 'mehr', 'gemessen', 'gebaut',
  'fehler', 'zeile', 'datei', 'eintrag', 'probe',
  // Found while translating this repo, not in the task's starting list:
  'fuer', 'für', 'muss', 'koennen', 'können', 'soll', 'diese', 'dieser',
  'dieses', 'einem', 'einer', 'eines', 'wie', 'wer', 'wo', 'kein',
  'keinen', 'keiner', 'waere', 'wäre', 'haette', 'hätte', 'wurde',
  'wurden', 'auf', 'als', 'nur', 'geht', 'laeuft', 'läuft',
  'ausdruecklich', 'erlaubt', 'begruendung', 'niemand', 'verlangte',
  'direkt', 'ohne', 'koerper', 'pruefen', 'nachpruefen', 'erste',
  'muster', 'ausnahme', 'sondern', 'statt', 'moeglich', 'moeglichkeit',
  'sowie', 'ebenfalls', 'deshalb', 'trotzdem', 'zwar', 'einschraenkung',
  'entscheidend', 'gehoert', 'gegenteil', 'unbegruendeten',
]);
export const GERMAN_WORD_SET = new Set(GERMAN_WORDS);

/** Distinct dictionary words a line's own text carries. */
export function germanHits(text) {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  const found = new Set();
  for (const w of words) if (GERMAN_WORD_SET.has(w)) found.add(w);
  return [...found];
}

/**
 * A line with its backtick-quoted spans removed.
 *
 * A backtick-quoted span is an identifier, a path or a command. Prose
 * outside the backticks is still scanned, so a German sentence cannot
 * hide by putting one word in backticks. See test/english-only.test.mjs
 * for the incident (a citation of `leer-ist-kein-bestehen`) that this
 * rule closes.
 */
export function asProse(line) {
  return String(line).replace(/`[^`]*`/g, ' ');
}

/**
 * Verbatim German quotations this dictionary must not flag, named by
 * their exact text rather than matched by a pattern — see
 * test/english-only.test.mjs for why a general "text in quotes is fine"
 * rule would launder any German sentence someone puts in quotation
 * marks. An entry here is a decision about one specific sentence, and
 * it has to be copied from the source, so it cannot grow by accident.
 */
export const KNOWN_VERBATIM_QUOTES = Object.freeze([
  '"Die FAKTEN-KRITISCH-Notiz erwähnt die Container `claude`,',
  '`diggi-tunnel`, `omniroute` […] die vollständige Datei unter',
  // Shared house rules, quoted in the original (added 2026-09-20):
  'leer-ist-kein-bestehen',
  'nicht messbar ist nicht null',
  'Nicht messbar ist nicht null',
  'Ein Riegel, der Unschuldige meldet, wird abgeschaltet',
  'Ein leerer Ordner ist messbar leer',
]);

/**
 * German CODE words: the vocabulary that finds a German identifier or
 * a German word in a file name, where no function word ever appears
 * (`const zaehler = 0`, `test/doku-zahlen.test.mjs`). Shared by
 * test/f5-german-identifiers.test.mjs (identifiers in code and shell)
 * and test/english-ratchet.test.mjs (file names, single words in
 * comments), so the three probes recognise German code words the same
 * way — moved here from the F5 probe on 2026-10-01.
 *
 * **Unmistakable words only, not a language detector.** A word that is
 * also English (`probe`, "hole", "rest", "stand", "lies", `muster`,
 * "band", "tot" in `ssTot`, "hier" in `hierId`) is NOT on it: a rule
 * that flags English gets switched off. Every word on the list counts,
 * however short (`roh`, `neu`); a short word that is also an English
 * fragment or abbreviation simply does not go on it.
 */
export const GERMAN_IDENTIFIER_WORDS = Object.freeze(new Set([
  'zaehler', 'zaehle', 'kurzhash', 'ablage', 'kanten', 'kante', 'schreibe', 'lese', 'pruefe',
  'baue', 'finde', 'suche', 'wurzel', 'fehler', 'eintrag', 'eintraege', 'zeile', 'zeilen', 'datei',
  'dateien', 'schalter', 'befehl', 'ergebnis', 'bericht', 'verzeichnis', 'spiegel', 'sperre',
  'schloss', 'zustand', 'erfahrung', 'entscheidung', 'gedaechtnis', 'nutzung', 'sitzung', 'frage',
  'antwort', 'treffer', 'quelle', 'anzahl', 'summe', 'gesamt', 'frisch', 'schwelle', 'deckel',
  'gruen', 'wege', 'pfad', 'gruppe', 'jetzt', 'gestern', 'woche', 'nachricht', 'absender',
  'empfaenger', 'abruf', 'einblendung', 'vorschlag', 'urteil', 'grund', 'aenderung', 'bauteil',
  'hilfe', 'pflicht', 'verfahren', 'lernen', 'kette', 'riegel', 'daten', 'rueckgabe', 'ausgabe',
  'eingabe', 'rumpf', 'koerper', 'inhalt', 'zwischen', 'merken', 'merke', 'gemerkt', 'gefunden',
  'gefundene', 'geschrieben', 'gelesen', 'offen', 'geschlossen', 'erledigt', 'verworfen', 'gueltig',
  'ungueltig', 'vorher', 'nachher', 'abstand', 'schlag', 'stamm', 'staemme', 'wort', 'woerter',
  'nutzer', 'mensch', 'erlaubnis', 'freigabe', 'zahlen',
  // Added 2026-10-01 from the English pass's inventory (each was a real
  // identifier or file name here before it was renamed):
  'ohne', 'welt', 'voll', 'leer', 'eins', 'zwei', 'drei', 'alle', 'alles', 'nichts', 'nicht',
  'echt', 'echter', 'eigen', 'eigene', 'fremd', 'ziel', 'lauf', 'soll', 'drin', 'draussen',
  'kommentar', 'kommentare', 'erwartet', 'fehlt', 'fehlend', 'fehlen', 'gesehen', 'behauptet',
  'behauptungen', 'damals', 'geprueft', 'pruefung', 'aufgeloest', 'kaputt', 'tabelle', 'schritt',
  'schritte', 'kandidat', 'kandidaten', 'herkunft', 'aussen', 'innen', 'bereich', 'bereiche',
  'letzte', 'naechste', 'spanne', 'teile', 'genannt', 'getroffen', 'regel', 'geheim', 'erzeugt',
  'oberflaeche', 'sammle', 'markierte', 'ausnahmen', 'dokumente', 'faktor', 'falsch', 'toleranz',
  'vorgabe', 'helfer', 'skripte', 'aufrufe', 'aufrufer', 'schuldig', 'bleibt', 'faelle', 'getarnt',
  'gleich', 'genau', 'zweiter', 'dritter', 'bauen', 'quatsch', 'kinder', 'versuche', 'ruhig',
  'grenzen', 'fakten', 'messgeraete', 'doku', 'sprache', 'kontext', 'kalt', 'paket', 'eingefroren',
  'zustandslos', 'unser', 'entrutscht', 'feld', 'felder', 'warum', 'befund', 'luecke', 'paritaet',
  'heute', 'wert', 'kopf', 'tiefe', 'ebene', 'pfeil', 'zeig', 'seit', 'teil', 'roh', 'neu',
]));
