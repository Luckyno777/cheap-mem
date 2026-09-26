/**
 * errorfile — the ONE module for "which file does this error concern".
 *
 * Ported from lucky-mem/src/fehlerdatei.mjs (F0, BAUPLAN-mem-admin_02.md
 * Block F): a doctor finding (`repetition`), a write-time hint and
 * auto-duty (`errorcontext.mjs`) all need the same answer to "which
 * file", and an answer rebuilt at each call site drifts — the same
 * lesson `global/pflichten.jsonl` id `kk035pdorf60` already paid for
 * once in the sibling house (post-liegt/briefkasten).
 *
 * **Precedence 1: an explicit `file`/`files` field.** If a session set
 * it, that is a STATEMENT, not a guess, and it wins outright.
 *
 * **Precedence 2: the path pattern.** No second pattern is invented
 * here — `src/pathcheck.mjs` already has one, bound to known root
 * directories, with a look-behind guard against reading a URL
 * (`https://example.org/src/foreign.mjs`) as a mention of
 * `src/foreign.mjs`. Same pattern, same finding: whoever checks a path
 * with `pathcheck.mentions()` gets no second opinion here.
 *
 * **What this does NOT cover.** An error with no path anywhere in its
 * text (a class like `concurrency` or `mishandling`, which is often
 * about a PROCESS, not a file) stays without a file — `files()` returns
 * `[]`, `file()` returns `null`. That is explicitly NOT a verdict of
 * "no file involved" but "not determinable" — callers (the doctor, the
 * write-time hint) must treat it as its own state, never as a hit with
 * zero results.
 */

import * as pathcheck from './pathcheck.mjs';

/** At most this many files per error — more would not be a finding any more. */
export const MAX_FILES = 3;

/**
 * All files this error names — explicit fields first, else the path
 * pattern over the whole entry (title, text, and whatever else is there).
 */
export function files(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const explicit = [];
  if (typeof entry.file === 'string' && entry.file.trim()) {
    explicit.push(entry.file.trim());
  }
  if (Array.isArray(entry.files)) {
    for (const f of entry.files) {
      if (typeof f === 'string' && f.trim()) explicit.push(f.trim());
    }
  }
  if (explicit.length) return [...new Set(explicit)].slice(0, MAX_FILES);
  return pathcheck.mentions(entry).slice(0, MAX_FILES);
}

/** The ONE file, when an answer needs one instead of a list. */
export function file(entry) {
  return files(entry)[0] ?? null;
}
