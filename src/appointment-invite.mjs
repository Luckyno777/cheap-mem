// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * appointment-invite — the calendar OUTLET: reminders as invitations in a real calendar.
 *
 * Ported from lucky-mem (src/termine-mail.mjs), in English, with nothing hardcoded:
 * no provider, no address, no participant. Everything comes from `.mem/config.json`
 * (`calendar`) or from `CHEAP_MEM_*` environment switches, and ships empty: without
 * a route the outlet is OFF, writes no file and nothing breaks.
 *
 * **What goes out.** For every ARMED reminder (not an action `--wake`, not a
 * briefing, not a proposal): an invitation (iCalendar METHOD:REQUEST) when it is
 * created or confirmed, a new one with a higher SEQUENCE when it is moved, a
 * cancellation (METHOD:CANCEL) when it is cancelled. The invitation is DERIVED from
 * the folded state (`dueList`), not hooked into the write paths: which
 * (appointment, SEQUENCE, method) ought to have gone out? What the journal does not
 * yet know as sent goes out. So there is exactly one path (the tick), and an
 * appointment created on another machine or by an agent is handled the same way.
 *
 * **The journal** `appointments/invites.jsonl` (append-only, never title, text,
 * address or secret):
 *   attempt   (id, appointment, sequence, method, n)        "sending now" (a claim, valid 2 minutes)
 *   sent      (attempt_id, appointment, sequence, method)   the server accepted
 *   failed    (attempt_id, ..., code, status?, next|null)   only a short code and the 3-digit number
 * Idempotent: a key route|appointment|SEQUENCE|method with `sent` never goes out again.
 * If a run dies between the server's "250" and `sent`, the next tick after the claim
 * runs out sends once more — same UID and SEQUENCE, which a calendar treats as the
 * same invitation (at-least-once, named honestly). Failures back off 1, 2, 4 ... 60
 * minutes, and after 10 attempts the entry is `given up`; only `mem appointment
 * calendar retry` tries it again.
 *
 * **Interchangeable routes.** The journal and the tick know only the interface
 * `outletFor(route).send({ kind: create | change | cancel, appointment, sequence, config, ... })`.
 * Route `smtp`: the .ics by mail (Outlook/Exchange, Gmail, any mail server).
 * Route `google`: the Google Calendar API directly, with a SERVICE ACCOUNT (JWT RS256
 * with node:crypto, token from oauth2.googleapis.com cached in memory only, events
 * insert/patch/delete over fetch, a fixed event id derived from the appointment id:
 * 409 = already there -> patch). A third route is one line in `OUTLETS`.
 *
 * **Reminders on the Google route (measured in lucky-mem, 2026-10-03).** The event is
 * sent with `reminders.overrides` (popup, N minutes), but Google keeps reminders PER
 * USER: what a service account sets applies only to the service account. In the
 * calendar OWNER's view the event shows `useDefault: true` — the owner's own default
 * notification of that calendar applies. So the lead time is set by the OWNER in the
 * Google Calendar settings of the calendar; `--remind-before` per appointment does
 * not act on this route. On the `smtp` route the invitation carries a VALARM, which
 * most calendar apps honour.
 *
 * **Microsoft 365.** SMTP AUTH is often DISABLED on Microsoft 365 / Exchange Online
 * tenants (disabled by default for new tenants, and "security defaults" switch it off).
 * Where it is blocked, route `smtp` cannot log in (the status says `auth`); the way
 * then is a Microsoft Graph route (calendar events over HTTPS with an app registration),
 * which is NOT built here — it would be a third entry in `OUTLETS` with the same
 * `send` interface.
 *
 * **Secrets** live only in files with permissions 0600 (the SMTP password, the
 * service-account JSON); a file with wider rights is REFUSED without any network access.
 * The content is never in an argument, the journal, the status or an error message.
 *
 * **Own SMTP client** (node:net, node:tls, no dependency): SSL (465) or STARTTLS (587),
 * AUTH PLAIN/LOGIN, one total time limit per sending. Plain text only against the
 * local machine (tests), never over a network.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createSign, randomBytes } from 'node:crypto';
import { appendLine } from './append.mjs';
import { LockTimeoutError, withLock } from './filelock.mjs';
import * as cfgmod from './config.mjs';
import * as A from './appointments.mjs';
import * as tm from './appointment-time.mjs';

export const JOURNAL_FILE = 'invites.jsonl';
const LOCK = path.join('.mem', 'appointment-invites.lock');

const DEFAULT_PORT = 465;
const DEFAULT_BEFORE_MIN = 15;
const TIME_LIMIT_MS = 20000;
const CLAIM_MS = 120000;
const MAX_ATTEMPTS = 10;
const BACKOFF_MAX_MIN = 60;
const TICK_BUDGET_MS = 25000;
const EVENT_MIN = 15;
const PRODID = '-//cheap-mem//Appointments//EN';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_API_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_POPUP_MAX_MIN = 40320;

export class InviteError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'InviteError'; this.code = code; Object.assign(this, extra); }
}

const pad = (n) => String(n).padStart(2, '0');
const newId = () => randomBytes(6).toString('hex');
const ADDRESS = /^[^\s<>@"',;:\\]+@[^\s<>@"',;:\\]+\.[^\s<>@"',;:\\]+$/;

// --- Configuration -------------------------------------------------------------------

/**
 * The outlet's configuration: `.mem/config.json` `calendar`, overridden by the environment.
 *
 *   calendar.route               smtp | google | off            CHEAP_MEM_CALENDAR_ROUTE
 *   calendar.remindBeforeMin     default lead (VALARM / popup)   CHEAP_MEM_CALENDAR_REMIND_MIN
 *   calendar.smtp.host|port|tls|user|from|to|passwordFile
 *                                CHEAP_MEM_SMTP_HOST|PORT|TLS|USER|FROM|TO|PASSWORD_FILE
 *   calendar.google.calendarId|keyFile
 *                                CHEAP_MEM_CALENDAR_ID | CHEAP_MEM_CALENDAR_KEY_FILE
 *
 * `{ active, route, reason, ... }`. `active` is true only when everything needed is set and
 * valid; the secret itself is never read here. The route defaults to `google` when a calendar id
 * is set, else `smtp` when an SMTP user is set, else off.
 */
export function readConfig(root, env = process.env, { file = undefined } = {}) {
  let c = file;
  if (c === undefined) {
    try { c = cfgmod.readConfig(root).calendar ?? {}; } catch { c = {}; }
  }
  c = c && typeof c === 'object' ? c : {};
  const smtp = c.smtp && typeof c.smtp === 'object' ? c.smtp : {};
  const google = c.google && typeof c.google === 'object' ? c.google : {};
  const pick = (a, b) => (a !== undefined && a !== '' ? a : b);
  const w = {
    route: pick(env.CHEAP_MEM_CALENDAR_ROUTE, c.route),
    before: pick(env.CHEAP_MEM_CALENDAR_REMIND_MIN, c.remindBeforeMin),
    host: pick(env.CHEAP_MEM_SMTP_HOST, smtp.host), port: pick(env.CHEAP_MEM_SMTP_PORT, smtp.port),
    tls: pick(env.CHEAP_MEM_SMTP_TLS, smtp.tls), user: pick(env.CHEAP_MEM_SMTP_USER, smtp.user),
    from: pick(env.CHEAP_MEM_SMTP_FROM, smtp.from), to: pick(env.CHEAP_MEM_SMTP_TO, smtp.to),
    passwordFile: pick(env.CHEAP_MEM_SMTP_PASSWORD_FILE, smtp.passwordFile),
    calendarId: pick(env.CHEAP_MEM_CALENDAR_ID, google.calendarId), keyFile: pick(env.CHEAP_MEM_CALENDAR_KEY_FILE, google.keyFile),
  };
  const off = (reason) => ({ active: false, route: 'off', reason, host: null, port: null, tls: null, user: null, from: null, to: null, beforeMin: DEFAULT_BEFORE_MIN, passwordFile: null, calendarId: null, keyFile: null });
  const route = w.route ?? (w.calendarId ? 'google' : (w.user ? 'smtp' : 'off'));
  if (route === 'off') return off(w.route === 'off' ? 'calendar.route is off' : 'not set up (no calendar.route in .mem/config.json)');
  if (!OUTLETS[route]) return off('calendar.route is smtp, google or off');
  const beforeRaw = w.before;
  const beforeMin = beforeRaw === undefined ? DEFAULT_BEFORE_MIN : Number(beforeRaw);
  if (!Number.isInteger(beforeMin) || beforeMin < 1 || beforeMin > 43200) return off('calendar.remindBeforeMin: 1 to 43200 minutes');
  if (route === 'google') {
    if (!w.calendarId) return off('calendar.google.calendarId is missing (for a personal calendar: the owner\'s address)');
    if (!/^[^\s/?#]{3,200}$/.test(String(w.calendarId))) return off('calendar.google.calendarId is not a calendar id');
    if (!w.keyFile) return off('calendar.google.keyFile is missing (absolute path of the service-account JSON, permissions 600)');
    if (!path.isAbsolute(String(w.keyFile))) return off('calendar.google.keyFile must be an absolute path');
    return { active: true, route, reason: null, host: null, port: null, tls: null, user: null, from: null, to: null, beforeMin, passwordFile: null, calendarId: String(w.calendarId), keyFile: String(w.keyFile) };
  }
  if (!w.user) return off('calendar.smtp.user is missing');
  if (!w.passwordFile) return off('calendar.smtp.passwordFile is missing');
  if (!ADDRESS.test(String(w.user))) return off('calendar.smtp.user is not a mail address');
  if (!w.host) return off('calendar.smtp.host is missing');
  const to = String(w.to ?? w.user);
  const from = String(w.from ?? w.user);
  if (!ADDRESS.test(from)) return off('calendar.smtp.from is not a mail address');
  if (!ADDRESS.test(to)) return off('calendar.smtp.to is not a mail address');
  const host = String(w.host);
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return off('calendar.smtp.host is not a host name');
  const port = w.port === undefined ? DEFAULT_PORT : Number(w.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return off('calendar.smtp.port is not a port number');
  const kind = w.tls ?? (port === 587 ? 'starttls' : 'ssl');
  if (!['ssl', 'starttls', 'plain'].includes(kind)) return off('calendar.smtp.tls is ssl, starttls or plain');
  if (kind === 'plain' && !['127.0.0.1', 'localhost', '::1'].includes(host)) return off('plain (no TLS) is allowed only against the local machine (tests), never over a network');
  if (!path.isAbsolute(String(w.passwordFile))) return off('calendar.smtp.passwordFile must be an absolute path');
  return { active: true, route, reason: null, host, port, tls: kind, user: String(w.user), from, to, beforeMin, passwordFile: String(w.passwordFile), calendarId: null, keyFile: null };
}

/** Check the permissions of the credential file (SMTP password / service-account key) WITHOUT reading it: `{ ok, reason }`. */
export function credentialState(config) {
  const google = config?.route === 'google';
  const file = google ? config.keyFile : config?.passwordFile;
  const name = google ? 'key file' : 'password file';
  if (!file) return { ok: false, reason: `no ${name} set` };
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? `${name} is missing` : `${name} is not readable` }; }
  if (!st.isFile()) return { ok: false, reason: `${name} is not a file` };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: `${name} has permissions that are too wide (${(st.mode & 0o777).toString(8)}), expected 600` };
  if (st.size === 0) return { ok: false, reason: `${name} is empty` };
  return { ok: true, reason: null };
}

function readPassword(config) {
  const s = credentialState(config);
  if (!s.ok) throw new InviteError('credential', s.reason);
  // Providers show app passwords in groups separated by spaces; the server takes them without.
  const p = fs.readFileSync(config.passwordFile, 'utf8').replace(/[\r\n]+$/, '').replace(/\s+/g, '');
  if (!p) throw new InviteError('credential', 'password file is empty');
  return p;
}

// --- iCalendar (RFC 5545) ------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const STRIP_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** TEXT value escaped: backslash, semicolon, comma, newline. */
function icsText(s) {
  return String(s).replace(STRIP_CONTROL, '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line to at most 75 octets (UTF-8 characters stay whole); a continuation starts with a space. */
function foldLine(line) {
  const out = []; let cur = ''; let len = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (len + b > 75) { out.push(cur); cur = ' '; len = 1; }
    cur += ch; len += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

const local = (zone, ms) => { const f = tm.clockFor(zone).fields(ms); return `${f.year}${pad(f.month)}${pad(f.day)}T${pad(f.hour)}${pad(f.minute)}00`; };
const utc = (ms) => A.iso(ms).replace(/[-:]/g, '');
const DAY_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function rrule(repeat, startMs, zone) {
  if (repeat === 'daily') return 'FREQ=DAILY';
  if (repeat === 'weekly') return 'FREQ=WEEKLY';
  if (repeat === 'weekdays') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (repeat === 'monthly') {
    // The clock takes the same day, and in shorter months the last one; RFC: candidates 28..d, the last counts.
    const d = tm.clockFor(zone).fields(startMs).day;
    if (d <= 28) return `FREQ=MONTHLY;BYMONTHDAY=${d}`;
    const days = []; for (let i = 28; i <= d; i += 1) days.push(i);
    return `FREQ=MONTHLY;BYMONTHDAY=${days.join(',')};BYSETPOS=-1`;
  }
  return null;
}

/** "+0200" of an offset in ms. */
const offsetText = (ms) => { const m = Math.round(ms / 60000); const sign = m < 0 ? '-' : '+'; const a = Math.abs(m); return `${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`; };

/**
 * A VTIMEZONE for any zone, derived from Intl (no tz database needed): the offset changes of the
 * year of `startMs` are found by bisection and written as yearly rules (month + "nth weekday");
 * a zone without changes gets one fixed STANDARD component. Rules are exact for the usual
 * "last Sunday of March"-style zones; for a zone with an unusual rule the transitions of that
 * year still hold and later years follow the same pattern (named limit).
 */
export function vtimezone(zone, startMs) {
  const clock = tm.clockFor(zone);
  const offsetOf = (ms) => { const f = clock.fields(ms); return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - Math.floor(ms / 60000) * 60000; };
  const year = clock.fields(startMs).year;
  const from = Date.UTC(year, 0, 1);
  const to = Date.UTC(year + 1, 0, 1);
  const changes = [];
  let prev = offsetOf(from);
  const step = 6 * 3600000;
  for (let t = from + step; t <= to; t += step) {
    const o = offsetOf(t);
    if (o !== prev) {
      let lo = t - step; let hi = t;
      while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 2 / 60000) * 60000; if (offsetOf(mid) === prev) lo = mid; else hi = mid; }
      changes.push({ at: hi, from: prev, to: o });
      prev = o;
    }
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  if (!changes.length) {
    const o = offsetOf(startMs);
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${offsetText(o)}`, `TZOFFSETTO:${offsetText(o)}`, `TZNAME:${clock.zoneLabel(startMs) || zone}`, `DTSTART:${year}0101T000000`, 'END:STANDARD');
  } else {
    for (const c of changes) {
      // The wall time just BEFORE the change, in the old offset: that is the moment the rule fires.
      const w = new Date(c.at + c.from);
      const m = w.getUTCMonth() + 1; const d = w.getUTCDate();
      const dim = new Date(Date.UTC(w.getUTCFullYear(), m, 0)).getUTCDate();
      const nth = d + 7 > dim ? -1 : Math.ceil(d / 7);
      const wd = DAY_CODE[w.getUTCDay()];
      const daylight = c.to > c.from;
      lines.push(`BEGIN:${daylight ? 'DAYLIGHT' : 'STANDARD'}`, `TZOFFSETFROM:${offsetText(c.from)}`, `TZOFFSETTO:${offsetText(c.to)}`,
        `TZNAME:${clock.zoneLabel(c.at + 3600000) || zone}`,
        `DTSTART:${w.getUTCFullYear()}${pad(m)}${pad(d)}T${pad(w.getUTCHours())}${pad(w.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${m};BYDAY=${nth}${wd}`, `END:${daylight ? 'DAYLIGHT' : 'STANDARD'}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

/** Stable UID per appointment id (tests and cancellations rely on it). */
const uidOf = (id) => `${id}@cheap-mem`;

const isPrivate = (a) => a.private === true || a.title === A.PRIVATE_TITLE;

/**
 * The calendar text of an appointment. `a`: { id, title, text, atMs, repeat, beforeMin, private };
 * `method`: REQUEST | CANCEL; `sequence` rises with every change. Private ones carry only "Private appointment".
 */
export function buildIcs({ a, method, sequence, from, to, zone, beforeMin = DEFAULT_BEFORE_MIN, nowMs = Date.now() }) {
  const priv = isPrivate(a);
  const summary = priv ? A.PRIVATE_TITLE : a.title;
  const startMs = tm.occurrence(a.atMs, a.repeat, 0, zone) ?? a.atMs;
  const n = Number.isInteger(a.beforeMin) && a.beforeMin > 0 ? a.beforeMin : beforeMin;
  const z = [
    'BEGIN:VCALENDAR', `PRODID:${PRODID}`, 'VERSION:2.0', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    ...vtimezone(zone, startMs),
    'BEGIN:VEVENT', `UID:${uidOf(a.id)}`, `DTSTAMP:${utc(nowMs)}`, `SEQUENCE:${sequence}`,
    `DTSTART;TZID=${zone}:${local(zone, startMs)}`, `DTEND;TZID=${zone}:${local(zone, startMs + EVENT_MIN * 60000)}`,
  ];
  const r = rrule(a.repeat, startMs, zone);
  if (r) z.push(`RRULE:${r}`);
  z.push(`SUMMARY:${icsText(summary)}`);
  if (!priv && a.text) z.push(`DESCRIPTION:${icsText(a.text)}`);
  z.push(`ORGANIZER;CN=cheap-mem:mailto:${from}`);
  z.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${to}`);
  z.push(method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');
  z.push('TRANSP:TRANSPARENT');
  if (method === 'REQUEST') z.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-PT${n}M`, `DESCRIPTION:${icsText(summary)}`, 'END:VALARM');
  z.push('END:VEVENT', 'END:VCALENDAR');
  return `${z.map(foldLine).join('\r\n')}\r\n`;
}

// --- MIME ------------------------------------------------------------------------------

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
const headerWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** Short plain text to go with the invitation; private: no details. */
function plainText({ a, method, sequence, zone, beforeMin }) {
  const priv = isPrivate(a);
  const n = Number.isInteger(a.beforeMin) && a.beforeMin > 0 ? a.beforeMin : beforeMin;
  const head = method === 'CANCEL' ? 'Cancelled' : (sequence > 0 ? 'Moved / changed' : 'Reminder');
  const z = [`${head}: ${priv ? A.PRIVATE_TITLE : a.title}`];
  if (method !== 'CANCEL') {
    z.push(`When: ${tm.clockFor(zone).text(tm.occurrence(a.atMs, a.repeat, 0, zone) ?? a.atMs)} (${zone})`);
    if (a.repeat) z.push(`Repeats: ${a.repeat}`);
    z.push(`Reminder ${n} minutes before.`);
    if (!priv && a.text) z.push('', a.text);
  }
  z.push('', `Calendar invitation from cheap-mem, appointment ${a.id}.`);
  return z.join('\r\n');
}

/** The whole mail (head and body, CRLF): multipart/mixed with text/plain, text/calendar and invite.ics. */
export function buildMail({ a, method, sequence, from, to, zone, beforeMin = DEFAULT_BEFORE_MIN, nowMs = Date.now() }) {
  const ics = buildIcs({ a, method, sequence, from, to, zone, beforeMin, nowMs });
  const title = isPrivate(a) ? A.PRIVATE_TITLE : a.title;
  const subject = `${method === 'CANCEL' ? 'Cancelled' : (sequence > 0 ? 'Updated' : 'Invitation')}: ${title}`.replace(/[\r\n]+/g, ' ');
  const outer = `cm-a-${randomBytes(8).toString('hex')}`;
  const inner = `cm-b-${randomBytes(8).toString('hex')}`;
  const text = plainText({ a, method, sequence, zone, beforeMin });
  const z = [
    `From: cheap-mem <${from}>`, `To: <${to}>`, `Subject: ${headerWord(subject)}`,
    `Date: ${new Date(nowMs).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${a.id}.${sequence}.${method.toLowerCase()}.${randomBytes(4).toString('hex')}@cheap-mem>`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${outer}"`, '',
    `--${outer}`, `Content-Type: multipart/alternative; boundary="${inner}"`, '',
    `--${inner}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    `--${inner}`, `Content-Type: text/calendar; charset=UTF-8; method=${method}`, 'Content-Transfer-Encoding: base64', '', b64(ics),
    `--${inner}--`,
    `--${outer}`, 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', 'Content-Transfer-Encoding: base64', '', b64(ics),
    `--${outer}--`, '',
  ];
  return { subject, raw: z.join('\r\n'), ics };
}

// --- SMTP ---------------------------------------------------------------------------------

class Wire {
  constructor(sock) { this.buffer = ''; this.replies = []; this.waiting = null; this.failure = null; this.lines = []; this.attach(sock); }
  attach(sock) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d) => { this.buffer += d; this.split(); });
    sock.on('error', (e) => this.fail(new InviteError(/cert|self.signed|unable to verify|hostname/i.test(e.message) ? 'certificate' : 'connection', `connection: ${e.code ?? 'error'}`)));
    sock.on('close', () => this.fail(new InviteError('connection', 'connection closed by the server')));
  }
  split() {
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, ''); this.buffer = this.buffer.slice(i + 1);
      this.lines.push(line);
      const m = /^(\d{3})([ -])/.exec(line);
      if (m && m[2] === ' ') { this.replies.push({ code: Number(m[1]), lines: this.lines }); this.lines = []; }
    }
    this.next();
  }
  next() {
    if (this.waiting && this.replies.length) { const w = this.waiting; this.waiting = null; w.ok(this.replies.shift()); }
    else if (this.waiting && this.failure) { const w = this.waiting; this.waiting = null; w.no(this.failure); }
  }
  fail(e) { if (!this.failure) { this.failure = e; this.next(); } }
  reply() { return new Promise((ok, no) => { this.waiting = { ok, no }; this.next(); }); }
  write(text) { this.sock.write(text); }
}

function expect(r, codes, step) {
  if (codes.includes(r.code)) return r;
  throw new InviteError(step === 'auth' ? 'auth' : 'rejected', `${step}: the server answered ${r.code}`, { status: r.code, permanent: r.code >= 500 });
}

/**
 * Send one mail over SMTP. `ca` (tests only): an extra trusted issuer.
 * Throws `InviteError` with `code` (connection | time | certificate | auth | rejected | credential) and maybe `status` (3 digits).
 * The password is in no message.
 */
export async function sendSmtp({ config, password, from, to, raw, timeLimitMs = TIME_LIMIT_MS, ca = undefined }) {
  let sock; let wire = null;
  const tlsOpt = { servername: config.host, ...(ca ? { ca } : {}) };
  const run = (async () => {
    sock = config.tls === 'ssl'
      ? tls.connect({ host: config.host, port: config.port, ...tlsOpt })
      : net.connect({ host: config.host, port: config.port });
    wire = new Wire(sock);
    expect(await wire.reply(), [220], 'greeting');
    const ehlo = async () => {
      wire.write(`EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'cheap-mem'}\r\n`);
      return expect(await wire.reply(), [250], 'EHLO');
    };
    let caps = await ehlo();
    if (config.tls === 'starttls') {
      wire.write('STARTTLS\r\n');
      expect(await wire.reply(), [220], 'STARTTLS');
      sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
      sock = tls.connect({ socket: sock, ...tlsOpt });
      await new Promise((ok, no) => { sock.once('secureConnect', ok); sock.once('error', (e) => no(new InviteError(/cert|self.signed|unable to verify|hostname/i.test(e.message) ? 'certificate' : 'connection', 'TLS handshake failed'))); });
      // eslint-disable-next-line require-atomic-updates
      wire = new Wire(sock);
      caps = await ehlo();
    }
    const offered = caps.lines.map((x) => x.toUpperCase());
    if (offered.some((x) => /AUTH[ =].*PLAIN/.test(x))) {
      wire.write(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${password}`, 'utf8').toString('base64')}\r\n`);
      expect(await wire.reply(), [235], 'auth');
    } else if (offered.some((x) => /AUTH[ =].*LOGIN/.test(x))) {
      wire.write('AUTH LOGIN\r\n');
      expect(await wire.reply(), [334], 'auth');
      wire.write(`${Buffer.from(config.user, 'utf8').toString('base64')}\r\n`);
      expect(await wire.reply(), [334], 'auth');
      wire.write(`${Buffer.from(password, 'utf8').toString('base64')}\r\n`);
      expect(await wire.reply(), [235], 'auth');
    } else {
      throw new InviteError('auth', 'the server offers neither AUTH PLAIN nor AUTH LOGIN', { permanent: true });
    }
    wire.write(`MAIL FROM:<${from}>\r\n`); expect(await wire.reply(), [250], 'MAIL FROM');
    wire.write(`RCPT TO:<${to}>\r\n`); expect(await wire.reply(), [250, 251], 'RCPT TO');
    wire.write('DATA\r\n'); expect(await wire.reply(), [354], 'DATA');
    const body = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    wire.write(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    expect(await wire.reply(), [250], 'acceptance');
    try { wire.write('QUIT\r\n'); } catch { /* does not matter */ }
  })();
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(() => no(new InviteError('time', `time limit ${Math.round(timeLimitMs / 1000)} s`)), timeLimitMs); });
  try {
    await Promise.race([run, limit]);
  } finally {
    clearTimeout(timer);
    run.catch(() => {});
    try { sock?.destroy(); } catch { /* does not matter */ }
  }
}

// --- The journal ------------------------------------------------------------------------------

const journalPath = (root) => path.join(root, A.DIR, JOURNAL_FILE);
const keyOf = (route, appointment, sequence, method) => `${route}|${appointment}|${sequence}|${method}`;
const FIRST_ROUTE = 'smtp';

function journalAppend(root, line) {
  fs.mkdirSync(path.join(root, A.DIR), { recursive: true });
  appendLine(journalPath(root), `${JSON.stringify(line)}\n`);
}

/** Fold the journal: per key route|appointment|SEQUENCE|method the state, plus which appointments have an invitation. */
function loadJournal(root) {
  const per = new Map(); const invited = new Set(); const attemptKey = new Map();
  let raw = '';
  let broken = 0;
  try { raw = fs.readFileSync(journalPath(root), 'utf8'); } catch { raw = ''; }
  let lastSend = null; let sentTotal = 0;
  for (const s of raw.split('\n')) {
    if (!s.trim()) continue;
    let z; try { z = JSON.parse(s); } catch { broken += 1; continue; }
    if (!z || typeof z !== 'object') { broken += 1; continue; }
    const key = z.type === 'attempt' ? keyOf(z.route ?? FIRST_ROUTE, z.appointment, z.sequence, z.method) : attemptKey.get(z.attempt_id);
    if (!key) continue;
    let e = per.get(key);
    if (!e) { e = { route: z.route ?? FIRST_ROUTE, appointment: z.appointment, sequence: z.sequence, method: z.method, sent: null, attempts: 0, claimedAt: null, lastFailure: null, next: null, gaveUp: false, first: z.ts ?? null }; per.set(key, e); }
    if (z.type === 'attempt') {
      attemptKey.set(z.id, key);
      e.claimedAt = Date.parse(z.ts); e.attempts = Number.isInteger(z.n) ? z.n : e.attempts + 1;
      if (z.manual) { e.gaveUp = false; e.next = null; }
    } else if (z.type === 'sent') {
      e.sent = z.ts ?? 'yes'; e.claimedAt = null; sentTotal += 1; lastSend = z.ts ?? lastSend;
      if (z.method === 'REQUEST') invited.add(`${z.route ?? FIRST_ROUTE}|${z.appointment}`);
    } else if (z.type === 'failed') {
      e.claimedAt = null; e.lastFailure = { ts: z.ts ?? null, code: z.code ?? null, status: z.status ?? null };
      e.next = z.next ? Date.parse(z.next) : null; e.gaveUp = z.gave_up === true;
    }
  }
  return { per, invited, broken, sentTotal, lastSend };
}

// --- What ought to go out ------------------------------------------------------------------------

/**
 * From the folded state and the journal: which invitations ought to have gone out, and are missing?
 * Only reminders that are armed (active) or cancelled, never actions (`wake`) and never briefings.
 * `{ open: [...], all: [...] }`; per entry { key, route, a, method, sequence }.
 */
function dueList(state, journal, nowMs, route) {
  const all = [];
  for (const x of state.items.values()) {
    if (x.kind !== 'reminder' || x.wake) continue;
    const a = { id: x.id, title: x.title, text: x.text, atMs: x.atMs, repeat: x.repeat, beforeMin: x.beforeMin, private: x.private };
    const past = !x.repeat && x.atMs < nowMs;
    if (x.status === 'active') {
      if (past) continue;
      all.push({ key: keyOf(route, x.id, x.moved, 'REQUEST'), route, a, method: 'REQUEST', sequence: x.moved });
    } else if (x.status === 'cancelled') {
      // A cancellation makes sense only if an invitation ever went to that route, and while it is still ahead.
      if (!journal.invited.has(`${route}|${x.id}`) || past) continue;
      all.push({ key: keyOf(route, x.id, x.moved + 1, 'CANCEL'), route, a, method: 'CANCEL', sequence: x.moved + 1 });
    }
  }
  return { all, open: all.filter((s) => !journal.per.get(s.key)?.sent) };
}

/** Wait after the n-th failed attempt, in minutes: 1, 2, 4 ... up to 60. */
const backoffMin = (n) => Math.min(2 ** Math.max(0, n - 1), BACKOFF_MAX_MIN);

function ready(e, nowMs, noBackoff) {
  if (!e) return true;
  if (e.sent) return false;
  if (e.gaveUp && !noBackoff) return false;
  if (e.claimedAt !== null && nowMs - e.claimedAt < CLAIM_MS) return false;
  if (!noBackoff && e.next !== null && nowMs < e.next) return false;
  return true;
}

// --- The interface of the routes ------------------------------------------------------------------

/** Journal/interface kind from method and SEQUENCE: create | change | cancel. */
export const kindOf = (method, sequence) => (method === 'CANCEL' ? 'cancel' : (sequence > 0 ? 'change' : 'create'));
const METHOD_OF_KIND = { create: 'REQUEST', change: 'REQUEST', cancel: 'CANCEL' };

/**
 * Route 1: .ics over SMTP. `send({ kind, appointment, sequence, config, zone, nowMs, sender, ca })` throws `InviteError`.
 * (`sender` replaces only the network, in tests.)
 */
const smtpOutlet = {
  route: 'smtp',
  async send({ kind, appointment, sequence, config, zone, nowMs = Date.now(), sender = null, ca = undefined }) {
    const method = METHOD_OF_KIND[kind];
    if (!method) throw new InviteError('config', `unknown kind '${kind}'`);
    const password = readPassword(config);
    const m = buildMail({ a: appointment, method, sequence, from: config.from, to: config.to, zone, beforeMin: config.beforeMin, nowMs });
    await (sender ?? sendSmtp)({ config, password, from: config.from, to: config.to, raw: m.raw, ca });
  },
};

const b64url = (b) => Buffer.from(b).toString('base64url');
const tokenMemo = new Map(); // client_email -> { token, until } in memory only, never on disk

/** Read the key: only client_email and private_key, never output. Permissions 600 are checked first. */
function readKey(config) {
  const s = credentialState(config);
  if (!s.ok) throw new InviteError('credential', s.reason);
  let j;
  try { j = JSON.parse(fs.readFileSync(config.keyFile, 'utf8')); } catch { throw new InviteError('credential', 'key file is not JSON'); }
  if (!j || typeof j.client_email !== 'string' || typeof j.private_key !== 'string' || !j.private_key.includes('PRIVATE KEY')) {
    throw new InviteError('credential', 'key file is not a service-account key (client_email/private_key missing)');
  }
  return { email: j.client_email, key: j.private_key };
}

/** JWT (RS256) for the token exchange, signed with node:crypto. */
function buildJwt({ email, key }, nowMs, tokenUrl = GOOGLE_TOKEN_URL) {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: email, scope: GOOGLE_SCOPE, aud: tokenUrl, iat, exp: iat + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key);
  return `${head}.${claims}.${b64url(sig)}`;
}

function googleFailure(err, limit) {
  if (err instanceof InviteError) return err;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new InviteError('time', `time limit ${Math.round(limit / 1000)} s`);
  return new InviteError('connection', 'connection to Google failed');
}

async function googleToken(sk, { tokenUrl, fetcher, nowMs, limitMs }) {
  const known = tokenMemo.get(sk.email);
  if (known && known.until - 60000 > nowMs && known.url === tokenUrl) return known.token;
  let r;
  try {
    r = await fetcher(tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(sk, nowMs, tokenUrl) }).toString(),
      signal: AbortSignal.timeout(limitMs),
    });
  } catch (e) { throw googleFailure(e, limitMs); }
  if (r.status >= 500) throw new InviteError('connection', `token: Google answered ${r.status}`, { status: r.status });
  if (!r.ok) throw new InviteError('auth', `token: Google answered ${r.status}`, { status: r.status, permanent: true });
  let j; try { j = await r.json(); } catch { throw new InviteError('auth', 'token: answer not readable'); }
  if (typeof j?.access_token !== 'string') throw new InviteError('auth', 'token: answer without access_token');
  tokenMemo.set(sk.email, { token: j.access_token, until: nowMs + (Number(j.expires_in) || 3600) * 1000, url: tokenUrl });
  return j.access_token;
}

/** The fixed event id: base32hex (0-9, a-v), at least 5 characters — from the appointment id, never random. */
export const eventIdOf = (id) => `cm${String(id).toLowerCase().replace(/[^0-9a-v]/g, '')}`;

/** The calendar entry for an appointment (Google form). Private ones: only "Private appointment". */
function buildEvent({ a, sequence, zone, beforeMin = DEFAULT_BEFORE_MIN }) {
  const priv = isPrivate(a);
  const startMs = tm.occurrence(a.atMs, a.repeat, 0, zone) ?? a.atMs;
  const n = Math.min(Number.isInteger(a.beforeMin) && a.beforeMin > 0 ? a.beforeMin : beforeMin, GOOGLE_POPUP_MAX_MIN);
  const at = (ms) => { const f = tm.clockFor(zone).fields(ms); return { dateTime: `${f.year}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:00`, timeZone: zone }; };
  const r = rrule(a.repeat, startMs, zone);
  return {
    id: eventIdOf(a.id), status: 'confirmed', summary: priv ? A.PRIVATE_TITLE : a.title,
    ...(!priv && a.text ? { description: a.text } : {}),
    start: at(startMs), end: at(startMs + EVENT_MIN * 60000), ...(r ? { recurrence: [`RRULE:${r}`] } : {}),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: n }] },
    sequence, transparency: 'transparent',
  };
}

/**
 * Route 2: Google Calendar API. `google` (tests only, never from the environment): { tokenUrl, apiUrl, fetcher }.
 * create: insert (409 = already there -> patch); change: patch (404 -> insert); cancel: delete (404/410 = already gone).
 */
const googleOutlet = {
  route: 'google',
  async send({ kind, appointment, sequence, config, zone, nowMs = Date.now(), google = {} }) {
    const fetcher = google.fetcher ?? fetch;
    const apiUrl = google.apiUrl ?? GOOGLE_API_URL;
    const limitMs = google.limitMs ?? TIME_LIMIT_MS;
    if (!['create', 'change', 'cancel'].includes(kind)) throw new InviteError('config', `unknown kind '${kind}'`);
    const sk = readKey(config);
    const token = await googleToken(sk, { tokenUrl: google.tokenUrl ?? GOOGLE_TOKEN_URL, fetcher, nowMs, limitMs });
    const base = `${apiUrl}/calendars/${encodeURIComponent(config.calendarId)}/events`;
    const call = async (method, url, body) => {
      try {
        return await fetcher(url, {
          method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(limitMs),
        });
      } catch (e) { throw googleFailure(e, limitMs); }
    };
    const check = (r, ok) => {
      if (ok.includes(r.status)) return r;
      const code = r.status === 401 || r.status === 403 ? 'auth' : (r.status >= 500 || r.status === 429 ? 'connection' : 'rejected');
      throw new InviteError(code, `calendar: Google answered ${r.status}`, { status: r.status, permanent: code === 'rejected' });
    };
    const eid = eventIdOf(appointment.id);
    const event = buildEvent({ a: appointment, sequence, zone, beforeMin: config.beforeMin });
    if (kind === 'cancel') {
      check(await call('DELETE', `${base}/${eid}`), [200, 204, 404, 410]);
      return;
    }
    const patch = async () => check(await call('PATCH', `${base}/${eid}`, event), [200]);
    if (kind === 'change') {
      const r = await call('PATCH', `${base}/${eid}`, event);
      if (r.status === 404 || r.status === 410) { check(await call('POST', base, event), [200, 409]); return; }
      check(r, [200]);
      return;
    }
    const r = await call('POST', base, event);
    if (r.status === 409) { await patch(); return; }
    check(r, [200]);
  },
};

/** All routes. A new route (e.g. Microsoft Graph) is one line here with the same `send` shape. */
const OUTLETS = { smtp: smtpOutlet, google: googleOutlet };

/** The route with the name; throws `InviteError('config')` when there is none. */
export function outletFor(route) {
  const o = OUTLETS[route];
  if (!o) throw new InviteError('config', `route '${route}' does not exist`);
  return o;
}

// --- Send and book -------------------------------------------------------------------------------

function failureOf(err) {
  if (err instanceof InviteError) return { code: err.code, status: err.status ?? null };
  return { code: 'connection', status: null };
}

async function deliver(root, config, zone, s, { nowMs, sender, manual = false, ca, google }) {
  const e = loadJournal(root).per.get(s.key);
  const n = manual ? 1 : (e?.attempts ?? 0) + 1;
  const began = Date.now();
  const attemptId = newId();
  const base = { route: s.route, appointment: s.a.id, sequence: s.sequence, method: s.method };
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  try {
    withLock(path.join(root, LOCK), () => {
      const j = loadJournal(root).per.get(s.key);
      if (!ready(j, nowMs, manual)) throw new InviteError('busy', 'already done or in progress');
      journalAppend(root, { type: 'attempt', id: attemptId, ts: A.iso(nowMs), ...base, n, ...(manual ? { manual: true } : {}) });
    }, { waitMs: 4000 });
  } catch (err) {
    if (err instanceof InviteError && err.code === 'busy') return { ok: false, skipped: true };
    if (err instanceof LockTimeoutError) return { ok: false, skipped: true };
    throw err;
  }
  let result;
  try {
    await outletFor(s.route).send({ kind: kindOf(s.method, s.sequence), appointment: s.a, sequence: s.sequence, config, zone, nowMs, sender, ca, google });
    result = { ok: true };
  } catch (err) {
    result = { ok: false, ...failureOf(err) };
  }
  const later = nowMs + (Date.now() - began);
  withLock(path.join(root, LOCK), () => {
    if (result.ok) {
      journalAppend(root, { type: 'sent', attempt_id: attemptId, ts: A.iso(later), ...base, n });
    } else {
      const gaveUp = n >= MAX_ATTEMPTS;
      journalAppend(root, {
        type: 'failed', attempt_id: attemptId, ts: A.iso(later), ...base, n, code: result.code, ...(result.status ? { status: result.status } : {}),
        next: gaveUp ? null : A.iso(later + backoffMin(n) * 60000), ...(gaveUp ? { gave_up: true } : {}),
      });
    }
  }, { waitMs: 4000 });
  return result;
}

/**
 * One tick of the outlet: what is not sent yet (and whose backoff is over) goes out in order, while the
 * time budget lasts. Without a config a no-op without any file. Never throws because of the network.
 * `sender`/`config`/`ca`/`google` replace network and configuration (tests); `retry`: ignore backoff and "given up".
 * Returns `{ state: off | empty | good, sent, failures: [short code], open }`.
 */
export async function tick(root, { now = Date.now(), env = process.env, config = null, sender = null, ca = undefined, google = undefined, retry = false, budgetMs = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const c = config ?? readConfig(root, env);
  if (!c.active) return { state: 'off', sent: 0, failures: [], open: 0, reason: c.reason };
  if (!fs.existsSync(path.join(root, A.DIR, A.APPOINTMENTS_FILE))) return { state: 'empty', sent: 0, failures: [], open: 0 };
  const zone = A.zoneOf(root, env);
  const state = A.load(root);
  const journal = loadJournal(root);
  const { open } = dueList(state, journal, nowMs, c.route);
  const budget = budgetMs ?? (retry ? 5 * TICK_BUDGET_MS : TICK_BUDGET_MS);
  const start = Date.now();
  let sent = 0; const failures = [];
  for (const s of open) {
    if (Date.now() - start > budget) break;
    if (!ready(journal.per.get(s.key), nowMs, retry)) continue;
    const r = await deliver(root, c, zone, s, { nowMs, sender, manual: retry, ca, google });
    if (r.skipped) continue;
    if (r.ok) sent += 1; else failures.push(`${s.a.id} ${s.method} ${r.code}${r.status ? ` ${r.status}` : ''}`);
  }
  const rest = dueList(state, loadJournal(root), nowMs, c.route).open.length;
  return { state: 'good', sent, failures, open: rest };
}

/** A test invitation 20 minutes ahead to the recipient, at once and with a result (no backoff, not part of the due list). */
export async function sendTest(root, { now = Date.now(), env = process.env, config = null, sender = null, ca = undefined, google = undefined } = {}) {
  const c = config ?? readConfig(root, env);
  if (!c.active) throw new InviteError('config', `the calendar outlet is off: ${c.reason}`);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const zone = A.zoneOf(root, env);
  const atMs = Math.ceil((nowMs + 20 * 60000) / 60000) * 60000;
  const a = { id: `test${newId()}`, title: 'cheap-mem test appointment', text: 'If this appointment shows up in your calendar and reminds you beforehand, the route works. You can delete it.', atMs, repeat: null, beforeMin: null, private: false };
  const s = { key: keyOf(c.route, a.id, 0, 'REQUEST'), route: c.route, a, method: 'REQUEST', sequence: 0 };
  const r = await deliver(root, c, zone, s, { nowMs, sender, manual: true, ca, google });
  return { ...r, appointment: a.id, atMs, atText: tm.clockFor(zone).text(atMs) };
}

// --- Information: status and doctor ------------------------------------------------------------------

/**
 * The state for `mem appointment calendar status` and the doctor finding. No network, never the secret:
 * `{ active, reason, config, credential, sentTotal, lastSend, open: [...], gaveUp, broken }`.
 */
export function status(root, { now = Date.now(), env = process.env, config = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const c = config ?? readConfig(root, env);
  const journal = loadJournal(root);
  let open = [];
  if (c.active && fs.existsSync(path.join(root, A.DIR, A.APPOINTMENTS_FILE))) {
    open = dueList(A.load(root), journal, nowMs, c.route).open.map((s) => {
      const e = journal.per.get(s.key);
      return { appointment: s.a.id, method: s.method, sequence: s.sequence, attempts: e?.attempts ?? 0, gaveUp: e?.gaveUp === true, lastFailure: e?.lastFailure ?? null, next: e?.next ? A.iso(e.next) : null, since: e?.first ?? null };
    });
  }
  return {
    active: c.active, reason: c.reason,
    config: c.active ? { route: c.route, host: c.host, port: c.port, tls: c.tls, user: c.user, from: c.from, to: c.to, calendarId: c.calendarId, beforeMin: c.beforeMin } : null,
    credential: c.active ? credentialState(c) : null,
    sentTotal: journal.sentTotal, lastSend: journal.lastSend,
    open, gaveUp: open.filter((o) => o.gaveUp).length, broken: journal.broken,
  };
}
