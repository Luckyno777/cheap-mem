// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// appointment-time: zones, clock changes, English expressions, repeats.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as tm from '../src/appointment-time.mjs';

const BER = 'Europe/Berlin';
const NOW = Date.parse('2026-10-03T10:00:00Z'); // Saturday 12:00 in Berlin
const at = (text, zone = BER, now = NOW) => {
  const r = tm.parse(text, { now, zone });
  return r && { ...r, text: tm.clockFor(zone).text(r.ms) };
};
const wall = (zone, ms) => { const f = tm.clockFor(zone).fields(ms); return `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')} ${String(f.hour).padStart(2, '0')}:${String(f.minute).padStart(2, '0')}`; };

test('expressions: the English forms resolve to the right wall time', () => {
  const cases = {
    'tomorrow 9:00': '2026-10-04 09:00', 'tomorrow': '2026-10-04 09:00', 'day after tomorrow 14:30': '2026-10-05 14:30',
    'friday 3pm': '2026-10-09 15:00', 'next friday 9:00': '2026-10-09 09:00', 'saturday 15:00': '2026-10-03 15:00',
    'saturday 9:00': '2026-10-10 09:00', 'oct 5 9am': '2026-10-05 09:00', '5 oct 2026 14:30': '2026-10-05 14:30',
    '2026-10-25 14:30': '2026-10-25 14:30', '2026-10-25T14:30': '2026-10-25 14:30', '14:30': '2026-10-03 14:30', '9am': '2026-10-04 09:00',
    'in 2 hours': '2026-10-03 14:00', 'in 45 minutes': '2026-10-03 12:45', 'in 3 days': '2026-10-06 12:00', 'in 1 week': '2026-10-10 12:00',
    '12am tomorrow': '2026-10-04 00:00', 'tomorrow 12pm': '2026-10-04 12:00', 'tomorrow noon': '2026-10-04 12:00', 'jan 5': '2027-01-05 09:00',
  };
  for (const [text, want] of Object.entries(cases)) {
    const r = at(text);
    assert.ok(r, `'${text}' was not recognised`);
    assert.equal(wall(BER, r.ms), want, text);
  }
});

test('expressions: a time zone designator is exact; garbage is null, never a guess', () => {
  assert.equal(tm.parse('2026-10-05T14:30:00Z', { now: NOW, zone: BER }).ms, Date.parse('2026-10-05T14:30:00Z'));
  assert.equal(tm.parse('2026-10-05T14:30:00+02:00', { now: NOW, zone: BER }).ms, Date.parse('2026-10-05T12:30:00Z'));
  for (const bad of ['', 'blah', 'tomorrow banana', '2026-02-30 10:00', '25:00', 'tomorrow 13pm', 'in 0 minutes', 'in two hours', 'weekdays']) {
    assert.equal(tm.parse(bad, { now: NOW, zone: BER }), null, `'${bad}' must not parse`);
  }
});

test('expressions: no time of day says so (default 09:00); a leading repeat word sets the repeat', () => {
  assert.equal(at('tomorrow').defaultTime, true);
  assert.equal(at('tomorrow 9:00').defaultTime, false);
  assert.equal(at('daily 9:00').repeat, 'daily');
  const w = at('weekdays 7:00');
  assert.equal(w.repeat, 'weekdays');
  assert.equal(wall(BER, w.ms), '2026-10-05 07:00', 'a Saturday anchor of a weekdays repeat starts on the Monday');
  assert.equal(at('every weekday 7:00').repeat, 'weekdays');
  assert.equal(at('weekly friday 15:00').repeat, 'weekly');
  assert.equal(at('monthly 2026-11-01 9:00').repeat, 'monthly');
});

test('the zone is a parameter: the same words mean different instants in different zones', () => {
  const ber = tm.parse('tomorrow 9:00', { now: NOW, zone: BER }).ms;
  const ny = tm.parse('tomorrow 9:00', { now: NOW, zone: 'America/New_York' }).ms;
  const utc = tm.parse('tomorrow 9:00', { now: NOW, zone: 'UTC' }).ms;
  assert.equal(utc, Date.parse('2026-10-04T09:00:00Z'));
  assert.equal(ber, Date.parse('2026-10-04T07:00:00Z'));
  assert.equal(ny, Date.parse('2026-10-04T13:00:00Z'));
});

test('zone resolution: config, then CHEAP_MEM_TZ, then the system; an unknown zone is refused', () => {
  assert.equal(tm.resolveZone('Europe/Berlin', { CHEAP_MEM_TZ: 'UTC' }), 'Europe/Berlin');
  assert.equal(tm.resolveZone(null, { CHEAP_MEM_TZ: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(tm.resolveZone(null, {}), tm.systemZone());
  assert.throws(() => tm.resolveZone('Mars/Olympus', {}), /not a zone/);
  assert.throws(() => tm.resolveZone(null, { CHEAP_MEM_TZ: 'nope' }), /not a zone/);
});

test('clock changes: ambiguous wall time takes the earlier, a skipped one the hour after (Berlin and New York)', () => {
  const c = tm.clockFor(BER);
  assert.equal(c.wallToUtc(2026, 10, 25, 2, 30), Date.parse('2026-10-25T00:30:00Z'), 'autumn: the CEST one');
  assert.equal(c.wallToUtc(2026, 3, 29, 2, 30), Date.parse('2026-03-29T01:30:00Z'), 'spring: 03:30 CEST');
  assert.equal(wall(BER, c.wallToUtc(2026, 3, 29, 2, 30)), '2026-03-29 03:30');
  const ny = tm.clockFor('America/New_York');
  assert.equal(ny.wallToUtc(2026, 11, 1, 1, 30), Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(wall('America/New_York', ny.wallToUtc(2026, 3, 8, 2, 30)), '2026-03-08 03:30');
  assert.equal(wall('Asia/Kolkata', tm.clockFor('Asia/Kolkata').wallToUtc(2026, 1, 1, 9, 0)), '2026-01-01 09:00');
});

test('repeats: wall time stays across the clock change; weekdays skip weekends; monthly keeps the anchor day', () => {
  const start = tm.clockFor(BER).wallToUtc(2026, 10, 24, 9, 0); // Saturday before the change
  assert.equal(wall(BER, tm.occurrence(start, 'daily', 2, BER)), '2026-10-26 09:00');
  assert.equal(tm.occurrence(start, 'daily', 2, BER) - start, 2 * 86400000 + 3600000, 'not +48 h: the clock change adds an hour');
  assert.equal(wall(BER, tm.occurrence(start, 'weekly', 1, BER)), '2026-10-31 09:00');
  const fri = tm.clockFor(BER).wallToUtc(2026, 10, 2, 7, 0);
  assert.deepEqual([0, 1, 2, 3].map((k) => wall(BER, tm.occurrence(fri, 'weekdays', k, BER))), ['2026-10-02 07:00', '2026-10-05 07:00', '2026-10-06 07:00', '2026-10-07 07:00']);
  const jan31 = tm.clockFor(BER).wallToUtc(2027, 1, 31, 9, 0);
  assert.deepEqual([0, 1, 2, 12].map((k) => wall(BER, tm.occurrence(jan31, 'monthly', k, BER)).slice(0, 10)), ['2027-01-31', '2027-02-28', '2027-03-31', '2028-01-31']);
  const leap = tm.clockFor(BER).wallToUtc(2027, 12, 31, 9, 0);
  assert.equal(wall(BER, tm.occurrence(leap, 'monthly', 2, BER)).slice(0, 10), '2028-02-29');
  assert.equal(tm.occurrence(start, null, 1, BER), null);
});

test('lastUntil / nextAfter / inWindow agree with occurrence()', () => {
  const a = tm.clockFor(BER).wallToUtc(2026, 10, 5, 9, 0);
  const now = tm.clockFor(BER).wallToUtc(2026, 10, 14, 9, 0) + 1000;
  const l = tm.lastUntil(a, 'daily', now, BER);
  assert.equal(l.k, 9);
  assert.equal(tm.nextAfter(a, 'daily', now, BER).k, 10);
  assert.equal(tm.lastUntil(a, null, a - 1, BER), null);
  assert.equal(tm.nextAfter(a, null, a + 1, BER), null);
  const win = tm.inWindow(a, 'weekdays', a, a + 14 * 86400000, { zone: BER });
  assert.equal(win.length, 10);
  assert.equal(tm.inWindow(a, null, a - 5, a + 5, { zone: BER }).length, 1);
});

test('durations', () => {
  assert.equal(tm.durationMinutes('15m'), 15);
  assert.equal(tm.durationMinutes('2h'), 120);
  assert.equal(tm.durationMinutes('1d'), 1440);
  assert.equal(tm.durationMinutes('90'), 90);
  assert.equal(tm.durationMinutes('0'), null);
  assert.equal(tm.durationMinutes('31d'), null);
  assert.equal(tm.durationMinutes('soon'), null);
});
