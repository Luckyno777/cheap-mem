// src/findingmirror.mjs — which doctor findings does this house know,
// and which does the other one not.
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing.
//
// **What it is for.** Both houses run a doctor with named findings
// (`mem doctor` here, `mem doktor` in the sister house) — but each house
// defines its findings for itself. Measured on 2026-09-18: 23 findings
// here, 36 there, and 17 of them the same question in two languages. A
// finding one house has and the other lacks is either a missing check or
// a lesson that never made the crossing.
//
// **Why not a translation table.** The obvious route would be matching
// names: `digest` sounds like `fasser`, `behind` like `rueckstand`. That
// needs a maintained, growing list of word pairs — and a maintained
// table was decided against the same day, for measured reasons (see the
// discarded entry `entitaets-aufloesung` in shared/invariants.jsonl).
//
// The difference from an alias table: these are not hundreds of open
// free-text values but a few dozen fixed names per house, and the
// mapping is NOT guessed algorithmically but confirmed by a human,
// entry by entry, under its own id — exactly as shared/invariants.jsonl
// already does for assurances. What is NOT entered there does not count
// as "probably the same"; it surfaces as its own finding, "only here" or
// "only there". There is no silent nothing.
//
// **A trap worth naming.** `behind` and `git` BOTH begin with the same
// unknown-state message about git not being runnable. Only the rest of
// each function tells them apart. The name alone proved nothing, and
// neither did the first line.
//
// **The mapping file points at names, not at ids verified elsewhere.**
// That is exactly where a tool of this family becomes a silent no-op: a
// finding is renamed in the source, the mapping entry stays behind and
// points into empty space, and without a counter-check that looks like
// continued coverage. So every entry is checked AGAINST the names
// actually found in the source; stale entries are reported, never
// counted as a hit.
//
// Usage:
// The command around it is bench/finding-mirror.mjs. The library lives
// in src/ and not beside the command because src/doctor.mjs imports it,
// and the published package ships src/ but not bench/ — a doctor that
// crashes on an npm install is not a doctor.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Where a house defines its finding names — both known shapes.
 *
 * `style` is also the field name under which a mapping entry carries
 * that house's local name. Deliberately two fixed entries, not an open
 * list: just as invariants.mjs knows two fixed spellings and guesses no
 * third.
 */
export const SOURCES = Object.freeze([
  { file: path.join('src', 'doctor.mjs'), call: 'finding', style: 'finding' },
  { file: path.join('src', 'doktor.mjs'), call: 'befund', style: 'befund' },
]);

/** A call `finding('name', ...)` — the name is the first argument, a
 *  short kebab-case word. Read from the source on purpose: a hand-kept
 *  list goes stale silently the next time the doctor is rebuilt. */
function namePattern(call) {
  return new RegExp(`\\b${call}\\(\\s*['"]([a-z][a-z0-9-]*)['"]`, 'g');
}

/**
 * Which finding names does ONE house define, and in which shape?
 *
 * `missing: true` when neither known source file exists — that is the
 * not-measurable case, not "0 findings". `empty: true` when the file is
 * there but not a single call was found: this tool's own positive
 * control. If `finding(` changes to something else the name set falls
 * silently to 0, and without this signal "0 here, 0 there, no
 * difference" would look like a passing run.
 */
export function readHouse(root) {
  for (const s of SOURCES) {
    let text;
    try { text = fs.readFileSync(path.join(root, s.file), 'utf8'); } catch { continue; }
    const names = new Set();
    const pattern = namePattern(s.call);
    let m;
    while ((m = pattern.exec(text))) names.add(m[1]);
    return { root, style: s.style, source: s.file, names, missing: false, empty: names.size === 0 };
  }
  return { root, style: null, source: null, names: new Set(), missing: true, empty: true };
}

/** Where the mapping file can live — both houses, both spellings. */
export const MAP_PLACES = Object.freeze([
  path.join('shared', 'finding-map.jsonl'),
  path.join('geteilt', 'befund-zuordnung.jsonl'),
]);

/**
 * The mapping file: human-kept pairs
 * `{"id": "...", "finding": "<name here>", "befund": "<name there>"}`.
 *
 * The KEYS are German in both houses, like shared/invariants.jsonl:
 * `nur`, `luecke`, `warum`. The ids and the field names are the shared
 * language; only the prose is written in each house's own tongue. One
 * spelling per key, or the two copies drift apart on the first edit.
 *
 * If it is missing that is not this tool's error — it is the not-yet-
 * curated state, and EVERY finding then shows up as only-here or
 * only-there. What is not entered is a finding, not a silent nothing.
 *
 * ## The third entry kind, without which the tool would be switched off
 *
 * An entry may instead carry `{"nur": "finding"}` or `{"nur": "befund"}`:
 * "only the house with THAT shape has this finding, and rightly so."
 *
 * The side is named by the FIELD NAME, not by "here" and "there": the
 * same file read from the other house would otherwise invert every
 * entry. A point of view in a shared file is not a fact.
 *
 * Without it this tool would be permanently red. On the first real run
 * 19 findings were only in the sister house and 6 only here — and the
 * 19 are almost all its librarian subsystem, which does not exist here
 * at all. A check that points at unfixable red gets switched off, and
 * then it stops catching the guilty too.
 *
 * Explained does not mean unchecked: a `nur` entry must still point
 * at a name that actually exists. And `luecke: true` separates "rightly
 * absent over there" from "genuinely missing over there" — as a number
 * those look identical and they are opposites.
 */
export function readMap(root) {
  for (const place of MAP_PLACES) {
    let text;
    try { text = fs.readFileSync(path.join(root, place), 'utf8'); } catch { continue; }
    const entries = [];
    let broken = 0;
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try { entries.push(JSON.parse(l)); } catch { broken += 1; }
    }
    return { place, entries, broken, missing: false };
  }
  return { place: null, entries: [], broken: 0, missing: true };
}

/**
 * Do both houses hold THE SAME mapping file?
 *
 * Unlike `invariants.jsonl`, where each house writes its own prose,
 * this file describes a fact BETWEEN the houses — the same sentence
 * holds for both. Two copies allowed to drift would be exactly the
 * second source of truth that `shared/calculations.jsonl` stands
 * against.
 *
 * Returns `{ same, why }`. `same: null` means "not comparable" (one
 * side has no file) — not "same".
 */
export function mapsAgree(hereRoot, thereRoot) {
  const read = (r) => {
    for (const place of MAP_PLACES) {
      try { return fs.readFileSync(path.join(r, place), 'utf8'); } catch { /* next */ }
    }
    return null;
  };
  const a = read(hereRoot);
  const b = read(thereRoot);
  if (a === null || b === null) {
    return { same: null, why: a === null ? 'no mapping file here' : 'no mapping file there' };
  }
  // Line-wise and sorted: append order is not a difference anyone cares about.
  const norm = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).sort().join('\n');
  return norm(a) === norm(b) ? { same: true, why: '' } : { same: false, why: 'the two copies differ' };
}

/**
 * Compare two houses.
 *
 * Same style on both sides (both `finding` or both `befund`): the names
 * themselves are the shared language, a mapping file adds nothing —
 * direct set diff. Different style (the normal case, one house English
 * and one German): the mapping file alone decides which name here
 * corresponds to which name there, and every entry is checked against
 * the names ACTUALLY found in both houses.
 */
export function compare(here, there, map) {
  if (here.style && here.style === there.style) {
    const both = [...here.names].filter((n) => there.names.has(n)).sort();
    const onlyHere = [...here.names].filter((n) => !there.names.has(n)).sort();
    const onlyThere = [...there.names].filter((n) => !here.names.has(n)).sort();
    return { mode: 'same-style', both, onlyHere, onlyThere, stale: [],
      incomplete: [], ambiguous: [], explainedHere: [], explainedThere: [] };
  }

  const stale = [];
  const incomplete = [];
  const ambiguous = [];
  const both = [];
  const mappedHere = new Set();
  const mappedThere = new Set();
  const seenHere = new Map();
  const seenThere = new Map();
  const explainedHere = [];
  const explainedThere = [];

  for (const e of map.entries) {
    const id = e?.id ?? '(no id)';
    const nHere = here.style ? e?.[here.style] : undefined;
    const nThere = there.style ? e?.[there.style] : undefined;

    // Explained one-sided: "there is nothing over there, and rightly so."
    // The name is still checked against what was actually found — a note
    // pointing at a renamed finding is a finding here too, not quiet.
    if (e?.nur) {
      // The side is named by the FIELD NAME, not by "here" or "there".
      // The first version named the side by point of view rather than
      // by shape, and the same file read from the other house inverted
      // every entry: "only ours" became "only theirs". A point of view
      // in a shared file is not a fact.
      if (e.nur !== here.style && e.nur !== there.style) {
        incomplete.push({ id, entry: e });
        continue;
      }
      const side = e.nur === here.style ? here : there;
      const name = e?.[side.style];
      if (!name) { incomplete.push({ id, entry: e }); continue; }
      if (!side.names.has(name)) {
        stale.push({ id, field: side.style, name, root: side.root, source: side.source });
        continue;
      }
      (side === here ? mappedHere : mappedThere).add(name);
      (side === here ? explainedHere : explainedThere)
        .push({ name, why: e.warum ?? '', gap: e.luecke === true,
          missingIn: (side === here ? there : here).style });
      continue;
    }

    if (!nHere || !nThere) { incomplete.push({ id, entry: e }); continue; }

    // Two entries claiming the same local name contradict each other:
    // which one holds? Reported, not silently overwritten by the last.
    if (seenHere.has(nHere) && seenHere.get(nHere) !== id) {
      ambiguous.push({ field: here.style, name: nHere, ids: [seenHere.get(nHere), id] });
    }
    seenHere.set(nHere, id);
    if (seenThere.has(nThere) && seenThere.get(nThere) !== id) {
      ambiguous.push({ field: there.style, name: nThere, ids: [seenThere.get(nThere), id] });
    }
    seenThere.set(nThere, id);

    const hereHas = here.names.has(nHere);
    const thereHas = there.names.has(nThere);
    if (!hereHas) stale.push({ id, field: here.style, name: nHere, root: here.root, source: here.source });
    if (!thereHas) stale.push({ id, field: there.style, name: nThere, root: there.root, source: there.source });
    if (hereHas) mappedHere.add(nHere);
    if (thereHas) mappedThere.add(nThere);
    if (hereHas && thereHas) both.push(id);
  }

  const onlyHere = [...here.names].filter((n) => !mappedHere.has(n)).sort();
  const onlyThere = [...there.names].filter((n) => !mappedThere.has(n)).sort();
  both.sort();
  explainedHere.sort((a, b) => a.name.localeCompare(b.name));
  explainedThere.sort((a, b) => a.name.localeCompare(b.name));
  return { mode: 'mapped', both, onlyHere, onlyThere, stale, incomplete,
    ambiguous, explainedHere, explainedThere };
}
