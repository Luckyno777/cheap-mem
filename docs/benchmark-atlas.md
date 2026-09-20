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
| bare node start | 30.6 ms p50 — **every CLI number below includes this** |
| corpus | `buildCorpus`, seed 42, deterministic |
| run | 347 records in 757 s, 26 blind spots |

> Taken with nothing else running. An earlier attempt had two copies of
> this benchmark racing each other on four cores, because a shell line of
> the form `lint && echo && nohup node … &` backgrounds the whole chain
> rather than its last command. Every timing from that attempt was
> discarded: a benchmark that loses half the CPU to a second benchmark
> measures the machine.

## What the run says, in one table

| phase | pass | fail | degraded | not measured |
|---|---:|---:|---:|---:|
| surface — every command, executed as a process | 157 | 0 | 0 | 11 |
| load — scale, latency, and whether the right answer survives | 15 | 4 | 4 | 2 |
| doctor — the state ladder: which findings can fail at all | 36 | 3 | 0 | 2 |
| defence — neutralisation, flooding, tamper detection | 7 | 0 | 4 | 1 |
| robust — broken state and concurrent writers | 55 | 1 | 0 | 4 |
| ceiling — where this design stops working | 7 | 2 | 5 | 9 |
| real — the same measurements against a grown memory | 10 | 4 | 1 | 3 |

## The measured ladder

Five corpus sizes, each built fresh, each measured through the real CLI.
Wall time, p50, in milliseconds. Index cache is what `mem find` has to
read and parse before it can answer anything.

| entries | `find` | `doctor` | `context` | index build | index cache | corpus on disk | peak RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 008 | 145 ms | 213 ms | 111 ms | 228 ms | 0.5 MB | 174 KB | 80 MB |
| 5 008 | 209 ms | 467 ms | 124 ms | 504 ms | 2.6 MB | 867 KB | 106 MB |
| 20 008 | 419 ms | 1 308 ms | 144 ms | 1 434 ms | 10.5 MB | 3.5 MB | 165 MB |
| 60 008 | 1 142 ms | 3 943 ms | 218 ms | 4 298 ms | 31.2 MB | 10.5 MB | 331 MB |
| 150 008 | 2 801 ms | 11 425 ms | 359 ms | 11 195 ms | 78.5 MB | 26.5 MB | 615 MB |

`mem context` is the outlier in the good direction: it grows with an
exponent of 0.223, which is close to flat. It is also the call the
SessionStart hook makes on every new session
(`install/hooks/session-start.sh` runs `mem context --n 10`), so that is
the one of these numbers a person feels most often. `mem doctor` and the
index build grow at 0.78–0.79, and `find` at 0.59.

## The part most benchmarks leave out: does the model predict anything?

Each series is fitted to `t = a · n^b`. A fit alone proves nothing — it
is drawn through the same points it is being judged on. So every series
is also **counter-checked**: fit on the four smaller rungs only, predict
the fifth, and compare against what the fifth actually measured.

| series | exponent b | R² | predicted the held-back rung | |
|---|---:|---:|---:|---|
| index cache size | 1.002 | 1.000 | **0.0 % off** | ✅ |
| `mem doctor` | 0.793 | 0.972 | 45.0 % off | ❌ |
| index build | 0.782 | 0.978 | 38.2 % off | ❌ |
| `mem find` | 0.592 | 0.929 | 49.9 % off | ❌ |
| `mem context` | 0.223 | 0.844 | 37.8 % off | ❌ |

**Four of the five models cannot predict one rung they did not see.**
Their R² looks respectable — 0.84 to 0.98 — and it means very little:
R² measures how well a curve describes the points it was drawn through,
not whether it forecasts anything.

So the honest conclusion from this phase is narrow, and it is the most
important sentence on this page:

> **The only quantity whose growth this design reliably predicts is the
> size of the index. Every timing extrapolated to 5 million entries is a
> shape, not a figure.**

Accordingly, every 5 M timing in the run is recorded `not-measured`, with
`expected: null`, and its evidence names the largest rung actually
reached. A fit from fewer than four rungs is refused outright — two
points make an R² of exactly 1 and say nothing at all.

## Five walls

Where this design stops working, and why. Measured or computed here;
never asserted from reading the code.

### 1. The index cache stops being parseable at ~978 000 entries

`loadIndex` does `JSON.parse(fs.readFileSync(cachePath, 'utf8'))` — the
whole cache becomes one JavaScript string before parsing starts. V8's
maximum string length is 536 870 888 bytes. The cache measured **548.7
bytes per entry** at 150 008 entries, and that ratio is the one series
whose model predicts (0.0 % off).

**978 395 entries and the cache cannot be read at all.** Not slow —
unreadable. This is the hard wall, it is well under 5 M, and it is the
only 5 M-relevant number on this page that rests on a verified model.

### 2. Reading one drawer holds 3.6 MB per MB on disk

`memory.readLog` does `readFileSync` then `split('\n')` then parses each
line: the file exists as a string, as an array of lines, and as parsed
objects, all at once. Measured on drawers this phase builds for the
purpose — 4, 16, 64 and 128 MB — running `readLog` alone in a fresh
process against a control that imports the same module and reads nothing:

**3.70 MB held per MB of drawer on disk** (R² = 0.998).

One type in one project is one file, so a 5 M-entry memory is a ~864 MB
drawer, projecting to ~3.2 GB held to read it once. Cross-checked with a
second instrument: `process.memoryUsage().heapUsed` around the same call
grows 3.1×, VmHWM 4.6×. They agree on the shape and differ as they
should — VmHWM is a high-water mark and catches the string and the split
array before either is collected, which is the number that decides
whether a container survives the call.

> An earlier version of this wall divided a whole `mem find` process peak
> by the corpus bytes and scaled that ratio: 93×, projecting 82 GB. About
> 70 MB of that ratio is a Node process existing at all, which does not
> grow with the corpus. The figure was two orders of magnitude too large.
> The whole-process number survives as its own record under its own name,
> with no expectation to miss: **92 MB for a process that finds nothing,
> plus 3.64 KB per entry** (R² = 0.995) — the difference from the 181 B
> an entry occupies on disk is the search index, which is what a `mem
> find` process actually peaks on.

### 3. Search is sublinear, and it does not save you

`find` grows at n^0.59 — better than linear. At 150 008 entries it is
already 2.8 s p50. The extrapolation to 5 M is one of the four
the counter-check rejected, so treat it as a direction, not a duration.

### 4. One writer per type: 9 entries per second at 150 k

`mem log` measured 112.2 ms per append with 150 008 entries already in
the drawer — 8.91 entries/sec through a single writer. That is not the
append; it is the per-write work around it. Writing 5 M entries at that
rate is ~6.5 days of wall clock, serialised.

### 5. git carries the whole drawer into every clone

166.2 bytes per entry in `learnings.jsonl` (measured on a real repo this
phase creates and commits into: `git add` 120 ms, `git commit` 106 ms at
596 KB). A single drawer type at 5 M entries is ~792 MB, present whole
in every clone and every checkout.

## What is confirmed broken

Each of these was measured, not inferred, and each is in the run's
`findings` list with its evidence.

**Recall collapses when the question carries shared words.** With three
words in common between the question and the corpus, the anchor is out of
first place at every corpus size; with five, all eight anchors are lost
entirely, at 1 k, 5 k and 20 k alike. First place survives up to two
shared words and is gone at three. The cause is the coverage multiplier
in `src/search.mjs` (`score *= (covered / groups.length) ** coverage`).

**Flooding wins at N = 3.** Three entries that vary one word, or swap in
synonyms, are enough to push the truthful entry out. Identical copies
never win, up to N = 50 — the detector catches those. It groups by
`topic`, so an entry type that carries no topic field is never flagged:
3 of 3 flagged with a topic, 0 of 3 without.

**Tamper detection catches 1 of 5.** Four kinds of edit to stored state
go unnoticed.

**28 of 31 doctor findings can reach a state other than ok** — three
never can, so three lines of that report are decoration. **13 of 31
report `ok` about an empty memory**, saying nothing where they should say
"unknown"; 11 do use the third state.

**`mem find` is blind to a drawer whose filename is unknown.** 42 of 285
parseable entries never reach the search when they sit in
`global/dutys.jsonl` instead of `duties.jsonl`. Since 2026-09-20 the
doctor *names* it (`orphan-drawers`, an error that reads the directory
rather than the type map), so the memory is no longer silent about the
gap — but the entries are still unreachable until the file is renamed.

## The bias every other number carries

The `real` phase runs the same measurements against a grown,
hand-written memory (2 345 entries) and compares its shape against a
generated corpus of the same size. That comparison is the phase's actual
deliverable:

| | real | generated | |
|---|---:|---:|---|
| share of entries in the largest type | 31.5 % | 10.4 % | 3.03× |
| median entry size | 964 B | 166 B | 5.81× |
| entries carrying no tags | 17.2 % | 0 % | the generator makes none |
| entries too thin to ever be found | 0.9 % | 0 % | the generator makes none |
| share inside the middle recency window | 100 % | 35.2 % | 2.84× |
| unparsable lines | 0 % | 0 % | no bias found |

Real memories are lumpy: one type dominates, entries are six times
longer, a sixth of them carry no tags at all. The generator produces
none of that. **Every latency and recall number in the other six phases
was measured against the smooth corpus, and inherits this difference.**
Saying so here is the point; a benchmark that compares only against its
own generator measures its generator.

That phase reads someone's actual memory, so every value leaving it
passes a guard that accepts numbers and booleans and replaces everything
else. The guard is sabotage-verified against a made-up entry and a plain
number before anything else runs, and its own redaction count is the
phase's last check — zero is the pass. The phase writes nothing into the
memory it reads; it measures a scratch copy and says so in each record.

## What this run could not see

26 blind spots, each named in the report. The ones worth knowing:

- **direct measurement above 150 008 entries** — the ladder stops there,
  so everything beyond is model, and the models mostly do not predict.
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
- **sabotage recipes for the `root` and `config` findings** — both are
  structurally unreachable: `requireConfig` runs before `checkAll`.
- **`mem find-embed` and the embedding backfill** — need an API key and
  an optional native dependency; this phase makes no network calls.

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
