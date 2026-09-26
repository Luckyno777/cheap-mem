# eval/ — does cheap-mem make an agent measurably better?

These tools do not answer the question by argument. Status:
**unproven** — the baseline with a model in the loop has not run yet.
What already measures here measures without a model.

## The principle: models only where intelligence is actually needed

A benchmark that burns hundreds of model calls to test a tool whose
whole point is frugality refutes itself. So the question is split
apart first, and only a part of it is left for a model:

| Sub-question | Model? |
|---|---|
| Does the needed fact arrive in context at all? | no — **ceiling** on the benefit |
| How much of what's fed in is noise? | no — **floor** on the harm |
| Does a correction take effect, a conflict get reported, is authority respected? | no — pure state |
| What does the context cost? | no — exactly countable |
| **Does the fact change the answer, when it arrives?** | **yes, only here** |

`metrics.mjs` answers the first four for 0 USD and says whether the
fifth is worth it. If the gold never arrives, every model trial is
wasted money.

## Order

| File | answers | model needed |
|---|---|---|
| `independence.mjs` | does the task give away its own answer? And is the gold findable at all? | no |
| `echo.mjs` | how much of what's auto-fed is the user's own earlier question? | no |
| `raw-only.mjs` | what does the reserve lane cost, when a fact exists only undigested? | no |
| `flood.mjs` | at what volume does sheer mass displace the truth? | no |
| `metrics.mjs` | ceiling and floor of the benefit, all gates | no |
| `run.mjs` | do agents solve the task better with memory? | **yes** |

`run.mjs` without `--yes` is a dry run and only names the cost.

## What has been measured so far

- **Echo rate reproduced** (the `13/18` finding from `src/search.mjs:1031`):
  81.2% (2056/2532, 95% 79.6-82.7) on verbatim repetition, 37.8% / 59.8%
  / 69.7% on rephrasing at 107 / 389 / 1141 documents. **The rate grows
  with memory size** — that is new and was not visible at n=18.
  **Retracted on 2026-09-06** — see the next point. These numbers
  describe how many hits *are echoes*, measured against rebuilt
  `thought` entries. They do not describe how many the shipped filter
  *drops*.
- **What the shipped echo filter actually drops** (2026-09-06, per
  `search.isEchoHit`, the call `mem find` and the gateway actually make):

  | Condition | raw captures | questions | fed in | dropped | 95% |
  |---|---|---|---|---|---|
  | synthetic, 1 message per capture (ceiling) | 600 | 600 | 1800 | 66.8% | 64.6-69.0 |
  | synthetic, 12 messages per capture (session shape) | 50 | 600 | 1800 | **0.0%** | 0.0-0.2 |
  | **real** (lucky-mem, 483 captures, 211 hand-typed user messages) | 483 | 211 | 535 | **5.0%** | 3.5-7.2 |

  On real material, 4 of 211 questions (1.9%) lose their entire context
  to the filter, 17 (8.1%) lose part of it. The sample of dropped ones
  are verbatim repetitions — the filter hits what it should, just far
  more rarely than "72%" suggests.

  The mechanism behind this is a limit, not an opinion: `isEchoHit` sees
  `entry.text`, i.e. the first 400 characters of the capture. A message
  that is not in the first 400 characters cannot be recognized as an
  echo. That is correct — exactly these 400 characters would be fed in;
  what is not shown must also not be a reason to drop something. But it
  means: the filter practically only engages on captures that *begin*
  with the repeated question.
- **The threshold `MEM_RETRIEVE_MIN=5.0` is correctly calibrated against
  the real corpus**: 93.3% of hits sit above it, median 11.34. An
  earlier version of this directory reported 1.1% — that was the
  synthetic corpus, not cheap-mem.

## Raw capture made the search itself worse (2026-09-06)

Found while cleaning up the corpus, not searched for. After the echoes
were honestly planted as raw capture, **gold-in-context fell from 11/33
to 8/33** — with the filter as without it. The three lost tasks carry
NO receipt at all: the gold never even becomes a candidate.

Re-measured at the index: the threshold is not to blame (6/33 over 5.0,
both times), the mean gold score only falls from 3.52 to 3.29 — but the
mean rank collapses from 9.1 to 21.6.

The reason is an asymmetry that has stood in the code since raw capture
was added: `termGraph` excludes raw capture, `docFreq`, `N` and
`avgLength` do not. The stop hook files every message, so raw capture
contains every question verbatim — and thereby makes exactly the words
that get searched for most often frequent. Their idf falls, and the
digested entry loses its edge over topical neighbors. **The memory gets
worse exactly where it is used the most.**

Fixed: BM25 now computes with a second statistic (`statsN`,
`statsDocFreq`, `statsAvgLength`) drawn from the digested part alone.
Raw captures are still found; they just no longer skew what counts as a
rare word. The attachment path too — the one real operation takes on
every session — follows this.

What it buys, honestly:

| | before | after |
|---|---:|---:|
| Gold, clean corpus | 12/33 | 12/33 |
| Gold, poisoned (39 raw captures) | 8/33 | **9/33** |
| `bench/retrieval.mjs` R@5 | 93% | 93% |

**One of three lost tasks comes back, two do not.** The statistic was
part of the cause, not all of it.

### The other two: the capture crowds in

Broken down for C3, with the clean statistic. The digested entries'
scores are **identical** with and without flooding — the pollution is
gone. Yet the answer still drops out:

```
without flooding                    with flooding
  N-abhaengigkeiten-0   22.57        [raw] echo37          30.31
  V-metrikendienst-2    19.64        N-abhaengigkeiten-0   22.57
  FL-25                 18.91        V-metrikendienst-2    19.64
  F-db (GOLD)           18.77        FL-25                 18.91
  P-db                  13.83        P-db                  13.83
```

A single raw capture at 30.31 takes the answer's place at 18.77. The
echo filter rightly leaves it alone: the capture belongs to a DIFFERENT
question, it is not an echo of this one.

The capture wins almost every time it competes — it is long, run
together, and contains many query words. And it competed on equal
footing, because it lands in the `unknown` tier and the round-robin
gives every tier the same slot per round. One capture = one digested
claim displaced.

That inverts the design. The three lanes are capture -> digest ->
retrieve; a capture is by definition **not yet a claim**, the digester
has not run over it yet. Putting an unprocessed transcript ahead of a
reviewed decision makes lane 1 the main lane and the digester redundant.

**Raw capture is now the reserve lane**: everything digested first,
then the capture. Not "drop the capture" — on a fresh memory it is the
only material, and then the slots are free anyway.

| | before | statistic | + reserve lane |
|---|---:|---:|---:|
| Gold, clean corpus | 12/33 | 12/33 | 12/33 |
| Gold, poisoned (39 raw captures) | 8/33 | 9/33 | **11/33** |
| Context cost, poisoned (tokens) | 17,601 | 18,241 | 22,234 |
| `bench/retrieval.mjs` R@5 | 93% | 93% | 93% |

The flood now costs only **one** task instead of three.

Two things that honestly belong here too:

- **The price, now measured** (`node eval/raw-only.mjs`). A third of the
  facts there exist ONLY as raw capture — undigested, the way the stop
  hook files them before the digester has run. That hits 14 of the 33
  tasks.

  | Condition | fact in context | of those affected | raw-capture claims |
  |---|---:|---:|---:|
  | everything digested (baseline) | 12/33 | 5/14 | 0 |
  | a third raw-capture-only, reserve lane | 12/33 | **4/14** | 0 |
  | same displacement, raw capture on equal footing | 12/33 | **6/14** | 27 |

  So the reserve lane costs **2 of the 14 affected tasks** compared to
  giving the capture equal footing. And more sharply still: on this
  corpus the capture **never** gets through — 0 raw-capture claims, even
  though seven facts live only there. The digested entries always fill
  the five slots.

  So the trade-off is named, not explained away: the rule wins 2 tasks
  where the memory is flooded, and loses 2 where the digester has not
  run yet. What decides the sign is the digester's delay — if it runs
  hourly, the window is narrow; if it never runs, "only in raw capture"
  is the normal case.

  **How fast "never" sets in was sharper than first reported.** The
  first report said "on a dense corpus." Measured with a growing number
  of digested entries matching the question, and five raw captures
  alongside:

  | digested entries | 0 | 1 | 2 | 3 | 4 | **5** | 6 | 12 | 100 |
  |---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
  | raw-capture claims out of 5 | 5 | 4 | 3 | 2 | 1 | **0** | 0 | 0 | 0 |

  **Five matching digested entries, and the raw-capture lane is shut.**
  Not "a dense corpus" — five. A grown memory is thus practically always
  shut, and the undigested capture does not exist for the agent.

  What follows from this, and it is not a small thing: **cheap-mem now
  depends on the digester actually running.** Before, a backlog was
  merely untidy; now it is a gap in what can be retrieved. `mem doctor`
  has said so ever since, instead of only reporting the number.
- **The echo filter has less work to do as a result.** In the poisoned
  corpus it now drops 0 instead of 39 — not because it got worse, but
  because the echoes no longer even reach the selection. It still
  counts where the capture fills empty slots.

## The stateless baseline — the headroom, not the ceiling (2026-09-06)

`node eval/run.mjs --split all --arms A --model claude-sonnet-5` — arm A
is the bare question, no context, no history. 45 tasks, ~2 USD.
`node eval/baseline.mjs <run>` evaluates it.

**Why at all.** "For 38% of tasks the needed fact makes it into
context" only says whether it ARRIVES — not whether the model would
have known it anyway. For "UTC, ISO-8601" it guesses right, and on
tasks like that the benchmark measures nothing.

| | right without memory | 95% |
|---|---:|---|
| predicted guessable (18) | 39% | 20-61 |
| predicted not guessable (21) | 24% | 11-45 |
| no gold, class F (6) | 83% | 44-97 |

By class, and here is where the result sits: **D (correction) 0/6, I
(entity lookup) 0/6** — without memory the model never gets there.
**H (lock-in) 4/6, F 5/6** — there it needs none.

**The headroom.** Reporting either number alone overestimates the
benefit, because the sets overlap:

First run, 39 tasks with gold:

| | |
|---|---:|
| fact arrives in context | 15/39 = 38% |
| model answers right without memory | 12/39 = 31% |
| **both: fact present AND failed without it** | **6/39 = 15%** |

Six tasks carry no statistics. So exactly the two classes whose
baseline is **zero** — D (correction) and I (identifier) — grew from 6
each to 18 each. Only those: enlarging the others would have made the
benchmark more expensive, not sharper.

Second run, 63 tasks with gold (24 new, `--only` spares the ones
already measured):

| | |
|---|---:|
| fact arrives in context | 24/63 = 38% |
| model answers right without memory | 12/63 = 19% |
| **HEADROOM: fact present AND failed without it** | **15/63 = 24%** |
| right anyway without the fact (world knowledge) | 3/63 = 5% |

By class the picture is clean: **D 0/18, I 0/18** without memory —
there a stateless agent MUST fail. **H 4/6, F 5/6** — there it needs none.

That explains the paired model test from the same day (35/48 versus
28/48, p = 0.625, not significant) better than any guess about
retrieval would: at a headroom of 9%, a non-significant result is not a
puzzle, it is the expectation.

**The label was worse than the measurement, and that was the point.**
`guessable` in world.mjs is an explicit PREDICTION. How uncertain it is
was shown twice: an independent second assessment of the same 15 facts
agreed on 9, and against the measurement the label matches on 23 of 39
tasks — 59%. Eleven tasks labeled "guessable" failed without memory,
five labeled "not guessable" succeeded. A judgment with this hit rate
may not carry a metric; it sits in the corpus so the measurement can
correct it.

## Query words: the only lever that grows the headroom (2026-09-06)

While digesting, the digester adds three to five words per entry that
someone would later SEARCH with and that do not occur in the entry
itself (`mem log --asked`, weighted like `tags`). Cost at retrieval
time: zero — the work happens on lane 2, where a model runs anyway.
Embeddings cost one call per QUERY; this costs one per digest run.

`node eval/query-words-effect.mjs`, the same corpus twice:

| | without | with |
|---|---:|---:|
| Gold in fed context | 24/63 = 38% | **28/63 = 44%** |
| Precision (gold per claim) | 10% | 11% |
| **Headroom** | 15/63 = 24% | **19/63 = 30%** |

Gained: A3, E1, D10, D15. Lost: none. All four sit IN the headroom —
the model fails there without memory, and now the fact arrives.

**Where the words come from decides the value of the number.** They
come from a separate model run that saw only the corpus entries and not
a single task — exactly the digester's position in real operation. Had
they been copied from `vokB`, the tasks' vocabulary, the benchmark would
have measured its own template.

**And one guard afterward.** Of 31 entries, every third carried a word
that satisfies a task's SCORING RULE: `cookie` against
`/keks|cookie|sitzung/`, `textdatei` against `/datei/`, `ticket` against
`/sammelpostfach|ticket/`. Words like that are not a question but an
answer. `safeWords()` throws them out (141 -> 132 words), a test records
that none gets through. In real operation there is no scoring rule,
there the digester MAY write `cookie` — **so the measured effect is a
lower bound.**

## Does memory help an agent? Yes — under named conditions (2026-09-06)

The question this was all leading up to. `node eval/pair-a-c.mjs`: the
same task twice, arm A (no context) against arm C (context fed in),
Sonnet 5, 63 tasks with gold, ~3.15 USD.

| | |
|---|---:|
| right without memory | 12/63 = 19% |
| right with memory | **34/63 = 54%** |
| better with memory | **22** |
| worse | **0** |
| unchanged | 41 |

Sign test over the 22 differing tasks: **p < 0.0001**. On the 28 tasks
where the fact actually arrived: 19 better, 0 worse.

By class:

| | without | with |
|---|---:|---:|
| D (correction) | 0/18 | **8/18** |
| I (identifier) | 0/18 | **9/18** |
| E (conflict) | 1/3 | 3/3 |
| H (lock-in) | 4/6 | 5/6 |
| A, B | 5/12 | 7/12 |
| C | 2/6 | 2/6 |

**What this means and what it does not.** The earlier paired run from
the same day gave 35/48 versus 28/48 at p = 0.625 — not significant. The
difference is not in retrieval, it is in the task set: there, most
questions were guessable without memory; here, 36 of 63 come from
classes whose baseline is zero.

The absolute 54% is therefore **a property of this task mix, not a rate
that transfers**. What does transfer is the conditional statement:
*where the fact lives only in memory, cheap-mem delivers it, and the
model uses it* — 22 improvements, not a single regression.

The limits, unvarnished: one run per condition (a single difference can
be noise, only the balance carries weight), one model, one synthetic
corpus. And 29 of the 63 tasks stay wrong even with memory — on most of
them, because the fact never arrives in the first place.

**A bug of my own while evaluating**, because it shows the class: I read
`gold_retrieved` as a yes/no. It is a LIST, and an empty array is truthy
in JavaScript — my first intermediate number said "63 of 63 had gold in
context" instead of 28. The `=== true` comparison then silently let the
sub-analysis fail instead of complaining. Neither would have been
noticed. The script now throws if the field has an unexpected shape,
and says so loudly if the subset is empty.

## The trap this directory has fallen into three times

1. **Measured the probe instead of the thing.** The first echo
   measurement passed the raw JSON line to `isEcho`; its key names push
   the overlap below the threshold. Result: 0 of 2532 echoes. A positive
   control has run before every measurement since.
2. **Measured a path nobody takes.** The second version of the same
   measurement filed every earlier question as a `thought` entry and
   checked with `isEcho(question, compactLine(entry))`. In real
   operation, though, the stop hook writes a gzip file under `raw/`, and
   the shipped filter sees only raw capture, and within it only the
   captured text. The positive control was there — it only checks the
   probe, not whether the probe sits where the thing actually happens.
   `echo.mjs` now files real raw captures and counts with `isEchoHit`.
3. **Over-optimized independence.** To drive lexical leakage to zero,
   the tasks were gutted so far that BM25 could no longer find the gold
   entry. An A/B would have wrongly shown memory as ineffective. The
   criterion is now not "no shared word," but "no shared word that
   UNIQUELY identifies the gold entry" — and `independence.mjs` reports
   findability as an equally mandatory number alongside it.

## Measured without a single model call (synthetic corpus, 21 tasks)

| Metric | clean | poisoned |
|---|---:|---:|
| Gold in fed context | **5/18 = 28%** | 4/18 = 22% |
| Tasks with empty context | 8/21 | 0/21 |
| Precision (gold per claim) | **12%** | 7% |
| of those, echoes of the question | 0/42 | **21/59 = 36%** |
| stale version fed in as active | 0 | 0 |
| conflict reported, **when both sides are candidates** | 1/1 | 2/2 |
| conflict not even detectable (only one side present) | 2 | 1 |
| authority breach | 0 | 0 |
| context cost | 6143 tokens | 6533 tokens |

**Memory can improve at most 28% of these tasks** — on 13 of 18 the fact
never arrives at all. At the same time, 88% of what's fed in is not the
fact being sought. The possible benefit lies in a narrow band, and only
for that band is a model trial worth it — paired (the same task with and
without exactly this claim), so that task variance drops out.

All gates hold. The first version of this table reported "conflict only
1 of 3" and looked like a defect in `potentialConflicts`. The diagnosis
showed something else: on two of the three tasks, BOTH sides were never
among the candidates, and reporting can only report what is there. The
metric was framed wrong, not the code.

Along the way, the real finding turned up: **`search()` has `mmr: false`
as its default. `bin/mem find` turns diversity re-ranking on,
`src/retrieval.mjs` did not** — so the agent path (`mem retrieve`, MCP
`mem_retrieve`) was worse than the human path. Near-identical entries on
the same topic filled up the hit list. Measured: the sought claim was in
the top-5 on **7 of 18** tasks without MMR and on **9 of 18** with it.
Fixed, with a test and a mutant (`test/gateway-diversity.test.mjs`).

In the poisoned corpus, scores spike to 60-128 because the echoes
contain the question verbatim — they displace everything else. That is
displacement, concretely measured, without a model.

**Limit of these numbers:** they hold for this corpus. It matches the
real one's density (median 563 versus 551 characters), but not yet its
score distribution (42% over the threshold versus 93%). The 28% is a
property of this benchmark, not a statement about real operation.

## Open

The synthetic corpus produces scores of 0.5-5.5, the real one 2-93.
Short synthetic entries are no substitute for grown ones. Before the
baseline runs, the corpus must resemble the real one in length and
density — otherwise every retrieval number is off by an order of
magnitude.

## The paired test — the one thing a model was needed for

40 calls, 0.70 USD, Haiku 4.5, clean corpus. Only run on the 5 tasks
where the gold actually arrives in context; on the remaining 13 the
answer is already known without a model. Both conditions get the same
number of claims — the gold claim is replaced by the next-best non-gold
claim, not removed without replacement.

| Task | removed | WITH | W/OUT | Delta |
|---|---|---:|---:|---:|
| C3 | F-db | 4/4 | 4/4 | 0 |
| D3 | F-port-neu | 0/4 | 0/4 | 0 |
| E2 | F-konflikt-a | 0/4 | 0/4 | 0 |
| H2 | F-lockin | 3/4 | 1/4 | **+50%** |
| H3 | F-lockin | 4/4 | 4/4 | 0 |

Total 11/20 versus 9/20. One task differs, four do not. **Sign test:
p = 1.000.** With a single differing task, the smallest reachable p is
also 1.000 — this sample CANNOT show an effect, whatever it turns out
to be.

**Result: no demonstrable effect at n=5 tasks.**

### And a finding against the gauge itself

A look at the answers shows differences the binary grading does not see:

- **D3** without gold: *"**3000** — the note [V-metrikendienst-6] states
  that the metrics service runs on port 3000"* — a confident wrong
  number from a distractor entry. With gold: no wrong number, but a
  caveat. Both count as failure.
- **E2** without gold: *"Yes, 5 MB is under the artifact limit of
  16 MB"* — an invented limit. With gold: *"No, 2 MB maximum"* —
  factually correct, but without naming the contradiction my rubric
  requires. And the model could not have named it: retrieval only
  supplied ONE of the two sides.

That is a hypothesis for the next round, not a result of this one: it
arose AFTER looking at the data. Whoever now adds it as a metric after
the fact and re-evaluates the same runs is measuring their own
expectation. It belongs pre-registered and tested on new tasks.

---

# Stage 1 — why doesn't the fact arrive? (0 USD)

`node eval/ablation.mjs`

## Finding A: the curated synonyms are English

| Language | Questions | Terms | Synonyms | Questions with at least one |
|---|---:|---:|---:|---:|
| German | 21 | 198 | **0** | **0/21** |
| English | 15 | 44 | 53 | 11/15 |

`THESAURUS` in `src/thesaurus.mjs`: 39 groups, 188 words, not a single
German one. For a German memory, this layer contributes **nothing**.
The English measurement is the positive control: the mechanism works,
it just does not engage.

This affects lucky-mem directly — that is a German memory. A way out
exists (`.mem/thesaurus.json`, `loadUserGroups`), but it is displayed
nowhere: a German user silently gets worse retrieval until they
discover the file on their own.

## Finding B: the learned termGraph hurts in German and helps in English

Gold claim in the top-5, same code, same calls:

| Threshold | German with | German without | English with | English without |
|---:|---:|---:|---:|---:|
| 2 | 9/18 | **14/18** | 13/15 | 13/15 |
| 3 | 8/18 | **12/18** | **13/15** | 10/15 |
| 4 | 7/18 | 8/18 | **13/15** | 8/15 |
| 5 | 5/18 | 6/18 | **12/15** | 7/15 |

Not a score-inflation artifact: at threshold 2 the English numbers are
equal, above that the termGraph keeps the right documents on top. In
German it hurts at every threshold.

## Finding C: the damage grows with repetition in the corpus

| Repetitions | Documents | with termGraph | without |
|---:|---:|---:|---:|
| 1 | 35 | 16/18 | 16/18 |
| 2 | 57 | 16/18 | 16/18 |
| 4 | 101 | 12/18 | 16/18 |
| 8 | 189 | 9/18 | 16/18 |
| 16 | 365 | 8/18 | 16/18 |

Without termGraph, recall stays constant; with it, recall falls
monotonically. `buildTermGraph` guards against OMNIPRESENCE
(maxDocFraction, nPMI), not against LOCAL redundancy: a cluster of
near-identical entries lets two noise words co-occur perfectly, and
nPMI rewards exactly that to the maximum.

Together with the echo rate, which also grows with size, this forms a
pattern: **retrieval quality degrades as the memory grows.**

## Counter-check against myself

My density expansion drew ALL entries from a pool of eight sentences —
that produces exactly the co-occurrence driving the finding. With
distinct filler per entry: with termGraph 7/18, without 10/18. The gap
shrinks from 7 to 3 and **does not disappear**. Part of the finding was
my own artifact, the rest stands.

## Calibration on dev+val (final untouched)

| termGraph | threshold | gold | claims | precision | tokens | empty context |
|---|---:|---:|---:|---:|---:|---:|
| with | 5 *(today's default)* | 2/12 | 29 | 7% | 5439 | 6 |
| with | 3 | 4/12 | 63 | 6% | 11729 | 1 |
| **without** | **3** | **8/12** | **27** | **33%** | **5339** | **4** |
| without | 2 | 8/12 | 39 | 26% | 7574 | 4 |

On this corpus, `without termGraph, threshold 3` dominates today's
default on **every** axis: four times the gold, five times the
precision, at slightly fewer tokens.

**What does NOT follow from this:** turning the termGraph off. The
English measurement says the opposite. What follows is in stage 2.

---

# Stage 3 — threshold: both candidates rejected (0 USD)

Calibrated on dev+val, final untouched.

| Rule | German gold | claims | prec. | English gold | claims | prec. |
|---|---:|---:|---:|---:|---:|---:|
| absolute >= 5 *(today)* | 2/14 | 29 | 7% | 12/15 | 68 | 79% |
| absolute >= 3 | 4/14 | 63 | 6% | 13/15 | 75 | 79% |
| relative >= 0.5x best | 4/14 | 70 | 6% | 13/15 | 75 | 79% |
| relative >= 0.8x best | 3/14 | 62 | 5% | 13/15 | 73 | 81% |

**REJECT: relative threshold.** It gains nothing over `absolute >= 3` on
either corpus. The suspicion that an absolute BM25 threshold would be
fragile, because the score distributions differ by an order of
magnitude (own corpus 0-10, real one 2-93), did not show up in the numbers.

**REJECT: lowering the default from 5 to 3.** In German it buys +2 gold
for +34 noise claims at unchanged precision (6%). On the real corpus,
93.3% of hits already sit above 5, so it barely changes anything there.

The informative part of the null result: **the threshold is not the
binding constraint.** The ranking is. Whoever wants to raise recall has
to work on the ordering, not on the filter.

# Stage 4 — displacement: holds (0 USD)

`node eval/flood.mjs` — four conditions (attacker as agent/user,
topically similar/dissimilar, short/long), flooding from 0 to 400 entries.

**The real claim is displaced under no condition.** It stays at rank
1-4, and the conflict gets reported from the FIRST flood entry on.

And a mechanism nobody had noticed before: **from roughly 34 flood
entries on, the attacker disappears entirely** from the fed-in context.
The more copies it writes, the more frequent its words become, the
smaller their idf, the lower every individual score. **BM25 makes mass
flooding self-limiting.** That is not a design choice, but a property
measured here for the first time.

The first version of this file reported "displaced" for EVERY flood
amount, even for 0 — at threshold 5.0, nothing was arriving at all on
the then-too-thin corpus. A gauge that sounds the alarm even without an
attack measures nothing. A positive control now runs before it.

# Stage 5 — metrics after the fixes (0 USD)

Ceiling unchanged at **5/18 = 28%**; MMR helped in the top-5 (7 -> 9),
the threshold cuts the gain back off. All gates hold.

**Checked against the real corpus, noted as a limit instead of tuned
away:** own corpus p50 4.84 / 47.6% over the threshold; real one p50
11.34 / 93.3%. The density now matches (median 563 versus 551
characters), the score distribution does not. Every number here holds
for this corpus.

# Stage 6 — more tasks, and frozen (0 USD)

21 -> **39 tasks**, 13 per split, 7 classes. Discriminating power
depends on the task count: four runs of the same task are not four
observations, and at five tasks the smallest reachable p equals 1.000.

## The independence criterion, third and final version

The first two were wrong, both too strict:

1. *"no shared word"* — gutted the tasks so far that BM25 could no
   longer find the gold at all. An A/B would have wrongly shown memory
   as ineffective.
2. *"no shared RARE word"* — also wrong. If a fact appears once in the
   corpus, its topic word is rare by construction. That a question
   about the health check contains the word "health check" is not
   leakage, but the normal case memory exists for.

The right question is: **does the question give away the ANSWER?**
Exactly checkable, because `must`/`mustNot` already define what counts
as correct — if the question itself would pass as the answer, the task
tests nothing. Result after two real corrections (C1 offered "files or
database," H1 named JSON): **0 of 33 given away, 33 topical only.**

## Frozen

`eval/final-eingefroren.json` + `.sha256`, sealed by
`test/eval-frozen.test.mjs`. From here on: no rewording, no relaxed
rule, no special case on final.

## Pre-registered secondary metric

`erfundeneZahlen(answer, question, context)` — numbers in the answer
that occur neither in the question nor in the context. Deterministic,
no model judge. It tests the hypothesis from the day before (memory may
prevent invention more than it delivers the right answer) on data it
did NOT come from. Class F is excluded: there the model rightly computes.

# Stage 7 — the paired run on the extended set (0.77 USD)

48 calls, 6 tasks with arriving gold, Haiku 4.5, clean corpus.

| Task | removed | WITH | W/OUT | invented numbers WITH/W-OUT |
|---|---|---:|---:|---:|
| C3 | F-db | 4/4 | 4/4 | 0 / 0 |
| D3 | F-port-neu | 0/4 | 0/4 | **2 / 0** |
| E2 | F-konflikt-a | 0/4 | 0/4 | **0 / 4** |
| H1 | F-lockin | 4/4 | 4/4 | 0 / 0 |
| H2 | F-lockin | 1/4 | 0/4 | 0 / 0 |
| H3 | F-lockin | 4/4 | 4/4 | 0 / 0 |

Success 13/24 versus 12/24, **one** task differs, p = 1.000. Invented
numbers 2 versus 4, **one task better, one worse**, p = 1.000.

## The pre-registered hypothesis is NOT confirmed

It cuts both ways: on E2 memory prevented invention, on D3 it caused
one. That is exactly what pre-registration is for — had I only looked
at E2 after the run, the hypothesis would have looked "confirmed."

## And the metric itself is not up to what the answers show

This is an observation made after the run and changes nothing about the
result — it only says what has to be different next time:

- **D3 without gold**: *"**3000** — that is the metrics service's port
  per note [V-metrikendienst-1]"*. A wrong answer, confidently stated,
  **not counted as invented** — the number did, after all, sit in the
  (wrong) context.
- **E2 without gold**: *"2 MB maximum per file"* — the RIGHT answer,
  **counted as invented**, because the 2 did not sit in the context.

The metric measures "number not in context" and thereby conflates three
things: inventing a wrong number (bad), stating a correct one from the
model's own knowledge (harmless), copying a wrong one from mismatched
context (bad, but uncounted). It needs CORRECTNESS as its reference, not
provenance.

# Stage 8 — feature tests: not run

Aborted by its own rule. The ceiling is 28%: of 33 tasks with gold, 6
arrive, and over 6 tasks no sign test can reach p < 0.05 unless all six
go the same way. Empty answer semantics, `why` as a field, contradiction
checking, and sectioning would all hit the same ceiling.

Spending money on a measurement whose discriminating power is already
zero beforehand would be exactly the mistake this whole series was
built against.

**The bottleneck is not the model and not the feature. It is recall.**

---

# The faithful corpus — and what it disproves about its own findings

Up to here, every number sat on a corpus whose score distribution was
off by a factor of two. Measured against the grown lucky-mem (930
documents): **8944 distinct words**, median 61 per document. The
generator reached **403** across 259 documents — word count per
document was right, the vocabulary was 22x too poor. At 403 words every
one is frequent, every idf is tiny, and all scores sit at 0-10 instead
of the real 2-93.

German compound words solve this without a word list: 60 determiner
words times 60 base words give 3600 plausible technical terms, and
every distractor entry gets its own topic from that.

| | documents | distinct words | p50 | >= 5.0 |
|---|---:|---:|---:|---:|
| old | 259 | 403 | 4.84 | 47.6% |
| **new** | **839** | **3915** | **9.89** | **94.9%** |
| **real** | **930** | **8944** | **11.34** | **93.3%** |

## Three of my own findings that fall as a result

**1. "The termGraph hurts in German" — RETRACTED.** On the faithful corpus:

| | top-5 | over threshold | empty context |
|---|---:|---:|---:|
| full | 13/33 | **13/33** | **0** |
| without termGraph | 18/33 | 12/33 | **15** |

The ranking damage remains, but does not carry through to what gets fed
in — and **without** the termGraph, 15 of 33 tasks get no context at
all. The damage measured earlier (9/18 versus 16/18) was an artifact of
repetition in a poor corpus.

**2. "8 of 21 tasks get empty context" — RETRACTED.** On the faithful
corpus: **0 of 39.** This also removes the main justification for
empty-answer semantics as an urgent feature.

**3. Ceiling 28% — corrected to 36%** (12 of 33).

## What holds

- **The echo rate grows with memory size**: 31.3 / 57.3 / 66.8% at 829 /
  1159 / 2039 documents (rephrased questions). The finding is
  corpus-independent — but holds for captures of ONE message. In
  session shape (12 messages per capture) it falls to 0.0%.
- **The threshold of 5 is right**: recall is flat from 0 to 6 (13/33)
  and only falls from 7 on. Stage 3 confirmed.
- **All gates hold**: no correction failure, conflicts 2/2 reported, no
  authority breach.
- **Displacement does not occur**, flooding is self-limiting.

# German synonyms: INCONCLUSIVE, kept

`THESAURUS` is extended with German words, and specifically **into**
the existing groups rather than alongside them — so a German question
also finds an English entry. Mixed-language memories are the normal
case as soon as tools log in English and the human asks in German.

Measured:

- Coverage: before, **0 synonyms out of 342 terms** across 39 German
  questions; now covered. The gap was real.
- **Recall on the benchmark: 13/33 before, 13/33 after. No effect.** The
  groups do not bridge the word pairs this benchmark separates on.
- Cross-language, German question onto an English entry: **0/4 before,
  1/4 after.** The mechanism engages ("Zugangsdaten" found `credential`
  at rank 2), the effect is small and n=4.

**Verdict: INCONCLUSIVE.** A real coverage gap is closed, a small
cross-language effect is measurable, a recall gain is NOT. Kept because
it changes no behavior and costs no runtime — not because it proved itself.

---

# The decisive run — and what it says after the correction

Two runs on the faithful corpus, 12 tasks with arriving gold, 96 calls each.

## Run 1: unbalanced pairing, discarded

83% versus 63%, seven tasks better, one worse, p = 0.070. This looked
like this series' first real signal.

The token difference sat at **+7416**, even though it must be near zero
when paired. The replacement pool for the removed gold claim came from
the same top-N query and was empty as soon as retrieval returned N
hits: WITH carried one more claim in 9 of 12 pairs.

| | pairs | better | worse |
|---|---:|---:|---:|
| balanced | 3 | 1 | 1 |
| unbalanced | 9 | **6** | 0 |

The entire effect sat in the unbalanced pairs. **Discarded.**

## Run 2: balanced

All 12 pairs carry the same number of claims on both sides, token
difference +1252 over 96 calls (about 13 per call, from replacement
claims of varying length).

| Task | Cl | WITH | W/OUT | Delta |
|---|---|---:|---:|---:|
| H1 | H | 4/4 | 0/4 | **+100%** |
| E3 | E | 3/4 | 0/4 | **+75%** |
| C5 | C | 4/4 | 2/4 | **+50%** |
| H4 | H | 1/4 | 3/4 | **−50%** |
| B1 B3 B5 C3 D3 E2 H2 H3 | | | | 0 |

**Success 35/48 (73%) versus 28/48 (58%). Three tasks better, one
worse, eight equal. Sign test p = 0.625 — not significant.**

Invented numbers: WITH 0, W/OUT 1. One task differs, p = 1.000.

## The result of this phase

**Question 1 stays unproven.** Not for lack of discriminating power
this time — that was there after the corpus and retrieval work (12
tasks instead of 6, p < 0.05 reachable) — but because the effect shrinks
to 3 to 1 under clean pairing.

The aggregated 73% versus 58% looks like something. But the unit of the
statement is the task, not the run, and at the task level it stands at
3:1 with eight ties.

**Where memory visibly helped:** H1 (an old decision no longer applies,
4/4 versus 0/4), E3 (a contradiction must be surfaced, 3/4 versus 0/4),
C5 (a user preference, 4/4 versus 2/4). All three are cases where the
answer CANNOT come from the model's own knowledge.

**Where it hurt:** H4, 1/4 versus 3/4. The old approval rule in context
keeps the model from declaring it outdated — historical lock-in, measured live.
