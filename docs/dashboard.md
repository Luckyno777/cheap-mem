# The dashboard

`mem serve` shows one page: the dashboard. Since 2026-09-28 it is
cheap-mem's only UI. It is the sibling house's dashboard (lucky-mem),
functionally and visually the same. It differs in three ways only: it is
in English, it carries cheap-mem's own mark (the C), and a fresh install
starts with an empty store.

```bash
mem serve                 # http://127.0.0.1:8847/  (localhost only without a token)
mem serve --allow-writes  # allow the page to write, for this run only
```

## Routes

| Route | What |
|---|---|
| `/`, `/dashboard`, `/pult` | the page |
| `/dashboard.json` | everything the views show, collected live (gzip when asked) |
| `/dashboard/entry.json?id=` | one entry, whole |
| `/dashboard/message.json?id=` | one inbox message, whole |
| `/dashboard/probe.json` | the retrieval probe: what `mem retrieve` would inject for a question. It is read-only and never logged |
| `/dashboard/facts-at.json?known=&valid=` | the bitemporal comparison (Knowledge / Facts) |
| `/console.json`, `/pult.json` | the console's and the board's numbers, for tools |
| `/console`, `/viewer` | 303 into the dashboard (`#settings/system`, `#knowledge/entries`) |
| `/manifest.webmanifest`, `/sw.js`, `/favicon.ico` | the installable shell (PWA) |

Writing routes and their switch: `docs/dashboard-writes.md`.

## What it shows

- **Overview**: state, attention, the board's tiles (the same as
  `mem board`, which stays on the CLI), and the 3D network.
- **Knowledge**: entries, network, topics, facts, learnings, skills.
- **Work**: duties and questions, agents, inbox, agent context, usage,
  and the user and ledger view.
- **Sources**: projects, files and store, raw captures, digest, and the
  export studio.
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
1M/5M/10M scale gate (VM tooling; the corpus-size finding, the hook-time
finding and the weekly series run on your own memory instead).

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

- Without `CHEAP_MEM_SERVE_TOKEN` it binds to localhost only. A request
  that is neither loopback nor carries the token gets a bare 404.
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
first password needs that code (or the bearer). Loopback does not count:
behind a tunnel whose client runs on the same machine, every request
arrives from 127.0.0.1.

**Storage.** `.pipeline/serve-password.json`: only a salted scrypt hash
(compared with `timingSafeEqual`), mode 600, gitignored. The sessions
file keeps only SHA-256 of the session tokens.

**Session.** The session cookie (named mem\_session): `HttpOnly; SameSite=Strict; Path=/`,
`Secure` behind https or a tunnel, 30 days, sliding. After an
identity-provider round trip the page reloads once same-site (no script)
so the strict cookie comes along.

**Failed attempts.** Every refusal waits 0.4 s; from the 3rd failure per
source (behind the tunnel `CF-Connecting-IP`) an exponential lock of
1 s, 2 s, 4 s … up to 15 min; 20 failures overall lock everyone for a
while. Logged with source and counters, never with a password.

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
`<memory>/.pipeline/recall/recall.sock` (Windows: a named pipe). The
recall hook (`bin/mem-retrieve`, and `bin/mem-retrieve.ps1`) asks it
first; with no socket it runs `mem find` itself, exactly as before.

- **One search path.** The server runs the same `find` handler as
  `mem find <prompt> --top N --json`; the hook renders and books as
  before. Nothing new can be read or written through it.
- **Local only.** No TCP, no port. Directory mode 0700, socket and key
  file 0600, all under `.pipeline/` (gitignored); the key never reaches
  a log. Another user reaches neither (probe
  `test/m10-recall-server.test.mjs`, M10-6).
- **Fresh.** No index is kept in the server; every question loads it
  through `search.loadIndex()`, which checks the file state. If code
  under `src/` changes, the server answers `stale`, the hook runs
  direct, and the server restarts itself: it runs as a child of
  `mem serve` under `src/recallserver-keeper.mjs`, which starts it again
  with a fresh import — at most once per 60 s
  (`MEM_RECALL_SERVER_RESTART_MS`), with a log line
  `recall server: restart (code under src/ changed)`. Until it listens
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
