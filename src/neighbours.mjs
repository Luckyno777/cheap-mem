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
import fs from 'node:fs';
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
 * How much of the drawer's END this hint is allowed to read.
 *
 * **Why a bound at all.** This ran a full `readLog` — every line of the
 * drawer parsed — before every single write, and it is a HINT, not a
 * correctness check. Measured 2026-09-20: 2.3 ms at 1,000 rows, 15.9 ms
 * at 10,000, 205.6 ms at 100,000. Fitted exponent 0.96: the cost of
 * writing one entry grew with everything already written, which is the
 * shape this whole build plan exists to remove.
 *
 * **Why the tail is the right bound, and why it stays correct.** A
 * tombstone is always appended AFTER the entry it retires. So if an
 * entry is inside the tail, its tombstone is inside the tail too, and
 * the retired-filter cannot wrongly report a withdrawn ruling as still
 * standing. The bound can only make the hint miss an OLD neighbour — it
 * cannot make it show a false one.
 *
 * **And a missed neighbour must not look like no neighbour.** That is
 * the whole reason `scannedWholeFile` travels with the result: when the
 * scan was partial and found nothing, the hint says what it looked at
 * instead of implying the subject is new. A silent nothing is the one
 * answer this house does not allow.
 *
 * 512 KB is roughly 3,000 entries at the 166 B/entry measured in the
 * real drawers — comfortably more than the "last few" anyone reads a
 * hint for, and a flat cost from there on.
 */
export const TAIL_BYTES = 512 * 1024;

/**
 * The last `TAIL_BYTES` of a drawer, as whole lines.
 *
 * The first line of a mid-file read is almost always cut in half, so it
 * is dropped — never parsed and never counted. Dropping it is safe
 * precisely because it is the OLDEST line in the window: the newest
 * entries, which is what a hint is about, are at the other end.
 */
function readTail(absPath, tailBytes = TAIL_BYTES) {
  let size;
  try { size = fs.statSync(absPath).size; } catch { return null; }
  if (size <= tailBytes) {
    // Small enough to read whole: no window, no partial answer.
    try { return { raw: fs.readFileSync(absPath, 'utf8'), whole: true }; }
    catch { return null; }
  }
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(tailBytes);
    fs.readSync(fd, buf, 0, tailBytes, size - tailBytes);
    const text = buf.toString('utf8');
    const cut = text.indexOf('\n');
    return { raw: cut >= 0 ? text.slice(cut + 1) : '', whole: false };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * The neighbours of an entry that is not written yet.
 *
 * Reads only. Retired entries (superseded/done/discarded) stay out: a
 * withdrawn ruling is not a neighbour but history, and showing it would
 * weigh the writer against something that no longer holds.
 */
export function neighbours(root, type, data = {}, {
  project = null, except = null, tailBytes = TAIL_BYTES,
} = {}) {
  const field = SUBJECT_FIELD[type];
  if (!field) return { field: null, value: null, hits: [] };
  const value = String(data?.[field] ?? '').trim();
  if (!value) return { field, value: null, hits: [] };
  const same = value.toLowerCase();

  // Only the tail of the drawer, for the reasons on `TAIL_BYTES`.
  const abs = memory.logPath(root, type, project);
  const tail = readTail(abs, tailBytes);
  if (!tail) return { field, value, hits: [], scannedWholeFile: false, unreadable: true };
  const res = { entries: [] };
  let broken = 0;
  for (const zeile of tail.raw.split('\n')) {
    if (!zeile.trim()) continue;
    try { res.entries.push(JSON.parse(zeile)); }
    catch { broken += 1; res.entries.push({ __broken: true, raw: zeile }); }
  }

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
  return {
    field,
    value,
    hits: hits.slice(0, MAX),
    more: Math.max(0, hits.length - MAX),
    // What the hint looked at. Carried on every result, not only the
    // partial ones, so a reader never has to guess whether the field
    // was simply forgotten.
    scannedWholeFile: tail.whole,
    scannedEntries: res.entries.length,
    // **Nothing in a clean drawer should land here.** A window read
    // lands mid-line almost every time, and the half-line it starts on
    // is dropped before parsing. If this is ever non-zero on a drawer
    // with no genuinely corrupt lines, the drop stopped working — and
    // the symptom would otherwise be invisible, because the
    // `__broken` filter below quietly discards such a line anyway.
    // Invisible is exactly how a window bug survives.
    brokenInWindow: broken,
  };
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
  // **Nothing found, and only part of the drawer read.** This is the
  // one case the bound could turn into a lie: silence would read as
  // "nothing stands under this subject yet", when the truth is "nothing
  // stands under it RECENTLY". Say which.
  if (!found?.hits?.length) {
    if (found && found.value && found.scannedWholeFile === false) {
      return ['', `  Nothing under ${found.field} '${found.value}' in the last `
        + `${found.scannedEntries} entries of this drawer (older ones not read).`];
    }
    return [];
  }
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
