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
 * **The counterpart ids stay.** `replaces_id`, `closes_id` and `retires_id`
 * say that ANOTHER entry is superseded, closed or retired. Their effect is not
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
export const WRITE_PATH_OWNS = Object.freeze(['agent', 'id', 'ts']);

/** Types the bridge does not write at all (a norm for ALL agents). */
export const REFUSED_TYPES = Object.freeze([procedure.TYPE, workflow.TYPE]);

/**
 * The ids of ANOTHER entry whose state this line changes. Allowed on every
 * type; the authority rule judges the effect on read.
 */
export const COUNTERPART_IDS = Object.freeze(['replaces_id', 'closes_id', 'retires_id']);

/** Allowed only next to a counterpart id: the closing state and the successor. */
export const COUNTERPART_COMPANIONS = Object.freeze(['state', 'by_id']);

// On every type: content, access words, validity, the tier claim (clamped).
const COMMON = Object.freeze([
  'title', 'text', 'why', 'topic', 'tags', 'class', 'symbols', 'asked_as', 'asked-as',
  'valid_from', 'valid_until', 'authority',
]);

const PER_TYPE = Object.freeze({
  decision: ['choice', 'rejected'],
  error: ['file', 'files', 'guard'],
  event: [],
  timeline: ['key', 'value', 'fact', 'source'],
  thought: [],
  learning: ['learning', 'from'],
  duty: ['duty', 'owner', 'who'],
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
  const hasCounterpart = COUNTERPART_IDS.some((k) => Object.hasOwn(fields, k)
    && fields[k] !== undefined && fields[k] !== null && fields[k] !== '');
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
    + `${companions.length ? `${quoted(companions)} only travel${companions.length > 1 ? '' : 's'} with an entry that supersedes, closes or retires another. ` : ''}`
    + 'Everything else (audit stamps such as v / status / authority_clamped_from / guard_at_creation, the shred '
    + 'switch, hashes) is set by the write path or by a human at the CLI, never by the caller.');
}
