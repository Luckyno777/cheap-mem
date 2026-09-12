/**
 * What already stands about this subject — shown AT WRITE TIME.
 *
 * **The brief was "conflict at write time instead of read time".
 * Measured, and in that form NOT built.** The obvious rule would be:
 * same `topic`, different `choice` -> conflict, so warn. Checked
 * against the reference corpus on 2026-09-08:
 *
 *     108 decisions, 103 topics
 *     5 topics carry more than one decision with a different choice
 *     of those, actually contradictory: 0
 *
 * All five are FOLLOW-UP decisions under a coarse topic — two rulings
 * about different sides of one thing, neither overriding the other. The
 * rule would have produced five false alarms out of five, and a warning
 * that is always wrong teaches people to skip warnings.
 *
 * **What remains, and why it is the useful half.** In all five cases
 * the writer would have liked to SEE what already stands under the
 * topic — to judge for themselves, not to be corrected. So: a note, not
 * a verdict. It names what is there and the commands that resolve the
 * case. Whoever wants neither types nothing.
 *
 * The hit density is the actual justification: 5 of 108 writes, 4.6 %.
 * A hint that appears on every second entry is invisible within a week;
 * one that appears every twenty entries gets read.
 */
import * as memory from './memory.mjs';

/**
 * Which field makes two entries "about the same subject".
 *
 * A closed vocabulary, not an open one: if it were any field, every
 * caller would find a different neighbourhood and the hint would mean
 * something different depending on who asked.
 */
export const SUBJECT_FIELD = Object.freeze({
  decision: 'topic',
  thought: 'topic',
  learning: 'topic',
  procedure: 'scope',
  timeline: 'key',
});

/** At most this many neighbours. More would be a list, not a note. */
export const MAX = 3;

/**
 * The neighbours of an entry that is not written yet.
 *
 * Reads only. Retired entries (superseded/done/discarded) stay out: a
 * withdrawn ruling is not a neighbour but history, and showing it would
 * weigh the writer against something that no longer holds.
 */
export function neighbours(root, type, data = {}, { project = null, except = null } = {}) {
  const field = SUBJECT_FIELD[type];
  if (!field) return { field: null, value: null, hits: [] };
  const value = String(data?.[field] ?? '').trim();
  if (!value) return { field, value: null, hits: [] };
  const same = value.toLowerCase();

  let res;
  try { res = memory.readLog(root, type, { project }); }
  catch { return { field, value, hits: [] }; }

  // **`readLog` does NOT filter.** It hands back the raw lines,
  // tombstones and retired entries included, and never sets a "retired"
  // marker — that is `find`'s job. A first version of this asked for
  // such a marker and therefore looked right while filtering nothing: a
  // discarded ruling would have gone on counting as a neighbour. The
  // test found it, not a reading of the code.
  const retired = memory.retiredMap(res.entries);

  const hits = [];
  for (const e of res.entries) {
    if (e.__broken || !e.id) continue;
    if (!memory.holds(e, retired)) continue;
    if (except && e.id === except) continue;
    if (String(e[field] ?? '').trim().toLowerCase() !== same) continue;
    hits.push(e);
  }
  // Newest first: what was ruled last is what the writer has to place
  // themselves against first.
  hits.reverse();
  return { field, value, hits: hits.slice(0, MAX), more: Math.max(0, hits.length - MAX) };
}

/** One line per neighbour. Short — it is a note, not a report. */
export function line(e) {
  const core = e.choice ?? e.rule ?? e.title ?? e.value ?? e.text ?? '';
  return `${String(e.ts ?? '').slice(0, 10)}  ${String(e.id).padEnd(14)} `
    + String(core).replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * The whole hint, as lines. Empty when there is nothing to say.
 *
 * **No verdict.** It never says "this contradicts" — this code does not
 * know that and cannot. It says what is there, and what you CAN do.
 */
export function hint(found) {
  if (!found?.hits?.length) return [];
  const lines = [
    '',
    `  Something already stands under ${found.field} '${found.value}':`,
    ...found.hits.map((e) => `    ${line(e)}`),
  ];
  if (found.more) lines.push(`    (and ${found.more} more)`);
  lines.push(
    '    If this REPLACES the old state:  --replaces_id <id>',
    '    If both hold side by side: do nothing.',
    '    If they CONTRADICT:  mem log link --from <new> --to <id> --kind contradicts');
  return lines;
}
