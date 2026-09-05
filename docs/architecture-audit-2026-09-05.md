# cheap-mem — architecture audit, 2026-09-05

Commissioned as a red-team brief: analyse the architecture, attack it, and
propose something better rather than confirming what is there.

**Method.** Everything below marked *measured* was run in this container
against the real code on this date. Everything marked *reasoned* was not
run and is argued, not proven. The distinction is kept because the brief
asked for bottlenecks, "no theoretical assumptions" — and because a
report that blurs the two is worth less than one that admits its edges.

**What was NOT done**, so nobody mistakes silence for a clean bill: no 1M
or 10M run (the 1M figures below are from an earlier run recorded in
`bench/scale.mjs`, not re-measured today); no embedding/vector comparison;
no multi-machine or NFS test; no re-measured feature comparison against
Mem0/Zep/Letta; no long-horizon multi-agent simulation.

---

## Executive summary

Three findings change what should be built next. All three are measured.

1. **The scan is not the bottleneck — the candidate set is.** Search is
   linear because it scores every document. The repo's own note concluded
   posting lists would buy "about 3x" and were therefore not worth it.
   That conclusion was drawn at 611 entries and does not survive a proper
   measurement: selectivity is *bimodal*, and the deciding factor is not
   corpus size but whether the query contains one common word. Selecting
   candidates by term rarity gives **3x to 1038x** fewer documents to
   score, with **identical top-10 in all eight queries tested**.

2. **Project isolation is a parameter, not a boundary.** `search()`
   filters by project only when a caller passes `project`. Omit it and
   one project's memories are returned to another. There is no scope that
   a caller cannot simply not ask for.

3. **`replaces_id` carries no authority.** Any writer can supersede any
   other writer's entry. In a single-user memory this is a non-issue. In
   the multi-agent system this repo is explicitly built for, it is the
   memory-poisoning primitive: one line retires a decision and the
   original stops being returned.

Everything else that was attacked held up: concurrent appends did not
corrupt, a destroyed index cache recovered silently and correctly, a
truncated line was skipped without taking the search down, and redaction
caught a real AWS key shape on the write path.

---

## 1. Current architecture (as measured, not as documented)

```
capture (hook, no model)  ──►  raw/YYYY/MM/*.jsonl.gz   [redacted before disk]
                                        │
digest (one model call, timer)  ────────┘
                                        ▼
                        projects/<p>/<drawer>.jsonl     [append-only]
                        global/<drawer>.jsonl
                                        │
                        buildIndex ─────┤  .mem/search-index.json (cache)
                                        ▼
retrieval (BM25 + thesaurus + tag graph, no model)  ──►  hook context
```

Load-bearing properties, verified in code:

- **Append-only.** Corrections are new lines with `replaces_id`; closure
  is a line with `closes_id`; topic merges are alias lines applied *on
  read*. Nothing rewrites history. (`src/memory.mjs`)
- **Model in exactly one place.** Capture and retrieval are deterministic;
  only the digest calls a model.
- **Text on disk, in git.** Inspectable, diffable, portable, offline.
- **Redaction before disk**, with a canary and a pre-commit hook.
- **Incremental index.** `appendToIndex()` extends a loaded index from
  appended lines and refuses (falls back to a full build) on any change
  that is not a pure append. The "cold path after every write" problem
  named in `bench/scale.mjs` has been fixed; that header comment is now
  stale. Code wins.

**Partially bitemporal already.** The brief proposes bitemporal memory as
new. `ts` (when recorded) and `valid_from` (when true) already coexist —
but only in the timeline drawer, and there is no `valid_until`. So the
gap is not the concept, it is that the concept is not uniform.

---

## 2. Scale — measured

`node bench/scale.mjs`, this container, Node 22:

| entries | corpus | build | heap | search p50 | p95 | vocab |
|--:|--:|--:|--:|--:|--:|--:|
| 1 000 | 0.2 MB | 113 ms | 2.1 MB | 1.07 ms | 1.40 ms | 3 428 |
| 10 000 | 2.5 MB | 802 ms | 27.5 MB | 15.5 ms | 18.4 ms | 15 863 |
| 100 000 | 25.1 MB | 8 592 ms | 209.8 MB | 174.3 ms | 211.6 ms | 19 490 |
| 1 000 000 * | 251 MB | 66 s | 1 525 MB | 1 767 ms | 2.46 s | — |

\* from the earlier run recorded in `bench/scale.mjs`, not re-measured today.

Linear in N, ~1.7 µs per document. Reproduced twice within 8%.

**Proportion.** The real memory this was built for grows at ~48
entries/day. 10k is half a year out, 100k is six years, 1M is a lifetime.
The million-entry row is a property of the design, not a problem anyone
has. That matters for prioritisation and is the reason nothing here is
labelled DO NOW on scale grounds alone.

---

## 3. The selectivity finding — measured

The repo's standing conclusion was: posting lists would cut work ~3x,
therefore not worth the rewrite. Re-measured at 100k, per query:

| query | terms | union, all terms | union, rare terms only | factor | same top-10? |
|---|--:|--:|--:|--:|:--|
| billing handler failed | 3 | 100 000 | 10 176 | 9.8x | yes |
| auth check database | 3 | 100 000 | 9 976 | 10.0x | yes |
| security deploy queue | 3 | 28 742 | 9 327 | 3.1x | yes |
| id42 | 1 | 19 | 19 | 1.0x | yes |
| file12.mjs | 2 | 100 000 | 138 | **724.6x** | yes |
| id42 file12.mjs | 3 | 100 000 | 157 | **636.9x** | yes |
| id7 id42 id99 | 3 | 362 | 362 | 1.0x | yes |
| frontend cache id300 | 3 | 19 716 | 19 | **1037.7x** | yes |

Two things fall out of this table that were not on anyone's radar.

**A union is exactly as unselective as its commonest term.** `file12.mjs`
tokenises into `file12` + `mjs`. `mjs` is in every document, so the union
is the whole corpus — for a query that names one file. The document set
is not large because the corpus is large; it is large because one token
is cheap. Corpus size never entered into it: the earlier 1.7x measurement
came out *identical at 1k, 10k and 100k*.

**So the fix is not an inverted index. It is term selection.** Restricting
candidate generation to terms whose posting list is below a threshold
returned the same top-10 in 8 of 8 queries while scoring 3x–1038x fewer
documents.

Honest limit: "same top-10 in 8 of 8" is evidence, not a guarantee. A
document made only of common terms could in principle score into the top
10 and be missed. The production-safe form of this is not a threshold
heuristic but **WAND / BlockMax-WAND**, which reaches the same speedup
with an exactness guarantee. That is the recommendation — the threshold
experiment is the proof that the headroom is there.

---

## 4. Red team — measured

Scenarios from the brief, run against the real code.

| # | scenario | result |
|--:|---|---|
| 5 | two agents write at once (4 processes, 200 lines each, 160 B to 60 kB per line) | **held.** 800/800 lines, 0 corrupt at every size |
| 6 | index cache destroyed (`{ not json`) | **held.** search returns correct hits; cache silently rebuilt |
| 7 | file truncated mid-line | **held.** search runs, broken line skipped |
| 3 | memory contains a real AWS key shape | **held.** redacted to `[REDACTED:env-secret]` before disk |
| 2 | project A retrieves project B | **FAILED.** without `project`, both are returned |
| 1/10 | agent Mallory supersedes agent Alice's decision | **FAILED.** `replaces_id` applied with no authority check; Alice's line stops being returned |
| 4 | memory contains prompt injection | **FAILED.** returned verbatim, unmarked as foreign content |

On #5: the safety is real but **unowned**. `appendFileSync` issues one
`write(2)` with `O_APPEND`; Linux holds the inode lock for its duration,
so it is atomic *on this filesystem*. On NFS it is not. Nothing in the
code or docs states this dependency, and no test guards it. A property
you rely on and never named is a property you will lose in a refactor.

On #7: skipping a broken line is right, but skipping it **silently** is
not. A half-written file loses entries with no signal. `mem doctor`
should count unparseable lines.

---

## 5. What must not be lost

Ranked by how hard they would be to get back:

1. **Append-only with read-time resolution.** Corrections, tombstones and
   topic merges all apply on read. This is the reason the memory is
   trustworthy and the reason an audit is possible at all. Every proposal
   below preserves it.
2. **Model in one place.** Deterministic capture and retrieval mean the
   memory works offline, costs nothing per query, and is reproducible.
3. **Text in git.** Inspectability and portability are not features here,
   they are the product.
4. **Redaction before disk.** Not after, not on read.
5. **Refusing to guess.** `appendToIndex` returns null rather than
   guessing on a non-append change. That instinct is worth more than any
   feature in this document.

---

## 6. Five architectures

| | architecture | core change | effort | migration |
|---|---|---|--:|--:|
| **A** | Minimal evolution | selective candidate generation (WAND); enforced scopes; write authority | S | none |
| **B** | SQLite index | files stay canonical, SQLite replaces `.mem/*.json` as the index | M | rebuildable, no data move |
| **C** | Hybrid engine | B + optional vector/graph sidecars | L | none forced |
| **D** | Backend abstraction + gateway | pluggable file/SQLite/Postgres behind one API | L | invasive |
| **E** | Full event-sourced, trust-scored, graph-native | events as the only primitive; state is a projection | XL | total rewrite |

Scored against the brief's weighting (local-first, privacy, determinism,
retrieval, temporal, multi-agent, multi-project, security, auditability,
portability, offline weighted highest):

| | A | B | C | D | E |
|---|--:|--:|--:|--:|--:|
| local-first / offline / portability | 5 | 5 | 4 | 3 | 3 |
| determinism | 5 | 5 | 4 | 4 | 3 |
| retrieval quality | 4 | 4 | 5 | 4 | 5 |
| temporal | 3 | 4 | 4 | 4 | 5 |
| multi-agent / multi-project | 4 | 4 | 4 | 4 | 5 |
| security / auditability | 5 | 5 | 4 | 3 | 4 |
| simplicity / maintainability | 5 | 4 | 2 | 2 | 1 |
| scalability | 3 | 5 | 5 | 5 | 5 |
| effort (inverted) | 5 | 4 | 2 | 2 | 1 |
| **weighted** | **4.4** | **4.5** | **3.8** | **3.4** | **3.4** |

**Recommended: A now, B when the numbers demand it.**

A fixes everything measured to be actually broken and costs no migration.
B is the right answer to scale — but the trigger for B is a number, not a
date: **when p50 search exceeds ~50 ms on the real corpus**, which at the
measured ~1.7 µs/doc means roughly 30k entries, i.e. about two years out
at the observed growth rate. Building B before that trigger is building
for a corpus that does not exist.

D and E are rejected below.

---

## 7. What NOT to build

The brief asked for this explicitly, and it is the most useful section.

- **No vector database.** Not "not yet" — the case has not been made. The
  measured retrieval failure mode is a *union* problem, and no embedding
  fixes a candidate set that is the whole corpus. Fix selection first,
  then re-measure whether semantic recall is still missing.
- **No backend abstraction (D).** An abstraction over file/SQLite/Postgres
  costs indirection in every call path to buy portability nobody has
  asked for. "Backends could be swapped" is future-proofing, which the
  brief itself rules out as insufficient justification.
- **No full event sourcing (E).** The log *is* the event store; entries
  with `replaces_id` and `closes_id` are already events, and reads are
  already projections. Renaming this into `MemoryCreated` /
  `MemorySuperseded` adds vocabulary, not capability.
- **No numeric confidence scores.** A float nobody can calibrate becomes
  a number everybody rounds to "probably fine". What is actually missing
  is not confidence but **authority**: who asserted this, and were they
  entitled to. That is categorical and checkable. Build that instead.
- **No memory decay.** Recency is already a ranking term (+15%, halved at
  90 days). Decay that *deletes* is incompatible with append-only; decay
  that *down-ranks* is what recency already does.
- **No explicit memory-type taxonomy** (working/episodic/semantic/…).
  cheap-mem already derives the useful distinctions from drawer, scope,
  temporal state and provenance. A parallel taxonomy is a second place
  for the same fact to be wrong — the same failure the topic field had
  before it was cut from 72 to 18.
- **No knowledge graph.** The measured retrieval problem is selectivity.
  Graph traversal earns its place when a query is a *path* question
  ("what did this decision cause"), which is a small, nameable set of
  queries — and the existing typed links already answer those.

---

## 8. Roadmap

### Phase 1 — the three that are actually broken

| | change | impact | risk | breaking |
|---|---|---|---|---|
| 1.1 | **Scope becomes a boundary.** A retrieval context carries a scope; `search()` requires it and returns only what the scope admits. Cross-scope reads become explicit and logged, not the default. | high | low | yes, `search()` signature |
| 1.2 | **Write authority on `replaces_id` / `closes_id`.** A superseding line is honoured only if its writer is the original writer, or holds an authority the original does not. Otherwise the old line stands and the attempt is recorded as a *contested* claim, visible in the viewer. Append-only preserved: nothing is rejected, the resolution changes. | high | low | no (read-time rule) |
| 1.3 | **Foreign content is marked as foreign.** Retrieved text carries its provenance into the context envelope. The hook already prints "data, not instructions" — that line belongs in the retrieval layer, per hit, not in the prose around it. | high | low | no |

### Phase 2 — cheap, measured wins

- **2.1 Selective candidate generation (WAND).** 3x–1038x fewer documents
  scored, exactness preserved. Gate: p50 must not regress on the real
  corpus, top-10 must be identical on the existing retrieval benchmark.
- **2.2 `mem doctor` counts unparseable lines.** Silent skipping becomes
  a visible number.
- **2.3 Name the concurrency dependency.** A comment and a test for the
  `O_APPEND` atomicity assumption, and an explicit "not safe on NFS".
- **2.4 `valid_until` uniformly, not only in the timeline drawer.**
  Completes the bitemporal model the code already half has.

### Phase 3 — explainability

`mem explain <query>` — why a hit ranked where it did (term contributions,
coverage, recency, scope) and, more valuable, why a *named* entry did not
appear. This is a debugging tool for building agents, and it is nearly
free: the scorer already computes every number it would print.

### Phase 4 — SQLite index, on a trigger

Files stay canonical. SQLite replaces the JSON cache. Trigger: p50 > 50 ms
on the real corpus (~30k entries). Not before.

### Phase 5 — evaluation as a standing gate

Extend `bench/retrieval.mjs` into a suite with fixed expectations for
exact / temporal / multi-hop / contradictory / cross-project retrieval,
plus a poisoning-resistance case per Phase 1.2. Any retrieval change must
move it or leave it alone; none may quietly regress it.

---

## 9. The smallest unit

The brief asks whether the primitive should be memory, observation, event,
fact or claim.

It is already **claim**, and that is right — the code just does not say so.
Every line records *someone asserting something at a time*: an author, a
timestamp, a content, and optionally what it replaces. That is a claim.
"Fact" would be a lie (facts do not need `replaces_id`). "Event" describes
only one drawer. "Observation" loses the author. "Memory" is the product,
not the unit.

Naming it claim is not cosmetic — it makes the two Phase-1 gaps obvious.
A claim without an author who may make it is a poisoning vector (1.2). A
claim retrieved without its claimant is an injection vector (1.3). Both
follow from taking the existing primitive seriously.

---

## 10. Red team against this proposal

- **Scope-as-boundary breaks every caller.** True. Mitigation: a scope
  that admits everything, explicitly constructed, so the permissive case
  is visible in the diff rather than implied by an omitted argument.
- **Write authority needs identity, and agent identity is a string.** A
  string is forgeable by anything that can write the file. So authority
  is only as strong as write access to the repo — this raises the cost of
  poisoning from *one line* to *repo write access*, which is a real gain
  and not a guarantee. Say so; do not sell it as security.
- **WAND changes results under a corpus shape not tested.** Gate it on
  the benchmark and keep the full scan behind a flag for a release.
- **Contested claims could accumulate.** If poisoning attempts are kept
  rather than rejected, the log grows with junk. Bounded by the same
  thing that bounds every other line: it is append-only and visible.
- **The synthetic corpus flatters the finding.** Ten topic words is
  denser in common terms than a real memory. That makes the *baseline*
  worse, so the measured factors are, if anything, conservative for the
  rare-query cases and optimistic for the common ones. The correct next
  measurement is the same table on the real 611-entry corpus.

---

## 11. Where cheap-mem is honestly better, and where it is not

**Better:** deterministic retrieval at zero marginal cost; a memory you
can `git log`; redaction before disk with a pre-commit gate; corrections
that never destroy the original; running with no service, no key and no
network.

**Worse:** no scope enforcement (Phase 1.1); no write authority (1.2);
linear search (Phase 2.1/4); no semantic recall at all — a paraphrase
with no shared vocabulary is not found, and the thesaurus only softens
this; no evaluation gate, so retrieval quality is defended by intuition
between benchmark runs.

Note what is *not* on the worse list: scale. At the observed growth rate
the linear scan is fine for years. Treating it as the urgent problem would
be optimising the thing that was easiest to measure rather than the thing
that is broken.
