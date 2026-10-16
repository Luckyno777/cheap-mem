# The dashboard

`mem serve` shows one page: the dashboard. Since 2026-09-28 it is
cheap-mem's only UI. It is the sibling house's dashboard (lucky-mem),
functionally and visually the same. It differs in three ways only: it is
in English, it carries cheap-mem's own mark (the C), and a fresh install
starts with an empty store.

```bash
mem serve                 # http://127.0.0.1:8847/  (the password login is the door)
mem serve --allow-writes  # allow the page to write, for this run only
```

## Routes

| Route | What |
|---|---|
| `/`, `/dashboard` | the page |
| `/pult`, `/pult.json` | 308 to `/dashboard` and `/desk.json` (old German names, kept for bookmarks) |
| `/dashboard.json` | everything the views show, collected live (gzip when asked) |
| `/dashboard/part.json?part=` | what the first answer leaves out: `inbox`, `raw`, `experiences` as lists; `entries` page by page (`&from=&n=`, at most 5000 a page); `atlas` (compact build only): the entries of a topic or drawer, 60 at a time (`&theme=` or `&drawer=project/type`, `&project=`, `&from=&n=`) |
| `/dashboard/entry.json?id=` | one entry, whole |
| `/dashboard/message.json?id=` | one inbox message, whole |
| `/dashboard/probe.json` | the retrieval probe: what `mem retrieve` would inject for a question. It is read-only and never logged |
| `/dashboard/facts-at.json?known=&valid=` | the bitemporal comparison (Knowledge / Facts) |
| `/dashboard/project-package.json?project=&global=&history=` | the project package export (Sources / Export studio); `&format=html` gives the offline reading view as one file; `&preview=1` the selection only |
| `/dashboard/skills.json` | the skill catalogue, read-only (a status is written only through a task) |
| `/dashboard/appointments.json` | the calendar overview behind the Today card and the calendar tab (`docs/appointments.md`) |
| `/api/fulltext` | full-text search of the knowledge view, read-only |
| `/entries.json`, `/entries` | one cursor page of entries, as JSON or rendered by the server (`docs/dashboard-entries-list.md`) |
| `/entry.json?id=` | one entry through the fast path (`docs/dashboard-single-entry.md`) |
| `/health` | liveness only, reveals nothing |
| `/console.json`, `/desk.json` | the console's and the board's numbers, for tools |
| `/console`, `/viewer` | 303 into the dashboard (`#settings/system`, `#knowledge/entries`) |
| `/manifest.webmanifest`, `/sw.js`, `/favicon.ico` | the installable shell (PWA) |

Writing routes and their switch: `docs/dashboard-writes.md`.

## How fast the first page is (since 2026-10-02)

The first answer of `/dashboard.json` is a small **head**, whatever the size
of the store: the newest 120 entries (plus the open duties and questions the
start page names), the counters (`overview`: per type and project, computed on
the server) and the paths of the parts that follow. The rest of the entries
arrives page by page (`/dashboard/part.json?part=entries&from=&n=`) from the
same build; the page shows "x of y entries loaded" until it is whole, and
takes its counters from the server's `overview`, never from the part it has.
A part that is not built yet answers `building` and is never shown as an
empty list.

- **After a restart** the head from the last run answers at once (`cache.source:
  "disk"`, never fresh, with its reason) while the server rebuilds. It lies in
  `.mem/dashboard-head.json` (0600 on POSIX; **on Windows POSIX modes mean nothing and cannot be checked**, so the head relies on carrying no decrypted text, and NTFS ACLs of the profile do the rest; written atomically, machine-local, not in
  git) and holds no `text`, `fact` or `why` of any entry: the dashboard decrypts
  locked entries in memory only, and decrypted content never reaches the disk.
- **A large store without a head on disk** gets a placeholder first (state
  unknown, no invented figure), then within seconds a light head (counters and
  newest titles, one pass over the drawers, bounded memory), then the full build.
- **Above 64 MB of drawers** (`CHEAP_MEM_SERVE_FULL_BUILD_MB` changes the line)
  the full build does not run. The **compact build** runs instead (it replaced
  the light head there; the light head stays only as the quick first state of a
  store the full build still handles):
  - **One pass** over the drawers (`src/dashboard-pass.mjs`) feeds the line
    total, the counters per type and project, the net (boxes, box pairs, links,
    dangling), the open questions, the agents, the projects and the newest
    entries (30,000, `CHEAP_MEM_SERVE_WINDOW_ENTRIES`). It keeps counters,
    bounded lists and a fingerprint table of about 14 bytes an entry — no entry
    list. A drawer with retiring or correcting lines is read a second time,
    only for those lines and their targets. The same `collectDashboard()` as
    the full build builds the rest of the answer, so every view that does not
    need the whole store works unchanged. Entries carry no free text there;
    citation counts, contested marks and derived links are not computed.
  - **The 3D atlas is condensed**: the 240 largest topics (tags), every drawer
    with its counter, the strongest 600 topic pairs, fixed size, no free text,
    in the head on disk too. The entries of a topic or a drawer come when the
    page zooms in: the newest 60 at once, "Load 60 more" for the next 60, from
    the sample of the pass, the window of the newest entries, or beyond them a
    search in the build worker (the page says "searching", never an empty
    list). An entry counts in every topic it carries.
  - **Modules that read the whole store themselves** (integrity scan, duties,
    facts, topics, learnings) run up to 128 MB of drawers; above, each is
    "unknown" with the reason. The doctor and the today card read the store
    several times and never run in the compact build (`mem doctor` does).
  - The project package is refused (503): it would be silently incomplete.
  Measured: see the changelog entry of 2026-10-02 (atlas-pass).
- The build runs in a worker thread whose heap the server caps (at most
  4 GB, half the RAM) and enforces itself: Node's `resourceLimits` alone did
  not hold on Node 22.22 (a 64 MB limit ran on to 2 GB; with `NODE_OPTIONS`
  setting `--max-old-space-size` it does not hold at all). The guard starts when
  the worker reports `ready`, and the build starts one turn later: stopping a
  worker in the middle of the evaluation of an ES module crashed V8 on
  Node 22.22. If the compact build with its modules goes over the cap, it is
  built again without them. A build over the cap
  fails the worker only; the server keeps answering with the last head and says
  why. The cache counts a result's age from the END of its build and waits at
  least four times a build's duration before the next background build.
- `CHEAP_MEM_SERVE_HEAD_ENTRIES` sets how many newest entries the first answer
  carries (default 120). The page holds at most 30,000 entries; above that lists and the network show
  the newest and the search goes through the server.

The measurements (`bench/board-tempo.mjs`, synthetic stores of
`bench/scale.mjs`) are in the changelog entry of 2026-10-02.

### When the cached state counts as changed

Every request recomputes the **generation stamp** of the store with `stat`
calls only: the drawers, the reflog of HEAD, and the machine-local places
`.mem`, `inbox` and `agents` (two levels, files only). A different stamp means
"store changed since the build" and a rebuild in the background. Derived caches
are NOT part of it, because the build or a read writes them itself and the
dashboard would rebuild forever: the search index (also the one of document
expansion, `MEM_EXPAND=1`, in `search-index-expand`), backlinks, the language
bridge, the console state, the answer patterns, the head on disk, the component
table with its rebuild lock and log, the time track with its build lock, the
drawer locks, heartbeats, and the scratch names of an atomic write
(`<name>.<pid>.<random>.tmp`, `<name>.stale.<pid>.<random>`) of any of them.
What the stamp does not see, the age catches: older than 60 s is rebuilt.

### After a write of your own

A write through the page shows its new state at the next read, not after the
rebuild (`src/dashboard-live.mjs`): the write names the **parts** of the answer
it changed, the server computes exactly those with the read functions the full
build calls and lays them over the stored answer, until a build that started
after the write is through. The answer says it: `cache.fresh` stays `false`,
`cache.live_parts` names the parts. A read without a write computes nothing.

| Write | Part | What it lays on |
|---|---|---|
| save a setting | `settings` | the settings and the change log |
| acknowledge or answer a message | `inbox` | the message list, the tray |
| rate a gold question | `gold` | the gold questions of the day |
| confirm a project (task) | `projects` | the project shelf, the waiting projects |
| delete a raw capture (task) | `raw` | the capture states and counters |
| confirm an answer (task `question-confirm`) | `questions` | the open and the waiting questions (badge, button, work lists) |

A part only refreshes its own sections; tiles derived from them (the
per-project question counts, the error-window tiles) follow with the rebuild.
The `questions` part reads the question drawers and the links of the questions
(measured 107 ms median on 5000 entries with 60 questions, against 5.7 s for
the full build, load about 15 on 4 cores). A store built compact keeps its
stored question lists until the rebuild: reading the whole store is what the
compact build avoids. A part that cannot be computed is named in
`cache.live_errors` and said at its card ("Could not be computed fresh ...
showing the state of HH:MM"), never shown silently old.

### Deferred parts while the build runs

A part that answers `building` is asked again after 3 s, bounded by a deadline
(120 s) and a budget (40 requests) per waiting spell, then it ends visibly with
"Load again". When a newer data load starts its own round of parts while such a
retry still waits, the retry is dropped (the spell keeps its deadline and
budget): the new round asks every part anyway, and the old timer used to fetch
them all a second time (seen on a cold start whose first answer was the quick
head; the changelog entry of 2026-10-16 has the counts).

## What it shows

- **Overview**: state, attention, the board's tiles (the same as
  `mem board`, which stays on the CLI), and the 3D network.
- **Decision cards.** Whatever a person is meant to decide or release is a
  readable card, not an identifier or the first words of a text: on the
  overview ("Today" and "Your next look"), in the duties list, in the card of
  a project that waits, and at the top of the entry drawer. One function
  (`cardHtml` in `assets/dashboard/dashboard.js`) draws all of them, from the
  `card` that `src/decisioncard.mjs` puts on each item of `/dashboard.json`:
  the question as a heading, what it is about, the options as a list with their
  effects (a No / not-now option is always among them, nothing is preselected),
  the recommendation as "Recommendation from <author>", the evidence as links
  (the identifier only small), and an origin line with author, tier, date and
  stage (`written` on the entry, `added later` from the card shelf, or a
  `replacement card` made by rule, which says that nobody wrote it and has no
  recommendation). A card written by an agent says "Written by an agent, not
  checked by you" unless it carries the tier `user`. Items are grouped by
  whom they are owed to (`owner` on each open item, named from the
  configuration): **For you** is everything owed to the configured human,
  whatever the kind of its card; **Agent work** is what is owed to an agent (no
  card, `src/cardfeed.mjs`). An item owed to nobody goes by its card: a decision
  or release is for you, a task is agent work. The Today card lists what is owed
  to the human only. Inside "For you" the items go by their deadline (overdue
  first, then due today, later, then none or an unreadable one in list order; the
  server sends `dueAt` from the due core), so the overview's three items are the
  most urgent ones; "Agent work" keeps the list order. When that group holds an item owed to
  nobody (no addressee, or a name the configuration does not know, a typo too),
  its hint reads "Nobody owns some of these yet" instead of "nothing for you to
  decide"; there is no third group for them yet. A card draws every text through
  `esc`; the texts arrive already masked from the server. After a write the
  freshly computed part (`projects`) carries the cards of what is left. Probes:
  `test/card-view-cm-browser.test.mjs`, `test/card-group-browser.test.mjs`.

  **Known defect of the existing group heading (open).** In the light theme the
  group heading ("FOR YOU (n)") and the hint under "Agent work" are drawn with
  the existing `.label` / `quiet` colour `--quiet` (rgb 97,120,105) and reach
  only 4.2 to 4.4 : 1 against the card background, short of WCAG AA (4.5 : 1) for
  small text. The variable is shared by the whole page and is deliberately not
  changed here; a separate job is to fix it.
- **Knowledge**: entries, network, topics, facts, learnings, skills.
- **Work**: duties and questions, agents, inbox, a calendar (today, the next
  days, proposals waiting for you, fired reminders, scheduled agent actions
  with their state, the cap, the calendar outlet; read only, from
  `/dashboard/appointments.json`, see [appointments.md](appointments.md);
  the overview also carries a card "Today in the calendar"), agent context,
  usage, and the user and ledger view. The agents page is a table: a summary
  bar on top, then one row per agent, grouped into needs attention,
  active (last 7 days) and idle.
- **Sources**: projects, files and store, raw captures, digest, and the
  export studio. The export studio builds a JSON package of one project
  (`/dashboard/project-package.json`), previewed from the same
  selection; the offline reading view is `mem viewer`.
- **Operations**: storage and drawers, tasks, diagnosis (the doctor),
  performance, integrity, versions, MCP tools.
- **Settings**: appearance, access, system settings (the console's knobs
  and long jobs), the function catalogue, and project state.

Every count has four states, each with its own colour: calm, watch,
alarm, unknown. The doctor uses good, warning, error, unknown.
**Unknown is never drawn as 0.** A source that cannot be read is named
on the page, and completeness then reads "unknown".

**What cheap-mem does not have is shown, with the reason.** Three areas
read "not available in cheap-mem, by design", each saying why: Books (a
stored, model-written condensation would be a second truth beside the
logs), the digester's yield per run (no background digest service here;
the doctor's digest-yield finding is what is measured) and the
1M/5M/10M scale gate (the sibling's VM tooling; the corpus-size finding, the
hook-time finding and the weekly series run on your own memory instead). The
repository has its own, smaller pass/fail ladder for developers
(`node bench/scale-gate.mjs`, up to 1,000,000 entries, `docs/scale.md`); the
dashboard does not show its result.

**Built, and reading only the journal or the append-only logs:** hook time
per day and per occasion against one budget (`src/latencybudget.mjs`,
doctor finding `hook-latency`), the live injection view (newest 30 recalls,
including why nothing was injected), and `mem restore` / `mem merge`
(new lines only; the browser shows the command, it has no write route
for them).

**Raw capture delete** works like `mem raw delete`. You get a preview
first, then must give a reason, then confirm. The tombstone stays in the
register.

## The measurement series

A running server records one snapshot a week: entries, declared links,
links into the void, raw captures, open duties and questions, injections
shown that week, and doctor warnings plus errors. They go to
`.mem/measurements.jsonl` and are capped at 52 weeks
(`src/measurements.mjs`). Nothing is recorded by tests or by opening
the page.

## Security

- **A door with nothing behind it does not start.** The door is the token
  (`CHEAP_MEM_SERVE_TOKEN`) or the password login (on by default). With
  neither - the login turned off by `CHEAP_MEM_SERVE_LOGIN=off` and no
  token - `mem serve` exits with a message and binds no port. To run like
  that on purpose, on this machine only, say so: `mem serve --local-no-token`
  (or `CHEAP_MEM_SERVE_LOCAL_NO_TOKEN=1`, for a service unit). Even then it
  binds loopback only (a public `--host` without a token is refused, switch
  or not), a request that carries a proxy header (a tunnel, a reverse proxy)
  is turned away, and the start prints a `NOTICE` line that it runs without
  a token.
- **A taken port is a message, not a crash.** If the port is already in use (another
  `mem serve`, another program), `mem serve` and `bin/mem-serve` print the host and
  port and the way out (`mem serve --port <n>` or `CHEAP_MEM_SERVE_PORT=<n>`), exit 1
  and show no stack. The setup code for a first password is written only after the
  port is bound, so a start that never bound leaves no code file behind.
- To make a token: `node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"`
  prints one (it works the same in bash, PowerShell and cmd). Put it in the
  environment of the process as `CHEAP_MEM_SERVE_TOKEN` (bash: `export CHEAP_MEM_SERVE_TOKEN=<token>`; PowerShell:
  `$env:CHEAP_MEM_SERVE_TOKEN='<token>'`), not in a file that is
  committed, and open `http://127.0.0.1:8847/?k=<the token>` once (the server
  moves it into a cookie), or send it as `Authorization: Bearer <the token>`.
  A request that is neither loopback nor carries the token gets a bare 404.
- Every data route checks the `Host` header against loopback,
  `CHEAP_MEM_SERVE_HOSTS` and the hosts of `CHEAP_MEM_SERVE_ORIGINS`.
  This guards against DNS rebinding.
- The page sends a Content-Security-Policy and never a CORS header.
- The service worker stores nothing unless `CHEAP_MEM_SERVE_OFFLINE=1`.

## The password (sign-in, since 2026-09-28)

Behind the token door and in front of all content sits a password — a
black page, one field, one button (`src/login.mjs`). Without a valid
session every page goes to `/login`, every data and writing route
answers `401` JSON. Tools keep the existing way:
`Authorization: Bearer <CHEAP_MEM_SERVE_TOKEN>` needs no password. The
door cookie (named mem\_k) alone is not enough and does need the
password — otherwise the password would do nothing in the owner's own
browser. `CHEAP_MEM_SERVE_LOGIN=off` switches it off
(tests, local use); the default is on.

**First setup: the code, not loopback.** With no password set, the
server keeps a one-time code in `.pipeline/serve-setup-code` (mode 600)
and logs only WHERE it is; `mem serve setup-code` prints it. Setting the
first password needs that code, and only that code: neither the bearer
token (it would turn a tool credential into a person session) nor
loopback counts. Behind a tunnel whose client runs on the same machine,
every request arrives from 127.0.0.1.

**Who writes as the owner.** `/setting`, `/inbox/reply`, `/inbox/state`,
the two verdict routes and the `raw-delete`, `done`, `restore`, `merge` and `export` tasks need a signed-in PERSON
(a valid password session cookie): `403` for the bearer token alone and
for a server with `CHEAP_MEM_SERVE_LOGIN=off`. Reading with the bearer is
unchanged. `/login/logout` needs the session too (`401` with the bearer
alone). So does `POST /task/cancel` (`403` otherwise); `raw-delete` is not
cancellable (`409`): it frees the bytes and then writes the tombstone. The
command, result and reason of `/task.json` name `<root>` and `<code>`, not
the server's absolute folders. The raw archive can be pointed from the dashboard only into the
memory root, the home folder, the temp folder or a folder listed in
`CHEAP_MEM_ARCHIVE_BASES`; any other place is set from the shell
(`mem archive`).

**With `CHEAP_MEM_SERVE_LOGIN=off` the dashboard reads, it does not
answer for you.** Replying to a letter, acknowledging it, changing a
setting and the verdict buttons need a signed-in person, and with the
login off there is none: those routes answer `403`. Use the shell
meanwhile (`mem inbox write` / `mem inbox ack`, `mem console` settings,
`mem done`, ...). The buttons stay in the page; a hint for the
login-off case is left for later. `done`, `restore`, `merge` and
`raw-delete` (the tasks that write as the human) need a password session
as well.

**Storage.** `.pipeline/serve-password.json`: only a salted scrypt hash
(compared with `timingSafeEqual`), mode 600, gitignored. The sessions
file keeps only SHA-256 of the session tokens.

**Session.** The session cookie (named mem\_session): `HttpOnly; SameSite=Strict; Path=/`,
`Secure` behind https or a tunnel, 30 days, sliding. After an
identity-provider round trip the page reloads once same-site (no script)
so the strict cookie comes along.

**Failed attempts.** Every refusal waits 0.4 s; from the 3rd failure per
source an exponential lock of 1 s, 2 s, 4 s … up to 15 min. The source is
the socket address. Only with `CHEAP_MEM_SERVE_BEHIND_TUNNEL=1` (a tunnel
on this machine) is `CF-Connecting-IP` from a loopback connection taken
as the source; without it every visitor behind a tunnel shares the
tunnel's address and one lock (the server logs one line the first time
it sees the header without the declaration, never the value). There is no lock across all sources (it
let a stranger lock the owner out). Logged with source and counters,
never with a password.

**Change / sign out:** Settings › Access (current password, new one
twice, at least 10 characters). A change ends every other session.
Changing the password is NOT behind the write switch: it touches no
memory, and the owner must be able to change it with writes off.

**Forgotten:** `mem serve reset-password` on the machine, then
`mem serve setup-code`; the next visit asks for the setup again.

## Every file from this server

three.js r180 (MIT) and DM Sans (SIL OFL 1.1) are vendored under
`assets/`, with their licences next to them and in `NOTICE`. That is
the one named exception to "no dependencies"
(`test/packaging.test.mjs`, `VENDORED`). The page makes no outside
request: no CDN, no font service.

## Parity with the sibling

Parity is kept through shared invariants (`shared/invariants.jsonl`),
not through shared code. Each house has its own tests. The completeness
inventory (`test/dashboard-complete.test.mjs`) lists every feature the
old UI had and where it lives now.


## Warm recall (M10, 2026-09-30)

`mem serve` also starts a **recall server** as a child process
(`src/recallserver.mjs`, `bin/mem-recall-server.mjs`): a Unix socket at
`<memory>/.pipeline/recall/recall.sock` (Windows: a named pipe, plus a
marker file `recall.pipe` in the same directory, because a pipe is no file
and the hook's bash test needs something to look for; a dead server leaves
the marker, the client's connect then fails and the hook goes direct with
`server-gone`). The
recall hook `bin/mem-retrieve` (bash, also under Git Bash on Windows) asks it
first; the PowerShell hook `bin/mem-retrieve.ps1` asks it through the same
Node client (`bin/mem-retrieve-client.mjs`, same exit codes, same journal
reasons, same one time budget) - unverified on real Windows PowerShell;
with no server it runs `mem find` itself, exactly as before.

- **One search path.** The server runs the same `find` handler as
  `mem find <prompt> --top N --json`; the hook renders and books as
  before. Nothing new can be read or written through it.
- **Local only.** No TCP, no port. Directory mode 0700, socket and key
  file 0600, all under `.pipeline/` (gitignored); the key never reaches
  a log. Another user reaches neither (probe
  `test/m10-recall-server.test.mjs`, M10-6). **On Windows POSIX modes
  mean nothing and cannot be checked**: the 0700/0600 above hold on
  POSIX only; there the random key is the guard, the server prints a
  NOTICE at start, and NTFS ACLs of your profile (`icacls`) do the rest.
  Unverified on real Windows.
- **Password and setup-code files** (`serve-password.json`,
  `serve-setup-code`) are 0600 on POSIX; on Windows the same applies:
  POSIX modes cannot be checked there, protect them with NTFS ACLs.
- **Fresh.** No index is kept in the server; every question loads it
  through `search.loadIndex()`, which checks the file state. If code
  under `src/` changes, the server answers `stale`, the hook runs
  direct, and the server restarts itself: it runs as a child of
  `mem serve` under `src/recallserver-keeper.mjs`, which starts it again
  with a fresh import — at most once per 60 s
  (`MEM_RECALL_SERVER_RESTART_MS`), with a log line
  `recall server: restart (code under src/ changed)`. "Changed" is read
  from `stat` only: the count of files, the newest mtime, the total size and
  the newest ctime. The ctime catches a change of the same size whose mtime
  was set back (`touch -d`, `cp -p`, `rsync -t`, unpacking a tar); a
  permission change also counts, which costs one restart, never a wrong
  answer. Until it listens
  again there is no socket, and the hook runs direct.
- **One budget.** `MEM_RETRIEVE_TIME` (5 s) covers the server attempt
  AND the direct fallback.
- **Journal.** Every recall line in `.pipeline/injections.jsonl` carries
  `path` (`server` | `direct`) and `path_reason` (`null`, or why it ran
  direct although a socket was there: `server-gone`, `server-timeout`,
  `server-refused`, `server-stale`, `server-error`).
- **Switches.** `MEM_RECALL_SERVER=0` (never asked, never started),
  `MEM_RECALL_SERVER_DIR` (another place, e.g. when the socket path
  would exceed 100 bytes), `MEM_RECALL_SERVER_WAIT_MS` (longest wait for
  the server, default 2500, never beyond the budget).

Running `mem serve` permanently is optional: the installers ask (default
no), see `install/serve-service.sh` and `install/windows.ps1 -ServeService`.
