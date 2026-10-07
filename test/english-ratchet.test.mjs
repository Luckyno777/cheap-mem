// test/english-ratchet.test.mjs — a ratchet on the number Lucky measured
// on 2026-09-26, and decided about that same day: cheap-mem is the
// THROUGHOUT-English open-source sister product to lucky-mem — docs,
// file names, identifiers, output, eval/, not just src/bin/test/bench
// comments. Measured with the guard's own dictionary and threshold
// (test/english-dictionary.mjs) over EVERY LINE of EVERY tracked text
// file: thousands of German lines, in dozens of files, almost none of
// them under `test/english-only.test.mjs`'s traced scope.
//
// **Why a second probe and not a wider version of the first.**
// `test/english-only.test.mjs` answers "does src/, bin/, test/ or
// bench/ leak German at a stranger" — a narrower, harder-edged question
// with its own file-specific exception lists (KNOWN_SRC_GERMAN_DATA and
// friends) that make sense only for code and comments. Widening it to
// docs/, eval/ and the repo root would mean bolting a second, unrelated
// purpose onto a file that already carries five kinds of exception.
// This file has exactly one job: make the wider number, once measured,
// only go DOWN.
//
// **A ratchet, not a fresh zero-tolerance guard.** 2406 German lines
// were not going to become zero in one sitting, and a guard that
// demands that either never ships or ships disabled. So: freeze
// today's count PER FILE as a ceiling in test/english-ratchet.json, and
// fail only on REGRESSION — a file that grows past its ceiling, or a
// file with German lines that carries no ceiling at all (a new
// offender, never seen before). A file that improves is rewarded with a
// printed hint to lower its ceiling, never a failure — see
// `docs/deliberately-not-built.md`'s reasoning against a guard that
// punishes the fix along with the break.
//
// **One dictionary, one threshold, one quote list — imported, not
// copied.** test/english-dictionary.mjs holds GERMAN_WORDS, the
// two-distinct-word threshold (`germanHits`), the backtick-stripping
// rule (`asProse`) and the verbatim-quote allowance
// (`KNOWN_VERBATIM_QUOTES`). Both this file and test/english-only.test.mjs
// import it, so the two probes can never quietly recognise German
// differently.
//
// **Named exemptions, not a skipped directory.** A handful of files
// hold German as DATA on purpose (a stop-word list, a synonym group, a
// cross-house contract file shared byte-for-byte with lucky-mem, this
// probe's own dictionary) or as a MEASUREMENT RECORD that translation
// would falsify. Each is named below with its own reason in
// test/english-ratchet.json, not swept aside by excluding eval/ or
// docs/ wholesale — everything else in those directories still owes a
// ceiling.
//
// **File names are in scope too.** Lucky's decision covers identifiers
// as much as prose. A short, explicit list of German filename-words is
// checked against every tracked path; today's offenders are named in
// the JSON's `filenameAllowlist`, each with the reason "to be renamed
// in B6/B4" — a decision, not a blind spot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { germanHits, asProse, KNOWN_VERBATIM_QUOTES, GERMAN_IDENTIFIER_WORDS } from './english-dictionary.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RATCHET = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'english-ratchet.json'), 'utf8'));

/** Every file `git` currently tracks, repo-relative, forward-slashed. */
function trackedFiles() {
  const out = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

// Extensions this probe already knows are binary and never worth
// decoding as text. Belt: a NUL-byte sniff below catches any binary
// type not on this list, so a new image or font format added later
// does not need this list updated to stay safe — only to stay fast.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tif', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.gz', '.wasm',
]);

/**
 * Is this tracked file binary?
 *
 * Extension first (fast, and covers files whose bytes alone would not
 * say so — a well-formed tiny PNG can look like plausible-ish bytes).
 * Falling back to a NUL-byte sniff over the first 8000 bytes: text
 * files, in any encoding this repo uses, never carry a NUL; binary
 * formats not on BINARY_EXT above generally do within that range.
 */
function isBinary(rel, buf) {
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) return true;
  return buf.subarray(0, 8000).includes(0);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `rel` match a ceiling/exemption `pattern`?
 *
 * A pattern with no `*` must equal `rel` exactly — the common case, and
 * the one that cannot silently widen. A pattern with `*` treats it as
 * "anything but a `/`", the same one glob shape the task allows
 * (`eval/runs/*.jsonl`) and no more: it cannot cross a directory
 * boundary, so a single entry never turns into a skipped subtree.
 */
function matchesPattern(pattern, rel) {
  if (!pattern.includes('*')) return pattern === rel;
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`);
  return re.test(rel);
}

function isExempt(rel) {
  return RATCHET.exemptions.some((e) => matchesPattern(e.pattern, rel));
}

/** German-flagged lines of one file's text, same rule as the dictionary's callers. */
// A shared invariant id (shared/invariants.jsonl "id", and the
// `invariant: <id>` marker a test carries) is a cross-house KEY that
// must stay byte-equal with lucky-mem, not prose — the same rule
// germanCommentWords() already applies to `invariant:` comments. The id
// token is blanked before measuring; the rest of the line still counts.
const INVARIANT_ID_MARK = /invariant:\s*[a-z0-9]+(?:-[a-z0-9]+)+/g;
const INVARIANT_ID_FIELD = /"id":\s*"[a-z0-9]+(?:-[a-z0-9]+)+"/g;
export function withoutInvariantIds(raw, rel = '') {
  let s = raw.replace(INVARIANT_ID_MARK, 'invariant:');
  if (rel === 'shared/invariants.jsonl') s = s.replace(INVARIANT_ID_FIELD, '"id": ""');
  return s;
}

function germanLinesOf(text, rel = '') {
  const offenders = [];
  text.split('\n').forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (KNOWN_VERBATIM_QUOTES.some((q) => raw.includes(q))) return;
    const hits = germanHits(asProse(withoutInvariantIds(raw, rel)));
    if (hits.length >= 2) offenders.push({ number: i + 1, hits, text: trimmed });
  });
  return offenders;
}

/**
 * Walk every tracked file once. Returns the full tracked list (for the
 * filename check, which must see binaries too), the German-flagged
 * lines per text file, and which files were treated as binary.
 */
function scan() {
  const files = trackedFiles();
  const perFile = new Map();
  const skippedBinary = [];
  for (const rel of files) {
    const full = path.join(REPO, rel);
    let buf;
    try { buf = fs.readFileSync(full); } catch { continue; }
    if (isBinary(rel, buf)) { skippedBinary.push(rel); continue; }
    const offenders = germanLinesOf(buf.toString('utf8'), rel);
    if (offenders.length) perFile.set(rel, offenders);
  }
  return { files, perFile, skippedBinary };
}

test('POSITIVE: the ratchet walks a meaningful number of tracked files', () => {
  // House rule: an empty pass is a failure — an empty walk passes
  // and proves nothing. 431 files were tracked on 2026-09-26; 300 is a
  // floor with room for this repo to shrink without this test needing
  // to move with it.
  const { files } = scan();
  assert.ok(files.length >= 300,
    `only ${files.length} tracked files were walked — this is an empty-scan false pass, not a clean repo`);
});

test('POSITIVE: binary detection skips a small, non-zero, expected set of files', () => {
  // Two failure modes, both silent otherwise: detection skips NOTHING
  // (a PNG gets decoded as UTF-8 text and either crashes or, worse,
  // quietly never flags because its bytes never form two dictionary
  // words) or detection skips TOO MUCH (a real text file goes
  // unscanned and its German goes unmeasured). 10 image files were
  // binary-skipped on 2026-09-26; the band below catches either
  // direction while leaving room for a handful more images.
  const { skippedBinary } = scan();
  assert.ok(skippedBinary.length >= 5 && skippedBinary.length <= 30,
    `expected roughly 5-30 binary-skipped files, got ${skippedBinary.length}: ${skippedBinary.join(', ')}`);
});

test('every named exemption still matches at least one tracked file', () => {
  // The same gegenprobe test/english-only.test.mjs runs for its own
  // named exceptions: a pattern that matches nothing is not "safely
  // unused", it is a reason nobody can check any more.
  const { files } = scan();
  const stale = RATCHET.exemptions.filter((e) => !files.some((f) => matchesPattern(e.pattern, f)));
  assert.deepEqual(stale, [],
    `exemption pattern(s) match no tracked file, re-measure or remove them:\n`
    + stale.map((e) => `  ${JSON.stringify(e.pattern)} (${e.reason})`).join('\n'));
});

test('every ceiling in test/english-ratchet.json still names a tracked file', () => {
  // A ceiling for a file that was renamed or deleted is not a passing
  // ceiling, it is an entry nobody is checking any more — the same
  // staleness the exemption gegenprobe above catches, for the other list.
  const { files } = scan();
  const trackedSet = new Set(files);
  const stale = Object.keys(RATCHET.ceilings).filter((rel) => !trackedSet.has(rel));
  assert.deepEqual(stale, [],
    `ceiling entry/entries name file(s) no longer tracked, update test/english-ratchet.json:\n`
    + stale.map((rel) => `  ${rel}`).join('\n'));
});

test('no file exceeds its English-ratchet ceiling, and no un-ceilinged file carries German', () => {
  const { perFile } = scan();
  const { ceilings } = RATCHET;
  const failures = [];
  const hints = [];
  for (const [rel, offenders] of perFile) {
    if (isExempt(rel)) continue;
    const count = offenders.length;
    const ceiling = ceilings[rel];
    if (ceiling === undefined) {
      const sample = offenders.slice(0, 3).map((o) => `${o.number}: ${o.text}`).join(' | ');
      failures.push(`${rel}: ${count} German line(s), no ceiling in test/english-ratchet.json (new offender) — e.g. ${sample}`);
    } else if (count > ceiling) {
      failures.push(`${rel}: ${count} German line(s) exceeds its ceiling of ${ceiling}`);
    } else if (count < ceiling) {
      hints.push(`${rel}: down to ${count} German line(s), ceiling is still ${ceiling} — lower it`);
    }
  }
  // A ceilinged file that is down to ZERO never reaches the loop above
  // (it has no offenders); without this line its ceiling would sit there
  // unnoticed, ready to absorb new German up to the old count.
  for (const rel of Object.keys(ceilings)) {
    if (!perFile.has(rel) && !isExempt(rel)) hints.push(`${rel}: down to 0 German lines, ceiling is still ${ceilings[rel]} — remove it`);
  }
  if (hints.length) {
    // Progress, not failure — see the file header. Printed so an agent
    // or Lucky can tighten test/english-ratchet.json without re-deriving
    // which files improved.
    // eslint-disable-next-line no-console
    console.log(`HINT: ${hints.length} file(s) improved past their ratchet ceiling:\n${hints.map((h) => `  ${h}`).join('\n')}`);
  }
  assert.deepEqual(failures, [], `${failures.length} file(s) violate the English ratchet:\n${failures.map((f) => `  ${f}`).join('\n')}`);
});

test('the measured total is reported', () => {
  // Always passes — this is a measurement for the report, not a check.
  // ("Report" in the sense of what a human or an agent reads back, not
  // a file this probe writes.)
  const { files, perFile } = scan();
  let total = 0;
  for (const offenders of perFile.values()) total += offenders.length;
  // eslint-disable-next-line no-console
  console.log(`English ratchet: ${total} German line(s) across ${perFile.size} of ${files.length} tracked files`);
  assert.ok(total >= 0);
});

// --- File names --------------------------------------------------------
//
// Lucky's decision (2026-09-26) names file names explicitly, not only
// prose. A short, EXPLICIT list — not the full GERMAN_WORDS dictionary,
// which would flag ordinary function-word fragments inside otherwise
// English paths and be worthless — checked as a case-insensitive
// substring against every tracked path. Substring, not a word-boundary
// match: a filename word followed by a digit (a second, third, fourth
// numbered variant of the same name) is as German as the word alone,
// and a strict boundary rule would have missed every numbered variant
// on 2026-09-26. The list itself lives in test/english-ratchet.json
// (`filenameGermanWords`), the one source for both this test and anyone
// auditing the JSON by hand.
//
// **Widened on 2026-10-01.** The explicit substring list caught only the
// words someone had thought of: `test/audit-grenzen`, `test/kalt-index-memo`
// and `test/paket-*` passed it. So a path is ALSO cut into words (at `/`,
// `.`, `-`, `_` and camelCase) and every word is looked up in
// GERMAN_IDENTIFIER_WORDS, the same unmistakable-German list the identifier
// probe uses — and an umlaut or ß anywhere in a path is German by itself.
export function filenameHits(rel) {
  const lower = rel.toLowerCase();
  const hits = new Set(RATCHET.filenameGermanWords.filter((w) => lower.includes(w)));
  for (const word of rel.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9äöüß]+/)) {
    if (GERMAN_IDENTIFIER_WORDS.has(word)) hits.add(word);
  }
  if (/[äöüß]/i.test(rel)) hits.add('umlaut/ß');
  return [...hits];
}

test('POSITIVE: a German file name is seen, whether listed, a dictionary word or an umlaut', () => {
  assert.ok(filenameHits('test/eine-sprache.test.mjs').length > 0, 'the explicit list');
  assert.ok(filenameHits('test/audit-grenzen.test.mjs').includes('grenzen'), 'a dictionary word');
  assert.ok(filenameHits('test/kalt-index-memo.test.mjs').includes('kalt'));
  assert.ok(filenameHits('docs/übersicht.md').includes('umlaut/ß'));
  assert.deepEqual(filenameHits('test/cold-index-memo.test.mjs'), []);
  assert.deepEqual(filenameHits('bench/atlas/phase-ceiling.mjs'), []);
});

test('every named filenameAllowlist entry still matches its file and its word', () => {
  const { files } = scan();
  const trackedSet = new Set(files);
  const bad = [];
  for (const entry of RATCHET.filenameAllowlist) {
    if (!trackedSet.has(entry.path)) { bad.push(`${entry.path}: no longer tracked`); continue; }
    if (filenameHits(entry.path).length === 0) bad.push(`${entry.path}: no longer matches a listed German filename-word`);
  }
  assert.deepEqual(bad, [],
    `stale filenameAllowlist entry/entries in test/english-ratchet.json:\n${bad.map((b) => `  ${b}`).join('\n')}`);
});

test('no tracked path carries a German filename-word, unless named in filenameAllowlist', () => {
  const { files } = scan();
  const allowed = new Set(RATCHET.filenameAllowlist.map((e) => e.path));
  const offenders = files.filter((f) => filenameHits(f).length > 0 && !allowed.has(f));
  assert.deepEqual(offenders, [],
    `tracked path(s) carry a German filename-word and are not in filenameAllowlist:\n`
    + offenders.map((f) => `  ${f}  [${filenameHits(f).join(', ')}]`).join('\n'));
});

// --- Single German words in comments (2026-10-01) ---------------------
//
// The line rule above needs TWO German function words, so a comment that
// slips one German word into English ("// ein Paket, nicht unser Pfad"
// has them, "// Paket: same cap as ..." does not) passes it. This check
// reads the COMMENTS of code (src/, bin/, test/, bench/, eval/, install/,
// hooks/, assets/dashboard/, .github/) and counts lines that carry a word
// from GERMAN_IDENTIFIER_WORDS standing on its own.
//
// **What is NOT a German word here, by construction:** text in backticks
// or quotes (a cited name, a quoted sentence), a word glued to `-`, `/`,
// `.` or `_` (a path, a file name, an id like `leer-ist-kein-bestehen` or
// `geteilt/befund-zuordnung.jsonl` — the sibling house's names, which
// this repo has to be able to cite), `invariant:` lines (the cross-house
// ids), and the known verbatim quotes. What is left is prose.
//
// **A ratchet like the line rule.** The 2026-10-01 pass translated what
// could be; what is left (multi-line quotations of the sibling, a German
// example input like `--as-of gestern`) is ceilinged per file in
// english-ratchet.json's `commentWordCeilings`. A file not listed must
// have none.
const CODE_DIRS = /^(src|bin|test|bench|eval|install|hooks|assets\/dashboard|\.github)\//;
const NON_CODE = /\.(png|jpe?g|ico|woff2?|tsv|json|jsonl|md|txt|svg|webp|gz|css|html|sha256)$/;
const COMMENT_EXEMPT = new Set(['test/english-dictionary.mjs', 'test/f5-german-identifiers.test.mjs', 'test/english-ratchet.test.mjs', 'test/english-only.test.mjs']);

/** Comment texts of one file, one per line that has a comment. */
export function commentLines(text, js) {
  const out = []; let inBlock = false;
  for (const l of text.split('\n')) {
    let c = '';
    if (js) {
      if (inBlock) { c = l; if (l.includes('*/')) inBlock = false; }
      else {
        const m = l.match(/^\s*(\/\/|\*|\/\*)(.*)$/);
        if (m) { c = m[2]; if (m[1] === '/*' && !l.includes('*/')) inBlock = true; }
        else { const t = l.match(/\s\/\/\s(.*)$/); if (t) c = t[1]; }
      }
    } else {
      const m = l.match(/(?:^|\s)#(?![!{])(.*)$/);
      if (m) c = m[1];
    }
    if (c) out.push(c);
  }
  return out;
}

/** German words standing on their own in one comment text. */
export function germanCommentWords(comment) {
  if (/invariant:/.test(comment) || KNOWN_VERBATIM_QUOTES.some((q) => comment.includes(q))) return [];
  const prose = comment.replace(/`[^`]*`/g, ' ').replace(/"[^"]*"|'[^']*'|„[^“]*“/g, ' ');
  const words = prose.match(/(?<![\w\-/.])[A-Za-zÄÖÜäöüß]+(?![\w\-/]|\.\w)/g) ?? [];
  return words.filter((w) => GERMAN_IDENTIFIER_WORDS.has(w.toLowerCase()));
}

function commentScan() {
  const per = {};
  for (const rel of trackedFiles()) {
    if (!CODE_DIRS.test(rel) || rel.startsWith('eval/runs/') || NON_CODE.test(rel) || COMMENT_EXEMPT.has(rel)) continue;
    let text; try { text = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    const js = /\.(mjs|js|cjs)$/.test(rel) || text.startsWith('#!/usr/bin/env node');
    const hits = commentLines(text, js).map(germanCommentWords).filter((h) => h.length);
    if (hits.length) per[rel] = hits.length;
  }
  return per;
}

test('POSITIVE: a lone German word in a comment is seen; cited names are not', () => {
  assert.deepEqual(germanCommentWords(' Paket: same cap as mem_log'), ['Paket']);
  assert.deepEqual(germanCommentWords(' a package, nicht our path'), ['nicht']);
  assert.deepEqual(germanCommentWords(' mirrors lucky-mem\'s test/kein-springen.test.mjs and `zaehler`'), []);
  assert.deepEqual(germanCommentWords(' the `zustand:gut` key and "fehler" in quotes'), []);
  assert.deepEqual(germanCommentWords(' invariant: leer-ist-kein-bestehen'), []);
  // Sabotage on a real file: one planted German word in a real source's
  // comment is counted on top of what the file had.
  const real = fs.readFileSync(path.join(REPO, 'src', 'archive.mjs'), 'utf8');
  const before = commentLines(real, true).filter((c) => germanCommentWords(c).length).length;
  const after = commentLines(`${real}\n// the ablage is checked here\n`, true).filter((c) => germanCommentWords(c).length).length;
  assert.equal(after, before + 1);
});

test('no file exceeds its comment-word ceiling, and no other file has a lone German comment word', () => {
  const per = commentScan();
  const ceilings = RATCHET.commentWordCeilings ?? {};
  const bad = []; const hints = [];
  for (const [rel, n] of Object.entries(per)) {
    const cap = ceilings[rel] ?? 0;
    if (n > cap) bad.push(`${rel}: ${n} comment line(s) with a lone German word (ceiling ${cap})`);
    else if (n < cap) hints.push(`${rel}: down to ${n}, ceiling ${cap} — lower it`);
  }
  for (const rel of Object.keys(ceilings)) if (!(rel in per)) hints.push(`${rel}: down to 0 — remove its ceiling`);
  // eslint-disable-next-line no-console
  if (hints.length) console.log(`HINT:\n${hints.map((h) => `  ${h}`).join('\n')}`);
  assert.deepEqual(bad, [], `translate the comment, or cite the name in backticks:\n${bad.join('\n')}`);
});

test('every commentWordCeilings entry still names a tracked file', () => {
  const tracked = new Set(trackedFiles());
  const stale = Object.keys(RATCHET.commentWordCeilings ?? {}).filter((rel) => !tracked.has(rel));
  assert.deepEqual(stale, []);
});

test('shared invariant ids are keys, not prose: blanked before measuring, the rest still counts', () => {
  // The sample is a REAL id taken from shared/invariants.jsonl at run time,
  // so this file carries no German line itself and the probe also proves
  // the catalogue holds such ids (otherwise the rule would guard nothing).
  const ids = fs.readFileSync(path.join(REPO, 'shared', 'invariants.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  const id = ids.find((x) => germanHits(asProse(x.replace(/-/g, ' '))).length >= 2);
  assert.ok(id, 'positive control: shared/invariants.jsonl holds at least one id that reads as German prose');
  const prose = id.replace(/-/g, ' ');
  const mark = ['//', 'invariant:'].join(' ');
  assert.equal(germanHits(asProse(withoutInvariantIds(`${mark} ${id}`))).length, 0);
  assert.equal(germanHits(asProse(withoutInvariantIds(`{"id": "${id}", "x": "y"}`, 'shared/invariants.jsonl'))).length, 0);
  // the same id outside shared/invariants.jsonl is NOT blanked, and prose next to a marker still counts
  assert.ok(germanHits(asProse(withoutInvariantIds(`{"id": "${id}"}`, 'other.jsonl'))).length >= 2);
  assert.ok(germanHits(asProse(withoutInvariantIds(`${mark} x-y ${prose}`))).length >= 2);
});
