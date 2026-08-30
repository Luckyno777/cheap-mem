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

/** Where messages live under the memory root. */
export const INBOX_DIR = path.join('inbox');

export const STATE = Object.freeze({
  OPEN: 'open',
  REPLIED: 'replied',
  PROCESSED: 'processed',
  CLOSED: 'closed',
});

const HEADER_FIELDS = ['From', 'To', 'Time', 'Subject', 'State'];

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

export function build(participants, { from, to, time, subject, state = STATE.OPEN, text }) {
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
  const header = [
    `From: ${from}`, `To: ${to}`, `Time: ${time}`,
    `Subject: ${subject}`, `State: ${state}`,
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
  };
}

export function fileName(participants, { time, from, to }) {
  checkParticipant(participants, from, 'From');
  checkParticipant(participants, to, 'To');
  const z = String(time).replace(/[:.]/g, '-');
  if (!/^[0-9TZ-]+$/.test(z)) throw new Error(`Time '${time}' is not ISO`);
  return `${z}--${from}-to-${to}.md`;
}

export function inboxDir(root) { return path.join(root, INBOX_DIR); }

export function write(root, participants, { from, to, subject, text, now = new Date() }) {
  const time = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const content = build(participants, { from, to, time, subject, text });
  const name = fileName(participants, { time, from, to });
  const dir = inboxDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return { path: p, name, time };
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

export function setState(root, participants, name, newState) {
  if (!Object.values(STATE).includes(newState)) {
    throw new Error(`Unknown state '${newState}'. Known: ${Object.values(STATE).join(', ')}`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`'${name}' is a path, not a filename`);
  }
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
  const m = /^([0-9TZ-]+)--([a-z]+)-to-([a-z]+)\.md$/.exec(name);
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
