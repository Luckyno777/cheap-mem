# How big can one memory get

Everything here is measured on real corpora with the real code
(`node bench/scale.mjs`), not estimated. Numbers are from 2026-09-05,
Node 22, one container. Your machine will differ; the shape will not.

## The short answer

**Keep one memory under about 50,000 entries.** Past that the recall hook
stops being invisible, which is the whole premise. Split before you get
there — see [Sharding](#sharding-is-the-answer-not-a-bigger-index) below.

`mem doctor` now watches this itself (external audit, 2026-09-19):
`checkCorpusSize` counts the corpus on every run and warns once it
crosses the 50,000-entry line above, naming the actual measured cost —
1237 MB heap and 746 ms search latency at 400,000 entries, not an
estimate — rather than leaving the number to be remembered by whoever
read this file once. Below the line it still states the count, so it
can be watched growing towards one. A WARNING, never an error: a large
corpus is not broken, only slower, and sharding is a migration a team
schedules, not something a build should be able to fail over.
Configurable per memory via `.mem/config.json`'s `corpusWarnThreshold`
for a memory that has deliberately decided to run larger.

## What actually costs time

Not the search. The index.

_Reading the table: "search itself" is WARM (in-process); "index load" and "after one new entry" are what a COLD fresh process pays. Older measurement, commit not recorded; current cold/warm figures with commit and hardware: `bench/cold-find.json`._

| entries | search itself | index load (cached) | after one new entry | index file |
|---:|---:|---:|---:|---:|
| 20 000 | 25 ms | 171 ms | 108 ms | 9 MB |
| 50 000 | 61 ms | 430 ms | 296 ms | 23 MB |
| 100 000 | 163 ms | 816 ms | 571 ms | 46 MB |
| 200 000 | 247 ms | 1 719 ms | 1 827 ms | 91 MB |

The middle column is the floor, and it is the one that matters: every
`mem find` is a fresh process that has to read and parse the whole index
file before it can answer. At 200k that is ~1.7 s **before any work
happens** — 1.2 s of it is `JSON.parse` alone.

The last column used to be far worse. Any single new entry invalidated
the whole cache, so the next search paid a full rebuild: 9.5 s at 200k. A
memory that captures every session writes constantly, so that was the
normal case, not the edge one. Appending fixed that (see below), which is
why the last two columns now sit close together — the load is the floor
and appending reaches it.

## Appending, and what it does not do

`loadIndex` adds newly appended lines to the cached index instead of
rebuilding. It updates the documents, the term frequencies and the
averages **exactly** — the test suite asserts an appended index is
document-for-document identical to a rebuilt one.

It does **not** recompute the compound lexicon or the two learned graphs
(tags, term co-occurrence). Those are corpus-wide statistics and
recomputing them is most of what a build costs. They drift instead, and
`REBUILD_AFTER_FRACTION` bounds the drift: once a fifth of the corpus
arrived after the last full build, the next search pays for a real one.
So retrieval *quality* lags the newest entries slightly. Finding them
does not — the documents are in the index immediately.

Appending refuses and falls back to a full rebuild whenever the change is
not a pure append: a shrunk file, a deleted file, or a changed prefix.
That last one is not hypothetical — `git pull --rebase` replays a local
commit on top of a remote one, so a line can appear in the *middle* of a
file that is only ever appended to locally. Tracking sizes alone would
index one line twice and miss another; a hash of the end of the indexed
prefix catches it in one 4 KB read.

## Sharding is the answer, not a bigger index

At 500–1000 entries a day — a small company, several people, sessions all
day — 50k arrives in **7 weeks to 3 months**, and 200k inside a year.

The temptation is to make one index faster. Don't. The fix is to stop
putting everything in one memory:

- **One memory per team, product or client.** Not one per company. This
  is not only a performance boundary, it is the access boundary you
  probably want anyway — the payments team's memory is not the support
  team's to read.
- **Projects inside a memory, not memories inside a repo.** `projects/`
  is for slicing one team's work, not for housing three teams.
- **The digest scales with the shards.** One model call per timer per
  memory. Ten memories cost ten calls; one memory ten times the size
  costs one call that cannot read its own backlog.

A memory that stays under 50k has a search that costs milliseconds and a
recall hook nobody notices. That is the product. Ten such memories are
ten fast memories; one memory of 500k is a slow one.

## When cheap-mem is the wrong tool

Be honest about the ceiling. If you genuinely need one searchable memory
of hundreds of thousands of entries that many people write to at once,
the design here stops paying:

- a process per query that deserializes the whole index cannot be fixed
  by tuning; it needs a store you can query without loading it
- git as the transport is fine for appends (`*.jsonl merge=union` in
  `.gitattributes` makes concurrent appends merge without conflicts), but
  it is not a coordination layer

SQLite with FTS5 is the honest next step: still one file, still no
server, still no model in the read path. It is also the point where this
stops being cheap-mem and becomes something else. Splitting the memory is
almost always the cheaper answer, and it is available today.

## The full-surface run

This page answers one question — how big can one memory get — from
`node bench/scale.mjs`, which measures the search path. The wider run is
`npm run atlas`: every command executed as a process, 8 phases, four
verdicts, and one JSON a later run is diffed against.

Its ceiling phase re-measures the ladder above and then does the thing
that makes a projection worth anything: it fits on the smaller rungs,
predicts the largest, and checks the prediction against what that rung
actually measured. Three of five models fail that check — so the timings
here describe the sizes they were taken at, and not much beyond them.
The one clean exception is the index cache, whose growth is linear and
predicted within 1.6 %. It used to carry a hard limit — at about 978 000
entries the single-file cache exceeded V8's maximum string length and
`JSON.parse` could not read it at all — until the shard cache of
2026-09-20 (B8, `src/indexcache.mjs`) removed that wall on purpose.

[docs/benchmark-atlas.md](benchmark-atlas.md) is the reading of that run,
including the walls, what is confirmed broken, and the blind spots (28 in
the run it reads) — the things it could not see.

## The scale gate

`node bench/scale-gate.mjs` is the pass/fail counterpart of the tables above:
a ladder of rungs (10,000, 100,000 and 1,000,000 entries by default, never
more) built on a Heaps-law corpus with the gold world written on top, judged
against limits that were committed BEFORE the first run
(`bench/scale-gate-criteria.json`, each limit with the documented figure it
comes from). Per rung it checks recall against the 10k rung, p95 of a cold
`mem find`, of a warm search and of the warm recall server, build time and
peak RSS, that `mem doctor`, the dashboard and the link map answer, that the
time questions (`--since`, `--as-of`) answer, and that one write after the
build is found again.

Three verdicts: `pass`, `fail`, and `unknown`. A value that was not measured
never passes, an aborted rung is `unknown` rather than failed, and a rung the
machine cannot hold is refused up front ("unknown (insufficient resources)")
from a disk and RAM estimate made on a small calibration rung. Each rung's row
is appended to a JSONL the moment it finishes (`--resume` skips finished
rungs); everything lives under the temp directory and is removed afterwards.
It is meant for a quiet machine: the documented timings were taken at load 3
to 8 on four cores, and the row records the load it ran at.
