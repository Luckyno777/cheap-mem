// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bridgefields — which fields a connected foreign agent may write into an
 * entry over the MCP bridge (`mem_log`). A list of ALLOWED fields per type,
 * not a block-list.
 *
 * **Why allowed instead of blocked (security cross-check 2026-10-10, ported
 * from lucky-mem's `bruecke-felder.mjs`; its F01 was a field the block-list
 * had forgotten).** `bin/mem-mcp` used to pass every key except
 * `type/project/tags/agent/id/ts` on, and `memory.logCheckedEntry` writes
 * every non-machine key and passes the machine keys (`MACHINE_FIELDS`:
 * `state`, `status`, `v`, `authority_clamped_from`, `guard_at_creation`, ...)
 * through as stamps. A block-list is as good as its author's memory: every
 * field that later gets an effect somewhere in the house (`shred` switches
 * the write to an encrypted body, `body_enc` / `shredded_of` mimic that
 * state, `command_pattern`-like guards, audit stamps) would be open to the
 * bridge at once. Here it is the other way round: what is not expressly
 * listed is REFUSED, LOUDLY, with the field names and the list of what is
 * allowed, and nothing is written. Never silently dropped.
 *
 * **Where the lists come from.** The body fields per type
 * (`bodyfields.BODY_FIELDS_BY_TYPE`, a test pins that every one is allowed),
 * the access words the indexer weights (`topic`, `class`, `tags`, `symbols`,
 * `asked_as`), the validity dates, the fields the type readers and validators
 * look at (`snippet.check`, `errorfile.files`, the timeline's `key`/`value`,
 * the duty's `owner`), and the calls the existing tests make over the bridge.
 *
 * **What is missing is on purpose.** A field that is not here is written by a
 * human at the CLI or by code: audit stamps (`v`, `authority_clamped_from`,
 * `guard_at_creation`, `status`), the state words `state` / `by_id` without a
 * counterpart id, the write-time switch `shred` and the fields it leaves
 * (`body_enc`, `shredded_of`), the content hash of a source. Whoever needs a
 * field that is missing adds it HERE, in the diff, with a reason.
 *
 * **The counterpart ids stay.** `replaces_id` and `retires_id` say that
 * ANOTHER entry is superseded or retired (`closes_id` is refused with a
 * pointer to `mem_duty_close`, see `NAMED_REFUSALS`). Their effect is not
 * decided here: it hangs on `authority.mayChangeState`, judged on read (the
 * early warning in the write path, the verdict in `memory.retiredMap` /
 * `openDuties`). `state` and `by_id` are allowed only next to one of them
 * (the late "superseded by" door and a duty's closing state).
 *
 * **Authority stays clamped.** `authority` is allowed; the bridge lowers it to
 * `BRIDGE_MAX_AUTHORITY` and records the demotion itself
 * (`bin/mem-mcp` `bridgeAuthority`). The record, `authority_clamped_from`, is
 * not the caller's to write: a forged one would claim a demotion that never
 * happened.
 *
 * Pure: no I/O, no reads. The refusal costs a loop over the argument keys,
 * so 50 agents writing at once pay nothing for it.
 */

import * as procedure from './procedure.mjs';
import * as workflow from './workflow.mjs';

/**
 * Set by the write path, not by the caller: dropped without a word, as they
 * always were (a connected agent's name is what it connected as; an id and a
 * timestamp are the store's). Not a refusal: a client that sends its own id
 * would otherwise fail on a field it cannot know is reserved.
 */
const WRITE_PATH_OWNS = Object.freeze(['agent', 'id', 'ts']);

/** Types the bridge does not write at all (a norm for ALL agents). */
export const REFUSED_TYPES = Object.freeze([procedure.TYPE, workflow.TYPE]);

/**
 * The ids of ANOTHER entry whose state this line changes. Allowed on every
 * type; the authority rule judges the effect on read. `closes_id` is NOT one
 * of them over the bridge: see `NAMED_REFUSALS`.
 */
export const COUNTERPART_IDS = Object.freeze(['replaces_id', 'retires_id']);

/**
 * The shape of an entry id (`src/tasks.mjs` ENTRY_ID). A counterpart id counts
 * only as a non-empty string of this shape: `false`, `0`, `[]`, `{}`, "x" are
 * not ids, and must not unlock `state` / `by_id`.
 */
export const ENTRY_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{3,63}$/;

/**
 * Fields that are refused over the bridge WITH a reason and a way out, not
 * only "not on the list".
 *
 * - `closes_id`: `mem_log` with `closes_id` + `state: done` closed a duty
 *   WITHOUT the F4 proof that `mem_duty_close` asks for (a guard on the error
 *   or a test file, `memory.evidenceOrThrow`). Closing goes through that tool.
 * - `guard`: `memory.dutyHasEvidence` counts a `guard` object on an error as
 *   F4 evidence. A latch the writer wrote itself proves nothing (it can point
 *   at a file that does not exist); the CLI checks it at creation and records
 *   `guard_at_creation`, the bridge does neither. A human sets it at the CLI.
 */
const NAMED_REFUSALS = Object.freeze({
  closes_id: "closing a duty over mem_log skips the F4 proof; close it with mem_duty_close (id, state, why), which asks for it",
  guard: 'a guard the writer wrote itself counts as F4 evidence for closing a duty and proves nothing; set it at the CLI (mem log error --guard-kind ... --guard-path ...), which checks it',
});

/** Allowed only next to a counterpart id: the closing state and the successor. */
const COUNTERPART_COMPANIONS = Object.freeze(['state', 'by_id']);

// On every type: content, access words, validity, the tier claim (clamped).
const COMMON = Object.freeze([
  'title', 'text', 'why', 'topic', 'tags', 'class', 'symbols', 'asked_as', 'asked-as',
  'valid_from', 'valid_until', 'authority',
]);

const PER_TYPE = Object.freeze({
  decision: ['choice', 'rejected'],
  error: ['file', 'files'],
  event: [],
  timeline: ['key', 'value', 'fact', 'source'],
  thought: [],
  learning: ['learning', 'from'],
  // due / due_date / until / deadline: src/appointment-today.mjs; by / to: src/today.mjs (the day list reads them).
  duty: ['duty', 'owner', 'who', 'due', 'due_date', 'until', 'deadline', 'by', 'to'],
  question: ['question'],
  skill: ['skill', 'when', 'scope', 'family'],
  source: ['excerpt', 'description', 'address'],
  update: [],
  link: ['from', 'to', 'kind', 'evidence'],
  snippet: ['kind', 'body', 'description', 'placeholders', 'language', 'version', 'test', 'used_by', 'origin'],
});

/** Type -> the allowed fields (counterpart ids included, `state`/`by_id` not: see `COUNTERPART_COMPANIONS`). */
export const ALLOWED_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(PER_TYPE).map(([type, own]) => [type,
    Object.freeze([...COMMON, ...own, ...COUNTERPART_IDS])])));

/** Is `fields[key]` an entry id (blank / null / undefined count as "no id")? */
function hasCounterpartKey(fields, key) {
  const v = fields[key];
  return typeof v === 'string' && ENTRY_ID.test(v);
}

const quoted = (names) => names.map((n) => `'${n}'`).join(', ');

/**
 * Refuse every field of `fields` that is not allowed for `type`. Throws one
 * error naming ALL of them (and what is allowed); returns nothing otherwise.
 * `type` or `fields` outside the lists: the common fields only (the write path
 * rejects an unknown type afterwards, with its own message).
 */
export function refuse(type, fields) {
  const allowed = Object.hasOwn(ALLOWED_FIELDS, type)
    ? ALLOWED_FIELDS[type] : Object.freeze([...COMMON, ...COUNTERPART_IDS]);
  // A counterpart id: absent (undefined, null, blank string), an entry id, or refused by name.
  let hasCounterpart = false;
  const badIds = [];
  for (const k of COUNTERPART_IDS) {
    if (!Object.hasOwn(fields, k)) continue;
    const v = fields[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (typeof v === 'string' && ENTRY_ID.test(v)) { hasCounterpart = true; continue; }
    badIds.push(k);
  }
  if (badIds.length) {
    throw new Error(`${quoted(badIds)} must be the id of an entry (a string of 4 to 64 letters, digits, - or _) — nothing was written.`);
  }
  // B1 (external review 2026-10-11): a correction of a DUTY over the bridge replaced any duty (user duties,
  // auto-duties included) and the replacement carried no error_ids, so it closed without the F4 proof. The
  // fold judges it now (`memory.openDuties`), and the bridge does not offer the door at all: like `closes_id`,
  // changing a duty's life cycle is `mem_duty_close`; a new duty is a new `mem_log`.
  if (type === 'duty' && Object.hasOwn(fields, 'replaces_id') && hasCounterpartKey(fields, 'replaces_id')) {
    throw new Error("Field 'replaces_id' is not allowed over the bridge for type 'duty': replacing a duty skips the "
      + 'authority rule and the F4 proof for a duty that grew out of errors; close it with mem_duty_close '
      + '(id, state, why), or log a new duty — nothing was written.');
  }
  const named = Object.keys(fields).filter((k) => Object.hasOwn(NAMED_REFUSALS, k));
  if (named.length) {
    throw new Error(`${named.map((k) => `Field '${k}' is not allowed over the bridge: ${NAMED_REFUSALS[k]}`).join('. ')} — nothing was written.`);
  }
  const foreign = [];
  for (const k of Object.keys(fields)) {
    if (WRITE_PATH_OWNS.includes(k) || allowed.includes(k)) continue;
    if (COUNTERPART_COMPANIONS.includes(k) && hasCounterpart) continue;
    foreign.push(k);
  }
  if (!foreign.length) return;
  const many = foreign.length > 1;
  const companions = foreign.filter((k) => COUNTERPART_COMPANIONS.includes(k));
  throw new Error(
    `${many ? 'Fields' : 'Field'} ${quoted(foreign)} ${many ? 'are' : 'is'} not allowed over the bridge for type `
    + `'${type}' — nothing was written. Allowed: ${allowed.join(', ')}`
    + ` (plus ${COUNTERPART_COMPANIONS.join(' / ')} next to ${COUNTERPART_IDS.join(' / ')}). `
    + `${companions.length ? `${quoted(companions)} only travel${companions.length > 1 ? '' : 's'} with an entry that supersedes or retires another. ` : ''}`
    + 'Everything else (audit stamps such as v / status / authority_clamped_from / guard_at_creation, the shred '
    + 'switch, hashes) is set by the write path or by a human at the CLI, never by the caller.');
}
