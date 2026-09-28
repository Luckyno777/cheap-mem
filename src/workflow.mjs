// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Workflows — a named sequence for a recurring task, and who said so.
 *
 * **Why this is not a new authority mechanism.** A workflow's `steps`
 * ARE an instruction, exactly the way a `procedure`'s `rule` is one —
 * see `src/procedure.mjs`'s own head comment for the danger this
 * collides with (memory output must stay DATA, never instructions).
 * Nothing here reasons about that question a second time: `isHuman` and
 * `complete` are re-exported from `procedure.mjs` unchanged, because a
 * second copy of the same check is a second place for it to drift out
 * of step with the first one. Only the FIELDS differ — a workflow
 * names a sequence of steps for a recurring task, a procedure names a
 * single rule.
 *
 * **No draft status.** A workflow is either issued by a human
 * (`issued_by` passes `isHuman`) or it is not written at all. An
 * agent that notices a recurring pattern can propose the CLI command
 * text for a human to run (see the design note in
 * `betrieb/WORKFLOW-BIBLIOTHEK.md` section 2.5) — it never gets a
 * write path of its own under a weaker status.
 *
 * **The bridge does not write this type**, for the identical reason
 * `procedure` is refused there — see `bin/mem-mcp`, the same `if`
 * that already refuses `procedure.TYPE`.
 *
 * **`references` never copies text.** A workflow points at the
 * procedures, skills, error classes and snippets it relies on by id or
 * name — never by pasting their content in. That is the same "one
 * truth in one place" rule `sammelband`/(cheap-mem's `duty`-adjacent
 * compendium idea) already leans on: whoever needs the full text of a
 * referenced entry reads it at its own id.
 */

import * as errorclass from './errorclass.mjs';
import * as procedure from './procedure.mjs';

/** The type name, written in exactly one place. */
export const TYPE = 'workflow';

/** Who can issue a workflow: a human. Identical rule to `procedure`. */
export const isHuman = procedure.isHuman;

/**
 * Complete the fields the way they should be stored.
 *
 * Identical to `procedure.complete`: stamps `issued_by` and, when the
 * agent that typed the entry differs from the human who issued it,
 * `on_instruction: true`. Nothing here is specific to a rule's text —
 * the function never looks at anything but `issued_by`/`agent`, so
 * reusing it is not a coincidence of shape, it is the same fact.
 */
export const complete = procedure.complete;

/** The closed set of kinds a `references` entry may name. */
export const REFERENCE_KINDS = Object.freeze(['procedure', 'skill', 'errorclass', 'snippet']);

/**
 * A reference is an id/name, never a copy of the target's text.
 *
 * Long strings are the signal something went wrong here: an id from
 * `memory.logEntry` is short, an error class name is one of twelve
 * fixed words (`errorclass.NAMES`) — nothing legitimate in this field
 * is long. 200 characters is generous headroom above the longest real
 * id this codebase produces, chosen so the check catches "somebody
 * pasted the rule text in" without ever catching a real id.
 */
const REFERENCE_MAX_CHARS = 200;

/**
 * Normalise `references` into `{ procedure: [...], skill: [...],
 * errorclass: [...], snippet: [...] }`, or `null` if the shape itself
 * is wrong (not an object, or an array).
 *
 * Unknown keys are dropped rather than rejected: a workflow entry
 * written by an older or newer build of this file should not become
 * unwritable over a key this version does not know about yet — the
 * conservative reading errs towards keeping the write, the same stance
 * `mem log`'s class-name warning takes.
 */
export function normaliseReferences(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const kind of REFERENCE_KINDS) {
    if (!Object.hasOwn(raw, kind)) continue;
    const v = raw[kind];
    const arr = Array.isArray(v) ? v : [v];
    out[kind] = arr.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  return out;
}

/**
 * Check `references` for the one thing that matters here: nothing in
 * it looks like copied text. Returns a list of problem strings — empty
 * means clean.
 */
export function checkReferences(raw) {
  const norm = normaliseReferences(raw);
  if (norm === null) {
    return ['references must be an object like '
      + '{procedure:[ids], skill:[ids], errorclass:[names], snippet:[ids]}'];
  }
  const problems = [];
  for (const [kind, values] of Object.entries(norm)) {
    for (const v of values) {
      if (v.length > REFERENCE_MAX_CHARS) {
        problems.push(`references.${kind} holds a value over ${REFERENCE_MAX_CHARS} characters — `
          + 'that looks like copied text, not an id/name. A workflow points at a '
          + `${kind}, it never copies its text.`);
      }
    }
  }
  return problems;
}

/** Turn `steps` (array or a single string) into a clean array. */
export function stepsOf(fields = {}) {
  const raw = fields.steps;
  if (Array.isArray(raw)) return raw.map((s) => String(s ?? '').trim()).filter(Boolean);
  const s = String(raw ?? '').trim();
  return s ? [s] : [];
}

/**
 * Check the fields before anything is written.
 *
 * Returns `{ ok, errors }`. Does not throw: the caller decides whether
 * that is an abort or a warning — same contract as `procedure.check`.
 */
export function check(fields = {}) {
  const problems = [];
  const title = String(fields.title ?? '').trim();
  const steps = stepsOf(fields);
  const by = String(fields.issued_by ?? '').trim();

  if (!title) problems.push('title missing — a workflow without a name is never found again');
  if (!steps.length) problems.push('steps missing — that is the sequence meant to be followed');
  if (!by) {
    problems.push('issued_by missing — a workflow without an author is an anonymous instruction');
  } else if (!isHuman(by)) {
    problems.push(`issued_by '${by}' is not a human. A sequence for all agents cannot come `
      + 'from one of them (allowed: owner, human:<name>).');
  }
  if (Object.hasOwn(fields, 'references')) {
    problems.push(...checkReferences(fields.references));
  }
  return { ok: problems.length === 0, errors: problems };
}

/**
 * The marking that precedes every display — mirrors
 * `procedure.mark`, one word different.
 */
export function mark(entry = {}) {
  const by = entry.issued_by ?? '(no author)';
  const day = String(entry.ts ?? '').slice(0, 10) || '(no date)';
  const how = entry.on_instruction ? `, written down by ${entry.agent ?? '?'}` : '';
  return `Workflow, issued by ${by} on ${day}${how}`;
}

/** Marking plus the numbered steps — for retrieval and `mem show`. */
export function display(entry = {}) {
  const head = mark(entry);
  const title = entry.title ? `${entry.title}\n` : '';
  const scope = entry.scope ? `  (applies to: ${entry.scope})\n` : '';
  const steps = Array.isArray(entry.steps)
    ? entry.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
    : String(entry.steps ?? '');
  return `${head}\n${title}${scope}${steps}`.trimEnd();
}

// Re-exported so a caller that already imported `workflow` for the
// closed error-class vocabulary does not also need `errorclass` —
// `references.errorclass` names are validated against this elsewhere
// (the CLI's `--on-class`-style gate), kept out of `check()` itself the
// same way `procedure.check` leaves `on_class` validation to `mem log`.
export const KNOWN_ERROR_CLASSES = errorclass.NAMES;
