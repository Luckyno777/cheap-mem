# Appointments: a calendar, reminders and scheduled agent actions

`mem appointment` is a small clock inside the memory. You (or an agent, as a
suggestion) plan something for a time; at that time the clock writes an ordinary
inbox letter. Three kinds:

| Kind | What happens at the time |
|---|---|
| **reminder** | a note to the human participant (Intent `information`, never wakes anyone) |
| **action** (`--wake <agent> --task "..."`) | a letter WITH the task to that agent (Intent `request`); the watcher wakes it |
| **briefing** (`--briefing`) | the day list "Today in the calendar" as a letter to the human, built by code, no model |

It ships empty: nothing exists until the first `mem appointment new`, and the
clock does nothing (no file, no process) until then.

## Quick start

```bash
mem appointment new --at "tomorrow 9:00" --title "Call the dentist" --remind-before 15m
mem appointment new --at "friday 3pm" --title "Check the backup" \
    --wake vm-admin --task "Check that last night's backup finished" --authority user
mem appointment new --at "weekdays 7:00" --briefing --authority user    # "Today in the calendar" every morning
mem appointment list          # the next 14 days;  --all: every appointment with its status
mem appointment today         # the day list;  --json for a machine (has `empty`)
mem appointment due           # dry run: what the clock would do NOW
mem appointment tick          # let the clock tick once (the watcher does this for you)
```

Other subcommands: `show <id>`, `cancel <id>`, `move <id> --at ...`,
`confirm <id> --authority user`, `cap [<n>] [--proposals]`, `calendar status|test|retry`.

## Time

Input and output use one zone: `timezone` in `.mem/config.json` (an IANA name such
as `Europe/Berlin`), else the environment `CHEAP_MEM_TZ`, else the system zone.
UTC is what is stored. An unknown zone name is refused, never replaced.

Accepted expressions (case does not matter):

```
2026-10-25 14:30        2026-10-25T14:30        2026-10-25T14:30:00Z   (a zone designator is exact)
oct 5 9am               5 october 2026 14:30    (no year: the next time)
today | tomorrow | day after tomorrow   [at] 14:30 | 2pm | noon
friday 3pm              next friday 9:00        (the next such day; today if the time is still ahead)
14:30 | 9am | at 9      (today, else tomorrow)
in 45 minutes | in 2 hours | in 3 days | in 1 week
daily 9:00 | weekdays 7:00 | every weekday 7:00 | weekly friday 15:00 | monthly 2026-11-01 9:00
```

A leading `daily | weekdays | weekly | monthly` also sets the repeat (so does
`--repeat`; saying two different ones is an error). `weekdays` is Monday to
Friday with **no holiday calendar**. Without a time of day, 09:00 applies and the
output says so. Anything not understood is refused: nothing is guessed.

Relative expressions count from `--relative-to <ISO>` (default: now). A session
that records a request it read in a transcript should pass the moment of the
user's line, not the moment it runs.

Clock changes: an ambiguous wall time (autumn, 02:30 exists twice) takes the
earlier one; a skipped one (spring) moves to the hour after. Repeats are
computed in wall time ("daily 09:00" stays 09:00 across the change). Monthly on
the 29th to 31st takes the last day of shorter months and keeps the anchor day
(Jan 31, Feb 28, Mar 31).

## Who may do what

The human is the participant marked `"human": true` in `.mem/config.json`; no name
is built in. A human action carries `--authority user`, the same claim as in
`mem inbox permit`: it is refused for a headless run (`MEM_HEADLESS`) and when the
process ceiling `CHEAP_MEM_MAX_AUTHORITY` is below `user`.

- A human's reminder is active at once. An **action** is armed only with
  `--authority user` (at creation, or later with `confirm`).
- What an agent creates is a **proposal** (`proposed`) and does nothing. A plain
  reminder an agent records together with the user's own sentence
  (`--requested-by user --quote "..."`, at most 200 characters, verbatim) is active
  at once; an action never becomes active that way.
- Only a human confirms, moves or cancels an armed appointment and sets a cap. An
  agent may cancel or move only its own proposal or its own plain reminder. A
  correction by anyone else is listed as `disputed` and changes nothing.
- A human's own planning is the permission for the action's one letter: the clock
  appends a single `grant` line for that letter to `inbox/permissions.jsonl`
  (`by: appointment:<id>`), so the watcher may wake the recipient without drawing on
  a budget. The woken agent gets **no extra rights**: the letter says so, and every
  house rule holds.

## Exactly once, late, and caps

- For each firing the clock writes an `intent` line, then the letter, then
  `delivered`, under a file lock. If a run dies in between, the next tick finds the
  letter through its request id (`appt-<intent id>`) and writes it only if it is
  missing. Two ticks at the same moment send one letter.
- After a pause (machine off), only the **latest** missed occurrence of a repeat
  fires, once, marked late, with the number skipped.
- Already past when entered: a reminder arrives once at once ("recorded late"); an
  action **never** fires, it counts as `missed` and the human gets a letter. The
  same holds for an action confirmed after its time.
- **Wake cap**: at most N agent wake-ups per calendar day (default 10,
  `mem appointment cap <n> --authority user`, stored with who/when/previous). The
  next one is held and the human gets a letter; if there is room again the same
  day it is caught up, on a later day it is not. Reminders and briefings do not
  count. The cap counts wake-ups, **not run time**: `--max-minutes` (default 30,
  at most 240) is only a time budget written into the letter, which this system
  cannot enforce.
- **Proposal cap**: an agent may make at most N proposals per day WITHOUT the
  user's quoted request (default 10, `cap <n> --proposals --authority user`). The
  next is not created, only counted, and one summary letter goes to the human
  after 20:00 (or the next day).
- The same title with a time within 10 minutes is a duplicate and is not created
  twice, whoever makes it.
- `--private` stores only "Private appointment", **no text**, and only that goes
  to an outside calendar. Nothing is guessed to be sensitive; a private
  appointment cannot wake an agent (the agent has to read the task).

## Where it runs

`bin/mem-watch` (and `mem-watch.ps1`) call `mem appointment tick` on every poll,
before the remote check. It is a no-op until `appointments/appointments.jsonl`
exists. Run it on **one** machine: two machines with the same clock would each
fire the same reminder (the `fired.jsonl` lines travel only with git).

| Environment | Meaning |
|---|---|
| `MEM_WATCH_APPOINTMENTS=off` | this machine's watcher does not tick |
| `MEM_WATCH_APPOINTMENTS_SYNC=1` | also commit and push what a tick wrote (`tick --sync`: only `appointments/` and `inbox/`), so the recipient's watcher on another machine sees the letter |

Without a watcher you can run `mem appointment tick` from cron or by hand. The
letters reach another machine like every message: commit and push.

Files (append-only, `*.jsonl` merges with `union`), under `appointments/`:
`appointments.jsonl`, `fired.jsonl`, `settings.jsonl`, and `invites.jsonl` when the
calendar outlet is on. The folder is deliberately not under `global/` or
`projects/`: the doctor measures findability there.

## Surfaces

- **CLI**: `mem appointment ...` (see above and `mem appointment --help`).
- **MCP**: `mem_appointment_new` (always a proposal, unless a quoted user request
  makes a plain reminder active), `mem_appointment_list` (read only; `today: true`
  for the day list), `mem_appointment_cancel` (own proposals only). A bridge is
  never a human: it cannot arm, confirm or set a cap. Under
  `CHEAP_MEM_MCP_READONLY=1` only the list remains.
- **Session start**: `appointment-today.sessionLine()` returns one line of at most
  160 bytes ("Today: 3 appointments, next 14:30 ...") and only while a briefing is
  active. It is not wired into a hook by default.
- **Dashboard**: Work & agents > Calendar (today, next days, proposals waiting for
  you with the confirm command, fired and unseen reminders, scheduled actions with
  their state, the cap, the calendar outlet) and the card "Today in the calendar"
  on the overview. Read only: `GET /dashboard/appointments.json`. Appointments are
  written with the CLI and the MCP tools, never from the page.
- **Doctor**: finding `appointment-invite` (see below).

The state of a fired action comes from the inbox, nothing new: `delivered`, `taken`
(a claim), `done` (claim done or the letter answered), `no-response` (untouched
after two hours), `claim-expired`.

## Calendar outlet: reminders in your own calendar

Optional. For every armed **reminder** (not an action, not a briefing, not a
proposal) the tick can also put an entry into a real calendar: an invitation when it
is created or confirmed, an update when it is moved (same UID, higher SEQUENCE),
a cancellation when it is cancelled. It is derived from the state, so an
appointment made on another machine or by an agent is handled the same way. Two
routes, switchable with one setting:

### Configuration (`.mem/config.json`)

```json
{
  "timezone": "Europe/Berlin",
  "calendar": {
    "route": "smtp",
    "remindBeforeMin": 15,
    "smtp":   { "host": "mail.example.org", "port": 465, "tls": "ssl",
                "user": "me@example.org", "from": "me@example.org", "to": "me@example.org",
                "passwordFile": "/home/me/.secrets/cm-smtp-password" },
    "google": { "calendarId": "me@example.org", "keyFile": "/home/me/.secrets/cm-calendar-key.json" }
  }
}
```

`route` is `smtp`, `google` or `off` (default: `google` when a calendar id is set,
else `smtp` when an SMTP user is set, else off). Every field also has an
environment switch that wins over the file: `CHEAP_MEM_CALENDAR_ROUTE`,
`CHEAP_MEM_CALENDAR_REMIND_MIN`, `CHEAP_MEM_SMTP_HOST|PORT|TLS|USER|FROM|TO|PASSWORD_FILE`,
`CHEAP_MEM_CALENDAR_ID`, `CHEAP_MEM_CALENDAR_KEY_FILE`. There are no defaults for a
host, an address or a provider. `tls` is `ssl` (port 465, the default), `starttls`
(587) or `plain` (**only** against the local machine, for tests).

**Secrets live only in files**, mode `0600` (a file with wider rights is refused
without any network access), given by absolute path. **Windows:** POSIX mode bits
mean nothing there (every file reads as 0666, `chmod` does nothing), so the rule
cannot be checked: sending stays allowed, but `credentialState()` carries a notice
and the doctor finding `appointment-invite` is `unknown`, never `good`. Protect the
file with NTFS ACLs yourself, e.g. `icacls <file> /inheritance:r /grant:r %USERNAME%:R`. They are never read from
an argument, never written to the journal, the status, the doctor or an error
message.

### Route `smtp`

The invitation is a mail with an iCalendar part (`METHOD:REQUEST` / `CANCEL`, an
`.ics` attachment too), RFC 5545: CRLF, lines folded at 75 octets, escaped text, a
`VTIMEZONE` for your zone (derived from Intl, any zone), `RRULE` for repeats, a
`VALARM` with the lead time, a stable `UID` (`<id>@cheap-mem`), `SEQUENCE` rising
with every change. It works with any mail server that offers AUTH PLAIN or LOGIN
(own client on `node:net` / `node:tls`, no dependency, SSL or STARTTLS).

**Microsoft 365 / Exchange Online: SMTP AUTH is often disabled** (off by default
for new tenants; "security defaults" turn it off). Where it is blocked, `smtp`
cannot log in; `mem appointment calendar status` then shows failures with the code
`auth`. The way for such a tenant is a Microsoft Graph route (calendar events over
HTTPS with an app registration). It is **not built yet**: it would be a third
entry in `OUTLETS` in `src/appointment-invite.mjs` with the same `send` shape.
Gmail and most other providers work with an app password in the password file.

Whether a calendar app files an invitation sent to its own address automatically
depends on the app; `mem appointment calendar test` shows what yours does.

### Route `google` (service account)

The Google Calendar API directly: a service account's key file (JSON), a JWT signed
RS256 with `node:crypto`, the token cached in memory only, `events.insert` / `patch` /
`delete` with a fixed event id derived from the appointment id (a 409 on insert
becomes a patch, a 404 on patch becomes an insert, a 404 or 410 on delete counts as
done). Setup on Google's side: enable the Calendar API in a project, create a
service account and a JSON key, and **share the calendar with the service account's
address** with the right "Make changes to events".

**Reminders on this route are set by the calendar's OWNER, not by the service
account.** Measured in lucky-mem on 2026-10-03: the event is sent with a popup
override, but Google keeps reminders per user. In the owner's view the event shows
"use default reminders" and the owner's own default notification of that calendar
applies. So the lead time is set by the owner in the Google Calendar settings of
that calendar; `--remind-before` per appointment does not act on this route (it
does on `smtp`, through the `VALARM`).

### Journal, retries, status

Every sending is recorded in `appointments/invites.jsonl` without content: a claim
(`attempt`), then `sent` or `failed` with a short code and the 3-digit status.
The key route|appointment|SEQUENCE|method means the same invitation never goes out
twice per route; switching the route announces existing future appointments once to
the new route. A failure backs off 1, 2, 4 ... 60 minutes; after 10 attempts it is
`given up` and only `mem appointment calendar retry` tries again. At-least-once, said
honestly: if a run dies between the server's acceptance and `sent`, the next tick
after two minutes sends once more with the same UID and SEQUENCE, which a calendar
treats as the same invitation.

```bash
mem appointment calendar status    # route, credential file rights, sent, open, given up (no network)
mem appointment calendar test      # a test appointment in 20 minutes; it is NOT deleted for you
mem appointment calendar retry     # send what is open now, ignoring backoff and "given up"
```

The doctor finding `appointment-invite` is good while the outlet is off or
healthy, a warning for open entries with failed attempts, an error for a
credential file with wrong rights, given-up entries, or failures older than six
hours.

## Limits, named

- No holiday calendar for `weekdays`. No time-zone-aware per-appointment zone: one
  zone per memory.
- A series is cancelled as a whole; a single occurrence cannot be skipped.
- The time budget (`--max-minutes`) is advice in a letter, not enforcement.
- A model-written briefing is not built (the briefing is code).
- Whether a watcher is running for the recipient is not measurable from the
  clock's machine: the letter is delivered; waking needs a watcher.
- The Microsoft Graph route is not built (see above).
- The calendar outlet was tested against fake servers (SMTP and the Google API)
  only; the first real `calendar test` is the real check.
