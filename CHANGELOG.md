# Changelog

A memory tool that could not say what changed between two of its own
states was the joke this file ends. Started 2026-09-08, after an
external review pointed out that a project built on "measured, not
guessed" had no record of its own history beyond `git log`.

Entries before that date are reconstructed from the commit history and
are therefore coarser than what follows. Where a day's work was
measured, the measurement is here rather than a summary of it.

Format follows [Keep a Changelog](https://keepachangelog.com). Dates
are the day the work landed on `main`.

## Unreleased

### Added

- **Cloud and local stores found by name** (`src/stores.mjs`).
  `mem raw archive --list-stores` finds Google Drive, iCloud, OneDrive
  and Dropbox on macOS, Windows and Linux, expanding the account
  wildcard those paths carry. `--set gdrive` then needs no path.
  Two candidates are reported as ambiguous rather than silently taking
  the first. A syncing store gets a warning naming all three
  consequences (eviction, no write barrier, shared use), attached to the
  path rather than to the command.
- **The archive** (`src/archive.mjs`). Raw captures live outside the
  repository; `raw-record.jsonl` stays tracked with one line per capture
  (stamp, span, line count, bytes, SHA-256, location, what was dropped).
  `mem raw archive`, `mem raw migrate`, `mem raw export --from/--to`
  with an optional hour window.
- **Machine-local archive location** (`.mem/archive.json`), set once via
  `mem raw archive --set`. `CHEAP_MEM_ARCHIVE` still wins for a single
  run; the report always names which of the three sources was used.
- `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`.
- A guard for the README's own numbers (`test/readme-zahlen.test.mjs`),
  because numbers in prose have no guard and therefore rot.
- **The error-class vocabulary** (`src/errorclass.mjs`, `mem classes`).
  Twelve closed classes, each with the question that decides it
  (`looks-right-does-nothing` asks *"What would be visible if it did NOT
  work?"*). Counted in the sibling project that motivated it: 303 error
  entries in 212 class names, 167 used exactly once — the dominant
  defect type was invisible because everyone coined a fresh name.
  Old names map through a literal-only `ALIAS`; `normalise()` returns
  `null` rather than guessing, and `coverage()` names what it could not
  map. `mem log error` warns on an unknown class and **writes it
  anyway** — a write that fails on a naming rule loses the content.
- **The board** (`src/board.mjs`, `mem board`). Seven tiles on one
  screen: raw archive, digest, error classes, agents, open questions,
  installation, MCP bridge. Four states, never two — `calm`, `watch`,
  `alarm`, and `unknown`, which is deliberately not green. `--html`
  renders one self-contained page: no script, no external source,
  because a board that stays empty when a script fails to load reports
  calm by omission. Every tile carries its own age; a condition that is
  normal is never drawn as a loss (a capture recorded by another machine
  counts as `foreign`, not `missing`).
- `mem bridge report <short-hash>` — an MCP bridge reports the checkout
  it is serving. Reports are **appended** to
  `.mem/bridge-reports.jsonl`, never overwritten: the first draft
  rewrote one JSON file, which would have made it the only bridge tool
  that CHANGES something. Appending also answers a question the
  overwrite could not — since when has this server been on the same
  checkout, and how often has it restarted. The board cannot measure that from inside, so it stays
  `unknown` until something reports. On 2026-09-08 a bridge ran a whole
  day on the previous day's checkout and an outside agent noticed; a
  board that inferred the running state from the repo state would have
  shown green for that entire day.
- **Code symbols are findable by ranked search** (`symbols` field,
  `qualifiziert` identifier pattern). An entry was always allowed to
  carry `symbols` and `--literal` found it; ranked search did not.
  Measured: symbol in the title → 1 hit, the same symbol only in
  `symbols` → 0 hits, `--literal` → 1 hit. Two causes, both measured:
  `symbols` had no field weight, so BM25 never saw it, and none of the
  five identifier patterns recognised a dotted name — `bezeichner()`
  returned an EMPTY set for `TokenStore.write`. The exact lane, built
  for precisely this kind of question, was blind to code symbols.

  The new pattern requires at least two characters per segment, which
  keeps `z.B.`, `u.a.`, `d.h.`, `e.g.` and `i.e.` out of a German
  corpus, and it needs no stop list: the existing `platz` bound already
  removes anything occurring in more documents than the answer has
  slots. Measured on 1153 real entries: 7469 identifiers before, 8610
  after (+15.3 %), 488 distinct new ones, 416 of them (85 %) in at most
  three entries.
- **Procedures can be armed by error class** (`--on-class`). Filing an
  error of that class offers the rule that was written against it — at
  the one moment it is wanted, rather than when somebody remembers to
  run `mem procedures`. Cheap here and expensive elsewhere: matching by
  keyword is guessing, matching against twelve fixed names is a lookup.
  An unknown class is REFUSED at write time — the opposite of `mem log`
  everywhere else, because there is no content to lose and a trigger on
  a class that does not exist never fires while looking armed. Old class
  names are normalised on the way in.
- **`hasMore` and a corpus generation on every retrieval** — and,
  deliberately, no cursor. See the Fixed entry below for why the
  pagination this was meant to become was taken back out.
- **`coverage_state` on every retrieval.** The gateway returned
  `truncated: true|false` — two states for a three-state question. The
  missing third is the one that matters: *the search space could not be
  established*. An empty answer from a caller with no capability used to
  report `truncated: false`, which reads as "we looked and there was
  nothing" when nothing was searched at all.

  Now `known_complete` / `known_partial` / `unknown_coverage`, each with
  the reasons that produced it — a state with reasons, never a number,
  because 0.8 against 0.9 says nothing about WHICH limit bit. UNKNOWN
  beats PARTIAL: a run that could not establish its space must not
  report a mere partial. Printed by `mem retrieve` and by `mem_retrieve`
  at the bridge **even when the news is good**, because printing it only
  on a cut would teach that silence means completeness.

  `known_complete` means no limit cut THIS answer. It is never proof
  that nothing else exists, and the output says so.
- `mem find --brief` now appears in `find --help`. It existed, it was in
  the README, and it was missing from the one place someone looks.
- **The console** (`mem serve`, `src/console.mjs`, `bin/mem-serve`). One
  fixed link carrying the state, the settings, the installation steps,
  the connections and the viewer — and the only place where anything can
  be SET without a shell. `/`, `/viewer`, `/console.json`, `/health`.

  It is a daemon, which the viewer file deliberately was not, so it
  carries that file's two properties (renders only the redacted drawers,
  writes no rendered content to disk) plus a third: **fail-closed**.
  With no `CHEAP_MEM_SERVE_TOKEN` it serves localhost only, and binding
  to a public address without one is REFUSED — the process does not
  start. A request without a valid token gets exactly what an unknown
  path gets, a bare 404.

  Writing over HTTP has three latches: a closed `SETTINGS` list (an
  unknown field is refused, not ignored), the same writer the CLI uses
  (`archive.setLocation` with its write probe), and an Origin check
  stricter than the one for reads. Every change is logged to
  `.mem/console-log.jsonl`. `CHEAP_MEM_SERVE_READONLY=1` shows
  everything and sets nothing — and says so. Of any token, only WHETHER
  it is set ever appears on the page.
- **`src/webauth.mjs`** — the bind rule, the constant-time comparison,
  the auth decision and the POST origin check, in one place, because two
  copies of one door means one of them is tested and the other is the
  one with the hole.
- `docs/CAPABILITIES.md` gained a **module inventory** — every file in
  `src/`, one line each — plus sections 10.16 and 10.17 for the error
  classes and the board, and 7.4 for the console.
- **A release path** (`.github/workflows/release.yml`). Publishing runs
  on a `v*` tag and passes four gates: the tag must equal the manifest
  version and the changelog must name it; lint and tests run on the
  tagged commit; the tarball is packed, installed into an empty
  directory and the CLI is run from it — the only check that sees the
  package the way a stranger does, since every test in the repository
  runs from a checkout where nothing can be missing. It also fails if a
  memory, a raw capture or a `node_modules` reached the tarball.
  `npm publish --provenance` over OIDC; the job holding the registry
  token has read-only access to the repository. `workflow_dispatch`
  exercises everything except the publish, because a release path only
  ever run for real is one nobody has tested.
- **`mem_bridge_report` and `mem_board` at the MCP bridge.** The bridge
  tile asks whether the server outside is serving the code in this repo.
  From inside that is unmeasurable, so the server must report it — and
  the command for it existed only in the CLI, while the agents it is
  about come in over the bridge and have no CLI. The tile would have
  stayed `unknown` forever for exactly the cases it was built for.
- The bridge tool list is now **asserted by name** in
  `test/bridge-reach.test.mjs`. `docs/CAPABILITIES.md` had claimed that
  guard existed since the port; it did not. A guarantee stated in the
  reference and absent from the code is worse than a missing one,
  because a reader who believes it stops looking.
- Two guards for the parts CI cannot reach: `test/package-contents.test.mjs`
  walks every relative import from both entry points and asks whether
  `package.json`'s `files` list would ship it (an omission there fails
  only on a stranger's machine, after the release);
  `test/release-workflow.test.mjs` checks the workflow's own shape — no
  `needs:` pointing at a renamed job, the publish behind every gate and
  behind its condition, no literal token, and no cancel-in-progress on a
  release.

### Changed

- **Captures drop what is not conversation.** Measured over 21 real
  transcripts (41.30 MB): `attachment` lines are 51.7 % of the volume,
  and the largest item inside them is the task reminder, re-dumped
  nearly every turn. Same 16.5 MB transcript captured both ways:
  4.83 MB gzipped without the filter, 2.09 MB with it — **56.8 % less**.
  `thinking` is deliberately kept. Every capture header books what was
  dropped and why.

### Fixed

- `--on-class` arrived hyphenated and would have been stored as
  `on-class` while the reader looked for `on_class` — the same trap
  `--issued-by` fell into once, one field later. A rule that exists and
  never fires is the class it was probably written against.

- **Snapshot-bound pagination was built and then removed, because it
  cost two measured defences.** The path is the record:

  First attempt (`selectWant = offset + want + 1`): one claim came back
  on page 2 AND page 3 — nine entries from nine authors, 9 rows, 1 of
  them twice. The author-share cap and the context budget work on the
  SELECTION, not the corpus, so a different selection size means
  different survivors and shifted offsets. A generation-bound cursor
  could never have caught it: the corpus had not changed, only the
  question about it had.

  Second attempt (`selectWant = maxResults + 1`, constant): pages fit
  together, and four existing probes went red. They were positive
  controls — "if MMR changes nothing on this fixture, the comparison
  above proves nothing". With 51 selected everything on a small fixture
  gets in, so MMR no longer shaped the selection, which is exactly its
  job here (measured 7/18 → 9/18 on the eval corpus). The flooding
  defence from 2026-09-05 rests on the same property.

  A measured defence had been traded for a convenience feature, and only
  the shape of the old probes caught it. What remains is the honest
  half: `hasMore`, derived from the selection loop stopping early, which
  costs no widening and claims nothing about how many more exist. A
  cursor is REFUSED rather than ignored — falling back to page one would
  answer a question nobody asked and look like success.

- **The secret latch flagged `token: env.FOO_TOKEN` as a secret.** That
  line NAMES an environment variable; it is not one. `process.env.X` was
  already treated as a reference, and a parameter literally called `env`
  is the house style for "the environment this was configured from" —
  exactly so a service does not read `process.env` behind its caller's
  back. The rule now covers the bare name `env` too. This widens
  PRECISION, never reach: the `looksLikeCredential` gate still applies,
  so a value that merely starts with `env.` and is credential-shaped is
  still caught, and `config.env.X` stays flagged because it could be
  anything. Three probes and two sabotages hold both directions.

- **`docs/CAPABILITIES.md` claimed an HTTP viewer that did not exist.**
  The Surfaces row and section 7.3 both described one; `mem viewer`
  writes a file. Third claim of the same family found this week, after
  the by-name tool list and the substring completeness guard. Rather
  than delete the claim, `mem serve` makes it true — and 7.3 now says
  plainly what the file mode is.
- The console's own store list announced four cloud drives on a Linux
  container that has none: `stores.discover()` returns every store with
  a possibly-empty `found` array, and the first draft mapped all of
  them. A claim about the machine, produced by not reading a field — in
  the page built to prevent exactly that.

- **The default archive location was gitignored, and that loses data.**
  It was `.mem/raw`; `.mem/` does not travel. On a machine with a disk
  that is fine, and it is false wherever the repository IS the disk — a
  cloud container, an ephemeral runner. Measured in the sibling
  project's own container on 2026-09-08: the last capture to reach the
  repository was at 19:36, and eight after it would have gone with the
  container, including the ones from the session that made the change.
  The default is now the tracked `raw/`; an archive elsewhere is a
  decision per machine (`mem raw archive --set`, `CHEAP_MEM_ARCHIVE`),
  and still wins.

  `test/stop-persists.sh` had been reporting this the whole time and was
  on a list as an outdated shell test. It was not outdated. It is green
  again without one line of it having changed, which is the proof of
  which side was wrong.

- **The record file had a German name in an English codebase.** The
  archive was ported from a German-language sibling and kept
  `raw-nachweis.jsonl`, while this CHANGELOG already called it
  `raw-record.jsonl` — two truths, one of them the code. Renamed, with a
  one-time move so a memory that already captured does not silently
  start a second, empty record.
- **The completeness guard for `docs/CAPABILITIES.md` was checking for
  substrings.** `board`, `classes` and `bridge` all passed while the
  reference named none of them: `board` sits inside "dashboard",
  `bridge` in prose about the MCP bridge. The guard now asks a narrower
  question per kind (a CLI command must be in the 7.1 block, a module
  must appear as `<name>.mjs`) and carries a positive control. The
  narrower guard immediately found 14 modules the reference had never
  named.
- **The README had two `## Commands` sections.** The lower one was older
  and had drifted — it still called `mem find` a "substring search",
  which stopped being true when ranking landed. Merged into one, with a
  guard against a second appearing.
- The command counts disagreed between the inventory table (44) and the
  section heading (45) of `docs/CAPABILITIES.md`. Both are now guarded
  against the code.
- Section 10 of `docs/CAPABILITIES.md` had two subsections numbered
  10.12 and its numbering ran 10.13, 10.14, 10.12, 10.11, 10.12.
  Renumbered in file order.

- **Redaction over-masked and reformatted while it did.** An env var
  *reference* was masked as if it were a value, and the separator around
  it was rewritten (a YAML colon came back as an equals sign). The
  digest reads these captures with a model, so this was corrupted source
  producing wrong facts, quietly.
- **A hook with a baked-in absolute path was dead on a second machine,
  and dead silently** — the session started without its memory and
  looked exactly like one that never had any. The root is now looked up,
  and a failed lookup says so and names the path. `MEM_HOOK_OFF=1`
  remains the only silent exit.
- **A transcript that shrank stopped being captured**, forever: the
  increment went negative and the capture reported "nothing new". (This
  one existed in the sibling project, not here — noted because the two
  are ported from each other and the asymmetry is the lesson.)

### Corrected

- The README claimed **"~500 lines of JS"** against a real ~18,900 —
  off by a factor of thirty-two — and **"all 17 MCP tools"** against a
  real 26. Neither was said on purpose; both were true once and nobody
  re-counted. For a project that argues for itself with honest
  self-description, that is the most expensive error available, so the
  counts now have a test.
- A historical measurement ("0 of 17 MCP tools" seen by three AI
  evaluations) is now dated, so it cannot be read as a current claim.

## 2026-09-08

The bridge caught up with the CLI: **20 → 26 MCP tools**, adding
heartbeats, open questions, procedures, sources, components and
neighbours. Provenance is stamped on every write by the server, never
accepted from the caller.

An id lane: asking for an entry id now returns that one entry. Reported
by a connected agent who wrote an entry over the bridge and could not
find it again — and the onboarding check had reported that route green,
because it queried a different lane.

Duplicate rate measured at **1.8 %**, and the raw figure that preceded
it was wrong.

## 2026-09-07

The error class asks itself at the moment of logging: entering one now
shows how often that class has occurred and when it last did.

## 2026-09-05

The largest single day (50 commits): the complete capability reference
in `docs/CAPABILITIES.md`, written after three AI evaluations read the
README and reported built features as missing.

## 2026-08-29 – 2026-09-03

Initial port from the private sibling project: the CLI, the entry types,
the inbox, the watcher, the MCP server, the install scripts, the Windows
port, CI on three platforms.
