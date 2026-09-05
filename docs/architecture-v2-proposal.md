# cheap-mem — ARCHITECTURE V2 PROPOSAL

Second research round. No implementation. The brief asked whether deeper
problems sit behind the first audit's findings; five new measurements say
yes, and one of them refutes a claim made in the first round.

Prerequisite reading: `docs/architecture-audit-2026-09-05.md`.
Reproduce with `bench/redteam.mjs`, `bench/selectivity.mjs`, `bench/scale.mjs`.

---

## 0. Corrections to round one

Stated before the new material, because a report that quietly fixes its own
record is worth less than one that shows the fix.

**Wrong: "a future timestamp buys ranking."** It does not. `search()` clamps
the recency bonus at `ageDays >= 0` (src/search.mjs:525), so a 2099 entry
gets nothing. Measured: top-3 unchanged. The vector I saw was a different
one, isolated below.

**Wrong: "a git merge conflicts and corrupts lines."** It does — but only
in a repository without `.gitattributes`. cheap-mem ships `*.jsonl
merge=union`, and with it the merge is clean, keeps both sides, and
byte-identical lines collapse. My first test repo was a bare `git init`
without the file. Measured both ways below.

Both errors have the same shape: a property was measured in an environment
that had been stripped of the thing that provides it. That shape turns out
to be the central finding of this round.

---

## 1. New measurements

### 1.1 Index divergence — clean

Does the incremental append produce the same index as a full rebuild?
200 entries cached, 20 appended, then compared:

    N equal: true (220/220) · docFreq terms differing: 0 · top-5 differing: 0/4 queries

No silent divergence. This closes a failure class the brief listed
("index divergence", "eventual consistency") with a negative result.

### 1.2 Ranking manipulation — open, and cheaper than expected

Corpus: 50 genuine entries about deployment. Query: *how do we deploy to
production*. One attacker entry appended per run:

| attack | top-3 |
|---|---|
| none | e0:0.02 e1:0.02 e2:0.02 |
| future timestamp (ts 2099) | e0:0.02 e1:0.02 e2:0.02 — **no effect** |
| short entry containing all query words | **KURZ:0.03** e0 e1 |
| term stuffing | **STUFF:0.03** e0 e1 |

Two things matter here.

**The winning attack needs no stuffing.** A *short* document containing the
query terms wins on BM25 length normalisation alone. `deploy to production`
/ `deploy production` — twelve tokens total — outranks fifty real entries.
Term stuffing merely reaches the same place more crudely.

**The margin is small but rank is not.** 0.03 versus 0.02 is nothing; being
position 1 of a top-3 context budget is everything. The real answer is not
down-weighted, it is *evicted*.

This is not fixable inside the ranker. Any writer who can add a document
can win a lexical ranking, and the same holds for a vector index. It is an
authority problem wearing a ranking costume — which is what unifies §2, §3
and §13 of the brief into one mechanism below.

### 1.3 git merge — safe, but by one uncommitted-elsewhere file

| case | merge | readable | corrupt | markers | ids kept |
|---|---|--:|--:|:--|---|
| no `.gitattributes`, different lines | **CONFLICT** | 3 | **3** | yes | base,b1,a1 |
| `merge=union`, different lines | clean | 3 | 0 | no | base,b1,a1 |
| `merge=union`, identical line | clean | 2 | 0 | no | base,a1 |

With the union driver: correct, and byte-identical lines deduplicate.
Without it: conflict markers turn three of six valid lines into garbage —
and garbage lines are skipped *silently* (round one, scenario 7). So the
combination is: **a merge in a repository that lost `.gitattributes`
destroys memories without a single error message.**

There is no test asserting `.gitattributes` exists or contains the driver.

### 1.4 Unicode — one evasion found

Same secret shape, written four ways:

| form | redaction hits |
|---|--:|
| `NAME=value` | 1 |
| NBSP before `=` | 1 |
| **full-width `＝` (U+FF1D)** | **0** |
| zero-width space inside the value | 1 |

A secret written with a full-width equals sign passes redaction and reaches
disk and git. The pre-commit hook uses the same matcher, so it passes there
too. This is a real bypass, not a theoretical one — and the fix is one line
(Unicode-normalise before matching), which is why it belongs in Phase 1
rather than a research programme.

---

## 2. The failure class nobody looked at

The brief's §10 asked for the class missed by both rounds. It is not in its
own list either. It is this:

> **cheap-mem's correctness rests on environment properties that live
> outside the codebase, are never stated, and are verified by nothing.**

Three found so far, all load-bearing, all silent when absent:

| property | provides | held by | guarded by |
|---|---|---|---|
| `O_APPEND` write atomicity above PIPE_BUF | concurrent writers do not corrupt | Linux + ext4 (**not NFS**) | nothing |
| `*.jsonl merge=union` | distributed appends merge without loss | one line in `.gitattributes` | nothing |
| `core.hooksPath` → pre-commit | secrets do not reach git | local git config, **not cloned** | nothing |

Each is invisible when correct and silent when broken. A memory copied to
an NFS share, a drawer vendored into another repository, a fresh clone
where nobody ran the hook installer — each keeps working, keeps answering,
and loses or leaks data with no signal.

**This is a more fundamental problem than any single finding of round one**,
because it is the reason those findings were hard to see: the system's
guarantees are not in the system.

### The V2 component that follows: environment assertions

`mem doctor` today checks *data*. It must also check *the assumptions*:

    env  filesystem     ext4, O_APPEND atomicity assumed — verified by probe
    env  merge driver   *.jsonl merge=union present in .gitattributes
    env  pre-commit     core.hooksPath set and the hook executable
    env  clock          system clock within N minutes of the newest entry

Each check is a few lines and turns an invisible dependency into a visible
one. This is the cheapest high-value item in the whole proposal, and it is
architecture, not polish: it moves guarantees from folklore into the code.

---

## 3. The primitive — is it Claim?

Tested against the alternatives on one question: *what can this primitive
express that the others cannot, and what does it force?*

| primitive | forces | loses |
|---|---|---|
| Fact | that it is true | corrections (`replaces_id` is meaningless for a fact) |
| Event | that it happened at a point | states that hold over intervals |
| Observation | a passive observer | the author's responsibility |
| Memory | nothing — it is the product name | everything |
| Experience | a subject who lived it | third-party and tool-written entries |
| Assertion | ≈ Claim, weaker on provenance | nothing much — a synonym |
| **Claim** | an author, a time, and revisability | — |

**Claim survives.** But the useful part is not the name, it is what the name
forbids: a claim without an author is malformed. Round one's three failures
are all instances of that single malformation — a claim retrieved without
its author (injection), superseded without checking the author (poisoning),
returned outside the author's scope (leakage).

### Minimal field set

Rejecting the brief's list field by field.

**Fundamental (cannot be derived):**

    id          identity for reference and supersession
    author      who asserts. Without it the primitive collapses to Fact.
    authority   the tier the author asserted in (see §4). Not derivable
                from author: the same agent may relay a user's statement.
    scope       where this claim is valid (see §5). One field, not two.
    ts          transaction time — when it entered the log
    body        the natural-language content
    replaces    optional: the claim this supersedes

**Derived, must not be stored:**

    status      ← from the existence of other claims (replaces/closes) plus
                  authority checks. Storing it would require mutation, which
                  is the one thing this design refuses. THIS IS THE MOST
                  IMPORTANT REJECTION IN THIS DOCUMENT.
    project     ← scope. A separate field is a second place to be wrong.
    agent       ← author.
    topic       ← already derived; the 72→18 exercise proved a stored topic
                  drifts from the thing it names.
    confidence  ← rejected entirely (§4).
    subject/predicate/object ← requires triple extraction, i.e. a model call
                  on the write path, which breaks "model in exactly one
                  place" and discards the prose BM25 actually ranks. A
                  triple store answers questions this system does not ask.

**Optional (present only when meaningful):**

    valid_from / valid_until   temporal claims (§6)
    evidence                   a pointer (raw capture, file, URL) — never a
                               copy, or the memory doubles as a mirror
    source                     for relayed claims: who said it originally

Nine fields, three optional. Everything the brief listed as separate is
either one of these or derived from them.

---

## 4. Authority model

**Neither binary nor graduated. Categorical, with a total order.**

    USER      the person, stated directly
    SYSTEM    configuration, policy, measured facts (a benchmark result)
    AGENT     an agent's own conclusion
    EXTERNAL  a document, web page, tool output
    INFERRED  a model's inference over other claims
    UNKNOWN   provenance missing — the default for anything unstamped

Ordered `USER > SYSTEM > AGENT > EXTERNAL > INFERRED > UNKNOWN`.

Why not numeric: a float nobody can calibrate becomes a number everybody
rounds to "probably fine", and two 0.7s from different pipelines are not
comparable. The tiers are comparable because they are defined by *who*,
which is checkable, not by *how sure*, which is not.

Why not per-verb permissions (`can_supersede`, `can_delete`, …): that is a
capability list, and it belongs on the *capability* (§5), not on the claim.
Conflating them is how ACL systems become unauditable. Authority answers
"how much does this weigh"; capability answers "what may this caller do".

**Two rules, and they are the whole model:**

1. **Supersession requires equal-or-higher authority than the claim it
   supersedes**, and equal authority additionally requires the same author.
   An AGENT claim cannot retire a USER claim. (Fixes round-one failure 2.)
2. **Authority is a hard tier in ranking, above relevance.** A higher-tier
   claim answering the query outranks any lower-tier claim, whatever BM25
   says. Within a tier, BM25 decides. (Fixes §1.2 above: the attacker's
   short entry is AGENT; the user's decision is USER; length normalisation
   never gets to compete across the tier boundary.)

Rule 2 is the load-bearing idea of this document. Ranking manipulation,
context poisoning and memory poisoning are one problem — *a low-authority
writer influencing what a high-authority reader sees* — and one mechanism
addresses all three.

**Honest limit.** Author and authority are fields in a file. Anyone with
repository write access can forge both. This raises poisoning from *one
line* to *repository write access*; it is not cryptographic and must never
be described as such. Signed commits would close it and are out of scope
until someone has the threat model that needs them.

---

## 5. Scope and capability

Three models, judged on the brief's own criterion — *accidental* leaks, not
just deliberate ones.

**Model A — forced scope parameter.** `search()` requires `scope`. Prevents
the omission that leaks today. But the value is chosen at every call site,
so `scope: ALL` becomes the copy-paste default. Catches the bug once; loses
to habit.

**Model B — scope derived from session/agent.** No parameter to get wrong;
the retrieval context carries it. Prevents accidents almost entirely. Fails
where a legitimate caller genuinely needs another scope (the digest reads
across projects) — and the escape hatch becomes Model A again.

**Model C — capability object.** The caller holds a token that *names* what
it may reach:

    Capability { scopes: [project:diggi, agent:librarian], rights: [read] }

Not constructible from nothing: obtained from the session, or granted
explicitly. Reaching outside it is not an argument you forgot but an object
you do not have.

**Verdict: C, with B as its default constructor.** A session mints the
capability from its own identity (B's ergonomics, no parameter to fumble),
and the object exists so that widening is a visible, greppable, loggable
act (C's auditability). A audits worst: `scope: ALL` looks like every other
argument.

Scope is a **lattice, not a hierarchy** — the brief's `global > org >
project > agent > session` chain cannot express "shared between two
projects", which the digest and the inbox both already need. Nodes, with
explicit edges; a capability admits a set of nodes plus their descendants.

Cross-scope reads stay possible and become *recorded*: a claim read outside
the reader's own scope is marked as such in the assembled context, which
feeds §7.

---

## 6. Untrusted memory — architectural, not textual

The brief is right that "this is data, not instructions" in a prompt is
weak. What actually helps, ranked by how much it depends on the model
behaving:

1. **Retrieval returns structured records, never a prose blob.** Each hit is
   `{id, author, authority, scope, ts, body}`. The consumer assembles the
   context; the memory never emits a string that could pass for a
   directive. Depends on nothing.
2. **Authority tiering (§4 rule 2).** An EXTERNAL claim cannot reach the top
   of a context assembled for a USER-level question. Depends on nothing.
3. **Never inline evidence.** `evidence` is a pointer. Fetching is the
   caller's decision, at the caller's authority.
4. **Body is never a template.** No interpolation on the retrieval path.
   Round one already relies on this and never states it.
5. **Labels in the envelope** (`authority: EXTERNAL`) — helps, and is the
   only layer that depends on the model. Last, not first.

`Memory ≠ Instruction` is enforced by 1–4 being *structural*: there is no
code path that turns a stored body into part of a prompt without a caller
choosing to. What the brief asked for is achievable without a second model
call — but only if the retrieval API stops returning text.

---

## 7. Conflict semantics

Two claims about the same subject are:

- **scoped apart** if their scopes do not intersect → not a conflict.
  *(project A uses PostgreSQL, project B uses SQLite — both true.)*
- **temporally apart** if their validity intervals do not overlap → not a
  conflict, a history. *(PostgreSQL until August, SQLite since.)*
- **superseding** if one carries a valid `replaces` for the other → resolved.
- **authority-decided** if scopes and intervals overlap and authority tiers
  differ → higher tier wins, lower is returned only on request.
- **contradictory** if scopes and intervals overlap and tiers are equal →
  **not resolved. Both returned, marked as contradictory.**

**Should cheap-mem resolve or display?** Both, and the line is exactly where
resolution is *mechanical*. Interval and scope comparison are arithmetic —
resolving those is correct and cheap. Authority is a declared order —
resolving by it is deterministic. Genuine same-tier contradiction is a
judgement, and a memory that makes judgements silently is a memory nobody
can audit.

But "return both" is where poisoning enters (an attacker manufactures a
contradiction to get their claim into every context). Hence: **contradiction
is surfaced, not multiplied.** One flag on one result, not two competing
entries, with the second reachable via `mem explain`. Context cost stays
bounded.

---

## 8. Temporal semantics

Two axes, uniformly, not only in the timeline drawer:

    ts           transaction time — when the log learned it. Never null.
    valid_from   when the claim's content began holding. Defaults to ts.
    valid_until  when it stopped. Open-ended when absent.

`observed_at` is rejected as a third axis: for a claim, observation *is* the
transaction — the author asserting at a time. Where they genuinely differ
(a relayed claim), that is `source` plus the original's `valid_from`.

**Late-recorded information** is the case bitemporality exists for and it
works: `ts = 2026-09-05, valid_from = 2026-01-01`. A query "what did we
believe in March" filters on `ts`; "what was true in March" filters on
`valid_from/until`. Both answerable, from the same log.

**A wrong historical claim** is corrected the same way as any other: a new
claim with `replaces`, carrying its own `ts` and a corrected validity
interval. The original stays readable — that is the point of the design.

**Interval comparison rules** (needed, currently unwritten):
`valid_until` is exclusive; absent `valid_from` means "since ts"; absent
`valid_until` means "still"; two intervals overlap iff
`a.from < b.until && b.from < a.until` with absent bounds as ±∞. Claims
whose `valid_until` precedes their `valid_from` are malformed and belong in
`doctor`, not in retrieval.

**Clock skew** is real and currently unowned: `ts` comes from whichever
machine wrote it. Ordering across machines is therefore approximate. Two
mitigations, no more: the recency clamp already ignores future timestamps,
and `doctor` should report entries whose `ts` lies ahead of the system
clock. Vector clocks would be a serious answer to a problem nobody has.

---

## 9. Claim lifecycle

    active      default
    disputed    a supersession was attempted without sufficient authority
    superseded  a valid supersession exists
    revoked     the author withdrew it (a claim with `closes`)
    archived    outside every live scope and validity window

**All five are derived at read time.** None is a stored field — see §3.

Answering the brief's questions about `disputed` directly:

- *Can an attacker flood the log?* Yes, with disk. Not with retrieval:
  **disputed claims are not indexed.** Flooding costs the attacker writes
  and the defender bytes, and buys no influence over any context. That
  asymmetry is the whole defence, and it is why "keep, don't reject" is
  affordable.
- *Should disputed claims be returned by default?* No. Visible in `doctor`,
  in the viewer, and via `mem explain`. Never in an assembled context.
- *When do they stop mattering?* When the claim they attacked is itself
  superseded by a valid supersession. They stay in the log — append-only —
  but stop being reachable except historically.
- *How separated?* By not being in the index at all. Separation by filter
  is the mistake §5 is about.

---

## 10. Retrieval architecture

Round one measured the headroom (3x–1038x fewer documents scored, identical
top-10 in 8/8). The remaining question is *which* mechanism, and the brief's
constraint is right: **no silent recall loss.**

| | mechanism | exact? | complexity | verdict |
|---|---|---|---|---|
| A | rare-term candidates only | **no** — a document of only common terms can be missed | trivial | reject as the default |
| B | A + full-scan fallback below a candidate floor | no (same hole, narrower) | small | reject: the hole is not where the floor is |
| C | WAND | **yes** for top-k | moderate | **recommended** |
| D | BlockMax-WAND | yes | high (block metadata, tuning) | not at this size |
| E | hybrid by query class | depends on the classifier | high | reject: a classifier that can be wrong reintroduces silence |

**C.** WAND gives exact top-k with a scored-document reduction in the range
measured, and its correctness argument is a proof rather than a benchmark
observation — which matters precisely because "identical in 8 of 8 queries"
is not a guarantee. D is C's optimisation and earns its complexity in the
1M–10M band, not before.

The invariant that makes this safe to ship: **the exhaustive scan stays, as
the oracle in the test suite.** Every WAND result is asserted identical to
the scan's on the benchmark corpus. An optimisation whose reference
implementation is deleted is an optimisation nobody can check.

---

## 11. Scale bands

Grounded in the measured ~1.7 µs/document and the observed ~48 entries/day.

| band | storage | index | retrieval | RAM | expected p50 | writes | concurrency |
|---|---|---|---|--:|--:|---|---|
| **0–10k** | JSONL, as today | in-memory + JSON cache, incremental | exhaustive scan | < 30 MB | < 16 ms | append | O_APPEND, verified by assertion (§2) |
| **10k–100k** | unchanged | + WAND posting lists in the cache | WAND | ~200 MB @100k | < 30 ms | unchanged | unchanged |
| **100k–1M** | JSONL canonical, **sharded by scope+month** | SQLite (FTS5 or own posting tables), rebuildable from JSONL | WAND in SQLite | bounded, mmap | < 50 ms | append + async index | single writer per shard |
| **1M–10M** | unchanged | SQLite + BlockMax, per-shard | + shard pruning by scope/time before scoring | bounded | < 100 ms | batched | writer per shard |
| **10M+** | out of scope for a local-first memory | — | — | — | — | — | — |

**Triggers, numeric, not calendrical:**

    → 10k–100k band:  p50 > 25 ms on the real corpus
    → 100k–1M band:   p50 > 50 ms, OR index cache > 100 MB,
                      OR full rebuild > 30 s
    → 1M–10M band:    p95 > 200 ms, OR RSS > 1 GB

At the observed rate the second trigger is ~2 years out and the third is
not on the horizon. **The 10M+ band is deliberately empty**: a memory that
needs it is no longer local-first, and pretending otherwise is how the
architecture gets ruined for a user who does not exist.

Two properties every band must keep: JSONL stays canonical and the index
stays rebuildable from it; and no band introduces a component that must run
for the memory to be readable.

---

## 12. Attack matrix

| attack | preconditions | exploit | impact | detection | prevention | recovery |
|---|---|---|---|---|---|---|
| **Ranking eviction** *(measured)* | write one claim | short claim containing query terms | real answer evicted from top-k | rank inversion vs. authority tier | authority tier above relevance (§4.2) | claim is disputed/retired; ranking unaffected retroactively |
| **Poisoning by supersession** *(measured)* | write one claim | `replaces` a higher-authority claim | original stops being returned | supersession across tiers | §4.1 | original never left the log |
| **Injection via body** *(measured)* | any stored text | body read as instruction | agent acts on foreign text | none today | structured records (§6.1), tiering | — |
| **Cross-scope read** *(measured)* | call without scope | omitted parameter | leakage, accidental | capability required | §5 model C | — |
| **Redaction evasion** *(measured)* | write a secret with `＝` | full-width equals | secret to disk and git | canary, `doctor` | Unicode-normalise before matching | rotate the key |
| **Merge-loss** *(measured)* | `.gitattributes` absent | conflict markers invalidate lines | **silent memory loss** | env assertion (§2) | assert driver; count unparseable lines | git history |
| **Provenance forgery** | repo write access | edit `author`/`authority` | full authority | git blame | signed commits (out of scope) | history |
| **Amplification** | agent write loop | 1 input → N claims/links | context and index bloat | per-run write budget | §13 | append-only: prune by scope, never by delete |
| **Context budget** | write many mid-relevance claims | fill top-k with near-misses | real answer crowded out | diversity/tier gates | tiering + MMR (present) | — |
| **Clock manipulation** | write access | back-date `valid_from` | rewrite apparent history | `ts` vs. clock check | recency clamp (present); `doctor` check | `ts` is independent of `valid_from` |

Six of eleven are measured, not hypothesised. Three of those six were found
in this round.

---

## 13. Amplification limits

The brief's `1 input → 100 memories → 1000 links → 10000 derived claims` is
prevented by budgets, not by cleverness:

- **Per-digest write budget.** A digest run that would write more than *k*
  claims from one capture stops and reports. The number is a policy, and
  having one at all is the point.
- **Derived claims carry `derived_from` and inherit the *lowest* authority
  of their sources.** A conclusion cannot outrank its premises. This alone
  kills derived-claim explosion as an attack, because amplifying claims
  amplifies nothing that outranks the original.
- **Links are typed and directional; untyped links are not created.** The
  graph cannot grow by association.
- **Duplicates: `merge=union` deduplicates byte-identically only.** Semantic
  duplicates need a content hash on the body — cheap, deterministic, and
  it turns "did we already record this" into a lookup rather than a model
  call. Recommended, and new to this round.

---

## 14. Explainability — deterministic, and it already exists

Every number needed is computed during scoring; none is stored.

    Why retrieved?        term contributions, coverage, recency, authority tier
    Why not retrieved?    which term missed; or filtered by scope/tier/validity;
                          or below top-k with the score it did reach
    Why ranked above X?   the per-term difference
    Why conflicting?      the overlapping interval and scope
    Why authoritative?    the tier, and the claim that granted it
    Why superseded?       the superseding claim's id, author, and tier

"Why not retrieved" is the valuable half and the one no memory system
offers. It requires the exhaustive scan — which §10 keeps as the test
oracle anyway, so `mem explain` costs a scan on an explicit debug command
and nothing on the hot path. **No model involved.**

---

## 15. Benchmark and CI gates

Classic IR metrics do not measure what breaks here. The suite splits:

**Quality:** P@k, R@k, MRR, nDCG on a fixed set with expectations written
before the change.
**Cost:** p50/p95/p99 latency; context tokens per query.
**Correctness under adversity, each with a generated adversarial set:**
stale-retrieval rate, conflict-retrieval rate, **poison-retrieval rate**
(does the crafted claim of §1.2 reach top-k), **cross-scope leakage rate**,
duplicate rate.

**Gates — absolute where the answer is binary, relative where it is not:**

    cross-scope leakage             == 0        absolute
    unauthorised supersessions      == 0        absolute
    corrupted writes (concurrency)  == 0        absolute
    secrets reaching disk           == 0        absolute
    environment assertions          all pass    absolute
    poison-retrieval rate           == 0        absolute, on the known attacks
    WAND top-k vs. exhaustive scan  identical   absolute
    recall@10                       no regression vs. previous commit
    p95                             no regression > 20 %

Absolute zeros only where a single instance is a defect. Recall and latency
are relative, because an absolute threshold on a moving corpus is a number
that gets edited rather than met.

---

## 16. Architecture comparison

Same criteria as round one, now with the V2 mechanisms priced in.

| | current | V2 minimal | V2 + SQLite | hybrid engine | full infrastructure |
|---|--:|--:|--:|--:|--:|
| correctness | 2 | 5 | 5 | 4 | 4 |
| security | 2 | 5 | 5 | 4 | 4 |
| simplicity | 5 | 4 | 3 | 2 | 1 |
| performance | 3 | 4 | 5 | 5 | 5 |
| scalability | 2 | 3 | 5 | 5 | 5 |
| maintainability | 4 | 4 | 3 | 2 | 2 |
| portability | 5 | 5 | 4 | 3 | 2 |
| determinism | 5 | 5 | 5 | 4 | 3 |
| extensibility | 3 | 4 | 4 | 5 | 5 |
| **total** | **31** | **39** | **39** | **34** | **31** |

V2 minimal and V2+SQLite tie, and that is the finding: **SQLite buys
scalability and performance at exactly the cost it takes back in simplicity,
maintainability and portability.** It is therefore not better — it is
better *later*, when the numeric triggers of §11 make the scalability column
stop being theoretical. Build V2 minimal now; the trigger decides the rest.

---

## 17. Red team against V2 → V3

**Attack 1 — authority tiers make the memory unusable.** Everything a user
did not say personally is AGENT or below, so a genuine agent finding never
surfaces above a stale USER claim.
*Real.* → **V3:** tier dominance applies only to *conflicting* claims, not to
ranking generally. A higher tier wins where two claims contradict; where
they do not, relevance decides. Ranking eviction is prevented because the
attacker's claim must *contradict* to displace — and contradicting a USER
claim is what §4.1 already refuses.

**Attack 2 — the attacker writes USER.** Authority is a field.
*Real, and unfixable at this layer.* → **V3:** authority may only be
*asserted upward* by a capability that holds it. A session minted from an
agent identity cannot mint a USER capability. Still forgeable by direct file
write; the honest statement stays "cost of poisoning = repository write
access", and it is written into the security model rather than implied.

**Attack 3 — non-contradicting flood.** After V3's attack-1 fix, an attacker
writes many *plausible, non-contradicting, short* claims and evicts by
volume.
*Real.* → **V3:** per-author, per-tier quota inside a single assembled
context — at most *m* claims from any one author below USER tier. Diversity
enforced structurally rather than by MMR, which optimises for a different
thing.

**Attack 4 — disputed-claim retrieval poisoning via `mem explain`.** Disputed
claims are unindexed but visible in explain; an agent that reads explain
output reintroduces them.
*Real.* → **V3:** `explain` output is a developer surface and must be marked
as never-context. Same rule as §6.1: it returns records, not prose.

**Attack 5 — environment assertions become the new silent failure.** They
warn, nobody reads warnings, and the assertion is as invisible as the
property it guards.
*Real, and it is the shape this whole round is about.* → **V3:** the
`merge=union` and pre-commit assertions are **CI gates**, not `doctor`
warnings (§15). A property that matters is asserted where a human cannot
skip past it.

**Attack 6 — WAND plus tiering interact.** WAND prunes by score upper
bound; a tier that promotes a document after scoring breaks the bound and
can drop a claim that should have won.
*Real, and subtle — this is the kind of bug that ships.* → **V3:** tier is
applied as a **partition before scoring**, not as a multiplier after. Score
within tier; merge tiers in order. WAND's bound stays valid inside each
partition. This constraint has to be in the design, because discovering it
during implementation means discovering it as a silent recall bug.

---

## 18. The four required answers

### What is cheap-mem's most fundamental architectural idea?

**Nothing is ever rewritten, and everything is resolved on read.**
Corrections, closures, topic merges — all are new lines interpreted at read
time. It is what makes the memory auditable, what makes concurrent writers
safe, what makes `merge=union` correct, and what makes every mechanism in
this document expressible without a migration. Every other property —
local-first, deterministic, git-backed — is downstream of it.

### What is the most fundamental remaining weakness?

**Not any single gap. That the system's guarantees live outside the system.**
Concurrency safety is a filesystem property. Merge safety is one line in
`.gitattributes`. Secret containment is a local git config that clones do
not carry. Each is load-bearing, none is stated in code, none is verified.
Round one's three failures were instances of the same disease at the API
level: scope, authority and provenance were also assumed rather than
enforced. That is why they were hard to see and why they will recur.

### The single change with the largest effect?

**Retrieval returns structured claims instead of text — records carrying
author, authority, scope and validity.**

One change, four failure classes: injection stops being possible because
nothing emits a directive-shaped string (§6); authority becomes available at
the point where ranking and conflict decisions happen, which is what §4, §7
and §12 all need; scope travels with the result rather than being a
forgotten argument; and explainability becomes free because the fields are
already there. It is also the smallest change on the list, and the one every
other proposal here depends on.

### Would you build the same architecture today?

**Yes — the same core, with four things right from the start.**

Keeping, without hesitation: append-only with read-time resolution; the
model in exactly one place; text in git; redaction before disk; and the
instinct that refuses to guess (`appendToIndex` returning null rather than
improvising is worth more than most features).

Doing differently:

1. **Claim with author and authority as required fields from line one.**
   Retrofitting provenance is the expensive part of this entire proposal;
   it would have cost nothing on day one.
2. **Capability instead of a scope parameter.** The leak measured in round
   one is not a bug, it is a signature that made the bug inevitable.
3. **Structured retrieval from the start**, never a text blob.
4. **Environment assertions from the first commit**, so that no guarantee
   ever lives somewhere the code cannot see it.

Not doing differently, despite the pull: no vector database, no triple
store, no event-sourcing vocabulary over a log that is already an event
log, no numeric confidence, no backend abstraction. Round two produced no
evidence for any of them — and produced hard evidence that the real problems
were smaller, closer to the disk, and considerably less fashionable.
