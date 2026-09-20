# The atlas: what this memory does under load, and where it stops

`npm run atlas` runs every command as a real process against real
corpora, records what it measured next to what was expected, and writes
one JSON a later run can be diffed against. This page is the reading of
that run.

Everything here was measured on the machine and date named below. Nothing
on this page is an estimate unless it says so — and where something is an
extrapolation, it says so in the same sentence as the number.

```
npm run atlas              # every phase, ~13 min
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
- **`mem find-embed` and the embedding backfill** — need an API key and
  an optional native dependency; this phase makes no network calls.
- **the register prototype past 40 000 rows** — the new `register` phase
  (sqlite+FTS5 against today's linear scan) ladders to 40,000 rows for
  this run's time budget; a 2026-09-20 one-off prototype separately
  reached 1,000,000 rows at 180.8 MB on disk, but that scale is not
  reproduced inside this run, and neither is a writer and a reader
  touching the register at the same time.

The sabotage recipes for the `root` and `config` doctor findings, listed
here in earlier runs as structurally unreachable, are no longer a blind
spot: this run reaches both (see "What is confirmed broken" above).

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
