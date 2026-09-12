/**
 * Re-presentation — a pointer instead of silence.
 *
 * The before-edit hook used to show a file's memory ONCE per session.
 * The second edit on the same file got nothing. That is not neutral:
 * silence reads as "there is nothing in the memory about this file",
 * and that was wrong — there was something, it had just been shown.
 * An omission without a note is a false statement by other means.
 *
 * Worse: when a NEW error about the same file is logged during the
 * session (the normal case while working on a file), the mark hides it
 * until the session ends.
 *
 * So three states instead of two:
 *
 *   show     never shown, the full block
 *   pointer  unchanged, one line of back-reference
 *   fresh    something arrived since, the full block again
 *
 * ## Why a watermark and not a timestamp
 *
 * "Unchanged" can only be proven by looking. The lookup costs a
 * measured ~145 ms; paying that before every edit is the wrong price.
 *
 * The shortcut is not a guess, though — it follows from how this is
 * built: the memory is APPEND-ONLY. Content can only change by
 * growing. If the sum of the book sizes is the same, the result CANNOT
 * be different — the pointer is then proven, not assumed. If it grew,
 * we look, and only the fingerprint decides (an entry about a
 * different file changes nothing about this answer).
 *
 * ## Fail closed
 *
 * A broken or unreadable mark leads to `show`, not to `pointer`.
 * Showing too much costs context; showing too little costs a mistake
 * that has already happened once.
 */

import fs from 'node:fs';
import path from 'node:path';

/** What to do. Closed list. */
export const ACTION = Object.freeze({
  SHOW: 'show',
  POINTER: 'pointer',
  FRESH: 'fresh',
});

/** Directories that do not count towards the watermark. */
const OUTSIDE = new Set(['.git', '.pipeline', 'raw', 'node_modules', '.github']);

/**
 * The memory's watermark: the sum of the book sizes.
 *
 * Only `.jsonl` — the append-only books. `facts.yaml` and the prose
 * files are deliberately NOT counted: they are overwritten rather than
 * appended to, so they can stay the same size and still change.
 * Counting them would look more thorough and be unprovable.
 */
export function watermark(root) {
  let bytes = 0;
  let files = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (OUTSIDE.has(e.name)) continue;
      const w = path.join(dir, e.name);
      if (e.isDirectory()) { walk(w, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try { bytes += fs.statSync(w).size; files += 1; } catch { /* gone is gone */ }
    }
  };
  walk(root, 0);
  return { bytes, files };
}

/** Short, stable fingerprint. For recognition only, never for security. */
export function fingerprint(text) {
  let h = 5381;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Decide, without reading or writing anything.
 *
 * `newFingerprint` may be `null` — then nothing was looked up because
 * the watermark did not move. That is the cheap path and the common
 * one.
 */
export function decide({ mark = null, levelNow = 0, newFingerprint = null } = {}) {
  if (!mark || typeof mark !== 'object') return { action: ACTION.SHOW, why: 'first-time' };
  if (!Number.isFinite(mark.level) || typeof mark.fingerprint !== 'string') {
    // Broken mark: show. The expensive side is the safe one.
    return { action: ACTION.SHOW, why: 'mark-broken' };
  }
  if (mark.level === levelNow) return { action: ACTION.POINTER, why: 'watermark-equal' };
  if (newFingerprint == null) {
    // Grew, but not checked: then we do not know, and the unknown is
    // shown rather than withheld.
    return { action: ACTION.SHOW, why: 'grew-unchecked' };
  }
  if (newFingerprint === mark.fingerprint) return { action: ACTION.POINTER, why: 'content-equal' };
  return { action: ACTION.FRESH, why: 'content-differs' };
}

/** Read a mark. Unreadable or broken yields `null` — see fail-closed. */
export function readMark(where) {
  try { return JSON.parse(fs.readFileSync(where, 'utf8')); }
  catch { return null; }
}

/** Write a mark. Never fails outward. */
export function writeMark(where, { level = 0, fingerprint: f = '', shown = 0 } = {}) {
  try {
    fs.mkdirSync(path.dirname(where), { recursive: true });
    fs.writeFileSync(where, JSON.stringify({ level, fingerprint: f, shown }));
    return true;
  } catch { return false; }
}

/**
 * The one line that replaces the block.
 *
 * It has to say three things or it is as bad as silence: WHAT there
 * was, WHEN it came (in this session), and that it STILL HOLDS.
 */
export function pointerLine({ pathName = '', count = 0 } = {}) {
  return `From memory about '${pathName}': ${count} entr${count === 1 ? 'y' : 'ies'} — `
    + 'already injected in this session and unchanged. '
    + `To see it again: mem component "${pathName}"`;
}
