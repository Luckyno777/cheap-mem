# How big can one memory get

Everything here is measured on real corpora with the real code
(`node bench/scale.mjs`), not estimated. Numbers are from 2026-09-05,
Node 22, one container. Your machine will differ; the shape will not.

## The short answer

**Keep one memory under about 50,000 entries.** Past that the recall hook
stops being invisible, which is the whole premise. Split before you get
there — see [Sharding](#sharding-is-the-answer-not-a-bigger-index) below.

## What actually costs time

Not the search. The index.

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
