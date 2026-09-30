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
 *   claim   {claimed_by, until}   "I take it, until then"
 *   done    {by}                  finished
 *   failed  {by, reason}          gave up, released at once
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
 *   - `done` counts only from the valid holder; then the message is
 *     through and later claims are invalid.
 *   - `failed` counts only from the valid holder and releases the
 *     message IMMEDIATELY (even before `until`).
 *   - Lines from non-holders (a foreign `done`) appear in `invalid`
 *     with a reason.
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
      if (!done && holder && z.by === holder.claimed_by) done = z;
      else invalid.push({ ...z, reason: done ? 'already done' : 'done by someone who is not the holder' });
    } else if (z.kind === KIND.FAILED) {
      if (!done && holder && z.by === holder.claimed_by) {
        failures.push({ ...z, claim: holder.id });
        holder = null;
      } else {
        invalid.push({ ...z, reason: 'failed by someone who is not the holder' });
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

export function done(root, message, { by, now = new Date() } = {}) {
  checkMessage(root, message);
  checkWho(by);
  const line = writeLine(root, {
    kind: KIND.DONE, message, by, time: iso(now), id: crypto.randomBytes(6).toString('hex'),
  });
  return { id: line.id, ...status(root, message, { now }) };
}

export function failed(root, message, { by, reason, now = new Date() } = {}) {
  checkMessage(root, message);
  checkWho(by);
  if (typeof reason !== 'string' || !reason.trim() || reason.includes('\n')) {
    throw new Error('failed needs a reason, one line');
  }
  const line = writeLine(root, {
    kind: KIND.FAILED, message, by, reason: reason.trim(), time: iso(now),
    id: crypto.randomBytes(6).toString('hex'),
  });
  return { id: line.id, ...status(root, message, { now }) };
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
