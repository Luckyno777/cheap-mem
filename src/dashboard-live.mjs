// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard-live.mjs — after a write of the person's OWN the server delivers the affected parts of
// `/dashboard.json` fresh at once (board-width-fresh-cm, 2026-10-12; the sibling's `src/dashboard-live.mjs`,
// bug 3fzbv8vxvosj).
//
// **The finding.** Saving a setting or acknowledging a message wrote correctly, and the page then showed the
// OLD value, also after a reload. `/dashboard.json` comes from the cache (src/dashboard-cache.mjs); its full
// rebuild takes seconds on a real store (and runs at most every max(20 s, 4 x build time)); `invalidate()` made the
// next build start at once, but the answer BEFORE it was the old state. Measured in a real Chromium on
// 0bf3ae5 (`test/dash-write-fresh-cm.test.mjs`): file says errorWindow 77, the page says 14, after the save and
// after the reload; an acknowledged message stays "open". Only the categories had a live path of their own
// (`categoriesLive`).
//
// **The choice: invalidate by part.** The cache knows which PARTS a write has made stale
// (`invalidate(parts)`, `get().live.parts`). This module computes exactly those parts fresh with the small read
// functions the full build calls anyway (no second version of the data) and the server lays them over the stored
// answer, also over the deferred lists (inbox, raw). Computed once per write (the server remembers the answer per
// state and parts), never on a read without a write: without stale parts this module does nothing, and the tempo
// promise of the cache stays.
//
// **Holds until** a build that STARTED after the write has finished (then the part is in the state itself).
//
// **A part that cannot be computed is named, never silently old.** `compute()` returns `errors` per part; the
// server puts them into the cache part of the answer (`live_errors`) and the page says so at the card ("could not be
// computed fresh (reason) - showing the state of HH:MM"). The part then stays the stored one.
//
// **The limit of a part: it refreshes its OWN sections only.** `settings` lays the settings list and the change log, not
// the board tiles that depend on a setting (error-window, quiet-hours: the error-class and agents tiles, the
// attention list); `raw` lays state and counters of the captures, not their reachability summary elsewhere on the
// board, nor the topics of a capture (those stay the stored ones). The tiles, `agents[].channel` and everything else
// derived from a setting or a message follow with the rebuild.
//
// **What is NOT here.** Writes whose effect sits in the whole entry stock (done, restore, merge: the entry list,
// open duties and questions, counters) cannot be recomputed in milliseconds - they stay with the rebuild;
// `REBUILD_ONLY` says so with a reason, and the probe holds that EVERY task kind and EVERY writing route is in
// exactly one list.
//
// invariant: three-states-never-two

import * as consolePage from './console.mjs';
import * as dashboard from './dashboard.mjs';
import * as dashboardData from './dashboard-data.mjs';
import * as today from './today.mjs';

let runs = 0;
/** How many times a part was computed in this process (probes only: a read without a write must not move it). */
export const runCount = () => runs;

/**
 * The parts: name -> `{ sections, build(root, work, ctx) }`. `sections` names the fields of `/dashboard.json` the
 * part replaces; `build` gets the state it is laid on (`work`, already with the earlier parts) and returns exactly
 * those fields.
 */
export const PARTS = Object.freeze({
  // Settings: the value read for each setting and the change log.
  settings: {
    sections: ['settings', 'log'],
    build: (root, _work, { env }) => ({
      settings: consolePage.settingsState(root, env),
      log: consolePage.readLog(root, { max: 5 }),
    }),
  },
  // Inbox: the message list, the human's tray list and the tray summary.
  inbox: {
    sections: ['inbox', 'humanInbox', 'humanTray'],
    build: (root, _work, { now }) => {
      const humanInbox = dashboard.humanInboxNow(root);
      return { inbox: dashboardData.inboxListNow(root, now), humanInbox, humanTray: dashboardData.trayOf(humanInbox, now) };
    },
  },
  // Gold verdict: the gold questions of the day (a rated example does not come back) and what is derived from them.
  gold: {
    sections: ['today'],
    build: (root, work, { env, now }) => ({ today: today.refresh(work.today, root, ['gold'], { env, now }) }),
  },
  // Confirm a project: the project shelf ("new" mark goes) and the waiting projects of the day.
  projects: {
    sections: ['projectShelf', 'today'],
    build: (root, work, { env, now }) => ({
      projectShelf: dashboardData.projectShelf(root),
      today: today.refresh(work.today, root, ['projects'], { env, now }),
    }),
  },
  // Delete a raw capture: state and counters of the captures.
  raw: {
    sections: ['raw'],
    build: (root, work) => ({ raw: dashboardData.rawLive(root, work.raw) }),
  },
});

/** Which writing route of the server makes which parts stale (the probe pins every path of `WRITE_PATHS`). */
export const ROUTE_PARTS = Object.freeze({
  '/setting': ['settings'],
  '/inbox/state': ['inbox'],
  '/inbox/reply': ['inbox'],
  '/dashboard/gold-verdict': ['gold'],
});

/** Writing routes without a part, with the reason (the probe: every path of `WRITE_PATHS` is here or in `ROUTE_PARTS`). */
export const ROUTE_NO_PART = Object.freeze({
  '/task': 'starts a child process; its END makes the parts stale (TASK_PARTS), see /task.json',
  '/task/cancel': 'ends a process, writes nothing the dashboard shows',
  '/dashboard/verify-verdict': 'appends outside this memory; the candidate list does not depend on verdicts',
});

/** Which task kinds make which parts stale when they end. */
export const TASK_PARTS = Object.freeze({
  'project-confirm': ['projects'],
  'raw-delete': ['raw'],
});

/**
 * Task kinds without a part, with the reason. The probe: every kind of `tasks.KINDS` is in `TASK_PARTS` or here,
 * so a new kind without a decision is noticed.
 */
export const REBUILD_ONLY = Object.freeze({
  export: 'writes a file outside the display, changes no part',
  integrity: 'reads only (hash chain check)',
  done: 'entry stock: list, open duties and questions, counters - only the rebuild computes that',
  restore: 'entry stock (see done)',
  merge: 'entry stock (see done)',
  'inbox-permit': 'one grant line; the dashboard shows no permission list',
  'question-confirm': 'entry stock (open/waiting questions, counters) - only the rebuild computes that (see done)',
  'category-assign': 'has its own live path (categoriesLive, cat-confirm-cm)',
  'category-confirm': 'like category-assign',
  'category-acknowledge': 'like category-assign',
  'category-rename': 'like category-assign',
  'category-merge': 'like category-assign',
  'category-create': 'like category-assign',
  'skill-status': 'the skill view reads fresh on every call (/dashboard/skills.json), not from the cache',
});

/** The parts a finished task of this kind made stale (empty when it has none). */
export function partsForTask(kind) {
  return TASK_PARTS[kind] ? [...TASK_PARTS[kind]] : [];
}

/**
 * Lay the stale parts fresh over `data`. Returns `{ data, errors }`: `data` is a shallow copy (the stored state stays
 * unchanged, it serves many answers); `errors` names the reason for every part that could not be computed - that
 * part then stays the stored one (never a made-up fresh one). An unknown part name is an error of that part, not a
 * throw.
 */
export function compute(root, data, parts, { env = process.env, now = new Date() } = {}) {
  let work = { ...data };
  const errors = {};
  for (const name of parts) {
    const part = Object.hasOwn(PARTS, name) ? PARTS[name] : null;
    if (!part) { errors[name] = `unknown part '${name}'`; continue; }
    runs += 1;
    try {
      const fresh = part.build(root, work, { env, now });
      for (const k of part.sections) {
        if (!Object.hasOwn(fresh, k)) throw new Error(`part ${name} did not deliver '${k}'`);
      }
      work = { ...work, ...fresh };
    } catch (e) {
      errors[name] = e?.message || String(e);
    }
  }
  return { data: work, errors };
}
