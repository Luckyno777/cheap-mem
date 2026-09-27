// Every checked number-place has a writer (BAUPLAN M14).
//
// **The finding.** `test/doku-zahlen.test.mjs` already caught
// `docs/CAPABILITIES.md`'s "2033 tests" drifting against a real 2043 —
// it is a good guard. What it never had was a write path: every catch
// it made was fixed by the same hand-motion, because
// `bench/readme-numbers.mjs` only ever wrote `README.md`. The guard
// worked and the drift still came back, over and over, for the same
// reason lucky-mem's own `betrieb/readme-zahlen.mjs` header gives: a
// probe that always reports the same thing and is always fixed the
// same way burns attention a real finding needed later.
//
// This file does not re-count anything — it is not a third counter for
// `tests` or `modules`. It asks a purely structural question: for
// every living document that carries at least one checkable number
// claim, does the writer's `CLAIMS` list know that FILE at all? If a
// third document grows a checkable claim and nobody teaches the writer
// about it, this goes red before the hand-fix habit repeats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArchive } from './doc-archive.mjs';
import * as numbers from '../bench/readme-numbers.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The same claim shape `test/doku-zahlen.test.mjs`'s sweep looks for —
// duplicated on purpose. This probe asks a COARSER, structural
// question ("does any checkable number live in this file") than the
// counting itself, so it does not need that file's exemption logic
// (dated markers, rate-vs-code lines) to be right, only to be
// cautious: an extra file listed in `EXEMPT` below costs one line and
// a reason; a missed one is the whole point of this file.
const MUSTER = /\b([\d][\d,]*)\s+(MCP tools|CLI commands|commands|tools|modules|tests|lines)\b/g;

function livingDocs() {
  const out = [];
  for (const rel of fs.readdirSync(REPO).filter((n) => n.endsWith('.md'))) out.push(rel);
  const d = path.join(REPO, 'docs');
  if (fs.existsSync(d)) {
    for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) out.push(path.join('docs', n));
  }
  return out.filter((r) => !isArchive(r));
}

function filesWithCheckableClaims() {
  const found = new Set();
  for (const rel of livingDocs()) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    MUSTER.lastIndex = 0;
    if (MUSTER.test(text)) found.add(rel);
  }
  return found;
}

/**
 * A file named here is a checkable-looking claim that is deliberately
 * NOT this writer's business, with the reason why:
 *
 *   - `docs/mcp-setup.md` — its "N tools" claims are hand-counted in a
 *     WORD-OR-NUMERAL vocabulary ("eight tools") that is
 *     `test/tool-count-doc.test.mjs`'s own territory; that file already
 *     guards them directly against `bin/mem-mcp`. A second writer for
 *     the same claim would be a second truth, not a fix.
 *   - `CLAUDE.md`, `docs/dashboard-single-entry.md`, `docs/design.md` —
 *     each has a number next to one of `MUSTER`'s words, but not in any
 *     phrasing `readme-numbers.mjs`'s `CLAIMS` regexes match ("About
 *     180 lines" for one file alone, "4000 lines" as a fixture size in
 *     a benchmark, "500 lines of glue" as a size claim, not a count).
 *     None of these is the exact "As of ...: **N CLI commands...**" /
 *     "about N lines in `bin/` and `src/`," / "one of N guarantees"
 *     shape the writer knows how to find and replace.
 *
 * Every exemption is checked below: it must name a file that (a) still
 * exists and (b) the writer still does NOT claim — an exemption that
 * quietly stopped being true would hide a real gap instead of
 * explaining one.
 */
const EXEMPT = new Set([
  'docs/mcp-setup.md',
  'CLAUDE.md',
  'docs/dashboard-single-entry.md',
  'docs/design.md',
]);

const writerFiles = () => new Set(numbers.CLAIMS.map((c) => c.file ?? 'README.md'));

test('POSITIVE: the sweep finds a real checkable claim', () => {
  const claimed = filesWithCheckableClaims();
  assert.ok(claimed.has('README.md'), 'README.md carries no checkable claim — the sweep is broken, not the docs');
  assert.ok(claimed.size >= 3, `only ${claimed.size} living doc(s) with a checkable claim — the sweep barely runs`);
});

test('POSITIVE: the writer names the files it actually covers', () => {
  const known = writerFiles();
  assert.ok(known.has('README.md'), 'the writer does not even know about README.md');
  assert.ok(known.size >= 2, 'the writer covers fewer than two files — this probe would prove little');
});

test('every living doc with a checkable number claim is a file the writer knows', () => {
  const claimed = filesWithCheckableClaims();
  const known = writerFiles();
  const orphaned = [...claimed].filter((f) => !known.has(f) && !EXEMPT.has(f));
  assert.deepEqual(orphaned, [],
    'these file(s) carry a checkable number claim but bench/readme-numbers.mjs has no CLAIMS '
    + `entry for them: ${orphaned.join(', ')} — every number a probe checks needs a writer, `
    + 'or the next drift there gets fixed by hand again (BAUPLAN M14). Either give it a CLAIMS '
    + 'entry, or add it to EXEMPT here with the reason it is a different guard\'s job.');
});

test('SABOTAGE: a checkable claim in a file the writer does not know is reported, not swallowed', () => {
  // Not a fixture on disk — the point under test is the COMPARISON
  // itself, so a stand-in file plays the part a real drifted document
  // would play, without writing into the live repo tree.
  const claimed = new Set([...filesWithCheckableClaims(), 'docs/invented-surface.md']);
  const known = writerFiles();
  const orphaned = [...claimed].filter((f) => !known.has(f) && !EXEMPT.has(f));
  assert.ok(orphaned.includes('docs/invented-surface.md'),
    'a file with a checkable claim but no writer must show up here, not disappear into a passing test');
});

test('every EXEMPT entry still means something — it names a real file the writer still does not cover', () => {
  const known = writerFiles();
  for (const f of EXEMPT) {
    assert.ok(fs.existsSync(path.join(REPO, f)), `EXEMPT names ${f}, which no longer exists — remove it`);
    assert.ok(!known.has(f),
      `EXEMPT names ${f}, but the writer already covers it — the exemption is stale, remove it`);
  }
});
