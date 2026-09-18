// A number is guarded where it stands — not where someone once put a guard.
//
// **The finding (2026-09-16).** Lucky, reading the docs: "cheap-mem's
// documentation looks out of date again." He was right, and the
// interesting part is that a guard already existed and was green.
//
// `test/readme-zahlen.test.mjs` was built on 2026-09-08 after two
// provably wrong numbers turned up in an external review. It works. It
// guards `README.md`. That is exactly as far as it goes:
//
//   - `docs/CAPABILITIES.md` said "778 tests" in two places. Real: 904.
//   - `CLAUDE.md` said `bin/mem` is "~3,400 lines". Real: 3,953.
//   - `README.md` itself said "about 18,900 lines". Real: 23,318 — and
//     the existing check PASSED, because its tolerance is a factor of
//     1.5 and the drift had only reached 1.23.
//
// So the lesson is not "add the missing numbers". It is sharper than
// that: **a guard that checks one place does not protect the number, it
// protects the place.** The 2026-09-08 fix corrected two sentences and
// fenced the sentences. Every other sentence went on rotting, and the
// fourth instance of the same class arrived eight days later.
//
// This file guards the QUANTITY instead. It derives each countable
// property from the code once, then walks every living doc and checks
// each claim it finds, wherever it stands.
//
// **What it deliberately does not do.**
//
//   - It does not prescribe wording. A guard that pins a sentence goes
//     red on the next honest rewrite, gets called a nuisance, and is
//     switched off. It matches "<number> <thing>" in any sentence.
//   - It does not touch dated measurements. "in September 2026 when
//     there were 17 MCP tools" is a true statement about a past day and
//     must stay. A date nearby means "then", not "now".
//   - It does not touch the archive. CHANGELOG.md and the dated
//     analyses under docs/ are records of what was true when written.
//     Rewriting them would be falsifying a record.
//
// Every one of those exemptions is COUNTED and asserted to be small, so
// that "skipped" can never quietly become "all of them".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as clihelp from '../src/clihelp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// --- What the code actually is ---------------------------------------

function lineCount(dir, filter = () => true) {
  let n = 0;
  for (const name of fs.readdirSync(path.join(REPO, dir))) {
    if (!filter(name)) continue;
    const p = path.join(REPO, dir, name);
    if (!fs.statSync(p).isFile()) continue;
    n += fs.readFileSync(p, 'utf8').split('\n').length;
  }
  return n;
}

const IST = {
  /** Countable things. No tolerance — these are facts, not estimates. */
  genau: {
    'MCP tools': new Set([...read('bin/mem-mcp').matchAll(/name: '(mem_[a-z_]+)'/g)].map((m) => m[1])).size,
    'CLI commands': clihelp.allTableCommands(read).length,
    modules: fs.readdirSync(path.join(REPO, 'src')).filter((n) => n.endsWith('.mjs')).length,
  },
  /**
   * Things that move with every commit. A tolerance, and a narrow one.
   *
   * The 2026-09-08 guard allowed a factor of 1.5, reasoning that an
   * exact match would fail on the next commit and be switched off
   * within a week. Sound reasoning, wrong number: 1.5 let a 4,400-line
   * error stand. 1.15 survives ordinary work — a month of commits does
   * not move 23,000 lines by 3,400 — and catches drift while it is
   * still a correction and not an embarrassment.
   */
  ungefaehr: {
    tests: 0,   // set below — counted from test/, see the note
    // TWO line counts, because the docs make two different claims:
    // `bin/mem` alone (CLAUDE.md's "what lives where") and the whole of
    // `bin/` + `src/` (the README's size argument). The first draft of
    // this guard had one number and reported CLAUDE.md as wrong by a
    // factor of 6.9 — a false positive against a sentence that was
    // right. A guard that cries wolf on correct prose gets switched
    // off, and then it guards nothing at all.
    'lines:cli': read('bin/mem').split('\n').length,
    'lines:all': lineCount('bin') + lineCount('src', (n) => n.endsWith('.mjs')),
  },
};

// Tests can only be counted statically, and that is a LOWER bound:
// subtests inside a `test()` body are not visible here. Measured on
// 2026-09-16: 899 statically against 904 reported by the runner. Close
// enough to guard, and named as a lower bound so nobody later reads it
// as the runner's number.
IST.ungefaehr.tests = fs.readdirSync(path.join(REPO, 'test'))
  .filter((n) => n.endsWith('.mjs'))
  .reduce((a, n) => a + [...read(path.join('test', n)).matchAll(/^test\(/gm)].length, 0);

/**
 * One band per kind, because the kinds are not equally countable.
 *
 * **What 1.15 for everything cost.** On 2026-09-18 the README said
 * "1166 tests" against a real 1231 counted here (1236 reported by the
 * runner). Factor 1.056 — comfortably inside 1.15, so every run was
 * green while the number was two weeks stale. Nobody was misled in any
 * way that mattered, and that is the point: a band chosen so it never
 * annoys anyone is a band that never says anything either.
 *
 * Tests are cheap to count exactly. The only reason this is not `1.0`
 * is the 0.41 % gap between the static count and the runner's number —
 * tests generated inside a loop or nested in a `describe` body are not
 * visible to a regex. 2 % covers that gap with room and still catches
 * the drift above; the positive control below proves it does.
 *
 * Line counts keep 1.15: they move with every commit for reasons that
 * are not drift, and the failure they exist to catch (500 against
 * ~23,000) is an order of magnitude away, not five percent.
 */
const TOLERANZ = { tests: 1.02, 'lines:all': 1.15, 'lines:cli': 1.15 };
const TOLERANZ_VORGABE = 1.15;
const bandFuer = (was) => TOLERANZ[was] ?? TOLERANZ_VORGABE;

// --- Which documents are living, and which are records ---------------

/**
 * A file is an ARCHIVE if its name carries a date, or it is the
 * changelog. Everything else is living and gets checked — including
 * files that do not exist yet, which is the point: a new document is
 * guarded the day someone writes it, without anyone remembering to add
 * it here.
 */
function istArchiv(rel) {
  return rel === 'CHANGELOG.md' || /-\d{4}-\d{2}-\d{2}/.test(rel);
}

function dokumente() {
  const raus = [];
  for (const rel of fs.readdirSync(REPO).filter((n) => n.endsWith('.md'))) raus.push(rel);
  const d = path.join(REPO, 'docs');
  if (fs.existsSync(d)) for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) raus.push(path.join('docs', n));
  return raus.filter((r) => !istArchiv(r));
}

// --- Finding claims ---------------------------------------------------

/** `28 MCP tools`, `904 tests`, `about 18,900 lines`, `54 commands`. */
const MUSTER = /\b([\d][\d,]*)\s+(MCP tools|CLI commands|commands|tools|modules|tests|lines)\b/g;

/**
 * An exemption NAMES the number it exempts.
 *
 * The first draft inferred it: a date nearby meant "historical". That
 * was wrong twice over in one file. `As of 2026-09-13: 54 CLI
 * commands…` is a claim about NOW that happens to carry a date — the
 * guard skipped the single most important line in the README. And a
 * marker that covered a whole paragraph also covered the corrected
 * number standing two sentences later, so the freshly fixed figure
 * would have gone unguarded from the day it was fixed.
 *
 * Both failures have one cause: the exemption was guessing. Now it
 * says what it means — `<!-- zahl-historisch: 500 lines (reason) -->`
 * exempts `500 lines` and nothing else. Punctual, visible to the next
 * reader, and impossible to widen by accident.
 */
function markierteAusnahmen(text) {
  const raus = new Set();
  for (const m of text.matchAll(/<!--\s*zahl-historisch:\s*([\d][\d,]*)\s+([A-Za-z ]+?)\s*(?:\(|-->)/gi)) {
    raus.add(`${m[1].replace(/,/g, '')} ${m[2].trim()}`);
  }
  return raus;
}

/**
 * `lines` is the one word that also means something else.
 *
 * "480 lines per hour" is a rate, "800 lines" in an old audit is a
 * budget. Only a claim that names the code is a claim about the code.
 * Everything else is skipped — and counted, so the skip can be seen.
 */
function zielDerZeilenzahl(text, index) {
  const umfeld = text.slice(Math.max(0, index - 200), index + 200);
  // `bin/mem` named on its own — and not as part of bin/mem-mcp or a
  // sentence that also names src/ — is a claim about that one file.
  if (/\bbin\/mem\b(?!-)/.test(umfeld) && !/\bsrc\//.test(umfeld)) return 'lines:cli';
  if (/\bbin\/|\bsrc\/|codebase|of JS\b/.test(umfeld)) return 'lines:all';
  return null;   // a rate, a budget, something else — not our business
}

function sammleBehauptungen() {
  const geprueft = []; const datiert = []; const nichtCode = [];
  for (const rel of dokumente()) {
    const text = read(rel);
    const ausgenommen = markierteAusnahmen(text);
    for (const m of text.matchAll(MUSTER)) {
      const zahl = Number(m[1].replace(/,/g, ''));
      const was = m[2];
      const satz = { rel, zahl, was, zeile: text.slice(0, m.index).split('\n').length };
      if (ausgenommen.has(`${zahl} ${was}`)) { datiert.push(satz); continue; }
      if (was === 'lines') {
        const ziel = zielDerZeilenzahl(text, m.index);
        if (!ziel) { nichtCode.push(satz); continue; }
        geprueft.push({ ...satz, was: ziel });
        continue;
      }
      geprueft.push(satz);
    }
  }
  return { geprueft, datiert, nichtCode };
}

/** `tools` alone means MCP tools; `commands` alone means CLI commands. */
const GLEICHBEDEUTEND = { tools: 'MCP tools', commands: 'CLI commands' };

// --- The guards -------------------------------------------------------

test('POSITIVE: the counters see a real codebase', () => {
  // A guard whose counters return zero passes forever. This is the
  // vacuity check, and it is first on purpose.
  assert.ok(IST.genau['MCP tools'] >= 15, `${IST.genau['MCP tools']} MCP tools found — the counter broke, not the docs`);
  assert.ok(IST.genau['CLI commands'] >= 30, `${IST.genau['CLI commands']} CLI commands found — the counter broke`);
  assert.ok(IST.genau.modules >= 25, `${IST.genau.modules} modules found — the counter broke`);
  assert.ok(IST.ungefaehr.tests >= 300, `${IST.ungefaehr.tests} tests found — the counter broke`);
  assert.ok(IST.ungefaehr['lines:all'] >= 5000, `${IST.ungefaehr['lines:all']} lines found — the counter broke`);
  // The floor was 1000 while `bin/mem` held the whole command table. It
  // holds the dispatch now and is ~180 lines; a floor from the old shape
  // reports the counter as broken every run, which is how a vacuity
  // check turns into noise and gets deleted.
  assert.ok(IST.ungefaehr['lines:cli'] >= 80, `${IST.ungefaehr['lines:cli']} lines in bin/mem — the counter broke`);
});

test('POSITIVE: the pattern finds a claim in ordinary prose', () => {
  // Without this, a pattern that matches nothing would make every
  // document below look clean.
  const treffer = [...'the server ships 28 MCP tools and about 18,900 lines'.matchAll(MUSTER)];
  assert.equal(treffer.length, 2);
  assert.equal(Number(treffer[0][1]), 28);
  assert.equal(Number(treffer[1][1].replace(/,/g, '')), 18900);
});

test('POSITIVE: an exemption exempts its own number and nothing else', () => {
  // Both halves matter. Without the first, the marker does nothing;
  // without the second, one marker silences a whole paragraph — which
  // is exactly how the corrected figure nearly went unguarded.
  const a = markierteAusnahmen('<!-- zahl-historisch: 500 lines (was wrong) -->');
  assert.ok(a.has('500 lines'), 'the marker does not exempt its own number');
  assert.ok(!a.has('23,300 lines'), 'the marker leaks onto other numbers');
  assert.equal(a.size, 1);
  assert.equal(markierteAusnahmen('no marker here').size, 0);
});

test('the guard actually reaches the living documents', () => {
  // The exemptions must stay a minority. If skipping ever becomes the
  // rule, this file checks nothing while looking busy.
  const { geprueft, datiert, nichtCode } = sammleBehauptungen();
  assert.ok(geprueft.length >= 8,
    `only ${geprueft.length} claims checked (${datiert.length} dated, ${nichtCode.length} not about code) `
    + '— either the docs stopped stating numbers, or the pattern no longer matches how they are written');
  assert.ok(geprueft.length > datiert.length + nichtCode.length,
    `more claims skipped (${datiert.length + nichtCode.length}) than checked (${geprueft.length}) `
    + '— the exemptions have eaten the guard');
  assert.ok(dokumente().length >= 3, 'no living documents found at all');
});

test('every countable claim in every living document is right', () => {
  const falsch = [];
  for (const c of sammleBehauptungen().geprueft) {
    const was = GLEICHBEDEUTEND[c.was] ?? c.was;
    if (was in IST.genau) {
      if (c.zahl !== IST.genau[was]) {
        falsch.push(`${c.rel}:${c.zeile} says ${c.zahl} ${c.was} — the code has ${IST.genau[was]}`);
      }
    } else if (was in IST.ungefaehr) {
      const real = IST.ungefaehr[was];
      const faktor = Math.max(real, c.zahl) / Math.min(real, c.zahl);
      if (faktor > bandFuer(was)) {
        falsch.push(`${c.rel}:${c.zeile} says ${c.zahl} ${c.was} — really ${real} (factor ${faktor.toFixed(2)})`);
      }
    }
  }
  assert.deepEqual(falsch, [], `\n${falsch.join('\n')}\n`);
});

test('the drift that got past the 2026-09-08 guard would fail this one', () => {
  // The point of a guard is that it catches the thing that happened.
  // "about 18,900 lines" against a real 23,318 is a factor of 1.23 — it
  // slipped through a tolerance of 1.5. If it would slip through here
  // too, this file is decoration.
  const faktor = IST.ungefaehr['lines:all'] / 18900;
  assert.ok(faktor > bandFuer('lines:all'),
    `the 18,900 claim would pass at a band of ${bandFuer('lines:all')} — this guard adds nothing`);
});

test('the test-count drift that the 1.15 band swallowed would fail this one', () => {
  // 2026-09-18: the README said 1166 against 1231 counted here. Factor
  // 1.056 — green under the old single band, and that is why this test
  // exists. If the narrower band would ALSO pass it, the change was
  // cosmetic.
  const real = IST.ungefaehr.tests;
  const faktor = real / 1166;
  assert.ok(faktor > bandFuer('tests'),
    `1166 tests against ${real} would pass at a band of ${bandFuer('tests')} — the narrowing bought nothing`);
  assert.ok(faktor < TOLERANZ_VORGABE,
    `1166 against ${real} is a factor of ${faktor.toFixed(3)} — if it exceeded the OLD band of `
    + `${TOLERANZ_VORGABE} the premise is wrong: it was never swallowed, and this test proves nothing`);
});

test('POSITIVE: the narrow band still passes the number that is actually there', () => {
  // A band tight enough to fail the truth is worse than one that is too
  // wide: the first thing anyone does with it is switch it off. The
  // runner reports a few more tests than a regex can see — that gap
  // must fit, or the next honest commit goes red.
  const real = IST.ungefaehr.tests;
  for (const behauptet of [real, 1236]) {
    const faktor = Math.max(real, behauptet) / Math.min(real, behauptet);
    assert.ok(faktor <= bandFuer('tests'),
      `a claim of ${behauptet} against ${real} counted would FAIL at ${bandFuer('tests')} `
      + '— the band is too tight for the static-vs-runner gap');
  }
});

test('a claim in a dated record is left alone', () => {
  // CHANGELOG.md states "17 MCP tools" for a release where that was
  // true. A guard that "corrects" a record falsifies it.
  const alle = dokumente();
  assert.ok(!alle.includes('CHANGELOG.md'), 'the changelog is a record and must not be rewritten');
  assert.ok(alle.includes('README.md'), 'the README is living and must be checked');
});
