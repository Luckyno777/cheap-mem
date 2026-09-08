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
- `mem bridge state <short-hash>` — an MCP bridge reports the checkout
  it is serving. The board cannot measure that from inside, so it stays
  `unknown` until something reports. On 2026-09-08 a bridge ran a whole
  day on the previous day's checkout and an outside agent noticed; a
  board that inferred the running state from the repo state would have
  shown green for that entire day.
- `docs/CAPABILITIES.md` gained a **module inventory** — all 42 files in
  `src/`, one line each — plus sections 10.16 and 10.17 for the two new
  modules.

### Changed

- **Captures drop what is not conversation.** Measured over 21 real
  transcripts (41.30 MB): `attachment` lines are 51.7 % of the volume,
  and the largest item inside them is the task reminder, re-dumped
  nearly every turn. Same 16.5 MB transcript captured both ways:
  4.83 MB gzipped without the filter, 2.09 MB with it — **56.8 % less**.
  `thinking` is deliberately kept. Every capture header books what was
  dropped and why.

### Fixed

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
