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
