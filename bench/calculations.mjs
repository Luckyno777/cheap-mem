// bench/calculations.mjs — does this house work the same thing out twice?
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing.
//
// ## The error class
//
// In the sister house it happened THREE times in a single day
// (2026-09-18):
//
//   1. A module recorded, at length and with reasons, that a capture's
//      size comes from the manifest and not from the disk. A shell
//      script a few hundred lines away called `statSync` itself. Four
//      relocated captures came back ENOENT, counted as infinitely
//      large, and sank to the back of the queue.
//   2. Two modules read a letter's timestamp from two different
//      places — the FILENAME in one, the HEADER FIELD in the other.
//      The same pile was "oldest 10 days" in one place and "9.5 days"
//      in the other.
//   3. A systemd unit promised something with `Persistent=true` that
//      systemd does not evaluate at all for a monotonic timer.
//
// None of those second versions was wrong when it was written. That is
// exactly what makes them dangerous: they only drift apart later, and
// then you believe the wrong one.
//
// ## Why not the obvious route
//
// Searching for places where several modules compare the same STATE
// directly — `state === "closed"` and the like — only works at a low
// false-positive rate, and a string comparison has none: every state
// check in the house would be a hit, the list would be unreadable, and
// a check that reports the innocent gets switched off.
//
// So: not strings, but CALCULATIONS. `shared/calculations.jsonl` records,
// for every question this house answers by computing, which file owns it
// and what a second version would look like. What is not in the
// catalogue is not searched for — a narrow catalogue that is right beats
// a wide net that nags.
//
// ## The positive control, without which this would be worthless
//
// A pattern that no longer matches anything — because a file was
// renamed, because a function is called something else — finds nothing
// and reports "all clear". That is the same silent no-op the invariant
// tool had about itself: "Covered 16 of 16" stood above six markers
// pointing at nothing.
//
// So this tool checks on EVERY run that each pattern still fires inside
// its own owner. If it does not, the anchor is orphaned and is reported
// as a finding — not as quiet.
//
//   node bench/calculations.mjs [--catalogue <path>] [--root <path>]
//
// Exit code: 0 clean, 1 something open, 2 not measurable.
// Not measurable is explicitly NOT 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATALOGUE = path.join('shared', 'calculations.jsonl');

/** Where we look. Tests are exempt: a probe MAY rebuild a calculation
 *  in order to check it — that is its job. */
export const PLACES = ['src', 'bin'];

/**
 * Read the catalogue. Always returns an object, never throws.
 *
 * A broken line is counted, not silently skipped: a catalogue that
 * loses half its entries and still reports "nothing open" is worse
 * than none.
 */
export function readCatalogue(root, rel = CATALOGUE) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    return { there: false, path: full, entries: [], discarded: [], broken: 0 };
  }
  const entries = [];
  const discarded = [];
  let broken = 0;
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!e.id || !e.owner || !e.pattern) { broken += 1; continue; }
      // Discarded entries stay in the catalogue but are not checked. A
      // deleted entry loses its reasoning, and then somebody enters it
      // again in six months — the same pattern `invariants.jsonl` keeps
      // with its discarded entries.
      if (e.kind === 'discarded') { discarded.push(e); continue; }
      entries.push(e);
    } catch { broken += 1; }
  }
  return { there: true, path: full, entries, discarded, broken };
}

/** Every source file under the places, without node_modules. */
export function sources(root, places = PLACES) {
  const out = [];
  const walk = (rel) => {
    const full = path.join(root, rel);
    let entries;
    try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = path.join(rel, e.name);
      if (e.isDirectory()) { walk(child); continue; }
      out.push(child);
    }
  };
  for (const p of places) walk(p);
  return out.sort();
}

/**
 * Check one calculation.
 *
 * Returns `{ id, seconds, anchorHolds }`.
 *
 * `anchorHolds` is the positive control: does the pattern fire inside
 * the owner itself? If it does not, it is searching empty space, and
 * every "nothing found" would be meaningless.
 */
export function checkOne(root, e, files) {
  let pattern;
  try { pattern = new RegExp(e.pattern); }
  catch (err) { return { id: e.id, error: `unusable pattern: ${err.message}` }; }

  const except = new Set([e.owner, ...(e.except ?? [])].map((x) => x.replace(/\\/g, '/')));
  const seconds = [];
  let anchorHolds = false;

  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    const normal = rel.replace(/\\/g, '/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      // Comments do not count: this catalogue DESCRIBES the patterns,
      // and a docblock explaining a calculation is not a second
      // calculation. Without this line every good piece of reasoning
      // reported itself as a defect.
      const l = lines[i];
      const bare = l.trimStart();
      if (bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*') || bare.startsWith('#')) {
        continue;
      }
      if (!pattern.test(l)) continue;
      if (except.has(normal)) { anchorHolds = true; continue; }
      seconds.push({ file: normal, line: i + 1, text: l.trim().slice(0, 100) });
    }
  }
  return { id: e.id, seconds, anchorHolds, owner: e.owner, question: e.question };
}

/** Check everything. */
export function check(root, { catalogue = CATALOGUE, places = PLACES } = {}) {
  const c = readCatalogue(root, catalogue);
  if (!c.there) return { measurable: false, why: `catalogue ${c.path} is missing`, ...c };
  if (!c.entries.length) {
    // An empty catalogue never finds anything. Reading that as "clean"
    // would be precisely the silent no-op this tool stands against.
    return { measurable: false, why: 'catalogue with no entries — nothing checked is not a pass', ...c };
  }
  const files = sources(root, places);
  return { measurable: true, broken: c.broken, discarded: c.discarded.length,
    files: files.length,
    results: c.entries.map((e) => checkOne(root, e, files)) };
}

// --- run as a tool -----------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const flag = (n, v) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : v;
  };
  const root = path.resolve(flag('root', path.join(fileURLToPath(new URL('..', import.meta.url)))));
  const r = check(root, { catalogue: flag('catalogue', CATALOGUE) });

  if (!r.measurable) {
    console.log(`NOT MEASURABLE: ${r.why}`);
    process.exit(2);
  }
  console.log(`Catalogue: ${r.results.length} calculations`
    + `${r.discarded ? `, ${r.discarded} discarded` : ''}`
    + `, ${r.files} source files`
    + `${r.broken ? `, ${r.broken} broken catalogue lines` : ''}\n`);

  let open = r.broken;
  for (const x of r.results) {
    if (x.error) { console.log(`  PATTERN BROKEN     ${x.id}  ${x.error}`); open += 1; continue; }
    if (!x.anchorHolds) {
      console.log(`  ANCHOR ORPHANED    ${x.id}  — the pattern no longer fires in `
        + `${x.owner}, so it is searching empty space`);
      open += 1;
      continue;
    }
    for (const s of x.seconds) {
      console.log(`  SECOND CALCULATION ${x.id}  ${s.file}:${s.line}`);
      console.log(`                     ${x.question}  ->  owned by ${x.owner}`);
      console.log(`                     ${s.text}`);
      open += 1;
    }
  }
  if (!open) console.log('  Every calculation lives in exactly one place.');
  process.exit(open ? 1 : 0);
}
