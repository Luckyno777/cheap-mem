// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * cli/appointments — what `mem appointment <sub>` does and prints.
 *
 * The handler in `src/cli/commands/agents.mjs` is thin (flag check, help, root);
 * the calendar's logic is in `appointments.mjs`, `appointment-clock.mjs`,
 * `appointment-today.mjs` and `appointment-invite.mjs`. This file is only the
 * words around them: parsing the switches and printing, in one place so the
 * handler stays short.
 */
import { execFileSync } from 'node:child_process';
import * as memory from '../memory.mjs';
import { out, die, warn, numberFlag } from './shell.mjs';
import * as A from '../appointments.mjs';
import * as clockMod from '../appointment-clock.mjs';
import * as todayMod from '../appointment-today.mjs';
import * as invite from '../appointment-invite.mjs';
import * as tm from '../appointment-time.mjs';

/** Switches each subcommand accepts (the handler hands this to `checkFlags`). */
export const FLAGS = Object.freeze({
  new: ['at', 'title', 'text', 'repeat', 'remind-before', 'wake', 'task', 'max-minutes', 'briefing', 'relative-to',
    'authority', 'private', 'source', 'requested-by', 'quote', 'json'],
  list: ['from', 'to', 'all', 'json'],
  show: ['json'],
  cancel: ['why', 'authority', 'json'],
  move: ['at', 'relative-to', 'authority', 'json'],
  confirm: ['authority', 'json'],
  due: ['json'],
  tick: ['json', 'sync'],
  cap: ['proposals', 'authority', 'json'],
  today: ['date', 'json'],
  calendar: ['json'],
});

export const SUBCOMMANDS = Object.freeze(Object.keys(FLAGS));

export const HELP = [
  'mem appointment new --at "<time>" --title "..." [--text "..."] [--repeat daily|weekly|monthly|weekdays]',
  '                    [--remind-before 15m] [--wake <agent> --task "..." [--max-minutes 30]] [--briefing]',
  '                    [--relative-to <ISO>] [--authority user] [--private] [--requested-by user --quote "..."] [--json]',
  'mem appointment list [--from <time> --to <time>] [--all] [--json]',
  'mem appointment show <id> [--json]',
  'mem appointment cancel <id> [--why "..."] [--authority user]',
  'mem appointment move <id> --at "<time>" [--authority user]',
  'mem appointment confirm <id> --authority user      (only a human: arms an agent\'s proposal)',
  'mem appointment due [--json]                       (dry run: what the clock would do NOW)',
  'mem appointment tick [--sync] [--json]             (let the clock tick once; mem-watch does this on every poll; --sync: commit and push what it wrote)',
  'mem appointment cap [<n> [--proposals] --authority user]  (agent wake-ups per day, default 10; --proposals: agent proposals without the user\'s request per day, default 10)',
  'mem appointment today [--date YYYY-MM-DD] [--json]  (the day list "Today in the calendar", no model; --json: machine-readable with `empty`)',
  'mem appointment calendar status|test|retry [--json]  (invitations into your calendar, route smtp|google: state without network | a test appointment in 20 min | send what is open now)',
  '',
  '  Time: the zone of .mem/config.json "timezone" (else CHEAP_MEM_TZ, else the system zone) for input and output; UTC is stored.',
  '        Examples: "tomorrow 9:00", "friday 3pm", "2026-10-25 14:30", "oct 5 9am", "in 2 hours", "14:30",',
  '        "weekdays 7:00" (a leading daily|weekdays|weekly|monthly sets the repeat; weekdays = Mon-Fri, no holiday calendar).',
  '        Relative expressions count from --relative-to (default: now) - a session that reads a conversation later passes the moment of the user\'s line.',
  '  Three kinds: reminder (a letter to the human participant + banner), scheduled action (--wake: a letter with the task to the agent;',
  '        the watcher wakes it), and --briefing (the day list as a letter). Only a HUMAN (--authority user) arms an action;',
  '        what an agent creates stays `proposed` until `confirm`.',
  '  Private: --private stores only "Private appointment", no text (nothing is guessed to be sensitive).',
  '  Already past when entered: a reminder arrives once at once ("recorded late"), an action never fires (missed).',
  '  The same thing twice (same title, time within 10 min) is not created twice.',
].join('\n');

const bool = (v) => v === true;
const one = (args, k) => (args[k] === undefined || args[k] === true ? null : String(args[k]));

function toTime(root, args, sub, key, base) {
  const text = one(args, key);
  if (!text) die(`appointment ${sub}: --${key} is missing (e.g. --${key} "tomorrow 9:00")`);
  const zone = A.zoneOf(root);
  const r = tm.parse(text, { now: base, zone });
  if (!r) {
    die(`appointment ${sub}: no time recognised in '${text}'. Examples: "tomorrow 9:00", "friday 3pm", "2026-10-25 14:30", `
      + '"oct 5 9am", "in 2 hours", "14:30".');
  }
  return r;
}

function referenceTime(args) {
  if (args['relative-to'] === undefined) return Date.now();
  const ms = Date.parse(String(args['relative-to']));
  if (!Number.isFinite(ms)) die(`appointment: --relative-to '${args['relative-to']}' is not an ISO time (e.g. 2026-10-02T08:30:00Z)`);
  return ms;
}

function catchFail(sub, fn) {
  try { return fn(); } catch (e) {
    if (e && e.name === 'AppointmentError') die(`appointment ${sub}: ${e.message}`);
    throw e;
  }
}

const json = (o) => out(JSON.stringify(o, null, 2));

/**
 * `tick --sync`: commit and push what a tick wrote (letters, the fired log, the grant), nothing else.
 * Only the two folders the clock writes to; a rejected push is reported and retried by the next tick.
 */
function syncTick(root) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (!git('status', '--porcelain', '--', A.DIR, 'inbox').trim()) return 'nothing to sync';
    git('add', '--', A.DIR, 'inbox');
    git('commit', '-q', '-m', 'appointments: clock tick', '--', A.DIR, 'inbox');
    git('push', '-q');
    return 'synced';
  } catch (e) {
    return `sync failed: ${String(e.stderr || e.message).split('\n')[0]}`;
  }
}

/** Run one subcommand. `rest` is what follows the subcommand name. */
export async function run(sub, { root, args, rest }) {
  const me = memory.agentDefault();
  const actor = () => A.actorFrom({ name: me, authority: one(args, 'authority') });
  const now = Date.now();

  if (sub === 'new') {
    const base = referenceTime(args);
    const z = toTime(root, args, 'new', 'at', base);
    let repeat = one(args, 'repeat');
    if (repeat === null) repeat = z.repeat ?? null;
    else if (z.repeat && z.repeat !== repeat) die(`appointment new: --at says '${z.repeat}' but --repeat says '${repeat}' - give one of them.`);
    let before = null;
    if (args['remind-before'] !== undefined) {
      before = tm.durationMinutes(String(args['remind-before']));
      if (before === null) die('appointment new: --remind-before is a duration like 15m, 2h, 1d (1 minute to 30 days)');
    }
    const minutes = args['max-minutes'] === undefined ? null : numberFlag('max-minutes', args['max-minutes'], { min: 1, max: 240 });
    const who = actor();
    const quote = one(args, 'quote');
    const requestedBy = one(args, 'requested-by');
    if (requestedBy !== null && requestedBy !== 'user') die("appointment new: --requested-by is only 'user'");
    if (quote && !requestedBy) die('appointment new: --quote needs --requested-by user');
    const wish = requestedBy ? { by: 'user', quote: quote ?? '' } : null;
    const r = catchFail('new', () => A.create(root, {
      title: one(args, 'title') ?? '', text: one(args, 'text') ?? '', atMs: z.ms, repeat, beforeMin: before,
      wake: one(args, 'wake'), task: one(args, 'task'), maxMinutes: minutes, kind: bool(args.briefing) ? 'briefing' : 'reminder',
      source: one(args, 'source') ?? 'cli', requestedBy: wish,
      // An agent without the user's quoted request makes even a reminder only a proposal ("waiting for you").
      reminderActive: Boolean(wish) || who.human || me.startsWith('human:'),
      isPrivate: bool(args.private), actor: who, now,
    }));
    const clock = tm.clockFor(A.zoneOf(root));
    if (r.dropped) {
      if (args.json) { json({ id: null, status: 'dropped', dropped: true, duplicate: false, warnings: r.warnings }); return; }
      out('NOT created: daily limit for proposals reached.');
      for (const w of r.warnings) warn(w);
      return;
    }
    if (args.json) { json({ id: r.id, status: r.status, duplicate: r.duplicate, at: new Date(z.ms).toISOString(), atText: clock.text(z.ms), repeat, warnings: r.warnings }); return; }
    if (r.duplicate) {
      out(`Already there: appointment ${r.id} (${r.status}) - nothing created.`);
      for (const w of r.warnings) warn(w);
      return;
    }
    out(`Appointment ${r.id} created: ${clock.text(z.ms)}${repeat ? ` (${repeat})` : ''}${z.defaultTime ? '  (no time of day: 09:00 assumed)' : ''}  [${r.status}]`);
    for (const w of r.warnings) warn(w);
    if (r.status === 'proposed') {
      out(`  Does nothing until a human confirms: mem appointment confirm ${r.id} --authority user${who.human ? '' : `  (${who.reason})`}`);
    }
    return;
  }

  if (sub === 'list') {
    const zone = A.zoneOf(root);
    const clock = tm.clockFor(zone);
    const stamp = (k, fallback) => {
      if (args[k] === undefined) return fallback;
      const r = tm.parse(String(args[k]), { now, zone });
      if (!r) die(`appointment list: --${k} '${args[k]}' is not a time`);
      return r.ms;
    };
    const from = stamp('from', clock.dayStart(now, 0));
    const to = stamp('to', clock.dayStart(now, 14));
    if (!(from < to)) die('appointment list: --from must be before --to');
    const v = todayMod.overview(root, { now, fromMs: from, toMs: to });
    if (args.json) { json(args.all ? v : { ...v, appointments: undefined }); return; }
    if (!v.appointments.length) { out('No appointments. Create one: mem appointment new --at "tomorrow 9:00" --title "..."'); return; }
    if (args.all) {
      for (const a of v.appointments) out(`  ${todayMod.shortLine(a)}`);
      out(`${v.appointments.length} appointment(s) in all, ${v.proposed} proposed (waiting for a human).`);
      return;
    }
    out(`Occurrences ${clock.text(from)} to ${clock.text(to)}:`);
    for (const o of v.occurrences) out(`  ${o.text}  ${o.title}  [${o.id}${o.wake ? `, wakes ${o.wake}` : ''}${o.kind === 'briefing' ? ', briefing' : ''}${o.status !== 'active' ? `, ${o.status}` : ''}]`);
    if (!v.occurrences.length) out('  (none)');
    if (v.proposed) out(`${v.proposed} proposal(s) wait for a human: mem appointment list --all`);
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) die('appointment show: which id? mem appointment show <id>');
    const v = todayMod.overview(root, { now });
    const a = v.appointments.find((x) => x.id === id);
    if (!a) die(`appointment show: '${id}' does not exist. List them: mem appointment list --all`);
    const state = A.load(root);
    const fired = state.intents.filter((x) => x.appointment === id);
    if (args.json) { json({ appointment: a, fired, actions: v.actions.filter((x) => x.appointment === id) }); return; }
    out(todayMod.shortLine(a));
    if (a.text) out(`  Text: ${a.text}`);
    if (a.task) out(`  Task: ${a.task}`);
    out(`  Created by ${a.by ?? '?'} (${a.source ?? '?'})${a.armedBy ? `, armed by ${a.armedBy}` : ''}${a.quote ? `, quote: "${a.quote}"` : ''}`);
    for (const f of fired) out(`  fired ${f.ts}: ${f.outcome}${f.late ? ' (late)' : ''} [${f.stage}]`);
    for (const x of v.actions.filter((y) => y.appointment === id)) out(`  state ${x.when}: ${x.state}${x.letter ? `  (${x.letter})` : ''}`);
    return;
  }

  if (sub === 'cancel') {
    const id = rest[0];
    if (!id) die('appointment cancel: which id? mem appointment cancel <id>');
    const r = catchFail('cancel', () => A.cancel(root, id, { actor: actor(), why: one(args, 'why'), now }));
    if (args.json) json(r); else out(r.already ? `Appointment ${id} was already cancelled.` : `Appointment ${id} cancelled.`);
    return;
  }

  if (sub === 'move') {
    const id = rest[0];
    if (!id) die('appointment move: which id? mem appointment move <id> --at "..."');
    const z = toTime(root, args, 'move', 'at', referenceTime(args));
    const r = catchFail('move', () => A.move(root, id, { atMs: z.ms, actor: actor(), now }));
    const text = tm.clockFor(A.zoneOf(root)).text(z.ms);
    if (args.json) json({ id: r.id, at: new Date(z.ms).toISOString(), atText: text }); else out(`Appointment ${id} moved to ${text}.`);
    return;
  }

  if (sub === 'confirm') {
    const id = rest[0];
    if (!id) die('appointment confirm: which id? mem appointment confirm <id> --authority user');
    const r = catchFail('confirm', () => A.confirm(root, id, { actor: actor(), now }));
    if (args.json) json(r); else out(r.already ? `Appointment ${id} was already armed.` : `Appointment ${id} armed.`);
    return;
  }

  if (sub === 'due') {
    const zone = A.zoneOf(root);
    const clock = tm.clockFor(zone);
    const state = A.load(root);
    const p = A.plan(state, now, { zone });
    const rows = p.entries.map((e) => ({
      appointment: e.item.id, title: e.item.title, action: e.action, stage: e.stage, occurrence: new Date(e.occurrenceMs).toISOString(),
      occurrenceText: clock.text(e.occurrenceMs), late: e.late === true, skipped: e.skipped || 0, afterCap: e.afterCap === true,
    }));
    if (args.json) { json({ entries: rows, cap: p.cap, today: p.today }); return; }
    if (!rows.length) out('Nothing is due.');
    for (const z of rows) out(`  ${z.action.padEnd(14)} ${z.occurrenceText}  ${z.title}  [${z.appointment}, ${z.stage}${z.late ? ', late' : ''}${z.skipped ? `, ${z.skipped} skipped` : ''}${z.afterCap ? ', after cap' : ''}]`);
    out(`Cap: ${p.cap.value} wake-ups per day, ${p.today} so far today. (Dry run - nothing written; carry it out: mem appointment tick)`);
    return;
  }

  if (sub === 'tick') {
    const r = clockMod.tick(root, { now });
    const mail = await invite.tick(root, { now });
    const synced = args.sync === true && r.state !== 'empty' ? syncTick(root) : null;
    if (args.json) { json({ clock: r, calendar: mail, ...(synced ? { sync: synced } : {}) }); return; }
    if (synced) out(`Sync: ${synced}.`);
    if (r.state === 'empty') out(`No appointments (${A.DIR}/ does not exist).`);
    else {
      for (const a of r.fired) out(`  ${a.outcome}${a.late ? ' (late)' : ''}  ${a.title}  [${a.appointment ?? '-'}]${a.skipped ? `  ${a.skipped} skipped` : ''}`);
      out(`${r.fired.length} fired, ${r.repaired} repaired.`);
    }
    for (const f of r.errors) warn(f);
    if (r.state === 'locked') warn('Lock held (another tick is running) - nothing done.');
    if (mail.state === 'good') out(`Calendar: ${mail.sent} entry/entries sent, ${mail.open} open.`);
    for (const f of mail.failures) warn(`Calendar: ${f}`);
    return;
  }

  if (sub === 'calendar') {
    const what = rest[0];
    if (what === 'status') {
      const st = invite.status(root, { now });
      if (args.json) { json(st); return; }
      if (!st.active) { out(`Calendar outlet: OFF (${st.reason}).`); out('Set it up: docs/appointments.md, section "Calendar outlet".'); return; }
      const c = st.config;
      out(c.route === 'google'
        ? `Calendar outlet: ON (route google, calendar ${c.calendarId}, reminder ${c.beforeMin} min before - on this route the calendar owner's own default applies).`
        : `Calendar outlet: ON (route smtp, ${c.host}:${c.port} ${c.tls}, from ${c.from}, to ${c.to}, reminder ${c.beforeMin} min before).`);
      out(`${c.route === 'google' ? 'Key file' : 'Password file'}: ${st.credential.ok ? 'ok (permissions 600)' : `PROBLEM: ${st.credential.reason}`}.`);
      out(`Sent in all: ${st.sentTotal}${st.lastSend ? `, last ${st.lastSend}` : ''}. Open: ${st.open.length}, given up: ${st.gaveUp}.`);
      for (const o of st.open) out(`  open ${o.appointment} ${o.method} seq ${o.sequence}: ${o.attempts} attempt(s)${o.lastFailure ? `, last failure ${o.lastFailure.code}${o.lastFailure.status ? ` ${o.lastFailure.status}` : ''}` : ''}${o.gaveUp ? ', GIVEN UP (mem appointment calendar retry)' : (o.next ? `, next attempt ${o.next}` : '')}`);
      if (st.broken) warn(`${st.broken} broken journal line(s) in ${A.DIR}/${invite.JOURNAL_FILE}`);
      return;
    }
    if (what === 'test') {
      try {
        const r = await invite.sendTest(root, { now });
        if (args.json) { json(r); return; }
        if (r.ok) out(`Test appointment sent (${r.appointment}, ${r.atText}). Check the calendar: is it there, and does it remind beforehand? It is not deleted automatically.`);
        else die(`appointment calendar test: sending failed (${r.code}${r.status ? ` ${r.status}` : ''}). State: mem appointment calendar status`);
      } catch (e) {
        if (e && e.name === 'InviteError') die(`appointment calendar test: ${e.message}`);
        throw e;
      }
      return;
    }
    if (what === 'retry') {
      const r = await invite.tick(root, { now, retry: true });
      if (args.json) { json(r); return; }
      if (r.state === 'off') { out(`The calendar outlet is off (${r.reason}).`); return; }
      out(`${r.sent} sent, ${r.failures.length} failed, ${r.open} still open.`);
      for (const f of r.failures) warn(f);
      return;
    }
    die('appointment calendar: status | test | retry');
  }

  if (sub === 'cap') {
    const proposals = bool(args.proposals);
    const key = proposals ? 'proposals' : 'wake';
    const state = A.load(root);
    const zone = A.zoneOf(root);
    if (rest[0] === undefined) {
      const wakes = A.wakesToday(state, now, zone);
      const dropped = A.droppedToday(state, now, zone);
      const pc = state.proposalCap;
      if (args.json) { json(proposals ? { ...pc, dropped } : { ...state.cap, today: wakes, proposals: { ...pc, dropped } }); return; }
      const how = (c) => (c.source === 'default' ? 'default' : `set by ${c.by} on ${c.ts}`);
      if (!proposals) {
        out(`Cap: ${state.cap.value} agent wake-ups per day (${how(state.cap)}), ${wakes} so far today.`);
        out('Reminders and briefings do not count. Change it (only a human): mem appointment cap <n> --authority user');
      }
      out(`Proposal cap: ${pc.value} agent proposals without the user's request per day (${how(pc)}), ${dropped} dropped today.`);
      out("The user's own reminders and anything with a quoted user request do not count. Change it (only a human): mem appointment cap <n> --proposals --authority user");
      return;
    }
    const line = catchFail('cap', () => A.setCap(root, rest[0], { actor: actor(), now, key }));
    if (args.json) json(line); else out(`${proposals ? 'Proposal cap' : 'Cap'}: ${line.previous} -> ${line.value} ${proposals ? 'proposals' : 'wake-ups'} per day (${line.by}, ${line.ts}).`);
    return;
  }

  if (sub === 'today') {
    let at = now;
    if (args.date !== undefined) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(args.date));
      if (!m) die('appointment today: --date is YYYY-MM-DD (e.g. 2026-10-05)');
      const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (t.getUTCFullYear() !== +m[1] || t.getUTCMonth() !== +m[2] - 1 || t.getUTCDate() !== +m[3]) die(`appointment today: '${args.date}' is not a date`);
      at = tm.clockFor(A.zoneOf(root)).wallToUtc(+m[1], +m[2], +m[3], 12, 0);
    }
    const h = todayMod.today(root, { now: at });
    if (args.json) {
      const st = A.load(root);
      json(todayMod.machine(h, { cap: { value: st.cap.value, today: A.wakesToday(st, at, h.zone) } }));
      return;
    }
    out(todayMod.briefingText(h));
    return;
  }

  die(`appointment: unknown subcommand '${sub}'. Known: ${SUBCOMMANDS.join(', ')}.`);
}
