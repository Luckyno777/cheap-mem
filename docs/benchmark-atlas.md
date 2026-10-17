# The atlas: what this memory does under load, and where it stops

`npm run atlas` runs every command as a real process against real
corpora, records what it measured next to what was expected, and writes
one JSON a later run can be diffed against. This page is the reading of
that run.

Everything here was measured on the machine and date named below. Nothing
on this page is an estimate unless it says so — and where something is an
extrapolation, it says so in the same sentence as the number.

```
npm run atlas              # every phase, ~16 min
npm run atlas:quick        # smaller corpora, ~2 min
npm run atlas:baseline     # …and overwrite bench/atlas-baseline.json
npm run atlas:compare      # this run against that baseline
node bench/atlas.mjs --phase ceiling,real
```

## How to read it

Four verdicts, not two:

| | |
|---|---|
| **pass** | measured, and it matched the stated expectation |
| **fail** | measured, and it did not |
| **degraded** | works, but worse than documented or than the run before |
| **not-measured** | could not be checked here — **this is not a pass** |

The fourth one is the point. A harness that quietly skips what it cannot
reach hands out a clean bill of health for a system it never looked at.
So a phase whose module is missing is recorded by name, a probe that
cannot run says why, and the run's exit code carries it: `0` everything
that ran passed, `1` something failed or degraded, `3` nothing failed but
something could not be measured.

There is deliberately **no overall score**. A single number is exactly
what lets a bad result hide behind a good average, and the thresholds
that would produce it are the most arguable part of any benchmark. The
report prints expectation and measurement side by side and leaves the
judgement where it belongs.

**A green run is not a clean bill of health.** Read it as "no problems
among the checks that ran", then read the blind-spot list, which is
printed by name and never summarised away.

## The run this page describes

Numbers below come from the committed baseline,
`bench/atlas-baseline.json`. Re-running produces a new one; timings will
differ by machine, the shapes will not.

| | |
|---|---|
| date | 2026-09-20 |
| node | v22.22.2, linux x64 |
| cpu | Intel Xeon @ 2.80 GHz, 4 cores, 16 GB |
| bare node start | 28.9 ms p50 — **every CLI number below includes this** |
| corpus | `buildCorpus`, seed 42, deterministic |
| run | 412 records in 969 s, 28 blind spots |

> Taken with nothing else running. An earlier attempt had two copies of
> this benchmark racing each other on four cores, because a shell line of
> the form `lint && echo && nohup node … &` backgrounds the whole chain
> rather than its last command. Every timing from that attempt was
> discarded: a benchmark that loses half the CPU to a second benchmark
> measures the machine.

## What the run says, in one table

| phase | pass | fail | degraded | not measured |
|---|---:|---:|---:|---:|
| surface — every command, executed as a process | 161 | 0 | 0 | 11 |
| load — scale, latency, and whether the right answer survives | 23 | 0 | 0 | 2 |
| doctor — the state ladder: which findings can fail at all | 42 | 0 | 0 | 0 |
| defence — neutralisation, flooding, tamper detection | 8 | 0 | 3 | 1 |
| robust — broken state and concurrent writers | 56 | 0 | 0 | 4 |
| ceiling — where this design stops working | 9 | 1 | 4 | 10 |
| register — the sqlite+FTS5 register prototype against today's linear scan | 7 | 0 | 0 | 49 |
| real — the same measurements against a grown memory | 16 | 0 | 1 | 4 |

## The measured ladder

Five corpus sizes were planned, each built fresh, each measured through
the real CLI. This run reached four of them: the 150,000-entry rung was
never attempted — the disk-space check estimated 1,778 MB needed against
901 MB free, and refused to build it rather than guess. That rung is
`not-measured`, not zero; direct measurement above 60,008 entries did not
happen this run. Wall time, p50, in milliseconds. Index cache is what
`mem find` has to read before it can answer anything.

| entries | `find` | `doctor` | `context` | index build | index cache | corpus on disk | peak RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 008 | 202 ms | 499 ms | 121 ms | 810 ms | 2.6 MB | 1.2 MB | 100 MB |
| 5 008 | 449 ms | 1 373 ms | 138 ms | 2 890 ms | 13.5 MB | 5.9 MB | 185 MB |
| 20 008 | 1 350 ms | 4 802 ms | 219 ms | 11 410 ms | 54.7 MB | 23.9 MB | 329 MB |
| 60 008 | 3 864 ms | 16 678 ms | 419 ms | 37 248 ms | 165.3 MB | 71.9 MB | 660 MB |

`mem context` is the outlier in the good direction: it grows with an
exponent of 0.298, which is closest to flat of the five. It is also the
call the SessionStart hook makes on every new session
(`install/hooks/session-start.sh` runs `mem context --n 10`), so that is
the one of these numbers a person feels most often. Over these four
rungs `mem doctor` grows at 0.86, the index build at 0.94, and `find` at
0.72 — `find` and `doctor` are markedly steeper here than the previous,
five-rung run measured; see the counter-check below before trusting
either shape.

## The part most benchmarks leave out: does the model predict anything?

Each series is fitted to `t = a · n^b`. A fit alone proves nothing — it
is drawn through the same points it is being judged on. So every series
is also **counter-checked**: fit on the smaller rungs only, predict the
one held back, and compare against what it actually measured. This run
had exactly four rungs — the floor `MIN_RUNGS_FOR_FIT` allows — so each
counter-check trains on three and holds back the fourth (60,008
entries), not four holding back a fifth the way a five-rung run does.
Fewer training points move the error margins around; read this table as
noisier than a five-rung run's.

| series | exponent b | R² | predicted the held-back rung | |
|---|---:|---:|---:|---|
| index cache size | 1.014 | 1.000 | **1.6 % off** | ✅ |
| index build | 0.937 | 0.995 | **23.3 % off** | ✅ |
| `mem doctor` | 0.855 | 0.984 | 38.6 % off | ❌ |
| `mem find` | 0.721 | 0.980 | 35.3 % off | ❌ |
| `mem context` | 0.298 | 0.881 | 39.4 % off | ❌ |

**Three of the five models cannot predict one rung they did not see.**
Their R² still looks respectable — 0.88 to 0.98 for the three that miss
— and it means very little on its own: R² measures how well a curve
describes the points it was drawn through, not whether it forecasts
anything. The other two — the index build time and the index size —
land within the 25% pass threshold on the held-out rung; on this run
they are the only two series this page treats as predictive, and the
index build's margin (23.3%) is close enough to that threshold that a
different quiet machine could tip it either way.

So the honest conclusion from this phase is:

> **The size of the index, and — on this run, more narrowly than before
> — how long building it takes, are the only quantities whose growth
> this design reliably predicts. Every other timing extrapolated to 5
> million entries is a shape, not a figure.**

Accordingly, every 5 M timing in the run is recorded `not-measured`, with
`expected: null`, and its evidence names the largest rung actually
reached. A fit from fewer than four rungs is refused outright — two
points make an R² of exactly 1 and say nothing at all.

## Five walls

Where this design stops working, and why. Measured or computed here;
never asserted from reading the code.

### 1. The whole-cache JSON.parse wall is gone — B8 removed it on purpose

Until 2026-09-20 `loadIndex` did
`JSON.parse(fs.readFileSync(cachePath, 'utf8'))` on the whole index
cache — one JavaScript string before parsing could start — and this wall
measured the entry count at which that string would cross V8's maximum
string length. **That wall no longer exists, and the removal was
deliberate, not a regression to paper over.** Build step B8
(`src/indexcache.mjs`) replaced the single-file cache with a shard
directory: `writeIndexCache`'s `planShards` caps every document shard at
`MAX_SHARD_BYTES` (33 554 432 B) before it is ever written, so no shard
read can approach the string limit at any corpus size — a structural
guarantee, not an extrapolation. The largest shard this run actually
saw, at 60 008 entries, was **33 554 431 B** — one byte under the cap it
is designed never to cross.

`meta.json` is the one piece of the cache still read as a single JSON
string, and it is what this wall checks now. It holds vocabulary
structures that grow sub-linearly with the corpus (Heaps' law), so
rather than extrapolate it to 5 M the way the retired wall did for the
whole cache, this reports its measured size at the largest rung reached:
17 338 921 B at 60 008 entries, **288.94 bytes per entry**, 3.2% of V8's
536 870 888-byte string limit and 4.1% of the 419 430 400-byte
`META_SIZE_LIMIT` this design imposes on itself. The old hard wall — a
fixed entry count past which the cache became unreadable — has no
replacement, because the design it applied to (one growing JSON string)
no longer exists.

### 2. Reading one drawer holds 3.6 MB per MB on disk

`memory.readLog` does `readFileSync` then `split('\n')` then parses each
line: the file exists as a string, as an array of lines, and as parsed
objects, all at once. Measured on drawers this phase builds for the
purpose — 4, 16, 64 and 128 MB — running `readLog` alone in a fresh
process against a control that imports the same module and reads nothing:

**3.63 MB held per MB of drawer on disk** (R² = 0.998).

One type in one project is one file, so a 5 M-entry memory is a ~5990 MB
drawer, projecting to ~21 790 MB held to read it once. Cross-checked with
a second instrument: `process.memoryUsage().heapUsed` around the same
call grows 3.1×, VmHWM 4.6×. They agree on the shape and differ as they
should — VmHWM is a high-water mark and catches the string and the split
array before either is collected, which is the number that decides
whether a container survives the call.

> An earlier version of this wall divided a whole `mem find` process peak
> by the corpus bytes and scaled that ratio: 93×, projecting 82 GB. About
> 70 MB of that ratio is a Node process existing at all, which does not
> grow with the corpus. The figure was two orders of magnitude too large.
> The whole-process number survives as its own record under its own name,
> with no expectation to miss: **123 MB for a process that finds nothing,
> plus 9.32 KB per entry** (R² = 0.989) — the difference from the 1,256 B
> an entry occupies on disk is the search index, which is what a `mem
> find` process actually peaks on.

### 3. Search is sublinear, and it does not save you

`find` grows at n^0.72 over the four rungs this run reached — still
sublinear, but steeper than a five-rung run showed. At 60 008 entries it
is already 3.9 s p50. The extrapolation to 5 M is one of the three the
counter-check rejected, so treat it as a direction, not a duration.

### 4. One writer per type: 8 entries per second at 60 k

`mem log` measured 120.4 ms per append with 60 008 entries already in
the drawer — 8.30 entries/sec through a single writer. That is not the
append; it is the per-write work around it. Writing 5 M entries at that
rate is ~7.0 days of wall clock, serialised.

### 5. git carries the whole drawer into every clone

974.1 bytes per entry in `learnings.jsonl` (measured on a real repo this
phase creates and commits into: `git add` 809 ms, `git commit` 84 ms at
2 778 entries, 2 642.6 KB). A single drawer type at 5 M entries is
~4645 MB, present whole in every clone and every checkout.

## What is confirmed broken

Each of these was measured, not inferred, and each is in the run's
`findings` list with its evidence.

**Recall no longer collapses when the question carries shared words — it
used to, and this run is the evidence it stopped.** Earlier baselines
found the anchor out of first place at three shared words and every
anchor lost outright at five, at 1 k, 5 k and 20 k alike; the cause was
the coverage multiplier in `src/search.mjs`
(`score *= (covered / groups.length) ** coverage`), which could crush a
score toward zero on incomplete coverage however strong the match was
otherwise. `src/search.mjs` now floors that multiplier
(`score *= coverageFloor + (1 - coverageFloor) * share`, `COVERAGE_FLOOR`
guarding how far coordination may pull a score down) instead of applying
it uncut. On this run first place survives up to **six** shared words and
is lost at seven — at three and five words, the corpus sizes that used to
fail (1 k, 5 k, 20 k) all pass with every anchor still returned. The
ceiling this multiplier imposes did not disappear, but it moved from
"loses at three words" to "loses at seven," and the old failure mode this
page used to report is gone.

**Flooding wins at N = 3.** Three entries that vary one word, or swap in
synonyms, are enough to push the truthful entry out. Identical copies
never win, up to N = 50 — the detector catches those. It groups by
`topic`, so an entry type that carries no topic field is never flagged:
3 of 3 flagged with a topic, 0 of 3 without.

**Tamper detection catches 1 of 5.** Four kinds of edit to stored state
go unnoticed.

**All 31 doctor findings can now reach a state other than ok, and none
falsely report `ok` on an empty memory.** Earlier runs found only 28 of
31 reachable (three findings never left `ok`, so those lines of the
report were decoration) and 13 of 31 saying `ok` about nothing where they
should have said "unknown." At least two of the three unreachable
findings were `root` and `config`, previously listed as a blind spot on
this page because `requireConfig` ran before `checkAll` and made their
sabotage cases structurally unbuildable; that blind spot is gone from
this run's report, and `doctor.break.root` and `doctor.break.config` now
both reach `error` under sabotage. `doctor.can-fail` measured 31 of 31
this run, and `doctor.ok-on-empty` measured 0 of 31 findings saying `ok`
on an empty memory (20 of 31 correctly use the third state instead).
Both were real gaps this page reported; both are closed on this run.

**`mem find` is blind to a drawer whose filename is unknown.** 42 of 285
parseable entries never reach the search when they sit in
`global/dutys.jsonl` instead of `duties.jsonl`. Since 2026-09-20 the
doctor *names* it (`orphan-drawers`, an error that reads the directory
rather than the type map), so the memory is no longer silent about the
gap — but the entries are still unreachable until the file is renamed.

## The bias every other number carries — smaller than it was

The `real` phase runs the same measurements against a grown,
hand-written memory (2 429 entries) and compares its shape against a
generated corpus of the same size. That comparison is the phase's actual
deliverable, and on this run every one of its checks passed: real and
generated are within 1.6× of each other on every shape dimension
measured, which is the phase's own pass bar (over 3× is flagged as a
bias the rest of the atlas would inherit).

| | real | generated | |
|---|---:|---:|---|
| share of entries in the largest type | 32.4 % | 32.69 % | 1.01× |
| median entry size | 969 B | 920 B | 1.05× |
| entries carrying no tags | 17.17 % | 19.87 % | 1.16× |
| entries too thin to ever be found | 0.86 % | 1.35 % | 1.57× |
| share inside the 7-day recency window | 47.51 % | 43.42 % | 1.09× |
| unparsable lines | 0 % | 0 % | no bias found |

**Earlier runs of this phase found the generator badly unrealistic** —
one type dominating the real corpus 3× more than the generated one,
entries roughly six times longer, a sixth of real entries carrying no
tags against none in the generated corpus. The corpus generator was
rewritten since; on this run its output matches the real memory's shape
within the phase's own 1.6× tolerance on every dimension checked, not
just the ones that happened to be close before. That does not make the
smooth-corpus caveat obsolete — a generator that passes this phase's
bound is not a promise that every downstream number carries zero bias,
only that this specific, checked bias shrank a great deal. **Every
latency and recall number in the other seven phases is still measured
against the generated corpus, not this one** — this phase exists to keep
that gap honest, not to erase it.

That phase reads someone's actual memory, so every value leaving it
passes a guard that accepts numbers and booleans and replaces everything
else. The guard is sabotage-verified against a made-up entry and a plain
number before anything else runs, and its own redaction count is the
phase's last check — zero is the pass. The phase writes nothing into the
memory it reads; it measures a scratch copy and says so in each record.

## What this run could not see

28 blind spots, each named in the report. The ones worth knowing:

- **direct measurement above 60 008 entries** — the disk-space check
  refused the 150,000-entry rung this run (901 MB free against an
  estimated 1,778 MB need), so the ladder stops earlier than planned and
  everything beyond is model, and the models mostly do not predict.
- **retrieval quality on the real memory** — whether `finde` returns the
  *right* entry needs a human-labelled answer key, and building one from
  the entries would mean reading them. Not faked.
- **`mem serve` beyond four anonymous GETs** — the token-guarded mode,
  the one route that can change state, and concurrent readers.
- **concurrent readers, and concurrent writers on wall 4.**
- **O_APPEND atomicity on a filesystem that does not guarantee it** —
  NFS, SMB, and `overlay`, which is what a Docker container usually
  reports. The environment check treats only six filesystems with a
  documented guarantee as safe and calls everything else *unknown*
  rather than fine; it used to be a deny-list, which meant `overlay`
  came back "atomic here". (The machine this run was taken on reports
  `ext2/ext3`, which is what `stat -f -c %T` says about ext4 — they
  share a statfs magic — so this particular run was not on overlay.)
- **`mem find-embed` and the embedding backfill** — need a local ollama
  and an optional native dependency; this phase makes no network calls
  (and since 2026-10-13 there is no embedding provider that could).
- **the register prototype past 40 000 rows** — the new `register` phase
  (sqlite+FTS5 against today's linear scan) ladders to 40,000 rows for
  this run's time budget; a 2026-09-20 one-off prototype separately
  reached 1,000,000 rows at 180.8 MB on disk, but that scale is not
  reproduced inside this run, and neither is a writer and a reader
  touching the register at the same time.

The sabotage recipes for the `root` and `config` doctor findings, listed
here in earlier runs as structurally unreachable, are no longer a blind
spot: this run reaches both (see "What is confirmed broken" above).

## Two phases added after this run: `skala` and `identifiers`

Both are in `bench/atlas.mjs` but not in the committed baseline above, which
was taken before them; the first run on a quiet machine adds them.

**`skala` (scale).** The phase counts what one call READS at a rung of
entries instead of timing it: lines and bytes read from the logs and from the
index cache by `mem find`, by the retrieval hook and by `mem context`, the
documents the search visits and the candidates per query, the index next to the
logs, and peak RSS. Wall-clock p50/p95 of the cold finds ride along as a
companion value and read `not-measured` when the load sensor saw foreign load.
The rungs come from `--rungs` (`node bench/atlas.mjs --phase skala --rungs
100000,1000000`); without it a quick run does 1,000 and 4,000 entries and a full
run 10,000 and 100,000. The 1,000,000 rung is never a default (about 1.5 GB of
RAM and, at the gate's build speed, the better part of an hour). A reference
rung (100,000, 1,000,000) that a run did not cover is a `not-measured` record
with the reason, and a named blind spot. The corpus is built by
`bench/scale-gate.mjs`, which stays its only owner; the pass bounds for RSS and
the time companion are that gate's pre-registered ones. The id `skala` is the
one the sister house uses, so the two atlases line up.

**`identifiers`.** Identifiers with an underscore, with an umlaut, and the same
typed as a transliteration (`prüfe_größe_limit` against `pruefe_groesse_limit`),
each planted with decoys that carry only the parts of the name, then asked for
by three paths (`find`, `find --recall`, `find --content-words`). The counter is
the rank of the entry that names the identifier; the expectation is rank 3 or
better. A plain word, a hyphenated and a camelCase name are the comparison
forms. A red here is a finding about the search, recorded as such; the phase
does not fix it. The sister house calls this phase `kennungen`.

`test/atlas-phase-parity.json` lists the sister house's phase ids and every
deliberate difference between the two atlases, with its reason;
`test/atlas-phase-parity.test.mjs` fails on any difference that is not named.

## Two more phases: `bridge` and `silent-errors`

Both are in `bench/atlas.mjs` and not in the committed baseline, like `skala`
and `identifiers`. Neither has an overall score and neither uses the clock:
every record carries what was expected, what was counted, the verdict and the
evidence; a group whose positive control fails reads `not-measured` and names
the control.

**`bridge`** (the sister house calls it `bruecke`). A real stdio client
(`bench/atlas/bridge-client.mjs`, the SDK's transport) against `bin/mem-mcp`
on a throwaway root, one door at a time, the doors the security ports closed:
`mem_log` with a machine or audit field, a shred switch or an unknown field,
for every writable type (refused of asked, naming the field, rows written);
`closes_id` and `guard`; a claimed authority; an appointment with
`requested_by` and a quote; `mem_inbox_write` with a foreign `from`;
`mem_store_put` outside the intake folder (absolute, `..`, in the root, a
symlink, a path that does not exist); and one `mem_log` with a title of tens of
thousands of characters without whitespace. The last is a counter, not a
timer: a preload (`bench/atlas/run-counter.mjs`) reports the longest unbroken
run any pattern scan was handed, and the expectation is the bound in
`src/entity.mjs` (512). The quick run takes about four seconds. Against
`91b1afc`, before the ports, 52 of its 75 records read `fail`; on the current
state they all pass.

**`silent-errors`** (the sister house calls it `stille-fehler`). The three-state
rule of CLAUDE.md as measured records: `memory.readLog` in five states (ok,
missing, empty, broken, unreadable); the same five states on the files `mem
find` and `mem context` read, over the CLI and over the bridge; the
client-visibility journal (E1); and the task block a subagent gets (E3), for
which `bench/atlas/inject-search-failure.mjs` makes one search lane throw in a
child process. Missing and empty may share an answer; an unreadable log must be
an error that names the file (`degraded` when it is an error that does not);
a broken line that is skipped without a word makes the answer `degraded`.
Measured on 2026-10-11: E1 was `fail` (an unreadable journal read as "no tool
was ever seen", `src/mcpvisibility.mjs` `read()`), E3 was `fail` (a failed
lane returned `null`, the same as an assignment nothing matches,
`src/subagenttask.mjs`, the catch after lane 1). Both were recorded first and
ported afterwards (change `silent-errors-cm`): `read()` now answers with a state
(`missing`, `empty`, `good`, `broken`, `unreadable`) and the task block carries
one sentence for a lane that failed or ran out of time. Both read `pass`.
E2 and E4 of the sister house's list are named as blind spots.

`test/atlas-phase-parity.json` lists the sister house's phase ids and the
phases this house does not have, each with its reason. (Until 2026-10-17 it also
carried a mapping for `bridge`/`bruecke` and `silent-errors`/`stille-fehler`;
see the next section.)

## One id per phase

From 2026-10-17 a phase has the same id in both houses, and new ids are English
in both. The sister house renames `kennungen`, `bruecke` and `stille-fehler` to
`identifiers`, `bridge` and `silent-errors` before its first baseline, and its
`netz-tempo` to `net-tempo` (names confirmed by the sister house, 2026-10-17;
its branch `agent/atlas-rahmen-lm` was not pushed yet at that date). So the `idMap` of `test/atlas-phase-parity.json` is empty.
`luckyMemPhases` is the list the sister house is building toward, and
`luckyMemPending` names the ids of it that are not on the sister house's main
branch yet, with the branch that carries them (`agent/atlas-rahmen-lm`).

An id can be held in this atlas before the phase is built: `bench/atlas/stub.mjs`
writes one record, `<id>.not-built`, with the verdict `not-measured`, and one
named blind spot, and never `pass`; a run of stubs alone ends with exit code 3,
never 0 (`exitCodeOf` in `bench/atlas/core.mjs`). `test/atlas-stub-never-passes.test.mjs`
holds that, with a positive control. The four ids agreed with the sister house
(`dashboard`, `cost`, `digest`, `net-tempo`) were stubs from the atlas frame
(`atlas-rahmen-cm`) until the next section; `cmStubs` in the parity list is empty
now, and the mechanism stays for the next agreed id. When a stub is built, its
file stops importing `stub.mjs` and its entry leaves `cmStubs` in the same commit.

## Four more phases: `dashboard`, `cost`, `digest`, `net-tempo`

Built on 2026-10-17 (change `atlas-neue-phasen-cm`), after the frame. All four lead
with a **count, never a clock**: the time a call takes depends on who else is
running, the number of processes, reads and requests does not. Each has a
threshold or expectation that is a **bound of the design or a ratchet** (today's
measured number, which may fall and must not grow), never a wish; a ratchet says
what is, not that it is good, and the record prints the figure so a reader can
disagree. Each names its blind spots. None of them has a baseline yet: the first
full run on a quiet machine adds them (the figures below are from quick runs on
2026-10-17, on a box at load 14 on 4 cores, which does not move a count).

The counters are preloads whose output file travels in the URL's query string, so
no environment variable was added (`bench/atlas/*-counter.mjs`; each header names
what it cannot see, and `test/atlas-counters-probe.test.mjs` runs each on a planted
program with the answer written down): `start-counter` (node process starts),
`module-counter` (modules loaded, command groups among them), `call-counter`
(file-system calls, opens per entry log, worker threads), and the existing
`io-counter` (lines and bytes read). Of the tempo items of 2026-10-11 (TB), TB4 to TB7
were fixed in this house and held by a test each, and TB1, TB2 and TB8 are the sister
house's by name and have counterparts here; none of them was a row of the atlas before.

**`dashboard`.** The server is `bin/mem-serve` as its own child process on a
scratch memory (`bench/atlas/serve-world.mjs`), with `io-counter` inside it; the
full build runs in a worker thread and the counter adds every row. The page's own
protocol (the page, `/dashboard.json` until the build is in, each deferred part,
the entries page by page) is replayed over HTTP, one scenario per server, and two
scenarios are compared as the difference of two deterministic counts.
`build-reads`: a full build reads each line of the entry logs at most 32 times
(measured 28.5 at 300 entries and 29.4 at 1000, so a pass count and not a byte
count). `warm-load`: a second page load reads nothing (0 lines). `write-rebuild`:
one new entry costs a full rebuild of 27.7 to 28.5 passes, not less, which the
record prints (the cache's gap between two builds is set to 0 for this scenario by
its test switches, so the run does not wait 20 s). `desk` (the counterpart of plan
item TB1): `/desk.json` collects on every call, 22.1 passes of the store per call,
and the second call reads 100 % of the first; no page asks for the route. That is a
**finding**, recorded as `fail` (minor) against the expectation that a repeated
call is served from a cache like `/dashboard.json`. `requests`: in Chromium, the
home view opens with 13 requests and `/dashboard/appointments.json` is among them
twice (the page draws once from the head and once from the full list, and each
draw asks again), a **finding** recorded as `fail` (minor); the entries view asks
11 and none twice. Blind spots: the replay is a model of the page; time is
`bench/board-tempo.mjs`'s question and is not judged; the compact build above the
size limit, writes and a second client are not entered. Without Chromium
`requests` reads `not-measured`; where a process cannot be ended gracefully
(Windows) the read counters are missing and the rows say so instead of counting 0.

**`net-tempo`.** This house had no counter for the 3D network, so
`bench/atlas/net-counter.mjs` is it: calls of `initGraph()` (builds) and
`graphModel()` (model computations) through a wrapper appended to the served
script, and WebGL contexts and linked programs through patches installed before
the page's own script, so nothing in the shipped file changed. Chromium with
software GL, a real `bin/mem-serve`. `load`: opening the network builds it once or
twice (the head, then the full list; which it is depends on a race, both are inside
the bound of 2), one model computation per build, at most one context per build
plus the page's background canvas, at most five programs per build plus one.
`quiet`: a quiet reload with the same and with changed data builds nothing, 0 of
each counter (the no-jump rule). `rebuild`: a draw by the person is one build, one
model computation, one context, five programs. `reuse`: a rebuild should make 0
new contexts and 0 new programs, as the sister house does with its pool of the
canvas; this house makes 1 and 5 per draw, so the record reads `degraded`, minor,
and says it is a cost the sister house removed, not a promise this house broke. The
**red probe**: with the counter switched off the page still draws its network, and
`load` reads `fail` ("a broken counter") with the other three rows `not-measured`;
it is held both on doctored results and on the real page. The time of a build is
neither a verdict nor a companion value. Blind spots: the mode selector, focusing a
topic and project and tab changes (also rebuilds), the size, and the picture
(`test/atlas-net-cm.test.mjs`).

**`cost`.** What one call costs. `cli-start` (TB4): a CLI start is one process and
loads at most one command group (`--help` none), and loads at most this many
modules (file count): `version` 111 (103 measured), `--help` 71 (62), `find` 102 (94); a whole
command group is about thirty files, so a headroom of 8 to 9 is below a regression. `hook.*` (TB5 and
the other five hooks): node processes started per hook call, on the second call
(the component table built), the labelled rebuild child not counted: `before-edit`
1, `subagent-start` 1, `retrieve` 4, `catch-fail` 4, `after-failure` 5, `stop` 5.
These are ratchets: the phase says what is, and that four to five processes for a
prompt hook is more than the work needs is a thing the reader sees in the figure.
Where there is no bash or no time-cap program (`timeout`, `gtimeout`, `perl`) the
six rows are `not-measured` and name that. `retrieve-opens` (TB6): a warm
`mem retrieve` opens each entry log at most 3 times (two passes of the state
derivation, one read in `loadIndex`; measured 3). `doctor-probe` (TB7): no worker
thread without `--full`, six with it. `doctor-fs` (counterpart of TB2): the
stat-class calls of `mem doctor --quiet` do not grow with the entries (829 calls at
100 entries and at 400), they do grow with the project folders (about 450 per
folder, printed and not judged). `today-journal` (counterpart of TB8): `mem today`
reads each byte of the injection journal twice per call (slope 2.00 bytes read per
journal byte, once for the card and once through the doctor it runs; the counter
watches the journal file alone, so the probe's temporary file cannot move it),
expected once: a **finding**, recorded as `fail` (minor). `today-probe`: the same
doctor, called with its default, starts the six writer threads of the
concurrent-append probe on every `mem today` call (10 calls out of 10) and writes a
probe folder under the memory root each time, although TB7 limited the probe to
`--full` for `mem doctor`: a second **finding**, `fail` (minor). TB1, TB2 and TB8 are the sister
house's items by name (`/schreibtisch.json`, `mem doktor`, `mem heute`); the rows
here are their counterparts in this house's code, not copies.

**`digest`.** What one tick of `bin/mem-digest` costs, without a model: the model
command (`MEM_DIGEST_CMD`) is a stand-in that writes one line per call and, in the
draining variant, marks what it was given as digested. `idle`: a tick that finds
nothing ripe calls no model, leaves no lock, and starts 3 node processes. `due-once`
(the control of `idle`: the same store, the threshold set to zero): exactly one
model call, and because the stand-in digests nothing the script must say so and
exit 1. `cap`: that call is handed 4 of 21 captures (990 raw bytes) and no more than
the budget (1000), the oldest capture among them by the age reserve; the sizes are
chosen so that they do not divide the budget, which is what lets a selection that
overshoots it be seen. `drain`: the backlog is gone after 4 working ticks (bound:
`ceil(raw bytes / budget) + 1` = 5),
one call and exit 0 each, and the tick after has 0 calls. `starts`: ratchets of 3
(idle) and 14 (a tick with one call). The model call itself is a stand-in: what a
real session does with the prompt, its cost journal, the PowerShell twin and two
ticks at once are blind spots. Without bash (or with a space in the scratch path,
which the script word-splits) the five rows are `not-measured`.

**What the first quick run says, in one line each.** `dashboard`: 3 pass, 2 fail
(the findings `desk` and `requests`). `net-tempo`: 3 pass, 1 degraded (`reuse`).
`cost`: 10 pass, 2 fail (`today-journal`, `today-probe`). `digest`: 5 pass. The five non-passes are
findings, recorded and not fixed; each is a pinned row of its probe test, which goes red on
purpose when the finding is fixed so the row is changed with the fix.

`test/atlas-phase-parity.json` lists the sister house's phase ids and the
phases this house does not have, each with its reason. (Until 2026-10-17 it also
carried a mapping for `bridge`/`bruecke` and `silent-errors`/`stille-fehler`.)

## Keeping it honest over time

`bench/atlas-baseline.json` is the one committed artefact: the run a
later run measures itself against. It is written only by
`npm run atlas:baseline`, never as a side effect — a baseline that
rewrites itself on every run turns every comparison into "this run equals
this run".

`npm run atlas:compare` prints verdict and value changes, new checks, and
checks that disappeared. That last list matters most: **a check that
vanished between two runs is not an improvement.** Either it was renamed,
or something stopped being measured.
