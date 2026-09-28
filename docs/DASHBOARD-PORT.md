# Dashboard port — cheap-mem onto lucky-mem's Dashboard-Muster-3

Status: analysis only, no code changed. Written 2026-09-28 against
`cheap-mem` branch `agent/cm-dash-spec` (base commit `cedce0c`) and
`lm-post` (worktree at `/home/user/lm-post`, same date). Numbers below
are either **measured** (command shown) or marked **estimate**/**N/A**
— none is invented.

Owner decision this document assumes (2026-09-28): lucky-mem's
Dashboard-Muster-3 becomes the only UI in both houses. cheap-mem gets
the same look, animations, 3D "energy-core" network and functions, in
English, fed by cheap-mem's own data, with cheap-mem's own mark. The
old UI is switched off only after this document's mapping shows
nothing was silently dropped.

---

## 0. Summary of what exists today, in one paragraph per house

**lucky-mem** ships the target already: `/dashboard` (`src/dashboard.mjs`,
109 lines — page shell only), `/dashboard.json` (`src/dashboard-daten.mjs`,
1034 lines — `sammleDashboard()`), the browser app
(`assets/dashboard/dashboard.js`, 3236 lines), vendored `three.js` r180
and a vendored DM Sans woff2, served by `bin/mem-ansicht-server.mjs`
(1229 lines). It sits **beside** the older `schreibtisch` (desk) at `/`,
unremoved. The planning document `betrieb/DASHBOARD-MUSTER-3.md` (925
lines, dated 2026-09-27) is lucky-mem's own port analysis of the same
mockup and is the closest precedent for this document — several of its
findings (the two pre-existing spatial views merging into one 3D graph,
the fetch-allowlist test rewrite, the three.js/font vendoring plan)
transfer directly and are cited below rather than re-derived.

**cheap-mem** has **no dashboard of this shape yet**. It has three
separate, older surfaces — a one-off static "photograph" file
(`viewer.mjs`), a small read+write settings console (`console.mjs`),
and a fully server-rendered, no-JS, no-fetch, single-page-per-view
workspace called **Astra** (`astra.mjs` + `src/astra/*.mjs`) — all
served by one host, `bin/mem-serve`. Astra is the nearest existing
analogue to lucky-mem's *old* `schreibtisch`, not to Dashboard-Muster-3.
`icon.mjs`'s comment "cheap-mem does not ship one yet" is **stale**:
`bin/mem-serve` has existed since 2026-09-09 (commit `169f988`), three
days after `icon.mjs` was written (2026-09-05, `9233868`), and the
comment was never revised. cheap-mem already has, and needs, a host.

---

## 1. Inventory of cheap-mem's current UI

### 1.1 Hosting model

One process, `bin/mem-serve` (Node `http`, no framework, 442 lines),
started as `mem serve` (`src/cli/commands/setup.mjs:481`). Binds to
`127.0.0.1:8847` by default; a public bind is **refused** without
`CHEAP_MEM_SERVE_TOKEN` (`webauth.bindAllowed`, fail-closed). No CSP
header is set today (grep across `src/*.mjs` and `bin/mem-serve`: none).
Nothing is written to disk by the server itself — HTML is built and
served from RAM per request (`bin/mem-serve` header comment).

Static, no-server alternative: `mem viewer` (`src/viewer.mjs`, 1349
lines) writes **one** self-contained HTML file — every entry embedded
as JSON, search/filter run client-side, explicitly "no server, no
model, no network" (README.md:82, `docs/CAPABILITIES.md:590-591`). This
is a *photograph*, thrown away when stale, not a running page.

### 1.2 Routes (`bin/mem-serve`, `export const PATHS`)

| Path | Method | Reads | Writes | Guard |
|---|---|---|---|---|
| `/health` | GET | — | — | none (by design, reveals nothing) |
| `/`, `/pult`, `/dashboard.json` | GET | `astra.build()` / `dashboard.collect()` | — | token/loopback |
| `/console`, `/console.json` | GET | `console.collect()` | — | token/loopback |
| `/viewer` | GET | `viewer.build()` | — | token/loopback |
| `/entry.json?id=` | GET | `dashboard.getEntryFast()` | — | token/loopback |
| `/entries.json?type=&project=&q=&after=&n=` | GET | `pages.page()` | — | token/loopback |
| `/task.json[?id=]` | GET | `tasks.read()` / `tasks.overview()` | — | token/loopback |
| `/setting` | POST | — | `console.apply()` (closed `SETTINGS` list) | `writegate.refusal()` + SameSite cookie + Origin allowlist |
| `/task`, `/task/cancel` | POST | — | `tasks.start()` / `tasks.cancel()` (closed `KINDS` list) | same three-latch `writegate.refusal()` |
| `/inbox/reply` | POST | — | `inbox.reply()` (only the configured human participant, only replying to the addressee) | same three-latch, plus reply-direction check |
| any other path | GET | 404, **identical** to an auth failure (no signal to a scanner) | — | — |

`WRITE_PATHS = ['/setting', '/task', '/task/cancel', '/inbox/reply']` —
exactly four, all behind `writegate.refusal()`
(`src/writegate.mjs`, 135 lines): write switch (off by default since
2026-09-27) → readonly latch → Host/Origin allowlist, in that order.
`readConfig()`'s comment fixes this precisely: *"Writing is OFF by
default (decision 2026-09-27, reversing the earlier 'on by default')."*

No CSRF-style route exists for raw-capture deletion, export, or
anything else — those are CLI-only today (§1.4).

### 1.3 Pages / views, per route

- **`/console`** (`src/console.mjs`, 541 lines): a closed list of three
  settings — `raw-archive` (path, probe-writable), `error-window`
  (days, 1–3650), `quiet-hours` — each with `read()`/`write()`, plus
  the two long-running task buttons (export, integrity check). Every
  applied change is appended to `.mem/console-log.jsonl` (machine-local,
  gitignored). Secrets are never echoed, only "set / not set".
- **`/` (Astra)**: seven views, one glyph and one label each
  (`src/astra/shared.mjs`, `NAV`):
  - **Desk** (`◫`, `src/astra/desk.mjs`) — four metric tiles (entries,
    declared links, drawer kinds, system alarms), a system-state card
    grid, an active-work card grid. Four states throughout: `calm` /
    `watch` / `alarm` / `unknown` — `unknown` is its own colour
    (`--muted`), never folded into `watch`.
  - **Knowledge** (`▤`) — the entry list/master-detail
    (`src/astra/knowledge.mjs`), backed by `/entries.json` and
    `/entry.json` for the fast single-entry path.
  - **Neural network** (`⌘`, `src/astra/space.mjs`) — a rotatable,
    zoomable 2-D canvas (`<canvas id="space">`) laying out the same
    entries as Knowledge, two line modes ("where things sit" /
    "only what someone declared"), capped at `LIST_MAX = 400`
    (`src/astra/shared.mjs:20`).
  - **Projects** (`◈`, `src/astra/projects.mjs`).
  - **Agents** (`◉`, `src/astra/agents.mjs`) — liveness from **two
    independent signals** (heartbeat + observed activity, never
    folded into one boolean — `src/dashboard.mjs:170-176`), the PR
    "bell" channel, and **"Your inbox"**: the configured human
    participant's messages, with a reply form posting to
    `/inbox/reply`.
  - **Links** (`⤴`, `src/astra/net.mjs`) — the declared-only
    drawer×drawer matrix (`src/net.mjs`), never similarity-based.
  - **Settings** (`⚙`, `src/astra/set.mjs`) — re-embeds the console's
    forms and the task buttons inside Astra.
  - A separate **Neural network vs. Links duplication** exists today,
    exactly the shape lucky-mem's own `DASHBOARD-MUSTER-3.md` §2.4
    found in itself: two spatial views (`space` = canvas layout,
    `net` = matrix) that Dashboard-Muster-3's single 3D graph is meant
    to merge, not replace.
  - **Rendering contract** (`test/dashboard.test.mjs:470-490`,
    `docs/CAPABILITIES.md` §7.5): Astra's page is **fully
    server-rendered, data embedded inline, zero `fetch`/`XMLHttpRequest`,
    zero external `<script src=…>`**, and at most **one** external
    resource total — a Google Fonts stylesheet for DM Sans (added
    2026-09-16, `docs/viewer-design-tokens.json`). This is stricter
    than lucky-mem's own already-agreed fetch-allowlist relaxation
    (`DASHBOARD-MUSTER-3.md` §4.3): cheap-mem's current test forbids
    *any* `fetch`, lucky-mem's forbids more than one distinct target.
- **`/viewer`** (`src/viewer.mjs`): the static-photograph HTML, also
  reachable live over the server as a fallback route (any path not in
  `PATHS` above 404s **before** reaching the viewer branch, so in
  practice `/viewer` is the only way to reach it over HTTP).

### 1.4 Read and write paths NOT reachable over HTTP today

- **Raw-capture review/delete.** `mem raw delete <path> --reason "…"
  [--by <name>] [--yes]` and `mem raw migrate [--remove]` exist as CLI
  commands only (`src/cli/commands/capture.mjs:9-30`). No Astra view,
  no `console.mjs` setting, no `mem-serve` route surfaces raw-capture
  review or deletion at all. `NAV` in `src/astra/shared.mjs` has no
  `raw`/`sources` entry.
- **Doctor.** `mem doctor` (`src/doctor.mjs`, states `good`/`warn`/
  `error`/`unknown`) is CLI-only; Astra's Desk tile pulls doctor-style
  system state from its own `system` array
  (`dashboard.collect()`), not from a `/doctor.json` route — there is
  no dedicated doctor page.
- **Weekly/rolling measurement.** `src/gauges.mjs` (three numbers:
  occupancy, sufficiency, allocation, `docs/CAPABILITIES.md` §8) is a
  benchmark-time tool (`bench/`), not exposed anywhere in Astra or the
  server.

### 1.5 PWA / icon

`src/icon.mjs` draws the mark (a trail spine + three shrinking bars, in
`--ink`/`--accent` from the page's own palette) as a PNG, in code, at
any size — no binary checked in. **Only `viewer.mjs` embeds it**
(`markLink()`, default 64 px, light) — `astra.mjs`, `board.mjs` and
`console.mjs` ship **no favicon at all** today (`grep -n "icon\." src/
astra.mjs src/viewer.mjs` returns hits only in `viewer.mjs`). There is
no manifest, no service worker, no install prompt anywhere in
cheap-mem — `icon.mjs`'s own header names this as future work
("A manifest and a service worker need a real origin... Until it does,
only the mark lives here"). lucky-mem's PWA lives in `src/pwa.mjs` and
is out of scope for cheap-mem's port unless the owner asks for it
(§6).

### 1.6 Other UI-touching files, unclassified in the task

- `board.mjs` (485 lines) — a smaller, text-first status summary
  (`mem board`, text or one self-contained HTML page,
  `docs/CAPABILITIES.md` line 30); used by `test/board-cli.test.mjs`
  and `test/board.test.mjs`. Not routed by `mem-serve` under its own
  path (no `/board` in `PATHS`); reachable only via `mem board` on the
  CLI. **Not part of the switch-off scope** unless the owner says the
  same functionality is fully covered elsewhere first.
- `pages.mjs` (389 lines) — the `/entries.json` cursor-paginated list;
  pure data, no page of its own. Stays regardless of the UI switch: the
  new dashboard needs exactly this kind of endpoint (§2).
- `bin/mem-serve` itself is not "UI" but is the one file every UI
  decision in this document has to go back through.

---

## 2. Mapping: lucky-mem's dashboard view → cheap-mem data source

Status vocabulary matches the task's: **available** (wire it up),
**must be built** (no path today), **not applicable** (with reason).

| Dashboard-Muster-3 view (English name here, German source name from lucky-mem's own spec in parens) | cheap-mem data source | Status | Note |
|---|---|---|---|
| Home / overview | `dashboard.collect()` → Desk tiles | **available** | Same four metrics already computed (`src/astra/desk.mjs`); only the presentation changes |
| Knowledge → Entries (`knowledge/entries`) | `pages.page()` (`/entries.json`), `dashboard.getEntryFast()` (`/entry.json`) | **available** | Already server-paginated (cursor `after`), unlike lucky-mem's own client-paginated Astra-equivalent — no server change needed here, only the browser app |
| Knowledge → Network (3-D graph) | `net.build()` (boxes/pairs/dangling) for the aggregate view; `d.entries[].links` for a focused entry's trail (same data `astra/space.mjs` already draws in 2-D) | **available, rebuild needed** | Merge cheap-mem's own two existing spatial views (`space` canvas + `net` matrix) into one 3-D graph — the exact merge lucky-mem's own `DASHBOARD-MUSTER-3.md` §2.4 recommends for itself. Node cap: reuse `LIST_MAX = 400` (`src/astra/shared.mjs`); group cap: none exists yet in cheap-mem — needs a `NET_BOX_CAP`-style constant analogous to lucky-mem's `HIRNNETZ_KNOTEN_DECKEL`. **Node/edge count on THIS repo: not measurable — none exists.** Checked 2026-09-28: no `.mem/` with real entries exists anywhere in this repo (`/.mem/` is blanket-`.gitignore`d, `find` turns up only test-scratch dirs under `/tmp/*/`, which are throwaway fixtures, not a corpus). `bench/heaps-corpus.mjs`'s own header states this explicitly: *"cheap-mem is a tool, not a populated personal memory — there is no real English corpus here."* The only fixtures that exercise `net.build()` are `test/net.test.mjs`'s 11 unit tests (measured: `node --test test/net.test.mjs` → 11/11 pass), each hand-built with 2-5 entries for correctness, not scale (e.g. the "pairs carry the kinds" test: 3 entries, 1 pair, 2 kinds) — citing a node/edge count from these would misrepresent a unit fixture as a corpus measurement. Contrast: lucky-mem's own `net.mjs` header cites a REAL number from ITS sibling memory (2544 tag-based edges, 2026-09-11, the exact case that justified switching to declared-links-only). cheap-mem has no equivalent to cite. Flagged to owner (§6): before this view can be demoed with real numbers, someone must either dogfood cheap-mem on a real project long enough to accumulate declared links, or extend `bench/heaps-corpus.mjs` (currently vocabulary-growth only, no link generation) to produce a synthetic linked corpus — and any resulting number must be labelled synthetic, not real, in the demo itself |
| Knowledge → Topics | tags on every entry (`e.tags`) | **available** | Pure aggregation, no new source (same conclusion lucky-mem reached for itself) |
| Knowledge → Facts (bitemporal compare) | `timeline.jsonl` entries + `timesearch.mjs`/`timeexpr.mjs` | **must be built** | Same gap lucky-mem found in itself (§3.1 of its own doc): the computation exists, no HTTP facade does |
| Knowledge → Learnings | entries of type `learning` | **available** | Filter on `memory.TYPES.learning` |
| Knowledge → Skills | entries of type `skill` (procedures are a separate type, `memory.TYPES.procedure`, deliberately not the same thing — see `memory.mjs:87-92`) | **available** | Filter; keep the skill/procedure distinction the source enforces (issued vs. acquired) rather than merging them for the view |
| Knowledge → Books (digests) | no `sammelband`-equivalent found in cheap-mem's type table (`memory.TYPES` has no digest/book type; `mem digest` in `search.mjs` builds a session-start dump, not a stored artifact) | **not applicable** | Reason: cheap-mem has no persisted "book" abstraction to show; `mem digest` output is ephemeral (stdout at session start), not an entry a dashboard can list. Flag to owner if a persisted-digest feature is wanted (§6) |
| Work → Tasks | `memory.openDuties()`, `question.all()` (same source Desk's "Active work" tile already reads) | **available** | |
| Work → Agents | `dashboard.mjs` agent context (`agentActivity`, `agentChannel` — two independent liveness signals, PR bell) | **available** | 1:1, already built for Astra's Agents view |
| Work → Inbox (**Postbox**) | `inbox.mjs` (`read()`, `reply()`) — cheap-mem's mailbox, ported from lucky-mem's own Sitzungspost | **available** | Read is in `dashboard.mjs` already (`humanInboxState`); write is `/inbox/reply`, already guarded. No dedicated `/inbox.json` route exists yet — same gap lucky-mem names for itself (`/schreibtisch.json` carries inbox data, not a separate JSON) |
| Work → Context (simulated injection) | `askedlearn.mjs`/hook-time injection logic; not HTTP-reachable | **not applicable as a live probe** | Same reason lucky-mem gives itself: injection happens inside a live coding-agent session via a hook, not on a browser's request. Rename to "recent injections" and read from whatever log exists, if any (check `userhabits.mjs`/`gauges.mjs` for a persisted log before promising this) |
| Work → Usage | `gauges.mjs` (occupancy/sufficiency/allocation) | **must be built** | Real numbers exist (bench-time only); no HTTP facade, no persisted history for a chart |
| Sources → Projects | Astra's Projects view (`src/astra/projects.mjs`) | **available** | |
| Sources → Files | `stores.mjs`, archive location (`console.mjs`'s `raw-archive` setting) | **available** | |
| Sources → Raw (capture review) | `raw.mjs` (`listCaptures`, `capturesWithState`, `pending`, `dropReason`) | **must be built** | No HTTP route or Astra view today at all (§1.4) — the single biggest concrete gap versus lucky-mem's own real desk, which already has this tab |
| Sources → Fasser (capture yield / provenance chain) | no `fasser`-equivalent found; closest is `raw.mjs`'s capture pipeline plus whatever produces `dropReason` | **must be built / rename** | cheap-mem has no separate "fasser run" concept as such — confirm with owner whether "capture yield" should be a new small aggregation over `raw.mjs`'s existing records, not a new subsystem |
| Sources → Export | none | **must be built** | Same gap, same recommendation as lucky-mem's own doc: a server-side export endpoint over the existing read layer, not a generic export command |
| Ops → Shards | no "shard" concept in cheap-mem; nearest is drawer (`project/type` path, same as lucky-mem's own "reinterpret as Kasten" conclusion) | **not applicable, reinterpret** | Use drawer (project × type) as the grouping, exactly as lucky-mem itself decided for its "Kasten" |
| Ops → Doctor | `doctor.mjs` — **states already match exactly**: `good`/`warn`/`error`/`unknown` | **available** | No dedicated HTTP route yet (`/entry.json` etc. exist, `/doctor.json` does not) — small, well-scoped addition |
| Ops → Performance | `gauges.mjs`, `bench/atlas.mjs` | **must be built** | No time-series history persisted anywhere; same conclusion as lucky-mem's own "So würden Messreihen aussehen" caveat — do not fabricate a chart from one point |
| Ops → Integrity | `integrity.mjs`, `tasks.mjs`'s `integrity` kind (already a task button in `/console`) | **available** | Encryption/shredder-style rows from the mockup are **not applicable**: cheap-mem is deliberately append-only plaintext JSONL. Exact citation (`docs/design.md:76-81`, "Why there's no encryption"): *"Because your memory belongs on a private git remote and git has no mainstream encryption story... the honest advice is: use a private repo, don't put secrets in."* A stated design choice, not an oversight — no fake encryption toggle to match the mockup's row |
| Ops → Versions | `component.mjs` (`mem component <path>`, wired at `src/cli/commands/setup.mjs:939`) — English throughout, no German name to translate; its own header cites a real measurement ("805 path mentions: 312 distinct components, 70 of them (22%) occur…"), git state | **available** | Verified 2026-09-28: `grep -n "german\|bauteil" src/component.mjs` returns no hits — this row's earlier "verify" is resolved, nothing to translate |
| Ops → MCP | `mcpprofile.mjs` — verified 2026-09-28: exports `READING`/`WRITING` (English, `src/mcpprofile.mjs:52,68`), never German `LESEND`/`SCHREIBEND` — this house's naming was already English before this document's first draft raised the question | **available** | Tool list is static; whether a specific client sees it is unknowable from the server, same as lucky-mem's own honest "unbekannt bleibt es" |
| Settings → Appearance | client-side only (theme/motion/print) | **available** | No data source needed |
| Settings → System | `console.mjs`'s `raw-archive` + `error-window` | **available, near-exact match** | `quiet-hours` is a third cheap-mem setting with **no** Dashboard-Muster-3 counterpart — needs its own settings row, not a silent drop |
| Settings → Catalog | 66 CLI commands (`docs/CAPABILITIES.md`, verified count §1 of this document via direct grep), MCP tool profile | **available** | Real count, not the mockup's own unverified claim |

Retrieval probe (mockup's command-palette-adjacent "ask a question and
see what surfaces" concept, if lucky-mem's build exposes one at
`/dashboard/abrufprobe.json`): cheap-mem's nearest equivalent is
`retrieval.mjs` (`search()`, structured claims only, no prose) plus
`mem retrieve`/`mem explain` on the CLI. **Must be built** as an HTTP
facade; the CLI computation exists and is well-tested
(`test/retrieval*.test.mjs` — not individually inventoried here).

Weekly measurement equivalent: no persisted weekly/rolling series
exists in cheap-mem today (`gauges.mjs` is measured per benchmark run,
not stored over time). **Must be built** if the owner wants a chart —
flagging this explicitly rather than inventing a fake history, per
house rule "not measured is not null."

---

## 3. cheap-mem UI with no lucky-mem counterpart

- **Long-running task buttons with polling** (`/task`, `/task.json`,
  `/task/cancel`, `src/tasks.mjs`) — a real child-process job runner
  with progress/result/cancel and a single-instance lock per kind
  (`export`, `integrity`). The mockup's own `operation-step`/
  `operation-stop`/`operation-restart` concept is the closest analogue
  on lucky-mem's side, but cheap-mem's version is real (child process),
  not simulated — worth keeping the polling and the lock, adding to the
  ported page in the mockup's operation-card style.
- **Console change log** (`.mem/console-log.jsonl`) — every setting
  change is append-logged, machine-local. No mockup view shows this;
  add a small "recent changes" list under Settings rather than drop
  it silently.
- **`quiet-hours` setting** — no Dashboard-Muster-3 counterpart at all
  (§2). Needs its own settings row.
- **Two-signal agent liveness** (heartbeat + observed activity, never
  folded into one boolean, `src/dashboard.mjs:170-176`) is stricter
  than the mockup's presumed single-signal badge (lucky-mem's own doc
  flags the identical tension for itself in its §3.3 "in lucky-mem
  nicht sinnvoll" list — same fix applies here: keep two signals, three
  possible statements, never a boolean).
- **`mem board`** (text-first status, `src/board.mjs`) has no mockup
  page; whether it is worth a view of its own or fully subsumed by the
  new Desk equivalent is an open question (§6), not a "must add."

---

## 4. Technical constraints

### 4.1 Dependency-free philosophy vs. vendored three.js + DM Sans

cheap-mem's stated position (`README.md:155` "with zero dependencies",
`CLAUDE.md`'s "no dependencies" note on `bin/mem`, `docs/CAPABILITIES.md`
§7.5 "no fetch, no CDN, no second file... there is therefore no failed
request to fall back from") is stricter than lucky-mem's own already-
accepted position: cheap-mem's Astra test (`test/dashboard.test.mjs:
483-484`) forbids **any** `fetch`/`XMLHttpRequest` and any external
`<script src=…>`, and allows at most **one** external resource total —
a Google Fonts stylesheet, added 2026-09-16 as a deliberate, logged
exception (`docs/viewer-design-tokens.json`). Vendoring three.js r180
(~520 KB minified per lucky-mem's own measurement, `DASHBOARD-MUSTER-3
.md` §4.1) and a DM Sans woff2 is a **second and third** deliberate
exception of the same kind, at a larger scale. This is not a blocker —
it is a decision the owner has already made once for cheap-mem (the
font) and is being asked to make twice more, explicitly (§6).

Licensing, if vendored: three.js is MIT (Copyright 2010–present
three.js authors); DM Sans is SIL OFL 1.1 (Copyright 2014 The DM Sans
Project Authors). Both license texts already exist verbatim in
lucky-mem's mockup and can be copied into cheap-mem's `NOTICE` (which
today only names cheap-mem's own MIT terms) and into a header comment
on the vendored files, mirroring lucky-mem's own recommendation
(`DASHBOARD-MUSTER-3.md` §4.1–4.2). Size, measured directly on lucky-mem's
own vendored files (`ls -la`, 2026-09-28), not cited secondhand:
`assets/three/three-r180.min.js` = 520,601 bytes (≈508 KiB, matching the
"~520 KB" figure in `DASHBOARD-MUSTER-3.md` §4.1 exactly);
`assets/schrift/dm-sans-latin.woff2` = 62,724 bytes +
`dm-sans-latin-ext.woff2` = 31,292 bytes (≈92 KiB together). Total new
weight if both are vendored as-is: ≈600 KiB, versus cheap-mem's current
zero (verified: no `assets/` folder exists in this repo at all).

### 4.2 English-only ratchet

`test/english-only.test.mjs` walks every comment line in `src/`, `bin/`
and `test/` and fails at zero German-function-word hits (two distinct
dictionary words on one line, per its own documented heuristic). It
inspects **comments**, not string literals or ported German field
names inside data. A ported dashboard's German source comments (from
copying lucky-mem's `dashboard-daten.mjs`/`dashboard.js`/
`mem-ansicht-server.mjs`) **must be rewritten in English before
landing** — this is not a formality, the test is real and will fail
red on an unmodified copy. Verified: `test/english-only.test.mjs`
exists and its own header states its exact scan surface.

### 4.3 SPDX headers

All 87 of cheap-mem's `src/*.mjs` files carry `SPDX-License-Identifier`
headers today (measured: `grep -l SPDX-License-Identifier src/*.mjs |
wc -l` = 87 = total file count). Any new file (vendored three.js, a new
`dashboard-data.mjs`, a new browser bundle) needs the same header
convention — vendored files get the *upstream* SPDX identifier (MIT for
three.js) plus a note of provenance, not cheap-mem's own
`SPDX-FileCopyrightText: 2026 Lucky H.` line, which would misrepresent
authorship.

### 4.4 The fetch-zero test is the central rewrite, same shape as lucky-mem's own §4.3

`test/dashboard.test.mjs:483-490` and `test/astra-knowledge-entries-json
.test.mjs:94` both assert **zero** `fetch`/`XMLHttpRequest` in Astra's
rendered HTML today. A Dashboard-Muster-3-style single-page app that
loads `/dashboard.json` and further JSON endpoints from the browser
needs this test rewritten from "zero" to "a named, closed allowlist of
same-origin paths" — structurally the same change lucky-mem's own
`DASHBOARD-MUSTER-3.md` §4.3 recommends for its sibling `test/schreibtisch
.test.mjs`. Recommendation here, matching that precedent: rewrite, do
not delete or weaken past a closed list; land it in the same work
package as the server routes it protects (§5, not a separate "test
change" package).

### 4.5 Existing tests that pin the old UI (must be touched or deliberately superseded, never silently orphaned)

Measured line counts, `test/*.mjs`: `viewer.test.mjs` (177),
`viewer-design.test.mjs` (160), `viewer-structure.test.mjs` (127),
`viewer-topic-scaling.test.mjs` (383), `dashboard.test.mjs` (605 —
Astra, not the new dashboard; misleading name once the new page ships),
`dashboard-entry-fast.test.mjs` (267), `dashboard-knowledge-types.test
.mjs` (121), `board.test.mjs` (230), `board-cli.test.mjs` (132),
`pages.test.mjs` (412), `icon.test.mjs` (51), `icon-guard.test.mjs`
(301). Total: 2966 lines across 12 files, none of which are touched by
this analysis, all of which stay green until the owner approves the
old-UI switch-off (task's own precondition: "after completeness is
proven"). `icon-guard.test.mjs` in particular already anticipates and
guards against a wrong-mark leak between the two houses (§ mark, below)
— it is a direct asset for this port, not an obstacle.

### 4.6 The mark (own logo, never the sibling's)

`icon.mjs` draws cheap-mem's mark (trail spine + three bars) as a pure
function of size/theme, from the page's own palette tokens — exactly
as lucky-mem's `marke.mjs` draws its "L". `icon-guard.test.mjs` already
enforces, with byte-level fixtures, that no cheap-mem page ever embeds
lucky-mem's mark and vice versa, quoting the owner's own 2026-09-27
rule ("we only turn the mark from a C into an L"). Today **only**
`viewer.mjs` embeds the mark at all (§1.5) — the new dashboard page
must call `markLink()` (or an equivalent inline `<svg>` built from
`icon.mjs`'s same palette constants, matching how lucky-mem's
`dashboard.mjs` inlines its `<svg class="mark">` directly rather than
using a `<link rel="icon">`) so the tab and the sidebar both show
cheap-mem's own mark, never a blank space and never the sibling's.

### 4.7 Windows installer

`install/windows.ps1` was checked for viewer/dashboard/serve
references: none exist (grep, this document's own investigation). It
only handles Claude Desktop MCP registration. **No changes needed
here** for this port.

### 4.8 CSP

No `content-security-policy` header exists anywhere in
`bin/mem-serve` today (verified: no match in `src/*.mjs`, `bin/mem-
serve`, or `test/*.mjs`). Adding vendored three.js/WebGL and a
same-origin JSON API is the right moment to add one — lucky-mem's own
`DASHBOARD-MUSTER-3.md` §4.5 proposes a concrete policy that transfers
directly (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`,
etc.); cheap-mem has no existing CSP to conflict with it, which makes
this strictly additive.

---

## 5. Work packages

Strict file ownership per SubagentStart rule §2 (own worktree, own
branch, section-level ownership only when two agents must share one
file). Order is mostly linear because each later package reads the
previous one's output shape.

### Package A — Data layer (no page, no browser code)

**Owns:** new file `src/dashboard-data.mjs` (English name, mirrors
lucky-mem's `dashboard-daten.mjs` role: one pass, one payload shape for
the new page). Reads existing modules (`memory.mjs`, `net.mjs`,
`doctor.mjs`, `raw.mjs`, `inbox.mjs`, `retrieval.mjs`, `gauges.mjs`) —
does not modify them except where §5 Package B below needs a genuinely
new small export (e.g. a `NET_BOX_CAP` constant, a `/doctor`-shaped
read function) that Package A specifies but does not itself land in
someone else's file.

**Commitment:**
- Measure: does `sammleDashboard()`'s German field-name shape
  (§2 of this document) translate 1:1 to English names over cheap-mem's
  existing English data, or does one field need a genuinely new
  computation (facts/bitemporal, usage/gauges, export, raw review)?
- Baseline: zero — no such file exists.
- Expected change: one new module, fully covered by new unit tests
  mirroring `test/dashboard-entry-fast.test.mjs`'s style (state-by-
  state: ok/warning/unknown/error, never a silent fallback).
- Abort criterion: if a field in §2's "must be built" column turns out
  to need a change to an EXISTING module's public contract (not just a
  new read), stop and split that into its own package rather than
  quietly widening Package A's scope.

**Red-proof:** write the new module's test file first, against the
OLD tree (no `dashboard-data.mjs` exists) — it fails with "module not
found", which is not yet the interesting red. The interesting proof is
per-field: for every field this document marks "must be built" (§2),
a positive-control test that PASSES on hand-built input asserting the
field CAN be computed correctly, before touching the real read path.

### Package B — Server routes (owns `bin/mem-serve` additions only)

**Owns:** new routes in `bin/mem-serve`'s `PATHS`/`WRITE_PATHS` lists
and their handlers: `/board2` or `/dashboard` (English page, final name
open to the owner — §6), `/dashboard.json`, `/doctor.json` (new, small),
`/raw.json` + a guarded raw-delete write route (new — the single
biggest net-new write surface, needs its own `writegate.refusal()`-
style three-latch, following `/inbox/reply`'s pattern exactly, not
inventing a new guard shape), `/probe.json` (retrieval probe, read-only,
GET only, following lucky-mem's own `probe`-route precedent).

**Commitment:**
- Measure: number of routes added (target: match §2's "must be built"
  rows, roughly 5-7 new routes).
- Baseline: 12 routes today (`PATHS.length`, measured).
- Expected change: `PATHS.length` grows by the number of new routes;
  `WRITE_PATHS.length` grows by exactly the raw-delete route (the rest
  of §2's gaps are read-only).
- Abort criterion: any new write route that cannot reuse
  `writegate.refusal()` unchanged stops the package — a second write-
  guard shape is exactly the "two truths" failure `console.mjs`'s own
  header comment warns against.

**Red-proof:** on the OLD tree, `curl` each new path and confirm 404
(proves the route did not already exist by accident); positive
control: `curl /entry.json?id=<real id>` on the OLD tree still 200s
(proves the test harness itself reaches the server).

### Package C — Browser page: markup + CSS (owns new files only)

**Owns:** new files `assets/dashboard/dashboard.css`, page shell inside
a new `src/dashboard.mjs` (English, page shell ONLY, mirroring
lucky-mem's own 109-line `dashboard.mjs` role — sidebar, topbar, scope
bar, dialogs). Does not touch `astra.mjs`, `viewer.mjs`, `board.mjs`,
`console.mjs`.

**Commitment:**
- Measure: does the new page pass `test/icon-guard.test.mjs`'s
  fixtures (cheap-mem's own mark, never the sibling's)?
- Baseline: N/A (new page).
- Expected change: one new passing assertion per existing icon-guard
  fixture pattern, applied to the new page too.
- Abort criterion: if the mark cannot be inlined the way
  `icon.mjs`/`markLink()` already supports without a new drawing
  function, stop and coordinate with whoever owns `icon.mjs` rather
  than forking the mark-drawing logic.

**Red-proof:** on the OLD tree, `icon-guard.test.mjs` has no fixture for
a page that does not exist yet — write the new fixture first (it fails
"page not found"), then land the page.

### Package D — Browser page: app script (owns `assets/dashboard/dashboard.js` only)

**Owns:** the new browser-side JS: hash routing, three.js wiring
(reading from Package A's payload, not lucky-mem's German field names),
command palette, forms wired to Package B's write routes. Depends on A
and B being stable in shape (not necessarily fully "must-built" fields
filled — placeholders with an honest "not measured" state are fine, a
silently invented number is not).

**Commitment:**
- Measure: does every state the payload can report (`ok`/`warning`/
  `unknown`/`error`, cheap-mem's four-state vocabulary) render
  distinctly, matching `dashboard.mjs`'s existing `tone()` map
  refusing a fifth, unmapped state (`src/astra/shared.mjs:66-70`) —
  the new script should keep that same "throw on unknown state" guard,
  not silently default.
- Baseline: N/A.
- Expected change: one rendering path per state, tested against
  Package A's positive-control fixtures.
- Abort criterion: any place the script would need to guess a value
  Package A did not provide — stop, that is Package A's gap, not
  Package D's to paper over.

**Red-proof:** render the new page against a hand-built payload with
one field deliberately set to an unmeasurable state; the page must
show "not measured" text, never a blank tile or a zero. Positive
control: the same payload with the field measurable renders the real
number.

### Package E — Test rewrites (owns test files that pin old contracts)

**Owns:** `test/dashboard.test.mjs`'s fetch-zero assertion (rewritten
to a named allowlist, §4.4) IF and only if Package B/D land in the same
merge window — otherwise this assertion must stay red-proof against
the OLD Astra page unchanged, since Astra keeps running until switch-
off. `test/english-only.test.mjs` needs no change (it already scans
everything new by walking `src/`/`bin/`/`test/`) but every new file's
comments must pass it before merge — this is verification, not a file
this package "owns" changing.

**Commitment:**
- Measure: `test/dashboard.test.mjs`'s fetch assertion, before/after.
- Baseline: `doesNotMatch(html, /\bfetch\(|.../)` — unconditional today.
- Expected change: becomes a named allowlist covering exactly Package
  B's new routes, nothing else.
- Abort criterion: if the allowlist would need a wildcard or a regex
  broader than an explicit path list, stop — that is the same
  "isolated test-weakening" trap lucky-mem's own document warns
  against in its §4.3.

**Red-proof:** the OLD assertion, run against the NEW page's HTML
(before this package's rewrite lands), fails exactly because the new
page has a fetch call — proving the old test really does catch this.
Positive control: the OLD assertion still passes against the OLD
Astra page, unchanged.

### Package F — Switch-off (does nothing until A-E are done and the owner approves)

**Owns:** removal/redirect of `astra.mjs`, old `dashboard.mjs`
(renamed to avoid the collision with Package A/C's new file — resolve
the name collision explicitly, do not let two files both be called
`dashboard.mjs` even briefly), `board.mjs`, `pages.mjs`'s consumers
if superseded, `bin/mem-serve`'s old routes. **Not started** until this
document's mapping (§2) shows every "available"/"must be built" row
landed and the owner has signed off per the task's own precondition.

---

## 6. Open questions for the owner

1. **three.js + DM Sans vendoring.** This is a second and third
   deliberate exception to cheap-mem's "zero dependencies, no CDN, no
   second file" test-enforced rule (§4.1), on top of the DM-Sans-from-
   Google-Fonts exception already made 2026-09-16. Approve vendoring
   (recommended, matches lucky-mem's own choice and keeps both houses
   visually identical) or specify a lighter substitute?
2. **Route names — confirmed collision, not just a risk.** Checked
   2026-09-28 directly against lucky-mem's source: `src/dashboard.mjs`'s
   `WEGE` (paths) object hardcodes `seite: '/dashboard'` and
   `daten: '/dashboard.json'` (lines 28-29) — so mirroring lucky-mem's
   own path exactly is not optional if the two houses' URLs are meant to
   line up, but `/dashboard.json` is ALREADY cheap-mem's existing route
   for the OLD Astra page (`bin/mem-serve`'s `PATHS`, verified above) and
   `/dashboard` is free (Astra sits at `/`). Recommendation: the new page
   takes `/dashboard` + `/dashboard.json` exactly as named, and the OLD
   Astra page's `/dashboard.json` route is renamed (e.g. `/pult.json` —
   `/pult` already exists as an alias per `PATHS`, so extending it costs
   nothing new) BEFORE Package B lands, not after — a mid-build rename
   of a live route is exactly the kind of two-truths risk this document
   flags elsewhere (§4.1 "console.mjs's own header comment"). This is a
   sequencing decision for the owner, not a detail Package B can infer.
3. **Raw-capture delete over HTTP.** Today this is CLI-only, with a
   `--reason`/`--by`/`--yes` guard. Exposing it over HTTP is the single
   largest new write surface this port introduces (§2, §5 Package B).
   Confirm the owner wants this in the browser at all, versus staying
   CLI-only with the dashboard only showing (never deleting) raw
   captures.
4. **`mem board`'s fate.** No mockup counterpart exists. Fold fully
   into the new Desk-equivalent view, keep as a CLI-only text tool, or
   something else?
5. **Books/digests, Fasser/capture-yield, Context/live-injection.**
   Three §2 rows where cheap-mem's own vocabulary does not map cleanly
   onto lucky-mem's mockup concepts. Confirm the "not applicable" /
   "rename" calls in §2 before any code is written against them.
6. **Weekly/rolling measurement chart.** No persisted time series
   exists (`gauges.mjs` is per-run). Build one (new: what gets stored,
   how long it is kept, whether it needs its own retention/size limit
   given the append-only philosophy) or leave that mockup view as
   "not measured" permanently?
7. **PWA (manifest/service worker).** Explicitly out of scope for this
   port unless the owner asks — `icon.mjs` is ready for it, nothing
   else is. Confirm scope before Package C touches anything install-
   related.
8. **Cross-house sync mechanism.** `shared/invariants.jsonl` (26
   entries) and `shared/finding-map.jsonl` (72 entries) already exist
   as the agreed "assurance, not name-diff" mechanism between the two
   houses (`docs/invariants.md`). Recommendation: use the same
   mechanism for dashboard parity — a new invariant id per major
   dashboard behaviour (e.g. "four-state vocabulary never collapses to
   three"), written once, checked by each house's own test in its own
   language, rather than a shared module. Confirm this is the intended
   meaning of the `Parity: lm=yes|no|offen` trailer convention already
   used by this very task, or whether the owner wants something
   additional (e.g. a periodic "mirror test" that diffs the two
   houses' `PATHS`-equivalent lists by shape, not by name).
