// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * appointments — the calendar's store: an append-only drawer for appointments,
 * reminders, briefings and scheduled agent actions.
 *
 * Ported from lucky-mem (src/termine.mjs, the "Terminuhr") in English. The
 * clock that fires them is `appointment-clock.mjs`; the day list and the
 * dashboard view are `appointment-today.mjs`; calendar invitations to an
 * outside calendar are `appointment-invite.mjs`. This file is the data:
 * lines in, state out, and every rule about who may do what.
 *
 * **Where it lives.** `appointments/` under the memory root, NOT under
 * `global/` or `projects/`: the doctor measures findability there, and
 * appointment lines (a time, a title, an id) would be foreign bodies that
 * skew every rate. Three append-only files (`*.jsonl` merges with `union`):
 *
 *   appointments.jsonl   type: appointment | cancel | move | confirm
 *   fired.jsonl          type: intent | delivered | seen | proposal-dropped | dropped-reported
 *   settings.jsonl       type: setting (the two caps, with who and when)
 *
 * **Three kinds, one path.**
 *   (a) reminder    a note to the human (Intent: information, never wakes).
 *   (b) action      `wake` + `task`: at the time, a letter WITH the task goes to the
 *                   agent (Intent: request). Only the human arms it (`--authority user`);
 *                   what an agent creates is `proposed` and does nothing until a
 *                   human confirms. The human's own planning IS the permission for
 *                   that one letter (a single grant in the permission ledger, see
 *                   `mailpermit.grantScheduled`); it gives the woken agent NO extra
 *                   rights: it is an ordinary letter and every house rule holds.
 *   (c) briefing    `kind: briefing`: the day's list, computed by code, as a letter
 *                   to the human. No model, wakes nobody, no cap.
 *
 * **Who is "the human".** The participant marked `"human": true` in
 * `.mem/config.json` — never a hardcoded name. The authority claim is the
 * same as everywhere in cheap-mem: `--authority user`, refused for a
 * headless run (`MEM_HEADLESS`) and for a process whose ceiling
 * (`CHEAP_MEM_MAX_AUTHORITY`) is below `user`.
 *
 * **Plain text, on purpose, and what `--private` does.** The drawer is plain
 * JSONL (a reminder has to be readable by the clock). Nothing is guessed to be
 * sensitive. `--private` stores the neutral title "Private appointment", keeps
 * NO text, and the invitation to an outside calendar carries the neutral title
 * too: the details are dropped, not hidden.
 *
 * **Once.** The clock writes an `intent` line first (key appointment|occurrence|stage),
 * then the letter, then `delivered`, all under a file lock. A run that dies
 * between intent and letter is repaired by the next tick, which finds the
 * letter through its request id and writes it only if it is missing.
 *
 * **Late, never twice, no storm.** After a pause (machine off) only the LATEST
 * missed occurrence of a repeat fires, once, marked `late`, with the number
 * skipped. What was already past when it was RECORDED: a reminder fires once at
 * once ("recorded late"); an action NEVER fires, it is `missed` and the human
 * gets a letter.
 *
 * **Caps.** At most N agent wake-ups per calendar day (default 10, set by the
 * human, with who/when). The (N+1)th is not fired but held, and the human gets
 * a letter. Reminders and briefings do not count. The cap counts WAKE-UPS, not
 * run time: `max_minutes` per action (default 30) is only a time budget written
 * into the letter, which this system cannot enforce.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendLine } from './append.mjs';
import * as authority from './authority.mjs';
import * as agentsMod from './agents.mjs';
import * as cfgmod from './config.mjs';
import * as tm from './appointment-time.mjs';

export const DIR = 'appointments';
export const APPOINTMENTS_FILE = 'appointments.jsonl';
export const FIRED_FILE = 'fired.jsonl';
export const SETTINGS_FILE = 'settings.jsonl';
export const LOCK = path.join('.mem', 'appointments.lock');

/** Default of the wake cap: agent wake-ups per calendar day. */
const CAP_DEFAULT = 10;
const CAP_MAX = 500;
/** Default of the daily limit for agent PROPOSALS made without the human's wish. */
const PROPOSAL_CAP_DEFAULT = 10;
const DEFAULT_MAX_MINUTES = 30;
const MAX_MINUTES_LIMIT = 240;
/** From this much lag a firing is `late`. */
const LATE_MS = 10 * 60000;
/** How long a fired, unseen reminder stays in the banner. */
const BANNER_WINDOW_MS = 48 * 3600000;
/** Duplicate: the same title, time at most this far apart. */
const DUPLICATE_MS = 10 * 60000;
export const PRIVATE_TITLE = 'Private appointment';
const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_TASK = 1000;
const MAX_QUOTE = 200;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SOURCES = ['cli', 'dashboard', 'mcp', 'session', 'reflector'];

export class AppointmentError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'AppointmentError'; this.code = code; Object.assign(this, extra); }
}

const filePath = (root, name) => path.join(root, DIR, name);
export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const newId = () => randomBytes(6).toString('hex');
export const keyOf = (id, occurrenceMs, stage) => `${id}|${iso(occurrenceMs)}|${stage}`;
/** The compact form of an instant, used inside request ids: 20261005t090000z. */
export const compact = (ms) => iso(ms).replace(/[-:]/g, '').toLowerCase();

/** The zone this memory speaks: config `timezone`, else CHEAP_MEM_TZ, else the system zone. */
export function zoneOf(root, env = process.env) {
  let configured = null;
  try { configured = cfgmod.readConfig(root).timezone ?? null; } catch { configured = null; }
  return tm.resolveZone(configured, env);
}

/** Read one JSONL file; broken lines are COUNTED, never silently skipped. */
function readFile(root, name) {
  const lines = []; let broken = 0;
  let raw = '';
  try { raw = fs.readFileSync(filePath(root, name), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return { lines, broken, exists: false }; }
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object' && !Array.isArray(o)) lines.push(o); else broken += 1; } catch { broken += 1; }
  }
  return { lines, broken, exists: true };
}

export function append(root, name, line) {
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  appendLine(filePath(root, name), `${JSON.stringify(line)}\n`);
  return line;
}

/** Is a claim of authority enough to count as the human? One place, the same rules as the permission ledger. */
export function actorFrom({ name, authority: claimed = null, env = process.env } = {}) {
  const claim = claimed === null || claimed === undefined || claimed === '' ? null : String(claimed).trim().toLowerCase();
  if (claim === null) return { name, human: false, reason: 'no --authority user' };
  if (claim !== 'user') return { name, human: false, reason: `'${claim}' is not 'user'` };
  if (env.MEM_HEADLESS) return { name, human: false, reason: `headless run (${env.MEM_HEADLESS})` };
  const ceiling = authority.ceilingFromEnv(env);
  if (ceiling && ceiling !== 'user') return { name, human: false, reason: `authority ceiling ${authority.CEILING_ENV}=${ceiling}` };
  return { name, human: true, reason: null };
}

// --- Reading and folding -------------------------------------------------------

/**
 * Fold the three files into the state. A correction counts only when it was
 * entitled (the human, or the author on their own not-yet-armed proposal or
 * plain reminder); otherwise it is listed as `disputed` and changes nothing.
 */
export function load(root) {
  const a = readFile(root, APPOINTMENTS_FILE);
  const f = readFile(root, FIRED_FILE);
  const s = readFile(root, SETTINGS_FILE);
  const items = new Map();
  const disputed = [];

  // cancelled | active (armed by a human, or a plain reminder) | proposed (any action without a
  // human, and any appointment created as a proposal).
  const statusOf = (x) => {
    if (x.cancelled) return 'cancelled';
    if (x.armed) return 'active';
    return (x.wake || x.proposal) ? 'proposed' : 'active';
  };

  for (const z of a.lines) {
    if (z.type === 'appointment') {
      const atMs = Date.parse(z.at);
      if (typeof z.id !== 'string' || !z.id || items.has(z.id) || !Number.isFinite(atMs)) continue;
      const briefing = z.kind === 'briefing';
      items.set(z.id, {
        id: z.id, ts: z.ts ?? null, title: String(z.title ?? ''), text: String(z.text ?? ''),
        atMs, firstAtMs: atMs, repeat: tm.REPEATS.includes(z.repeat) ? z.repeat : null,
        beforeMin: Number.isFinite(z.remind_before_min) ? z.remind_before_min : null,
        kind: briefing ? 'briefing' : 'reminder',
        proposal: z.proposed === true,
        requestedBy: z.requested_by === 'user' && typeof z.quote === 'string' && z.quote ? 'user' : null,
        quote: typeof z.quote === 'string' ? z.quote : null,
        source: typeof z.source === 'string' ? z.source : null,
        recordedLate: z.recorded_late === true,
        private: z.private === true,
        wake: typeof z.wake === 'string' && z.wake && !briefing ? z.wake : null,
        task: typeof z.task === 'string' && z.task ? z.task : null,
        maxMinutes: Number.isInteger(z.max_minutes) ? z.max_minutes : DEFAULT_MAX_MINUTES,
        by: typeof z.by === 'string' ? z.by : null,
        // Only a human as author arms anything.
        armed: z.authority === 'user' ? { by: z.by ?? null, ts: z.ts ?? null, how: 'creation' } : null,
        cancelled: null, moved: 0,
      });
      continue;
    }
    const x = items.get(z.target);
    if (!x) continue;
    const human = z.authority === 'user';
    if (z.type === 'confirm') {
      if (human && !x.armed) x.armed = { by: z.by ?? null, ts: z.ts ?? null, how: 'confirmation' };
      else if (!human) disputed.push({ type: z.type, target: z.target, by: z.by ?? null, why: 'not the human' });
      continue;
    }
    if (z.type === 'cancel' || z.type === 'move') {
      const own = z.by && z.by === x.by && (statusOf(x) === 'proposed' || !x.wake);
      if (!human && !own) { disputed.push({ type: z.type, target: z.target, by: z.by ?? null, why: 'only the human changes armed appointments' }); continue; }
      if (z.type === 'cancel') { x.cancelled = { ts: z.ts ?? null, by: z.by ?? null, why: z.why ?? null }; continue; }
      const next = Date.parse(z.at);
      if (Number.isFinite(next)) { x.atMs = next; x.moved += 1; }
    }
  }
  for (const x of items.values()) x.status = statusOf(x);

  // The clock: intents, deliveries, acknowledgements.
  const intents = [];
  const delivered = new Map(); // intent id -> line
  const seen = new Set();
  const dropped = []; // agent proposals the daily limit refused (a count, never content)
  const droppedReported = new Set(); // days for which the summary letter is out
  for (const z of f.lines) {
    if (z.type === 'intent' && typeof z.id === 'string' && typeof z.key === 'string') intents.push(z);
    else if (z.type === 'delivered' && typeof z.intent_id === 'string') delivered.set(z.intent_id, z);
    else if (z.type === 'seen' && typeof z.appointment === 'string' && typeof z.occurrence === 'string') seen.add(`${z.appointment}|${z.occurrence}`);
    else if (z.type === 'proposal-dropped' && Number.isFinite(Date.parse(z.ts))) dropped.push(z);
    else if (z.type === 'dropped-reported' && typeof z.day === 'string') droppedReported.add(z.day);
  }
  const FINAL = ['reminder', 'woke', 'briefing', 'missed', 'undeliverable'];
  const done = new Set(); // keys that are finished (never a second time)
  const held = new Map(); // key -> intent line (held by the cap, may be caught up the same day)
  const byKey = new Map(); // key -> latest intent
  for (const z of intents) {
    if (FINAL.includes(z.outcome)) done.add(z.key);
    else if (z.outcome === 'held') held.set(z.key, z);
    byKey.set(z.key, z);
  }
  const open = intents.filter((z) => !delivered.has(z.id));

  // The caps: the last valid setting of each key.
  let cap = { value: CAP_DEFAULT, source: 'default', by: null, ts: null };
  let proposalCap = { value: PROPOSAL_CAP_DEFAULT, source: 'default', by: null, ts: null };
  for (const z of s.lines) {
    if (z.type !== 'setting' || !Number.isInteger(z.value) || z.value < 0 || z.value > CAP_MAX || z.authority !== 'user') continue;
    if (z.key === 'wake') cap = { value: z.value, source: 'setting', by: z.by ?? null, ts: z.ts ?? null };
    if (z.key === 'proposals') proposalCap = { value: z.value, source: 'setting', by: z.by ?? null, ts: z.ts ?? null };
  }
  return {
    items, disputed, intents, delivered, seen, done, held, byKey, open, cap, proposalCap, dropped, droppedReported,
    broken: a.broken + f.broken + s.broken, exists: a.exists || f.exists || s.exists,
  };
}

/** Agent wake-ups fired on the calendar day of `nowMs`. */
export function wakesToday(state, nowMs, zone) {
  const clock = tm.clockFor(zone);
  const today = clock.day(nowMs);
  return state.intents.filter((z) => z.outcome === 'woke' && clock.day(Date.parse(z.ts)) === today).length;
}

/** Proposals an AGENT made today without the human's wish (they wait under "waiting for you"). */
function proposalsToday(state, nowMs, zone) {
  const clock = tm.clockFor(zone);
  const today = clock.day(nowMs);
  let n = 0;
  for (const x of state.items.values()) {
    if (x.proposal && !x.requestedBy && x.ts && clock.day(Date.parse(x.ts)) === today && !(x.by ?? '').startsWith('human:')) n += 1;
  }
  return n;
}

/** How many proposals did the daily limit refuse on the day of `nowMs`? */
export function droppedToday(state, nowMs, zone) {
  const clock = tm.clockFor(zone);
  const today = clock.day(nowMs);
  return state.dropped.filter((z) => clock.day(Date.parse(z.ts)) === today).length;
}

// --- The plan: what is due now ----------------------------------------------------

/**
 * What the clock would do NOW — without writing anything (`mem appointment due`
 * is exactly this dry run; `tick` carries out the same list).
 *
 * Returns `{ entries, cap, today }`. Per entry: `action` = remind | wake | hold |
 * briefing | missed | undeliverable, `stage` = before | main, `late`, `recordedLate`,
 * `skipped`, `afterCap`. `canWake(name)` says whether a recipient exists.
 */
export function plan(state, nowMs, { zone, canWake = () => true } = {}) {
  const raw = [];
  for (const x of state.items.values()) {
    if (x.status !== 'active') continue;
    // What was already past at recording/confirmation never fires as an action afterwards.
    const confirmed = x.armed?.how === 'confirmation' ? Date.parse(x.armed.ts) : -Infinity;
    const recorded = x.ts ? Date.parse(x.ts) - 60000 : -Infinity;
    const lower = x.wake ? Math.max(confirmed, recorded) : -Infinity;

    // Main: the LATEST occurrence that is not after now.
    const last = tm.lastUntil(x.atMs, x.repeat, nowMs, zone);
    if (last) {
      const key = keyOf(x.id, last.ms, 'main');
      if (!state.done.has(key)) {
        if (x.wake && last.ms <= lower) {
          // A one-off action whose time had passed: missed, and the human is told. A repeat simply starts with its next occurrence.
          if (!x.repeat) raw.push({ item: x, stage: 'main', occurrenceMs: last.ms, key, action: 'missed', late: true, lagMs: nowMs - last.ms, skipped: 0 });
        } else if (x.kind === 'briefing' && tm.clockFor(zone).day(last.ms) !== tm.clockFor(zone).day(nowMs)) {
          // A briefing for a day that is over would be wrong ("today"): it falls away.
        } else {
          // How many occurrences lie between the last fired one and this: they fall away, no storm.
          let lastDone = -Infinity;
          for (const k of [...state.done, ...state.held.keys()]) {
            const [id, occ, stage] = k.split('|');
            if (id === x.id && stage === 'main') lastDone = Math.max(lastDone, Date.parse(occ));
          }
          const from = Math.max(lastDone + 1, x.atMs, Number.isFinite(lower) ? lower + 1 : -Infinity);
          const between = tm.inWindow(x.atMs, x.repeat, from, last.ms, { max: 100000, zone }).length;
          const recordedLate = x.recordedLate && last.k === 0;
          raw.push({
            item: x, stage: 'main', occurrenceMs: last.ms, key,
            action: x.wake ? 'wake' : (x.kind === 'briefing' ? 'briefing' : 'remind'),
            late: recordedLate || nowMs - last.ms > LATE_MS, recordedLate, lagMs: nowMs - last.ms, skipped: between,
          });
        }
      }
    }
    // Before: shortly BEFORE the next occurrence; if it is past, main took over.
    if (x.beforeMin && x.kind !== 'briefing') {
      const next = tm.nextAfter(x.atMs, x.repeat, nowMs, zone);
      if (next && nowMs >= next.ms - x.beforeMin * 60000 && !(x.wake && next.ms <= lower)) {
        const key = keyOf(x.id, next.ms, 'before');
        if (!state.done.has(key)) {
          const due = next.ms - x.beforeMin * 60000;
          raw.push({ item: x, stage: 'before', occurrenceMs: next.ms, key, action: 'remind', late: nowMs - due > LATE_MS, lagMs: nowMs - due, skipped: 0 });
        }
      }
    }
  }
  raw.sort((p, q) => p.occurrenceMs - q.occurrenceMs || p.key.localeCompare(q.key));

  // Reachability, then the cap — in time order, so earlier wake-ups count first.
  let today = wakesToday(state, nowMs, zone);
  const clock = tm.clockFor(zone);
  const dayNow = clock.day(nowMs);
  const entries = [];
  for (const p of raw) {
    if (p.action !== 'wake') { entries.push(p); continue; }
    if (!canWake(p.item.wake)) { entries.push({ ...p, action: 'undeliverable', reason: `'${p.item.wake}' is not a participant of this memory (any more)` }); continue; }
    const wasHeld = state.held.has(p.key);
    if (today >= state.cap.value) {
      // Already held and the human knows: stay quiet, no second letter.
      if (!wasHeld) entries.push({ ...p, action: 'hold' });
      continue;
    }
    // A held occurrence is caught up only on the SAME calendar day — a day later it would be an ambush.
    if (wasHeld && clock.day(p.occurrenceMs) !== dayNow) continue;
    today += 1;
    entries.push({ ...p, afterCap: wasHeld, late: p.late || wasHeld });
  }
  return { entries, cap: state.cap, today: wakesToday(state, nowMs, zone) };
}

// --- Writing -----------------------------------------------------------------------

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function checkField(name, value, max, { required = false, single = true } = {}) {
  const s = single ? oneLine(value ?? '') : String(value ?? '').replace(/\s+$/, '');
  if (required && !s) throw new AppointmentError('INVALID', `${name} is missing`);
  if (s.length > max) throw new AppointmentError('INVALID', `${name} is too long (${s.length} > ${max} characters)`);
  if (CONTROL.test(s)) throw new AppointmentError('INVALID', `${name} contains control characters`);
  return s;
}

const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Is there already an appointment with the same title and (at most 10 min apart) time — whoever made it? */
export function findDuplicate(state, { title, atMs, kind = 'reminder' }, zone) {
  const t = titleKey(title);
  for (const x of state.items.values()) {
    if (x.status === 'cancelled' || x.kind !== kind || titleKey(x.title) !== t) continue;
    if (tm.inWindow(x.atMs, x.repeat, atMs - DUPLICATE_MS, atMs + DUPLICATE_MS + 1, { max: 5, zone }).length) return x;
  }
  return null;
}

/**
 * Create an appointment. Throws `AppointmentError` (code INVALID | RIGHTS).
 * Returns `{ id, status, duplicate, dropped, line, warnings }`. `actor` comes from `actorFrom`.
 *
 *   kind          reminder (default) | briefing
 *   source        cli | dashboard | mcp | session | reflector (for checking, not for permission)
 *   requestedBy   { by: 'user', quote } — a session records the user's explicit request; a
 *                 reminder is then active at once, an action stays `proposed` all the same
 *   reminderActive  false: even a reminder is only a proposal (an agent without the user's request)
 *   private       neutral title, no text — see the header
 *
 * **Daily limit for proposals.** An agent makes at most N (default 10, `mem appointment cap <n> --proposals`)
 * proposals per calendar day WITHOUT the user's quoted request; the next one is not created,
 * only counted (`dropped: true`), and one summary letter goes to the human.
 */
export function create(root, {
  title, text = '', atMs, repeat = null, beforeMin = null, wake = null, task = null, maxMinutes = null,
  kind = 'reminder', source = 'cli', requestedBy = null, reminderActive = true, isPrivate = false,
  actor, now = Date.now(), env = process.env,
}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const zone = zoneOf(root, env);
  if (kind !== 'reminder' && kind !== 'briefing') throw new AppointmentError('INVALID', `kind is reminder or briefing, not '${kind}'`);
  if (!SOURCES.includes(source)) throw new AppointmentError('INVALID', `source is one of ${SOURCES.join(' | ')}, not '${source}'`);
  let t = checkField('title', title || (kind === 'briefing' ? 'Today in the calendar' : ''), MAX_TITLE, { required: true });
  let tx = checkField('text', text, MAX_TEXT, { single: false });
  if (!Number.isFinite(atMs)) throw new AppointmentError('INVALID', 'at: not a point in time');
  if (repeat !== null && !tm.REPEATS.includes(repeat)) throw new AppointmentError('INVALID', `repeat is one of ${tm.REPEATS.join(' | ')}, not '${repeat}'`);
  if (beforeMin !== null && !(Number.isInteger(beforeMin) && beforeMin >= 1 && beforeMin <= 43200)) {
    throw new AppointmentError('INVALID', 'remind-before: 1 minute to 30 days (e.g. 15m, 2h, 1d)');
  }
  let wish = null;
  if (requestedBy) {
    if (requestedBy.by !== 'user') throw new AppointmentError('INVALID', "requested_by is only 'user'");
    const q = oneLine(requestedBy.quote ?? '');
    if (!q) throw new AppointmentError('INVALID', `requested_by needs the user's sentence in their words (quote, at most ${MAX_QUOTE} characters) as evidence`);
    if (q.length > MAX_QUOTE) throw new AppointmentError('INVALID', `quote is too long (${q.length} > ${MAX_QUOTE})`);
    if (CONTROL.test(q)) throw new AppointmentError('INVALID', 'quote contains control characters');
    wish = { by: 'user', quote: q };
  }
  let target = null; let task2 = null; let minutes = null;
  const warnings = [];
  if (wake !== null && wake !== '') {
    if (kind === 'briefing') throw new AppointmentError('INVALID', 'A briefing wakes nobody (no --wake).');
    target = String(wake).trim();
    const participants = participantsOf(root);
    const human = cfgmod.humanParticipant(participants).name;
    if (target === human) throw new AppointmentError('INVALID', `wake: '${target}' is the human — for them it is a reminder (leave out --wake).`);
    if (!Object.hasOwn(participants, target)) {
      throw new AppointmentError('INVALID', `wake: '${target}' has no inbox. Known: ${Object.keys(participants).join(', ')}`);
    }
    task2 = checkField('task', task, MAX_TASK, { required: true, single: false });
    minutes = maxMinutes === null || maxMinutes === undefined ? DEFAULT_MAX_MINUTES : Number(maxMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES_LIMIT) throw new AppointmentError('INVALID', `max-minutes: 1 to ${MAX_MINUTES_LIMIT}`);
    try {
      const a = agentsMod.readAgent(root, target);
      const silent = a ? agentsMod.silentStatus(a, new Date(nowMs)) : null;
      if (silent?.silent) warnings.push(`'${target}' announced silence until ${silent.until}${silent.why ? ` (${silent.why})` : ''}: the letter will wait.`);
    } catch { /* no agents/ drawer: nothing to warn about */ }
    warnings.push('Whether a watcher is running for that participant is not measurable from here: the letter is delivered, waking needs a watcher (mem-watch).');
  } else if (task) {
    throw new AppointmentError('INVALID', 'task without wake: whom should the action wake? (--wake <agent>)');
  } else if (maxMinutes !== null && maxMinutes !== undefined) {
    throw new AppointmentError('INVALID', 'max-minutes without wake: a time budget exists only for an action.');
  }

  // Duplicate: the same thing does not go in twice, whatever the source.
  const state = load(root);
  const dup = findDuplicate(state, { title: t, atMs, kind }, zone);
  if (dup) {
    return { id: dup.id, status: dup.status, duplicate: true, dropped: false, line: null, warnings: [`already there (appointment ${dup.id}, "${dup.title}", ${dup.status}) — nothing created.`] };
  }

  // The daily limit for agent proposals without the user's quoted request: beyond it nothing is created, only counted.
  const armed = actor?.human === true;
  const wouldBeProposal = target ? !armed : (!armed && !reminderActive);
  if (wouldBeProposal && !wish && !String(actor?.name ?? '').startsWith('human:')) {
    const n = proposalsToday(state, nowMs, zone);
    if (n >= state.proposalCap.value) {
      append(root, FIRED_FILE, { type: 'proposal-dropped', id: newId(), ts: iso(nowMs), by: actor?.name ?? 'unknown', source });
      return {
        id: null, status: 'dropped', duplicate: false, dropped: true, line: null,
        warnings: [`Daily limit reached: ${n} of ${state.proposalCap.value} proposals without the user's request today — NOT created, only counted (the user gets a daily summary). `
          + "With the user's request (requested_by + a verbatim quote) it would be free."],
      };
    }
  }

  const priv = isPrivate === true;
  if (priv) {
    if (target) throw new AppointmentError('INVALID', 'A private appointment cannot wake an agent: the agent has to read the task in plain text. Word the task neutrally and leave out --private.');
    t = PRIVATE_TITLE; tx = '';
    warnings.push(`Details dropped (--private): only "${PRIVATE_TITLE}" is stored, and only that goes to an outside calendar.`);
  }
  const id = newId();
  const line = {
    type: 'appointment', id, ts: iso(nowMs), ...(kind === 'briefing' ? { kind } : {}), title: t, ...(tx ? { text: tx } : {}),
    at: iso(atMs), ...(repeat ? { repeat } : {}), ...(beforeMin ? { remind_before_min: beforeMin } : {}),
    ...(target ? { wake: target, task: task2, max_minutes: minutes } : {}),
    ...(priv ? { private: true } : {}),
    ...(atMs < nowMs - 60000 ? { recorded_late: true } : {}),
    by: actor?.name ?? 'unknown', source,
    ...(wish ? { requested_by: 'user', quote: priv ? '(private: wording not stored)' : wish.quote } : {}),
    // Only a human arms it; an agent makes a proposal.
    ...(armed ? { authority: 'user' } : {}),
    ...(wouldBeProposal ? { proposed: true } : {}),
  };
  append(root, APPOINTMENTS_FILE, line);
  if (line.recorded_late) {
    warnings.push(target
      ? 'The time is already past: an action NEVER fires afterwards, it counts as missed and the user gets a letter.'
      : 'The time is already past: the reminder arrives once at once, marked "recorded late".');
  }
  return { id, status: wouldBeProposal ? 'proposed' : 'active', duplicate: false, dropped: false, line, warnings };
}

/** The configured participants (config + registered agents), `{}` when there is no config. */
export function participantsOf(root) {
  try { return cfgmod.readConfig(root).participants; } catch { return {}; }
}

function current(root, id) {
  const state = load(root);
  const x = state.items.get(id);
  if (!x) throw new AppointmentError('UNKNOWN', `Appointment '${id}' does not exist. List them: mem appointment list --all`);
  return { state, x };
}

function mayChange(x, actor) {
  if (actor?.human) return true;
  // An agent may change only ITS OWN proposal or its own plain reminder.
  return x.by === actor?.name && (x.status === 'proposed' || !x.wake);
}

export function cancel(root, id, { actor, why = null, now = Date.now() }) {
  const { x } = current(root, id);
  if (x.status === 'cancelled') return { id, already: true };
  if (!mayChange(x, actor)) {
    throw new AppointmentError('RIGHTS', `Appointment ${id} is armed (by the user) or belongs to someone else — only the user cancels it: mem appointment cancel ${id} --authority user`);
  }
  append(root, APPOINTMENTS_FILE, {
    type: 'cancel', id: newId(), ts: iso(now), target: id, by: actor?.name ?? 'unknown',
    ...(actor?.human ? { authority: 'user' } : {}), ...(why ? { why: checkField('why', why, 500) } : {}),
  });
  return { id, already: false };
}

export function move(root, id, { atMs, actor, now = Date.now() }) {
  const { x } = current(root, id);
  if (x.status === 'cancelled') throw new AppointmentError('INVALID', `Appointment ${id} is cancelled — make a new one.`);
  if (!mayChange(x, actor)) {
    throw new AppointmentError('RIGHTS', `Appointment ${id} is armed (by the user) or belongs to someone else — only the user moves it: mem appointment move ${id} --at ... --authority user`);
  }
  if (!Number.isFinite(atMs)) throw new AppointmentError('INVALID', 'at: not a point in time');
  if (atMs < now - 60000) throw new AppointmentError('INVALID', 'at is in the past.');
  append(root, APPOINTMENTS_FILE, { type: 'move', id: newId(), ts: iso(now), target: id, at: iso(atMs), by: actor?.name ?? 'unknown', ...(actor?.human ? { authority: 'user' } : {}) });
  return { id, atMs };
}

/** Arm a proposal — ONLY a human (like `mem skill status --authority user`). */
export function confirm(root, id, { actor, now = Date.now() }) {
  const { x } = current(root, id);
  if (!actor?.human) {
    throw new AppointmentError('RIGHTS', `Confirming is for a human: mem appointment confirm <id> --authority user (${actor?.reason ?? 'no human origin'}). Nothing written.`);
  }
  if (x.status === 'cancelled') throw new AppointmentError('INVALID', `Appointment ${id} is cancelled.`);
  if (x.armed || x.status !== 'proposed') return { id, already: true };
  append(root, APPOINTMENTS_FILE, { type: 'confirm', id: newId(), ts: iso(now), target: id, by: actor.name, authority: 'user' });
  return { id, already: false };
}

/**
 * Set a cap — ONLY a human; an agent never raises its own limit.
 * `key`: `wake` (agent wake-ups per day) or `proposals` (agent proposals without the user's request per day).
 */
export function setCap(root, value, { actor, now = Date.now(), key = 'wake' }) {
  if (key !== 'wake' && key !== 'proposals') throw new AppointmentError('INVALID', `cap: key is wake | proposals, not '${key}'`);
  if (!actor?.human) {
    throw new AppointmentError('RIGHTS', `Only the user sets the cap: mem appointment cap <n>${key === 'proposals' ? ' --proposals' : ''} --authority user (${actor?.reason ?? 'no human origin'}). Nothing written.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > CAP_MAX) throw new AppointmentError('INVALID', `cap: a whole number 0 to ${CAP_MAX} (0 = no wake-up / no proposal), not '${value}'`);
  const state = load(root);
  const before = key === 'proposals' ? state.proposalCap : state.cap;
  const line = { type: 'setting', id: newId(), ts: iso(now), key, value: n, previous: before.value, by: actor.name, authority: 'user' };
  append(root, SETTINGS_FILE, line);
  return line;
}

/** Mark an occurrence as seen (the banner). No rights question: it only changes the display. */
export function markSeen(root, { appointment, occurrence, by = null, now = Date.now() }) {
  if (!/^[0-9a-f]{12}$/.test(String(appointment)) || !Number.isFinite(Date.parse(occurrence))) {
    throw new AppointmentError('INVALID', 'seen: an appointment id and an occurrence (ISO) are needed');
  }
  append(root, FIRED_FILE, { type: 'seen', appointment, occurrence: iso(Date.parse(occurrence)), ts: iso(now), by });
  return { appointment, occurrence };
}

export const limits = Object.freeze({ BANNER_WINDOW_MS, CAP_MAX, DEFAULT_MAX_MINUTES });
