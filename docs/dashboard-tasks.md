# Long CLI work as tasks

**As of 2026-09-27.** `POST /task`, `GET /task.json`, `POST /task/cancel`
(`bin/mem-serve`) start, follow and end long-running CLI work as
tasks — progress where the command really reports one, a result
otherwise, and a real cancel. This is cheap-mem's mirror of Bauplan
E1.7; lucky-mem's original is `src/vorgaenge.mjs` (its commit
`d6880335`, section "E1.7 Datenvertrag Vorgaenge" in its own dashboard
coverage notes). `src/dashboard.mjs`, `src/pages.mjs` and every other
existing route were NOT touched for this.

## The inventory, checked against the source, not guessed

A task is a child process of an EXISTING CLI command — no second
export/verify code path invented alongside it. cheap-mem has exactly
two long-running CLI paths that fit what the plan asks for:

| Plan kind | Kind key | Real command | Found in |
|---|---|---|---|
| Export | `export` | `mem raw export --into <dir> --json` | `src/cli/commands/capture.mjs`, branch `sub === 'export'` |
| Deep integrity check | `integrity` | `mem chain --json` | `src/cli/commands/admin.mjs`, `chain:`; `src/chain.mjs:verifyChain()` |

**A third kind — an index rebuild — was looked for and left out,
on purpose, not silently dropped.** Three candidates exist in the CLI,
and none of them fits cleanly:

- `mem find "<query>" --fresh --json` forces `search.loadIndex()` to
  rebuild before it searches — but `find` also REQUIRES a query and
  returns THAT query's hits. Wiring "rebuild the index" through it
  would give this module a second job (an arbitrary search) it never
  asked for, and no query is neutral enough to stand for "none".
- `mem browse --fresh` has the same rebuild, but needs a terminal
  (interactive, no `--json`) — unusable headless, which is exactly
  what a server-started child process is.
- `mem embed backfill --force` genuinely rebuilds an index (the vector
  store `mem find-embed` reads), and needs neither a query nor a
  terminal. It was still left out: that store is OFF by default, needs
  optional dependencies (`better-sqlite3`, `sqlite-vec`) most installs
  do not have, and for most providers an API key. Calling it "the"
  index rebuild would suggest it refreshes the everyday BM25 search
  index everyone actually uses, which it does not touch at all.

`KINDS` in `src/tasks.mjs` therefore holds two entries, not three.
`mem doctor` was checked too (the plan text's other guess, mirroring
lucky-mem's own dead end with `mem doktor --tief`) and has no `--deep`
or comparable flag; it is a fast set of findings, not a long-running
scan.

## Progress: honestly absent, not invented

No CLI module in this codebase writes an intermediate progress line —
checked, not assumed: neither `raw export` nor `chain` reports one,
and no other module here does either (lucky-mem's counterpart,
`register-bau`'s `erzeugeMelder()`, has no equivalent on this side).
So `KINDS[*].progressPattern` is `null` for both kinds, and a running
task's state carries the literal string `'running (no progress
measurable)'` for its whole run — never an invented percentage, never
an interpolated bar. `src/tasks.mjs` still has the plumbing to record a
matched progress line, exercised nowhere today, so a future kind that
DOES report one does not need a second reading path built for it.

## The state file

Append-only, under `.mem/tasks/<id>.jsonl` (id: `[a-z0-9]{6,40}`, from a
timestamp plus random bytes, never from user input). `.mem/` is this
project's own established home for derived, per-machine state
(`search-index/`, `vectors.db`, `digest.log`, …); `mem init`/`mem hooks
install` now also add `.mem/tasks/` to the memory's own `.gitignore`
(`src/cli/githook.mjs`, `writeMemoryGitignore()`), the same way every
other derived directory there already is.

Four event kinds, in this possible order: `started` (once, with `pid`,
`serverEpoch`, the full command including its arguments), `progress`
(0..n — in practice always 0 today, see above), then exactly one of
`result` or `cancelled` (terminal). No writer ever rewrites a line; one
broken line does not drag the readable ones down with it — the same
reading rule every other `.jsonl` in this project already follows.

## The contract of `tasks.read()`

```
unknown (id never seen)       { state:'unknown', id, reason }                    -> 404
unknown (server restarted)    { state:'unknown', kind, started, running:'unknown',
                                 reason:'server restarted…' }                     -> 200
running                        { state:'ok', kind, started, running:true,
                                 progress }                                      -> 200
finished, nothing to flag      { state:'ok', …, running:false, result }          -> 200
finished, with a finding       { state:'warning', …, result, reason }            -> 200
cancelled                      { state:'ok', …, cancelled:true, reason }         -> 200
state file broken/unreadable   { state:'error', id, reason }                     -> 500
```

- `state:'unknown'` carries two different reasons, named rather than
  merged into one plain no: the id was never seen at all (HTTP 404 —
  a request error), OR the id is known but THIS server instance never
  started it itself (no terminal event, and the `serverEpoch` on the
  `started` line does not match the one running now) — then it stays
  HTTP 200 with `running:'unknown'`, because the id and its history ARE
  known, only the current run state is not any more.
- `state:'ok'` with `cancelled:true` is a deliberate classification: a
  cancel that really completed is not a system failure, it is a
  successful, requested action. `cancelled` sits next to it as its own
  field so a caller cannot confuse "finished" with "cancelled".
- `state:'warning'` covers two cases, the same rule lucky-mem's own
  `pruefung` classify uses: (a) the command itself reports a finding —
  `raw export` with `missing.length > 0`, `chain` with a broken seal OR
  no seal ever written at all (sealing needs `chainSealCadence` set,
  off by default — see `mem chain --help`); (b) the process finished
  successfully (exit 0) but produced no usable JSON for a documented
  reason — see the next section. Neither is `'error'` for a module
  whose job it is to report exactly this.
- `state:'error'` means: no usable JSON AND a nonzero exit code (a
  crash), or the state file itself has no `started` line or cannot be
  read at all.

## The quirk found while inventorying `raw export`

`mem raw export --into <dir> --json` prints its structured result
BEFORE checking `--json` only along the branch that has one — reading
`src/cli/commands/capture.mjs`, branch `sub === 'export'`:

```js
if (!hit.length) { out('No captures in that range.'); return; }
...
if (args.json) { out(JSON.stringify({ written, missing })); return; }
```

An empty range (a fresh memory, or a range with nothing captured in it)
returns BEFORE the `--json` check ever runs — exit 0, plain text, no
JSON at all. `test/tasks.test.mjs` has a probe naming this exact
outcome directly. `src/tasks.mjs`'s `classifyResult()` treats it the
same way lucky-mem treats the identical shape in its own export
command: exit 0 without JSON is `'warning'`, carrying the plain text as
the reason, never `'error'` for a process that ran cleanly through to
its own, honest end.

**A second, smaller inconsistency, also found while building this and
handled rather than worked around:** `raw export --json` prints one
COMPACT line; `chain --json` prints `JSON.stringify(verdict, null, 2)`
— pretty, multi-line. `lastJsonPayload()` in `src/tasks.mjs` tries the
WHOLE trimmed stdout as one JSON value first (covers both shapes, since
neither command writes anything else to stdout once `--json`
short-circuits it), and only falls back to a per-line scan from the end
if that fails.

## The lock, a restart, and a real cancel

**Per running server instance, not per kind forever.** At most one
task per kind runs at a time, tracked in an in-memory `Map` (`ACTIVE`)
rather than the state file — the file holds the history, the map holds
the live child handle a cancel needs. A second `start()` of a kind
already running throws `LOCK_ACTIVE` (`HTTP 409` over the route,
carrying the running id); the lock is free again the instant the
child's own `close` event fires, whatever the outcome.

**A server restart mid-task reads back `unknown`, never `running`
forever.** `SERVER_EPOCH` is created once per process start and written
into every `started` line. `read()` only says `running:true` when THIS
instance's `ACTIVE` map still holds that exact id AND its epoch matches
the one running now. After a restart `ACTIVE` is empty, so any task
that never reached a terminal line reads back `state:'unknown'`,
`running:'unknown'` — never `true` (nobody here is watching that
process any more) and never `false` either (nobody here saw it
actually finish).

**Cancel waits for a confirmed end.** Every child gets its own process
group on POSIX (`detached: true`, pgid = its own pid); `cancel()`
signals `-pid` (the whole group, so a grandchild the command itself
started is not left behind) with SIGTERM, waits with
`process.kill(pid, 0)` in a loop for the real end — no `pgrep`, no
trusting a service manager — and escalates to SIGKILL after 4 seconds.
On Windows, which has no POSIX process groups, `taskkill /pid <pid>
/t /f` ends the tree instead, and the same existence-check loop
follows (Node implements it with signal `0` on every platform). Only
once the child's OWN `close` event fires does `start()`'s handler write
the `cancelled` line — the proof is the process really being gone, not
`cancel()`'s own return value. `test/tasks.test.mjs` proves this with
`process.kill(pid, 0)` throwing `ESRCH` on the pid afterwards, over a
real, uncancelled-and-timed `mem chain` run made large enough to still
be mid-flight when the cancel arrives (calibrated in that file's own
comment).

## Children start without an inherited lock fd

cheap-mem's own lock helper (`mem_take_lock` in `bin/_portable.sh`,
used by `bin/mem-digest` and `bin/mem-watch`) claims fd 9 with `exec 9>
"$lock"` inside a bash process — a bash-opened fd carries no
close-on-exec flag by default, so if `mem-serve` were ever started
from underneath such a claim, fd 9 would otherwise travel into every
child this module spawns. `spawnChild()` in `src/tasks.mjs` does not
need lucky-mem's bash-wrapper fix for this: Node's own
`child_process.spawn` never hands a child any fd beyond what `stdio`
names, so its `stdio` array explicitly lists fds 3 through 9 as
`'ignore'` (bound to `/dev/null` instead of inherited) — closing the
one that matters, and a few either side of it for the same reason,
without touching `bin/_portable.sh` at all.

## The routes sit behind the write switch and the existing guards

`POST /task` and `POST /task/cancel` call `writegate.refusal()` — the
same single check `/setting` calls: first the dashboard write switch
(off by default since 2026-09-27; `"dashboard": { "allowWrites": true }`
in `.mem/config.json` or `mem serve --allow-writes`, see
`docs/dashboard-writes.md`), then `cfg.readonly` (403 under
`CHEAP_MEM_SERVE_READONLY=1`), then `webauth.hostAllowed`, then
`webauth.postOriginOk`. `GET /task.json` needs no origin check, like
`/entries.json`: it only reads. All three sit behind the same
token/loopback guard every other path in `PATHS` does, ahead of the
routing in `buildHandler`.

**History.** When E1.7 landed, the brief made a new opt-in flag
conditional on the server having no writing route yet; `/setting` was
already writable by default, so the task routes joined it under the
existing latches and no flag was added. On 2026-09-27 the owner decided
the other way for ALL writing routes at once: off by default, one switch.

## Belonging where they were spawned

`src/tasks.mjs` always spawns through `process.execPath` (`node
bin/mem raw export …`), never by executing `bin/mem` itself — the same
way this project's own tests already invoke it, and it happens to
sidestep the `noexec`-mount problem `bin/_portable.sh`'s header comment
documents for its own hooks: a file that may not be EXECUTED may still
be READ.

## On the desk: the "Long jobs" panel

The Settings tab of the desk (`/`) carries a **Long jobs** section
(`src/astra/tasks.mjs`, drawn inside `setView`): one card per kind with
its title, the command it runs, the latest task's state (`never
started`, `running`, `ok`, `warning`, `cancelled`, `no longer tracked`
after a server restart, `error`), its times and reason, and one no-JS
form — **Start**, or **Cancel** while one runs. The data is
`dashboard.collect()`'s `tasks` field, read through `tasks.overview()`;
`/pult.json` carries the same field.

The forms send `from=/`. With it, `/task` and `/task/cancel` answer a
success with `303 → /` and a refusal with a short HTML page; without it
(or with any other value — a closed list, like `/setting`'s) the JSON
contract above is unchanged. The page does not poll: it is a snapshot,
and a running card says "reload for the current state". With the write switch off, or under
`CHEAP_MEM_SERVE_READONLY=1`, every button is disabled and the panel says
so. It is a section, not a tab, so `dashboard.VIEWS` stays at seven.

## Probes

`test/tasks.test.mjs` (24 probes, real child processes, no mock):
the closed two-kind list; an unknown kind rejected before any child
starts; started → the state file provably grows → a result, for a
real, empty-memory `mem chain` run (`state:'warning'`, "no seal");
`raw export`'s empty-range quirk reproduced exactly; the lock up
immediately after `start()`, free again right after the end; two
different kinds running at once; a real `mem chain` run made large
enough to still be mid-flight, cancelled, and PROVEN dead
(`process.kill(pid, 0)` → `ESRCH`), with the lock free again
immediately after; `cancel()` with nothing active or an unknown kind;
`read()` with an unseen or malformed id; a simulated restart (a
hand-written foreign `serverEpoch`) reading back `unknown`/`running`,
never `ok`/`running:true`; `overview()` before anything ever started.

HTTP layer, same file: all three paths are in `PATHS`; a missing or
foreign Origin refuses `POST /task` and `POST /task/cancel` with no
child process starting; `CHEAP_MEM_SERVE_READONLY=1` refuses it too,
even with a valid origin; an unknown kind → 400 with the known list;
the full path `POST /task` → `GET /task.json?id=` to a result; an
unknown id → 404; `GET /task.json` with no id lists both kinds; two
starts of the same kind back to back → the second gets 409 with the
running id; `POST /task/cancel` with nothing running → 409, no crash.

Panel, `test/astra-tasks.test.mjs`: `collect()` carries both kinds with
titles from `KINDS`; the Settings section shows a card and a start form
per kind, no cancel form when nothing runs; a finished `warning` shows
state, end time and reason; a foreign-epoch task reads "no longer
tracked"; read-only disables every button; no sibling-project names in
the panel; a form POST with `from=/` gets 303, a refused one HTML, and
any other `from` keeps the 201 JSON answer.
