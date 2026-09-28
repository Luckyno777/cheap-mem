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
 *
 * **`references` accepts only the four known kinds — an unknown one is
 * REFUSED, not dropped.** An earlier draft of this file dropped a
 * key `check()` did not recognise, reasoning that an older/newer build
 * should not make an entry unwritable over a key it does not know
 * about yet. That is the wrong side of the trade for a field whose
 * whole job is "point at something real": a silently dropped kind
 * looks, to whoever wrote it, like it was recorded — and it was not.
 * `check()` reports it instead, the same way `pruefeVerweise` in the
 * German house always has.
 *
 * **Optional fields, wrong TYPE is an error, MISSING is not.**
 * `triggers`/`path_patterns`/`tool_patterns`/`tools` (when set) must be
 * arrays of non-empty strings, `source_proposal` (when set) must be a
 * string naming the id of the `thought`/proposal this workflow was
 * promoted from, and `scope` (when set) must be a string. None of the
 * four arrays is required — a later doctor finding judges whether a
 * workflow has ENOUGH of them to ever fire; this file only checks that
 * what is there is well-formed.
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
 * is wrong (not an object, an array, or carrying an unknown kind).
 *
 * An unknown key makes the WHOLE shape invalid — `check()` needs to
 * report it, and a partial normalisation that silently drops it would
 * leave `check()` with nothing left to complain about. See the head
 * comment for why this is a refusal now, not a drop.
 */
export function normaliseReferences(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((k) => !REFERENCE_KINDS.includes(k))) return null;
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
 * Check `references` for two things: every key is one of the four
 * known kinds, and nothing in it looks like copied text. Returns a
 * list of problem strings — empty means clean.
 */
export function checkReferences(raw) {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const unknown = Object.keys(raw).filter((k) => !REFERENCE_KINDS.includes(k));
    if (unknown.length) {
      return unknown.map((k) => `references.${k} is not a known kind `
        + `(allowed: ${REFERENCE_KINDS.join(', ')})`);
    }
  }
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

function isArrayOfStrings(x) {
  return Array.isArray(x) && x.every((s) => typeof s === 'string' && s.trim());
}

/**
 * The four optional match fields a later doctor finding reads to judge
 * whether a workflow has enough of them to ever fire — `check()` only
 * verifies their SHAPE, not their sufficiency. See the head comment.
 */
export const OPTIONAL_ARRAY_FIELDS = Object.freeze(['triggers', 'path_patterns', 'tool_patterns', 'tools']);

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
  for (const field of OPTIONAL_ARRAY_FIELDS) {
    if (fields[field] !== undefined && !isArrayOfStrings(fields[field])) {
      problems.push(`${field} must, when set, be an array of non-empty strings`);
    }
  }
  if (fields.source_proposal !== undefined && typeof fields.source_proposal !== 'string') {
    problems.push('source_proposal must, when set, be a string (an id)');
  }
  if (fields.scope !== undefined && typeof fields.scope !== 'string') {
    problems.push('scope must, when set, be a string');
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
