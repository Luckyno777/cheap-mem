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

/** Fields that are ONE text; a number or a boolean is tolerated (older CLI parsers wrote `--title` without a value as `true`). */
const SCALAR_FIELDS = Object.freeze([
  'title', 'text', 'why', 'topic', 'class', 'choice', 'rejected', 'learning', 'duty', 'question', 'skill', 'rule',
  'fact', 'description', 'excerpt', 'body', 'key', 'value', 'file', 'owner', 'who', 'kind', 'from', 'to', 'by',
  'by_id', 'replaces_id', 'retires_id', 'closes_id', 'state', 'status', 'authority', 'agent', 'valid_from',
  'valid_until', 'due', 'due_date', 'until', 'deadline', 'address', 'language', 'version', 'test', 'when', 'scope',
  'family', 'subject', 'project', 'type', 'source', 'target', 'start_status', 'status_of', 'issued_by', 'on_instruction',
  'trigger_words', 'triggers', 'hash', 'author',
]);

/** Fields that must be a TEXT (string) and nothing else: they are compared and sorted (`localeCompare`, `slice`). */
const STRICT_TEXT_FIELDS = Object.freeze(['id', 'ts']);

/** Fields that are a list of texts (a single text is a one-word list and stays readable). */
const LIST_FIELDS = Object.freeze([
  'tags', 'symbols', 'asked', 'asked_as', 'asked-as', 'placeholders', 'files', 'used_by', 'error_ids', 'steps',
]);

const SCALAR = new Set(SCALAR_FIELDS);
const STRICT = new Set(STRICT_TEXT_FIELDS);
const LIST = new Set(LIST_FIELDS);

const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const what = (v) => (Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : typeof v);

/**
 * What is wrong with the shape of this entry, as one sentence naming the field, or `null` when it can be read.
 * Pure, no I/O. `null` / `undefined` as a value count as "not set".
 */
export function shapeProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  for (const [k, v] of Object.entries(entry)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('_')) {
      // `_source`, `_line`, `_type`, `_project`, ... are the READERS' own annotations: a stored line has none, and a
      // stored object there would crash the reader that trusts its own field (fuzz 2026-10-11: `_type`).
      if (!isScalar(v)) return `field '${k}' is ${what(v)}, expected: text (names with a leading underscore belong to the readers)`;
    } else if (STRICT.has(k)) {
      if (typeof v !== 'string') return `field '${k}' is ${what(v)}, expected: text`;
    } else if (SCALAR.has(k)) {
      if (!isScalar(v)) return `field '${k}' is ${what(v)}, expected: text`;
    } else if (LIST.has(k)) {
      if (!(typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))) {
        return `field '${k}' is ${Array.isArray(v) ? 'a list with non-text' : what(v)}, expected: a list of texts`;
      }
    }
  }
  return null;
}
