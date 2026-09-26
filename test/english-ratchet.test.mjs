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
import { germanHits, asProse, KNOWN_VERBATIM_QUOTES } from './english-dictionary.mjs';

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
function germanLinesOf(text) {
  const offenders = [];
  text.split('\n').forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (KNOWN_VERBATIM_QUOTES.some((q) => raw.includes(q))) return;
    const hits = germanHits(asProse(raw));
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
    const offenders = germanLinesOf(buf.toString('utf8'));
    if (offenders.length) perFile.set(rel, offenders);
  }
  return { files, perFile, skippedBinary };
}

test('POSITIVE: the ratchet walks a meaningful number of tracked files', () => {
  // House rule: leeres Bestehen ist Durchfallen — an empty walk passes
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
function filenameHits(rel) {
  const lower = rel.toLowerCase();
  return RATCHET.filenameGermanWords.filter((w) => lower.includes(w));
}

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
