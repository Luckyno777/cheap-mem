// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * appointment-clock — the clock: what is due NOW becomes a letter, exactly once.
 *
 * Ported from lucky-mem (src/termine.mjs, `ausloesen`). The rules live in
 * `appointments.mjs` (see its header); this file carries them out:
 *
 *   1. Repair: an `intent` without `delivered` (the run died between the two) is
 *      completed — the letter is looked up by its request id and written only if
 *      it is missing.
 *   2. Do: for every due entry write `intent`, then the letter, then `delivered`.
 *   3. Summary: one letter per calendar day about proposals the daily limit refused.
 *
 * Everything runs under a file lock, so two ticks never decide at the same time.
 * `tick` is idempotent: running it twice in a row does nothing the second time.
 *
 * **Who ticks.** `mem appointment tick` — `bin/mem-watch` calls it on every
 * poll (the watcher is the one process that already runs all day). Without an
 * `appointments/appointments.jsonl` it is a no-op that writes no file. One machine
 * should tick: two machines with the same clock would each fire the same reminder
 * (the `fired.jsonl` lines travel only with git). `MEM_WATCH_APPOINTMENTS=off`
 * keeps a machine's watcher out of it.
 *
 * **Letters.** A reminder and a summary are letters from the human participant to the
 * human participant (a note to oneself, Intent: information, never wakes). An action is a
 * letter from the human to the agent (Intent: request) plus ONE grant line in the
 * permission ledger: the human armed the appointment, so that letter may wake its recipient
 * without drawing on a budget. The letter says in its last lines that it carries no extra rights.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LockTimeoutError, withLock } from './filelock.mjs';
import * as cfgmod from './config.mjs';
import * as inbox from './inbox.mjs';
import * as mailpermit from './mailpermit.mjs';
import * as A from './appointments.mjs';
import * as today from './appointment-today.mjs';
import * as tm from './appointment-time.mjs';

const MARK = 'Clock-Entry: ';
/** From which wall-clock hour the day's summary of refused proposals goes out (or on the next day). */
const SUMMARY_FROM_HOUR = 20;
const OUTCOME_OF = { wake: 'woke', hold: 'held', remind: 'reminder', briefing: 'briefing', missed: 'missed', undeliverable: 'undeliverable' };
const ACTION_OF = Object.fromEntries(Object.entries(OUTCOME_OF).map(([k, v]) => [v, k]));

const requestIdOf = (intentId) => `appt-${intentId}`;

/** The letter for one entry — pure, so a test can read it. */
function letterFor(e, { intentId, nowMs, state, zone, human, root }) {
  const x = e.item;
  const clock = tm.clockFor(zone);
  const when = clock.text(e.occurrenceMs);
  const late = e.recordedLate
    ? `RECORDED LATE: the appointment was already past when it was entered (${when}); the reminder arrives once, at once.`
    : (e.late ? `LATE: due ${when}, fired ${clock.text(nowMs)} (${Math.round(e.lagMs / 60000)} min later).` : null);
  const skipped = e.skipped > 0 ? `${e.skipped} further missed occurrence(s) of this repeat were skipped (only the latest fires).` : null;
  const mark = `${MARK}${intentId}`;
  const privateNote = x.private ? ['(private: details are not stored)'] : [];
  const rid = requestIdOf(intentId);
  if (e.action === 'wake') {
    const lines = [
      `Scheduled task (appointment ${x.id}): ${x.title}`,
      `Due: ${when}`,
      ...(late ? [late] : []), ...(skipped ? [skipped] : []),
      ...(e.afterCap ? ['Caught up: it was held by the daily cap, and there is room again.'] : []),
      '',
      'TASK:', x.task, '',
      ...(x.text ? ['Note on the appointment:', x.text, ''] : []),
      `Time budget: at most ${x.maxMinutes} minutes. This is written only here — the system cannot enforce it; keep to it yourself and say if it is not enough.`,
      `Planned by the user (armed by ${x.armed?.by ?? '?'}, ${x.armed?.how ?? '?'}; created by ${x.by ?? '?'}, source ${x.source ?? '?'}).`,
      'This is an ordinary letter: the appointment gives you NO extra rights, every house rule holds. '
      + 'Take it (mem inbox claim), report done or failed, and answer the human in their inbox.',
      mark,
    ];
    return { from: human, to: x.wake, subject: `Scheduled task: ${x.title}${e.late ? ' (late)' : ''}`, text: lines.join('\n'), intent: 'request', requestId: rid, grantFor: x.id };
  }
  if (e.action === 'hold') {
    return {
      from: human, to: human, subject: `Held (cap): ${x.title}`, intent: 'information', requestId: rid,
      text: [
        `The scheduled task "${x.title}" for ${x.wake} (appointment ${x.id}, due ${when}) was NOT fired:`,
        'the daily cap for agent wake-ups is reached.',
        '',
        `Cap: ${state.cap.value} per day, woken already today: ${e.todayWakes}.`,
        'Raise it (only you): mem appointment cap <n> --authority user',
        'If there is room again on the same day, the task is caught up (late); on a later day it is not.',
        mark,
      ].join('\n'),
    };
  }
  if (e.action === 'undeliverable') {
    return {
      from: human, to: human, subject: `Not deliverable: ${x.title}`, intent: 'information', requestId: rid,
      text: [
        `The scheduled task "${x.title}" for ${x.wake} (appointment ${x.id}, due ${when}) was NOT delivered:`,
        e.reason ?? `'${x.wake}' cannot be written to from here.`,
        '',
        `Fix the recipient, or cancel it: mem appointment cancel ${x.id} --authority user`,
        mark,
      ].join('\n'),
    };
  }
  if (e.action === 'missed') {
    return {
      from: human, to: human, subject: `Missed: ${x.title}`, intent: 'information', requestId: rid,
      text: [
        `The scheduled task "${x.title}" for ${x.wake} (appointment ${x.id}) was due ${when} and did NOT fire:`,
        'its time was already past when it was recorded or confirmed. A task never fires afterwards.',
        '',
        `Plan it again if it still matters: mem appointment new --at "..." --title "${x.title}" --wake ${x.wake} --task "..." --authority user`,
        mark,
      ].join('\n'),
    };
  }
  if (e.action === 'briefing') {
    const h = today.today(root, { now: nowMs, state, zone });
    return { from: human, to: human, subject: today.briefingSubject(h, e.late), text: `${today.briefingText(h, { late })}\n${mark}`, intent: 'information', requestId: rid };
  }
  const head = e.stage === 'before' ? `Soon: ${x.title}` : `Appointment: ${x.title}`;
  return {
    from: human, to: human, subject: `${head} - ${when}${e.late ? ' (late)' : ''}`, intent: 'information', requestId: rid,
    text: [
      e.stage === 'before' ? `Reminder ahead (${x.beforeMin} min before) of appointment ${x.id}` : `Reminder (appointment ${x.id})`,
      `When: ${when}`, `Title: ${x.title}`,
      ...privateNote,
      ...(x.text ? [x.text] : []),
      ...(x.repeat ? [`Repeats: ${x.repeat}`] : []),
      ...(late ? [late] : []), ...(skipped ? [skipped] : []),
      mark,
    ].join('\n'),
  };
}

function summaryLetter(state, day, n, human) {
  const today2 = day;
  return {
    from: human, to: human, intent: 'information', requestId: `appt-dropped-${day}`,
    subject: `${n} agent proposal(s) dropped on ${today2} (cap)`,
    text: [
      `${n} appointment proposal(s) from agents on ${day} were NOT created: the daily limit for proposals without your request is reached.`,
      `Limit: ${state.proposalCap.value} per day. Your own reminders and anything with your quoted request do not count.`,
      'Raise it (only you): mem appointment cap <n> --proposals --authority user',
      `${MARK}dropped-${day}`,
    ].join('\n'),
  };
}

/** Is there already a letter for this request id? (Repair after a run that died between intent and letter.) */
function findLetter(root, participants, to, requestId) {
  let messages = [];
  try { messages = inbox.read(root, participants, { to }).messages; } catch { return null; }
  return messages.find((m) => m.requestId === requestId) ?? null;
}

function defaultSend(root, participants, nowMs, env) {
  return (letter) => {
    const prior = findLetter(root, participants, letter.to, letter.requestId);
    let name = prior?.name ?? null;
    if (!name) {
      const r = inbox.write(root, participants, {
        from: letter.from, to: letter.to, subject: letter.subject, text: letter.text, now: new Date(nowMs),
        requestId: letter.requestId, intent: letter.intent, env,
      });
      name = r.name;
    }
    // The human armed this appointment: its one letter may wake the recipient, no budget is drawn.
    if (letter.grantFor) mailpermit.grantScheduled(root, { message: name, appointment: letter.grantFor, now: new Date(nowMs) });
    return { name, existed: Boolean(prior) };
  };
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

/**
 * Let the clock tick once. Idempotent and safe against two simultaneous runs (file lock).
 * Without `appointments/appointments.jsonl` it is a no-op without any file.
 *
 * Returns `{ state: 'empty' | 'good' | 'locked' | 'blocked', fired: [...], repaired: n, errors: [...] }`.
 * `send` and `canWake` replace letter writing and the recipient check (tests).
 */
export function tick(root, { now = Date.now(), send = null, canWake = null, env = process.env } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!fs.existsSync(path.join(root, A.DIR, A.APPOINTMENTS_FILE))) return { state: 'empty', fired: [], repaired: 0, errors: [] };
  const participants = A.participantsOf(root);
  const human = cfgmod.humanParticipant(participants).name;
  if (!human) {
    return { state: 'blocked', fired: [], repaired: 0, errors: [`no participant is marked "human": true in .mem/config.json — letters from the clock need one (${cfgmod.humanParticipant(participants).reason})`] };
  }
  let zone;
  try { zone = A.zoneOf(root, env); } catch (e) { return { state: 'blocked', fired: [], repaired: 0, errors: [firstLine(e)] }; }
  const write = send ?? defaultSend(root, participants, nowMs, env);
  const reach = canWake ?? ((name) => Object.hasOwn(participants, name) && name !== human);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  try {
    return withLock(path.join(root, A.LOCK), () => {
      const fired = []; const errors = []; let repaired = 0;
      let state = A.load(root);

      // 1) Intents without a delivery: find the letter, else write it.
      for (const z of state.open) {
        try {
          const x = state.items.get(z.appointment);
          if (!x) continue;
          const e = {
            item: x, stage: z.stage, occurrenceMs: Date.parse(z.occurrence), key: z.key, action: ACTION_OF[z.outcome] ?? 'remind',
            late: z.late === true, recordedLate: z.recorded_late === true, lagMs: Math.max(0, Date.parse(z.ts) - Date.parse(z.occurrence)),
            skipped: z.skipped || 0, afterCap: z.after_cap === true, todayWakes: A.wakesToday(state, Date.parse(z.ts), zone), reason: z.reason ?? null,
          };
          const r = write(letterFor(e, { intentId: z.id, nowMs, state, zone, human, root }));
          A.append(root, A.FIRED_FILE, { type: 'delivered', intent_id: z.id, letter: r?.name ?? null, ts: A.iso(nowMs), recovered: true });
          repaired += 1;
        } catch (err) { errors.push(`repair ${z.id}: ${firstLine(err)}`); }
      }
      state = A.load(root);

      // 2) What is due now.
      const p = A.plan(state, nowMs, { zone, canWake: reach });
      for (const e of p.entries) {
        const intent = {
          type: 'intent', id: randomId(), ts: A.iso(nowMs), key: e.key, appointment: e.item.id,
          occurrence: A.iso(e.occurrenceMs), stage: e.stage, outcome: OUTCOME_OF[e.action],
          late: e.late === true, ...(e.recordedLate ? { recorded_late: true } : {}), skipped: e.skipped || 0,
          ...(e.afterCap ? { after_cap: true } : {}),
          ...(e.action === 'wake' || e.action === 'hold' || e.action === 'undeliverable' ? { to: e.item.wake } : {}),
          ...(e.action === 'hold' ? { cap: state.cap.value } : {}),
          ...(e.action === 'undeliverable' ? { reason: e.reason ?? null } : {}),
          by: 'appointment-clock',
        };
        A.append(root, A.FIRED_FILE, intent);
        try {
          const r = write(letterFor({ ...e, todayWakes: p.today }, { intentId: intent.id, nowMs, state, zone, human, root }));
          A.append(root, A.FIRED_FILE, { type: 'delivered', intent_id: intent.id, letter: r?.name ?? null, ts: A.iso(nowMs) });
        } catch (err) {
          // The intent stands; the next tick completes the letter (step 1).
          errors.push(`letter for ${e.key}: ${firstLine(err)}`);
        }
        fired.push({ id: intent.id, key: e.key, appointment: e.item.id, title: e.item.title, outcome: intent.outcome, late: intent.late, skipped: intent.skipped });
      }

      // 3) One summary per calendar day about proposals the daily limit refused: after 20:00 or on the next day.
      state = A.load(root);
      const clock = tm.clockFor(zone);
      const perDay = new Map();
      for (const z of state.dropped) { const d = clock.day(Date.parse(z.ts)); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
      const dayNow = clock.day(nowMs);
      for (const [day, n] of [...perDay].sort()) {
        if (state.droppedReported.has(day)) continue;
        if (day === dayNow && clock.fields(nowMs).hour < SUMMARY_FROM_HOUR) continue;
        try {
          const r = write(summaryLetter(state, day, n, human));
          A.append(root, A.FIRED_FILE, { type: 'dropped-reported', id: randomId(), ts: A.iso(nowMs), day, count: n, letter: r?.name ?? null });
          fired.push({ id: null, key: `dropped|${day}`, appointment: null, title: `${n} proposal(s) dropped (cap)`, outcome: 'dropped-reported', late: false, skipped: 0 });
        } catch (err) { errors.push(`summary ${day}: ${firstLine(err)}`); }
      }
      return { state: 'good', fired, repaired, errors };
    }, { waitMs: 4000 });
  } catch (e) {
    if (e instanceof LockTimeoutError) return { state: 'locked', fired: [], repaired: 0, errors: [firstLine(e)] };
    throw e;
  }
}

const randomId = () => A.newId();
