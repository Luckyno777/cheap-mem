// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The injection journal — what the retrieval hook actually put into a
 * turn, and what it did NOT put there.
 *
 * Why this has to exist: the hook injects, the raw capture throws
 * exactly that away again (`attachment:hook_additional_context`), and
 * after that nobody can say how much of the context window the memory
 * itself occupies. The one number the gauges need is the only one
 * missing.
 *
 * Two design decisions, both from rules that already hold here:
 *
 * 1. **The nothing is booked too.** A turn without an injection has a
 *    reason — question too short, no hit, everything under the
 *    threshold, index rebuilding. Book only the injections and "never
 *    searched" looks exactly like "searched and found nothing", which
 *    is the same confusion as an empty memory that reads like a fully
 *    answered one.
 *
 * 2. **Closed vocabulary.** {@link OCCASION} and {@link REASON} are
 *    lists, not free strings. A new reason is a decision and belongs
 *    in a diff.
 *
 * The journal is runtime state under `.pipeline/`, not in the repo: it
 * describes ONE machine and grows fast. Whoever wants to evaluate it
 * reads it where it was written — or ships the evaluation (not the raw
 * lines) by session post.
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendLine } from './append.mjs';

/** Where the journal lives, relative to the memory root. */
export const JOURNAL_FILE = path.join('.pipeline', 'injections.jsonl');

/** What the retrieval ran for. Closed list. */
export const OCCASION = Object.freeze({
  /** UserPromptSubmit — a person wrote something. */
  QUESTION: 'question',
  /** PreToolUse — before an edit/write, literal path lookup. */
  BEFORE_EDIT: 'before-edit',
  /**
   * PostToolUseFailure (matcher Bash|Edit|Write) — after a tool really
   * failed, before the second attempt (X2b). `bin/mem-after-failure`
   * books it. The swallowed failure (`mem-catch-fail`, PostToolUse) is
   * NOT booked here: it runs after every successful Bash call and one
   * line per run would be exactly the noise it was built against.
   */
  AFTER_ERROR: 'after-error',
  /**
   * SessionStart — the session began and the start hook put the core and
   * the recent context into it (X2b). A line means "the block was
   * delivered": `hits` is not counted for it and `bytes` stays `null`
   * (the hook prints in several pieces; not measured is not 0).
   */
  SESSION_START: 'session-start',
});

/**
 * Why nothing was injected. `null` means: it WAS injected.
 *
 * The order follows the hook, so one reason cannot mask an earlier one.
 */
export const REASON = Object.freeze({
  /** Question too short — "yes", "go on". No signal, not searched. */
  NO_SIGNAL: 'no-signal',
  /** Searched; the index was empty or held no matching drawers. */
  EMPTY: 'empty',
  /** Searched, hits found, all below the threshold. */
  TOO_WEAK: 'too-weak',
  /** The index had to be rebuilt and ran past the time limit. */
  REBUILD: 'rebuild',
  /** Already shown in this session and nothing new since. */
  ALREADY_SHOWN: 'already-shown',
  /** The retrieval did not run at all (switched off, no memory). */
  OFF: 'off',
  /**
   * The tool call was interrupted, not failed (`is_interrupt`): nobody
   * learns from an abort, and it is not a fault of the hook either.
   * Its own reason so it is not counted as `no-input` (X2b).
   */
  INTERRUPT: 'interrupt',
  /**
   * A failure arrived, but with no error text under any known field
   * name — the one outage the after-error hook can have (X2b).
   */
  NO_INPUT: 'no-input',
});

const REASONS = new Set(Object.values(REASON));
const OCCASIONS = new Set(Object.values(OCCASION));

/**
 * Build one journal line — without writing it.
 *
 * Separate from writing so the shape is testable without a file
 * system, and so the hook can still build it when writing fails.
 *
 * An unknown occasion or reason is NOT let through quietly: it becomes
 * `unknown` and shows up as such. A journal that carries every typo as
 * its own category counts wrong later.
 */
export function buildLine({
  ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  session = null,
  occasion = OCCASION.QUESTION,
  reason = null,
  bytes = 0,
  hits = 0,
  searched = null,
  sources = [],
  questionBytes = null,
  durationMs = null,
} = {}) {
  return {
    ts,
    session: session || null,
    occasion: OCCASIONS.has(occasion) ? occasion : 'unknown',
    reason: reason == null ? null : (REASONS.has(reason) ? reason : 'unknown'),
    // `null` = this writer cannot know what was injected (`mem find
    // --journal-session` books the question; the hook renders the text
    // afterwards). Not 0: an unmeasured occupancy must not read as none.
    bytes: bytes === null ? null : (Number.isFinite(bytes) ? Math.max(0, Math.round(bytes)) : 0),
    hits: Number.isFinite(hits) ? Math.max(0, Math.round(hits)) : 0,
    // How many entries the index held at all. `null` means "not
    // recorded" — deliberately not 0, or an empty memory cannot be
    // told apart from an unmeasured one.
    searched: Number.isFinite(searched) ? searched : null,
    // The locations, so the allocation can be worked out later: which
    // injected hit was actually touched afterwards.
    sources: Array.isArray(sources) ? sources.slice(0, 20).map(String) : [],
    question_bytes: Number.isFinite(questionBytes) ? questionBytes : null,
    // Wall time of the process that booked the line, from its start to
    // the booking (Bauplan P2; the latency budget reads this). `null`
    // means "not measured" — deliberately not 0: a line written before
    // this field existed, or by a writer that cannot time itself, must
    // not read as an instant hook.
    duration_ms: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
  };
}

/**
 * Append one line. Never fails outward: the journal is a measurement,
 * and a measurement must not stop what it measures. Returns `true` if
 * something was written.
 */
export function book(root, fields = {}) {
  if (!root) return false;
  const line = buildLine(fields);
  const where = path.join(root, JOURNAL_FILE);
  try {
    fs.mkdirSync(path.dirname(where), { recursive: true });
    appendLine(where, JSON.stringify(line) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the journal. Broken lines are COUNTED, not skipped — the same
 * rule that holds inside the memory itself.
 */
export function read(root, { file = null } = {}) {
  const where = file || path.join(root || '.', JOURNAL_FILE);
  let raw;
  try { raw = fs.readFileSync(where, 'utf8'); }
  catch { return { lines: [], broken: 0, present: false }; }
  const lines = [];
  let broken = 0;
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { lines.push(JSON.parse(l)); }
    catch { broken += 1; }
  }
  return { lines, broken, present: true };
}
