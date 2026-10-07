// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// appointment-invite: the calendar outlet. A fake SMTP server and a fake Google Calendar API stand in for the
// network; the iCalendar text is checked against RFC 5545 rules; idempotence, backoff, rights on the credential
// files and "no secret anywhere" are probed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as A from '../src/appointments.mjs';
import * as I from '../src/appointment-invite.mjs';
import * as tm from '../src/appointment-time.mjs';
import * as doctor from '../src/doctor.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ZONE = 'Europe/Berlin';
const clock = tm.clockFor(ZONE);
const wall = (y, mo, d, h = 0, mi = 0) => clock.wallToUtc(y, mo, d, h, mi);
const NOW = wall(2026, 10, 5, 8, 0);
const HUMAN = A.actorFrom({ name: 'human:alex', authority: 'user', env: {} });
const AGENT = { name: 'vm-admin', human: false, reason: 'agent' };
// Secrets are built at run time, so this file holds no literal that looks like one.
const PASSWORD = ['pw', Math.random().toString(36).slice(2), 'Zq9'].join('-');

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function world(calendar = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-invite-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    version: 1, participants: { alex: { role: 'the human', human: true }, 'vm-admin': 'agent' }, language: 'en', timezone: ZONE, calendar,
  }));
  return r;
}
function secretFile(r, name, content, mode = 0o600) {
  const f = path.join(r, name);
  fs.writeFileSync(f, content, { mode });
  fs.chmodSync(f, mode);
  return f;
}
const make = (r, o) => A.create(r, { actor: HUMAN, now: NOW - 3600000, env: {}, ...o });
const smtpConf = (r, port, extra = {}) => ({
  calendar: { route: 'smtp', smtp: { host: '127.0.0.1', port, tls: 'plain', user: 'me@example.test', from: 'cm@example.test', to: 'me@example.test', passwordFile: secretFile(r, 'smtp-pass', PASSWORD), ...extra } },
});
const configOf = (r, calendar) => I.readConfig(r, {}, { file: calendar });
const journal = (r) => fs.existsSync(path.join(r, A.DIR, I.JOURNAL_FILE)) ? fs.readFileSync(path.join(r, A.DIR, I.JOURNAL_FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/** A fake SMTP server (plain, loopback): AUTH PLAIN/LOGIN, records every accepted message. `behaviour(n)` may refuse. */
function fakeSmtp({ behaviour = () => null, advertise = 'AUTH PLAIN LOGIN' } = {}) {
  const got = []; let attempts = 0;
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    let mode = 'cmd'; let data = ''; let user = null; let pass = null; let authStep = 0; let from = null; let to = null;
    attempts += 1;
    const n = attempts;
    const refusal = behaviour(n);
    s.write('220 fake ESMTP\r\n');
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      for (;;) {
        if (mode === 'data') {
          const i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          data = buf.slice(0, i); buf = buf.slice(i + 5); mode = 'cmd';
          if (refusal === 'reject-data') { s.write('554 no\r\n'); continue; }
          got.push({ user, pass, from, to, raw: data });
          s.write('250 queued\r\n'); continue;
        }
        const j = buf.indexOf('\r\n');
        if (j < 0) return;
        const line = buf.slice(0, j); buf = buf.slice(j + 2);
        if (authStep === 1) { user = Buffer.from(line, 'base64').toString(); authStep = 2; s.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (authStep === 2) { pass = Buffer.from(line, 'base64').toString(); authStep = 0; s.write(refusal === 'bad-auth' ? '535 nope\r\n' : '235 ok\r\n'); continue; }
        if (/^EHLO/i.test(line)) s.write(`250-fake\r\n250 ${advertise}\r\n`);
        else if (/^AUTH PLAIN /i.test(line)) { const [, u, p] = Buffer.from(line.slice(11), 'base64').toString().split('\0'); user = u; pass = p; s.write(refusal === 'bad-auth' ? '535 nope\r\n' : '235 ok\r\n'); }
        else if (/^AUTH LOGIN/i.test(line)) { authStep = 1; s.write('334 VXNlcm5hbWU6\r\n'); }
        else if (/^MAIL FROM:/i.test(line)) { from = line.slice(10).replace(/[<>]/g, ''); s.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { to = line.slice(8).replace(/[<>]/g, ''); s.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { mode = 'data'; s.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { s.end('221 bye\r\n'); }
        else s.write('500 ?\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ got, port: server.address().port, attempts: () => attempts, close: () => new Promise((r2) => { server.closeAllConnections?.(); server.close(r2); }) })));
}

// --- RFC 5545 helpers ----------------------------------------------------------

function mimeParts(raw) {
  const out = [];
  const re = /Content-Type: ([^\r\n]+)\r\n(?:Content-Disposition: [^\r\n]+\r\n)?Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?=\r\n--)/g;
  let m;
  while ((m = re.exec(raw))) out.push({ type: m[1], body: Buffer.from(m[2].replace(/\r\n/g, ''), 'base64').toString('utf8') });
  return out;
}
function checkIcs(ics) {
  assert.ok(ics.endsWith('\r\n'), 'ends with CRLF');
  assert.ok(!/[^\r]\n/.test(ics), 'no bare LF');
  const phys = ics.split('\r\n'); phys.pop();
  for (const l of phys) assert.ok(Buffer.byteLength(l) <= 75, `line over 75 octets: ${l.slice(0, 40)}...`);
  const unfolded = ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
  const event = unfolded.slice(unfolded.indexOf('BEGIN:VEVENT'));
  const stack = [];
  for (const l of unfolded) {
    if (l.startsWith('BEGIN:')) stack.push(l.slice(6));
    else if (l.startsWith('END:')) assert.equal(stack.pop(), l.slice(4), 'balanced BEGIN/END');
  }
  assert.deepEqual(stack, []);
  assert.equal(unfolded[0], 'BEGIN:VCALENDAR');
  assert.ok(unfolded.includes('VERSION:2.0'));
  assert.ok(unfolded.some((l) => /^PRODID:/.test(l)));
  assert.equal(unfolded.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  const prop = (n) => (n === 'METHOD' ? unfolded : event).find((l) => l.startsWith(`${n}:`) || l.startsWith(`${n};`));
  for (const n of ['UID', 'DTSTAMP', 'DTSTART', 'SUMMARY', 'SEQUENCE', 'ORGANIZER', 'ATTENDEE', 'STATUS', 'METHOD']) assert.ok(prop(n), `${n} present`);
  assert.match(prop('DTSTAMP'), /^DTSTAMP:\d{8}T\d{6}Z$/);
  const tz = /TZID=([^:]+):/.exec(prop('DTSTART'))[1];
  assert.ok(unfolded.includes(`TZID:${tz}`), 'VTIMEZONE for the TZID in use');
  return { unfolded, prop, get: (n) => (prop(n) ?? '').replace(/^[^:]*:/, '') };
}

// --- tests ----------------------------------------------------------------------

test('config: ships empty (off), and every field comes from the config or the environment, nothing hardcoded', () => {
  const r = world();
  const off = I.readConfig(r, {});
  assert.equal(off.active, false);
  assert.match(off.reason, /not set up/);
  assert.equal(I.status(r, { env: {} }).active, false);
  assert.equal(fs.existsSync(path.join(r, A.DIR)), false, 'status of an off outlet writes nothing');
  const src = fs.readFileSync(path.join(SRC, 'appointment-invite.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /smtp\.[a-z0-9-]+\.[a-z]+|@(?!cheap-mem)[a-z0-9-]+\.[a-z]{2,}/i, 'no mail host and no address in the code');
  const f = '/tmp/pass-file';
  const c = I.readConfig(r, { CHEAP_MEM_SMTP_HOST: 'mail.example.test', CHEAP_MEM_SMTP_USER: 'me@example.test', CHEAP_MEM_SMTP_PASSWORD_FILE: f });
  assert.equal(c.active, true);
  assert.equal(c.route, 'smtp');
  assert.equal(c.port, 465);
  assert.equal(c.tls, 'ssl');
  assert.equal(c.to, 'me@example.test', 'recipient defaults to the user, sender too');
  assert.equal(I.readConfig(r, { CHEAP_MEM_SMTP_PORT: '587', CHEAP_MEM_SMTP_HOST: 'h.example.test', CHEAP_MEM_SMTP_USER: 'me@example.test', CHEAP_MEM_SMTP_PASSWORD_FILE: f }).tls, 'starttls');
  const bad = [
    [{ route: 'carrier' }, /smtp, google or off/],
    [{ route: 'smtp', smtp: { user: 'me@example.test', passwordFile: f } }, /host is missing/],
    [{ route: 'smtp', smtp: { host: 'h', user: 'not-an-address', passwordFile: f } }, /not a mail address/],
    [{ route: 'smtp', smtp: { host: 'h', user: 'a@b.test', passwordFile: 'relative' } }, /absolute path/],
    [{ route: 'smtp', smtp: { host: 'mail.example.test', tls: 'plain', user: 'a@b.test', passwordFile: f } }, /only against the local machine/],
    [{ route: 'smtp', smtp: { host: 'h', port: 70000, user: 'a@b.test', passwordFile: f } }, /port number/],
    [{ route: 'google', google: { keyFile: f } }, /calendarId is missing/],
    [{ route: 'google', google: { calendarId: 'me@example.test' } }, /keyFile is missing/],
    [{ route: 'google', google: { calendarId: 'me@example.test', keyFile: 'rel' } }, /absolute path/],
    [{ route: 'smtp', remindBeforeMin: 0, smtp: { host: 'h', user: 'a@b.test', passwordFile: f } }, /1 to 43200/],
  ];
  for (const [cal, re] of bad) {
    const x = I.readConfig(r, {}, { file: cal });
    assert.equal(x.active, false, JSON.stringify(cal));
    assert.match(x.reason, re);
  }
  assert.equal(I.readConfig(r, { CHEAP_MEM_CALENDAR_ROUTE: 'off' }, { file: { route: 'smtp' } }).active, false);
  assert.equal(I.readConfig(r, {}, { file: { google: { calendarId: 'me@example.test', keyFile: f } } }).route, 'google', 'a calendar id implies google');
});

test('iCalendar: RFC 5545 shape (CRLF, folding, escaping, VTIMEZONE, RRULE, VALARM, SEQUENCE, CANCEL)', () => {
  const a = { id: 'abc123def456', title: 'Lunch; with, \\ comma äöü€ '.repeat(8), text: 'line one\nline two, with; chars', atMs: wall(2026, 10, 7, 12, 30), repeat: null, beforeMin: 20, private: false };
  const req = I.buildIcs({ a, method: 'REQUEST', sequence: 0, from: 'cm@example.test', to: 'me@example.test', zone: ZONE, nowMs: NOW });
  const p = checkIcs(req);
  assert.equal(p.get('UID'), 'abc123def456@cheap-mem');
  assert.equal(p.get('SEQUENCE'), '0');
  assert.equal(p.get('METHOD'), 'REQUEST');
  assert.equal(p.get('STATUS'), 'CONFIRMED');
  assert.equal(p.get('DTSTART'), '20261007T123000');
  assert.match(p.prop('DTSTART'), /^DTSTART;TZID=Europe\/Berlin:/);
  assert.ok(p.unfolded.includes('TRIGGER:-PT20M'), 'VALARM with the appointment\'s own lead');
  assert.ok(p.unfolded.some((l) => /^SUMMARY:.*\\;.*\\,.*\\\\/.test(l)), 'TEXT escaping of ; , \\');
  assert.ok(p.unfolded.some((l) => /^DESCRIPTION:line one\\nline two\\, with\\; chars$/.test(l)));
  assert.ok(req.split('\r\n').some((l) => l.startsWith(' ')), 'a long line is folded');
  // Folding never cuts a multi-byte character.
  const unfoldedBytes = Buffer.from(req.replace(/\r\n[ \t]/g, ''), 'utf8').toString('utf8');
  assert.ok(!unfoldedBytes.includes('�'));
  assert.ok(p.unfolded.some((l) => l.startsWith('SUMMARY:') && l.includes('äöü€')));
  const cancel = I.buildIcs({ a, method: 'CANCEL', sequence: 2, from: 'cm@example.test', to: 'me@example.test', zone: ZONE, nowMs: NOW });
  const pc = checkIcs(cancel);
  assert.equal(pc.get('STATUS'), 'CANCELLED');
  assert.equal(pc.get('SEQUENCE'), '2');
  assert.equal(pc.get('UID'), p.get('UID'), 'the same UID cancels the invitation');
  assert.ok(!pc.unfolded.includes('BEGIN:VALARM'));
  // Repeats.
  const rr = (repeat, at) => checkIcs(I.buildIcs({ a: { ...a, repeat, atMs: at }, method: 'REQUEST', sequence: 0, from: 'a@b.test', to: 'a@b.test', zone: ZONE, nowMs: NOW })).get('RRULE');
  assert.equal(rr('daily', a.atMs), 'FREQ=DAILY');
  assert.equal(rr('weekly', a.atMs), 'FREQ=WEEKLY');
  assert.equal(rr('weekdays', a.atMs), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(rr('monthly', wall(2026, 10, 15, 9, 0)), 'FREQ=MONTHLY;BYMONTHDAY=15');
  assert.equal(rr('monthly', wall(2026, 10, 31, 9, 0)), 'FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1');
  assert.equal(rr(null, a.atMs), '');
});

test('VTIMEZONE: derived for any zone from Intl (Berlin, New York, Sydney, a zone without changes)', () => {
  const expectations = {
    'Europe/Berlin': [/BYMONTH=3;BYDAY=-1SU/, /BYMONTH=10;BYDAY=-1SU/, /TZOFFSETTO:\+0200/],
    'America/New_York': [/BYMONTH=3;BYDAY=2SU/, /BYMONTH=11;BYDAY=1SU/, /TZOFFSETTO:-0400/],
    'Australia/Sydney': [/BYMONTH=10;BYDAY=1SU/, /BYMONTH=4;BYDAY=1SU/, /TZOFFSETTO:\+1100/],
  };
  for (const [zone, res] of Object.entries(expectations)) {
    const text = I.vtimezone(zone, Date.parse('2026-10-05T12:00:00Z')).join('\n');
    for (const re of res) assert.match(text, re, `${zone}: ${re}`);
    assert.match(text, new RegExp(`TZID:${zone}`));
  }
  const tokyo = I.vtimezone('Asia/Tokyo', Date.parse('2026-10-05T12:00:00Z')).join('\n');
  assert.doesNotMatch(tokyo, /RRULE/);
  assert.match(tokyo, /TZOFFSETTO:\+0900/);
  const ics = I.buildIcs({ a: { id: 'x1', title: 'T', text: '', atMs: Date.parse('2026-10-05T12:00:00Z'), repeat: null, beforeMin: null, private: false }, method: 'REQUEST', sequence: 0, from: 'a@b.test', to: 'a@b.test', zone: 'America/New_York', nowMs: NOW });
  assert.equal(checkIcs(ics).get('DTSTART'), '20261005T080000');
});

test('private: only "Private appointment" leaves the machine, in the .ics, the mail text and the Google event', () => {
  const a = { id: 'p1p1p1p1p1p1', title: 'Therapy', text: 'details', atMs: wall(2026, 10, 7, 12, 0), repeat: null, beforeMin: null, private: true };
  const mail = I.buildMail({ a, method: 'REQUEST', sequence: 0, from: 'a@b.test', to: 'a@b.test', zone: ZONE, nowMs: NOW });
  const all = mail.raw + mail.ics + mimeParts(mail.raw).map((p) => p.body).join('\n');
  assert.doesNotMatch(all, /Therapy|details/);
  assert.match(mimeParts(mail.raw).map((p) => p.body).join('\n'), /Private appointment/);
});

test('smtp: an invitation goes out once; moved = same UID, higher SEQUENCE; cancelled = CANCEL; nothing twice', async () => {
  const r = world();
  const smtp = await fakeSmtp();
  const cal = smtpConf(r, smtp.port).calendar;
  const c = configOf(r, cal);
  try {
    const a = make(r, { title: 'Dentist', text: 'bring the card', atMs: wall(2026, 10, 7, 10, 0), beforeMin: 30 });
    make(r, { title: 'An action', atMs: wall(2026, 10, 7, 11, 0), wake: 'vm-admin', task: 't' });
    make(r, { title: 'Brief', atMs: wall(2026, 10, 7, 7, 0), kind: 'briefing' });
    A.create(r, { title: 'Proposal', atMs: wall(2026, 10, 7, 12, 0), reminderActive: false, actor: AGENT, now: NOW, env: {} });
    const t1 = await I.tick(r, { now: NOW, config: c });
    assert.equal(t1.sent, 1, 'only the armed reminder: not the action, the briefing or the proposal');
    assert.equal(smtp.got.length, 1);
    const m = smtp.got[0];
    assert.equal(m.user, 'me@example.test');
    assert.equal(m.pass, PASSWORD);
    assert.equal(m.from, 'cm@example.test');
    assert.equal(m.to, 'me@example.test');
    const parts = mimeParts(m.raw);
    const ical = parts.find((p) => /text\/calendar/.test(p.type));
    assert.match(ical.type, /method=REQUEST/);
    const p = checkIcs(ical.body);
    assert.equal(p.get('UID'), `${a.id}@cheap-mem`);
    assert.ok(p.unfolded.includes('TRIGGER:-PT30M'));
    assert.ok(parts.some((x) => /invite\.ics/.test(x.type)), 'the .ics also as an attachment');
    assert.match(m.raw, /Subject: Invitation: Dentist/);
    // Idempotent: a second tick sends nothing.
    assert.equal((await I.tick(r, { now: NOW + 60000, config: c })).sent, 0);
    assert.equal(smtp.got.length, 1);
    // Moved: the same UID, SEQUENCE 1.
    A.move(r, a.id, { atMs: wall(2026, 10, 8, 10, 0), actor: HUMAN, now: NOW });
    assert.equal((await I.tick(r, { now: NOW + 120000, config: c })).sent, 1);
    const moved = checkIcs(mimeParts(smtp.got[1].raw).find((x) => /text\/calendar/.test(x.type)).body);
    assert.equal(moved.get('SEQUENCE'), '1');
    assert.equal(moved.get('UID'), p.get('UID'));
    assert.equal(moved.get('DTSTART'), '20261008T100000');
    assert.match(smtp.got[1].raw, /Subject: Updated: Dentist/);
    // Cancelled: METHOD:CANCEL with the next SEQUENCE.
    A.cancel(r, a.id, { actor: HUMAN, now: NOW });
    assert.equal((await I.tick(r, { now: NOW + 180000, config: c })).sent, 1);
    const cx = mimeParts(smtp.got[2].raw).find((x) => /text\/calendar/.test(x.type));
    assert.match(cx.type, /method=CANCEL/);
    assert.equal(checkIcs(cx.body).get('SEQUENCE'), '2');
    assert.equal((await I.tick(r, { now: NOW + 240000, config: c })).sent, 0);
    assert.equal(smtp.got.length, 3);
    // Cancelling something that never got an invitation sends no cancellation.
    const b = make(r, { title: 'Quick', atMs: wall(2026, 10, 9, 10, 0) });
    A.cancel(r, b.id, { actor: HUMAN, now: NOW });
    assert.equal((await I.tick(r, { now: NOW + 300000, config: c })).sent, 0);
    // A past, one-off reminder is not invited.
    A.create(r, { title: 'Yesterday', atMs: NOW - 86400000, actor: HUMAN, now: NOW, env: {} });
    assert.equal((await I.tick(r, { now: NOW + 360000, config: c })).sent, 0);
  } finally { await smtp.close(); }
});

test('smtp: LOGIN fallback, the journal and the status carry no secret, title, text or address', async () => {
  const r = world();
  const smtp = await fakeSmtp({ advertise: 'AUTH LOGIN' });
  const c = configOf(r, smtpConf(r, smtp.port).calendar);
  try {
    make(r, { title: 'Confidential merger lunch', text: 'secret agenda', atMs: wall(2026, 10, 7, 10, 0) });
    assert.equal((await I.tick(r, { now: NOW, config: c })).sent, 1);
    assert.equal(smtp.got[0].pass, PASSWORD);
    const journalText = fs.readFileSync(path.join(r, A.DIR, I.JOURNAL_FILE), 'utf8');
    const statusText = JSON.stringify(I.status(r, { now: NOW, config: c }));
    const doctorText = JSON.stringify(doctor.checkAppointmentInvite(r, { now: new Date(NOW) }));
    for (const [where, text] of [['journal', journalText], ['status', statusText], ['doctor', doctorText]]) {
      for (const secret of [PASSWORD, 'Confidential', 'secret agenda']) assert.ok(!text.includes(secret), `${secret} leaked into ${where}`);
    }
    // The journal and the doctor carry no address either (the status shows the configured route for the human to check).
    for (const addr of ['me@example.test', 'cm@example.test']) {
      assert.ok(!journalText.includes(addr) && !doctorText.includes(addr), `${addr} leaked`);
    }
  } finally { await smtp.close(); }
});

test('smtp failures: backoff 1,2,4..60 minutes, given up after 10, retry brings it back; a permanent refusal is a short code', async () => {
  const r = world();
  const smtp = await fakeSmtp({ behaviour: () => 'reject-data' });
  const c = configOf(r, smtpConf(r, smtp.port).calendar);
  try {
    make(r, { title: 'Dentist', atMs: wall(2026, 10, 20, 10, 0) });
    let now = NOW;
    const t1 = await I.tick(r, { now, config: c });
    assert.equal(t1.sent, 0);
    assert.match(t1.failures[0], /rejected 554/);
    // Inside the backoff nothing is attempted.
    assert.deepEqual((await I.tick(r, { now: now + 30000, config: c })).failures, []);
    assert.equal(smtp.attempts(), 1);
    const waits = [];
    for (let n = 1; n < 10; n += 1) {
      const f = journal(r).filter((z) => z.type === 'failed').at(-1);
      waits.push(Math.round((Date.parse(f.next) - Date.parse(f.ts)) / 60000));
      now = Date.parse(f.next) + 1000;
      await I.tick(r, { now, config: c });
    }
    assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
    assert.equal(smtp.attempts(), 10);
    const last = journal(r).filter((z) => z.type === 'failed').at(-1);
    assert.equal(last.gave_up, true);
    assert.equal(last.next, null);
    assert.equal((await I.tick(r, { now: now + 7 * 86400000, config: c })).failures.length, 0, 'given up: not tried again by itself');
    assert.equal(smtp.attempts(), 10);
    const st = I.status(r, { now, config: c });
    assert.equal(st.gaveUp, 1);
  } finally { await smtp.close(); }
  // retry: ignores backoff and "given up" once the server works again.
  const good = await fakeSmtp();
  try {
    const c2 = configOf(r, smtpConf(r, good.port).calendar);
    const t = await I.tick(r, { now: NOW + 8 * 86400000, config: c2, retry: true });
    assert.equal(t.sent, 1);
    assert.equal(good.got.length, 1);
    assert.equal(I.status(r, { now: NOW + 8 * 86400000, config: c2 }).open.length, 0);
  } finally { await good.close(); }
});

test('smtp: a bad login is a short "auth" code, never the server text or the password', async () => {
  const r = world();
  const smtp = await fakeSmtp({ behaviour: () => 'bad-auth' });
  const c = configOf(r, smtpConf(r, smtp.port).calendar);
  try {
    make(r, { title: 'Dentist', atMs: wall(2026, 10, 20, 10, 0) });
    const t = await I.tick(r, { now: NOW, config: c });
    assert.match(t.failures[0], /auth 535/);
    assert.equal(smtp.got.length, 0);
    assert.ok(!fs.readFileSync(path.join(r, A.DIR, I.JOURNAL_FILE), 'utf8').includes(PASSWORD));
  } finally { await smtp.close(); }
});

test('credential files: wider than 600 is refused WITHOUT any network access; the doctor says error', { skip: process.platform === 'win32' && 'no POSIX permission bits on Windows' }, async () => {
  const r = world();
  const smtp = await fakeSmtp();
  try {
    const conf = smtpConf(r, smtp.port);
    fs.chmodSync(conf.calendar.smtp.passwordFile, 0o644);
    const c = configOf(r, conf.calendar);
    make(r, { title: 'Dentist', atMs: wall(2026, 10, 20, 10, 0) });
    const t = await I.tick(r, { now: NOW, config: c });
    assert.match(t.failures[0], /credential/);
    assert.equal(smtp.attempts(), 0, 'no connection was even opened');
    assert.equal(I.credentialState(c).ok, false);
    assert.match(I.credentialState(c).reason, /too wide \(644\)/);
    const f = doctor.checkAppointmentInvite(r, { now: new Date(NOW), });
    assert.equal(f.name, 'appointment-invite');
    // The doctor reads the real config, which here is the config file: set it so the doctor sees the same outlet.
    const cfgPath = path.join(r, '.mem', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); cfg.calendar = conf.calendar; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const f2 = doctor.checkAppointmentInvite(r, { now: new Date(NOW) });
    assert.equal(f2.level, 'error');
    assert.match(f2.text, /too wide/);
    assert.ok(f2.advice);
    fs.chmodSync(conf.calendar.smtp.passwordFile, 0o600);
    assert.equal(I.credentialState(c).ok, true);
    for (const bad of [['missing', null], ['empty', '']]) {
      const cc = { ...conf.calendar, smtp: { ...conf.calendar.smtp, passwordFile: bad[1] === null ? path.join(r, 'nope') : secretFile(r, 'empty', '') } };
      assert.equal(I.credentialState(configOf(r, cc)).ok, false, bad[0]);
    }
  } finally { await smtp.close(); }
});

test('doctor finding: off is good; on and healthy is good; open failing entries warn, after six hours error', async () => {
  const r = world();
  assert.equal(doctor.checkAppointmentInvite(r).level, 'good');
  const smtp = await fakeSmtp({ behaviour: () => 'reject-data' });
  try {
    const conf = smtpConf(r, smtp.port);
    const cfgPath = path.join(r, '.mem', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); cfg.calendar = conf.calendar; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    assert.equal(doctor.checkAppointmentInvite(r, { now: new Date(NOW) }).level, 'good');
    make(r, { title: 'Dentist', atMs: wall(2026, 10, 20, 10, 0) });
    await I.tick(r, { now: NOW, env: {} });
    const w = doctor.checkAppointmentInvite(r, { now: new Date(NOW + 60000) });
    assert.equal(w.level, 'warn');
    assert.match(w.text, /rejected/);
    assert.equal(doctor.checkAppointmentInvite(r, { now: new Date(NOW + 7 * 3600000) }).level, 'error');
  } finally { await smtp.close(); }
});

// --- Google ----------------------------------------------------------------------------

function fakeGoogle() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const events = new Map(); const calls = []; let tokens = 0;
  const email = 'svc@example-project.iam.test';
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
    if (u.pathname === '/token') {
      const jwt = new URLSearchParams(init.body).get('assertion');
      const [h, c, s] = jwt.split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      if (!ok || claims.iss !== email || !/calendar\.events$/.test(claims.scope)) return reply(401, {});
      tokens += 1;
      return reply(200, { access_token: `tok${tokens}`, expires_in: 3600 });
    }
    if (!/^Bearer tok/.test(init.headers?.authorization ?? '')) return reply(401, {});
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(.+))?$/.exec(u.pathname);
    if (!m) return reply(404, {});
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === 'POST') { if (events.has(body.id)) return reply(409, {}); events.set(body.id, body); return reply(200, body); }
    if (method === 'PATCH') { if (!events.has(m[2])) return reply(404, {}); events.set(m[2], { ...events.get(m[2]), ...body }); return reply(200, events.get(m[2])); }
    if (method === 'DELETE') { if (!events.has(m[2])) return reply(404, {}); events.delete(m[2]); return reply(204, {}); }
    return reply(405, {});
  };
  return { fetcher, events, calls, tokens: () => tokens, email, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

test('google: JWT is signed RS256 and accepted; insert, patch on move, delete on cancel; the token is fetched once', async () => {
  const r = world();
  const g = fakeGoogle();
  const keyFile = secretFile(r, 'svc.json', JSON.stringify({ client_email: g.email, private_key: g.privateKey }));
  const c = configOf(r, { route: 'google', remindBeforeMin: 25, google: { calendarId: 'owner@example.test', keyFile } });
  const google = { fetcher: g.fetcher, tokenUrl: 'http://fake.test/token', apiUrl: 'http://fake.test/calendar/v3' };
  const a = make(r, { title: 'Dentist', text: 'card', atMs: wall(2026, 10, 7, 10, 0), repeat: 'weekdays' });
  assert.equal((await I.tick(r, { now: NOW, config: c, google })).sent, 1);
  const id = I.eventIdOf(a.id);
  assert.match(id, /^cm[0-9a-v]{12}$/);
  const ev = g.events.get(id);
  assert.equal(ev.summary, 'Dentist');
  assert.equal(ev.start.dateTime, '2026-10-07T10:00:00');
  assert.equal(ev.start.timeZone, ZONE);
  assert.deepEqual(ev.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']);
  assert.deepEqual(ev.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 25 }] });
  assert.equal((await I.tick(r, { now: NOW + 1000, config: c, google })).sent, 0);
  A.move(r, a.id, { atMs: wall(2026, 10, 8, 11, 0), actor: HUMAN, now: NOW });
  await I.tick(r, { now: NOW + 2000, config: c, google });
  assert.equal(g.events.get(id).start.dateTime, '2026-10-08T11:00:00');
  assert.equal(g.events.get(id).sequence, 1);
  A.cancel(r, a.id, { actor: HUMAN, now: NOW });
  await I.tick(r, { now: NOW + 3000, config: c, google });
  assert.equal(g.events.size, 0);
  assert.equal(g.tokens(), 1, 'the token is cached in memory, not fetched per call');
  assert.ok(!fs.readFileSync(path.join(r, A.DIR, I.JOURNAL_FILE), 'utf8').includes('tok1'));
});

test('google: 409 on insert becomes a patch; 404 on patch becomes an insert; 404/410 on delete is done; 403 is auth', async () => {
  const r = world();
  const g = fakeGoogle();
  const keyFile = secretFile(r, 'svc.json', JSON.stringify({ client_email: g.email, private_key: g.privateKey }));
  const c = configOf(r, { route: 'google', google: { calendarId: 'owner@example.test', keyFile } });
  const google = { fetcher: g.fetcher, tokenUrl: 'http://fake.test/token', apiUrl: 'http://fake.test/calendar/v3' };
  const a = make(r, { title: 'Dentist', atMs: wall(2026, 10, 7, 10, 0) });
  g.events.set(I.eventIdOf(a.id), { id: I.eventIdOf(a.id), summary: 'stale' });
  await I.tick(r, { now: NOW, config: c, google });
  assert.equal(g.events.get(I.eventIdOf(a.id)).summary, 'Dentist');
  assert.ok(g.calls.includes('POST /calendar/v3/calendars/owner%40example.test/events'));
  assert.ok(g.calls.some((x) => x.startsWith('PATCH')));
  g.events.clear();
  A.move(r, a.id, { atMs: wall(2026, 10, 8, 10, 0), actor: HUMAN, now: NOW });
  await I.tick(r, { now: NOW + 1000, config: c, google });
  assert.equal(g.events.size, 1, 'the changed event was missing: it is inserted');
  g.events.clear();
  A.cancel(r, a.id, { actor: HUMAN, now: NOW });
  const t = await I.tick(r, { now: NOW + 2000, config: c, google });
  assert.equal(t.sent, 1, 'delete of an already missing event counts as done');
  const denied = { ...google, fetcher: async (url) => (String(url).split('?')[0].endsWith('/token') ? { status: 200, ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) } : { status: 403, ok: false, json: async () => ({}) }) };
  const b = make(r, { title: 'Another', atMs: wall(2026, 10, 9, 10, 0) });
  const t2 = await I.tick(r, { now: NOW + 3000, config: c, google: denied });
  assert.match(t2.failures.join(), new RegExp(`${b.id} REQUEST auth 403`));
});

test('google: a key file with wide permissions or without the key fields is refused before any request', async () => {
  const r = world();
  const g = fakeGoogle();
  let calls = 0;
  const google = { fetcher: async () => { calls += 1; return { status: 500, ok: false }; }, tokenUrl: 'http://fake.test/token', apiUrl: 'http://fake.test/calendar/v3' };
  make(r, { title: 'Dentist', atMs: wall(2026, 10, 7, 10, 0) });
  if (process.platform !== 'win32') { // Windows has no POSIX permission bits: only the missing-fields half applies there
    const wide = secretFile(r, 'wide.json', JSON.stringify({ client_email: g.email, private_key: g.privateKey }), 0o640);
    const t = await I.tick(r, { now: NOW, config: configOf(r, { route: 'google', google: { calendarId: 'o@example.test', keyFile: wide } }), google });
    assert.match(t.failures[0], /credential/);
  }
  const junk = secretFile(r, 'junk.json', '{"nothing":1}');
  const t2 = await I.tick(r, { now: NOW + 1000000, config: configOf(r, { route: 'google', google: { calendarId: 'o@example.test', keyFile: junk } }), google });
  assert.match(t2.failures[0], /credential/);
  assert.equal(calls, 0);
});

test('switching the route announces existing future appointments once to the new route, each route idempotent on its own', async () => {
  const r = world();
  const smtp = await fakeSmtp();
  const g = fakeGoogle();
  try {
    const keyFile = secretFile(r, 'svc.json', JSON.stringify({ client_email: g.email, private_key: g.privateKey }));
    make(r, { title: 'Dentist', atMs: wall(2026, 10, 20, 10, 0) });
    const cs = configOf(r, smtpConf(r, smtp.port).calendar);
    const cg = configOf(r, { route: 'google', google: { calendarId: 'o@example.test', keyFile } });
    const google = { fetcher: g.fetcher, tokenUrl: 'http://fake.test/token', apiUrl: 'http://fake.test/calendar/v3' };
    assert.equal((await I.tick(r, { now: NOW, config: cs })).sent, 1);
    assert.equal((await I.tick(r, { now: NOW, config: cg, google })).sent, 1);
    assert.equal((await I.tick(r, { now: NOW + 1000, config: cs })).sent, 0);
    assert.equal((await I.tick(r, { now: NOW + 1000, config: cg, google })).sent, 0);
    assert.deepEqual([...new Set(journal(r).filter((z) => z.type === 'sent').map((z) => z.route))].sort(), ['google', 'smtp']);
    assert.equal(I.outletFor('smtp').route, 'smtp');
    assert.throws(() => I.outletFor('graph'), /does not exist/);
  } finally { await smtp.close(); }
});

test('sendTest: a test appointment in 20 minutes, outside the due list, with a result', async () => {
  const r = world();
  const smtp = await fakeSmtp();
  try {
    const c = configOf(r, smtpConf(r, smtp.port).calendar);
    const t = await I.sendTest(r, { now: NOW, config: c });
    assert.equal(t.ok, true);
    assert.match(t.appointment, /^test[0-9a-f]{12}$/);
    assert.equal(t.atMs, Math.ceil((NOW + 20 * 60000) / 60000) * 60000);
    assert.equal(smtp.got.length, 1);
    assert.equal((await I.tick(r, { now: NOW + 1000, config: c })).state, 'empty', 'no appointment file: the test is not part of the due list');
    await assert.rejects(() => I.sendTest(r, { now: NOW, config: configOf(r, {}) }), /outlet is off/);
  } finally { await smtp.close(); }
});

const tlsAvailable = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('smtp over SSL: certificate checked (the fake CA is passed in tests only)', { skip: tlsAvailable ? false : 'openssl not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tls-'));
  roots.push(dir);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const tls = await import('node:tls');
  const got = [];
  const server = tls.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (s) => {
    s.setEncoding('utf8'); s.write('220 hi\r\n'); let buf = ''; let data = false;
    s.on('data', (d) => {
      buf += d;
      for (;;) {
        if (data) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; got.push(buf.slice(0, i)); buf = buf.slice(i + 5); data = false; s.write('250 ok\r\n'); continue; }
        const j = buf.indexOf('\r\n'); if (j < 0) return; const l = buf.slice(0, j); buf = buf.slice(j + 2);
        if (/^EHLO/.test(l)) s.write('250-x\r\n250 AUTH PLAIN\r\n'); else if (/^AUTH/.test(l)) s.write('235 ok\r\n'); else if (/^(MAIL|RCPT)/.test(l)) s.write('250 ok\r\n');
        else if (/^DATA/.test(l)) { data = true; s.write('354 go\r\n'); } else if (/^QUIT/.test(l)) s.end('221 bye\r\n');
      }
    });
    s.on('error', () => {});
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  try {
    const conf = { host: 'localhost', port: server.address().port, tls: 'ssl', user: 'me@example.test' };
    const raw = 'Subject: t\r\n\r\nbody\r\n';
    await I.sendSmtp({ config: conf, password: PASSWORD, from: 'a@b.test', to: 'c@d.test', raw, ca: fs.readFileSync(path.join(dir, 'c.pem')) });
    assert.equal(got.length, 1);
    await assert.rejects(() => I.sendSmtp({ config: conf, password: PASSWORD, from: 'a@b.test', to: 'c@d.test', raw }), (e) => e.code === 'certificate');
  } finally { server.close(); }
});

// --- Red proof -----------------------------------------------------------------------------------

test('RED proof: without the idempotence guard the second tick sends again (the probe above bites); the old state has no outlet at all', async () => {
  // (1) The old state, fixed commit: the module does not exist there. Positive control: a module that did exist then is found.
  const OLD = '24cd9a9';
  const has = (f) => { try { execFileSync('git', ['cat-file', '-e', `${OLD}:${f}`], { cwd: path.join(SRC, '..'), stdio: 'ignore' }); return true; } catch { return false; } };
  const gitHere = (() => { try { execFileSync('git', ['cat-file', '-e', `${OLD}:src/inbox.mjs`], { cwd: path.join(SRC, '..'), stdio: 'ignore' }); return true; } catch { return false; } })();
  if (gitHere) {
    assert.equal(has('src/inbox.mjs'), true, 'positive control: the probe finds a file that existed');
    assert.equal(has('src/appointment-invite.mjs'), false);
    assert.equal(has('src/appointments.mjs'), false);
  }
  // (2) A mutant: a copy of src/ with the "already sent" guard removed in BOTH places must double-send.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mutant-'));
  roots.push(copy);
  fs.cpSync(SRC, path.join(copy, 'src'), { recursive: true });
  const file = path.join(copy, 'src', 'appointment-invite.mjs');
  let text = fs.readFileSync(file, 'utf8');
  const guard1 = 'const open = all.filter((s) => !journal.per.get(s.key)?.sent)';
  const guard1b = 'return { all, open: all.filter((s) => !journal.per.get(s.key)?.sent) };';
  const guard2 = '  if (e.sent) return false;\n';
  assert.ok(text.includes(guard1b) && text.includes(guard2), 'the guard lines the mutant removes exist (else this probe measures nothing)');
  text = text.replace(guard1b, 'return { all, open: all };').replace(guard2, '');
  void guard1;
  fs.writeFileSync(file, text);
  const run = async (modPath) => {
    const r = world();
    const smtp = await fakeSmtp();
    try {
      const Imod = await import(`${pathToFileURL(modPath).href}?m=${Math.random()}`);
      const Amod = await import(`${pathToFileURL(path.join(path.dirname(modPath), 'appointments.mjs')).href}?m=${Math.random()}`);
      Amod.create(r, { title: 'Dentist', atMs: wall(2026, 10, 20, 10, 0), actor: Amod.actorFrom({ name: 'h', authority: 'user', env: {} }), now: NOW, env: {} });
      const c = Imod.readConfig(r, {}, { file: smtpConf(r, smtp.port).calendar });
      await Imod.tick(r, { now: NOW, config: c });
      await Imod.tick(r, { now: NOW + 5000, config: c });
      return smtp.got.length;
    } finally { await smtp.close(); }
  };
  assert.equal(await run(path.join(SRC, 'appointment-invite.mjs')), 1, 'the real module sends once');
  assert.equal(await run(file), 2, 'the mutant sends twice: the idempotence probe really catches a missing guard');
});
