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
 * **The rule is inverted (coordinator, 2026-10-12; the same in lucky-mem).** A field the readers touch that this file does
 * not name still crashed them (the search field weights, the subject field per type). So EVERY top-level field is judged:
 * a value is a string, a number, a boolean, null, or a LIST of those - an object is wrong. The exceptions are named:
 * `STRUCTURED_FIELDS` may hold objects (`origin`, `provenance`, `guard`, `chain_seal`, ...); the list comes from real data
 * (what the CLI writes for every type, the fixtures and the bench corpora) and a test keeps it honest. On top of that the
 * prose fields are text, `id` and `ts` are text, and the list fields are lists of texts. Nothing nests deeper than 32 levels.
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
  'fact', 'description', 'excerpt', 'body', 'key', 'file', 'owner', 'who', 'kind', 'from', 'to',
  'by_id', 'replaces_id', 'retires_id', 'closes_id', 'state', 'status', 'authority', 'agent', 'valid_from',
  'valid_until', 'address', 'language', 'when', 'scope',
  'family', 'subject', 'project', 'type', 'source', 'target', 'start_status', 'status_of', 'issued_by',
  'hash', 'author',
]);

/** The few scalars that are not prose: a number, a boolean or a text. Never an object or a list. */
const LOOSE_SCALAR_FIELDS = Object.freeze(['value', 'version', 'test', 'on_instruction']);

/** Fields that must be a TEXT (string) and nothing else, and are also the ones sorted by `localeCompare`. */
const STRICT_TEXT_FIELDS = Object.freeze(['id', 'ts']);

/**
 * The fields that may hold an OBJECT (or a list of objects) - everything else holds a scalar or a list of scalars. Derived
 * from what is really written: the CLI for every type, the test fixtures, the bench corpora (test/field-shape-audit.test.mjs
 * writes every type through the real CLI and asserts that none of its lines is broken).
 */
const STRUCTURED_FIELDS = Object.freeze([
  'origin', 'provenance', 'guard', 'chain_seal', 'body_enc', 'references', 'asked_evidence',
]);
const STRUCTURED = new Set(STRUCTURED_FIELDS);

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

/** An entry is not nested deeper than this (`origin.derived_from` is two levels; the same number in lucky-mem): a nesting bomb overflows every recursive reader. */
const MAX_DEPTH = 32;

/** Keys that make an object turn into text or a prototype by themselves: a line that carries one anywhere is wrong. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'toJSON', 'toLocaleString', 'hasOwnProperty']);

/**
 * What is wrong with the STRUCTURE of `value` (anywhere inside it): nested deeper than `max` levels, or an object key that
 * would make it convert itself (`toString`, `valueOf`, ...). Iterative on purpose: this check must not overflow itself.
 */
function structureProblem(value, max) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (d >= max) return `nested deeper than ${max} levels`;
    if (!Array.isArray(v)) {
      for (const k of Object.keys(v)) if (FORBIDDEN_KEYS.has(k)) return `has the key '${k}', which would turn the object into text or a prototype`;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (x !== null && typeof x === 'object') stack.push([x, d + 1]);
  }
  return null;
}

/** A list flag that carries no list: `true` / `false` / a number (written by `--tags` without a value). */
const isNoList = (v) => typeof v === 'boolean' || typeof v === 'number';

/**
 * What is wrong with the shape of this entry, as one sentence naming the field, or `null` when it can be read.
 * Pure, no I/O. `null` / `undefined` as a FIELD value count as "not set"; an entry that is itself not an object is wrong.
 */
export function shapeProblem(entry) {
  // A line that is not an object at all (`null`, a number, a text, a boolean, a list) is no entry: every reader that
  // opens a field of it ("Cannot read properties of null") crashed on it (second review 2026-10-12, 43 of 85 read commands).
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `the line is ${entry === null ? 'null' : Array.isArray(entry) ? 'a list' : `a ${typeof entry}`}, expected: a JSON object`;
  }
  for (const [k, v] of Object.entries(entry)) {
    if (v === null || v === undefined) continue;
    if (k === 'asked_evidence') {
      // the paraphrase learner's records: a LIST of objects (`mem asked-learn`, `mem gold miss` iterate it; a number or an object
      // there ended in "not iterable", second review 2026-10-12)
      if (!(Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x)))) {
        return `field 'asked_evidence' is ${Array.isArray(v) ? 'a list with non-objects' : what(v)}, expected: a list of records`;
      }
      continue;
    }
    if (STRUCTURED.has(k)) continue; // may hold an object; the depth cap above covers it
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
    } else if (!isScalar(v) && !(Array.isArray(v) && v.every(isScalar))) {
      // a field this file does not name: a scalar or a list of scalars, never an object (the inverted rule)
      return `field '${k}' is ${Array.isArray(v) ? 'a list with objects or lists in it' : what(v)}, expected: a text, a number, a boolean or a list of those (an object is only allowed in ${STRUCTURED_FIELDS.join(', ')})`;
    }
  }
  // last, so a message that names the field wins; this one catches what hides inside a structured field
  return structureProblem(entry, MAX_DEPTH);
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
