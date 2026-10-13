// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * deadlines.mjs — the day brief's view of the due dates: the part "Deadlines" of `mem today`, the day line's numbers and the
 * Monday week review. Build plan Q7 (step 6b, branch B, `today-due-cm`).
 *
 * **This module asks, the core answers.** Whether a duty is fresh, due or overdue, and which field carries its due date, is
 * decided in ONE place, `src/due.mjs` (invariant `frist-eine-stelle`). Nothing here reads a duty's due field or computes a
 * state: it hands the open duties to `dueCore.situationFromOpen`, splits the answer by addressee and shapes it for the
 * surfaces. The week review needs the DAY of a due date, and takes it from `dueCore.parseDue`.
 *
 * **Pure.** Nothing here reads a file, writes a line or asks the clock: the open duties (`memory.openDuties()`, read ONCE by the
 * caller and handed to everything that needs them), `now`, the house `zone` and the name of the human come in. That is what
 * makes "one duty run per `today()`" provable (test/today-due.test.mjs counts the passes over the duty drawer).
 *
 * **The human comes from the configuration.** No participant name stands in `src/` (design commitment 3). The duties of the
 * human are listed one by one (at most {@link SHOWN_MAX}, the rest counted); everything else (agents, nobody) is only a number:
 * an agent can write a hundred duties, and a card that shows them all is a card an agent can fill (owner decision, Q7).
 *
 * **Titles.** A title is entry text: first MASKED (`outputguard.maskText`, so a key over the cut cannot leave a stump), then
 * cut, then bidi-visible (`bidi.visible`, so a right-to-left override cannot reorder the line). An encrypted duty shows
 * `[locked]` instead of a title; its due date stays readable (owner decision 2026-10-12).
 *
 * **Three states.** What cannot be read is `readable: false` with a reason, never a quiet 0.
 */

// invariant: frist-eine-stelle
// invariant: nicht-messbar-ist-nicht-null

import * as dueCore from './due.mjs';
import * as addressee from './addressee.mjs';
import * as bidi from './bidi.mjs';
import { maskText } from './outputguard.mjs';
import { clockFor, systemZone } from './appointment-time.mjs';

/** At most this many duties of the human are listed one by one; the rest is counted. */
export const SHOWN_MAX = 8;

/** A title is shown up to this many characters (after the mask). */
export const TITLE_MAX = 100;

/** What an encrypted duty shows instead of its title (the same mark the decision card uses). */
export const LOCKED = '[locked]';

/**
 * Entry text for the day brief: masked, THEN cut, then bidi-visible. One line. The cut never leaves a torn `[REDACTED:` marker
 * or half a surrogate pair behind.
 */
export function safeText(text, max = TITLE_MAX) {
  const masked = maskText(String(text ?? '')).replace(/\s+/g, ' ').trim();
  let cut = masked;
  if (masked.length > max) {
    let end = Math.max(0, max - 1);
    // A cut that falls inside a [REDACTED:...] marker moves to the marker's start: no half marker, no stump.
    for (const m of masked.matchAll(/\[REDACTED(?::[^\]]*)?\]/g)) {
      if (end > m.index && end < m.index + m[0].length) end = m.index;
    }
    cut = masked.slice(0, end).replace(/[\uD800-\uDBFF]$/, '');
    cut = `${cut.trimEnd()}…`;
  }
  return bidi.visible(cut);
}

/** The title a duty shows. An encrypted duty has none to show. */
function titleOf(duty) {
  if (duty?.body_enc) return LOCKED;
  return safeText(duty?.title ?? duty?.text ?? duty?.id ?? '');
}

const empty = () => ({ withDue: 0, overdue: 0, dueToday: 0, fresh: 0, unknown: 0 });

/**
 * The part "Deadlines" of the day, from the OPEN duties.
 *
 *   `mine`    the duties addressed to the human that carry a due value: counts per state, the first {@link SHOWN_MAX} (the
 *             core's order: earliest due first, so the overdue ones come first, unreadable ones last) as `list`, and `more`
 *             for the rest
 *   `others`  everything not addressed to the human (agents, unaddressed): counts only
 *
 * `fold` is the result of `memory.openDuties()` (`{ open }`) or `{ error }` when reading it failed. `human` is the name from the
 * configuration, or null with `humanReason`.
 */
export function part(fold, { human = null, humanReason = null, now = Date.now(), zone = systemZone(), max = SHOWN_MAX } = {}) {
  if (!fold || fold.error || !Array.isArray(fold.open)) {
    return { readable: false, reason: `duties not readable: ${fold?.error?.message ?? fold?.error ?? 'no duties handed in'}`, list: [] };
  }
  if (!human) {
    return { readable: false, reason: humanReason ?? 'no human participant is configured', list: [] };
  }
  const t = now instanceof Date ? now.getTime() : Number(now);
  // The core reads and judges every due value once; the titles are made for the shown rows only (a store of 100,000 duties
  // does not mask 100,000 titles).
  const s = dueCore.situationFromOpen(fold.open, { now: t, zone, title: () => '' });
  const mine = empty();
  const others = empty();
  const rows = [];
  for (const r of s.list) {
    const into = r.who === human ? mine : others;
    into.withDue += 1;
    into[r.state === dueCore.STATE.DUE ? 'dueToday' : r.state] += 1;
    if (r.who === human) rows.push(r);
  }
  const shown = rows.slice(0, Math.max(0, max));
  const byId = new Map();
  const want = new Set(shown.map((r) => r.id));
  for (const d of fold.open) if (d && want.has(d.id) && !byId.has(d.id)) byId.set(d.id, d);
  const list = shown.map(({ id, due: value, day, state, since }) => ({
    id, title: titleOf(byId.get(id)), due: value === null ? null : safeText(value, 40), day, state, since: since ?? null,
  }));
  return {
    readable: true, reason: null, zone, asOf: new Date(t).toISOString(), human,
    open: s.open, withoutDue: s.withoutDue,
    mine: { ...mine, list, more: Math.max(0, rows.length - shown.length) },
    others,
  };
}

/** The numbers the day line takes from a {@link part}: `null` when the part could not be read (never 0). */
export function lineCounts(p) {
  if (!p?.readable) return { overdue: null, dueToday: null };
  return { overdue: p.mine.overdue, dueToday: p.mine.dueToday };
}

// --------------------------------------------------------------------------------------------------
// The week review (Monday briefing)
// --------------------------------------------------------------------------------------------------

/** Days of a week from Monday: the weekday number (0 = Sunday) of `ms` in `zone`, as 1..7 with Monday = 1. */
export function isoWeekday(ms, zone = systemZone()) {
  const w = clockFor(zone).fields(ms).weekday;
  return w === 0 ? 7 : w;
}

/** The week boundaries as DAYS in the house zone (`YYYY-MM-DD`): this Monday, the Monday before, the Monday after. Never UTC. */
export function weekDays(now, zone = systemZone()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const clock = clockFor(zone);
  const back = isoWeekday(t, zone) - 1;
  return {
    lastFrom: clock.day(clock.dayStart(t, -back - 7)),
    from: clock.day(clock.dayStart(t, -back)),
    to: clock.day(clock.dayStart(t, 7 - back)),
  };
}

/**
 * The Monday week review of the human's duties: the due dates of last week (how many, done, dropped, still open), what is
 * overdue now, what falls due this week. A week is Monday 00:00 to the next Monday 00:00 in the HOUSE zone.
 *
 * `show` is the rule of the owner (Q7, decision 3): the block is shown only if something fell due last week or falls due this
 * week. A quiet week gets no block, and the block alone may carry an otherwise empty briefing.
 *
 * `fold` is `memory.openDuties()` (`{ open, done }`). A closed duty counts by the due date it carried when it was closed.
 */
export function week(fold, { human = null, humanReason = null, now = Date.now(), zone = systemZone(), projectsWaiting = null } = {}) {
  if (!fold || fold.error || !Array.isArray(fold.open)) {
    return { readable: false, reason: `duties not readable: ${fold?.error?.message ?? fold?.error ?? 'no duties handed in'}`, show: false };
  }
  if (!human) return { readable: false, reason: humanReason ?? 'no human participant is configured', show: false };
  const t = now instanceof Date ? now.getTime() : Number(now);
  const days = weekDays(t, zone);
  const last = { total: 0, done: 0, dropped: 0, open: 0 };
  const thisWeek = { total: 0, open: 0 };
  let overdueNow = 0;
  const dayOf = (d) => {
    const p = dueCore.parseDue(dueCore.dueValue(d), { zone });
    return p.ok ? p : null;
  };
  for (const d of fold.open) {
    if (addressee.ofDuty(d) !== human) continue;
    const p = dayOf(d);
    if (!p) continue;
    if (t >= p.overdueFromMs) overdueNow += 1;
    if (p.day >= days.lastFrom && p.day < days.from) { last.total += 1; last.open += 1; }
    else if (p.day >= days.from && p.day < days.to) { thisWeek.total += 1; thisWeek.open += 1; }
  }
  for (const d of Array.isArray(fold.done) ? fold.done : []) {
    if (addressee.ofDuty(d) !== human) continue;
    const p = dayOf(d);
    if (!p) continue;
    const dropped = String(d?._closed?.state ?? '') === 'dropped';
    if (p.day >= days.lastFrom && p.day < days.from) { last.total += 1; if (dropped) last.dropped += 1; else last.done += 1; }
    else if (p.day >= days.from && p.day < days.to) thisWeek.total += 1;
  }
  return {
    readable: true, reason: null, zone, human, days,
    last, thisWeek, overdueNow, projectsWaiting,
    show: last.total + thisWeek.total > 0,
  };
}

/** The review as lines of the briefing (plain ASCII). `[]` for a review that is not shown. */
export function weekLines(w) {
  if (!w) return [];
  if (!w.readable) return [`Week review: not measurable (${safeText(w.reason, 160)})`];
  if (!w.show) return [];
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const lines = [`Week review (last week ${w.days.lastFrom} to ${w.days.from} exclusive, this week to ${w.days.to} exclusive):`];
  lines.push(`- Last week: ${n(w.last.total, 'deadline', 'deadlines')} fell due: ${w.last.done} done, ${w.last.dropped} dropped, ${w.last.open} still open`);
  lines.push(`- Overdue now: ${w.overdueNow}`);
  lines.push(`- Due this week: ${n(w.thisWeek.total, 'deadline', 'deadlines')}`);
  lines.push(`- Projects awaiting confirmation: ${w.projectsWaiting === null ? 'not measurable' : w.projectsWaiting}`);
  return lines;
}
