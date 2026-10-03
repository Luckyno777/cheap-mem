// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * appointment-time — points in time for appointments: wall clock in, UTC stored.
 *
 * Ported from lucky-mem (src/termine-zeit.mjs), in English, and with the zone
 * as a PARAMETER instead of a constant: the zone comes from `.mem/config.json`
 * (`timezone`), else `CHEAP_MEM_TZ`, else the system's own zone.
 *
 * **Why a second time module next to `timeexpr.mjs`.** `mem when` asks about
 * the PAST ("friday" is the last friday; an expression is a WINDOW). An
 * appointment is a POINT in the FUTURE: "friday 3pm" is the next one, and
 * "tomorrow" without a time never becomes a guessed midnight. What carries
 * over is the care about zones: UTC is stored, the wall clock is spoken, and
 * everything is computed through Intl (which knows daylight saving time),
 * never through a fixed offset.
 *
 * **Two edge cases of a clock change, decided here and pinned by
 * test/appointment-time.test.mjs:**
 *   - An ambiguous wall time (autumn, 02:30 exists twice): the EARLIER one.
 *     An appointment may come an hour early rather than not at all.
 *   - A wall time that does not exist (spring, 02:30 is skipped): the hour
 *     after, pushed forward and never skipped.
 *   - Repeats are computed in WALL time ("daily 09:00" stays 09:00 across the
 *     change), never as +24 hours.
 *
 * **Never guess.** What is not recognised with certainty is not a time:
 * `parse` returns `null` and the caller says what it understands.
 */

export const REPEATS = Object.freeze(['daily', 'weekly', 'monthly', 'weekdays']);

const DAY_MS = 86400000;
const WEEKDAYS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };

const pad = (n) => String(n).padStart(2, '0');

/** The system's own zone (what the machine thinks), else UTC. */
export function systemZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** True when Intl knows the zone. */
export function isZone(name) {
  if (typeof name !== 'string' || !name) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); return true; } catch { return false; }
}

/**
 * Which zone applies: `.mem/config.json` `timezone` (passed in as `configured`),
 * else the environment `CHEAP_MEM_TZ`, else the system zone. An unknown name is
 * REFUSED (throws) rather than silently replaced by another zone.
 */
export function resolveZone(configured = null, env = process.env) {
  const pick = configured || env.CHEAP_MEM_TZ || null;
  if (pick === null) return systemZone();
  if (!isZone(String(pick))) throw new Error(`Time zone '${pick}' is not a zone Intl knows (e.g. Europe/Berlin, America/New_York, UTC)`);
  return String(pick);
}

const CLOCKS = new Map();

/** The clock of one zone, built once. */
export function clockFor(zone) {
  if (CLOCKS.has(zone)) return CLOCKS.get(zone);
  const c = buildClock(zone);
  CLOCKS.set(zone, c);
  return c;
}

function buildClock(zone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' });
  const memo = new Map();

  function fields(ms) {
    // Remembered (at most 20000 points): a calendar window computes the same anchors thousands of times.
    const known = memo.get(ms);
    if (known) return known;
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const f = { year: +p.year, month: +p.month, day: +p.day, hour: p.hour === '24' ? 0 : +p.hour, minute: +p.minute, weekday: WEEKDAY_INDEX[p.weekday] };
    if (memo.size > 20000) memo.clear();
    memo.set(ms, f);
    return f;
  }

  /** Offset of the zone from UTC at `ms`, in ms (wall as if UTC, minus the instant, at minute resolution). */
  function offsetAt(ms) {
    const f = fields(ms);
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - (ms - (ms % 60000 + 60000) % 60000);
  }

  /**
   * Wall clock in this zone -> UTC milliseconds. Overflowing days/months roll
   * (31st + 1 day = 1st of the next month); a clock change follows the rules in the header.
   */
  function wallToUtc(year, month, day, hour = 0, minute = 0) {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const target = new Date(guess);
    const fits = (utc) => {
      const f = fields(utc);
      return f.year === target.getUTCFullYear() && f.month === target.getUTCMonth() + 1
        && f.day === target.getUTCDate() && f.hour === target.getUTCHours() && f.minute === target.getUTCMinutes();
    };
    const before = offsetAt(guess - DAY_MS);
    const after = offsetAt(guess + DAY_MS);
    const offsets = [...new Set([before, after])];
    const valid = offsets.map((o) => guess - o).filter(fits).sort((a, b) => a - b);
    if (valid.length) return valid[0]; // ambiguity: the earlier instant
    // A gap: use the offset in force BEFORE the change, which lands on the hour after.
    return guess - before;
  }

  const zoneLabel = (ms) => {
    try { return zoneName.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName')?.value ?? ''; } catch { return ''; }
  };

  /** "Fri 2026-10-09 14:30 CEST" — display, always in the configured zone. */
  function text(ms) {
    const f = fields(ms);
    const z = zoneLabel(ms);
    return `${SHORT[f.weekday]} ${f.year}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}${z ? ` ${z}` : ''}`;
  }

  /** The calendar day of an instant, "YYYY-MM-DD" (day boundaries, e.g. the cap). */
  function day(ms) {
    const f = fields(ms);
    return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
  }

  /** "HH:MM" of an instant. */
  function hhmm(ms) {
    const f = fields(ms);
    return `${pad(f.hour)}:${pad(f.minute)}`;
  }

  /** Start (00:00) of the day containing `ms`, plus `plusDays` wall-clock days. */
  function dayStart(ms, plusDays = 0) {
    const f = fields(ms);
    return wallToUtc(f.year, f.month, f.day + plusDays, 0, 0);
  }

  return { zone, fields, wallToUtc, text, day, hhmm, dayStart, zoneLabel };
}

function realDay(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function norm(text) {
  return String(text ?? '').toLowerCase().replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Time of day from one chunk ("14:30", "2pm", "2:30 pm", "9", "noon"), or null. Returns `{ hour, minute, rest }`. */
function takeTime(s) {
  let m;
  if ((m = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/.exec(s))) {
    let h = +m[1]; const mi = +m[2];
    if (m[3]) { if (h < 1 || h > 12) return { bad: true }; h = h % 12 + (m[3] === 'pm' ? 12 : 0); }
    return { hour: h, minute: mi, rest: s.replace(m[0], ' ') };
  }
  if ((m = /\b(\d{1,2})\s*(am|pm)\b/.exec(s))) {
    const h12 = +m[1];
    if (h12 < 1 || h12 > 12) return { bad: true };
    return { hour: h12 % 12 + (m[2] === 'pm' ? 12 : 0), minute: 0, rest: s.replace(m[0], ' ') };
  }
  if ((m = /\bnoon\b/.exec(s))) return { hour: 12, minute: 0, rest: s.replace(m[0], ' ') };
  if ((m = /\bat (\d{1,2})\b/.exec(s))) return { hour: +m[1], minute: 0, rest: s.replace(m[0], ' ') };
  return null;
}

/**
 * Turn a time expression into a FUTURE point.
 *
 * Recognised (case does not matter):
 *   2026-10-05 14:30 | 2026-10-05T14:30 | 2026-10-05 at 2pm
 *   2026-10-05T14:30:00Z        (with a zone designator: exactly that instant)
 *   Oct 5 9am | 5 oct 2026 14:30 | 5 october   (without a year: the next time)
 *   today | tomorrow | day after tomorrow  [at] 14:30 | 2pm
 *   friday 3pm | next friday 9:00   (the next such day; today if the time is still ahead)
 *   14:30 | at 9 | 9am              (today, else tomorrow)
 *   in 45 minutes | in 2 hours | in 3 days | in 1 week
 *   daily 9:00 | weekdays 7:00 | every weekday 7:00 | weekly friday 15:00 | monthly 2026-11-01 9:00
 *      (a leading repeat word also sets the repetition: `repeat` in the answer)
 * Without a time of day 09:00 applies — `defaultTime` says so, so the caller can show it.
 *
 * Returns `{ ms, defaultTime, repeat }` or `null` when something is left over that was not understood.
 */
export function parse(input, { now = Date.now(), zone = systemZone() } = {}) {
  const r = parseRaw(input, { now, zone });
  // An anchor on a weekend of a weekdays repeat starts on the Monday: say so in the point itself.
  if (r && r.repeat === 'weekdays') return { ...r, ms: occurrence(r.ms, 'weekdays', 0, zone) };
  return r;
}

function parseRaw(input, { now, zone }) {
  const clock = clockFor(zone);
  let s = norm(input);
  if (!s) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  // With an explicit zone designator: exactly this instant.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = Date.parse(String(input).trim());
    return Number.isFinite(ms) ? { ms, defaultTime: false, repeat: null } : null;
  }

  // A leading repeat word.
  let repeat = null;
  let m;
  if ((m = /^(?:every )?(daily|day|weekdays|weekday|weekly|week|monthly|month)\b/.exec(s))) {
    const w = m[1];
    repeat = /^(daily|day)$/.test(w) ? 'daily' : /^weekday/.test(w) ? 'weekdays' : /^(weekly|week)$/.test(w) ? 'weekly' : 'monthly';
    s = s.slice(m[0].length).trim();
    if (!s) return null;
  }

  // Relative.
  const rel = /^in (\d{1,4}) (minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d|weeks|week|w)$/.exec(s);
  if (rel) {
    const n = +rel[1];
    const unit = rel[2];
    if (n < 1) return null;
    if (/^(minutes|minute|mins|min|m)$/.test(unit)) return { ms: nowMs + n * 60000, defaultTime: false, repeat };
    if (/^(hours|hour|hrs|hr|h)$/.test(unit)) return { ms: nowMs + n * 3600000, defaultTime: false, repeat };
    const f = clock.fields(nowMs);
    const days = /^w/.test(unit) ? n * 7 : n;
    return { ms: clock.wallToUtc(f.year, f.month, f.day + days, f.hour, f.minute), defaultTime: false, repeat };
  }

  // Date.
  let date = null; // { year, month, day, noYear }
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) {
    if (!realDay(+m[1], +m[2], +m[3])) return null;
    date = { year: +m[1], month: +m[2], day: +m[3], noYear: false };
    s = s.replace(m[0], ' ');
  } else if ((m = /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?\b/.exec(s))
    || (m = /\b(\d{1,2})(?:st|nd|rd|th)? (jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?(?: (\d{4}))?\b/.exec(s))) {
    const first = /^\d/.test(m[1]);
    const month = MONTHS[first ? m[2] : m[1]];
    const dayN = +(first ? m[1] : m[2]);
    const year = m[3] ? +m[3] : null;
    if (year !== null && !realDay(year, month, dayN)) return null;
    date = { year, month, day: dayN, noYear: year === null };
    s = s.replace(m[0], ' ');
  }
  // The ISO "T" between date and time is a loose "t" after taking the date out.
  s = s.replace(/^t(?=\d)/, ' ').replace(/\bt(?=\d{2}:\d{2})/, ' ');

  // Word days.
  let offset = null; // days from today
  let weekday = null;
  if (!date) {
    if (/\bday after tomorrow\b/.test(s)) { offset = 2; s = s.replace(/\bday after tomorrow\b/, ' '); }
    else if (/\btomorrow\b/.test(s)) { offset = 1; s = s.replace(/\btomorrow\b/, ' '); }
    else if (/\b(today|tonight)\b/.test(s)) { offset = 0; s = s.replace(/\b(today|tonight)\b/, ' '); }
    else {
      for (const [name, wd] of Object.entries(WEEKDAYS)) {
        const re = new RegExp(`\\b${name}\\b`);
        if (re.test(s)) { weekday = wd; s = s.replace(re, ' '); break; }
      }
    }
  }

  // Time of day.
  const t = takeTime(s);
  if (t?.bad) return null;
  let hour = null; let minute = 0;
  if (t) { hour = t.hour; minute = t.minute; s = t.rest; }
  if (hour !== null && (hour > 23 || minute > 59)) return null;

  // Filler words; what is left was not understood.
  s = s.replace(/\b(on|at|the|of|next|coming|this|every|o'clock|oclock)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (s) return null;

  const hasDay = date !== null || offset !== null || weekday !== null;
  if (!hasDay && hour === null) return null;
  const defaultTime = hour === null;
  const h = hour ?? 9; const mi = hour === null ? 0 : minute;
  const f = clock.fields(nowMs);

  if (date) {
    let year = date.year;
    if (date.noYear) {
      year = f.year;
      if (!realDay(year, date.month, date.day)) return null;
      if (clock.wallToUtc(year, date.month, date.day, h, mi) <= nowMs) year += 1;
      if (!realDay(year, date.month, date.day)) return null;
    }
    return { ms: clock.wallToUtc(year, date.month, date.day, h, mi), defaultTime, repeat };
  }
  if (offset !== null) return { ms: clock.wallToUtc(f.year, f.month, f.day + offset, h, mi), defaultTime, repeat };
  if (weekday !== null) {
    let plus = (weekday - f.weekday + 7) % 7;
    const today = clock.wallToUtc(f.year, f.month, f.day + plus, h, mi);
    // Today counts only if the stated time is still ahead; with no time, "friday" on a friday is the next one.
    if (plus === 0 && (defaultTime || today <= nowMs)) plus = 7;
    return { ms: clock.wallToUtc(f.year, f.month, f.day + plus, h, mi), defaultTime, repeat };
  }
  // Only a time of day: today, else tomorrow.
  const today = clock.wallToUtc(f.year, f.month, f.day, h, mi);
  return { ms: today > nowMs ? today : clock.wallToUtc(f.year, f.month, f.day + 1, h, mi), defaultTime, repeat };
}

/** "15m", "2h", "1d", "90" (minutes) -> minutes; else `null`. One minute to 30 days. */
export function durationMinutes(text) {
  const m = /^(\d{1,6})\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)?$/.exec(norm(text));
  if (!m) return null;
  const n = +m[1];
  const unit = m[2] ?? 'm';
  const times = /^(h|hr|hrs|hours)$/.test(unit) ? 60 : /^(d|day|days)$/.test(unit) ? 1440 : 1;
  const min = n * times;
  return min >= 1 && min <= 43200 ? min : null;
}

// --- Repeats ------------------------------------------------------------------

function daysInMonth(year, month0) { return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate(); }

/**
 * The k-th occurrence (k = 0 is the anchor itself) as UTC milliseconds, computed in wall time.
 *
 *   daily / weekly   day + k, or 7k
 *   monthly          the same day of the month; where it does not exist (the 31st), the
 *                    last day of the month — the anchor stays the starting day (Jan 31 -> Feb 28 -> Mar 31)
 *   weekdays         Monday to Friday; an anchor on a weekend starts on the Monday
 *   no repeat        only k = 0
 */
export function occurrence(atMs, repeat, k, zone = systemZone()) {
  if (k === 0 && !repeat) return atMs;
  if (!repeat) return null;
  const clock = clockFor(zone);
  const f = clock.fields(atMs);
  if (repeat === 'daily') return clock.wallToUtc(f.year, f.month, f.day + k, f.hour, f.minute);
  if (repeat === 'weekly') return clock.wallToUtc(f.year, f.month, f.day + 7 * k, f.hour, f.minute);
  if (repeat === 'monthly') {
    const m0 = f.month - 1 + k;
    const year = f.year + Math.floor(m0 / 12);
    const month0 = ((m0 % 12) + 12) % 12;
    return clock.wallToUtc(year, month0 + 1, Math.min(f.day, daysInMonth(year, month0)), f.hour, f.minute);
  }
  if (repeat === 'weekdays') {
    // Monday = 0 ... Friday = 4; Saturday and Sunday slide to the Monday.
    const until = f.weekday === 6 ? 2 : f.weekday === 0 ? 1 : 0;
    const wd0 = f.weekday === 6 || f.weekday === 0 ? 0 : f.weekday - 1;
    const n = wd0 + k;
    const shift = until + Math.floor(n / 5) * 7 + (n % 5) - wd0;
    return clock.wallToUtc(f.year, f.month, f.day + shift, f.hour, f.minute);
  }
  return null;
}

/** The latest occurrence not after `nowMs`: `{ k, ms }` or `null`. */
export function lastUntil(atMs, repeat, nowMs, zone = systemZone()) {
  if (nowMs < atMs) return null;
  if (!repeat) return { k: 0, ms: atMs };
  const dd = Math.floor((nowMs - atMs) / DAY_MS);
  let k = repeat === 'daily' ? dd
    : repeat === 'weekly' ? Math.floor(dd / 7)
      : repeat === 'monthly' ? Math.floor(dd / 31)
        : Math.floor((dd * 5) / 7);
  k = Math.max(0, k - 2);
  for (let i = 0; i < 100000; i += 1) {
    const next = occurrence(atMs, repeat, k + 1, zone);
    if (next !== null && next <= nowMs) k += 1; else break;
  }
  while (k > 0 && occurrence(atMs, repeat, k, zone) > nowMs) k -= 1;
  const ms = occurrence(atMs, repeat, k, zone);
  return ms <= nowMs ? { k, ms } : null;
}

/** The first occurrence AFTER `nowMs`: `{ k, ms }` or `null` (a one-off in the past has none). */
export function nextAfter(atMs, repeat, nowMs, zone = systemZone()) {
  const last = lastUntil(atMs, repeat, nowMs, zone);
  if (!last) return { k: 0, ms: atMs };
  if (!repeat) return null;
  return { k: last.k + 1, ms: occurrence(atMs, repeat, last.k + 1, zone) };
}

/** All occurrences with `fromMs <= ms < toMs`, at most `max`. */
export function inWindow(atMs, repeat, fromMs, toMs, { max = 400, zone = systemZone() } = {}) {
  const out = [];
  const first = nextAfter(atMs, repeat, fromMs - 1, zone);
  if (!first) return out;
  for (let k = first.k; out.length < max; k += 1) {
    const ms = occurrence(atMs, repeat, k, zone);
    if (ms === null || ms >= toMs) break;
    if (ms >= fromMs) out.push({ k, ms });
    if (!repeat) break;
  }
  return out;
}
