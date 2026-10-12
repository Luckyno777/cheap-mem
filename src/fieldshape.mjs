// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * fieldshape — which SHAPE a field of a log line may have when it is READ
 * (Fable security run 2026-10-11, ported from lucky-mem's `feldformen.mjs`,
 * their error 5katltp7cfkr).
 *
 * **The finding.** A line whose text field is an OBJECT (`tags: {toString: "x"}`,
 * `owner: {a: 1}`, `title: {…}`) or whose `ts` is a number crashed every reader
 * that concatenates, compares or lower-cases the field: `mem find`, `mem context`,
 * `mem duties`, `mem viewer`, the recall hooks and `mem doctor` ended in "Cannot
 * convert object to primitive value" or "localeCompare is not a function" — for
 * everyone, and a tombstone did not heal it (the line is read all the same). One
 * `mem_log` of a foreign agent could do it before the bridge refused such values
 * (`bridgefields.logFieldShape`); a raw line written by hand, by a merge or by an
 * old CLI still can.
 *
 * **Two sides, one rule.** The bridge refuses such a value LOUDLY when writing. This
 * module is the other side: the readers (`memory.parseLine`) never let such a line
 * through as an entry, but report it as BROKEN (`{__broken: true, raw, reason}` — the
 * three-states rule: neither swallowed silently nor counted as healthy). The reader
 * side is the real safety net, because the CLI, old lines and a merge never meet the
 * bridge's gate.
 *
 * Only fields the house knows as text or as a list of text are judged, by NAME. Every
 * other field (`origin`, `provenance`, `guard`, `seal`, `refs`, …) is a legitimate
 * object and is not touched here.
 *
 * A leaf module on purpose: no imports.
 */

/**
 * Fields that are ONE text. A text field is TEXT (review 2026-10-12): a number or a boolean there crashed `context`, `core`,
 * `facts`, `viewer`, `today` and the dashboard ("localeCompare / slice is not a function") while the doctor stayed ok, and
 * the CLI itself wrote `"key": true` when `--key` had no value. Such a line is broken now, like one with an object there.
 */
const TEXT_FIELDS = Object.freeze([
  'title', 'text', 'why', 'topic', 'class', 'choice', 'learning', 'duty', 'question', 'skill', 'rule',
  'fact', 'description', 'excerpt', 'body', 'key', 'file', 'owner', 'who', 'kind', 'from', 'to', 'by',
  'by_id', 'replaces_id', 'retires_id', 'closes_id', 'state', 'status', 'authority', 'agent', 'valid_from',
  'valid_until', 'due', 'due_date', 'until', 'deadline', 'address', 'language', 'when', 'scope',
  'family', 'subject', 'project', 'type', 'source', 'target', 'start_status', 'status_of', 'issued_by',
  'hash', 'author',
]);

/** The few scalars that are not prose: a number, a boolean or a text. Never an object or a list. */
const LOOSE_SCALAR_FIELDS = Object.freeze(['value', 'version', 'test', 'on_instruction']);

/** Fields that must be a TEXT (string) and nothing else, and are also the ones sorted by `localeCompare`. */
const STRICT_TEXT_FIELDS = Object.freeze(['id', 'ts']);

/**
 * Fields that are a list of texts (a single text is a one-word list and stays readable). A list flag WITHOUT a value
 * (`--tags` alone) was written as `true` by older CLIs: that is no shape error, the line is read with an EMPTY list there
 * and the doctor warns about it (`legacyLists`). The write side refuses it now.
 */
const LIST_FIELDS = Object.freeze([
  'tags', 'symbols', 'asked', 'asked_as', 'asked-as', 'placeholders', 'files', 'used_by', 'error_ids', 'steps',
  // a workflow's match lists and a procedure's classes (a comma-separated text or a list, see workflow.OPTIONAL_ARRAY_FIELDS)
  'triggers', 'trigger_words', 'path_patterns', 'tool_patterns', 'tools', 'on_class',
  // what a decision turned down: `--rejected a,b` is stored as a list
  'rejected',
]);

const TEXT = new Set([...TEXT_FIELDS, ...STRICT_TEXT_FIELDS]);
const LOOSE = new Set(LOOSE_SCALAR_FIELDS);
const LIST = new Set(LIST_FIELDS);

const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const what = (v) => (Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : typeof v);

/** An entry is not nested deeper than this (`origin.derived_from` is two levels): a nesting bomb overflows every recursive reader. */
const MAX_DEPTH = 64;

/** Is anything inside `value` nested deeper than `max` levels? Iterative on purpose: this check must not overflow itself. */
function deeperThan(value, max) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (d >= max) return true;
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (x !== null && typeof x === 'object') stack.push([x, d + 1]);
  }
  return false;
}

/** A list flag that carries no list: `true` / `false` / a number (written by `--tags` without a value). */
const isNoList = (v) => typeof v === 'boolean' || typeof v === 'number';

/**
 * What is wrong with the shape of this entry, as one sentence naming the field, or `null` when it can be read.
 * Pure, no I/O. `null` / `undefined` as a value count as "not set".
 */
export function shapeProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (deeperThan(entry, MAX_DEPTH)) return `nested deeper than ${MAX_DEPTH} levels`;
  for (const [k, v] of Object.entries(entry)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('_')) {
      // `_source`, `_line`, `_type`, `_project`, ... are the READERS' own annotations: a stored line has none, and a
      // stored object there would crash the reader that trusts its own field (fuzz 2026-10-11: `_type`).
      if (!isScalar(v)) return `field '${k}' is ${what(v)}, expected: text (names with a leading underscore belong to the readers)`;
    } else if (TEXT.has(k)) {
      if (typeof v !== 'string') return `field '${k}' is ${what(v)}, expected: text`;
    } else if (LOOSE.has(k)) {
      if (!isScalar(v)) return `field '${k}' is ${what(v)}, expected: text`;
    } else if (LIST.has(k)) {
      if (isNoList(v)) continue; // legacy: see `legacyLists`
      if (!(typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))) {
        return `field '${k}' is ${Array.isArray(v) ? 'a list with non-text' : what(v)}, expected: a list of texts`;
      }
    }
  }
  return null;
}

/** Is `name` a field that must be text (a number or a boolean there is wrong)? The bridge uses it when writing. */
export function isTextField(name) {
  return TEXT.has(name);
}

/** The list fields of this entry that carry no list (`tags: true`): their names, or `[]`. */
export function legacyLists(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  return Object.entries(entry).filter(([k, v]) => LIST.has(k) && isNoList(v)).map(([k]) => k);
}

/** The same entry with every such field read as an empty list (a copy; the entry itself when there is none). */
export function withoutListFlags(entry) {
  const bad = legacyLists(entry);
  if (!bad.length) return entry;
  const copy = { ...entry };
  for (const k of bad) copy[k] = [];
  return copy;
}
