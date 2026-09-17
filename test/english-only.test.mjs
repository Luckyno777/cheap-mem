// cheap-mem is the English-facing product; a German comment in it is
// debt that gets paid once, partially, and comes back. Measured
// 2026-09-17: 298 German comment lines across 28 files in src/, bin/
// and test/, the largest single offender being src/retrieval.mjs at
// 118. This probe is what keeps that count at zero going forward.
//
// **How it decides a line is German.** For every comment line found
// while walking src/, bin/ and test/, count how many DISTINCT words on
// the DICTIONARY below appear. A line is flagged only at two or more.
// One alone is not enough: "die" is also English slang, "man" and
// "sein" are English words too ("one must", a person's own), and a
// one-word trigger made an earlier version of this check noisy enough
// that it would have been ignored. Two distinct German function words
// on the same line is not a coincidence in an English sentence.
//
// **What this heuristic deliberately does NOT catch:**
//   - a German word alone, or repeated (two occurrences of the SAME
//     word do not count as two — "a probe that finds a name is not a
//     probe that finds a behaviour" must not flag on "probe" twice);
//   - German content that lives in DATA, not prose — the synonym word
//     lists in src/thesaurus.mjs hold German words on purpose, so a
//     memory written in German can be searched too. They are string
//     literals, not comment lines, and this probe never reads code;
//   - the `// invariant: <slug>` / `// invariante: <slug>` marker line
//     shape from bench/invariants.mjs. The id after the colon is a
//     cross-house contract with `shared/invariants.jsonl`, and its
//     slug is deliberately renderable in EITHER house's language (see
//     docs/invariants.md: "the id is the contract between the houses;
//     the word in front of it is not"). Renaming the slug would break
//     that catalogue for reasons that have nothing to do with English
//     wording, so this probe reuses the project's own NEARLY_MARKER
//     pattern to recognise and skip exactly that one shape;
//   - one verbatim quotation, named explicitly below rather than
//     matched by a pattern, because inventing a general "this comment
//     quotes something" rule would be a heuristic guessing at intent,
//     the exact failure mode `docs/deliberately-not-built.md` warns
//     against for this kind of problem. On 2026-09-16 a benchmark run
//     leaked the operator's own memory into three answers, and
//     test/eval-kontext-riegel.test.mjs quotes what the model actually
//     said, in the language it actually said it in, as the evidence
//     for the incident. Translating the quote would misrepresent what
//     was found;
//   - a comment inside a file this probe cannot decide is text (a
//     binary asset, should one ever land in these three directories);
//   - anything outside src/, bin/ and test/ — docs/, bench/ and
//     shared/invariants.jsonl are not in this product's traced scope.
//
// **Comment extraction is line-based and does not parse the language.**
// `//` and `#` start a comment to the end of the line; `/* ... */`
// comments are tracked across lines so a CSS-style block whose
// continuation lines carry no leading `*` is still read in full — an
// earlier, cruder version of this same idea (used only to VERIFY this
// translation pass, never committed) missed exactly those continuation
// lines. Neither this nor the line-based extraction understands string
// literals, so a `//` or `#` inside a string is read as a comment
// start. That is a known source of false negatives (a German word
// after such a false start is never reached) and, in principle, false
// positives; none turned up in this repository's own text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEARLY_MARKER } from '../bench/invariants.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCAN_DIRS = ['src', 'bin', 'test'];

// The one verbatim quotation this probe must not flag. Named by its
// exact text rather than matched by a pattern — see the file header for
// why. If this line ever changes or the incident is rewritten, this
// allowance should be revisited alongside it, not silently widened.
const KNOWN_VERBATIM_QUOTES = Object.freeze([
  '"Die FAKTEN-KRITISCH-Notiz erwähnt die Container `claude`,',
  '`diggi-tunnel`, `omniroute` […] die vollständige Datei unter',
]);

// The required dictionary from the task, plus real German function
// words this translation pass actually found causing false negatives
// (a word missing from the list simply cannot be caught). Deliberately
// excludes two words that are genuine German/English homographs and
// produced false positives during calibration against this repo's own
// English comments: "was" (past tense of "is") and "so". Leaving them
// out means a line using ONLY those plus one real German word still
// needs a second real German word to flag — which is the point of the
// two-word threshold in the first place.
const GERMAN_WORDS = Object.freeze([
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
const GERMAN_WORD_SET = new Set(GERMAN_WORDS);

function listFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { listFiles(full, out); continue; }
    // The extensions actually in use across src/, bin/ and test/, plus
    // the extensionless CLI scripts under bin/ (bin/mem, bin/mem-mcp,
    // and the shell hooks) — a hardcoded extension list would silently
    // stop covering a new shell hook the day someone adds one without
    // a suffix, so "no dot in the name" is treated the same as a match.
    if (/\.(mjs|js|sh|ps1)$/.test(entry.name) || !entry.name.includes('.')) out.push(full);
  }
}

/**
 * Comment lines of one file, as { line, number } pairs.
 *
 * Line-based and language-blind — see the file header for the tradeoffs
 * this accepts.
 */
function commentLines(text) {
  const out = [];
  let inBlock = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (inBlock) {
      const close = raw.indexOf('*/');
      if (close === -1) { out.push({ number: i + 1, raw, text: raw }); continue; }
      out.push({ number: i + 1, raw, text: raw.slice(0, close) });
      inBlock = false;
      continue;
    }
    const lineComment = raw.indexOf('//');
    const hashComment = raw.indexOf('#');
    const blockStart = raw.indexOf('/*');
    // Earliest marker wins; -1 (not found) must lose that race, not win it.
    const candidates = [lineComment, hashComment, blockStart]
      .map((n) => (n === -1 ? Infinity : n));
    const earliest = Math.min(...candidates);
    if (!Number.isFinite(earliest)) continue;
    if (earliest === blockStart) {
      const close = raw.indexOf('*/', blockStart + 2);
      if (close === -1) { out.push({ number: i + 1, raw, text: raw.slice(blockStart + 2) }); inBlock = true; }
      else out.push({ number: i + 1, raw, text: raw.slice(blockStart + 2, close) });
    } else if (earliest === lineComment) {
      out.push({ number: i + 1, raw, text: raw.slice(lineComment + 2) });
    } else {
      out.push({ number: i + 1, raw, text: raw.slice(hashComment + 1) });
    }
  }
  return out;
}

/** Distinct dictionary words a comment line's own text carries. */
function germanHits(text) {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  const found = new Set();
  for (const w of words) if (GERMAN_WORD_SET.has(w)) found.add(w);
  return [...found];
}

function scanRepo() {
  const files = [];
  for (const d of SCAN_DIRS) listFiles(path.join(REPO, d), files);
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(REPO, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const { number, raw, text: lineText } of commentLines(text)) {
      const trimmed = lineText.trim();
      if (!trimmed) continue;
      if (NEARLY_MARKER.test(raw)) continue;
      if (KNOWN_VERBATIM_QUOTES.some((q) => lineText.includes(q))) continue;
      const hits = germanHits(lineText);
      if (hits.length >= 2) offenders.push({ file: rel, number, hits, text: trimmed });
    }
  }
  return { files, offenders };
}

test('POSITIVE: the scan really walks a meaningful number of files', () => {
  // A probe run against an empty directory always passes and measures
  // nothing — house rule: leeres Bestehen ist Durchfallen. 197 files were
  // counted in src/+bin/+test/ on 2026-09-17 (178 .mjs, 5 .ps1, 3 .sh, 11
  // extensionless bin/ scripts); 40 is a floor well below that, chosen so
  // a future reorganisation has room without this assertion needing to
  // move with it.
  const { files } = scanRepo();
  assert.ok(files.length >= 40,
    `only ${files.length} files were scanned in src/, bin/, test/ — `
    + 'this is an empty-scan false pass, not a clean codebase');
});

test('no comment line in src/, bin/ or test/ carries two or more German words', () => {
  const { offenders } = scanRepo();
  const report = offenders
    .map((o) => `  ${o.file}:${o.number}  [${o.hits.join(', ')}]  ${o.text}`)
    .join('\n');
  assert.deepEqual(offenders.map((o) => `${o.file}:${o.number}`), [],
    `${offenders.length} comment line(s) still read as German:\n${report}`);
});
