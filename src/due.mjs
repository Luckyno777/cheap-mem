// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * due.mjs — the due-date core: when is a duty fresh, due or overdue.
 *
 * Pure, no I/O: nothing here reads a file, writes a line or asks the clock (the time comes in as `now`, the zone as
 * `zone`). Build plan Q1, step 6b, branch A (the sibling house builds the same core as `src/faelligkeit.mjs`; the field
 * names and the states are paired in `shared/field-names-parity.jsonl`, and the same fixture gives the same state in both
 * houses: `shared/due-states.jsonl`).
 *
 * ## The finding that ordered this module
 *
 * A due date on a duty was read and never written, and every reader guessed other names: `today.mjs` read `due ?? by`,
 * `dashboard-data.mjs` the same pair, `appointment-today.mjs` `due / due_date / until / deadline`. In lucky-mem four readers
 * guessed five names, and the stored data carried none. That is the class `two-truths`: now the question stands in ONE
 * place, here. No other module reads the field name (shared/calculations.jsonl, entry `due-one-place`, checked by
 * bench/calculations.mjs).
 *
 * ## The field
 *
 * `due` on a duty (type `duty`, nowhere else). A due date and a follow-up date are ONE field: a follow-up is a duty
 * that names its subject and carries a `due`; the label is derived when it is shown. Shelf life (`valid_until`) stays its own field and
 * does not belong here.
 *
 * ## The value: exactly two forms
 *
 *   YYYY-MM-DD                     a day in the house zone (`.mem/config.json` timezone, else CHEAP_MEM_TZ, else the system
 *                                  zone); overdue from 00:00 of the following day
 *   YYYY-MM-DDThh:mm[:ss[.f]]Zone  a point in time WITH a zone (`Z` or +hh:mm); overdue from exactly that point
 *
 * A date-time WITHOUT a zone is refused: it would be another hour on every machine. When writing that is a loud error
 * (`checkWrite`); when reading, an unreadable SCALAR (text, number, boolean) is not a shape error but the state `unknown` — the
 * duty stays open. That does not hold for an object or a list of objects in the field: by the general field-shape rule
 * (src/fieldshape.mjs) that is a broken line, and a broken line opens and closes nothing.
 *
 * ## The states
 *
 *   fresh     the due date lies before the day it falls due
 *   due       the day of the due date is running (for a point in time: up to it)
 *   overdue   the due date has passed
 *   unknown   no readable value (missing, unreadable, no usable clock)
 *
 * The day boundary is MIDNIGHT IN THE HOUSE ZONE, never UTC; the two clock changes of a year (a day of 25 and one of 23
 * hours) come from the zone clock (`appointment-time.mjs`, `clockFor`) and are pinned in test/due-core.test.mjs.
 *
 * ## Aliases
 *
 * Older readers took `due_date`, `until`, `deadline` and (`today.mjs`) `by` for the same thing. The core keeps READING them
 * — a line that carries one is not lost — but `aliasUsed` names the one it found, so `mem doctor` can point at it. The
 * bridge writes only `due` (src/bridgefields.mjs).
 *
 * ## Age doping
 *
 * Moving a due date appends a correction (append-only, `replaces_id`), and its `ts` is new while the duty is not. So
 * "overdue" is computed from the due date, never from the age of a line, and "open since" comes from the START of the
 * chain (`openSince`), not from the `ts` of the newest stage.
 */

import { clockFor, systemZone } from './appointment-time.mjs';
import * as addressee from './addressee.mjs';

/** The states of a due date. A closed list: a fifth state is entered here and shows in the diff. */
export const STATE = Object.freeze({
  FRESH: 'fresh',
  DUE: 'due',
  OVERDUE: 'overdue',
  UNKNOWN: 'unknown',
});

/** Other names older readers took for the due date. Read, not written, and named by `aliasUsed`. */
const ALIASES = Object.freeze(['due_date', 'until', 'deadline', 'by']);

const DAY_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

const FORMS = 'YYYY-MM-DD (a day in the house zone) or an ISO point in time WITH a zone '
  + '(e.g. 2026-11-01T17:00:00+01:00 or ...Z)';

function realDay(y, m, d) {
  if (y < 2000 || y > 2999 || m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const toMs = (now) => (now instanceof Date ? now.getTime() : Number(now));

/**
 * Read a due value. Pure.
 *
 * Returns `{ ok: true, kind, value, day, dueFromMs, overdueFromMs }`:
 *   kind             'day' | 'instant'
 *   day              the calendar day of the due date in `zone` (YYYY-MM-DD)
 *   dueFromMs        from here the duty is "due" (midnight of that day in `zone`)
 *   overdueFromMs    from here it is "overdue"
 * or `{ ok: false, reason }`. Nothing is guessed: what has neither form is unreadable.
 */
export function parseDue(value, { zone = systemZone() } = {}) {
  if (typeof value !== 'string') return { ok: false, reason: 'is not text' };
  const clock = clockFor(zone);
  const day = DAY_FORM.exec(value);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    if (!realDay(y, m, d)) return { ok: false, reason: 'is not a calendar day' };
    return {
      ok: true, kind: 'day', value, day: value,
      dueFromMs: clock.wallToUtc(y, m, d, 0, 0),
      overdueFromMs: clock.wallToUtc(y, m, d + 1, 0, 0),
    };
  }
  const at = INSTANT_FORM.exec(value);
  if (at) {
    const [y, m, d, hh, mi] = [at[1], at[2], at[3], at[4], at[5]].map(Number);
    const ss = at[6] === undefined ? 0 : Number(at[6]);
    const offH = at[9] === undefined ? 0 : Number(at[9]);
    const offM = at[10] === undefined ? 0 : Number(at[10]);
    if (!realDay(y, m, d) || hh > 23 || mi > 59 || ss > 59 || offH > 23 || offM > 59) {
      return { ok: false, reason: 'is not a valid point in time' };
    }
    const fraction = at[7] === undefined ? '' : `.${at[7].slice(0, 3).padEnd(3, '0')}`;
    const ms = Date.parse(`${at[1]}-${at[2]}-${at[3]}T${at[4]}:${at[5]}:${String(ss).padStart(2, '0')}${fraction}${at[8]}`);
    if (!Number.isFinite(ms)) return { ok: false, reason: 'is not a valid point in time' };
    const f = clock.fields(ms);
    return {
      ok: true, kind: 'instant', value, day: clock.day(ms),
      dueFromMs: clock.wallToUtc(f.year, f.month, f.day, 0, 0),
      overdueFromMs: ms,
    };
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) && !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return { ok: false, reason: 'has no zone (a date-time without a zone would be another hour on every machine)' };
  }
  return { ok: false, reason: 'has neither of the two allowed forms' };
}

/** The state of a due value at `now` (ms or Date) in `zone`. `unknown` when the value or the clock is not readable. */
export function state(value, now = Date.now(), { zone = systemZone() } = {}) {
  return stateOfRead(parseDue(value, { zone }), toMs(now));
}

/** The state from a value that was already read (`parseDue`), so `situationFromOpen` reads each value once. */
function stateOfRead(p, t) {
  if (!p.ok || !Number.isFinite(t)) return STATE.UNKNOWN;
  if (t >= p.overdueFromMs) return STATE.OVERDUE;
  if (t >= p.dueFromMs) return STATE.DUE;
  return STATE.FRESH;
}

/**
 * The raw due value of a duty, or `null` when it carries none. THE one place that knows the field name — and its older
 * aliases. An unreadable value (number, object, nonsense) comes out unchanged: `state` turns it into `unknown`.
 */
export function dueValue(duty) {
  if (duty === null || typeof duty !== 'object') return null;
  for (const name of ['due', ...ALIASES]) {
    const v = duty[name];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/**
 * The due value of a duty for PASSING ON (day list, dashboard, display): text or `null`. An old value that is no text (a
 * number, a boolean) never travels raw — to a reader it is "no readable due date"; the state `unknown` is said by `state` and
 * `situationFromOpen`.
 */
export function dueText(duty) {
  const v = dueValue(duty);
  return typeof v === 'string' ? v : null;
}

/** The alias (`due_date`, `until`, `deadline`, `by`) a duty uses INSTEAD of `due`, or `null` (for `mem doctor`). */
export function aliasUsed(duty) {
  if (duty === null || typeof duty !== 'object') return null;
  const own = duty.due;
  if (own !== undefined && own !== null && own !== '') return null;
  return ALIASES.find((name) => duty[name] !== undefined && duty[name] !== null && duty[name] !== '') ?? null;
}

/** Open since when: the START of the chain (`_since`, set by `memory.openDuties` on a corrected duty), else its `ts`. */
export function openSince(duty) {
  return duty?._since ?? duty?.ts ?? null;
}

/**
 * The situation of a list of OPEN duties (`memory.openDuties().open`) — the replacement for the readers' guessing.
 * Pure: `now` and `zone` come from outside; `title` makes the display title (its rule lives in memory.mjs, which this
 * module must not import).
 *
 * Returns `{ open, withDue, withoutDue, fresh, dueNow, overdue, unknown, list }`. `unknown` counts only duties that CARRY a
 * value which cannot be read; a duty without one is `withoutDue`. `list` holds only the duties with a value, earliest due
 * first, unreadable ones last, ties by id; a row is `{ id, title, who, project, dueAt, day, state, since, overdueFromMs }`.
 *
 * ## Why the results do not say `due`
 *
 * `due` is the name of the RAW field on a duty. A result that answered to the same name (the count of the state `due`, the
 * text of a row) was read by `const { due } = s` exactly like the field, and the one-place latch (shared/calculations.jsonl,
 * `due-one-place`) could not tell the two apart, so it could not look for destructuring. The count is `dueNow` and the row's
 * text is `dueAt`; `rowForOutput` gives a row back its public name for the CLI and bridge JSON, which stay as they were.
 */
export function situationFromOpen(open, { now = Date.now(), zone = systemZone(), title = (d) => String(d?.title ?? d?.text ?? '') } = {}) {
  const t = toMs(now);
  const count = { fresh: 0, due: 0, overdue: 0, unknown: 0 }; // keyed by the STATE value; returned as `dueNow` below
  const list = [];
  let withoutDue = 0;
  for (const d of open ?? []) {
    const value = dueValue(d);
    if (value === null) { withoutDue += 1; continue; }
    const read = parseDue(value, { zone });
    const s = stateOfRead(read, t);
    count[s] += 1;
    list.push({
      id: d.id ?? null,
      title: title(d),
      who: addressee.ofDuty(d) || null,
      project: d._project ?? null,
      dueAt: typeof value === 'string' ? value : null,
      day: read.ok ? read.day : null,
      state: s,
      since: openSince(d),
      overdueFromMs: read.ok ? read.overdueFromMs : null,
    });
  }
  list.sort((a, b) => {
    const x = a.overdueFromMs ?? Infinity; const y = b.overdueFromMs ?? Infinity;
    return x !== y ? x - y : String(a.id).localeCompare(String(b.id));
  });
  return {
    open: (open ?? []).length, withDue: list.length, withoutDue,
    fresh: count.fresh, dueNow: count.due, overdue: count.overdue, unknown: count.unknown, list,
  };
}

/**
 * A row of `situationFromOpen` as the CLI (`mem deadlines --json`) and the bridge (`mem_deadlines`) print it: the public
 * name `due` back in the place `dueAt` had, and without the internal `overdueFromMs`. Pure.
 */
export function rowForOutput(row) {
  const out = {};
  for (const [key, v] of Object.entries(row ?? {})) {
    if (key === 'overdueFromMs') continue;
    out[key === 'dueAt' ? 'due' : key] = v;
  }
  return out;
}

/**
 * The check on the write path: the same for the CLI (`mem log`, `mem correction`) and the bridge (`mem_log`), because both
 * run through `memory.logCheckedEntry` / `memory.correctionEntry`. Throws with the field name and the reason BEFORE anything
 * is written. Without `due` in the data: nothing.
 */
export function checkWrite(type, data) {
  if (data && typeof data === 'object') {
    // The older names are READ, never written: one field, one name. `--due-date` arrives hyphenated.
    for (const key of Object.keys(data)) {
      const name = key.replace(/-/g, '_');
      if (ALIASES.includes(name)) {
        throw new Error(`Field '${name}' is not written any more: use 'due' (--due) for the due date - nothing was written. `
          + 'Older lines that carry it are still read.');
      }
    }
  }
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'due') || data.due === undefined) return;
  if (type !== 'duty') {
    throw new Error(`Field 'due' exists only on a duty (type duty), not on '${type}' - nothing was written. `
      + 'A due date is a promise with a debtor; appointments live under mem appointment, '
      + 'the shelf life of a fact is valid_until.');
  }
  const value = data.due;
  if (value === null || value === true || value === '') {
    throw new Error(`Field 'due' needs a value (${FORMS}) - nothing was written. `
      + 'To remove a due date later use a correction: mem correction duty <id> --without due.');
  }
  const p = parseDue(value);
  if (!p.ok) {
    throw new Error(`Field 'due' ${p.reason}. Allowed is exactly: ${FORMS} - nothing was written.`);
  }
}
