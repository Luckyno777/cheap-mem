// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * claim — X4: taking over a message or task, with an expiry.
 *
 * **The critique this answers.** File merge, shared memory and mailboxes
 * do not solve distributed coordination. What is needed is (1) a
 * takeover with a time limit, (2) resumption after a crash, (3)
 * idempotency. Idempotency exists already (`Client-Request-Id`). The
 * state of a message only knows open/replied/processed/closed: "I am
 * working on it" and "I failed at it" did not exist, so two observers
 * who both saw the same open message both handled it, and nobody saw it.
 *
 * **What is built here.** One append-only file `claims.jsonl` in the
 * inbox directory, three line kinds, each per message (`message` = file
 * name):
 *
 *   claim   {claimed_by, until}        "I take it, until then"
 *   done    {by, claim_id}             finished
 *   failed  {by, claim_id, reason}     gave up, released at once
 *
 * Nothing is rewritten (house rule: append-only). The `State:` header of
 * the message itself is untouched — a message with no line here behaves
 * exactly as before.
 *
 * **The read rule — the only place that decides.** All lines of one
 * message are sorted by (`time`, then the stable key `claimed_by` + `id`)
 * and folded in order:
 *
 *   - VALID is the FIRST claim whose `until` has not expired.
 *   - A later claim while the valid one is still running is written, but
 *     read as "second, not valid". It stays visible (`invalid`), never
 *     silently dropped.
 *   - After expiry a different agent may claim. That is the resumption.
 *   - `done` counts only from the valid holder AND only with the `claim_id`
 *     of the valid claim; then the message is through and later claims
 *     are invalid.
 *   - `failed` counts only from the valid holder with the valid
 *     `claim_id` and releases the message IMMEDIATELY (even before
 *     `until`).
 *   - Lines from non-holders (a foreign `done`), with a foreign or old
 *     `claim_id`, appear in `invalid` with a reason — never silently.
 *   - A done/failed line with NO `claim_id` is read as "unproven": it
 *     does NOT count and stands in `invalid` with that
 *     reason.
 *
 * **Why the claim id (y0, 2026-09-30).** The actor name alone is not an
 * identity: an old process of the same agent that was resumed after
 * expiry would close the NEW claim of that agent with its late `done`.
 * `claim()` already returns an id; `done()`/`failed()` now require it, and
 * the fold checks that the message belongs to the currently valid claim.
 * Why "no id" is not read leniently: claims exist only since 2026-09-30,
 * so there is no real legacy data that a lenient reading would protect;
 * a lenient rule would keep exactly the hole this closes.
 *
 * **Git is not a lock.** Across hosts there is no shared write access:
 * two hosts that claim at the same moment see each other only after push
 * and pull. After the merge (`*.jsonl merge=union`) BOTH lines are in
 * the file. The read rule then decides deterministically and the same on
 * every host (the order of lines in the file does not matter, only
 * `time` and the key); the loser sees at its next read that it does not
 * count. The goal is NOT to prevent a duplicate (a file in git cannot),
 * but that it never stays SILENT: the duplicate stands there as a line,
 * with a name. Whoever asks `check()` before every effect (and once more
 * before `done`) works at worst visibly twice.
 *
 * Honest limits: (a) `time` is the clock of the writing host — if two
 * clocks drift, the one running ahead loses, deterministically but not
 * "fairly". (b) The rule says who COUNTS, it does not stop anyone from
 * working anyway; it makes that visible. (c) The 30 minute default is a
 * caller preset, not a measurement.
 *
 * No model in the path, no network, no environment variable.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from './inbox.mjs';
import { appendLine } from './append.mjs';

/** File name inside the inbox. Not `.md`, so `inbox.read` never mistakes it for a message. */
export const FILE = 'claims.jsonl';

/** Default time limit in minutes. */
export const DEFAULT_MINUTES = 30;

export const KIND = Object.freeze({
  CLAIM: 'claim',
  DONE: 'done',
  FAILED: 'failed',
});

/** The states `status()` returns. */
export const STATUS = Object.freeze({
  FREE: 'free',
  CLAIMED: 'claimed',
  EXPIRED: 'expired',
  DONE: 'done',
});

export function filePath(root) { return path.join(inbox.inboxDir(root), FILE); }

const iso = (d) => new Date(d).toISOString();

function checkMessage(root, message) {
  inbox.checkMessageName(message);
  if (!fs.existsSync(path.join(inbox.inboxDir(root), message))) {
    throw new Error(`No message '${message}' — nothing to claim`);
  }
}

function checkWho(who) {
  if (typeof who !== 'string' || !/^[A-Za-z0-9._:@-]{1,64}$/.test(who)) {
    throw new Error(`Claimant is [A-Za-z0-9._:@-], not: ${JSON.stringify(who)}`);
  }
}

function writeLine(root, line) {
  fs.mkdirSync(inbox.inboxDir(root), { recursive: true });
  // One single append write per line (appendLine): two processes on the
  // same host do not interleave.
  appendLine(filePath(root), `${JSON.stringify(line)}\n`);
  return line;
}

/** Read all lines. Broken ones are counted and named, not silently skipped. */
export function readLines(root) {
  const file = filePath(root);
  if (!fs.existsSync(file)) return { lines: [], broken: [] };
  const lines = [];
  const broken = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const z = JSON.parse(raw);
      const ok = z && typeof z === 'object' && Object.values(KIND).includes(z.kind)
        && typeof z.message === 'string' && typeof z.id === 'string'
        && Number.isFinite(Date.parse(z.time))
        && (z.kind !== KIND.CLAIM
          ? typeof z.by === 'string'
          : typeof z.claimed_by === 'string' && Number.isFinite(Date.parse(z.until)));
      if (!ok) throw new Error('fields missing or unreadable');
      if ('claim_id' in z && typeof z.claim_id !== 'string') throw new Error('claim_id is not a string');
      lines.push(z);
    } catch (e) { broken.push({ line: i + 1, reason: e.message }); }
  });
  return { lines, broken };
}

/** The order every host agrees on: time, then stable key. */
function key(z) { return `${z.claimed_by ?? z.by}\u0000${z.id}`; }
function order(lines) {
  return [...lines].sort((a, b) => (Date.parse(a.time) - Date.parse(b.time))
    || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * Why a done/failed line does NOT count, or null when it does. Holder,
 * name AND claim id must all match the currently valid claim.
 */
function doesNotCount(z, holder, done) {
  if (done) return 'already done';
  if (!holder) return 'no valid claim to close';
  if (z.claim_id === undefined) return 'unproven: no claim_id, does not count';
  if (z.by !== holder.claimed_by) return 'done by someone who is not the holder';
  if (z.claim_id !== holder.id) {
    return `claim_id ${z.claim_id} is not the valid claim (${holder.id}) — old or foreign, does not count`;
  }
  return null;
}

/**
 * The read rule, pure, no file access. `lines` = all lines of ONE
 * message. Returns status, holder and the visibly invalid ones.
 */
export function fold(lines, { now = new Date() } = {}) {
  const nowMs = new Date(now).getTime();
  let holder = null;
  let done = null;
  let resumptions = 0;
  const invalid = [];
  const failures = [];
  for (const z of order(lines)) {
    if (z.kind === KIND.CLAIM) {
      if (done) {
        invalid.push({ ...z, reason: 'after done' });
      } else if (holder && Date.parse(z.time) < Date.parse(holder.until)) {
        invalid.push({
          ...z,
          reason: `second, not valid — ${holder.claimed_by} holds until ${holder.until}`,
        });
      } else {
        if (holder) resumptions += 1;
        holder = z;
      }
    } else if (z.kind === KIND.DONE) {
      const why = doesNotCount(z, holder, done);
      if (!why) done = z;
      else invalid.push({ ...z, reason: why });
    } else if (z.kind === KIND.FAILED) {
      const why = doesNotCount(z, holder, done);
      if (!why) {
        failures.push({ ...z, claim: holder.id });
        holder = null;
      } else {
        invalid.push({ ...z, reason: why.replace(/^done /, 'failed ') });
      }
    }
  }
  let status = STATUS.FREE;
  if (done) status = STATUS.DONE;
  else if (holder) status = nowMs < Date.parse(holder.until) ? STATUS.CLAIMED : STATUS.EXPIRED;
  return {
    status, holder, done, invalid, failures, resumptions,
    /** May another agent claim now? Free or expired — never when done. */
    claimable: status === STATUS.FREE || status === STATUS.EXPIRED,
  };
}

/** The state of a message. With no line at all: `free` — the normal path, unchanged. */
export function status(root, message, { now = new Date() } = {}) {
  checkMessage(root, message);
  const { lines, broken } = readLines(root);
  return { ...fold(lines.filter((z) => z.message === message), { now }), broken };
}

/**
 * Claim a message. The line is ALWAYS written; whether it counts is
 * `valid` — read with the read rule, not guessed.
 */
export function claim(root, message, { by, minutes = DEFAULT_MINUTES, now = new Date() } = {}) {
  checkMessage(root, message);
  checkWho(by);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes must be > 0');
  const time = new Date(now);
  const line = writeLine(root, {
    kind: KIND.CLAIM, message, claimed_by: by,
    until: iso(time.getTime() + minutes * 60_000), time: iso(time),
    id: crypto.randomBytes(6).toString('hex'),
  });
  return { id: line.id, ...check(root, message, line.id, { now }) };
}

/** Does MY claim (`id`) still count? Ask before every effect and before `done`. */
export function check(root, message, id, { now = new Date() } = {}) {
  const s = status(root, message, { now });
  const valid = s.status === STATUS.CLAIMED && s.holder.id === id;
  const mine = s.invalid.find((u) => u.id === id);
  return {
    valid,
    status: s.status,
    holder: s.holder?.claimed_by ?? null,
    reason: valid ? null : (mine?.reason
      ?? (s.status === STATUS.EXPIRED && s.holder?.id === id ? 'expired' : `does not count (${s.status})`)),
  };
}

function checkClaimId(claimId, what) {
  if (typeof claimId !== 'string' || !/^[0-9a-f]{12}$/.test(claimId)) {
    throw new Error(`${what} needs the claim_id of your claim (12 hex characters, from claim()), not: ${JSON.stringify(claimId)}`);
  }
}

export function done(root, message, { by, claimId, now = new Date() } = {}) {
  checkMessage(root, message);
  checkWho(by);
  checkClaimId(claimId, 'done');
  const line = writeLine(root, {
    kind: KIND.DONE, message, by, claim_id: claimId, time: iso(now), id: crypto.randomBytes(6).toString('hex'),
  });
  return closing(root, message, line, now);
}

export function failed(root, message, { by, claimId, reason, now = new Date() } = {}) {
  checkMessage(root, message);
  checkWho(by);
  checkClaimId(claimId, 'failed');
  if (typeof reason !== 'string' || !reason.trim() || reason.includes('\n')) {
    throw new Error('failed needs a reason, one line');
  }
  const line = writeLine(root, {
    kind: KIND.FAILED, message, by, claim_id: claimId, reason: reason.trim(), time: iso(now),
    id: crypto.randomBytes(6).toString('hex'),
  });
  return closing(root, message, line, now);
}

/** Result of done/failed: the state, plus whether THIS line counts (and if not, why). */
function closing(root, message, line, now) {
  const st = status(root, message, { now });
  const mine = st.invalid.find((u) => u.id === line.id);
  return { id: line.id, ...st, valid: !mine, reason: mine ? mine.reason : null };
}

/**
 * Expired claims with neither done nor failed — the material for a
 * doctor finding. Deliberately NO finding created yet: without users in
 * operation it would be a check without a subject.
 */
export function orphaned(root, { now = new Date() } = {}) {
  const { lines } = readLines(root);
  const messages = [...new Set(lines.map((z) => z.message))].sort();
  const out = [];
  for (const message of messages) {
    const s = fold(lines.filter((z) => z.message === message), { now });
    if (s.status === STATUS.EXPIRED) out.push({ message, holder: s.holder.claimed_by, until: s.holder.until });
  }
  return out;
}
