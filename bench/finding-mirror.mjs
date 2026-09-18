// bench/finding-mirror.mjs — the command around src/findingmirror.mjs.
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing. The logic lives in src/ because src/doctor.mjs imports it and
// the published package ships src/ but not bench/.
//
//   node bench/finding-mirror.mjs [--root <path>] [--against <path-to-other-house>]
//
// Exit code: 0 everything judged, 1 something open, 2 not measurable.
// Not measurable is explicitly NOT 0.
import path from 'node:path';
import { readHouse, readMap, compare, mapsAgree, SOURCES, MAP_PLACES }
  from '../src/findingmirror.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

// --- run as a tool -----------------------------------------------------
{
  const ROOT = path.resolve(flag('root') ?? process.cwd());
  const here = readHouse(ROOT);

  if (here.missing) {
    console.log(`No doctor source in ${ROOT}. Expected: ${SOURCES.map((s) => s.file).join(' or ')}`);
    console.log('That is not measurable, not "no findings".');
    process.exit(2);
  }
  if (here.empty) {
    console.log(`${here.source} exists in ${ROOT}, but not a single '${here.style}(' call was found.`);
    console.log('Not measurable — either the call name is changing right now, or the file '
      + 'really is empty. Neither is a pass.');
    process.exit(2);
  }
  console.log(`Source here: ${here.source}  (style '${here.style}', ${here.names.size} findings)`);

  const AGAINST = flag('against');
  if (!AGAINST) {
    for (const n of [...here.names].sort()) console.log(`  FINDING  ${n}`);
    process.exit(0);
  }

  const there = readHouse(path.resolve(AGAINST));
  if (there.missing) {
    console.log(`\nThe other house (${AGAINST}) has no doctor source. Not measurable.`);
    process.exit(2);
  }
  if (there.empty) {
    console.log(`\nThe other house (${AGAINST}) has ${there.source} but not a single `
      + `'${there.style}(' call in it. Not measurable.`);
    process.exit(2);
  }
  console.log(`Source there: ${there.source}  (style '${there.style}', ${there.names.size} findings)`);

  const map = here.style === there.style
    ? { place: null, entries: [], broken: 0, missing: true }
    : readMap(ROOT);
  if (here.style !== there.style) {
    console.log(map.missing
      ? `\nNo mapping file (expected: ${MAP_PLACES.join(' or ')}). `
        + 'Every finding therefore appears as only-here/only-there.'
      : `\nMapping: ${map.place}  (${map.entries.length} entries`
        + `${map.broken ? `, ${map.broken} broken lines` : ''})`);
  }

  const g = compare(here, there, map);
  console.log(`\nAgainst ${AGAINST}:`);
  console.log(`  Both houses:  ${g.both.length}`);
  for (const id of g.both) console.log(`  BOTH               ${id}`);
  // Three states, not two: "rightly absent over there" and "genuinely
  // missing over there" look identical as a count and are opposites.
  for (const e of [...g.explainedHere, ...g.explainedThere]) {
    if (!e.gap) continue;
    console.log(`  GAP in '${e.missingIn}'  ${e.name}${e.why ? `  — ${e.why}` : ''}`);
  }
  for (const e of g.explainedHere) {
    if (e.gap) continue;
    console.log(`  ONLY HERE, KNOWN   ${e.name}${e.why ? `  — ${e.why}` : ''}`);
  }
  for (const e of g.explainedThere) {
    if (e.gap) continue;
    console.log(`  ONLY THERE, KNOWN  ${e.name}${e.why ? `  — ${e.why}` : ''}`);
  }
  for (const n of g.onlyHere) console.log(`  ONLY HERE          ${n}  — unjudged: missing over there, or needs an entry`);
  for (const n of g.onlyThere) console.log(`  ONLY THERE         ${n}  — unjudged: missing here, or needs an entry`);
  for (const s of g.stale) {
    console.log(`  MAPPING INTO VOID  ${s.id}  field '${s.field}': '${s.name}' does not (any longer) `
      + `exist in ${s.root} (${s.source}) — renamed or removed, entry stale`);
  }
  for (const i of g.incomplete) console.log(`  MAPPING INCOMPLETE ${i.id}  ${JSON.stringify(i.entry)}`);
  for (const a of g.ambiguous) {
    console.log(`  MAPPING AMBIGUOUS  field '${a.field}' name '${a.name}' -> ids ${a.ids.join(', ')}`);
  }
  const ag = mapsAgree(ROOT, path.resolve(AGAINST));
  if (ag.same === false) {
    console.log('  MAPPING DRIFTED    the copies in the two houses are no longer the '
      + 'same file — a copy allowed to drift is a second source of truth');
  } else if (ag.same === null) {
    console.log(`  MAPPING ONE-SIDED  ${ag.why} — not comparable, and that is not "same"`);
  }

  const open = g.onlyHere.length + g.onlyThere.length + g.stale.length
    + g.incomplete.length + g.ambiguous.length
    + (ag.same === true ? 0 : 1);
  if (!open) {
    console.log('  Every finding of both houses is judged — mapped or explained as '
      + 'one-sided — and no note points into empty space.');
  }
  process.exit(open ? 1 : 0);
}
