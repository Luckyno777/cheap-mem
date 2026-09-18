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
import * as agents from './agents.mjs';
import { bodyHash } from './retrieval.mjs';

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

function checkParticipant(participants, role, field) {
  if (typeof role !== 'string' || !Object.hasOwn(participants, role)) {
    throw new Error(
      `${field}: '${role}' has no inbox. Known: ${Object.keys(participants).join(', ')}`);
  }
}

export function build(participants, {
  from, to, time, subject, state = STATE.OPEN, text, requestId = null,
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
  const header = [
    `From: ${from}`, `To: ${to}`, `Time: ${time}`,
    `Subject: ${subject}`, `State: ${state}`,
    ...(requestId !== null ? [`Client-Request-Id: ${requestId}`] : []),
  ].join('\n');
  return `${header}\n\n${text.replace(/\s+$/, '')}\n`;
}

export function parse(content) {
  if (typeof content !== 'string') throw new Error('parse expects a string');
  const boundary = content.indexOf('\n\n');
  if (boundary < 0) throw new Error('No blank line — that is a header, not a message');
  const headerPart = content.slice(0, boundary);
  const text = content.slice(boundary + 2).replace(/\s+$/, '');

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

export function write(root, participants, {
  from, to, subject, text, now = new Date(), requestId = null,
}) {
  const time = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const content = build(participants, { from, to, time, subject, text, requestId });
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
  for (let n = 2; n < 1000; n += 1) {
    try {
      fs.writeFileSync(p, content, { encoding: 'utf8', flag: 'wx' });
      return { path: p, name, time };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // The counter belongs BEHIND the mark, not behind the recipient
      // name. It used to read `-2` right after the name, and
      // fromFileName returned null for that: the second message of a
      // second was unreadable and never announced as new. The repair
      // against losing a message had produced an undeliverable one.
      name = fileName(participants, { time, from, to, mark: `${mark}-${n}` });
      p = path.join(dir, name);
    }
  }
  throw new Error(`Inbox: 1000 messages in one second for '${base}' — refusing to guess`);
}

/**
 * Three states, never two: no dir, empty dir, has messages.
 */
export function read(root, participants, { to = null, state = null } = {}) {
  if (to !== null) checkParticipant(participants, to, 'To');
  const dir = inboxDir(root);
  if (!fs.existsSync(dir)) return { dir: null, messages: [] };

  const messages = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const m = { name, ...parse(fs.readFileSync(path.join(dir, name), 'utf8')) };
    if (to !== null && m.to !== to) continue;
    if (state !== null && m.state !== state) continue;
    messages.push(m);
  }
  return { dir, messages };
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

export function setState(root, participants, name, newState) {
  if (!Object.values(STATE).includes(newState)) {
    throw new Error(`Unknown state '${newState}'. Known: ${Object.values(STATE).join(', ')}`);
  }
  checkMessageName(name);
  const p = path.join(inboxDir(root), name);
  if (!fs.existsSync(p)) throw new Error(`No message '${name}'`);
  const old = parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, build(participants, { ...old, state: newState }), 'utf8');
  return { ...old, state: newState, name };
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
export function newFor(root, participants, { to }) {
  checkParticipant(participants, to, 'To');
  const { dir, messages } = read(root, participants, { to });
  const seen = new Set(loadSeen(root)[to] ?? []);
  return {
    dir,
    new: messages.filter((m) => !seen.has(m.name)),
    known: messages.filter((m) => seen.has(m.name)).length,
    mtime: inboxMtime(root),
  };
}

export function markSeen(root, { to, names }) {
  const all = loadSeen(root);
  all[to] = [...new Set([...(all[to] ?? []), ...names])].sort();
  const p = path.join(root, SEEN_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  return all[to].length;
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
  const seen = new Set(loadSeen(root)[to] ?? []);
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
 * Returns three states:
 *   { status: 'nothing',   known: N }
 *   { status: 'new',       new: [names], known: N, unreadable: [names] }
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
  return { status: 'new', new: fresh, known, unreadable };
}

function standardExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
