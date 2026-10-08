# cheap-mem — complete capability reference

**Read this file and you have the whole system.** It exists because
three separate AI evaluations of cheap-mem reached wrong conclusions
from partial reads, and the pattern was always the same: a capability
that IS built was reported as missing, because the entry point did not
name it.

This is written for a reader that skims — increasingly a model, not a
person. Every capability is named in the inventory below before it is
explained, so a reader whose window covers only the first screens still
leaves with the complete surface. A person can take the same route:
inventory → the two or three sections that matter for the decision →
the verification commands at the end.

---

## 0. Inventory — everything, on one screen

| Area | What exists | Section |
|---|---|---|
| **Data model** | 15 entry types, typed links (4 kinds), topics, projects, append-only JSONL, one line = one entry | [1](#1-the-data-model) |
| **Provenance** | `author`, `authority` tiers, `origin.derived_from`, `origin.raw`, git history | [1.3](#13-provenance) |
| **Retrieval** | BM25 over weighted fields, curated thesaurus, learned tag graph, compound splitting, exact-identifier lane, MMR diversity, raw-capture reserve lane, recency bonus, optional embeddings fused by RRF, time-window search | [2](#2-retrieval) |
| **Truth over time** | `valid_from` / `valid_until`, `key`-tracked changing facts, `as_of` historical queries, staleness flagging, supersession via `replaces_id`, contradiction marking | [3](#3-truth-over-time) |
| **Conflict & authority** | authority tiers decide who may overrule whom, conflict detection and reporting, disputed claims kept visible rather than deleted, author-share limits against flooding | [3.4](#34-conflict-and-authority) |
| **Corruption & rollback** | broken-line counting (never silent skipping), epoch watermark detecting a memory that went backwards, semantics version, integrity checks over the replacement graph | [4](#4-integrity) |
| **Boundaries** | capability object as scope boundary, redaction before disk, structured-claims gateway (no prose emitted), resource limits and context quotas | [5](#5-boundaries) |
| **Automation** | 7 Claude Code hooks (session start, recall per message, recall per file edit, recall after a failed or failure-printing tool call, subagent start, answer check and capture at stop), one model call per few hours, watcher, git as sync | [6](#6-automation) |
| **Surfaces** | 85 CLI commands, 42 MCP tools, an HTTP viewer, a status board (`mem board`, text or one self-contained HTML page), a self-check (`mem doctor`) | [7](#7-surfaces) |
| **Multi-agent** | origin stamped on every write, error latches, heartbeats separating "dead" from "nothing to do", error broadcast into other agents' inboxes, procedures (a norm only a human can issue), open questions as a class of their own, neighbours shown at write time, an onboarding check that is evidenced rather than ticked, sources indexed without fetching, component-name resolution for the pre-edit hook | [10](#10-multi-agent) |
| **Measurement** | 17 benchmarks, an eval harness with a frozen reference run, 3943 tests | [8](#8-how-to-verify-any-claim-here) |
| **Deliberately absent** | usage counters, `confidence` floats, decay-as-deletion, graph database, LLM per fact, second temporal axis | [9](#9-deliberately-absent) |

**One-sentence positioning.** cheap-mem is a local, git-backed,
append-only fact store with model-free retrieval, temporal validity,
authority-based conflict resolution and a structured retrieval gateway
— built so the recall path costs no model call and no network hop.

---

### 0.1 Every module in `src/`

One line each, so a reader can tell what exists without opening the
directory. The section number in brackets is where it is explained.

| Module | What it is |
|---|---|
| `appointment-clock.mjs` | the calendar's clock: what is due now becomes a letter, exactly once (intent, letter, delivered, under a file lock; repair after a dead run; the cap; the daily proposal summary) |
| `appointment-invite.mjs` | the calendar outlet: reminders as RFC 5545 invitations over SMTP or the Google Calendar API (service account), journal with backoff and idempotence, secrets only from 0600 files, the doctor's `appointment-invite` state |
| `appointment-time.mjs` | points in time for appointments: any IANA zone, UTC stored, English expressions, repeats in wall time, clock-change rules |
| `appointment-today.mjs` | "Today in the calendar": the day list, the briefing text, the session-start line, the state of fired actions, the dashboard's overview |
| `appointments.mjs` | the calendar's store: append-only `appointments/`, the fold, who may do what, the plan, the caps (`docs/appointments.md`) |
| `agentledger.mjs` | counts agent job outcomes from the event log — never a claimed strength below 20 jobs for a group (`unknown (n<20)`) |
| `afterfailure.mjs` | X2b: the after-error occasion — what the PostToolUseFailure hook (`bin/mem-after-failure`, bash and PowerShell) asks and shows after a tool call really failed: parse the failure, pick the error and learning lanes, book the journal line with its reason |
| `agents.mjs` | registered agents: who exists, what each is for |
| `answercheck.mjs` | the Stop hook's last-answer check: patterns tied to a LOGGED error in this memory, never on suspicion, dropped once their own measured hit rate falls under 1 in 5 |
| `append.mjs` | the one place a JSONL drawer is appended to — guards against a fused line when the file did not already end on a newline |
| `askedlearn.mjs` | query words learned from recall misses: a miss the same session then fetched by id teaches the entry the words it was asked with, in any language (`mem asked-learn`, M18b) |
| `searchlevers.mjs` | Block H search levers, one switch `MEM_SEARCH_LEVERS` (`mem search-levers`): threshold by score gap (h3: a flat field of weak hits is withheld), context reorder (h2), short recall lines with counted loads (h5) |
| `questionsplit.mjs` | Block H lever h1: the question split into core words (searched) and common words (damped by-catch that does not count in coverage) |
| `expand.mjs` | document expansion: the field `asked_as` (8 to 12 everyday phrasings written at capture time, checked at write time), read by the search only behind the switch `MEM_EXPAND=1` (weight 0.3, half coverage, stop words stripped, its own index cache) |
| `archive.mjs` | the raw capture lives outside the repo — location, record, migration, export |
| `authority.mjs` | who is entitled to overrule whom |
| `atomicwrite.mjs` | the one way to write a state file: a unique temp file in the same directory, then `rename` (with a Windows retry) — a reader never sees half a file, two writers never share a temp file (F5, suggestion 14) |
| `backlinks.mjs` | an incrementally maintained index — id -> every entry that points at it by a declared edge, across every drawer and project (E1.4); read by `getEntryFast()` and `mem-serve` |
| `basis.mjs` | on what basis a statement stands: stated, measured, inferred, guessed — a mark, never a number |
| `bashtargets.mjs` | which files a shell command WRITES (`sed -i`, `tee`, `> file`, `cp`, `mv`), read deterministically for the before-edit hook on Bash; directories, extension-less words, expansions, `/dev` and `/tmp` give no target |
| `bidi.mjs` | the nine Trojan-Source bidi-override characters (CVE-2021-42574), neutralised at display time — `mem find`, `mem browse`, `mem context`, the retrieval hook |
| `board.mjs` | the operating state on one screen (10.17) |
| `bodyfields.mjs` | O2: the ONE source for which fields carry an entry's content, per type and in reading order — every display and the set of indexed fields read it; a leaf with no imports |
| `body-reader.mjs` | audit F21: the ONE bounded body reader of the dashboard server's writing routes — counts bytes including the current chunk, refuses a too-large Content-Length unread, and delivers exactly one of `ok` / `too-big` (the caller answers 413) / `aborted` |
| `broadcast.mjs` | an error goes into the inboxes of whoever it will hit (10.5) |
| `browse.mjs` | the interactive search that re-ranks as you type |
| `capability.mjs` | scope as a boundary, not an argument (5) |
| `chain.mjs` | a per-writer hash chain over the append-only logs — catches a rewrite that survives a commit, which a git-diff check alone cannot |
| `chatgptimport.mjs` | `mem raw import-chatgpt`: a ChatGPT data export (ZIP or `conversations.json`) in as raw captures — one per conversation, current branch only, redacted before disk, no model call, idempotent by conversation fingerprint + `update_time`, continuations file only the new part, `--dry-run` counts and writes nothing ([6.1](#61-importing-a-chatgpt-history)) |
| `checkrecord.mjs` | the tracked, append-only proof (`checked.jsonl`) that a full `node --test` run was green for a given tree — one tier, no local machine-only stamp (Bauplan P1) |
| `claim.mjs` | taking over a message with an expiry: append-only claim/done/failed lines, first unexpired claim counts, a second one stays visibly invalid, resumption after expiry; git is not a lock (X4) |
| `clihelp.mjs` | what the CLI dispatches, what its help advertises, and where the two have drifted apart |
| `clock.mjs` | clock skew between writers, measured from the log itself, never used to reorder anything |
| `closingreport.mjs` | X2b: the task-end occasion — the Stop hook reports the open duties written in this session (a systemMessage, never a block; capped, once per duty; filtered from `today.decisionsForHuman`, no second count) |
| `commandguard.mjs` | the command guard (lever-5 port): an error of the class `mishandling` may carry a `command_pattern` (`mem log error ... --command-pattern "git add -A$"`); the before-edit hook on Bash warns once per session and error when a command matches, never blocks, behind a shell prefilter that starts node only on a keyword hit; derived booklet under `.pipeline/command-guard/`; `mem command-guard build\|show\|check\|seed` (10.30) |
| `component-table.mjs` | an offline-built register — every git-tracked path and exported symbol to the entries that mention/guard/fix it — so `mem component --table`/`--hook` (the pre-edit hook) can look up instead of scanning; R-Tab parity with lucky-mem |
| `component.mjs` | one file, across both spellings (10.14) |
| `config.mjs` | participants, defaults, the memory's own settings |
| `console.mjs` | the console: state, settings, connections (7.4) |
| `dashboard.mjs` | the old desk's data collector, still the first pass under the dashboard's data (7.5) |
| `dashboard-cache.mjs` | `/dashboard.json` from a cache: generation stamp (drawers, git reflog, local sources), background rebuild in a worker thread with a heap cap the parent enforces, cold start from the head on disk or a placeholder, age counted from the end of the build, never stale as fresh (`cache.fresh`/`refreshing`/`reason`/`source`) (7.5) |
| `dashboard-head.mjs` | the first answer of `/dashboard.json`: newest entries + server-side counters (`overview`), the rest paged through `/dashboard/part.json?part=entries`; the head kept on disk without free texts (0600, atomic); the light head only as the quick first state of a store the full build still handles |
| `dashboard-pass.mjs` | ONE pass over the drawers for a store the full build cannot handle: line total, overview, net, open questions, agents, projects, the newest entries and the condensed 3D atlas (the 240 largest topics, drawers, pair counts, the newest 60 entries of each as the first page); fingerprint table of about 14 bytes an entry, no entry list in memory; `/dashboard/part.json?part=atlas` pages it 60 at a time |
| `dashboard-compact.mjs` | the compact build above the full-build line (replaces the light head): the pass plus the same `collectDashboard()` as the full build; modules that read the whole store themselves (integrity, duties, facts, topics, learnings) run up to 128 MB of drawers, above they are unknown with a reason; the doctor and today never run there |
| `dashboard-data.mjs` | the dashboard's DATA layer: `/dashboard.json`, one entry, one message, the read-only retrieval probe, facts at a date (7.5) |
| `dashboard-page.mjs` | the dashboard's page shell; the views are drawn in the browser from `assets/dashboard/` (7.5) |
| `measurements.mjs` | the dashboard's weekly measurement series, at most 52 weeks, written only by a running server (7.5) |
| `pwa.mjs` | the dashboard's manifest and service worker, which stores nothing unless asked to (7.5) |
| `login.mjs` | the password in front of the dashboard: first setup only with a machine-local code, scrypt hash, server-side sessions, lock after failed attempts (7.5) |
| `digestselect.mjs` | which pending captures one digest run gets: an age reserve for the oldest first (`MEM_DIGEST_AGE_RESERVE_PCT`, default 25 % of the cap), then smallest first; read by `bin/mem-digest` and its PowerShell port |
| `docimages-state.mjs` | W7: the ONE list of UI files the docs screenshots depend on, the writer `bench/docs-images.mjs` calls after shooting (`docs/images/.state.json`, sha256 per file) and the check behind doctor finding `docs-images-fresh` (no state -> unknown; older than the UI -> warn with the one reshoot command; never reshoots itself) |
| `integrationcontract.mjs` | X2: the integration contract as data — five occasions (session start, task start, before a change, after an error, task end) by three clients (Claude Code hooks, MCP, plain CLI), each cell full/partial/missing with its evidence (file, installer registration, tool name), what is delivered/retrieved/considered and what is measured; the doctor's `integration-contract` finding and the generated block of `docs/integration-contract.md` read only this |
| `doctor.mjs` | the self-check: configured, missing, or merely unknown |
| `effect.mjs` | did an injection get used? Share of (injection, entry) pairs named/opened/edited again within 30 minutes, with a Wilson interval, floored at 1000 pairs (`mem effect`, M5 parity) |
| `embed-hook.mjs` | embedding on write, without blocking the write |
| `envelope.mjs` | what a message intends (information/request/read/result/clarification/cancel), its reply turn, and THE one rule whether it may wake a model (10.28) |
| `entity.mjs` | machine-shaped identifiers: exact, not similar (2) |
| `entryops.mjs` | restore and merge as append-only operations: `mem restore` (a closed entry taken up again as a NEW line with `restored_from`) and `mem merge` (a correction of the first entry carrying `merged_from`, obsolete tombstones for the rest) — no line is ever rewritten (Bauplan P3) |
| `entries-page.mjs` | `GET /entries`: the paged entry list rendered as a server page (same filters, cursor and `pages.page()` as `/entries.json`), a plain GET filter form and a next-page link, no script, nothing loaded from outside (D3b) |
| `environment.mjs` | the guarantees cheap-mem does NOT provide itself |
| `envregister.mjs` | the register of every environment variable cheap-mem reads (default, meaning, kind), a scan that finds each read in `src/`, `bin/`, `install/` and `hooks/`, and the generated table of `docs/environment-variables.md`; `mem envvars`. A read without a row, or a row nobody reads, fails `test/envregister.test.mjs` |
| `epoch.mjs` | noticing that the memory went backwards (4) |
| `errorclass.mjs` | the closed vocabulary of twelve error classes (10.16) |
| `errorcontext.mjs` | `mem log error`'s file history (max 3) and the auto-duty it opens on a real repetition, one per file+class |
| `errorfile.mjs` | which file an error concerns: an explicit field first, else the path pattern |
| `errorfixes.mjs` | errors linked to their fixes and lessons on the existing link drawer: commit trailer `Fixes: <id>` -> `resolves` (`mem error-fixes backfill`), `mem log learning --from <id>` -> `generalizes`, notes at write time, doctor `error-linked` (10.26) |
| `errorsignature.mjs` | a line-anchored failure signature in Bash output, for a hook to catch what an exit code hid |
| `experience.mjs` | the experience of a skill/workflow/snippet/procedure inside its DECLARED scope: account (traps, fixes, learnings), the causality gate, the sharpening package (proposal only), versions as trial correction lines (owner only), review marks, test<->error guards, procedure effect; doctor `skill-sharpen`, `guard-suspicion`, `procedure-effect` (10.29) |
| `filelock.mjs` | one small leaf lock for read-modify-write on a file (`withLock`): O_EXCL lock file with pid and host, bounded wait, a lock whose holder is provably dead (gone, or a zombie) taken over at once, otherwise by age only, nesting throws — used by the keyring, the drawer append/archive and the component-table rebuild |
| `processalive.mjs` | does a process really live? `kill(pid, 0)` also succeeds for a zombie (`<defunct>`); on Linux the state in `/proc/<pid>/stat` counts (`Z`, `X` = dead) — read by the file lock's orphan takeover and the doctor's running-code check |
| `findingmirror.mjs` | which doctor findings this house knows and the sister house does not — mapped pair, reasoned one-sided, or unjudged |
| `fulltext.mjs` | full-text search behind the knowledge view's search field: `GET /api/fulltext?q=` returns the ids whose WHOLE entry (every string field, tags, nested) contains the query; index kept per store state under the dashboard cache's generation stamp; a failure is `measurable:false`, never an empty list (7.5) |
| `freshness.mjs` | living facts, deterministic, no model (3) |
| `frozenset.mjs` | a really immutable set (`has`/`size`/`values`, no `add`): `Object.freeze(new Set())` freezes only the wrapper object, not the contents |
| `gap.mjs` | N18 parity: a retrieval miss the injection journal recorded, later matched by content-word overlap with a NEW entry, is a closed knowledge gap — produces `kind:'gap'` candidates for `goldlog.mjs`'s file, shown first on the "Rate today" card |
| `gauges.mjs` | three numbers about retrieval: occupancy, sufficiency, allocation |
| `guard.mjs` | a recorded error becomes a latch (10.2) |
| `guardgaps.mjs` | ranks the errors that have NO guard (`mem guard gaps`): a guarded error is a filter, never a gap; repetition, an open duty and age only order the unguarded ones; reads, writes nothing |
| `heartbeat.mjs` | running, or just nothing to do (10.3) |
| `hybrid.mjs` | BM25 and semantic recall, fused by RRF (2) |
| `icon.mjs` | the mark, drawn in code |
| `inbox.mjs` | cross-session messages |
| `indexcache.mjs` | the search index cache as shards, never as one JSON string — the old cache broke past ~978,000 entries |
| `injection.mjs` | the journal of what the hook put into a turn, and what it did not |
| `integrity.mjs` | what is wrong with the log itself (4) |
| `ismain.mjs` | "was this module started as the program?" by real path, so an entry point under a symlinked directory (every macOS temp dir) still runs instead of silently doing nothing |
| `langdetect.mjs` | cheap, deterministic per-entry language detection — one memory can hold German and English text without a mismatched stemmer |
| `language.mjs` | stemming and stop words, per language |
| `langbridge.mjs` | optional starter dictionaries from the language a person asks in to the language the agents wrote in, as files (`src/langbridge/*.tsv`), off by default (`languageBridges` in `.mem/config.json`, M18b) |
| `latencybudget.mjs` | ONE latency budget per recall-hook occasion over the injection journal's `duration_ms`: p50/p95, four states, under 20 timed lines unknown — the doctor's `hook-latency` finding and the dashboard's hook-time panel read only this (Bauplan P2) |
| `mailpermit.mjs` | the user's permission and budgets for waking messages, as an append-only ledger with estimated token spend (10.28) |
| `maintenance.mjs` | content-hash deduplication: identical entries merge, highest authority stays active |
| `mcplive.mjs` | a real `tools/list` probe of the local MCP bridge — cached, run in the background, never awaited by `/dashboard.json` (7.5) |
| `mcpprofile.mjs` | the read-only bridge profile: unknown counts as writing |
| `mcpvisibility.mjs` | which MCP client saw or called which tool, and when — name, client, time only, never call content, machine-local under `.pipeline/` (7.5) |
| `memory.mjs` | the log itself: types, entries, links, topics, projects (1) |
| `missgold.mjs` | a LOCAL, git-ignored file (`.mem/local/miss-gold.jsonl`, 0600) with the question text of real recall misses, read off the same vetted evidence as `askedlearn.mjs`; scored from 20 cases on (rank 1, top-K, MRR), never a number below that; cases the paraphrase learner already used are left out; numbers-only output; collected at most once per UTC day by the digest tick (`mem gold miss collect|daily|status|score`) |
| `modelcost.mjs` | reads the token/cost fields a headless `claude -p --output-format json` run already returns; machine-local, never a second model call (7.5) |
| `neighbours.mjs` | what stood next to this at write time (10.8) |
| `net.mjs` | what points at what — from declared links, not from similarity |
| `netderive.mjs` | derived links, apart from the declared ones: pairs sharing rare terms and a file (auto, dashed in the atlas) or strong rare terms alone (borderline, listed for a human, never decided); deterministic, no model, nothing written (`mem net --derived`, dashboard `net.derived`) |
| `observations.mjs` | per-machine ledger of what was shown — never read by retrieval or ranking |
| `onboarding.mjs` | evidenced, not ticked (10.9) |
| `outputguard.mjs` | the output guard: every render path (find, show, when, context, retrieve, viewer, recall hook, MCP bridge, read commands) masks known key shapes as `[REDACTED:type]` through `redaction.redact` before any cut; the line on disk is untouched |
| `pages.mjs` | filtered, cursor-paged lists over the drawers — never the whole desk (`/entries.json`, E1.3) |
| `parity.mjs` | the parity core (mem-admin_02 L5/W9): the cutoff, the `Parity:` trailer shape, merge coverage, addenda, and the W9 debt list against the sibling house — `bench/parity.mjs` is the thin CLI over this |
| `origin.mjs` | where the session ran (cloud, ssh, local, unknown): the closed vocabulary of the injection journal's `origin` field; `raw.detectSurface` asks here |
| `pathcheck.mjs` | do the paths named in entries still point anywhere — per project, against ITS tree |
| `pointer.mjs` | a pointer instead of silence when something was already shown |
| `posixmode.mjs` | what a file mode may be claimed to say: POSIX bits are judged on Linux/macOS, and on Windows (where stat says 0666 and chmod does nothing) every report says "not checkable on this platform" instead of a verdict; `platform` is a parameter so the Windows answer is testable on Linux; used by `missgold.mjs` and `login.mjs` |
| `prepush.mjs` | the opt-in pre-push WARNING: before a push to the default branch, asks CI (via `gh`) whether that exact commit has a green run — green/red/pending/none/unknown, never blocks, never says green without CI saying so ([6.2](#62-the-pre-push-ci-warning)) |
| `probescaffold.mjs` | an error logged with `--file` gets its own test scaffold — marker, sabotage/positive-control/red-on-old-stand `test.todo` sections, empty never counted as passing or as F4 evidence (10.2) |
| `procedure.mjs` | a norm only a human can issue (10.6) |
| `profile.mjs` | switchable measuring points that land in the ordinary log — finds where time went without a hand-written report script |
| `provenance.mjs` | which clone answered, and how old it is; STALE only when older than 90 min AND behind origin or lag unknown (an old but level clone is fresh); wired as doctor finding `provenance` (`behindOrigin` is also what `behind` uses) |
| `question.mjs` | what we do NOT know (10.7) |
| `raw.mjs` | capture, drop filter, digest bell, pending work |
| `readview.mjs` | the offline reading view: the project package as ONE self-contained HTML file (`project-package.json?format=html`) with search, list, detail and references, no network call, no outside address; encrypted entries stay encrypted |
| `recallattach.mjs` | two attachments to recalled lines (L3, L4): the newest valid solution (`resolves` link or commit proof) as ONE line `↳ Solution <id>: <core>` directly under a shown error (question, after-failure, before-edit, subagent), and the two most important lines of a skill's experience account under a skill offer; never encrypted or `personal` entries; `MEM_SOLUTION_ATTACH=0`, `MEM_SKILL_ACCOUNT_OFFER=0` |
| `recallhook.mjs` | Z1c: what `bin/mem-retrieve` and `bin/mem-catch-fail` (bash and PowerShell) hand their work to: decide short prompts, claim the turn, print the answer, book the journal line AFTER the write |
| `recallrender.mjs` | Z1c: the one renderer of the recalled lines — real content from `retrieval.BODY_FIELDS`, the entry ID per hit, cuts on a sentence or clause boundary with a visible marker |
| `recallserver.mjs` | M10: the warm recall server `mem serve` starts — a Unix socket (Windows: named pipe plus marker file `recall.pipe`; POSIX modes not checkable there) under `.pipeline/recall/`, key file 0600, that runs the SAME `find` handler as `mem find --json`; answers `stale` and stops listening when `src/` changed |
| `recallserver-place.mjs` | M10: where the recall server listens and the client's exit codes — Node built-ins only, so the per-turn client (`bin/mem-retrieve-client.mjs`) never loads the search path |
| `recallserver-keeper.mjs` | M10: runs the recall server as a child of `mem serve` and starts it again with a fresh import after a code change — at most once per 60 s, one log line per restart |
| `recallsignal.mjs` | Z1c: does a short prompt carry a search signal? An ID, a file name, an error code or a rare word searches; confirmations never do; deterministic |
| `redaction.mjs` | secrets removed before anything reaches disk (5) |
| `release.mjs` | the release rail for a service install: a frozen, verified `git archive` copy, rollback, the active code path — gated on a matching `checked.jsonl` row (Bauplan P1) |
| `repetition.mjs` | is this error a repeat? same file+class in 30 days, or the same class 3x in 7 |
| `repetitionhint.mjs` | from the third repetition of an error class or normalised title, prints a draft for `mem log procedure` (`mem suggest procedure`); quotes the newest error, no model, writes nothing |
| `routes.mjs` | which registered session of a role a message is for: registered on pickup, by fingerprint, never the raw session id (10.28) |
| `retrieval.mjs` | the gateway: structured claims out, never prose (5) |
| `rewrites.mjs` | the learned rewrite table, read side: question word -> entry word from vetted misses, active from 2 sessions, decays after 90 days, lockable per pair, weight 0.5 below thesaurus and bridge, switch `MEM_REWRITES=off`, shipped empty (`mem rewrites`) |
| `rewritecare.mjs` | the rewrite table's write side: turns `mem asked-learn` cases into pairs, append-only to `.mem/rewrites.jsonl` (`mem rewrites care --write`) |
| `projectnew.mjs` | a NEW project, the guarded way: `mem project new` refuses a name too like a project or a topic alias (distance, word part, spelling) and names the existing one, writes a reason and an event, marks `facts.yaml` `status: new` until a person confirms (`mem project confirm`); an unattended run needs 2 evidenced captures on 2 days; `mem project suggestions` is the dry run and also lists projects made past the command (`handmade`: folder and entries after 2026-10-02, no creation event, no status), which `mem project confirm` accepts too; `mem log --project <unknown>` is refused. Merging two projects is not built (see the head of the file) |
| `categories.mjs` | categories ABOVE topics, shipped empty: four append-only tables under `global/` (`categories`, `topic-category`, `category-aliases`, `category-wishes`), applied on read; `mem category list/open/assign/confirm/create/acknowledge/rename/merge`; a new category creates itself from 3 different topics with the project-name similarity protection (a near-duplicate lands on the existing one, a project name is refused); `mem find --category`; the doctor finding `categories`; `categories` and `topics.list[].category` in the dashboard data. `create --suggested` adopts a neutral starter list, nothing is baked in |
| `categories-initial.mjs` | `mem category initial-assign`: deterministic keyword rules propose a category for topics without one (clear lead only, never guessed); a person confirms |
| `projectpackage.mjs` | the project package export behind the "Load JSON package" button in the dashboard's export studio (Sources → Export studio): same selection as the preview, plaintext through redaction, encrypted entries stay ciphertext, raw captures/mail/file bytes/keys excluded, "why" only from raw lines (`GET /dashboard/project-package.json`) |
| `runningmark.mjs` | W1 parity: an atomic start marker (`.pipeline/running/<service>.json`) so `doctor.checkRunningCode` can tell whether `mem serve`/`mem-mcp --http` still run the code they started with (Bauplan W1) |
| `search.mjs` | BM25, thesaurus, tag graph, the index |
| `semantics.mjs` | which rules produced this state (4) |
| `setup.mjs` | the five steps between installed and working (10.12) |
| `shardarchive.mjs` | P17: splits the raw-capture body across shards so git never has to carry one multi-GB blob |
| `shortline.mjs` | the one-line entry summary of the MCP tools (`mem_component`, `mem_links`, `mem_facts`, ...), procedure mark and bidi latch included, body fields from `bodyfields.mjs` |
| `shred.mjs` | per-entry body encryption plus a small, NOT append-only keyring — a real deletion without rewriting history |
| `shrink.mjs` | an append-only memory must not get smaller |
| `sibling.mjs` | where the sister house's clone lives, if it sits beside us at all — dependency-free so nothing that needs it has to import `doctor.mjs` |
| `skillusage.mjs` | W10: which skills get used — Skill tool calls and /command marks counted from the raw-capture archive, always with coverage; a skill without a hit is "not observed", never "unused"; names and counts only, never removes anything (`mem skills usage`, finding `skill-usage`) |
| `skillregistry.mjs` | ONE registry over skill, workflow, snippet and procedure with a status (`proposed`/`trial`/`released`/`withdrawn`, plus `unknown` and `draft`) from `procedure.mjs`; status lines are history, only a human writes them; exports to Claude Code `SKILL.md` (marker file, never `~/.claude`) and one text file; the hook offer (`mem skills list|export|status|fetch`, MCP `mem_skill_find`/`mem_skill_fetch`) |
| `skilleffect.mjs` | the rate "offered -> fetched" of the hook's skill offer from the injection journal and the raw capture, with a minimum count and a Wilson interval; below it unknown, never 0; an offer counts as observed only when the capture began before it AND reaches past its window, pieces only as far as they join (`mem skills effect`) |
| `skillcatalog.mjs` | the dashboard's "Skills & procedures" catalogue from the registry: groups, history per entry, installed `SKILL.md` files and drift (`GET /dashboard/skills.json`; status change only via the `skill-status` task with a password session) |
| `snippet.mjs` | a reusable code/script/text/mail/letter block WITH PLACEHOLDERS — a `text`/`mail`/`letter` body must clear redaction before write (10.27) |
| `source.mjs` | knowledge that already exists, indexed rather than copied (10.10) |
| `state.mjs` | the derived state, and nothing else derives it |
| `statequestion.mjs` | freshness for questions that ask "what holds now": a state signal word ("current", "still", "latest", ...; file/config-extensible, English default) dampens older same-`topic` hits among a query's own results — the newest, and anything with no readable `ts`, untouched (M9 parity) |
| `store.mjs` | generated files provable by hash, without bloating the repo |
| `stores.mjs` | the usual places people keep files, found by name (10.11) |
| `subagentstart.mjs` | the SubagentStart hook: any procedure tagged `subagent-start` (a norm only a human can issue) plus a context recap, capped, plus the block for the assignment (`subagenttask.mjs`) |
| `subagenttask.mjs` | the assignment text of a subagent (read, fail-soft, from its own transcript; the hook input documents none) and the choice of what the memory hands it FOR THAT TASK: at most 4 hits and 1,500 bytes of errors (with their solution line), learnings, duties, procedures and skills, found by the files and content words of the task; nothing encrypted, `personal` or naming a person |
| `switches.mjs` | which switch names the CLI keeps for itself, and how close a typo may come |
| `tasks.mjs` | long CLI work as tasks — progress/result/cancel over a real child process (E1.7, 7.4) |
| `teach.mjs` | what the memory has to say to a newcomer, in five sections |
| `today.mjs` | one source for "what does the owner need today" — `mem today`, the dashboard's Today card and the session-start line all read this; part (f) lists the projects awaiting a person's confirmation (7) |
| `thesaurus.mjs` | curated word groups plus what the memory learned |
| `timeexpr.mjs` | natural language to a time window |
| `timesearch.mjs` | retrieval by time window, no model |
| `userhabits.mjs` | generic, code-only habit meter over the user's own captures, configurable patterns (`mem user`) |
| `goldlog.mjs` | the owner's rating of a real retrieval question (hit / near miss / no hit, from the journal's recorded reason — no invented scores), appended OUTSIDE the memory root; `mem gold today`/`mem gold rate` and the dashboard's Rate-today card share it (7.5) |
| `variants.mjs` | variant fusion: up to 4 rewordings the CALLING agent writes are each searched with the same options and merged by Reciprocal Rank Fusion; the score stays a real search score; no model in the recall path (`mem find --variants "a\|b"`, `mem_find` field `variants`) |
| `verifylog.mjs` | a human's verdict on an uncertain fact, appended OUTSIDE the memory root — never a correction, never inside the repo (7.5) |
| `viewer.mjs` | one self-contained HTML page to rummage through it all |
| `webauth.mjs` | the door in front of any HTTP service (7.4) |
| `workflow.mjs` | a named SEQUENCE for all — same authority question as `procedure`, same answer: only a human issues one, the bridge never writes it (10.26) |
| `workflowdetect.mjs` | finds the visible workflow (human, in force, no draft) for a prompt, a subagent assignment (`triggers`), a Bash command (`tool_patterns`) or a file (`path_patterns`, table role `works-on`); a tie shows titles only (10.26) |
| `writegate.mjs` | the dashboard write switch: off by default, one check in front of every writing route (7.4) |

Plus `src/embed/` — the optional embedding lane (provider, store,
index), which is off unless configured.

---
## Read this first if you are evaluating cheap-mem

These five claims are the ones evaluators have gotten wrong. Each names
where to check.

1. **"No relationship system."** Wrong. `link` is one of the 15 entry
   types, with a closed vocabulary of four edge kinds
   (`causes`, `generalizes`, `contradicts`, `resolves`).
   `src/memory.mjs` → `LINK_KINDS`, `linksOf()`; CLI `mem links <id>`;
   MCP `mem_links`. The vocabulary is closed **on purpose** — see
   [1.2](#12-links).
2. **"No temporal modelling."** Wrong. `valid_from` / `valid_until` per
   entry, `key`-tracked fact versions, and `retrieve({ asOf })` for
   "what held then". `src/freshness.mjs`, `src/retrieval.mjs`.
   What is genuinely absent is the *second* temporal axis (belief
   time) — see [9](#9-deliberately-absent).
3. **"No importance or salience signal."** Present, but not as a
   number a writer sets: `standing()` counts how many other entries
   cite this one. `src/memory.mjs`; CLI `mem experiences`; MCP
   `mem_experiences`. Why citations and not a `confidence` field:
   [3.5](#35-standing).
4. **"Text in, text out — no structure."** Wrong at the gateway.
   `retrieve()` returns typed claims with id, author, authority tier,
   scope, validity window and score — never a prose blob.
   `src/retrieval.mjs`; MCP `mem_retrieve`.
5. **"Missing feature X."** Check [9](#9-deliberately-absent) before
   concluding oversight. Six capabilities are absent by decision, each
   with the reason and with what would change our mind.

---

## 1. The data model

### 1.1 Entry types

Fifteen drawers. The split is not episodic/semantic — it is **what you
will need it for later**, which is the more useful axis in practice.

| Type | File | Holds |
|---|---|---|
| `decision` | `decisions.jsonl` | a choice, with the reason for it |
| `error` | `errors.jsonl` | something broke, and why |
| `event` | `events.jsonl` | it happened: a release, a hire, a start |
| `timeline` | `timeline.jsonl` | a fact that changes over time |
| `thought` | `thoughts.jsonl` | reasoning worth keeping, not yet a decision |
| `learning` | `learnings.jsonl` | what to do differently next time |
| `duty` | `duties.jsonl` | something owed to someone |
| `question` | `questions.jsonl` | something we do NOT know — no debtor, closes over an existing `resolves` edge (see [10.7](#107-open-questions--srcquestionmjs-mem-questions)) |
| `skill` | `skills.jsonl` | a capability acquired, with evidence |
| `procedure` | `procedures.jsonl` | a norm for ALL — only a human can issue one (see [10.6](#106-procedures--srcproceduremjs-mem-procedures)) |
| `source` | `sources.jsonl` | a pointer at knowledge that already exists — indexed, not copied (see [10.10](#1010-sources--srcsourcemjs-mem-sources)) |
| `update` | `updates.jsonl` | a version, a dependency, a config change |
| `link` | `links.jsonl` | a typed relation between two entries |
| `workflow` | `workflows.jsonl` | a named SEQUENCE for all — the same authority question as `procedure`, same answer (see [10.26](#1026-workflows--srcworkflowmjs-mem-log-workflow)) |
| `snippet` | `snippets.jsonl` | a reusable code/script/text/mail/letter block WITH PLACEHOLDERS, never real data (see [10.27](#1027-snippets--srcsnippetmjs-mem-log-snippet)) |

One JSON object per line. Files are append-only: nothing is ever
rewritten in place. A correction is a **new line** carrying
`replaces_id`.

`duty` is the only type with a lifecycle, and even closing one appends
a line rather than editing the original.

### 1.2 Links

Four edge kinds, and the vocabulary is **closed**:

| Kind | Meaning |
|---|---|
| `causes` | the source brought the target about |
| `generalizes` | the source is the lesson drawn from the target(s) |
| `contradicts` | the source and target cannot both be right |
| `resolves` | the source closed the target out |

**Why closed.** An open vocabulary lets every digest run invent a new
verb, and a graph whose edges mean whatever the writer felt that day
cannot be traversed by code — only re-read by a model, which is exactly
the cost this design exists to avoid.

`contradicts` is load-bearing for falsifiability: it **flags** a claim
rather than deleting or quietly weakening it, so the claim keeps
standing in the open with its challenge attached.

Note that these are edges between **entries**, not between entities.
Entity-level relations (`works_on`, `depends_on`) do not exist — see
[9](#9-deliberately-absent).

### 1.3 Provenance

Every entry can carry:

- `author` — who asserted it
- `authority` — which tier they asserted it at (see [3.4](#34-conflict-and-authority))
- `origin.derived_from` — the entry ids this was distilled from
- `origin.raw` — the raw capture it came from
- `ts` — when it was written
- `valid_from` / `valid_until` — when it is *true*, which is a different question

Plus git: every line has a commit, an author and a date that the memory
itself cannot forge.

### 1.4 Topics and projects

A `topic` is a handle for a subject that keeps developing:
`architecture/auth-model` gathers a decision, later an error against it,
later a learning. `topicEntries()` reads the whole thread of ANY type,
newest first, with retired entries dropped. Topic aliases resolve on
READ — the line on disk stays as it was written.

Projects are directories: `projects/<name>/<type>.jsonl`, plus a global
tier. Scope is enforced by capability, not by convention — see
[5.1](#51-capability-scope-as-a-boundary).

---

## 2. Retrieval

The whole design premise: **recall costs no model call and no network
hop.** Everything in this section runs offline, deterministically, in
milliseconds.

### 2.1 The default lane — BM25, and what is layered on it

- **Weighted fields.** Title, class, topic, text and tags do not count
  equally.
- **Curated thesaurus** plus a **tag graph learned from the user's own
  entries**, so a query finds things worded differently without an
  embedding model.
- **Compound splitting**, which matters in German and in identifiers.
- **Recency bonus**, bounded: at most +15 %, fading with `exp(-age/90 days)` (about a third left after 90 days).
  Deliberately weak — recency is a hint, not a truth claim.
- **MMR diversity** by default, so the top-k does not fill with
  near-duplicates. `--no-mmr` restores pure BM25 order.

- **Document expansion, off by default (`MEM_EXPAND=1`).** The digest model
  writes `--asked-as` (8 to 12 short everyday phrasings) next to each entry;
  with the switch on the search indexes them at weight 0.3, counts a word the
  entry carries only through them as half a typed word, and keeps them out of
  the gate's "whole question covered" rule and out of the exact-identifier lane.
  Off, the field is never read and the index is bit-identical. Measured in
  branch `agent/expand-gemini-cm` (`bench/expand-gemini/results.md` there); `src/expand.mjs`.

### 2.2 The exact-identifier lane

A question about a path, a version, a ticket number or a service name
has **one** matching word, and the entry is short. BM25 scores that
low — measured on the eval corpus: gold at rank 1 in five of six cases,
and every score below the recall bar of 5.0. Correct ranking, nothing
delivered.

So exact identifier matches bypass the score bar entirely, and are
ordered among themselves by score. `src/entity.mjs`, `src/search.mjs`.

### 2.3 The raw-capture reserve lane

Undigested captures are indexed but held in **reserve**: they surface
only when nothing curated answers, and they are marked when they do.
This keeps a raw transcript from outranking a written-up finding.
There is no CLI flag for it: code calling `retrieve()` in `src/retrieval.mjs` can pass `rawReserve: false` to restore the old behaviour.

### 2.4 Optional semantic recall

Embeddings are **off by default**. `src/embed-hook.mjs` is the seam
where an embedding provider plugs in; `src/embed` holds the providers. When configured, `hybrid.mjs` runs
BM25 and semantic search and fuses the two rankings with Reciprocal
Rank Fusion — no score normalisation needed across the two very
different scales. With embeddings unconfigured, hybrid is exactly BM25
at exactly BM25's cost. **No silent dependency.**

### 2.5 Time-window retrieval

`mem when "last friday between 3 and 8pm"` parses natural-language time
expressions into a window and returns what was written in it, with
provenance. No model. `src/timeexpr.mjs`, `src/timesearch.mjs`.

### 2.6 Literal search

`--literal` is plain substring matching with no ranking. It is what the
pre-edit hook uses: a path query under ranked search always returns
*something* (the fragments are rare, so scores are high), and a hint
that appears on every edit gets ignored. Literal means: if no entry
names this file, nothing is shown.

### 2.7 The index

A gitignored cache — **never a source of truth**. It is appended to
incrementally rather than rebuilt on every new line, and the appended
index is asserted document-for-document identical to a rebuilt one.
Corpus-wide statistics (compound lexicon, learned graphs) drift between
full rebuilds, bounded by a rebuild fraction.

Measured limits are in [`scale.md`](scale.md): keep one memory under
~50,000 entries, because index **load** (not search) becomes visible
past that.

---

## 3. Truth over time

### 3.1 Validity intervals

`valid_from` and `valid_until` say when a claim is *true*, separately
from `ts`, which says when it was *written*. `valid_until` is
exclusive. `retrieve({ asOf })` returns what held at a point in time,
not what is recorded now.

### 3.2 Tracked changing facts

`timeline` entries that share a `key` are versions of one fact. The
newest `valid_from` wins; the rest are history, kept and marked. No key
means a one-off note, left alone. Facts that have gone quiet past a
staleness horizon are **flagged**, not hidden. `src/freshness.mjs`,
CLI `mem facts`, MCP `mem_facts`.

### 3.3 Supersession

A correction is a new line with `replaces_id`. The superseded entry
stops being returned as current but stays readable, and the chain is
walkable. `src/integrity.mjs` checks the replacement graph for cycles,
forks, dangling references and depth.

### 3.4 Conflict and authority

**Authority tiers**, not confidence numbers, decide who may overrule
whom. The reasoning, from `src/authority.mjs`: *a float nobody can
calibrate becomes a number everybody rounds to "probably fine", and two
0.7s from different pipelines are not comparable.* Tiers are comparable
because they are defined by WHO asserted — checkable — rather than by
HOW SURE someone was, which is not.

Before this existed, `replaces_id` was applied with no check at all:
any writer could retire any other writer's entry. That is the
poisoning primitive in a multi-agent memory — one line, and a decision
is gone.

**Where the guarantee ends, stated plainly:** `author` and `authority`
are fields in a file. Anyone with repository write access can write
both. This raises the cost of poisoning from ONE LINE to REPOSITORY
WRITE ACCESS. That is a real gain and it is not cryptography. Signed
commits would close it and are deliberately out of scope until someone
has the threat model that needs them.

Conflicts between claims are **detected and reported**, and both sides
stay visible. Author-share limits bound how much of one answer a single
author can occupy, so flooding cannot fill every slot.

### 3.5 Standing

`standing()` measures how well an entry is **backed**: how many other
entries lean on it, via `origin.derived_from` and link edges.

Why citations and not retrieval counts: a retrieval counter is written
where the reading happens, so two clones of one memory would hold
different numbers — git would stop being the source of truth. And it
would reward *popularity* over usefulness: the broadly worded entry
that comes back on every second query would beat the precise one that
answers exactly one question right.

**Honest limit, measured 2026-09-08:** on a real 1,594-entry corpus,
88 entries are cited at all, with a maximum of 3 citations. The signal
is real but thin. `standing()` therefore feeds `mem experiences` and is
**not** currently a ranking factor — see the roadmap note in
[9](#9-deliberately-absent).

---

## 4. Integrity

- **Broken lines are counted, never silently skipped.** A log that
  quietly drops what it cannot parse reports a state that is not the
  state.
- **Epoch watermark** (`src/epoch.mjs`): check out an older commit or
  restore a stale backup, and a claim that had been superseded is
  active again — from inside that state, everything looks correct. The
  watermark lives OUTSIDE the tracked tree (a gitignored local file),
  because any marker committed alongside the log travels back with it.
  It stores no memory content; delete it and you lose detection, not
  data.
- **Semantics version** (`src/semantics.mjs`): the same log plus the
  same semantic version always yields the same derived state. Change a
  rule that alters `replay(log)` and the number is bumped by hand, so a
  mismatch is visible rather than silent.
- **State separation** (`src/state.mjs`): the log decides what is TRUE;
  the index decides only what is FAST TO FIND. This was made structural
  after status once lived in the gitignored index — editing a cache
  changed what the memory considered active, in both directions.
- **Merge driver** for concurrent writers, so two sessions appending to
  the same log do not conflict.

---

## 5. Boundaries

### 5.1 Capability: scope as a boundary

Scope is an **object the caller must hold**, not an argument they may
omit. Before this, `search()` filtered by project only when a caller
passed one — omit it and one project's memories came back to another.

A required `scope` argument catches that omission exactly once; after
that `scope: 'all'` becomes the copy-paste default and is invisible in
review. A capability cannot be forgotten: reaching outside it is not a
missing argument but an object you do not have, and widening one is a
named function call that greps.

Scopes form a **lattice**, not a hierarchy — `global > org > project >
agent > session` cannot express "shared between two projects", which
the digest and the inbox both need.

**Where it ends:** this is in-process. A different process reading the
files directly is outside it.

### 5.2 Redaction before disk

Every incoming entry runs through redaction **before it is written**,
not at commit time. A git hook catches secrets at commit, which is
enough for a human who looks in between — not for an agent writing
every few seconds. If redaction's self-test fails, nothing is written
at all.

Layered: pattern matching, then comparison against actual environment
values, with a canary to prove the layer is live. Unicode bypasses are
closed.

### 5.3 The gateway emits claims, not prose

`retrieve()` returns structured claims. Nothing in it emits a
directive-shaped string; a caller who wants prose has to build it, at
their own authority, from labelled fields. One change addressing four
failure classes at once: injection, authority, scope leakage,
explainability.

`explainMissing()` answers the inverse question — why did an entry NOT
come back — naming scope, validity window, supersession or score.

### 5.4 Limits

Resource bounds and context quotas cap what a single retrieval can
return, so a flood cannot become a denial of service or a context bill.

---

## 6. Automation

7 Claude Code hooks, installed by `install/claude-code.sh`:

| Hook | When | What |
|---|---|---|
| `SessionStart` | session begins | prints `FACTS.md` + recent context |
| `UserPromptSubmit` | every message | recalls matching memory (no model, ~ms) and feeds it to the turn; refreshes the clone in the background, detached |
| `PreToolUse` (Edit/Write/NotebookEdit, and Bash when the command writes a file) | before a file changes | searches the memory for that PATH, literally, and shows errors, decisions and learnings naming it, plus open duties and released procedures for it — once per file per session |
| `Stop` | after a turn | captures the transcript (model-free) and persists it; checks the last answer against patterns tied to a logged error (see `docs/answer-check.md`) |
| `PostToolUse` (Bash only) | after a Bash call that exited 0 | when the call's own output carries a failure signature (`# fail 3`, `npm test \| tail`), recalls matching memory — the failure the exit code hid |
| `PostToolUseFailure` (Bash, Edit, Write) | after a tool call that really failed | recalls earlier errors and learnings of the same class, once per failure per session |
| `SubagentStart` | a subagent begins | shows the procedures tagged `subagent-start`, a context recap and — read from the subagent's own transcript — the errors, learnings, duties, procedures and skills that fit ITS TASK (4 hits, 1,500 bytes, nothing personal; `MEM_SUBAGENT_TASK_OFF=1`) — a subagent gets neither `SessionStart` nor `UserPromptSubmit` |

**Why the PreToolUse hook exists**, measured 2026-09-08: recall used to
hang only on `UserPromptSubmit`, so it fired when the person typed and
stayed silent through the building. Against four defects from one
Windows install, **three** had an entry naming the very file being
touched.

**The digest is the only model call.** It runs every few hours, reads
raw captures, and turns them into entries — the one thing code cannot
do. Capture and search run without it.

Sync is git. A watcher can drive the loop on a server.

### 6.1 Importing a ChatGPT history

`mem raw import-chatgpt <export.zip|conversations.json>` reads the
official ChatGPT data export (Settings -> Data controls -> Export data)
into the raw capture — the same lane the Stop hook fills. One capture per
conversation, the visible branch only (the parent chain from
`current_node`; a conversation without one is skipped, not guessed),
system/hidden/tool messages left out and counted, images and files as
placeholders. Redaction runs before anything is written, with the same
canary as capture. **No entry is written and no model is called**: the
next `mem digest` condenses the captures like any other session.

Re-running is safe: the record keeps a fingerprint of each conversation
(never its raw id or title) with its `update_time`, so an unchanged
conversation is skipped, a conversation that grew files only the new
messages, and an edited one files a new full version beside the old.
A capture deleted with `mem raw delete` does not come back. `--dry-run`
prints the counts (conversations, messages, left out, redaction
findings) and writes nothing; `--since <date>` limits by last update.

### 6.2 The pre-push CI warning

`mem hooks install --pre-push` (opt-in) adds a pre-push hook next to the
pre-commit one; in a cheap-mem checkout, `git config core.hooksPath hooks`
arms both. Before a push to the remote's default branch it asks CI
through `gh run list --commit <sha>` and prints one of five states:
green, red, pending, none (no run for that exact commit) or unknown (no
`gh`, offline, not logged in, not a GitHub remote). It **never blocks**
and never reports green unless CI said so. Why a warning and not the
sibling house's local "tested green" stamp: `src/checkrecord.mjs` explains
why this house keeps no machine-local stamp; CI is the independent
evidence, and a network answer that may be missing cannot carry a block.

---

## 7. Surfaces

### 7.1 CLI — 85 commands

```
init whoami inbox log find discard done when show raw digest duties
thesaurus embed hooks retrieve explain epoch doctor context facts
browse setup experiences links agents agent store topics topic core
viewer project correction version guard heartbeat questions answer
procedures broadcast onboarding sources component status board classes
bridge serve gauges shrink paths net teach maintenance observations
find-embed find-hybrid raw-capture topic-merge archive chain user ledger
asked-learn effect today modelcost gold skills restore merge supersede
gaps suggest search-levers rewrites workflow snippet error-fixes
experience command-guard appointment category envvars
```

`mem appointment` is the calendar: reminders, a day briefing and agent actions
planned for a time, fired by a clock that ticks inside `bin/mem-watch`, once, as
inbox letters; a human arms, agents only propose; an optional outlet puts
reminders into a real calendar (`docs/appointments.md`).

`mem gaps` lists open and closed knowledge gaps (a retrieval miss later
answered by a new entry) and `gaps rate` the weekly rate; `mem suggest
procedure <class>` prints a draft `mem log procedure` for an error class
that repeated three times, and writes nothing.

`mem board` is the operating state on one screen — raw archive, digest,
error classes, agents, open questions, installation, MCP bridge — with
`--html` for a single self-contained page. Every tile reports how old
its answer is, and a tile that could NOT be measured shows as
`unmeasured` rather than as calm. `mem status` says which of the five
installation steps has actually happened; `mem classes` is the error
vocabulary and how much of this memory it covers.

Every command takes `--help`. `mem doctor` is the self-check: it
reports what is configured, what is missing, and what is merely
unknown — UNKNOWN is a distinct result from OK and ERROR, on purpose.

### 7.2 MCP — 42 tools

For agents without hooks (ChatGPT, Codex, Gemini CLI, Cursor, Claude
Desktop). `bin/mem-mcp`, stdio (or `--http`).

| Tool | Purpose |
|---|---|
| `mem_log` | append an entry |
| `mem_heartbeat` | report that this agent is running (hourly quiet period) |
| `mem_appointment_new` | propose an appointment: a reminder, or an action for an agent at a time. Always a proposal until a human confirms; only a plain reminder carrying the user's quoted request is active at once |
| `mem_appointment_list` | read only: the next 14 days, or every appointment, or the day list |
| `mem_appointment_cancel` | cancel your own proposal (an armed appointment is the user's) |
| `mem_questions` | what is open — and with `all`, what was answered |
| `mem_answer` | close a question by naming the entry that answers it |
| `mem_procedures` | the procedures in force, each with its author |
| `mem_skill_find` / `mem_skill_fetch` | read only: released (and [trial]) skills, workflows, snippets, procedures for a task as short cards; the full text of one (`src/skillregistry.mjs`) |
| `mem_component` | everything about one file, across both spellings |
| `mem_source` | take in an address as a source (no local paths) |
| `mem_bridge_report` | report which checkout this server is serving |
| `mem_board` | the operating state on one screen |
| `mem_find` | ranked search; optional `variants` (caller-written rewordings, rank-fused) |
| `mem_retrieve` | ranked retrieval returning structured claims |
| `mem_show` | one entry in full |
| `mem_links` | what an entry points at, and what points at it |
| `mem_experiences` | the learnings the memory stands behind, strongest first |
| `mem_topics` | a subject as a thread; without a key, the list of topics |
| `mem_facts` | the facts that hold right now |
| `mem_explain` | why an entry did NOT come back |
| `mem_context` | compact dump for the start of a task |
| `mem_duties` | what is still owed |
| `mem_duty_close` | close a fulfilled duty — appends a line, the original stays |
| `mem_inbox_new` | new inbox messages addressed to you |
| `mem_inbox_show` | one inbox message in full |
| `mem_inbox_write` | write a message to another agent; `intent` decides whether it may wake the recipient (10.28) |
| `mem_inbox_ack` | change a message's state (open / replied / processed / closed) |
| `mem_inbox_claim` / `mem_inbox_renew` / `mem_inbox_done` | claim a message with an expiry, renew it, report it done — as the connected agent, same read rule as `mem inbox claim` |
| `mem_inbox_failed` / `mem_inbox_claims` | give a claim up with a reason (released at once); read only: who holds a message and whether your own claim still counts — same as `mem inbox failed|claims` |
| `mem_project_init` | create a project skeleton |
| `mem_project_new` | create a NEW project the guarded way: refused when the name is too like a project or topic alias, written with a reason and an event, marked new until a person confirms it |
| `mem_project_suggestions` | read only: which topics without a project hang on 2 captures on 2 days (dry run, same as `mem project suggestions`) |
| `mem_store_put` | register a local file in the content-addressed store |
| `mem_store_list` | what is held in the file store right now |
| `mem_store_get` | resolve a hash to the local path of the stored bytes |
| `mem_user_habits` | generic, code-only habit meter over the user's own captures |
| `mem_ledger` | jobs per agent kind/model — counted, never a claimed strength (`src/agentledger.mjs`) |

`mem store verify` and `mem store remove` stay off the bridge —
deleting a registered artifact is a human's call at the CLI.

The server also serves **`instructions`** at `initialize`
(`HOUSE-RULES.md`), and every tool description names the **occasion**
to call it, not just the capability. This is not decoration: measured
2026-09-07, a connected agent had `mem_log` available for a whole day
and used it zero times — nobody had asked it to.

**What the bridge deliberately does not offer:** nothing that edits,
deletes, commits or pushes. The tool list is asserted **by name** in
the test suite, so a new tool is a decision someone makes rather than
one that happens.

`mem_bridge_report` writes, and stays inside that rule the same way
`mem_log` does: it APPENDS a line to `.mem/bridge-reports.jsonl` and
there is no path through it that changes or removes an existing one.
The first draft rewrote a single JSON file — which would have broken
the rule, and the rule was right. Appending also answers a question the
overwrite could not: since when has this server been on the same
checkout, and how often has it restarted.

It has to be here rather than only in the CLI. The bridge tile asks
whether the server outside is serving the code in this repo; from
inside that is unmeasurable, and the only party who knows is the server
— which comes in over the bridge and has no CLI. A capability missing
where the work happens is not a capability.

### 7.3 Viewer

`mem viewer` writes ONE self-contained HTML page: every entry embedded,
search and filters in the browser. No server, no model, no network — a
photograph of the memory, thrown away when it goes stale. It reads only
the redacted drawers; raw captures are excluded.

### 7.4 Console — `mem serve`, `src/console.mjs`

The other mode: one fixed link that always shows the current state, and
the only place where anything can be SET without a shell. That matters
where a shell is least available — a phone over browser-SSH, a tablet,
somebody else's laptop. An archive path that can only be changed by
typing a long command is, in practice, not changeable.

| Path | What |
|---|---|
| `/`, `/dashboard` | the dashboard page (7.5) — since 2026-09-28 also home of the settings, installation steps and connections this section describes |
| `/console`, `/viewer` | redirects (303) into the dashboard; the pages of their own are gone |
| `/pult`, `/pult.json` | redirects (308) to `/dashboard` and `/desk.json` — the old German names, kept for bookmarks since 2026-10-01 |
| `/console.json` | the state numbers, for tools |
| `/desk.json` | the old desk's data, for tools (was `/dashboard.json` until 2026-09-28, `/pult.json` until 2026-10-01) |
| `/task`, `/task/cancel` | start/cancel a long CLI work item as a task (E1.7, `src/tasks.mjs`) |
| `/task.json` | a task's progress/result, or the two-kind overview |
| `/inbox/reply` | answer one message in the human participant's tray — same write as `mem inbox write` (P1b) |
| `/health` | no auth, reveals nothing — for a supervisor or tunnel |

The list lives once, as `PATHS` in `bin/mem-serve`, and the auth probe
reads it from there. A path list copied into a test is a list that goes
on passing after another path is added.

**It is a daemon, and the trade is worth naming.** The viewer file was
"nothing that keeps running". This keeps running. So it carries the two
properties the file had — it renders only the redacted drawers, and it
writes no rendered content to disk — plus a third, because a link is
reachable from outside:

**Fail-closed.** With no `CHEAP_MEM_SERVE_TOKEN` it serves localhost
only, and binding to a public address without one is REFUSED: the
process does not start. Not warned about — refused. A warning in a log
has never once prevented an open link. A request without a valid token
gets exactly what an unknown path gets, a bare 404, so a scanner sees
"nothing here" rather than "something guarded here". The rules live in
`src/webauth.mjs`, once, because two copies of one door means one of
them is tested and the other is the one with the hole.

**Writing over HTTP is off until the owner turns it on** (2026-09-27,
`src/writegate.mjs`, `docs/dashboard-writes.md`). In front of every
writing route sits one switch: `"dashboard": { "allowWrites": true }` in
`.mem/config.json`, or `mem serve --allow-writes` for one run. Off, each
writing route answers 403 and says how to turn it on; the dashboard
itself cannot flip it. One function, `writegate.refusal()`, runs the
switch and the Host/Origin/readonly latches for every route.

**Behind the switch, three latches.** Until E1.7 (2026-09-27) `/setting`
was the only place in the project that wrote over HTTP; `/task` and
`/task/cancel` (starting/cancelling a task — `src/tasks.mjs`, `docs/
dashboard-tasks.md`) are the second, sharing the SAME three latches
rather than a fourth copy of them:

1. **A closed list.** `SETTINGS` names every knob with its check and its
   writer (`/task`: `tasks.KINDS` names every kind that can be started).
   A name that is not in the list is REFUSED, not ignored.
2. **The same execution path as the CLI.** `archive.setLocation` creates
   the directory, writes a probe file, removes it, and records the
   location only then — the exact function the CLI itself calls
   (`/task`: the exact CLI COMMAND itself, spawned as a child process —
   `src/tasks.mjs`, no second export/verify logic invented beside it).
   A second writer here would be two truths, and the second would not
   have the probe.
3. **Origin.** A POST without an `Origin` matching the request's own
   `Host` is refused — stricter than the rule for reads, because a
   browser always sends `Origin` on a POST, so a missing one on a
   state-changing request is a form from somewhere else. The session
   cookie is `SameSite=Lax` and would not travel with such a POST
   anyway; this is the second, independent reason. `/task` and
   `/task/cancel` call the exact same `webauth.postOriginOk` check, not
   a fourth copy of it.

Every change is logged, machine-locally, to `.mem/console-log.jsonl`,
and the last five are shown on the page. A setting that changes
silently is the state this project spends its time hunting.

`CHEAP_MEM_SERVE_READONLY=1` shows everything and sets nothing — and
the page says that it is in that mode, rather than looking broken. It
wins over the write switch and over `--allow-writes`.

**Of any token, only WHETHER it is set is shown.** A console that
printed the link with the token in it, so you could conveniently copy
it, would have put that token into every screenshot and every browser
history.

### 7.5 Dashboard — `/`, `src/dashboard-data.mjs` (data) + `src/dashboard-page.mjs` and `assets/dashboard/` (page)

Since 2026-09-28 the dashboard is cheap-mem's only UI (`docs/dashboard.md`).
It is the sibling house's dashboard, functionally and visually the same,
in English, with cheap-mem's own mark (the C) and an empty store on a
fresh install. Five areas — **Overview**, **Knowledge**, **Work**,
**Sources**, **Operations** — plus **Settings**, and a 3D network of every
declared link. `/` and `/dashboard` serve the same page; `/console`
and `/viewer` lead into it (303), `/pult` too (308). `/console.json` and `/desk.json` stay
for tools; `mem board` and `mem viewer` stay on the CLI.

**It has no fallback, and that is the feature.** Every view is drawn
from `/dashboard.json`, collected live from this memory. A source that
cannot be read is named on the page; the completeness mark then reads
"unknown", never a number nobody counted.

**Nothing is derived twice.** The board states come from
`console.collect`, the entries and agents from `viewer.collectMemory`,
the network from `net.build`, the doctor from `doctor.run`. The data
layer assembles; it owns no truth of its own, so it cannot disagree
with the CLI about an edge or a state.

**Four states on every count** — `calm / watch / alarm / unknown` on the
board, `good / warning / error / unknown` from the doctor — each with its
own colour. Unknown is never drawn as 0.

**What cheap-mem does not have is shown as such.** Books, the digester's
yield, restore, merge and the live injection view are marked "not
available in cheap-mem" rather than hidden or faked.

**Writing** goes only through the routes named in `WRITE_PATHS` in
`bin/mem-serve` (`/setting`, `/task`, `/task/cancel`, `/inbox/reply`,
`/inbox/state`, `/dashboard/verify-verdict`, `/dashboard/gold-verdict`)
and their gates, and is
off until the write switch is on (`docs/dashboard-writes.md`). Deleting a
raw capture works as on the CLI: preview, mandatory reason, confirmation.

**Every file comes from this server.** three.js and DM Sans are vendored
under `assets/` (MIT and OFL, see `NOTICE`) — the one named exception to
"no dependencies". The page sends a CSP header, never a CORS header, and
every data route checks the Host header against DNS rebinding.

---

## 8. How to verify any claim here

Do not take this document's word. Every claim above is checkable, and
the commands are short.

```bash
npm test                                    # the runner counts subtests; count: Measurement row, section 0
node bench/scale.mjs                        # the scaling table in scale.md
node bench/redteam.mjs                      # scope and poisoning scenarios
node bench/ranking-attack.mjs               # flooding and rank manipulation
node bench/byzantine.mjs                    # a flood of rule-abiding, plausible but wrong claims
node bench/alias-fragmentation.mjs --root <mem> --set "a,b,c"
node bench/duplicate-rate.mjs --root <mem>  # does the digest consolidate?
node eval/metrics.mjs                       # retrieval ceiling and floor, no model
mem doctor                                  # what is actually configured here
```

`eval/` carries a **frozen reference run** with a checksum, so a later
run can be compared against it rather than against memory.

Two measurements worth knowing before you form a view:

- **Retrieval ceiling.** On the eval corpus, the needed item reaches
  the context in 38 % of tasks, and 91 % of what is injected is not the
  sought item. Those are the upper bound of benefit and the lower bound
  of pollution — stated because a memory system that quotes only its
  wins is not measuring.
- **Duplicate rate.** 1.8 % near-duplicates across 902 digested
  entries, and most of the residue is one entry filed both globally and
  under a project — a scoping question, not a failure to consolidate.

---

## 9. Deliberately absent

Six capabilities do **not** exist, by decision rather than oversight.
Each has a reason and a stated condition that would change our mind:
[`deliberately-not-built.md`](deliberately-not-built.md).

| Absent | One-line reason |
|---|---|
| Usage counters (`times_retrieved`) | machine-local, so git stops being the source of truth; rewards popularity over usefulness |
| `confidence` float per entry | uncalibratable and incomparable across writers; tiers answer a checkable question instead |
| Decay as deletion/archiving | breaks append-only and the provenance chain; decay as a *ranking* effect stays open |
| Graph database | breaks local-first, readability and "no unnecessary infrastructure" — and the textbook case for it measured as a non-problem here |
| LLM per fact (Mem0-style) | breaks token efficiency and model independence; the digest does the same job three orders of magnitude cheaper |
| Second temporal axis (belief time) | elegant, solves no problem anyone here has had; `git log` covers the rare case |

**Also not yet built, and honestly so:** an entity layer. cheap-mem
knows words, not things. Measured on a real corpus, the textbook case
(one person under several names) is a non-problem — `lukas` occurred
once in 1,070 entries, 94 % of mentions used one spelling. Where a real
corpus fragmented was **component names**, at 43 %. If an entity layer
gets built it starts there, and it would make existing knowledge
operable rather than add new knowledge: the memory already contains the
entry saying two names are the same person — no lookup can act on it.

---

## The ten principles this is built against

Any proposed change is weighed against these, and a change that breaks
one needs to say so out loud:

1. Local first
2. Git as the source of truth
3. Human-readable data
4. Model independence
5. Token efficiency
6. Simplicity
7. Full user control
8. No unnecessary infrastructure
9. Not a heavyweight enterprise system
10. On-demand context loading, not prompt stuffing

---

## Where to go next

| You want | Read |
|---|---|
| To install it | [`quickstart.md`](quickstart.md), [`install-linux.md`](install-linux.md) / [`-macos`](install-macos.md) / [`-windows`](install-windows.md) |
| To connect a non-Claude agent | [`mcp-setup.md`](mcp-setup.md) |
| The architecture | [`architecture.md`](architecture.md), [`state-separation.md`](state-separation.md) |
| The threat model | [`security-model.md`](security-model.md) |
| Scaling numbers | [`scale.md`](scale.md) |
| Why something is missing | [`deliberately-not-built.md`](deliberately-not-built.md) |
| An external comparison | [`analysis-2026-09-08-comparison-foreign-systems.md`](analysis-2026-09-08-comparison-foreign-systems.md) |

---

## 10. Multi-agent

Everything in this section exists because several agents share one
memory and none of them reads it out of politeness. The numbers are
measurements from the reference deployment (a ~1600-entry memory
written by five agents over two weeks), not projections.

### 10.1 Origin on every write — `src/memory.mjs`, `agentDefault()`

Measured before the change: **855 of 1081 entries carried no agent
field (79 %)**. Only the MCP bridge stamped one; the CLI never did.
The second axis — who claimed this — was empty for three quarters of
the corpus, and with it every authority comparison and the agent board.

Now every write carries one. The order is: an explicit `agent` field,
then the origin stamp (`origin.agent`, `origin.surface`), then
`CHEAP_MEM_AGENT`, then `human:<os user>`.

**Never a fallback to `session` or `unknown`.** An invented origin is
worse than none, because it looks like evidence. `human:` as a prefix
keeps human and machine names disjoint. Old entries are not
backfilled — that would be inventing origin at scale; the corpus heals
forward.

### 10.2 Error latches — `src/guard.mjs`, `mem guard run`

Measured: **289 classified errors, 42 classes recurring, 43 % of
entries in repeat classes** — spread over days, not one bad session.
The class warning ("the Nth time") fires while logging, i.e. after the
error. It counts; it does not prevent.

A latch hangs off an `error` entry and answers one question: is the
error back?

```
mem log error --class silent-fail --title "..." \
  --guard-kind absent --guard-path bin/hook.sh --guard-pattern "|| exit 0"
mem guard run [--duty]
```

Four kinds, and the vocabulary is **closed**: `absent`, `present`,
`file-there`, `file-gone`.

**A latch executes nothing.** The obvious design — "a command that
exits non-zero" — would be a serious hole: an entry is data, and a
connected agent logs errors, so it could drop arbitrary code on the
owner's machine and wait for the latches to be run. The pattern is
literal text, not a regular expression, for the same reason plus one:
a crafted regex can make a match run arbitrarily long. Paths cannot
escape the memory root.

**`broken` is not `green`.** A latch pointing at a deleted file has
checked nothing; reporting that as a pass would be the very class it
exists to catch. `mem guard run` exits 1 while anything is red.

**A latch is checked at creation time**, and if it comes back green the
entry records `guard_at_creation: green`. At the moment you log an
error the error is *there*, so the latch must be red. A latch that was
never red is unproven — the same thing as a falsification test without
a backdrop.

**A test scaffold, not only a latch — `src/probescaffold.mjs`.** With
an explicit `--file`, `mem log error` also lays down
`test/error-<id>.test.mjs`: the marker `// error: <id>` and three
`test.todo` sections (sabotage, positive control, red on the old
stand). Measured against a reference deployment: only a handful of
errors ever carried a guard, because going from error to probe is its
own separate step, and that step is exactly the one that gets skipped.
`--without-scaffold` turns it off; an existing file is never
overwritten.

**Empty is not passing.** A scaffold that ran green while still empty
would be worse than none — it would look like a latch and catch
nothing. So the `// scaffold: empty` marker, or any remaining
`test.todo(`, keeps the file worthless as F4 evidence
(`memory.dutyHasEvidence`, `probescaffold.isEmpty`) even once it
contains a stray `test(`.

```
mem log error --class silent-fail --title "..." --file src/foo.mjs
mem guard quote
```

`mem guard quote` measures the SHARE of `error` entries that carry a
guard (field, or a non-empty scaffold — the same rule `dutyHasEvidence`
uses), and names scaffolds that have sat empty for more than
`probescaffold.STALE_DAYS` (14) days as a warning, never silently `ok`.

### 10.3 Heartbeats — `src/heartbeat.mjs`, `mem heartbeat`

Measured: for twenty hours no agent but one session had written
anything. Whether the others were *running* could not be established —
there was no signal separate from work output. **"Dead" and "nothing to
do" looked identical**, and while that is true a watchdog has nothing
to watch.

A heartbeat line says: this agent was running at this time and could
write. It does **not** say the agent is doing its job — that is what
its entries say, which is why the agent board shows both.

The log is in git (a local pulse file is invisible to anyone asking
from another machine), with a **quiet period**: at most one line per
agent per hour. A pulse every three minutes would be 480 lines per
agent per day, and the memory would be buried under its own pulse
measurement. `written: false` is the normal answer, not a failure.

`ageMin()` returns **`null`, not `Infinity`**, for an agent never seen.
"Never seen" and "not seen in a while" are different statements, and
the first usually means the agent does not call the heartbeat at all.

### 10.4 Roads not taken — `rejected` on a decision

Without the field, "have we already looked at PostgreSQL?" is not
answerable: the entry only records that SQLite was chosen, so the next
agent evaluates it again and the reason from last time is lost.

Weight **1.2 — deliberately below `choice` (1.5)**. At equal or higher
weight the damage would be worse than the one repaired: somebody
searching for the tool they *use* would first find the decision in
which it was *rejected*.

`--rejected` splits on a **semicolon**, not a comma. The value is a
sentence and naturally contains commas ("too heavy, and too much
ops"); a comma split turns one statement into two fragments that say
nothing. In the reference deployment the same mistake once made 17
entries unfindable by tag.

### 10.5 Error broadcast — `src/broadcast.mjs`

Measured: 43 % of classified errors recurred, across days rather than
within one session. **Every one of them had already been recorded.** It
just was not read, because reading was the reader's duty.

If agent A logs an error about a file B has touched, B finds a note in
its inbox — with evidence, no model call, and B does not have to
remember.

Two brakes, and they are the actual design:

**The trigger is a PATH, matched literally.** If the error names no
path, nothing goes out. A ranked search always returns something, and a
broadcast that fires at everybody on every error is noise after the
third one — worse than silence, because it takes the real warning with
it. The memory's own log files are excluded: an error that talks about
logging would otherwise match everybody who ever wrote about the log.

**A duplicate marker in the subject** (`[bc:<id>]`). A channel that
redelivers the same note on every run gets switched off, and then it is
gone entirely.

A recipient is somebody who demonstrably touched the file — evidenced
by an entry of their own naming the path AND carrying an agent field.
Recipients without an inbox are **reported, never dropped silently**.
It hangs off both write paths, CLI and bridge: the bridge is where the
foreign agents write, and a broadcast that only the CLI triggers would
never carry an error filed by a connected model.

Reach grows with origin stamping (10.1), not by loosening this. In the
reference deployment a dry run over the last 60 errors found a
recipient in 3 cases; that number is a statement about how much
provenance exists, not about the lane.

### 10.6 Procedures — `src/procedure.mjs`, `mem procedures`

A `skill` here means "a capability acquired, with evidence" — a
statement ABOUT an agent. A procedure is a norm FOR ALL. A capability
is acquired; a procedure is issued. Conflating them is what made the
original "skill lane" idea dangerous.

**The body of a procedure IS an instruction**, which collides with the
rule everything else rests on: what comes back out of the memory is
data. So three latches, all mechanical:

1. **The bridge does not write this type.** Not as a permission, not as
   a flag — at all. `mem_log` refuses `type: procedure` and names the
   way out (propose it as a `thought`, or message the owner). Anybody
   can set a field; nobody can set a missing write path.
2. **Issued and written are two fields.** `issued_by` must be a human
   (`owner` or `human:<name>`); an agent name is refused. If somebody
   else typed it, the entry carries `on_instruction: true`.
3. **Every display carries the marking** "Procedure, issued by X on Y" —
   the CLI's human line, `--json --brief`, the full `--json` (as a
   `marking` field), the MCP bridge, and the viewer. Five paths, because
   a guarantee each of them keeps on its own is only as strong as the
   sloppiest.

**What is NOT solved, stated plainly.** Who is "the user" for a foreign
agent? It connects under an agent name, and "the owner asked me to" is
unfalsifiable from there. No field fixes that — a field anybody can set
is not authority. What is achieved is narrower: the write path is
closed, and where writing happens it is attributable who claims to have
ordered it. A forgeable claim becomes a forgeable but visible one.

### 10.7 Open questions — `src/question.mjs`, `mem questions`

Across the ten original entry types there was none for "we do not know
this". Everything the memory could hold was known.

```
mem questions new "..."            note one
mem questions [--all]              what is open
mem answer <id> --with <entry-id>  close it
```

**Not a state on `duty`.** A duty has a debtor and counts as neglected
when it sits; a question has no owner and may stay open for years
without anybody being at fault. Filing questions as duties would
manufacture a pile of apparently neglected work.

**No lifecycle of its own.** A question closes when something answers
it, and the `resolves` edge already exists. The state is read from the
GRAPH and only from there — a field on the question would be a second
truth about one state, and the two would drift.

A missing question mark warns but does not block: a question gets noted
in passing or not at all, and refusing one over punctuation is
formalism.

### 10.8 Neighbours at write time — `src/neighbours.mjs`

The brief was "conflict at write time instead of read time". Measured
against the reference corpus, and in that form **not built**:

    108 decisions, 103 topics
    5 topics with more than one decision and a different choice
    of those, actually contradictory: 0

All five are follow-up decisions under a coarse topic. Five false
alarms out of five, and a warning that is always wrong teaches people
to skip warnings.

What is built is the useful half: while writing, what already stands
about this subject is shown — with the three ways out, none of them
asserted.

```
If this REPLACES the old state:  --replaces_id <id>
If both hold side by side: do nothing.
If they CONTRADICT:  mem log link --from <new> --to <id> --kind contradicts
```

Hit density 5 of 108, i.e. 4.6 %. A hint on every second entry is
invisible within a week; one every twenty entries gets read. The
neighbourhood is read BEFORE the write, or the hint would say
"something already stands: your entry from a second ago".

### 10.9 Onboarding, not configuration — `src/onboarding.mjs`

A connected foreign agent had the log tool available for a whole day
and used it not once. It was configured — inbox created, bridge
connected, tools visible — and still not connected. We noticed after a
day, by counting.

Five steps, each mechanically checkable:

```
inbox   houserules   written   heartbeat   loop
```

A step counts because something in the memory EVIDENCES it — never
because somebody ticked it. So somebody else's entry does not count
either: you cannot onboard an agent by writing for it.

The last step proves the whole loop — the agent writes an entry itself
and finds it again. Both halves must hold; written alone would only
mean it can send. A withdrawn probe stops proving it, which is what
makes the second half more than decoration.

`mem onboarding <agent>` exits 1 while anything is open and names the
command that closes each step. There is no "essentially onboarded".

### 10.10 Sources — `src/source.mjs`, `mem sources`

A company's knowledge is already somewhere. The cheapest entrance is a
boring one: a pointer plus a searchable excerpt. No connectors.

```
mem sources add <url|path> [--title] [--tags] [--note]
mem sources list [--kind file|address]
```

- **Nothing is fetched.** An address stays a pointer. A memory that
  dereferences addresses is a crawler, and what it collects on the way
  nobody has read. Pass text yourself with `--note`. The address
  pattern is narrow: http(s) and nothing else, no `file://`.
- **A local file goes into the store**, content-addressed; the entry
  carries the hash. Binary files get no excerpt — byte soup in the
  index makes every search worse.
- **The excerpt is capped** at 4000 characters and says when it
  truncates. It weighs 0.8, below our own text: an excerpt is a
  quotation, not a statement by the memory.
- **The excerpt goes through redaction** before anything is written,
  and what was redacted is reported. A foreign document is exactly
  where a credential rides along.

### 10.11 Storage places — `src/stores.mjs`, `mem raw archive --list-stores`

The archive can live in a folder, on a mounted NAS share, or in Google
Drive, iCloud, OneDrive or Dropbox. The last four cannot be named by
hand — Google Drive on macOS lives under
`~/Library/CloudStorage/GoogleDrive-<account>/My Drive`, with the
account in the directory name — so they are found. `--set gdrive` then
needs no path at all.

Two candidates (two Google accounts on one machine) are reported as
AMBIGUOUS rather than silently taking the first: "it went somewhere" is
the failure the archive exists to avoid.

A syncing store gets a warning naming three consequences, attached to
the PATH rather than to the command, so typing the Dropbox path by hand
warns too:

- Files can be evicted to the cloud; reading one may fail while offline.
  The memory reports that as an error, never as an empty result.
- A write returning does not mean the bytes left this machine.
- Two machines pointed at one folder share the archive.

None of the three is fixable from here. The memory can only refuse to
pretend they do not exist.

### 10.12 Is it working? — `src/setup.mjs`, `mem status`

`mem setup <agent>` installs. `mem status` reports — five steps, each
answered with evidence rather than with a previous step's word: a
memory exists, the archive is writable, the hooks are installed and
name a path that exists HERE, the bridge is registered, the memory
holds something.

It exists because of the Windows install on 2026-09-08: a hook with the
first machine's absolute path baked in, dead and silent on the second.
Nobody had a command that would have said "the memory is not attached
here". The hook step now reads every installed hook and checks the root
it names.

Three states per step, never two. `open` is a to-do list and exits 0;
only `broken` is an error. A to-do list that returns non-zero breaks
every script that calls it, and then nobody calls it.

### 10.13 The archive — `src/archive.mjs`, `mem raw archive`

**The raw capture does not live in the repository.** Reported from a
Windows install on 2026-09-08: 9.17 MB of git pack in 75 minutes, one
capture 8.6 MB gzipped, extrapolated ~50 MB per working day. In the
sibling project, checked afterwards, `raw/` was already 46 MB out of a
45.74 MiB pack — the memory had become almost nothing but its own raw
material.

Compression was measured first, on real captures, and every route was
single-digit:

| approach | saving |
|---|---|
| 1296 most frequent words as short codes, in plaintext | 26.6 % |
| the same substitution, after gzip | **6.8 %** |
| a shared gzip dictionary across captures | 1.9 % |
| exact duplicate lines across captures | 0.4 % |

gzip already does that work. After it there is nothing left to squeeze,
so the only levers are storing less (the capture drop filter,
`src/raw.mjs` `dropReason`) and storing elsewhere — this.

**An expiry date alone would not have helped: git deletes nothing.** A
removed file is gone from the working tree and still in the pack.
`mem raw migrate` therefore stops the GROWTH and reclaims nothing, and
it says so rather than letting anyone believe otherwise.

| command | what it does |
|---|---|
| `mem raw archive` | where it lives, how much, how much is reachable |
| `mem raw migrate [--remove]` | pull captures still in the repo into the archive |
| `mem raw export --from … --to … [--hour-from N] [--hour-to N] --into <dir>` | write a time range out, decompressed |
| `mem raw review [--project X] [--from … --to …] [--json]` | every capture with its state |
| `mem raw missing [--json]` | every MISSING capture one by one: path, date, bytes, the path it is expected at |
| `mem raw delete <path> --reason "…" [--by …] [--yes]` | remove the bytes, leave a tombstone |

**Deleting a capture, and what "delete" has to mean here.** Because git
deletes nothing, a delete that removes a row, or removes a file inside
the repository, has done nothing except make the person believe it did —
which is worse than refusing, because they stop looking. So the bytes go
from the ARCHIVE, outside git, and the append-only register keeps the
capture's row and gains a tombstone naming who removed it, when, and
why. `--reason` is required: a tombstone without one answers "was this
deliberate?" with a shrug. Without `--yes` the command only prints what
would happen and how many bytes — nothing is touched.

That leaves four states for any capture, and the last two are the point:

| state | means |
|---|---|
| `present` | recorded, and the bytes are reachable |
| `deleted` | the bytes are gone **and someone said so**, with a reason |
| `unreachable` | recorded, belongs to THIS machine's store, bytes not there, nobody said so — a broken archive, not a decision |
| `elsewhere` | the record points into ANOTHER machine's store — not an error, just not readable from here. The sibling house measured 15 of 1238 captures in this position on 2026-09-17; calling them `unreachable` makes the review a standing alarm |

One word for the last two would hide a broken NAS mount behind a
deliberate cleanup. `mem raw review` and the workspace's Settings view
read the same four states from the same function; the page draws them,
it does not recompute them.

And one more answer sits above those four: **a register that cannot be
read is not "no captures".** Both the archive tile and the review report
that as unknown, with the read error, and their counters go to `null`
rather than `0` — a number nobody took must not arrive looking like a
measurement. (Found by the probe that broke the register on purpose; the
first version caught the error into an empty list, and an empty list on
that page reads as "nothing has been captured yet".)

What `review` deliberately cannot do is filter by TOPIC. A capture
carries no topic in its metadata — only path, project, surface and
session. Finding captures by what they are about means a content search
over the decompressed material: a different, larger feature. It is not
built, and not silently faked either.

The location comes from three places, and `mem raw archive` always says
which one won:

| rank | source | for |
|---|---|---|
| 1 | `CHEAP_MEM_ARCHIVE` | one run diverting |
| 2 | `.mem/archive.json` | this machine — `mem raw archive --set <path>` |
| 3 | `raw/` | the default when nothing is set — **tracked** |

> **Why the default is inside the repository rather than beside it.**
> It read `.mem/raw` for half a day, and `.mem/` is gitignored. On a
> machine with a disk that is fine. Wherever the repository IS the disk
> — a cloud container, an ephemeral runner — the capture then reaches
> nothing that outlives the process, and the stop hook is the only thing
> that pushes.
>
> Measured in the sibling project's own container on 2026-09-08: the
> last capture that reached the repository was at 19:36, and eight after
> it would have gone with the container, including those from the
> session that made the change. `test/stop-persists.sh` had been red
> about it the whole time and was sitting on a list as an outdated shell
> test. It was not outdated.
>
> So: whoever has a disk says so. Whoever says nothing gets the place
> that survives. Growth is what a migration on a machine that stays is
> for; nothing is for captures that are gone.

The machine-local file exists because capturing happens in several
places — a session's stop hook, the watcher, the digest. Naming the
path in each of them would rebuild the bug found the same day: an
absolute path in five places, one of which gets forgotten. `--set`
creates the directory, writes a probe file into it and removes it
again, and only then records the location; a failed probe records
nothing.

Note which memory the command acts on: not the current directory. The
root comes from the environment or from where `bin/mem` itself lives.

A folder, a mounted NAS share or a synced cloud drive all work, because
anything the operating system can mount is a path — which is why there
is no network adapter: there would be no target to test it against.

What stays in the repository is `raw-record.jsonl`: one line per
capture with stamp, time span, line count, bytes, SHA-256, location and
what was dropped. It answers, without touching the archive, whether a
capture existed, when, how big, and whether it has been digested. It
does NOT answer what is in it — deliberately. A memory that knows its
own raw material only as a summary can no longer check whether the
summary is true.

The SHA is in the repository because an archive has no history: if
someone overwrites a file on the NAS, nothing would notice.

**Two guards, both about not lying:**

- If the archive is not writable, the capture FAILS and says why. It
  does not quietly fall back into the repository — that would undo the
  whole exercise while looking exactly like before. The offset is not
  advanced either, so the same stretch is still there next time.
- `readCapture` THROWS when a recorded capture is unreachable. Returning
  an empty result would let an unmounted drive look exactly like an
  empty memory.

For the same reason `pending()` takes its byte counts from the record
rather than from disk: the amount of open work decides whether the
digest runs, and a digest that never fires again because a drive was
unmounted is the most expensive kind of silence.

### 10.14 Components — `src/component.mjs`, `mem component`

Measured across 805 path mentions: 312 distinct components, 70 of them
(22 %) appearing in more than one spelling — almost always just the
path prefix.

That is expensive in exactly one place, and it is the most valuable
one. The pre-edit hook asks literally with the last two path segments:

    bin/capture.sh          3 of 11 entries
    .claude/stop.sh         0 of 10
    hooks/stop.sh           6 of 10

The hook that fires DURING the work ran at a third of its reach. It
now asks over both forms.

**No alias table.** There is one for topics and it is right there —
topics are invented, so their sameness must be asserted. A path is not
invented; a curated table would mean maintaining by hand what is
derivable.

**The latch:** a base-name hit counts only when the entry names it
without a prefix or with the same one. `projects/x/events.jsonl`
answers no question about `global/events.jsonl` — the confusion would
be worse than the gap, because it gives a hint the appearance of
evidence. Every hit carries its form (`exact` / `base`) into the
display: a base hit is weaker evidence and should look like it.

### 10.15 Reach: the bridge carries all of it

After the port, six of these capabilities existed only at the CLI. For
an agent whose ONLY access is the bridge — a connected model over MCP —
they therefore did not exist. The same measurement as for the store
tools, one round later.

The expensive one was the heartbeat. `mem onboarding` checks five
steps, and one of them was fundamentally out of reach for a
bridge-only agent: it could behave however well it liked and stay red.
**A test bench that does not permit a result is not measuring the
thing under test.**

Two boundaries stay, and both have a reason rather than an oversight:

- **`procedure` is read, never written**, over the bridge. A norm for
  all agents cannot come from one of them.
- **`mem_source` takes addresses, not local paths.** The content of a
  source lands redacted in the searchable corpus that everybody reads
  — a different exposure from `mem_store_put`, which holds bytes under
  a hash and refuses outright on a redaction finding. Taking a local
  file in as a source is a human's decision at the CLI. The refusal
  names both ways out.

`mem_heartbeat` takes its identity from the connected agent, never
from a parameter: otherwise one agent could beat for another, and the
lane would look alive where nobody is running any more.

Not added: `broadcast` (fires by itself when an error is logged) and
`guard run` (an operational handle, not a working tool).

### 10.16 Error classes — `src/errorclass.mjs`, `mem classes`

A closed vocabulary of twelve, so that errors become countable at all.

**The count that forced it (2026-09-08, in the sibling project this
tool was extracted from).** 303 error entries, 212 distinct class
names, 167 of them used exactly once. Fifty-five percent of all entries
sat in a class with a single member — and a class with one member
classifies nothing.

The hand check made it plain: `looks-right-does-nothing` was written
seven times, while `silent-failure`, `silent-loss`, `lying-check`,
`falsely-green`, `watchdog-mute` and nine more names described the same
defect about 27 times. **The dominant defect type was invisible because
every writer coined a fresh name for it.**

**The same count, eight days later (2026-09-16).** That sibling still
runs an open vocabulary, so it doubles as a control group nobody had to
set up: 408 error entries, 238 distinct class names, 176 of them used
exactly once.

Read it in both directions, because it says two things and only one of
them is comfortable:

- The share improved — 43 % of entries now sit in a single-member class,
  down from 55 %. Of the 26 class names coined in those eight days, 17
  were reused at least once. Writers do converge on their own, slowly.
- The coining did not stop. **26 new class names in eight days**, by
  writers who had already read the finding above. Knowing that the
  vocabulary sprawls turns out not to prevent sprawling; the names are
  invented in the moment of writing, when the defect feels specific and
  a fresh word feels more honest than a blunt one.

That second half is the argument for a closed list rather than a
convention. Twelve classes are too few to describe any defect exactly —
that is the point. A writer forced to pick the nearest of twelve files
a countable entry; a writer free to coin files a precise one that joins
176 others nobody will ever count. The warning on an unknown class
(`it will not be counted`) is deliberate for the same reason: refusing
the entry would lose it, and counting it would reopen the list.

Three properties, each with a reason:

- **Every class carries a falsifying question**, not just a label.
  `looks-right-does-nothing` asks *"What would be visible if it did NOT
  work?"* A list of labels invites mis-picking; a question can be
  answered on the concrete case. When none of the twelve fits, that is
  a finding — not a licence to invent a 213th name.
- **Old names map through `ALIAS`, and only literally.** No fuzzy
  matching, no keyword rule. `normalise()` returns `null` rather than
  the nearest string. What is unmapped, `coverage()` counts as open and
  names — a mapping nobody checked would be a number nobody can stand
  behind.
- **`mem log error` warns, and writes anyway.** `mem log` is the path
  along which things get saved that would otherwise be lost; a write
  that fails on a naming rule loses the content.

`mem classes` lists the twelve with their questions and how many
entries each holds; `mem classes --open` names what could not be
mapped.

### 10.16b Procedures armed by error class — `--on-class`

A procedure may name the error classes it was written against:

```bash
mem log procedure --title "Falsify, do not confirm" \
  --rule "Ask what would be visible if it did NOT work, then build that probe." \
  --issued-by owner --on-class looks-right-does-nothing,check-tests-the-wrong-thing
```

From then on, filing an error of that class offers the rule — at the one
moment it is actually wanted. A procedure that only surfaces when
somebody remembers to run `mem procedures` applies when it is least
needed.

**Cheap here, expensive elsewhere.** Matching a rule to a situation by
keyword is guessing; matching against twelve fixed names is a lookup.
The closed vocabulary of [10.16](#1016-error-classes--srcerrorclassmjs-mem-classes) pays a second
time.

An unknown class is **refused at write time**, which is the opposite of
what `mem log` does everywhere else. There the rule is "write and warn",
because a refused write loses content. Here there is no content to lose:
a trigger on a class that does not exist never fires, and the rule sits
in the log looking armed. Old class names are accepted and normalised on
the way in, so knowing the history is not punished.

### 10.17 The board — `src/board.mjs`, `mem board`

Seven tiles on one screen: raw archive, digest, error classes, agents,
open questions, installation, MCP bridge. Text for a terminal, or
`--html` for a single self-contained page — no script, no external
source, because a board that stays empty when a script fails to load
reports calm by omission.

**Four states, never two.** `calm`, `watch`, `alarm` — and `unknown`,
which is deliberately not green. A tile that could not be measured is
grey. The whole reason the module exists is that on 2026-09-08 four
questions had no answer anywhere in the tooling:

- Is the bridge serving the code that is in the repo? (One ran a whole
  day on the previous day's checkout. An outside agent noticed.)
- Is the raw capture where it is supposed to be? (672 captures still
  sat in the repository while the report said they were archived.)
- Is one defect type piling up? (Seven visible occurrences; twenty-eight
  actual ones, under fourteen names.)
- Is anyone still writing, or has a lane failed silently?

Three rules the tiles follow. Each tile says **how old** its answer is.
No tile is dropped for being calm — a board that hides quiet tiles
loses the information that something was checked. And a condition that
is normal is never rendered as a loss: a capture recorded by another
machine counts as `foreign`, not as `missing`, or the board is
permanently red on every machine but one.

The bridge tile is the honest case. From inside, this repo cannot know
which process is running out there, so it does not guess: it stays
`unknown` until an agent reports with `mem bridge report <short-hash>`.
A tile that inferred the running state from the repo state would have
shown green for the whole day the bug lasted.

### 10.18 Integrity of the log itself — `src/chain.mjs`, `mem chain`

`mem doctor`'s append-only check compares the working tree against
`git show HEAD:<path>`. That catches an edit made before it is
committed — where carelessness actually happens — but once a rewrite is
committed, HEAD *is* the rewritten content and the check compares clean
history to itself. Measured detection against five tampers: **1 of 5**.

`src/chain.mjs` is a second signal that never reads git. It hashes the
raw JSONL line byte for byte and compares against a seal recorded
earlier inside the log. One chain per writer, because writers append
concurrently and a single global chain would report every interleaving
as a break.

Four states, and the third one matters: a seal that covers **zero**
lines reports `unknown`, not `ok`. A check that can say `ok` without
being able to say what it inspected is not a check. Sealing is opt-in
(`chainSealCadence`) until `search.mjs` and `retrieval.mjs` learn to
skip `chain_seal` lines — an un-integrated reader would otherwise
return seals as if they were content.

### 10.19 Clock skew between writers — `src/clock.mjs`

`env/clock` used to compare the newest entry in the whole memory
against `Date.now()`, whoever wrote it. Comparing your own clock to
your own clock's recent output says nothing about a fleet; it only says
you did not write in the future.

This narrows the comparison to the newest line from a **foreign**
writer against this process's clock. That is the number that `ts`-based
ordering between writers actually rests on. Ordering *within* one
writer is `chain.mjs`'s business, and this module does not touch it.
Nothing is ever reordered on the strength of it — it is reported, not
applied.

### 10.20 The index cache, as shards — `src/indexcache.mjs`

The old cache was one JSON document. That works until the serialized
**text** passes V8's maximum string length (2**29 − 24 UTF-16 code
units — a V8 constant, not a flag). At the measured 548.7 bytes per
entry that is ~978,477 entries, matching the build plan's measured
break at 978,395. It is not a slow decline: every entry before the line
loads, every corpus past it throws `RangeError: Invalid string length`
inside `JSON.parse`, deterministically.

Streaming the bytes is not the fix — Node has no streaming `JSON.parse`
— so the cache is written and read as shards instead, none of which
approaches the limit. `test/index-cache-ladder.test.mjs` re-establishes
the wall on whichever machine runs the test rather than trusting a
number measured on another one.

**Wired into `loadIndex` since B8 (2026-09-20).** The cache is the
directory `.mem/search-index/`; the single file `.mem/search-index.json`
is the old name, kept in the memory's `.gitignore` for leftovers.

### 10.21 Language per entry, not per memory — `src/langdetect.mjs`

The index used to carry ONE language, read once from `.mem/config.json`
and applied to every entry. A German company writing German notes about
English code got the wrong stemmer for whichever half did not match —
and nothing said so.

Detection is stopword overlap over the entry's fields, weighted the way
`search.mjs` already weights them for BM25, and a language wins only by
a real margin. No model, no network, no dictionary beyond the stopword
lists `language.mjs` already carries. Deterministic: the same entry
always yields the same verdict, so an index rebuild cannot quietly
change what a query matches. Below the margin the answer is the
memory's configured language — a fallback, named as one.

### 10.22 Archiving shards — `src/shardarchive.mjs`

Git does not carry a multi-gigabyte body. The build plan projected
~166.2 B/entry in `learnings.jsonl` (~792 MB per drawer type, ~4.8 GB
in all at 5,000,000 entries); re-running the
same generator on the current tree measures ~974 B/entry for
`learnings.jsonl` and a ~1253 B/entry mean across every drawer type —
6-7x the cited figure, and in line with the real corpus (p50 979 B over
2,286 real entries), which the older synthetic figure is not.

The honest number to design against is the higher one. This module
moves cold shards out of the working tree, and the discrepancy is
recorded here rather than silently corrected, because the same class of
gap is already on this house's record: *a synthetic corpus of short
entries measures retrieval wrong by an order of magnitude.*

### 10.23 Deleting from an append-only log — `src/shred.mjs`

An append-only log and a duty to delete are not compatible by editing
the log — rewriting a line is the one thing this design refuses. Crypto-
shredding resolves it without touching a byte: each entry's **body** is
encrypted at write time (AES-256-GCM, a fresh 32-byte key per entry),
the key lives in `.mem/keyring.json`, and deleting means destroying the
key and appending an ordinary new marker line (`shredded_of`,
`shredded_reason`). The original line stays exactly as written, so a
sealed hash chain still verifies.

**Named explicitly, because the point is what stays legible.**
`NEVER_ENCRYPT` is `id` (the register's key), `ts` (as-of queries), `v`
(schema dispatch), `agent` (chain replay reads it raw), `project`
(scope filtering) and the deletion marker's own fields. Everything in
`SHREDDABLE_FIELDS` is body.

Four states from `readEntryBody`, and the boundaries between them are
the feature: `ok` (decrypted), `plain` (a real entry that was never
encrypted), `unreadable` with a reason that distinguishes *the keyring
is absent entirely* from *this one key is gone*, and `unknown` when
there is no entry to inspect at all.

**It ships OFF (`shred: true` per call).** Decision of 2026-09-30 (threat
model: data theft at rest, i.e. a stolen laptop): encrypted entries are
visible and searchable for the signed-in user and the agents. With the
key present the body is decrypted **in memory only**, when the search index
is loaded and when the dashboard reads the drawers (`shred.makeReveal`); the
persisted index carries such an entry as a stub (its clear fields), and no
file under the root, cache folders included, ever holds the decrypted
words. With the key destroyed, the body leaves search and display at once;
with the key store unreachable, search and display say "not readable", never
empty. (Until 2026-09-30 such an entry was unfindable, because `title` is a
body field; that limit is closed.)

**Three more limits, measured rather than assumed:**

- **Cost fails its own criterion.** Baseline `logEntry` is ~0.08 ms flat.
  With shredding: 0.44 ms at 0 keys, 1.38 ms at 500, 6.92 ms at 3000 —
  because the keyring is read and rewritten whole on every write. That
  is the same corpus-size dependence the write path was repaired to
  remove, reintroduced by the keyring's storage design.
- **Raw capture is a separate store and is not covered.** A capture
  holding the same text survives a shred of the structured entry.
- **A versioned keyring defeats the whole mechanism.** If
  `.mem/keyring.json` is committed with retained history, destroying a
  key is just another commit and the old key is recoverable from the
  previous one — demonstrated. The keyring needs a distribution that
  does not retain history.

### 10.24 One place that appends — `src/append.mjs`

Every JSONL write in this memory is an append, and every one of them
assumed the file already ended in a newline. It usually does. When it
does not — a write cut short, a file touched from outside — the next
append merges into the last line and **two** entries become unreadable:
the new one and the one that was fine before it. Measured through the
normal CLI: a drawer holding one valid entry without a trailing newline
goes to `0 valid, 1 broken` after a single `mem log`.

There was no shared append path to fix: 14 call sites across eleven
modules here, eleven across as many in the sister house, each with the
same unchecked assumption. They now go through one function, because
the alternative is the same rule spelled fourteen times.

The check reads **one byte** — `openSync` + `fstatSync` + `readSync` at
`size - 1` — never the file. `\n` (0x0A) is never part of a multi-byte
UTF-8 sequence, so the last byte is the right question to ask. The
healing newline is prepended and written in a *single* `appendFileSync`,
because two writes would give up the O_APPEND atomicity
`test/concurrent-append.test.mjs` relies on. Cost, measured over 5000
appends: 0.0045 ms → 0.0116 ms, constant regardless of file size; an
`fsync` on the same path costs 0.24–0.29 ms.

**What it does not fix:** concurrent writers still tear lines — that is
a different failure with its own measurement in the sister house (one
line in 1922). The check limits the damage rather than preventing it.
Under a race between probe and write the worst case is an *empty* line,
which every reader here already skips.

`checkNewline: false` exists only so the guarantee can be broken on
purpose: `test/append-newline.test.mjs` uses it to show the loss coming
back, with the control running the same call checked, right beside it.

### 10.25 The agent ledger — `src/agentledger.mjs`, `mem ledger`, `mem_ledger`

An agent registry that BELIEVES a strength ("this model is strong at
design" — plausible and unproven) is assumption dressed as
measurement. `mem ledger` counts the opposite: per agent kind/model,
only what the job journal can show — jobs, jobs usable on the first
try, follow-up jobs, packages with a real `git revert`. Below **20**
jobs for a group the verdict is always `unknown (n<20)`, never a
claimed strength.

**Not a new file, not a new writer.** There is no separate ledger on
disk: it is the set of `event` entries tagged `job`, read through
`memory.iterLog()` the same way every other reader does. The logging
convention is five extra English fields on an ordinary `mem log
event`, documented in `agentledger.mjs`'s own header:

```
mem log event --project <name> --tags job,agents,<package> \
  --title "..." --package <package> --agent_kind <kind> \
  --model <model> --first_try yes|no --follow_ups <n>
```

A `package` field missing means the entry cannot be attributed to a
job — it counts in `unassigned`, never guessed at. A missing
`agent_kind`/`model` is recorded as `'unknown'`, never left null.

**"usable on the first try" is a floor, not a measurement.** Nothing
written at job time reliably says whether a follow-up will be needed
later, so a job counts as first-try-usable unless there is evidence
otherwise — the structured field, a follow-up word in the entry's own
text, or a commit on `git log --all` (every branch) whose subject
starts `<package>-followup`/`<package>-rework`. Any one of the three is
enough; none of them can be cancelled by another, so this can only
undercount follow-ups, never invent one. A revert counts only a real
`git revert` commit, deduplicated by hash across branches.

Both surfaces are read-only: `mem ledger [--json]` at the CLI,
`mem_ledger` at the bridge (`src/mcpprofile.mjs`'s `READING` list). An
empty journal reports "no jobs recorded" — not a silent, misleadingly
green zero.

### 10.26 Workflows — `src/workflow.mjs`, `mem log workflow`

A `workflow` names a SEQUENCE for a recurring task — "this is how a
release like this goes" — the way a `procedure` names a single rule.
Its `steps` ARE an instruction exactly the way a procedure's `rule` is
one, so it takes the identical authority answer rather than a second,
possibly-drifting copy of it: `workflow.isHuman`/`workflow.complete`
are `procedure.isHuman`/`procedure.complete` themselves, re-exported,
not reimplemented. Only a human issues one (`issued_by` must be
`owner` or `human:<name>`), and **the bridge does not write this type
at all** — the same `if` in `bin/mem-mcp` that already refuses
`procedure.TYPE`, right next to it.

Fields: `title`, `steps` (a non-empty array of non-empty strings),
`issued_by`, and — all optional, checked for shape but never required
— `scope`, `triggers`/`path_patterns`/`tool_patterns`/`tools` (arrays
of strings a later doctor finding reads to judge whether a workflow
has enough of them to ever fire), `source_proposal` (the id of the
`thought` it was promoted from), and `references`. `references` points
at the `procedure`/`skill`/`errorclass`/`snippet` entries a workflow
relies on by id/name only — an unknown kind, or anything shaped like
copied text rather than an id, is refused, not silently dropped.

**Found without being asked for** (`src/workflowdetect.mjs`). The
question hook and the subagent hook show a visible workflow (issued by a
human, in force, not a draft) whose `triggers` match the text on the
search's own tokens; the before-edit hook does the same for a Bash
command against `tool_patterns`, and for an edited file the component
table names (role `works-on`, from `path_patterns`). One clear winner:
its card once per session, then a pointer; a tie: titles only. `mem
workflow new|check|list|show` writes the three list fields
(comma-separated) under the same check; `mem doctor` warns on
`workflow-without-trigger`.

**Errors to fixes** (`src/errorfixes.mjs`): a commit trailer `Fixes:
<error-id>` becomes a `resolves` link with `evidence: commit:<hash>`
(`mem error-fixes backfill [--repo P]`, idempotent, an unknown id only
warns); `mem log learning --from <error-id>` writes `generalizes`;
`mem doctor` reports `error-linked`.

**The solution under its error** (`src/recallattach.mjs`, L3): wherever an
automatic path shows an error that has a valid solution, one line stands
directly below it: `  ↳ Solution <id>: <core>`. The newest valid `resolves`
link wins; its source is an entry in force (not superseded, discarded or
disputed) or a commit proof (`commit:<hash>`, the core taken from the link's
`why`). The line counts in the byte budget of the short form (H5) and in the
subagent block, where another hit gives way first. The journal's new field `ids`
carries the hit ids and the solution ids (ids only, never text).
`MEM_SOLUTION_ATTACH=0` is the emergency stop.

### 10.27 Snippets — `src/snippet.mjs`, `mem log snippet`

A `snippet` is a reusable code/script/text/mail/letter building block
carrying `{{PLACEHOLDER}}`s instead of real data. Unlike `workflow`, it
is not an authority problem — the MCP bridge MAY write this type — but
a `text`/`mail`/`letter` body MUST clear `src/redaction.mjs`'s
`redact()` before it is written, in both the CLI and the bridge; a hit
is an ABORT, not a warning (`mem snippet new|list|show` too; `mem doctor`
reports `snippet-without-redaction` for legacy lines), because the entire point of a snippet is
reuse by other agents. `code`/`script` bodies are deliberately not
redaction-gated — a credential-shaped example in a docstring is normal
there and must stay writable.

Fields: `title`, `kind` (the closed list `code`/`script`/`text`/`mail`/
`letter`), `body`, and — optional — `language`, `placeholders` (an
array, defaulted from `{{NAME}}`-shaped identifiers actually found in
`body` when not given explicitly), `origin`, `test` (a path to the
test that exercises it), `used_by` (ids of workflows that reference
it — upkeep lives at `workflow.references.snippet`, this is only the
back-reference), and `version` (a positive integer, defaulting to 1). A
later version is never an edit of the same line: it is a new entry
carrying `replaces_id`, via `memory.correctionEntry()`, the same
append-only correction mechanism every corrected entry in this house
already uses.

### 10.28 Session mail that does not cost money by itself — `src/envelope.mjs`, `src/mailpermit.mjs`, `src/routes.mjs`

Ported from lucky-mem (Block S). Before this, the watcher (`bin/mem-watch`)
started its handler, a fresh paid model session, for every new message:
a broadcast note, a thank-you, a receipt.

**Intent.** A message carries an optional `Intent` header. `information`
(the default), `result` (the default for a reply, `--in-reply-to`) and
`cancel` never wake anyone. `request` and `clarification` ask for an
answer, `read` asks to be read; those three wake the recipient — but only
with permission.

**Permission or a budget, from the user only.** Agents may write a waking
message at any time; it lies in the inbox and is reported as
`waiting-for-permission` until the user permits it
(`mem inbox permit <name> --authority user`) or gives a budget
(`mem inbox allow --letters N | --tokens N [--until D] [--to R] --authority user`).
Grants and spending are lines in `inbox/permissions.jsonl`, append-only;
a message is charged once however long it lies. Token figures are
estimates from the model-cost journal, or a named assumption, and are
always marked as such. A headless run (`MEM_HEADLESS`) and a process
under a lower `CHEAP_MEM_MAX_AUTHORITY` cannot grant; a line without
`authority: user` is listed as disputed and does not count. The limit is
the same as in 10.1: whoever can write the repository can forge a line.

**The one wake rule.** `envelope.wakes()` decides for the watcher's look
at the remote (`mem inbox watch`), after the pull (`mem inbox wake`, which
charges the grant or budget right before the handler starts) and for the
headless listing (`mem inbox new` in a handler run does not hand over a
request still waiting). Mail to the human participant never waits: no
machine wakes them. No model call anywhere in this path.

**Reply budget.** A reply is one turn deeper than its original
(`Turn: n of 6`). Past the maximum nothing in the chain wakes anyone,
whatever the permission says, so two agents cannot ping-pong.

**Routes.** A role can be played by several sessions at once. A session
that picks up its mail (`mem inbox new|show|all`) registers a route
(`inbox/routes.jsonl`: role, provider, a fingerprint of the session id,
a generated id; never the raw id). Its messages carry `From-Route`; the
write path sets `To-Route` on a reply from the original, and `mem inbox
new` does not offer such a reply to another session of the same role.
`mem inbox routes` lists them; `mem inbox permissions` shows budgets,
grants and what is waiting.

**What waits, and permitting it from the dashboard.** `mem doctor` reports
`inbox-waiting-permission`: messages the one wake rule would wake but
that lack a grant or budget (warn, with the oldest), unknown when the
ledger has a broken line (it may hide a budget). The dashboard permits a
message through the task `inbox-permit` (`POST /task`), which runs `mem
inbox permit <name> --authority user --json`; `--authority user` comes
only from a password session, and without one the task is refused before
anything runs.

**Picked up.** When the recipient itself fetches its mail (`mem inbox
new`, `mem inbox show`, MCP `mem_inbox_new`), one `picked-up` event per
message and recipient is appended to `inbox/states.jsonl` (never by the
watcher's poll, never twice). A `read` request asks for no answer: once
its recipient picked it up it reads as `processed`; a `request` stays
open until answered.

### 10.29 Experience of a skill — `src/experience.mjs`, `mem skills account|sharpen|version`, `mem experience`

Ported from lucky-mem (L3, L2b). A view over drawers that exist — the
registry, errors, learnings and the `resolves`/`generalizes`/`contradicts`
links — with no new store and no model: the code names evidence ids, a
session writes the prose. The system proposes, the owner decides.

**Scope.** An error counts for an entry only inside the scope the entry
declares: `classes` (error classes; a procedure's `on_class` counts),
`files` (paths, a trailing `/` for a folder), `topics` (an error's
`topic` or `tags`). Several axes must all hit. Without a scope an entry
gets no errors at all — an error that only sounds similar is no
experience of it. Whether a use helped is written nowhere, so it stays
unknown and is never a trigger.

**The account in the offer** (`src/recallattach.mjs`, L4): when the recall hook
offers a released skill that DECLARES a scope, the offer brings the two most
important lines of its account, e.g. `  ↳ Error (open, repeated) <id>: [class]
<core>`: open or repeated errors first (open AND repeated before only open
before only repeated, newest first), then the newest learnings in force; at most
400 bytes. A skill without a scope has no account and the store is not even read.
Never encrypted or `personal` entries. `MEM_SKILL_ACCOUNT_OFFER=0` is the stop.

**Account and package.** `mem skills account [<name>]` lists traps,
fixes, learnings, contradictions and open traps. Two cases in scope in
30 days make a proposal (one is an event). `mem skills sharpen <name>`
shows what is new since the last version — new traps, fixes proven for
14 days whose error did not come back, new learnings, newly released
procedures for the same class, questionable steps — each with its id;
ripe from 3 points of 2 kinds AND the gate. The source time of a
`Fixes:` edge is the commit time, not when backfill wrote the edge.

**Versions.** `mem skills version <name> [--text] [--title] [--classes]
[--files] [--topics] --issued-by owner --authority user` appends a
correction line (`replaces_id`) with `start_status: trial`, never
released; releasing stays `mem skills status`. Refused before writing
without both flags, in a headless run, or under a lower authority
ceiling. A version that only sets the scope keeps the package start.

**Views.** `mem experience review` names old fixes a newer learning
generalizes over (never marked obsolete by itself); `mem experience
guards` pairs tests carrying `// error: <id>` with the error and flags
a return after the test commit as a suspicion; `mem experience effect`
compares a released procedure's repetition rate 14 days before and after
its release. Doctor: `skill-sharpen`, `guard-suspicion`,
`procedure-effect` — numbers and suspicions, never a verdict, nothing
changed.

### 10.30 Command guard — `src/commandguard.mjs`, `mem command-guard`

The before-edit hook catches a repeated mistake on a FILE; for a shell
command it saw nothing, so `pkill chrome`, `git add -A` or `rm -rf /tmp`
could be repeated although the error was logged. An error of the class
`mishandling` may therefore carry a **command pattern** (field
`command_pattern`, written with `mem log error ... --command-pattern
"git add -A$ ;; git add --all$"`; for an old error a correction line, see
`mem command-guard seed`). When a Bash command matches, the hook shows the
error once per session and error (title, class, id) and **never blocks**.

Matching is literal, without a parser or a shell: the first wording of a
pattern must stand where a command starts (line start, after `;` `&` `|`
`(`, behind `sudo`/`time`/`VAR=x`, or first in `bash -c "..."`), so a
sentence that only names the command triggers nothing; wordings joined with
` & ` must ALL occur; a trailing `$` allows no further argument. A pattern
nothing can match (under 4 characters, quotes, non-ASCII) is refused at
write time. A shell prefilter in `bin/mem-before-edit` (and its `.ps1` twin)
starts node only when a keyword of the derived booklet
(`.pipeline/command-guard/words.txt`) occurs in the hook JSON or the booklet
is stale; with no pattern recorded there is no extra process. cm ships
empty: no pattern comes with the code. The pattern is never learned from
hits and changes no rank. `mem command-guard show` prints the coverage
(`mishandling` incidents carrying a pattern); `check "<command>"` is a dry
run.

