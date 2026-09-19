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
//   - anything outside src/, bin/, test/ and bench/ — docs/ and
//     shared/invariants.jsonl are not in this product's traced scope.
//
// **bench/ was added on 2026-09-19, and the reason is a scope change,
// not a change of mind.** On 2026-09-17 leaving it out was right: the
// benchmarks were an internal instrument. Then the README was rebuilt
// as a shop window for strangers and companies, and it invites the
// reader, by name, to run `npm run verify` and `node bench/mutation.mjs`
// — so eight benchmark files started printing German at people the
// README was written to convince. A scope that was correct became
// wrong because what it excluded became public.
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
const SCAN_DIRS = ['src', 'bin', 'test', 'bench'];

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

// **Built from parts, and that is the whole point.** This extractor is
// line-based and does not parse the language, so a marker inside a
// STRING literal reads to it as a real comment opener. Written plainly,
// the two lines below that mention the block markers would open a
// comment this file never closes — and every line after them, to the end
// of the file, would be scanned as comment text. That is not theory: on
// 2026-09-19 it flagged this file's own positive control, a deliberately
// German string sitting 120 lines further down, and the header above
// still said "none turned up in this repository's own text".
//
// bench/redteam.mjs assembles a secret from parts so the pre-commit hook
// does not catch the file that tests the pre-commit hook. Same idiom,
// same reason: an instrument must not trip over its own description.
/**
 * Does this file's language have block comments at all?
 *
 * Shell and PowerShell do not. The extension answers for most files; for
 * the extensionless scripts under bin/ the SHEBANG answers, because they
 * are a mix — `bin/mem`, `bin/mem-mcp` and `bin/mem-serve` are node,
 * while `bin/mem-capture` and its siblings are bash. A first draft of
 * this function guessed "no dot means shell" and would have switched
 * block comments off for the three largest JavaScript files in bin/,
 * quietly, for a reason having nothing to do with their language. The
 * file states what it is on its first line; that is not a guess.
 */
function hasBlocks(file, text) {
  const name = path.basename(file);
  // `.ps1` is why this line is not redundant: PowerShell scripts in this
  // repo carry no shebang, so the check below cannot speak for them.
  // Measured 2026-09-19: deleting this line leaves every probe green
  // (the shebang catches the bash scripts), deleting the shebang branch
  // turns one red. So the `.sh` half is belt to the shebang's braces,
  // and the `.ps1` half is the only thing standing — untested today,
  // because no PowerShell file here happens to contain the sequence.
  if (/\.(sh|ps1)$/.test(name)) return false;
  if (/\.(mjs|js)$/.test(name)) return true;
  const shebang = text.slice(0, text.indexOf('\n') + 1 || 200);
  if (/^#!.*\b(bash|sh|zsh)\b/.test(shebang)) return false;
  if (/^#!.*\bnode\b/.test(shebang)) return true;
  return true;   // unknown: assume blocks, so nothing is silently skipped
}

const BLOCK_OPEN = '/' + '*';
const BLOCK_CLOSE = '*' + '/';

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
 *
 * `blocks` is false for shell and PowerShell, where the block markers do
 * not exist and the sequence means something else entirely. Found on
 * 2026-09-19 in `bin/mem-before-edit`, whose `case` statement carries a
 * `/` glob branch: read as a comment opener, it blinded the scan for the
 * whole rest of that file. The extractor does not parse the language,
 * but it can at least know which language it is not looking at.
 */
function commentLines(text, blocks = true) {
  const out = [];
  let inBlock = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (inBlock) {
      const close = raw.indexOf(BLOCK_CLOSE);
      if (close === -1) { out.push({ number: i + 1, raw, text: raw }); continue; }
      out.push({ number: i + 1, raw, text: raw.slice(0, close) });
      inBlock = false;
      continue;
    }
    const lineComment = raw.indexOf('//');
    const hashComment = raw.indexOf('#');
    const blockStart = blocks ? raw.indexOf(BLOCK_OPEN) : -1;
    // Earliest marker wins; -1 (not found) must lose that race, not win it.
    const candidates = [lineComment, hashComment, blockStart]
      .map((n) => (n === -1 ? Infinity : n));
    const earliest = Math.min(...candidates);
    if (!Number.isFinite(earliest)) continue;
    if (earliest === blockStart) {
      const close = raw.indexOf(BLOCK_CLOSE, blockStart + 2);
      if (close === -1) { out.push({ number: i + 1, raw, text: raw.slice(blockStart + 2) }); inBlock = true; }
      else out.push({ number: i + 1, raw, text: raw.slice(blockStart + 2, close) });
    } else if (earliest === lineComment) {
      out.push({ number: i + 1, raw, text: raw.slice(lineComment + 2) });
    } else {
      out.push({ number: i + 1, raw, text: raw.slice(hashComment + 1) });
    }
  }
  out.unterminated = inBlock;
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
    for (const { number, raw, text: lineText } of commentLines(text, hasBlocks(file, text))) {
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
    `only ${files.length} files were scanned in src/, bin/, test/, bench/ — `
    + 'this is an empty-scan false pass, not a clean codebase');
});

test('no comment line in src/, bin/, test/ or bench/ carries two or more German words', () => {
  const { offenders } = scanRepo();
  const report = offenders
    .map((o) => `  ${o.file}:${o.number}  [${o.hits.join(', ')}]  ${o.text}`)
    .join('\n');
  assert.deepEqual(offenders.map((o) => `${o.file}:${o.number}`), [],
    `${offenders.length} comment line(s) still read as German:\n${report}`);
});

// --- What the stranger actually reads ---------------------------------
//
// The probe above never reads code — deliberately, because
// `src/thesaurus.mjs` holds German words as DATA on purpose. That
// carve-out has a cost, and on 2026-09-19 the bill came: every German
// comment in bench/ was gone and `npm run verify` still printed
// "erwartet / gehalten / kaputt", because those live in string
// literals. A guard that reads only the parts nobody runs cannot see
// the part everybody runs.
//
// So this second probe reads the NON-comment lines of bench/, where the
// console output lives. Same dictionary, same two-word threshold —
// calibrated on 2026-09-19 against every bench file, where it produced
// exactly two hits, both of them the deliberate bilingual stop list
// below, and no false positive on an English code line.
//
// Why bench/ and not src/: the product's own output is English already
// and is covered by its own tests; the German that is left in this repo
// is data (thesaurus word groups, bilingual stop lists, both-houses
// directory names), and telling data from prose inside src/ would need
// the guessing-at-intent heuristic `docs/deliberately-not-built.md`
// warns against. bench/ has exactly one such piece of data, and it is
// named here rather than pattern-matched, for that same reason.
const KNOWN_GERMAN_DATA = Object.freeze([
  // bench/duplicate-rate.mjs: a stop list that is bilingual on purpose,
  // so a German memory can be measured for near-duplicates too. Same
  // rationale as the thesaurus word groups.
  "const STOP = new Set(('der die das und oder ein eine einen dem den des ist sind war waren ",
  "+ 'nicht auch noch nur schon dass wie wenn aber im in an auf fuer von zu mit bei aus ",
]);

function scanBenchOutput() {
  const dir = path.join(REPO, 'bench');
  const offenders = [];
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs'));
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    text.split('\n').forEach((raw, i) => {
      const trimmed = raw.trim();
      // Comment lines belong to the probe above; here only what runs.
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')
        || trimmed.startsWith(BLOCK_OPEN)) return;
      if (KNOWN_GERMAN_DATA.some((q) => raw.includes(q))) return;
      const hits = germanHits(raw);
      if (hits.length >= 2) {
        offenders.push({ file: `bench/${name}`, number: i + 1, hits, text: trimmed });
      }
    });
  }
  return { files, offenders };
}

test('POSITIVE: the bench scan walks files and the dictionary still bites', () => {
  // Two ways this probe could pass while measuring nothing: an empty
  // file list, or a dictionary that no longer matches German. Both are
  // checked, the second by feeding it a German line that is not in the
  // repo at all.
  const { files } = scanBenchOutput();
  assert.ok(files.length >= 15, `only ${files.length} bench files scanned — empty-scan false pass`);
  const probe = germanHits("console.log('erwartet: der Eintrag ist nicht gemessen');");
  assert.ok(probe.length >= 2,
    `the dictionary finds only ${probe.length} German word(s) in an obviously German line`);
});

test('no bench output line carries two or more German words', () => {
  // The line a company sees when it runs the command the README names.
  const { offenders } = scanBenchOutput();
  const report = offenders
    .map((o) => `  ${o.file}:${o.number}  [${o.hits.join(', ')}]  ${o.text}`)
    .join('\n');
  assert.deepEqual(offenders.map((o) => `${o.file}:${o.number}`), [],
    `${offenders.length} bench line(s) print German at the reader:\n${report}`);
});

test('no scanned file ends inside an unterminated block comment', () => {
  // The failure mode that hid above, made loud. If the extractor reaches
  // the end of a file still believing it is inside a block comment, it
  // has mistaken something — almost always a marker inside a string —
  // for a comment opener, and it has been reading CODE as prose ever
  // since. Silently, that only shows up as a mystifying German hit on a
  // line that is plainly not a comment. Named, it shows up as this.
  const files = [];
  for (const d of SCAN_DIRS) listFiles(path.join(REPO, d), files);
  const bad = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = commentLines(text, hasBlocks(file, text));
    if (lines.unterminated) bad.push(path.relative(REPO, file));
  }
  assert.deepEqual(bad, [],
    `the comment extractor never leaves a block comment in: ${bad.join(', ')}. `
    + `It is reading code as comment text from that point to the end of the file. `
    + `Usually a ${BLOCK_OPEN} inside a string literal — build it from parts.`);
});

// --- Does the PRODUCT'S OWN CODE carry German, not just its comments? -
//
// The first probe above never reads code, on purpose: `src/thesaurus.mjs`
// holds German synonym words as DATA. `scanBenchOutput` closed the same
// gap for bench/ output; this closes it for src/ and bin/ — the
// identifiers and string literals a stranger actually runs, which
// nobody proofreads the way they proofread a sentence.
//
// Same dictionary, same two-word threshold. Comments are stripped with
// `codeLines`, built from the SAME state machine as `commentLines`
// above — not `scanBenchOutput`'s plainer `startsWith('//'|'*'|'/*')`
// check. That plainer check would misread this house: src/ and bin/
// carry heavy JSDoc blocks whose continuation lines do not start with
// `*` (confirmed 2026-09-19 in src/astra.mjs and src/viewer.mjs, ~60
// lines of ordinary design-rationale prose). Read as code by mistake,
// those lines would be re-scanned for German the comment probe above
// already cleared them of — an "innocent reported" false positive
// waiting to happen the day one of them picks up a second word this
// dictionary knows. `codeLines` tracks the same block state and hands
// back only the text before/after/outside a comment on each line.
//
// **Measured 2026-09-19 against src/+bin/ (93 files): eleven lines.**
// Nine are the bilingual stop-word lists this file already explains are
// DATA: src/language.mjs:39-45 (DE_STOP) and src/search.mjs:1367-1368.
// A tenth is the same kind of DATA one level down: src/thesaurus.mjs:108,
// one German synonym quartet for "because/reason", in the very file the
// header above names as holding German word groups on purpose, so a
// memory written in German stays searchable. All ten are named below,
// verbatim and by substring rather than file-and-line — same idiom as
// `KNOWN_GERMAN_DATA` above — so a later reflow does not silently stop
// covering them; a companion test checks that each one still matches
// something real.
//
// The eleventh is not data and not German: src/cli/commands/write.mjs:124
// checks a guard-check result and calls this file's fatal-exit helper.
// Both of those two ordinary English names happen to sit on GERMAN_WORDS
// too, for unrelated reasons of the dictionary's own — one was added
// there for German prose using the same spelling, the other is a
// definite article. Renaming an established, correctly-English name to
// dodge a dictionary collision would be solving the probe's problem in
// the product's vocabulary, so it is named as a false positive instead
// — exactly the way `KNOWN_VERBATIM_QUOTES` above excuses one exact
// quotation rather than inventing a pattern for "sentences that quote
// something".
//
// **A claim measured here, and found short.** Commit 2378a6a said, of
// this exact count: "Re-measured: nine lines left in src/ and bin/, all
// nine the stop lists, no prose." That was one DATA line short (it
// missed src/thesaurus.mjs:108, present in the tree at that commit
// already) before even counting the write.mjs false positive. Re-stated
// here rather than quietly matched, because a guard that repeats an
// unverified count is the exact failure this file's own house rule —
// "Prüfe nach... miss selbst" — exists to catch.
const KNOWN_SRC_GERMAN_DATA = Object.freeze([
  // src/language.mjs: DE_STOP, the German half of the bilingual
  // tokenizer stopword pack.
  "'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem',",
  "'einer', 'eines', 'und', 'oder', 'aber', 'ist', 'sind', 'war', 'waren',",
  "'wird', 'werden', 'wurde', 'wurden', 'hat', 'haben', 'hatte', 'hatten',",
  "'sein', 'seine', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'nicht',",
  "'kein', 'keine', 'mit', 'von', 'zu', 'zum', 'zur', 'auf', 'in', 'im',",
  "'an', 'am', 'fuer', 'für', 'bei', 'aus', 'nach', 'ueber', 'über', 'als',",
  "'wie', 'wenn', 'dass', 'da', 'so', 'auch', 'noch', 'nur', 'schon',",
  // src/search.mjs: the same bilingual stop list, second copy, for the
  // content-word filter used at query time.
  "'der', 'die', 'das', 'und', 'ist', 'nicht', 'auch', 'noch', 'aber', 'wir',",
  "'ich', 'mit', 'ein', 'eine', 'dass', 'wie', 'was', 'schon', 'nur', 'mal',",
  // src/thesaurus.mjs: one German synonym group among many.
  "'weil', 'grund', 'begruendung', 'warum'],",
]);

// Named, singular, and explained above rather than pattern-matched — a
// dictionary collision on real English identifiers, not German.
const KNOWN_SRC_FALSE_POSITIVES = Object.freeze([
  "if (probe.state === 'broken') die(`log: the latch is no good",
]);

/**
 * Non-comment text of one file, as { number, raw, code } per line.
 *
 * Mirrors `commentLines`'s block-comment state machine so the two never
 * disagree about which lines are comments — `code` is what is left once
 * every `//`, `#` and `/* ... *&#47;` span (including one that opens and
 * closes within the same line) is removed.
 */
function codeLines(text, blocks = true) {
  const out = [];
  let inBlock = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    let code = '';
    let pos = 0;
    for (;;) {
      if (inBlock) {
        const close = raw.indexOf(BLOCK_CLOSE, pos);
        if (close === -1) break;
        inBlock = false;
        pos = close + 2;
        continue;
      }
      const rest = raw.slice(pos);
      const lineComment = rest.indexOf('//');
      const hashComment = rest.indexOf('#');
      const blockStart = blocks ? rest.indexOf(BLOCK_OPEN) : -1;
      const candidates = [lineComment, hashComment, blockStart]
        .map((n) => (n === -1 ? Infinity : n));
      const earliest = Math.min(...candidates);
      if (!Number.isFinite(earliest)) { code += rest; break; }
      code += rest.slice(0, earliest);
      if (earliest === blockStart) { inBlock = true; pos += earliest + 2; continue; }
      break; // // or # runs to the end of the line
    }
    out.push({ number: i + 1, raw, code });
  }
  out.unterminated = inBlock;
  return out;
}

function scanSrcOutput() {
  const files = [];
  for (const d of ['src', 'bin']) listFiles(path.join(REPO, d), files);
  const offenders = [];
  const unterminated = [];
  for (const file of files) {
    const rel = path.relative(REPO, file);
    const text = fs.readFileSync(file, 'utf8');
    const lines = codeLines(text, hasBlocks(file, text));
    if (lines.unterminated) unterminated.push(rel);
    for (const { number, raw, code } of lines) {
      const trimmed = code.trim();
      if (!trimmed) continue;
      if (KNOWN_SRC_GERMAN_DATA.some((q) => raw.includes(q))) continue;
      if (KNOWN_SRC_FALSE_POSITIVES.some((q) => raw.includes(q))) continue;
      const hits = germanHits(code);
      if (hits.length >= 2) offenders.push({ file: rel, number, hits, text: trimmed });
    }
  }
  return { files, offenders, unterminated };
}

test('POSITIVE: the src/bin code scan walks files and the dictionary still bites', () => {
  const { files } = scanSrcOutput();
  assert.ok(files.length >= 40, `only ${files.length} src/bin files scanned — empty-scan false pass`);
  const probeHits = germanHits("const antwort = 'der Eintrag ist nicht gemessen';");
  assert.ok(probeHits.length >= 2,
    `the dictionary finds only ${probeHits.length} German word(s) in an obviously German line`);
});

test('every named src/bin exception still matches a real line', () => {
  // The gegenprobe for the exception list itself. A line can move, be
  // reworded or be deleted; a substring exception that no longer matches
  // anything is not "safely unused" — it is silent cover for whatever
  // that same text would flag if it reappeared verbatim somewhere else,
  // and it is a sign the count above ("eleven") is no longer measured,
  // only remembered.
  const files = [];
  for (const d of ['src', 'bin']) listFiles(path.join(REPO, d), files);
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'));
  const stale = [...KNOWN_SRC_GERMAN_DATA, ...KNOWN_SRC_FALSE_POSITIVES]
    .filter((q) => !texts.some((t) => t.includes(q)));
  assert.deepEqual(stale, [],
    `named src/bin exception(s) match nothing any more, re-measure and update them:\n`
    + stale.map((q) => `  ${JSON.stringify(q)}`).join('\n'));
});

test('no src/ or bin/ line outside comments carries two or more German words, unless it is named DATA', () => {
  // The identifiers and strings a stranger who clones this repo actually
  // runs, as opposed to the prose the two probes above already cover.
  const { offenders } = scanSrcOutput();
  const report = offenders
    .map((o) => `  ${o.file}:${o.number}  [${o.hits.join(', ')}]  ${o.text}`)
    .join('\n');
  assert.deepEqual(offenders.map((o) => `${o.file}:${o.number}`), [],
    `${offenders.length} src/bin code line(s) carry German outside the named exceptions:\n${report}`);
});

test('no src/ or bin/ file ends inside an unterminated block comment (code scan)', () => {
  // Same failure mode as the comment-probe's own version of this check,
  // for `codeLines` instead of `commentLines`: an unterminated block
  // comment usually means a `/*`-like sequence inside a string fooled
  // the extractor, and everything after it in the file was read as the
  // wrong thing from that point on.
  const { unterminated } = scanSrcOutput();
  assert.deepEqual(unterminated, [],
    `codeLines never leaves a block comment open in: ${unterminated.join(', ')}`);
});
