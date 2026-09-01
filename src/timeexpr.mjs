// src/timeexpr.mjs — natural language → time window.
//
// So retrieval triggers on language, not on a typed command: if a query names
// a time ("yesterday afternoon", "last friday between 3 and 8pm", "last 12
// hours"), this returns the window as UTC bounds — otherwise `null`, and the
// caller falls back to keyword search. NEVER guess: what is not clearly a time
// is not a time.
//
// No model, no dependency. The one subtlety is the zone: stamps are UTC, people
// speak wall-clock. The zone is configurable (a local-first tool has no single
// home); it defaults to the system zone. Offsets come from Intl (DST-correct),
// not a fixed hour.

function systemZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

// Offset (minutes, zone vs UTC) at instant `utcMs`. Positive = east of UTC.
function zoneOffsetMin(utcMs, zone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  let hh = p.hour; if (hh === '24') hh = '00';
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hh, +p.minute, +p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

// Wall-clock (y/mo/d/hh/mm) in `zone` → UTC Date. Two passes: the offset itself
// depends on the instant (DST boundary).
export function zonedToUtc(y, mo, d, hh = 0, mi = 0, zone = systemZone()) {
  const naive = Date.UTC(y, mo - 1, d, hh, mi);
  const off = zoneOffsetMin(naive, zone);
  let utc = naive - off * 60000;
  const off2 = zoneOffsetMin(utc, zone);
  if (off2 !== off) utc = naive - off2 * 60000;
  return new Date(utc);
}

function zonedParts(utcMs, zone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  let hh = p.hour; if (hh === '24') hh = '0';
  return { year: +p.year, month: +p.month, day: +p.day, wday: wd, hour: +hh };
}

function dayStartPlus(utcMs, plusDays, zone) {
  const t = zonedParts(utcMs, zone);
  const noon = zonedToUtc(t.year, t.month, t.day, 12, 0, zone).getTime();
  const target = zonedParts(noon + plusDays * 86400000, zone);
  return zonedToUtc(target.year, target.month, target.day, 0, 0, zone);
}

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const SECTIONS = {
  morning: [6, 12], forenoon: [6, 12],
  noon: [11, 14], midday: [11, 14],
  afternoon: [12, 18],
  evening: [18, 24],
  night: [0, 6], overnight: [0, 6],
};

function hour24(h, ap) {
  if (!ap) return h;
  if (ap === 'pm') return h === 12 ? 12 : h + 12;
  return h === 12 ? 0 : h; // am
}

const win = (from, to, label) => ({ from, to, label });

/**
 * Detect a time window in `text`. Returns `{from, to, label}` (UTC Dates) or
 * `null`. `now` is the reference instant (default: real now); `zone` an IANA
 * zone (default: system).
 */
export function windowFor(text, { now = new Date(), zone = systemZone() } = {}) {
  if (!text || typeof text !== 'string') return null;
  const s = text.toLowerCase();
  const nowMs = now.getTime();

  // 1) Relative span: "last 12 hours", "past 3 days", "last 2 weeks".
  const rel = s.match(/\b(?:last|past|previous)\s+(\d{1,3})\s*(hours?|days?|weeks?)\b/);
  if (rel) {
    const n = +rel[1];
    const unit = rel[2];
    const ms = unit.startsWith('hour') ? n * 3600000
      : unit.startsWith('day') ? n * 86400000
        : n * 7 * 86400000;
    if (n > 0) return win(new Date(nowMs - ms), now, `last ${n} ${unit}`);
  }
  const rel1 = s.match(/\b(?:last|past)\s+(hour|day|week)\b/);
  if (rel1 && !rel) {
    const unit = rel1[1];
    const ms = unit === 'hour' ? 3600000 : unit === 'day' ? 86400000 : 7 * 86400000;
    return win(new Date(nowMs - ms), now, `last ${unit}`);
  }

  // 2) Day anchor.
  let dayStart = null;
  let dayLabel = null;
  const isoD = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoD) {
    dayStart = zonedToUtc(+isoD[1], +isoD[2], +isoD[3], 0, 0, zone);
    dayLabel = `${isoD[1]}-${isoD[2]}-${isoD[3]}`;
  } else if (/\bday before yesterday\b/.test(s)) {
    dayStart = dayStartPlus(nowMs, -2, zone); dayLabel = 'day before yesterday';
  } else if (/\byesterday\b/.test(s)) {
    dayStart = dayStartPlus(nowMs, -1, zone); dayLabel = 'yesterday';
  } else if (/\btoday\b/.test(s)) {
    dayStart = dayStartPlus(nowMs, 0, zone); dayLabel = 'today';
  } else {
    for (const [name, wd] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${name}\\b`).test(s)) {
        const todayWd = zonedParts(nowMs, zone).wday;
        let back = (todayWd - wd + 7) % 7;
        if (back === 0) back = 7; // "friday" on a Friday = last Friday
        dayStart = dayStartPlus(nowMs, -back, zone);
        dayLabel = name;
        break;
      }
    }
  }

  // 3) Hour window: "between 3 and 8 pm", "3-8pm", "from 15:00 to 20:00", or a
  //    section word.
  let hFrom = null; let hTo = null; let hLabel = null;
  // Blank out an ISO date first: otherwise the hour-span regex greedily eats
  // the date's own "08-29" as if it were a range. (German needs no such guard
  // because its span requires a trailing "uhr".)
  const sHours = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  const span = sHours.match(/\b(?:between\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|and|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
    || sHours.match(/\bfrom\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*to\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (span) {
    const ap1 = span[3] || span[6] || null; // a trailing am/pm applies to both
    const ap2 = span[6] || span[3] || null;
    const a = hour24(+span[1], ap1);
    const b = hour24(+span[4], ap2);
    // "between 15 and 20" without am/pm and clearly 24h numbers: keep as-is.
    if (a !== b || (span[2] || span[5])) {
      hFrom = [a, +(span[2] || 0)];
      hTo = [b, +(span[5] || 0)];
      hLabel = `${span[1]}${ap1 || ''}-${span[4]}${ap2 || ''}`;
    }
  } else {
    for (const [word, [a, b]] of Object.entries(SECTIONS)) {
      if (new RegExp(`\\b${word}\\b`).test(s)) { hFrom = [a, 0]; hTo = [b, 0]; hLabel = word; break; }
    }
  }

  // 4) Combine.
  if (dayStart) {
    const t = zonedParts(dayStart.getTime(), zone);
    if (hFrom && hTo) {
      const from = zonedToUtc(t.year, t.month, t.day, hFrom[0], hFrom[1], zone);
      const to = hTo[0] >= 24
        ? dayStartPlus(dayStart.getTime(), 1, zone)
        : zonedToUtc(t.year, t.month, t.day, hTo[0], hTo[1], zone);
      return win(from, to, `${dayLabel} ${hLabel}`);
    }
    return win(dayStart, dayStartPlus(dayStart.getTime(), 1, zone), dayLabel);
  }

  // 5) Hour window with no day → today.
  if (hFrom && hTo) {
    const t = zonedParts(nowMs, zone);
    const from = zonedToUtc(t.year, t.month, t.day, hFrom[0], hFrom[1], zone);
    const to = hTo[0] >= 24
      ? dayStartPlus(nowMs, 1, zone)
      : zonedToUtc(t.year, t.month, t.day, hTo[0], hTo[1], zone);
    return win(from, to, `today ${hLabel}`);
  }

  return null;
}

export const _internal = { zonedParts, dayStartPlus, systemZone };
