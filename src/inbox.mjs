// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * inbox — file-based messages between AI sessions that share a memory.
 *
 * Ported from lucky-mem/src/sitzungspost.mjs (originally German, from
 * an earlier Diggi implementation). Participant list is configurable
 * via .mem/config.json — no hardcoded names.
 *
 * Why file+git and not a socket: cloud sessions cannot open a socket to
 * a local session, and vice versa. But both can push/pull a git branch.
 * The inbox is a directory of markdown files with a 5-line header; the
 * transport is `git push`. Delivery = "pushed"; read = "the other side
 * pulled".
 *
 * The format is: `Key: Value` lines until the first blank line; anything
 * after is body. Nothing in the body can retroactively change the header
 * — that's the one property of the format that matters.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as agents from './agents.mjs';
import { bodyHash } from './retrieval.mjs';
import * as redaction from './redaction.mjs';
// Z3/A5: a deliberate cycle inbox <-> claim. Both import the namespace
// and only call each other INSIDE functions, never at load time — ESM
// resolves that without an ordering problem. The message+claim projection
// belongs in `read()`, because every reader goes through it.
import * as claim from './claim.mjs';
import { appendLine } from './append.mjs';
// Block S (ported from lucky-mem): intent + turn budget, the one wake
// rule, permission/budget, routes. None of the three imports this file.
import * as envelope from './envelope.mjs';
import * as mailpermit from './mailpermit.mjs';
import * as routes from './routes.mjs';
import { isHuman } from './config.mjs';

/** Where messages live under the memory root. */
export const INBOX_DIR = path.join('inbox');

export const STATE = Object.freeze({
  OPEN: 'open',
  REPLIED: 'replied',
  PROCESSED: 'processed',
  CLOSED: 'closed',
});

/**
 * Which states mean "no longer open"?
 *
 * **Why this is a function and not a comparison at each reader.** A
 * message has four states. Every place that asks "is this one done?"
 * answers it for itself, and the answers drift apart — because they
 * are written at different times, each correct for the vocabulary of
 * its day, and none of them is revisited when a state is added.
 *
 * Measured here on 2026-09-16: `doctor.mjs` filtered open messages
 * with `state !== 'done' && state !== 'answered'`. Neither string is
 * a state of this module. The filter therefore matched EVERY message,
 * and the delivery check reported all four states as open — a check
 * that has never excluded anything since it was written.
 *
 * Deliberately an ENUMERATION and not `!== OPEN`. If a fifth state
 * arrives — 'withdrawn', 'expired' — `!==` would silently count it as
 * done everywhere at once, a decision nobody made. Here it shows up
 * in one place, and a test fails until someone decides.
 */
export const DONE = Object.freeze([STATE.REPLIED, STATE.PROCESSED, STATE.CLOSED]);

/** Is this message through? The only place that decides. */
export function isDone(state) { return DONE.includes(state); }

const HEADER_FIELDS = ['From', 'To', 'Time', 'Subject', 'State'];

/**
 * `Client-Request-Id` — an OPTIONAL header, deliberately absent from
 * HEADER_FIELDS above.
 *
 * Ported from lucky-mem/src/umschlag.mjs (`Doppel-Marke`, "Doppel-Marke"
 * = duplicate mark), keeping the reasoning and not the German name: a
 * required field would make every message written before this one
 * unreadable, and there are messages on disk that predate it. Same
 * schema-evolution rule this module already applies to Faden/Auftrag
 * over there — a reader has to keep understanding old mail.
 *
 * The name changed on purpose: `Doppel-Marke` names what the field
 * PREVENTS (a duplicate). `Client-Request-Id` names what it holds (the
 * id a caller assigns before sending) — the caller does not know in
 * advance whether the send will turn out to be a duplicate, a conflict,
 * or genuinely new, so a field named after the outcome does not fit a
 * header written before the outcome is known.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const CONTROL_CHARS = new RegExp(`[${
  [...Array(32).keys()].filter((c) => c !== 9 && c !== 10 && c !== 13)
    .concat(127).map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')
}]`);
const CONTROL_CHARS_G = new RegExp(CONTROL_CHARS.source, 'g');

function checkParticipant(participants, role, field) {
  if (typeof role !== 'string' || !Object.hasOwn(participants, role)) {
    throw new Error(
      `${field}: '${role}' has no inbox. Known: ${Object.keys(participants).join(', ')}`);
  }
}

/**
 * `In-Reply-To` — Z3/A7, OPTIONAL like Client-Request-Id: the FILE NAME
 * of the message this one answers. A `Re:` subject is not a reference:
 * two parallel threads with the same subject cannot be told apart by it
 * (ChatGPT letter 2026-09-30T04:26Z, point 7). Ported from lucky-mem's
 * `Antwort-Auf`, which that letter names as the model. Absent on every
 * older message and read as `null`, never as an error.
 */
const IN_REPLY_TO_PATTERN = /^[0-9TZ-]+--[A-Za-z0-9._-]+-to-[A-Za-z0-9._-]+(?:~[a-z0-9]{1,12}(?:-[0-9]{1,3})?)?\.md$/;

export function build(participants, {
  from, to, time, subject, state = STATE.OPEN, text, requestId = null, inReplyTo = null,
  intent = null, turn = null, turnMax = null, fromRoute = null, toRoute = null,
}) {
  checkParticipant(participants, from, 'From');
  checkParticipant(participants, to, 'To');
  if (typeof subject !== 'string' || !subject.trim()) {
    throw new Error('Message without a subject cannot be found later');
  }
  if (subject.includes('\n')) throw new Error('Subject is one line, not a message');
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('An empty message is not a message');
  }
  if (CONTROL_CHARS.test(subject) || CONTROL_CHARS.test(text)) {
    throw new Error('Control characters in message — would not survive storage');
  }
  if (!Object.values(STATE).includes(state)) {
    throw new Error(`Unknown state '${state}'. Known: ${Object.values(STATE).join(', ')}`);
  }
  if (requestId !== null && !REQUEST_ID_PATTERN.test(String(requestId))) {
    throw new Error(`Client-Request-Id is [A-Za-z0-9._:-], not: ${JSON.stringify(requestId)}`);
  }
  if (inReplyTo !== null && !IN_REPLY_TO_PATTERN.test(String(inReplyTo))) {
    throw new Error(`In-Reply-To is a message file name, not: ${JSON.stringify(inReplyTo)}`);
  }
  const header = [
    `From: ${from}`, `To: ${to}`, `Time: ${time}`,
    `Subject: ${subject}`, `State: ${state}`,
    ...(requestId !== null ? [`Client-Request-Id: ${requestId}`] : []),
    ...(inReplyTo !== null ? [`In-Reply-To: ${inReplyTo}`] : []),
    // Block S: Intent, Turn, From-Route, To-Route — optional, validated there.
    ...envelope.headerLines({ intent, turn, turnMax, fromRoute, toRoute }),
  ].join('\n');
  return `${header}\n\n${text.replace(/\s+$/, '')}\n`;
}

export function parse(content) {
  if (typeof content !== 'string') throw new Error('parse expects a string');

  // **CRLF goes first, and only here.**
  //
  // Until 2026-09-19 the boundary search below ran on the RAW text. A
  // message written on Windows separates header from body with
  // `\r\n\r\n`, so `indexOf('\n\n')` found nothing and the parser threw
  // 'No blank line'. Reported that day by a cheap-mem user who pulled
  // the latest onto a Windows machine: two entirely intact messages sat
  // in his drawer, the doctor reported `delivery: drawer unreadable`,
  // and the channel to ChatGPT was silent without anyone noticing.
  //
  // lucky-mem carried the identical assumption in the identical place
  // (src/sitzungspost.mjs, `zerlege`) and was repaired the same day —
  // both houses were written from the same template.
  //
  // The normalisation sits in the PARSER, not in each caller: `read`,
  // `setState`, `classifyRequest` and the MCP server all come through
  // here. A second place would be a second truth about what a blank
  // line is.
  //
  // A lone `\r` (classic Mac OS, pre-2001) is deliberately left alone.
  // There is no measured case for it, and a guard against an invented
  // problem is a line that promises something nobody checked.
  const normalised = content.includes('\r\n') ? content.split('\r\n').join('\n') : content;

  const boundary = normalised.indexOf('\n\n');
  if (boundary < 0) throw new Error('No blank line — that is a header, not a message');
  const headerPart = normalised.slice(0, boundary);
  const text = normalised.slice(boundary + 2).replace(/\s+$/, '');

  const header = {};
  for (const line of headerPart.split('\n')) {
    const i = line.indexOf(': ');
    if (i < 0) throw new Error(`Header line without field: ${JSON.stringify(line)}`);
    header[line.slice(0, i)] = line.slice(i + 2);
  }
  const missing = HEADER_FIELDS.filter((f) => !Object.hasOwn(header, f));
  if (missing.length) throw new Error(`Header missing: ${missing.join(', ')}`);

  return {
    from: header.From, to: header.To, time: header.Time,
    subject: header.Subject, state: header.State, text,
    // Absent on every message written before this field existed, and
    // that is a valid answer, not a parse error — same rule umschlag.mjs
    // (lucky-mem) applies to its own optional headers: a missing field
    // reads as `null`, never as a thrown error that would make old mail
    // unreadable.
    requestId: Object.hasOwn(header, 'Client-Request-Id') ? header['Client-Request-Id'] : null,
    inReplyTo: Object.hasOwn(header, 'In-Reply-To') ? header['In-Reply-To'] : null,
    // Block S: intent (derived when absent), turn, routes — see envelope.mjs.
    ...envelope.fromHeader(header),
  };
}

export function fileName(participants, { time, from, to, mark = null }) {
  checkParticipant(participants, from, 'From');
  checkParticipant(participants, to, 'To');
  const z = String(time).replace(/[:.]/g, '-');
  if (!/^[0-9TZ-]+$/.test(z)) throw new Error(`Time '${time}' is not ISO`);
  if (mark === null || mark === undefined || mark === '') return `${z}--${from}-to-${to}.md`;
  if (!MARK_PATTERN.test(String(mark))) {
    throw new Error(`Clone mark '${mark}' does not match ${MARK_PATTERN}`);
  }
  return `${z}--${from}-to-${to}${MARK_SEPARATOR}${mark}.md`;
}

/**
 * The mark hangs off a TILDE, not a hyphen.
 *
 * An agent name may contain hyphens (`vm-admin`), so an appended `-2`
 * cannot be told apart from part of a name. That is exactly how the
 * existing collision counter failed: `...-to-chatgpt-2.md` did not
 * parse, and a name that does not parse is put on the "unreadable"
 * pile and never announced as new. The repair against losing a
 * message within one second had produced an undeliverable one.
 *
 * The tilde cannot occur in an agent name. The boundary is
 * unambiguous with nothing left to guess.
 */
const MARK_SEPARATOR = '~';
const MARK_PATTERN = /^[a-z0-9]{1,12}(?:-[0-9]{1,3})?$/;
const MARK_FILE = path.join('.pipeline', 'clone-mark');
let markThisRun = null;

/**
 * This clone's mark — four characters, rolled once, local.
 *
 * **What it is for.** Two clones of the same memory can write the
 * same message in the same second: same sender, same recipient, same
 * timestamp, therefore the same filename with different content.
 * Both are allowed to — each creates the file exclusively and cannot
 * see the other. In git that is an add/add conflict. A watcher that
 * commits the conflict markers makes the drawer unparseable, delivery
 * goes quiet, and every agent behind it looks dead.
 *
 * Exclusive creation solves collisions WITHIN one clone. Between two
 * clones it can do nothing; there the only fix is that two clones do
 * not form the same name in the first place.
 *
 * The mark lives in `.pipeline/` and is therefore gitignored: it
 * describes this clone and never travels. It carries nothing about
 * the machine — four rolled characters, no hostname, no path, no user
 * name. A message name goes out into the world; what is in it must
 * not give anything away.
 *
 * Never throws. If the mark cannot be stored, one rolled for this run
 * applies — collision safety stays, stability does not. A drawer that
 * cannot be written to is the very outage this guards against.
 */
export function cloneMark(root) {
  const p = path.join(root, MARK_FILE);
  try {
    const have = fs.readFileSync(p, 'utf8').trim();
    if (MARK_PATTERN.test(have)) return have;
  } catch { /* none yet — roll one */ }
  const fresh = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${fresh}\n`, { encoding: 'utf8', flag: 'wx' });
    return fresh;
  } catch {
    // A race: another run was first. Its mark wins.
    try {
      const have = fs.readFileSync(p, 'utf8').trim();
      if (MARK_PATTERN.test(have)) return have;
    } catch { /* truly not storable */ }
    markThisRun = markThisRun ?? fresh;
    return markThisRun;
  }
}

export function inboxDir(root) { return path.join(root, INBOX_DIR); }

/**
 * A message name is a FILENAME, never a path.
 *
 * This check lived inline inside setState, which meant it protected
 * exactly one of the places that join a caller-supplied name onto the
 * inbox directory — `mem_inbox_show` in the MCP server did its own
 * path.join and read whatever it was handed. Same shape of mistake as
 * checkProjectName, which also existed and was also only called once.
 * A guard that is not the single entry point is a guard for one caller.
 */
export function checkMessageName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Message name missing');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`'${name}' is a path, not a filename`);
  }
}

/**
 * One message, by filename. The one way to read a message by name, so
 * the guard above cannot be walked around by joining the path yourself.
 */
export function readMessage(root, name) {
  checkMessageName(name);
  const p = path.join(inboxDir(root), name);
  if (!fs.existsSync(p)) throw new Error(`No message '${name}'`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * The reservation for one (from, to, request id): a marker file next to
 * the messages, named after a hash of exactly that triple.
 *
 * **Why the marker and not the message name.** The message name carries
 * the time and the clone mark, so two clones writing the same request
 * make two different names — that is what keeps `git add/add` conflicts
 * out of the drawer. The marker is the opposite on purpose: same triple,
 * same name, and its content is EMPTY, so the same marker added in two
 * clones merges cleanly (identical add on both sides). It carries no
 * text, no time and no comparison data — anything that could differ
 * between clones would turn the marker itself into a merge conflict.
 * Whether the two requests agree is decided from the messages, on read.
 *
 * Not `.md`, so `read` never mistakes it for a message.
 */
export const REQUEST_MARKER_EXT = '.req';

export function requestKey({ from, to, requestId }) {
  return createHash('sha256').update(`${from}\0${to}\0${requestId}`).digest('hex').slice(0, 24);
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Thrown when a Client-Request-Id is reused for a different message. */
export class RequestConflictError extends Error {
  constructor(message, { prior } = {}) {
    super(message);
    this.name = 'RequestConflictError';
    this.code = 'REQUEST_CONFLICT';
    this.prior = prior ?? null;
  }
}

/**
 * Send, at most once per (from, to, Client-Request-Id).
 *
 *   no id      — as it always was: every call writes a message.
 *   new id     — reserve the marker exclusively (`wx`), then write.
 *   same id, same text     — REPLAY: nothing is written; the earlier
 *                            message is returned with `replay: true`.
 *   same id, different text — CONFLICT: throws RequestConflictError. A
 *                            reused id is a caller bug, never papered over.
 *
 * Two clones cannot see each other's reservation until they merge, so
 * the read side (`read`) folds equal triples into ONE logical message
 * and lists the rest as `duplicates` — see there.
 */
export function write(root, participants, {
  from, to, subject: rawSubject, text: rawText, now = new Date(), requestId = null, inReplyTo = null,
  intent = null, toRoute = null, env = process.env,
}) {
  // Z3/A7: a reference must point at a real message, in the right
  // direction — the original went TO the one answering and FROM the one
  // being answered. Checked before redaction and before anything is
  // reserved, so a bad reference writes nothing.
  let original = null;
  if (inReplyTo !== null && inReplyTo !== undefined) {
    original = parse(readMessage(root, String(inReplyTo)));
    if (original.to !== from || original.from !== to) {
      throw new Error(`In-Reply-To '${inReplyTo}' went from '${original.from}' to '${original.to}' — `
        + `a reply to it goes from '${original.to}' to '${original.from}', not from '${from}' to '${to}'`);
    }
  }
  const fields = envelopeFields(root, { from, to, intent, toRoute, original, env });
  // **O1: redaction HERE, not in the caller.** Neither `mem inbox write`
  // nor `mem_inbox_write` redacted a message before the disk; both
  // leaned on the commit scan. One place for every write path — a
  // guarantee each caller has to keep itself is only as strong as the
  // sloppiest one. Self test fails -> nothing is written. Subject AND
  // text, both land in the inbox. Before the request-id check, so a
  // replay is compared against the already-redacted earlier message.
  const test = redaction.selfTest();
  if (!test.ok) throw new Error('Redaction failed its self test — nothing is written.');
  const counts = new Map();
  const clean = (v) => {
    if (typeof v !== 'string' || !v) return v;
    const r = redaction.redact(v);
    for (const f of r.found) counts.set(f.type, (counts.get(f.type) ?? 0) + f.count);
    return r.text;
  };
  const subject = clean(rawSubject);
  const text = clean(rawText);
  const findings = [...counts].map(([type, count]) => ({ type, count }));
  const res = writeUnredacted(root, participants, {
    from, to, subject, text, now, requestId, inReplyTo: inReplyTo ?? null, fields,
  });
  return { ...res, findings, envelope: fields };
}

/**
 * Block S: the envelope the WRITE path sets — never the caller.
 *
 *   Turn       a reply is one turn deeper than its original (envelope.replyTurn);
 *              past the maximum nothing in the chain wakes anyone again.
 *   From-Route this process's own registered route for role `from`
 *              (routes.ownRoute). Nobody writes in another session's name.
 *   To-Route   on a reply, ALWAYS the original's From-Route when that
 *              route is known and belongs to role `to`. Otherwise only an
 *              explicit, checked route of role `to`. The text never
 *              re-addresses a message.
 *
 * One place, so the CLI, the MCP bridge and the dashboard reply share it.
 */
function envelopeFields(root, { from, to, intent, toRoute, original, env }) {
  if (intent !== null && intent !== undefined && !envelope.INTENTS.includes(intent)) {
    throw new Error(`Intent is one of ${envelope.INTENTS.join('|')}, not: ${JSON.stringify(intent)}`);
  }
  const out = { intent: intent ?? null, turn: null, turnMax: null, fromRoute: null, toRoute: null };
  if (original) Object.assign(out, envelope.replyTurn(original));
  const own = routes.ownRoute(root, { role: from, env });
  if (own) out.fromRoute = own.routeId;
  if (original) {
    const r = original.fromRoute ? routes.find(root, original.fromRoute) : null;
    if (r && r.role === to) out.toRoute = r.routeId;
  } else if (toRoute !== null && toRoute !== undefined) {
    const r = routes.find(root, toRoute);
    if (!r || r.role !== to) throw new Error(`To-Route '${toRoute}' is not a registered route of role '${to}'`);
    out.toRoute = r.routeId;
  }
  return out;
}

function writeUnredacted(root, participants, { from, to, subject, text, now, requestId, inReplyTo, fields }) {
  if (requestId === null || requestId === undefined) {
    return writeMessage(root, participants, { from, to, subject, text, now, requestId: null, inReplyTo, fields });
  }
  // Validate before anything is reserved: a bad message must not leave a marker behind.
  build(participants, { from, to, time: new Date(now).toISOString(), subject, text, requestId, inReplyTo, ...fields });
  const seenPrior = () => {
    const c = classifyRequest(root, participants, { from, to, requestId, text });
    if (c === REQUEST.NEW) return null;
    const { messages } = read(root, participants, { to });
    const prior = messages.find((m) => m.from === from && m.requestId === requestId);
    if (c === REQUEST.CONFLICT) {
      throw new RequestConflictError(
        `Client-Request-Id '${requestId}' from '${from}' to '${to}' was already used for a `
        + `different message (${prior.name}) — nothing written. Use a new id for a new message.`,
        { prior });
    }
    return { path: path.join(inboxDir(root), prior.name), name: prior.name, time: prior.time, replay: true };
  };
  const hit = seenPrior();
  if (hit) return hit;

  const dir = inboxDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, `request-${requestKey({ from, to, requestId })}${REQUEST_MARKER_EXT}`);
  try {
    fs.writeFileSync(marker, '', { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Reserved by someone else: another process writing right now, an
    // earlier call that died before writing, or the other clone's marker
    // that came in with a merge. Give a live writer a moment to finish;
    // if no message ever shows up, the reservation is an orphan and we
    // write — a duplicate is folded on read, a lost message is not.
    for (let i = 0; i < 20; i += 1) {
      const again = seenPrior();
      if (again) return again;
      sleepMs(50);
    }
  }
  return writeMessage(root, participants, { from, to, subject, text, now, requestId, inReplyTo, fields });
}

function writeMessage(root, participants, {
  from, to, subject, text, now, requestId, inReplyTo = null, fields = {},
}) {
  const time = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const content = build(participants, { from, to, time, subject, text, requestId, inReplyTo, ...fields });
  const mark = cloneMark(root);
  const base = fileName(participants, { time, from, to, mark });
  const dir = inboxDir(root);
  fs.mkdirSync(dir, { recursive: true });

  // The name has second resolution and no disambiguator, so two messages
  // from the same sender to the same recipient inside one second landed
  // on the same path — and the second write destroyed the first one
  // completely. No error, no suffix, no trace, and both calls printed
  // "Written". Verified through the CLI. This is the channel every
  // session is told to use at session end, so the lost message was
  // typically a handover.
  //
  // raw.mjs solved the same second-collision for captures long ago; this
  // file never got it. It checks existsSync and then writes, which
  // leaves a gap between the two — the exclusive-create flag has no gap
  // at all: the filesystem either creates the file or tells us it is
  // taken, in one operation.
  let name = base;
  let p = path.join(dir, name);
  // Names: the base plus -2 to -999 (the clone mark allows at most three digits)
  // = 999 attempts. The old `n < 1000` tried only 998 and the message said 1000.
  for (let n = 2; n <= 1000; n += 1) {
    try {
      fs.writeFileSync(p, content, { encoding: 'utf8', flag: 'wx' });
      return { path: p, name, time };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (n >= 1000) break; // -999 was the last name the mark allows
      // The counter belongs BEHIND the mark, not behind the recipient
      // name. It used to read `-2` right after the name, and
      // fromFileName returned null for that: the second message of a
      // second was unreadable and never announced as new. The repair
      // against losing a message had produced an undeliverable one.
      name = fileName(participants, { time, from, to, mark: `${mark}-${n}` });
      p = path.join(dir, name);
    }
  }
  throw new Error(`Inbox: 999 messages in one second for '${base}' — refusing to guess`);
}

/**
 * The subject of a reply: `Re: <original>`, never `Re: Re: <original>`.
 * Pure, so the dashboard and a test agree on it without a round trip.
 */
export function replySubject(subject) {
  const s = String(subject ?? '').trim();
  return /^re:\s/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Answer one message, as the participant it was addressed to (P1b).
 *
 * **The same write as `mem inbox write`.** This does not build a
 * message of its own: it reads the original through `readMessage()`
 * (the one name guard), turns its header around — the reply goes FROM
 * the original's recipient TO its sender, subject `Re: ...` — and hands
 * that to `write()` above, exactly the call the CLI makes. Same file
 * name scheme, same header, same exclusive create, same clone mark.
 * Nothing is committed or pushed: delivery stays `git add/commit/push`,
 * as the CLI prints.
 *
 * `as` is who is answering. The call refuses when the original was not
 * addressed to `as` — no form field decides whom the reply goes to, so
 * a crafted name cannot make one participant speak for another
 * (fail closed, same rule lucky-mem's desk applies to its replies).
 *
 * The original is left as it is. Marking it `replied` is a separate,
 * deliberate step (`mem inbox ack`), as it is on the command line.
 */
export function reply(root, participants, { name, as, text, now = new Date(), intent = null, env = process.env }) {
  const original = parse(readMessage(root, name));
  if (typeof as !== 'string' || original.to !== as) {
    throw new Error(`'${name}' is addressed to '${original.to}', not to '${as}' — `
      + 'only its recipient can answer it');
  }
  return {
    ...write(root, participants, {
      from: original.to, to: original.from, subject: replySubject(original.subject), text, now,
      // Z3/A7: the stable reference, not only the `Re:` subject.
      // Block S: without an intent a reply is a `result` and wakes nobody.
      inReplyTo: name, intent, env,
    }),
    to: original.from,
  };
}

/**
 * Three states, never two: no dir, empty dir, has messages.
 *
 * And per message, also three states, never two: read, broken, filtered
 * out. `broken` is therefore always an array — on the absent drawer and
 * on the empty one too. An absent key would trip every caller that
 * reads it, and it would trip them exactly when there is no drawer,
 * which is the one case nobody tests by hand.
 */
export function read(root, participants, { to = null, state = null } = {}) {
  if (to !== null) checkParticipant(participants, to, 'To');
  const dir = inboxDir(root);
  if (!fs.existsSync(dir)) return { dir: null, messages: [], broken: [], duplicates: [], eventsBroken: [] };

  // Z3/A5+A8: ONE projection per message — header state, then the state
  // events (states.jsonl), then the claim. Read once per call, not per
  // message. See `project()`.
  const proj = projectionData(root);

  // **One unreadable message must not take the drawer down (2026-09-19).**
  //
  // Until today there was no try here. The throw came out of the LOOP,
  // every caller above caught it for the WHOLE drawer, and `doctor`
  // reported `delivery: drawer unreadable` — for a drawer whose other
  // messages were entirely intact. That is what the Windows user hit:
  // one CRLF message (see `parse`), two healthy ones, and a finding
  // that blamed all three.
  //
  // Silently skipping would be the other wrong answer: a message then
  // falls out of the drawer and nobody learns of it. So it goes into
  // its own list, with the reason. Same decision as house rule I19 for
  // malformed JSONL lines — count broken lines instead of silently
  // skipping them.
  const broken = [];
  const all = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    let m;
    try {
      m = { name, ...parse(fs.readFileSync(path.join(dir, name), 'utf8')) };
    } catch (e) {
      broken.push({ name, reason: e.message });
      continue;
    }
    if (to !== null && m.to !== to) continue;
    all.push(project(m, proj));
  }

  // **One logical message per (from, to, Client-Request-Id).**
  //
  // Two clones that send the same request cannot see each other's
  // reservation until they merge, and the merge must not conflict, so
  // both messages exist side by side. Every reader goes through here,
  // so the fold happens here: the OLDEST by header time wins, ties by
  // file name (a stable key both clones compute the same). The others
  // are not dropped — they come back as `duplicates`, each pointing at
  // the message it duplicates and saying whether its text agrees, so
  // "delivered once" never means "one silently vanished". Messages
  // without an id are never folded: two "ping"s are two requests.
  const byKey = new Map();
  for (const m of all) {
    if (m.requestId === null) continue;
    const k = `${m.from}\0${m.to}\0${m.requestId}`;
    const cur = byKey.get(k);
    if (!cur || m.time < cur.time || (m.time === cur.time && m.name < cur.name)) byKey.set(k, m);
  }
  const duplicates = [];
  const logical = [];
  for (const m of all) {
    const winner = m.requestId === null ? null : byKey.get(`${m.from}\0${m.to}\0${m.requestId}`);
    if (winner && winner !== m) {
      duplicates.push({
        ...m,
        duplicateOf: winner.name,
        sameText: bodyHash(m.text) === bodyHash(winner.text),
      });
    } else {
      logical.push(m);
    }
  }
  const messages = state === null ? logical : logical.filter((m) => m.state === state);
  return { dir, messages, broken, duplicates, eventsBroken: proj.broken };
}

/** Three states, never two: what a new send with the same id means. */
export const REQUEST = Object.freeze({
  NEW: 'new',
  REPLAY: 'replay',
  CONFLICT: 'conflict',
});

/**
 * Classify a message about to be sent, against what `from` has already
 * sent `to` under the same Client-Request-Id.
 *
 *   NEW      no earlier message carries this id — send normally.
 *   REPLAY   an earlier message carries the same id AND the same body —
 *            the same request arrived twice (a retried push, a doubled
 *            CLI call). It is the SAME operation, not a second one.
 *   CONFLICT an earlier message carries the same id with a DIFFERENT
 *            body — the id was reused for something else. That is a
 *            caller bug to surface, never to paper over.
 *
 * Deliberately keyed on the id, never on text equality: two intended
 * requests can share the same wording ("ping"), so deduplicating by
 * TEXT would silently drop one of them. That is the exact failure this
 * mirrors lucky-mem/src/umschlag.mjs (KOPF_MARKE) in guarding against —
 * ported for the reasoning, not the field name (see REQUEST_ID_PATTERN
 * above for why the name differs).
 *
 * Body equality reuses retrieval.mjs's `bodyHash` rather than `===`, so
 * a request re-sent with only trailing whitespace or CRLF/LF changed
 * still reads as the same body — the same normalisation this codebase
 * already applies when hashing memory entries, not a second rule for
 * messages that happens to disagree at the edges.
 *
 * A message with no requestId at all is always NEW: there is nothing to
 * compare it against, and old mail (written before this field existed)
 * must keep behaving exactly as it always did.
 */
export function classifyRequest(root, participants, { from, to, requestId, text }) {
  if (requestId === null || requestId === undefined) return REQUEST.NEW;
  const { messages } = read(root, participants, { to });
  const prior = messages.find((m) => m.from === from && m.requestId === requestId);
  if (!prior) return REQUEST.NEW;
  return bodyHash(prior.text) === bodyHash(text) ? REQUEST.REPLAY : REQUEST.CONFLICT;
}

/**
 * Z3/A8: a state change is an EVENT LINE, the message is never rewritten.
 *
 * Until 2026-09-30 `setState()` rewrote the message file with a new
 * `State:` header (ChatGPT letter 2026-09-30T04:26Z, point 8: "closed->open
 * accepted, setState overwrites the file without a version check"). Two
 * consequences: (a) a stale writer could silently reset a close — last
 * writer wins; (b) the history was gone.
 *
 * Now the message stays as written. Every change is one line in
 * `states.jsonl` in the inbox, carrying the state the writer saw BEFORE
 * (`prior`). Reading goes through `foldState()`: header state as the
 * start, then the lines in (time, file order); a line whose `prior` does
 * not match the folded state does NOT count and shows up as a conflict
 * (distributed conflicts after a merge: two clones, both from `open` —
 * the earlier counts, the other is a named conflict, never silent
 * last-writer-wins).
 *
 * **Transition.** Old messages carry their state in the header (that is
 * how they were acknowledged until now) — the header is the start of the
 * fold, so they stay readable exactly as before, without a migration.
 *
 * **Reopening** (a done state back to `open`) needs a `reason` — a
 * deliberate, explained event of its own.
 *
 * `expected`: whoever saw the state before deciding passes it along; if
 * it no longer matches, NOTHING is written (local compare-and-set,
 * StateConflictError).
 */
export const STATES_FILE = 'states.jsonl';
export function statesPath(root) { return path.join(inboxDir(root), STATES_FILE); }

export class StateConflictError extends Error {
  constructor(message, { current = null } = {}) {
    super(message);
    this.name = 'StateConflictError';
    this.code = 'STATE_CONFLICT';
    this.current = current;
  }
}

/**
 * All state lines. Broken ones are counted and named, never skipped silently.
 * Keyed `log` (the event log they came from), not `file`: this is not a
 * memory-drawer walk — that question has one owner (shared/calculations.jsonl,
 * log-drawer-walk -> integrity.scanIntegrity).
 */
export function readStateLines(root) {
  const p = statesPath(root);
  if (!fs.existsSync(p)) return { lines: [], events: [], broken: [] };
  const lines = [];
  const events = [];
  const broken = [];
  fs.readFileSync(p, 'utf8').split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const z = JSON.parse(raw);
      if (z && typeof z === 'object' && z.kind === 'event') {
        const fine = typeof z.message === 'string' && typeof z.id === 'string'
          && EVENTS.includes(z.event) && Number.isFinite(Date.parse(z.time));
        if (!fine) throw new Error('event line: fields missing or unreadable');
        events.push(z);
        return;
      }
      const ok = z && typeof z === 'object' && z.kind === 'state'
        && typeof z.message === 'string' && typeof z.id === 'string'
        && typeof z.state === 'string' && typeof z.prior === 'string'
        && Number.isFinite(Date.parse(z.time));
      if (!ok) throw new Error('fields missing or unreadable');
      lines.push(z);
    } catch (e) { broken.push({ log: STATES_FILE, line: i + 1, reason: e.message }); }
  });
  return { lines, events, broken };
}

/**
 * S2b/S2c (lucky-mem `abgeholt`): delivery EVENTS as their own lines in
 * states.jsonl. `picked-up`: the RECIPIENT actually got the message
 * (`mem inbox new` / `mem inbox show` as that participant) — never the
 * watcher's poll and never the seen-marker. An event changes no state line;
 * the one exception is in the projection: a message with intent `read`
 * (wakes, asks for no answer) counts as `processed` once its recipient
 * picked it up. No fifth state. Append-only.
 */
export const EVENTS = Object.freeze(['picked-up']);

/**
 * The recipient `to` picked these messages up: at most ONE line per
 * (message, recipient) — asking ten times writes once. A message to
 * someone else is skipped (a look into foreign mail is no pickup).
 * Never throws (picking up must not fail on the bookkeeping); errors are
 * returned in `failed`.
 */
export function markPickedUp(root, { to, names = [], now = new Date() } = {}) {
  const written = [];
  const failed = [];
  if (!to || !names.length) return { written, failed };
  let have;
  try {
    have = new Set(readStateLines(root).events.filter((e) => e.event === 'picked-up' && e.by === to).map((e) => e.message));
  } catch (e) { return { written, failed: [{ name: STATES_FILE, reason: e.message }] }; }
  for (const name of [...new Set(names)]) {
    if (have.has(name)) continue;
    try {
      checkMessageName(name);
      if (parse(readMessage(root, name)).to !== to) continue;
      const line = {
        kind: 'event', event: 'picked-up', message: name, by: to, time: new Date(now).toISOString(),
        id: createHash('sha256').update(`${name}\0picked-up\0${to}\0${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 12),
      };
      fs.mkdirSync(inboxDir(root), { recursive: true });
      appendLine(statesPath(root), `${JSON.stringify(line)}\n`);
      written.push(line);
      have.add(name);
    } catch (e) { failed.push({ name, reason: e.message }); }
  }
  return { written, failed };
}

/** The fold, pure. `headerState` = the header's state, `lines` = this message's state lines. */
export function foldState(headerState, lines = []) {
  let state = headerState;
  let source = 'header';
  let changes = 0;
  const conflicts = [];
  // Order: time, ties by file order. NOT the id (random): two changes in
  // the same millisecond (acknowledge, then re-acknowledge) sit in their
  // real order within one clone. After merge=union the file is the same
  // on every clone, so the order is the same everywhere.
  const sorted = lines.map((z, i) => [z, i]).sort(([a, ia], [b, ib]) =>
    (Date.parse(a.time) - Date.parse(b.time)) || (ia - ib)).map(([z]) => z);
  for (const z of sorted) {
    if (z.prior !== state) {
      conflicts.push({ ...z, why: `saw '${z.prior}', but '${state}' held — stale writer, does not count` });
      continue;
    }
    if (isDone(state) && z.state === STATE.OPEN && !(typeof z.reason === 'string' && z.reason.trim())) {
      conflicts.push({ ...z, why: 'reopening without a reason does not count' });
      continue;
    }
    state = z.state;
    source = 'event';
    changes += 1;
  }
  return { state, source, changes, conflicts };
}

function projectionData(root) {
  const broken = [];
  const st = readStateLines(root);
  broken.push(...st.broken);
  const stateBy = new Map();
  for (const z of st.lines) {
    if (!stateBy.has(z.message)) stateBy.set(z.message, []);
    stateBy.get(z.message).push(z);
  }
  const eventBy = new Map();
  for (const z of st.events ?? []) {
    if (!eventBy.has(z.message)) eventBy.set(z.message, []);
    eventBy.get(z.message).push(z);
  }
  const claimBy = new Map();
  try {
    const c = claim.readLines(root);
    for (const b of c.broken) broken.push({ log: claim.FILE, line: b.line, reason: b.reason });
    for (const z of c.lines) {
      if (!claimBy.has(z.message)) claimBy.set(z.message, []);
      claimBy.get(z.message).push(z);
    }
  } catch (e) {
    broken.push({ log: claim.FILE, line: null, reason: `unreadable: ${e.message}` });
  }
  return { stateBy, eventBy, claimBy, broken };
}

/**
 * Z3/A5: ONE state view per message — every reader (CLI, MCP, dashboard,
 * watcher, doctor) goes through `read()` and therefore through here.
 *
 *   state        the effective state
 *   headerState  what the header says (the start value)
 *   stateSource  'header' | 'event' | 'claim'
 *   claim        {status, holder} when there are claim lines
 *
 * **A `done` claim makes an open message `processed`.** That is the
 * contradiction of point 5 ("claim done leaves the header open; newFor
 * keeps reporting it new"). `processed` and not `replied`: the work is
 * done, but that says nothing about whether a REPLY was sent — transport,
 * claim, result and answer stay separate words. No fifth state.
 */
function project(m, proj) {
  const f = foldState(m.state, proj.stateBy.get(m.name) ?? []);
  const out = { ...m, headerState: m.state, state: f.state, stateSource: f.source };
  if (f.conflicts.length) out.stateConflicts = f.conflicts;
  // S2b/S2c: `picked-up` counts only from the recipient; a `read` request
  // is done with it — `processed`, not `replied` (it asked for no answer).
  const picked = (proj.eventBy?.get(m.name) ?? []).filter((e) => e.event === 'picked-up' && e.by === m.to)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))[0] ?? null;
  if (picked) {
    out.pickedUp = picked.time;
    if (out.state === STATE.OPEN && m.intent === 'read') { out.state = STATE.PROCESSED; out.stateSource = 'picked-up'; }
  }
  const cl = proj.claimBy.get(m.name);
  if (cl && cl.length) {
    const c = claim.fold(cl);
    out.claim = { status: c.status, holder: c.holder?.claimed_by ?? null };
    if (out.state === STATE.OPEN && c.status === claim.STATUS.DONE) {
      out.state = STATE.PROCESSED;
      out.stateSource = 'claim';
    }
  }
  return out;
}

/** The effective state of ONE message, through the same projection as `read()`. */
export function stateOf(root, name) {
  const m = parse(readMessage(root, name));
  return project({ name, ...m }, projectionData(root));
}

export function setState(root, participants, name, newState, {
  by = null, reason = null, expected = undefined, now = new Date(),
} = {}) {
  if (!Object.values(STATE).includes(newState)) {
    throw new Error(`Unknown state '${newState}'. Known: ${Object.values(STATE).join(', ')}`);
  }
  checkMessageName(name);
  const p = path.join(inboxDir(root), name);
  if (!fs.existsSync(p)) throw new Error(`No message '${name}'`);
  const old = parse(fs.readFileSync(p, 'utf8'));
  // The comparison value is header + events — NOT the claim projection:
  // `foldState()` sees only state lines, and `prior` must match exactly that.
  const current = foldState(old.state, readStateLines(root).lines.filter((z) => z.message === name)).state;
  if (expected !== undefined && expected !== current) {
    throw new StateConflictError(
      `'${name}' is '${current}', not '${expected}' — someone was faster. Nothing written.`, { current });
  }
  if (current === newState) return { ...old, state: current, name, unchanged: true };
  const r = reason === null || reason === undefined ? null : String(reason).replace(CONTROL_CHARS_G, '').trim();
  if (r !== null && r.includes('\n')) throw new Error('reason is one line');
  if (isDone(current) && newState === STATE.OPEN && !r) {
    throw new Error(`'${name}' is '${current}' — reopening needs a reason (--reason).`);
  }
  fs.mkdirSync(inboxDir(root), { recursive: true });
  const line = {
    kind: 'state', message: name, prior: current, state: newState,
    by: typeof by === 'string' && by ? by : null,
    reason: r || null,
    time: new Date(now).toISOString(),
    id: createHash('sha256').update(`${name}\0${current}\0${newState}\0${Date.now()}\0${Math.random()}`)
      .digest('hex').slice(0, 12),
  };
  appendLine(statesPath(root), `${JSON.stringify(line)}\n`);
  return { ...old, state: newState, name, stateLine: line.id };
}

export const SEEN_FILE = path.join('.mem', 'inbox-seen.json');
export const WHOAMI_FILE = path.join('.mem', 'inbox-whoami');

function loadSeen(root) {
  const p = path.join(root, SEEN_FILE);
  if (!fs.existsSync(p)) return {};
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Z3/A6: one recipient's delivery attempts as `{name: {tries, last}}`.
 *
 * Until 2026-09-30 this file was a list of names, and a name on it was a
 * TOMBSTONE: `inbox new` put every listed message on it the moment it
 * printed the header lines — before anyone read a body or did the work.
 * A crash right after the listing made the message vanish from `new`
 * for good (ChatGPT letter 2026-09-30T04:26Z, point 6). Now an entry is
 * an ATTEMPT with a time: while the message is still open (effective
 * state, see `project()`), it comes back after a back-off. Ported from
 * lucky-mem (sitzungspost.mjs `nochFaellig`), where the same tombstone
 * held a letter for 43 hours on 2026-08-30.
 *
 * An old name list stays readable: every name counts as one attempt with
 * no time, so it is due once more, and counted properly from then on.
 */
function attempts(all, to) {
  const raw = all[to];
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((n) => [n, { tries: 1, last: null }]));
  return raw && typeof raw === 'object' ? raw : {};
}

/** Back-off before a listed but still open message is offered again. Grows per try, capped. */
export const RETRY_MIN = 15;
export const RETRY_MAX_MIN = 240;
function waitMin(tries, base = RETRY_MIN) {
  const n = Math.max(1, Number(tries) || 1);
  return Math.min(base * (2 ** (n - 1)), RETRY_MAX_MIN);
}

function dueAgain(m, entry, now, base) {
  if (m.state !== STATE.OPEN) return false; // done is done (effective state)
  const last = entry?.last ? new Date(entry.last) : null;
  if (!last || Number.isNaN(last.getTime())) return true;
  return (new Date(now) - last) / 60000 >= waitMin(entry.tries, base);
}

export function inboxMtime(root) {
  const dir = inboxDir(root);
  if (!fs.existsSync(dir)) return null;
  let latest = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    latest = Math.max(latest, fs.statSync(path.join(dir, name)).mtimeMs);
  }
  return latest;
}

/**
 * What has arrived since the last look. "New" = "not in the seen list".
 */
export function newFor(root, participants, {
  to, now = new Date(), retryAfterMin = RETRY_MIN, holdWaiting = false, mine = null, permit = null,
}) {
  checkParticipant(participants, to, 'To');
  const { dir, messages, duplicates, broken, eventsBroken } = read(root, participants, { to });
  const tried = attempts(loadSeen(root), to);
  // Z3/A5: a message that is already through by the projection (header,
  // state event or claim done) is not new even at first sight — else
  // newFor offers a finished task as runnable (point 5).
  // Z3/A6: a listed message that is still open comes back after the
  // back-off; listing records an attempt, it never consumes.
  const due = (m) => (Object.hasOwn(tried, m.name)
    ? dueAgain(m, tried[m.name], now, retryAfterMin)
    : !isDone(m.state));
  const candidates = messages.filter(due);
  // Block S4 (routes): a message addressed to ANOTHER registered session
  // of this role is not offered here; it is counted, not dropped.
  const elsewhere = candidates.filter((m) => routes.forAnotherSession(root, m, mine));
  // Block S1: a headless run (the watcher's handler) is only handed what
  // may cost it a model run. A request still waiting for permission stays
  // unlisted — and unmarked, so it wakes later once permitted.
  const waiting = [];
  let fresh = candidates.filter((m) => !elsewhere.includes(m));
  if (holdWaiting) {
    const pm = permit ?? mailpermit.checker(root, { now });
    const human = (n) => isHuman(participants[n]);
    fresh = fresh.filter((m) => {
      const d = envelope.wakes(m, { permit: pm, human });
      if (d.reason === envelope.WAITING) { waiting.push({ ...m, waitingReason: d.detail ?? null }); return false; }
      return true;
    });
  }
  return {
    dir,
    duplicates,
    new: fresh,
    elsewhere,
    waiting,
    known: messages.length - candidates.length,
    // Z3/A9: unreadable messages travel along instead of vanishing here.
    // `read()` counted them; newFor threw the list away, and every surface
    // above it (CLI, MCP) showed a healthy empty inbox. Not filtered by
    // `to`: whom an unreadable message is for is exactly the unreadable
    // part. `eventsBroken` = unreadable lines in states.jsonl/claims.jsonl.
    broken: broken ?? [],
    eventsBroken: eventsBroken ?? [],
    mtime: inboxMtime(root),
  };
}

/**
 * Block S2/S4: which UNSEEN messages to `to` may wake a model now, on the
 * local tree — the decision `mem inbox wake` makes after the watcher's
 * pull, right before the handler (a paid model run) would start.
 *
 * Same rule as everywhere (`envelope.wakes`): waking intent, turn budget
 * left, and permission or budget (`mailpermit.checker`). Seen messages
 * never wake again — the same line `remoteNew` draws on the remote.
 *
 * `{ wake, waiting, quiet, broken }`, each entry `{ message, decision }`.
 */
export function wakeDecisions(root, participants, { to, now = new Date(), permit = null }) {
  checkParticipant(participants, to, 'To');
  const { messages, broken } = read(root, participants, { to });
  const seen = new Set(Object.keys(attempts(loadSeen(root), to)));
  const pm = permit ?? mailpermit.checker(root, { now });
  const human = (n) => isHuman(participants[n]);
  const wake = [];
  const waiting = [];
  const quiet = [];
  for (const m of messages) {
    if (seen.has(m.name)) continue;
    const d = envelope.wakes(m, { forRole: to, permit: pm, human });
    if (d.wakes) wake.push({ message: m, decision: d });
    else if (d.reason === envelope.WAITING) waiting.push({ message: m, decision: d });
    else quiet.push({ message: m, decision: d });
  }
  return { wake, waiting, quiet, broken };
}

/** Charge each woken message to its grant or budget — at most once per message. */
export function chargeWakes(root, wake, { via = 'watcher', now = new Date() } = {}) {
  const lines = [];
  for (const { message, decision } of wake) {
    const z = mailpermit.spend(root, message, decision.permit, { via, now });
    if (z) lines.push(z);
  }
  return lines;
}

/**
 * Record a delivery ATTEMPT (Z3/A6) — union, never replace. Not "this
 * message is done": only its effective state says that. Counts how often
 * and when, so the back-off does not send the same message every round.
 */
export function markSeen(root, { to, names, now = new Date() }) {
  const all = loadSeen(root);
  const tried = attempts(all, to);
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const name of names) {
    tried[name] = { tries: (Number(tried[name]?.tries) || 0) + 1, last: stamp };
  }
  all[to] = Object.fromEntries(Object.entries(tried).sort(([a], [b]) => a.localeCompare(b)));
  const p = path.join(root, SEEN_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  return Object.keys(tried).length;
}

export function whoAmI(root) {
  const p = path.join(root, WHOAMI_FILE);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').trim() || null;
}

export function setWhoAmI(root, participants, name) {
  checkParticipant(participants, name, 'Who');
  const p = path.join(root, WHOAMI_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${name}\n`, 'utf8');
  return name;
}

/**
 * Break a name back into parts. Returns null if it does not match.
 */
export function fromFileName(participants, name) {
  // `[a-z]+` stood here and rejected every agent whose name carries a
  // hyphen, a digit or a dot — `vm-admin` did not parse, so mail for
  // it was filed as unreadable and never announced. The name rule
  // lives in agents.mjs; a second, stricter copy of it here was a
  // silent allowlist nobody had decided on.
  const m = new RegExp(`^([0-9TZ-]+)--(${agents.NAME_PART})-to-(${agents.NAME_PART})`
    + `(?:${MARK_SEPARATOR}([a-z0-9]{1,12}(?:-[0-9]{1,3})?))?\\.md$`).exec(name);
  if (!m) return null;
  const [, time, from, to] = m;
  if (!Object.hasOwn(participants, from) || !Object.hasOwn(participants, to)) return null;
  return { time, from, to };
}

/**
 * What lies on the remote for `to` that we have not yet seen locally.
 * Never touches the working tree — `git ls-tree` on the remote branch.
 */
export function remoteNew(root, participants, { to, names }) {
  // Both formats (Z3/A6): the old name list and the attempt map.
  const seen = new Set(Object.keys(attempts(loadSeen(root), to)));
  const fresh = [];
  const unreadable = [];
  let known = 0;
  for (const full of names) {
    const name = full.split('/').pop();
    if (!name.endsWith('.md')) continue;
    const parts = fromFileName(participants, name);
    if (!parts) { unreadable.push(name); continue; }
    if (parts.to !== to) continue;
    if (seen.has(name)) known += 1;
    else fresh.push(name);
  }
  return { new: fresh.sort(), known, unreadable: unreadable.sort() };
}

/**
 * The watcher — looks at the remote for messages to `to`, does not
 * touch the working tree.
 *
 * Returns four states:
 *   { status: 'nothing',   known: N }
 *   { status: 'quiet',     known: N, waiting: [...], quiet: [...] }   new mail, none may wake
 *   { status: 'new',       new: [names that may wake], known: N, unreadable: [names], waiting, quiet }
 *   { status: 'broken',    reason: '...', detail: '...' }
 */
export function watch(root, participants, {
  to,
  branch = 'main',
  remote = 'origin',
  skipFetch = false,
  exec = null,
} = {}) {
  checkParticipant(participants, to, 'To');
  const run = exec ?? standardExec;
  let names;
  try {
    if (!skipFetch) {
      run('git', ['-C', root, 'fetch', remote, branch, '--quiet']);
    }
    const raw = run('git', ['-C', root, 'ls-tree', '-r', '--name-only',
      `${remote}/${branch}`, `${INBOX_DIR}/`]);
    names = raw.split('\n').filter(Boolean);
  } catch (err) {
    return {
      status: 'broken',
      reason: 'remote-unreachable',
      detail: String(err?.message ?? err).split('\n')[0],
    };
  }
  const { new: fresh, known, unreadable } = remoteNew(root, participants, { to, names });
  if (!fresh.length) return { status: 'nothing', known, unreadable };
  // Block S2/S4: a new NAME is not yet a reason to wake. Read each new
  // message from the remote (no checkout, no model) and ask the one wake
  // rule, with the remote copy of the permission ledger folded in — a
  // budget granted on another clone counts before it is pulled.
  const ref = `${remote}/${branch}`;
  let ledgerText = '';
  try {
    ledgerText = run('git', ['-C', root, 'show', `${ref}:${INBOX_DIR}/${path.basename(mailpermit.FILE)}`]);
  } catch { ledgerText = ''; } // no ledger on the remote yet: nothing granted there
  const pm = mailpermit.checker(root, { extraText: ledgerText });
  const human = (n) => isHuman(participants[n]);
  const wake = [];
  const waiting = [];
  const quiet = [];
  for (const name of fresh) {
    let m;
    try {
      m = { name, ...parse(run('git', ['-C', root, 'show', `${ref}:${INBOX_DIR}/${name}`])) };
    } catch {
      unreadable.push(name);
      continue;
    }
    const d = envelope.wakes(m, { forRole: to, permit: pm, human });
    if (d.wakes) wake.push(name);
    else if (d.reason === envelope.WAITING) waiting.push({ name, reason: d.detail ?? null });
    else quiet.push({ name, reason: d.reason });
  }
  if (!wake.length) return { status: 'quiet', known, unreadable, waiting, quiet };
  return { status: 'new', new: wake, known, unreadable, waiting, quiet };
}

function standardExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
