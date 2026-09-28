# Dashboard writes — off until you turn them on

`mem serve` shows the dashboard at one link (`docs/dashboard.md`). A
few things on it can also CHANGE something: a setting, or a
long job started or cancelled. Since 2026-09-27 **all of them are off by
default.** An open-source dashboard writes nothing before its owner
allows it.

## Turning it on

Two ways, and only these two:

| Where | What | How long |
|---|---|---|
| `.mem/config.json` | `"dashboard": { "allowWrites": true }` | for this memory, until you remove it |
| command line | `mem serve --allow-writes` | this run only — nothing is written down |

```json
{
  "version": 1,
  "participants": {
    "user": { "role": "The human.", "human": true },
    "session": "..."
  },
  "dashboard": { "allowWrites": true }
}
```

The config is read on every request, so editing the file takes effect
without a restart. `--allow-writes` takes no value; `--allow-writes foo`
is refused rather than guessed at.

**The dashboard cannot turn itself on.** `/setting` accepts only the
closed list in `src/console.mjs` (`SETTINGS`), and none of those touches
`.mem/config.json`; the flag lives in the server process. A switch that
the page it guards could flip would be decoration. `test/writegate.test.mjs`
posts every known setting id plus `dashboard.allowWrites` and friends
and checks that `.mem/config.json` is byte-for-byte unchanged.

## What it covers

Every writing route of `bin/mem-serve` — the inventory, pinned by the
exported `WRITE_PATHS` list and a probe that counts body readers against
gate calls:

| Route | What it writes |
|---|---|
| `POST /setting` | one knob from `SETTINGS` (raw archive location, error window, agent quiet limit) plus a line in `.mem/console-log.jsonl` |
| `POST /task` | starts a long CLI job (`raw export`, `chain`, `raw delete`, `done`) as a child process, with a closed list of parameters per kind; state under `.mem/` |
| `POST /task/cancel` | ends one |
| `POST /inbox/reply` | one new message in `inbox/`, answering a message in the human participant's tray — the same `inbox.write()` `mem inbox write` calls (P1b) |
| `POST /inbox/state` | acknowledges one message addressed to the human participant — nobody else's |
| `POST /dashboard/verify-verdict` | a human's verdict on one Today-card "to verify" candidate — one line appended OUTSIDE the memory root (`src/verifylog.mjs`, `CHEAP_MEM_VERIFY_FILE` or `~/.cheap-mem-verify/facts-verdict.jsonl`), never a write inside this repository (N9 parity) |

Every other path (`/`, `/dashboard`, `/pult`, the `.json` routes, the
retrieval probe) only reads. `/console` and `/viewer` only redirect.

With the switch off each of them answers **403**, names the reason and
says how to turn it on. Nothing is written — the probe snapshots every
file of the memory before and after.

The older latches stay, in this order behind the switch:
`CHEAP_MEM_SERVE_READONLY=1` (wins over everything, including
`--allow-writes`), the Host check, the Origin check. Token and bind rules
are unchanged.

## Four states, not two

`src/writegate.mjs` `read()` answers one of:

| State | When | Writes? |
|---|---|---|
| `on` | `--allow-writes`, or `allowWrites: true` | yes |
| `off` | the default (key absent, or no config file), `allowWrites: false`, or read-only mode | no |
| `unknown` | the key holds something else (`"yes"`, `1`, `"true"`) | no |
| `error` | `.mem/config.json` exists but cannot be read or parsed | no |

Only `on` lets a write through, but the page and the 403 say WHICH of
the other three it is: a config that cannot be read is shown as "could
not be read", never as a plain "off". `/console.json` and
`/pult.json` carry the same object as `writes`; `mem serve` prints
it on start.

## On the pages

With the switch not `on`, the console's and the desk's Settings forms and
the Long-jobs Start/Cancel buttons and the reply form under each message
in the Agents tab's inbox are rendered `disabled`, and a note names the
way to turn writing on. No script is involved — the server
decides what it renders.

## For new writing routes

Call `writegate.refusal(root, cfg, req)` before reading the body and add
the path to `WRITE_PATHS`. One function, not a copy per route: replying
from the inbox (P1b, below) was the first route added this way.

## Replying from the inbox (P1b)

The Agents tab shows the human participant's tray — whichever entry in
`participants` (`.mem/config.json`) carries `"human": true`, never a
hardcoded key. A config with none marked (or more than one) reports
that honestly instead of guessing; see `humanParticipant()` in
`src/config.mjs`. Under each message is a small form: a text box and
**Reply**. It posts to `/inbox/reply` with only the message's file name
and the text.

- **Same write as the CLI.** `inbox.reply()` reads the original, turns
  its header around (from its recipient, to its sender, subject
  `Re: <original>`, never `Re: Re:`) and calls `inbox.write()` — the
  call `mem inbox write` makes. Same file name scheme, same header,
  same body. `test/inbox-reply.test.mjs` writes the same reply through
  the CLI and compares the two files.
- **Nothing is delivered by the page.** Like the CLI, it writes the
  file and stops; delivery is still `git add`, `commit`, `push`.
- **The original is left alone.** Marking it `replied` stays a separate
  step (`mem inbox ack <name>`).
- **Nobody speaks for someone else.** No form field picks the sender or
  the recipient. A message not addressed to the human participant, a
  path instead of a name, or an empty text answers 400 and writes
  nothing.
- After a successful reply the server answers 303 back to the desk, so
  a reload does not send it twice.

## Migrating

If you used the console to set things before 2026-09-27: after updating,
the forms are disabled until you add `"dashboard": { "allowWrites": true }`
to `.mem/config.json` or start with `mem serve --allow-writes`.
