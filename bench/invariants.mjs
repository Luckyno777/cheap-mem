// bench/invariants.mjs — what one house learned, and whether the other knows.
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing.
//
// **What it is for.** On 2026-09-16 three defects were fixed in the
// project this tool was extracted from. All three were still sitting
// here unchanged — they had travelled across with the code and were
// never revisited. No tool found them; somebody happened to look.
//
// The obvious approach would be a name-level diff between the houses:
// which module here corresponds to which module there. That needs a
// maintained translation table — and a maintained table was decided
// against the same day, for measured reasons (see the discarded entry
// `entitaets-aufloesung` in the catalogue).
//
// So the comparison does not hang on names but on ASSURANCES.
// `shared/invariants.jsonl` holds the lessons that concern both houses
// under a common id. Each house writes its own prose; the IDS are what
// gets compared. A test declares itself responsible by naming the id
// in a marker comment:
//
//     // invariant: klon-marke-im-namen
//
// The diff is then mechanical: which id does this house cover, which
// does the other. No similarity search, no guessing.
//
// **Two kinds in the catalogue.** `invariant` is something that MUST
// hold and deserves a guard. `discarded` is negative knowledge:
// measured, with the number, and deliberately NOT built. The second
// kind is the rarer and more expensive one — what nobody writes down,
// the next session builds again. Every discarded entry therefore
// carries what would make the decision worth revisiting.
//
// Usage:
//   node bench/invariants.mjs [--root <path>] [--against <path-to-other-house>]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

/** Where the catalogue may live — either house, either spelling. */
export const CATALOGUE_PATHS = Object.freeze([
  path.join('shared', 'invariants.jsonl'),
  path.join('geteilt', 'invarianten.jsonl'),
]);

/** The marker with which a test declares itself responsible for an id. */
export const MARKER = /^\s*\/\/\s*(?:invariant|invariante):\s*([a-z0-9-]{3,64})\s*$/;

/**
 * A line that WANTS to be a marker but is not one.
 *
 * Without this a mistyped marker — a missing colon, a capital letter,
 * a trailing comment — simply does not match and vanishes. The test
 * then declares a coverage it does not have, and the tool agrees with
 * it. Reported, never silently dropped.
 */
export const NEARLY_MARKER = /^\s*\/\/\s*(?:invariant|invariante)\b/i;

export function readCatalogue(root) {
  for (const rel of CATALOGUE_PATHS) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    const entries = [];
    let broken = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { broken += 1; }
    }
    return { rel, entries, broken, missing: false };
  }
  return { rel: null, entries: [], broken: 0, missing: true };
}

/** Which ids do this house's tests declare as covered? */
export function covered(root, { dirs = ['test'] } = {}) {
  const out = new Map();
  const malformed = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      let text;
      try {
        if (!fs.statSync(p).isFile()) continue;
        text = fs.readFileSync(p, 'utf8');
      } catch { continue; }
      for (const [i, line] of text.split('\n').entries()) {
        const m = MARKER.exec(line);
        if (!m) {
          if (NEARLY_MARKER.test(line)) malformed.push(`${d}/${n}:${i + 1}  ${line.trim()}`);
          continue;
        }
        if (!out.has(m[1])) out.set(m[1], new Set());
        out.get(m[1]).add(`${d}/${n}`);
      }
    }
  }
  out.malformed = malformed;
  return out;
}

const isInvariant = (e) => e?.art === 'invariant' || e?.art === 'invariante';
const isDiscarded = (e) => e?.art === 'discarded' || e?.art === 'verworfen';

/**
 * The finding for ONE house.
 *
 * `uncovered` are invariants without a test. `unknownMarkers` are
 * markers in tests that do not appear in the catalogue — a typo in a
 * marker otherwise looks exactly like coverage and is none.
 */
export function finding(catalogue, coverage) {
  const invariants = catalogue.entries.filter(isInvariant);
  const ids = new Set(catalogue.entries.map((e) => e?.id).filter(Boolean));
  return {
    invariants: invariants.length,
    discarded: catalogue.entries.filter(isDiscarded).length,
    covered: invariants.filter((e) => coverage.has(e.id)).map((e) => e.id),
    uncovered: invariants.filter((e) => !coverage.has(e.id)).map((e) => e.id),
    unknownMarkers: [...coverage.keys()].filter((k) => !ids.has(k)),
    malformedMarkers: coverage.malformed ?? [],
  };
}

/**
 * The diff between two houses.
 *
 * Ids are compared, not prose: each house writes its own text, and it
 * should. If the id SETS differ, one house does not know a lesson at
 * all — a heavier finding than an uncovered invariant.
 */
export function diff(here, there) {
  const a = new Set(here.catalogue.entries.map((e) => e?.id).filter(Boolean));
  const b = new Set(there.catalogue.entries.map((e) => e?.id).filter(Boolean));
  return {
    catalogueOnlyHere: [...a].filter((i) => !b.has(i)),
    catalogueOnlyThere: [...b].filter((i) => !a.has(i)),
    coveredOnlyHere: here.finding.covered.filter((i) => !there.finding.covered.includes(i)),
    coveredOnlyThere: there.finding.covered.filter((i) => !here.finding.covered.includes(i)),
  };
}

export function readHouse(root) {
  const catalogue = readCatalogue(root);
  const coverage = covered(root);
  return { root, catalogue, coverage, finding: finding(catalogue, coverage) };
}

// --- as a command ------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = path.resolve(flag('root') ?? process.cwd());
  const here = readHouse(ROOT);

  if (here.catalogue.missing) {
    console.log(`No catalogue in ${ROOT}. Expected: ${CATALOGUE_PATHS.join(' or ')}`);
    console.log('That is not a pass.');
    process.exit(2);
  }
  console.log(`Catalogue: ${here.catalogue.rel}  (${here.finding.invariants} invariants, `
    + `${here.finding.discarded} discarded`
    + `${here.catalogue.broken ? `, ${here.catalogue.broken} broken lines` : ''})`);
  console.log(`Covered:   ${here.finding.covered.length} of ${here.finding.invariants}\n`);

  for (const id of here.finding.uncovered) console.log(`  NO TEST               ${id}`);
  for (const id of here.finding.unknownMarkers) {
    console.log(`  MARKER WITHOUT ENTRY  ${id}  (typo? looks like coverage where there is none)`);
  }
  for (const line of here.finding.malformedMarkers) {
    console.log(`  MALFORMED MARKER      ${line}`);
  }

  const AGAINST = flag('against');
  if (AGAINST) {
    const there = readHouse(path.resolve(AGAINST));
    if (there.catalogue.missing) {
      console.log(`\nThe other house (${AGAINST}) has no catalogue.`);
      process.exit(2);
    }
    const d = diff(here, there);
    console.log(`\nAgainst ${AGAINST}:`);
    for (const id of d.catalogueOnlyHere) {
      console.log(`  CATALOGUE ONLY HERE   ${id}  — the other house does not know this lesson`);
    }
    for (const id of d.catalogueOnlyThere) {
      console.log(`  CATALOGUE ONLY THERE  ${id}  — this lesson is missing here`);
    }
    for (const id of d.coveredOnlyHere) console.log(`  GUARDED ONLY HERE     ${id}`);
    for (const id of d.coveredOnlyThere) {
      console.log(`  GUARDED ONLY THERE    ${id}  — unguarded here`);
    }
    if (!d.catalogueOnlyHere.length && !d.catalogueOnlyThere.length
      && !d.coveredOnlyHere.length && !d.coveredOnlyThere.length) {
      console.log('  Both houses know the same lessons and guard the same ones.');
    }
  }

  if (!here.finding.invariants) {
    console.log('\nCATALOGUE WITH NO INVARIANTS. Nothing checked is not a pass.');
    process.exit(2);
  }
  process.exit(here.finding.uncovered.length + here.finding.unknownMarkers.length
    + here.finding.malformedMarkers.length ? 1 : 0);
}
