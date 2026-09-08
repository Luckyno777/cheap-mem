// src/guard.mjs — a recorded error becomes a latch.
//
// **The finding (2026-09-08, reference deployment).** 289 classified
// errors, 42 classes recurring, 124 entries (43 %) in repeat classes —
// and spread over DAYS, so not one bad session: `secret-leak` on four
// different days, `silent-failure` on three across a week.
//
// The class warning ("the Nth time") fires while LOGGING, i.e. after
// the error. It counts, it does not prevent. A memory that only
// records errors is a diary; a latch is what turns it into experience.
//
// --- Why NOT a shell command -----------------------------------------
//
// The obvious design is "a command that exits non-zero". That would be
// a serious hole: an entry is DATA, and whoever types `mem guard run`
// would then be executing somebody else's code. A connected agent logs
// errors — so it could drop arbitrary code on the owner's machine and
// wait for the latches to be checked. Same class as an
// instruction-shaped memory entry, only worse, because it is execution
// rather than persuasion.
//
// So: a CLOSED vocabulary, like LINK_KINDS. It executes nothing, it
// reads files. Most latches are a grep anyway. If the vocabulary is not
// enough, that is a decision somebody makes — not a gap somebody finds.

import fs from 'node:fs';
import path from 'node:path';

/** The latch kinds. Closed, for the same reason as LINK_KINDS. */
export const GUARD_KINDS = Object.freeze({
  absent: 'the pattern must NOT appear in the file',
  present: 'the pattern must appear',
  'file-there': 'the file must exist',
  'file-gone': 'the file must not exist',
});

/** How much file is read at most. A latch must never be expensive. */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Check one latch. Returns `{ state, why }`.
 *
 * `state` is `green` (condition held), `red` (the error is back) or
 * `broken` (the latch itself is no good).
 *
 * `broken` is explicitly NOT `green`. A latch pointing at a deleted
 * file has checked NOTHING — reporting that as "fine" would be exactly
 * the class this repo is built against.
 */
export function check(guard, { root = process.cwd() } = {}) {
  if (!guard || typeof guard !== 'object') return { state: 'broken', why: 'not a latch' };
  const kind = String(guard.kind ?? '');
  if (!Object.hasOwn(GUARD_KINDS, kind)) {
    return { state: 'broken', why: `unknown kind '${kind}' — known: ${Object.keys(GUARD_KINDS).join(', ')}` };
  }
  const rel = String(guard.path ?? '');
  if (!rel) return { state: 'broken', why: 'no path' };
  // No escaping the root. A latch reads inside the memory or the
  // project, not in /etc/shadow.
  const target = path.resolve(root, rel);
  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
    return { state: 'broken', why: `path points outside the root: ${rel}` };
  }

  const there = fs.existsSync(target);
  if (kind === 'file-there') {
    return there ? { state: 'green', why: `${rel} is there` } : { state: 'red', why: `${rel} is missing` };
  }
  if (kind === 'file-gone') {
    return there ? { state: 'red', why: `${rel} is back` } : { state: 'green', why: `${rel} is gone, as intended` };
  }

  if (!there) return { state: 'broken', why: `${rel} does not exist — the latch checks nothing` };
  const pattern = String(guard.pattern ?? '');
  if (!pattern) return { state: 'broken', why: 'no pattern' };

  let content;
  try {
    const size = fs.statSync(target).size;
    if (size > MAX_BYTES) {
      return { state: 'broken', why: `${rel} is ${(size / 1024 / 1024).toFixed(1)} MB — too large for a latch` };
    }
    content = fs.readFileSync(target, 'utf8');
  } catch (e) { return { state: 'broken', why: `${rel} not readable: ${e.message}` }; }

  // Literal text, not a regular expression. Reading a pattern out of an
  // entry as a regex would be the next execution hole — a crafted
  // pattern can make a match run arbitrarily long.
  const hit = content.includes(pattern);
  if (kind === 'absent') {
    return hit
      ? { state: 'red', why: `'${pattern}' is back in ${rel}` }
      : { state: 'green', why: `'${pattern}' does not occur in ${rel}` };
  }
  return hit
    ? { state: 'green', why: `'${pattern}' is in ${rel}` }
    : { state: 'red', why: `'${pattern}' is missing from ${rel}` };
}

/**
 * Every latch in the memory, with its entry.
 *
 * Only `error` entries carry one: a latch is the answer to an error,
 * not to a thought.
 */
export function all(root, { readLog, listProjects }) {
  const out = [];
  for (const project of [null, ...listProjects(root)]) {
    let res;
    try { res = readLog(root, 'error', { project }); } catch { continue; }
    for (const e of res.entries) {
      if (e.__broken || !e.guard) continue;
      out.push({ entry: e, project, guard: e.guard });
    }
  }
  return out;
}
