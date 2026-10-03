// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * appointment-today — "Today in the calendar": the day's list, by code, no model.
 *
 * Ported from lucky-mem (src/termine-heute.mjs). Four consumers, ONE computation:
 *   - the briefing (a letter to the human, "Today in the calendar (<weekday>, <date>)"),
 *   - `mem appointment today [--json]` and the dashboard's Calendar tab,
 *   - the one line for a session start (`sessionLine`, hard-capped at LINE_MAX_BYTES),
 *   - the dashboard's "Today in the calendar" head.
 *
 * What belongs in it: the appointments of today's calendar day (in the configured zone), the
 * scheduled agent actions of today with their state, open duties addressed to the human, the
 * letters that wait for the human, and cheaply: what fired or was missed yesterday. A briefing
 * that a model summarises is NOT built, on purpose (code first, model last): it would be its own
 * path later and would count against the cap.
 *
 * **The state of an action** comes from the inbox states that already exist, nothing new:
 *   due           the clock decided, the letter is not written yet
 *   delivered     the letter lies there, nobody has taken it
 *   taken         an agent holds the claim (`mem inbox claim`)
 *   done          claim done, or the letter answered / processed / closed
 *   no-response   delivered and still untouched after NO_RESPONSE_MS (2 h)
 *   claim-expired the claim ran out without `done`
 */
import * as inbox from './inbox.mjs';
import * as memory from './memory.mjs';
import * as cfgmod from './config.mjs';
import * as A from './appointments.mjs';
import * as tm from './appointment-time.mjs';

const NO_RESPONSE_MS = 2 * 3600000;
/** The session-start line may carry at most this many bytes (a hook budget: one short line). */
export const LINE_MAX_BYTES = 160;
const ACTION_WINDOW_MS = 72 * 3600000;
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');

function letters(root) {
  const participants = A.participantsOf(root);
  try { return new Map(inbox.read(root, participants, {}).messages.map((m) => [m.name, m])); } catch { return new Map(); }
}

/** The state of each action fired in the last 72 h (a wake-up), from the inbox states. */
export function actionStates(root, state, nowMs, zone) {
  const fired = state.intents.filter((a) => a.outcome === 'woke' && nowMs - Date.parse(a.ts) <= ACTION_WINDOW_MS);
  if (!fired.length) return [];
  const mail = letters(root);
  const clock = tm.clockFor(zone);
  return fired.map((a) => {
    const d = state.delivered.get(a.id);
    const x = state.items.get(a.appointment);
    let st = 'due';
    const name = d?.letter ?? null;
    if (d) {
      st = 'delivered';
      const m = name ? mail.get(name) : null;
      if (m) {
        if (inbox.isDone(m.state) || m.claim?.status === 'done') st = 'done';
        else if (m.claim?.status === 'claimed') st = 'taken';
        else if (m.claim?.status === 'expired') st = 'claim-expired';
        else if (nowMs - Date.parse(d.ts) > NO_RESPONSE_MS) st = 'no-response';
      } else if (name && nowMs - Date.parse(d.ts) > NO_RESPONSE_MS) st = 'no-response';
    }
    return {
      intent: a.id, appointment: a.appointment, title: x?.title ?? '?', occurrence: a.occurrence, when: clock.text(Date.parse(a.occurrence)),
      to: a.to ?? x?.wake ?? null, state: st, letter: name, deliveredAt: d?.ts ?? null, late: a.late === true, afterCap: a.after_cap === true,
    };
  });
}

/** Open duties addressed to the human that have a date field ... or at least how many are open. */
function dutiesSituation(root, dayText) {
  let open = [];
  try { open = memory.openDuties(root) ?? []; } catch { return { open: null, withDate: 0, due: [] }; }
  if (!Array.isArray(open)) open = open.open ?? [];
  const due = []; let withDate = 0;
  for (const p of open) {
    let d = null;
    for (const f of ['due', 'due_date', 'until', 'deadline']) {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(p[f] ?? ''));
      if (m) { d = m[1]; break; }
    }
    if (!d) continue;
    withDate += 1;
    if (d <= dayText) due.push({ id: p.id, title: String(p.title ?? p.text ?? '').slice(0, 120), date: d, overdue: d < dayText });
  }
  due.sort((a, b) => a.date.localeCompare(b.date));
  return { open: open.length, withDate, due: due.slice(0, 8) };
}

/** Letters waiting for the human (without the calendar's own reminders). */
function waitingForHuman(root) {
  try {
    const participants = A.participantsOf(root);
    const human = cfgmod.humanParticipant(participants).name;
    if (!human) return { n: null, subjects: [] };
    const all = inbox.read(root, participants, { to: human }).messages
      .filter((m) => !inbox.isDone(m.state) && !String(m.requestId ?? '').startsWith('appt-'));
    return { n: all.length, subjects: all.slice(-5).map((m) => String(m.subject).slice(0, 100)) };
  } catch { return { n: null, subjects: [] }; }
}

/**
 * The day list for the calendar day of `now` — all code. `state` optional (already loaded).
 * Never throws: what cannot be read is `null`, never 0.
 */
export function today(root, { now = Date.now(), state = null, zone = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const z = zone ?? A.zoneOf(root);
  const clock = tm.clockFor(z);
  const st = state ?? A.load(root);
  const from = clock.dayStart(nowMs, 0);
  const to = clock.dayStart(nowMs, 1);
  const f = clock.fields(nowMs);
  const dayText = clock.day(nowMs);
  const yesterdayText = clock.day(clock.dayStart(nowMs, -1));
  const states = actionStates(root, st, nowMs, z);
  const stateByIntent = new Map(states.map((s) => [s.intent, s]));

  const items = [];
  for (const x of st.items.values()) {
    if (x.status === 'cancelled' || x.kind === 'briefing') continue;
    for (const v of tm.inWindow(x.atMs, x.repeat, from, to, { max: 50, zone: z })) {
      let state2 = null;
      if (x.wake) {
        const a = st.byKey.get(A.keyOf(x.id, v.ms, 'main'));
        if (x.status === 'proposed') state2 = 'proposed (waiting for the user)';
        else if (!a) state2 = 'planned';
        else if (a.outcome === 'woke') state2 = stateByIntent.get(a.id)?.state ?? 'delivered';
        else if (a.outcome === 'held') state2 = st.done.has(a.key) ? 'caught up' : 'held (cap)';
        else state2 = a.outcome;
      } else if (x.status === 'proposed') state2 = 'proposed (waiting for the user)';
      items.push({
        id: x.id, title: x.title, ms: v.ms, time: clock.hhmm(v.ms), wake: x.wake, private: x.private, status: x.status, state: state2,
        kind: x.kind, beforeMin: x.beforeMin, repeat: x.repeat,
      });
    }
  }
  items.sort((a, b) => a.ms - b.ms);

  const yesterday = st.intents
    .filter((a) => clock.day(Date.parse(a.ts)) === yesterdayText && a.outcome !== 'briefing')
    .map((a) => ({
      title: st.items.get(a.appointment)?.title ?? '?', outcome: a.outcome, late: a.late === true,
      state: a.outcome === 'woke' ? (stateByIntent.get(a.id)?.state ?? null) : null,
    }));

  return {
    day: dayText, weekday: WEEKDAY[f.weekday], dateText: dayText, zone: z,
    appointments: items, actions: items.filter((t) => t.wake),
    duties: dutiesSituation(root, dayText), letters: waitingForHuman(root), yesterday,
  };
}

/**
 * The day list as plain data for a machine (a morning routine that pushes a notification): always
 * the same shape, deterministic (same state + same time = same text), private titles already neutral.
 * `empty` says whether there is NOTHING to report today.
 */
export function machine(h, { cap = null } = {}) {
  const item = (t) => ({
    id: t.id, time: t.time, at: new Date(t.ms).toISOString(), atText: `${h.dateText} ${t.time}`, title: t.title,
    private: t.private === true, type: t.wake ? 'action' : 'reminder', repeat: t.repeat ?? null,
    remindBeforeMin: t.beforeMin ?? null, wake: t.wake ?? null, state: t.state ?? null, status: t.status,
  });
  const appointments = h.appointments.map(item);
  const empty = appointments.length === 0 && h.duties.due.length === 0 && !(h.letters.n > 0) && h.yesterday.length === 0;
  return {
    date: h.day, weekday: h.weekday, zone: h.zone, empty,
    appointments, actions: appointments.filter((t) => t.type === 'action'),
    duties: { due: h.duties.due, open: h.duties.open, withDate: h.duties.withDate },
    letters: { waiting: h.letters.n, subjects: h.letters.subjects },
    yesterday: h.yesterday,
    ...(cap ? { cap } : {}),
  };
}

export function briefingSubject(h, late = false) {
  return `Today in the calendar (${h.weekday}, ${h.dateText})${late ? ' (late)' : ''}`;
}

/** The letter text — short, plain ASCII, no model. */
export function briefingText(h, { late = null } = {}) {
  const z = [`Today in the calendar (${h.weekday}, ${h.dateText})`, ''];
  if (late) z.push(late, '');
  z.push(`Appointments today: ${h.appointments.length || 'none'}`);
  for (const t of h.appointments) {
    z.push(`- ${t.time} ${t.title}${t.wake ? ` [wakes ${t.wake}: ${t.state ?? 'planned'}]` : (t.state ? ` [${t.state}]` : '')}`);
  }
  if (h.actions.length) {
    z.push('', 'Scheduled agent actions today:');
    for (const t of h.actions) z.push(`- ${t.time} ${t.title} -> ${t.wake}: ${t.state ?? 'planned'}`);
  }
  z.push('');
  if (h.duties.open === null) z.push('Duties: not readable.');
  else if (h.duties.due.length) {
    z.push(`Duties due today or overdue: ${h.duties.due.length} (of ${h.duties.open} open)`);
    for (const p of h.duties.due) z.push(`- ${p.date}${p.overdue ? ' (overdue)' : ''} ${p.title} [${p.id}]`);
  } else {
    z.push(`Duties: ${h.duties.open} open, ${h.duties.withDate ? `${h.duties.withDate} with a date, none due today` : 'none carries a due date'}.`);
  }
  z.push('');
  if (h.letters.n === null) z.push('Letters for you: not readable.');
  else {
    z.push(`Letters waiting for you: ${h.letters.n}`);
    for (const b of h.letters.subjects) z.push(`- ${b}`);
  }
  if (h.yesterday.length) {
    z.push('', 'Yesterday:');
    for (const g of h.yesterday) z.push(`- ${g.title}: ${g.outcome}${g.late ? ' (late)' : ''}${g.state ? `, state ${g.state}` : ''}`);
  }
  return z.join('\n');
}

/**
 * The one line for a session start: "Today: 3 appointments, next 14:30 Title".
 * Empty (`''`) unless a briefing is active — whoever does not want one gets nothing. Reads only
 * the appointment file (no letters, no network), hard-capped at LINE_MAX_BYTES.
 */
export function sessionLine(root, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let st; let z;
  try { st = A.load(root); z = A.zoneOf(root); } catch { return ''; }
  if (![...st.items.values()].some((x) => x.kind === 'briefing' && x.status === 'active')) return '';
  const clock = tm.clockFor(z);
  const from = clock.dayStart(nowMs, 0);
  const to = clock.dayStart(nowMs, 1);
  const todays = [];
  for (const x of st.items.values()) {
    if (x.status === 'cancelled' || x.kind === 'briefing') continue;
    for (const v of tm.inWindow(x.atMs, x.repeat, from, to, { max: 50, zone: z })) todays.push({ ms: v.ms, title: x.title });
  }
  todays.sort((a, b) => a.ms - b.ms);
  const n = todays.length;
  const next = todays.find((t) => t.ms >= nowMs);
  const noun = n === 1 ? 'appointment' : 'appointments';
  let line;
  if (!n) line = 'Today: no appointments';
  else if (!next) line = `Today: ${n} ${noun}, all past`;
  else {
    const head = `Today: ${n} ${noun}, next ${clock.hhmm(next.ms)} `;
    let title = next.title.replace(/\s+/g, ' ');
    // Bytes, not characters: a multi-byte letter counts more.
    if (Buffer.byteLength(head + title, 'utf8') > LINE_MAX_BYTES) {
      while (Buffer.byteLength(`${head}${title}...`, 'utf8') > LINE_MAX_BYTES && title.length > 1) title = title.slice(0, -1);
      title = `${title.trimEnd()}...`;
    }
    line = head + title;
  }
  while (Buffer.byteLength(line, 'utf8') > LINE_MAX_BYTES) line = line.slice(0, -2);
  return line;
}

// --- The view: everything a surface needs -------------------------------------------

/** One appointment as a plain object for the CLI and the dashboard. */
export function present(x, nowMs, state, zone) {
  const clock = tm.clockFor(zone);
  const n = tm.nextAfter(x.atMs, x.repeat, nowMs, zone);
  let missed = false;
  if (state && x.wake && !x.repeat) missed = state.byKey.get(A.keyOf(x.id, x.atMs, 'main'))?.outcome === 'missed';
  return {
    id: x.id, title: x.title, text: x.text, at: A.iso(x.atMs), atText: clock.text(x.atMs),
    kind: x.kind, repeat: x.repeat, remindBeforeMin: x.beforeMin, wake: x.wake, task: x.task,
    maxMinutes: x.wake ? x.maxMinutes : null, private: x.private,
    status: missed ? 'missed' : x.status, by: x.by, source: x.source, armedBy: x.armed?.by ?? null,
    requestedBy: x.requestedBy, quote: x.quote, moved: x.moved,
    next: n && x.status !== 'cancelled' ? { at: A.iso(n.ms), text: clock.text(n.ms) } : null,
    cancelled: x.cancelled,
  };
}

/** One line per appointment for the CLI. */
export function shortLine(a) {
  const parts = [a.id, a.next ? a.next.text : `${a.atText} (past)`, a.title];
  if (a.kind === 'briefing') parts.push('[briefing]');
  if (a.repeat) parts.push(`[${a.repeat}]`);
  if (a.wake) parts.push(`[wakes ${a.wake}, max ${a.maxMinutes} min]`);
  if (a.private) parts.push('[private]');
  if (a.status !== 'active') parts.push(`[${a.status}]`);
  return parts.join('  ');
}

/**
 * Everything a surface needs: appointments, occurrences in a window, the banner, the cap, the
 * state of actions, "today". Small enough for ONE answer (appointments are short lines).
 */
export function overview(root, { now = Date.now(), fromMs = null, toMs = null, canWake = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const zone = A.zoneOf(root);
  const clock = tm.clockFor(zone);
  const state = A.load(root);
  const from = fromMs ?? clock.dayStart(nowMs, -7);
  const to = toMs ?? clock.dayStart(nowMs, 42);
  const appointments = [...state.items.values()].map((x) => present(x, nowMs, state, zone));
  const occurrences = [];
  for (const x of state.items.values()) {
    if (x.status === 'cancelled') continue;
    for (const v of tm.inWindow(x.atMs, x.repeat, from, to, { max: 200, zone })) {
      occurrences.push({ id: x.id, title: x.title, at: A.iso(v.ms), text: clock.text(v.ms), time: clock.hhmm(v.ms), day: clock.day(v.ms), wake: x.wake, kind: x.kind, status: x.status, repeat: x.repeat, private: x.private });
    }
  }
  occurrences.sort((p, q) => Date.parse(p.at) - Date.parse(q.at));

  // Banner: due / fired reminders (and cap holds) nobody ticked off.
  const banner = []; const seen = new Set();
  const plan = A.plan(state, nowMs, { zone, canWake: canWake ?? (() => true) });
  const kindOf = (action, outcome, stage) => {
    if (action === 'hold' || outcome === 'held') return 'cap';
    if (action === 'undeliverable' || outcome === 'undeliverable') return 'undeliverable';
    if (action === 'missed' || outcome === 'missed') return 'missed';
    if (action === 'briefing' || outcome === 'briefing') return 'briefing';
    return stage === 'before' ? 'before' : 'reminder';
  };
  for (const e of plan.entries) {
    if (e.action === 'wake') continue; // a wake-up is not a message to the human
    const k = `${e.item.id}|${A.iso(e.occurrenceMs)}`;
    if (state.seen.has(k) || seen.has(k)) continue;
    seen.add(k);
    banner.push({ appointment: e.item.id, occurrence: A.iso(e.occurrenceMs), title: e.item.title, text: clock.text(e.occurrenceMs), kind: kindOf(e.action, null, e.stage), late: e.late, fired: false, private: e.item.private });
  }
  for (const z of state.intents) {
    if (z.outcome === 'woke') continue;
    if (nowMs - Date.parse(z.ts) > A.limits.BANNER_WINDOW_MS) continue;
    const k = `${z.appointment}|${z.occurrence}`;
    if (state.seen.has(k) || seen.has(k)) continue;
    const x = state.items.get(z.appointment);
    if (!x) continue;
    seen.add(k);
    banner.push({ appointment: z.appointment, occurrence: z.occurrence, title: x.title, text: clock.text(Date.parse(z.occurrence)), kind: kindOf(null, z.outcome, z.stage), late: z.late === true, fired: true, private: x.private });
  }
  const held = [...state.held.values()].map((z) => ({
    appointment: z.appointment, title: state.items.get(z.appointment)?.title ?? '?', occurrence: z.occurrence,
    text: clock.text(Date.parse(z.occurrence)), to: z.to ?? state.items.get(z.appointment)?.wake ?? null, caughtUp: state.done.has(z.key),
  }));
  const h = today(root, { now: nowMs, state, zone });
  return {
    state: state.broken ? 'warning' : 'good', reason: state.broken ? `${state.broken} unreadable line(s) in ${A.DIR}/` : null,
    now: A.iso(nowMs), nowText: clock.text(nowMs), zone,
    cap: { ...state.cap, today: A.wakesToday(state, nowMs, zone), max: A.limits.CAP_MAX },
    proposalCap: state.proposalCap,
    appointments, occurrences, window: { from: A.iso(from), to: A.iso(to) },
    banner, held, actions: actionStates(root, state, nowMs, zone), today: h,
    briefingActive: [...state.items.values()].some((x) => x.kind === 'briefing' && x.status === 'active'),
    proposed: appointments.filter((t) => t.status === 'proposed').length,
    disputed: state.disputed.length,
  };
}
