// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
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
import * as search from './search.mjs';

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

// ---------------------------------------------------------------------
// G1b: similar decisions WITHOUT a shared topic
//
// **The gap (gold case time-08, 2026-09-30).** Two decisions about one
// subject, the newer one written without `topic` and without
// `replaces_id`: nothing links them, so retrieval has no rule by which
// the newer one should win — and deliberately none is added there (a
// ranking rule on word overlap would decide by guess which ruling holds).
// The place the link CAN be made is the moment of writing: whoever
// writes the second decision knows whether it replaces the first. So at
// that moment — and only when there is no topic to find neighbours by —
// the two lexically closest decisions of the same drawer are shown, with
// the ready command to retire the old one.
//
// A note, not a verdict: "similar", never "contradicts". No model, no
// effect on retrieval, nothing written. Output only.
//
// **The threshold is measured, not guessed** (2026-09-30, every decision
// replayed in time order as if written without topic, corrections and
// tombstones not counted as writes):
//
//     reference corpus, 304 decisions      8 notes   2.6 %
//       (lucky-mem's real decision drawers, fields mapped to this shape)
//     gold world (bench/gold/world.jsonl)  1 of 18   exactly time-08
//
// On the same corpus a Jaccard floor of 0.20 gave 4.9 %, 0.35 lost the
// gold case itself. The brief's ceiling was ~5 %: a note on every tenth
// write is skipped within a week (same reasoning as the topic hint above).

/** At least this many shared content words... */
export const SIMILAR_MIN_SHARED = 2;
/** ...and at least this Jaccard overlap of the two word sets. */
export const SIMILAR_MIN_JACCARD = 0.25;
/** Two, not three: a note about "maybe this one", not a list. */
export const SIMILAR_MAX = 2;

/** The words a decision's SUBJECT is made of: title and choice, not the reasoning. */
export function subjectWords(e) {
  return new Set(search.contentWords([e?.title, e?.choice].filter(Boolean).join(' ')));
}

/** Shared words and Jaccard overlap of two word sets. */
export function overlap(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const union = a.size + b.size - shared;
  return { shared, jaccard: union ? shared / union : 0 };
}

/**
 * The lexically closest standing decisions of the same drawer, for a
 * decision that is about to be written WITHOUT a topic.
 *
 * Empty (and silent) when: not a decision; a topic is given (then the
 * topic hint above is the one that speaks); a `replaces_id` is given
 * (the writer already linked it); nothing passes the threshold.
 */
export function similarDecisions(root, type, data = {}, {
  project = null, except = null, tailBytes = TAIL_BYTES,
} = {}) {
  const none = { hits: [] };
  if (type !== 'decision') return none;
  if (String(data?.topic ?? '').trim()) return none;
  if (data?.replaces_id) return none;
  const mine = subjectWords(data);
  if (mine.size < SIMILAR_MIN_SHARED) return none;

  const tail = readTail(memory.logPath(root, type, project), tailBytes);
  if (!tail) return none;
  const entries = [];
  for (const zeile of tail.raw.split('\n')) {
    if (!zeile.trim()) continue;
    try { entries.push(JSON.parse(zeile)); } catch { /* a broken line is no neighbour */ }
  }
  const retired = memory.retiredMap(entries);
  const scored = [];
  for (const e of entries) {
    if (!e?.id || (except && e.id === except)) continue;
    if (!memory.holds(e, retired)) continue;
    const o = overlap(mine, subjectWords(e));
    if (o.shared >= SIMILAR_MIN_SHARED && o.jaccard >= SIMILAR_MIN_JACCARD) scored.push({ e, ...o });
  }
  // Closest first; on a tie the newer one, which is what the writer has
  // to place themselves against first.
  scored.sort((x, y) => y.jaccard - x.jaccard || String(y.e.ts).localeCompare(String(x.e.ts)));
  return { hits: scored.slice(0, SIMILAR_MAX).map((s) => s.e) };
}

/** The note, as lines. `newId` is the entry just written. */
export function similarHint(found, { newId = '<new-id>' } = {}) {
  if (!found?.hits?.length) return [];
  return [
    '',
    '  Similar decisions already stand (no topic given; word overlap only, not a verdict):',
    ...found.hits.map((e) => `    ${line(e)}`),
    '    If this one REPLACES it:',
    ...found.hits.map((e) => `      mem discard ${e.id} --why "replaced by ${newId}"`),
    '    If both hold side by side: do nothing. A shared --topic next time links them for recall.',
  ];
}
