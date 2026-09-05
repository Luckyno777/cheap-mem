# cheap-mem — security model, data model, environment contract

Describes what is **built**, as of 2026-09-05. Where something is not
solved it says so; where a guarantee stops, it says where.

Reproduce every claim marked *measured*:
`node bench/redteam.mjs`, `node bench/selectivity.mjs`, `node bench/scale.mjs`,
`npm test`.

---

## 1. The primitive: a claim

Every line in every drawer records **someone asserting something at a
time**. Not a fact (facts do not need `replaces_id`), not an event (that is
one drawer), not an observation (that loses the author).

```
id           identity, for reference and supersession
ts           transaction time — when the log learned it
body         the entry's own fields (choice/why/title/text/fact)
author       who asserts          — absent in pre-authority data
authority    the tier asserted in — absent reads as `unknown`
project      → scope
replaces_id  optional: the claim this supersedes
valid_from   optional: when the content began holding (default: ts)
valid_until  optional: when it stopped (exclusive)
```

**Derived, never stored.** `status` (active / superseded / disputed /
revoked) is computed from other claims at read time. Storing it would
require mutation, which is the one thing this design refuses. Same for
`topic` areas and for scope, which comes from `project`.

---

## 2. Authority

`user > system > agent > external > inferred > unknown` (`src/authority.mjs`).

Categorical with a total order, not a number. A float nobody can calibrate
becomes a number everybody rounds to "probably fine", and two 0.7s from
different pipelines are not comparable. Tiers compare because they are
defined by *who* asserted — which is checkable — rather than by *how sure*
someone was, which is not.

**One rule, no third case.** A supersession is honoured when the same
author corrects their own claim, or when a strictly higher tier overrules a
lower one. Otherwise the target stays active and the attempting claim reads
as `disputed`.

**Legacy data still corrects.** An entry written before the rule has
neither field: both authors null, both tiers `unknown` → same author, same
tier, allowed. A rule that retroactively invalidated every correction ever
made would be a migration disguised as a security fix.

**Where it ends.** `author` and `authority` are fields in a file. Anyone
who can write the repository can write both. This raises the cost of
poisoning from ONE LINE to REPOSITORY WRITE ACCESS. It is not cryptography.
Signed commits would close it and are out of scope until someone has the
threat model that needs them.

---

## 3. Scope

A capability (`src/capability.mjs`) is a value the caller must hold.
Narrowing always succeeds; widening has no method — `grant` is the only way
to mint a broader one, from an identity, and it is a named call that greps.

Scopes are a **lattice**, not a chain: `global > org > project > agent >
session` cannot express "shared between two projects", which the digest and
the inbox already need.

**Two layers, and only one is a boundary.**

| layer | what it is | boundary? |
|---|---|:--|
| `search()` | a ranker over an index | **no** — `project` is an optional filter |
| `retrieve()` | the gateway | **yes** — fails closed, no capability no results |

Stated because the benchmark shows both: `search()` without a project still
returns everything, and that is its job. Code that needs a boundary calls
the gateway.

**`global` is the root, not a sibling.** Facts belonging to no project —
the person, the timezone, the setup — are visible to every read
capability. Found by attacking this design after building it: a project
capability first returned nothing global at all, which in production reads
as "the memory forgot who I am". A global fact is by definition not another
project's secret.

**Where it ends.** In-process. Another process can construct a permissive
capability; this is not a sandbox. What it prevents is the accident — the
forgotten argument, the copied call site, the helper that quietly widened.
That is what was measured.

---

## 4. Untrusted memory

`Memory ≠ Instruction` is enforced structurally, ranked by how much each
layer depends on a model behaving:

1. **Retrieval returns records, never a blob.** The body is the entry's own
   words joined in a fixed order — no framing, no headings, no word the
   entry did not contain. Depends on nothing.
2. **Authority travels with every claim**, so a consumer can weigh
   `external` differently from `user`. Depends on nothing.
3. **`evidence` is a pointer, never a copy.** Fetching is the caller's
   decision at the caller's authority.
4. **The body is never a template.** No interpolation on the read path.
5. **Labels in the envelope** — the only layer that depends on the model,
   and therefore last.

**Not solved.** A client can flatten structured fields back into a
paragraph, and then an injection in a body is an injection. MCP's
`structuredContent` does not prevent that; it removes the step where the
*memory* does the flattening, which is the step this side of the boundary
controls.

---

## 5. Conflict and time

- scopes do not intersect → not a conflict
- validity intervals do not overlap → not a conflict, a history
- a valid `replaces_id` → resolved
- overlapping, different tiers → higher tier wins
- overlapping, same tier → **not resolved**, surfaced

cheap-mem resolves only where resolution is mechanical. Interval and scope
comparison are arithmetic; the tier order is declared. Genuine same-tier
contradiction is a judgement, and a memory that judges silently is a memory
nobody can audit.

**Not solved: contradiction detection.** Nothing here decides that "uses
PostgreSQL" and "uses SQLite" contradict. Only explicit `replaces_id`,
overlapping validity and scope are checked. Detecting semantic
contradiction deterministically is open.

`ts` = when recorded. `valid_from` = when the content began holding
(inclusive, defaults to `ts`). `valid_until` = when it stopped
(**exclusive** — half of all interval bugs are this choice left unstated).
An `as_of` query filters on validity; the recency bonus ignores future
timestamps (`ageDays >= 0`), so a 2099 entry buys nothing — measured.

---

## 6. Resource bounds

`src/retrieval.mjs LIMITS`. Every one has a number; none is unbounded.

| bound | default | why |
|---|--:|---|
| query chars | 2000 | past this it is a paste, not a question |
| max results | 50 | a hard ceiling regardless of what a caller asks |
| body chars | 4000 | per claim, in the returned record only |
| context chars | 24000 | total across returned bodies |
| per-author share | 0.5 | no sub-user author takes the whole answer |

The author limit is a **share**, not a flat count: a digest agent
legitimately writes most of a memory, and a flat cap would suppress the
most useful author. `user` tier is exempt — the owner cannot poison their
own memory in the sense this defends against.

**The share alone is nearly worthless, and the fix is content.** Attacking
it showed twenty identical claims under twenty author names passing
untouched: rotating a name costs an attacker nothing. So identical bodies
(NFC, CRLF→LF, whitespace collapsed — no case folding, no punctuation
stripping) collapse to the highest-ranked one, whoever signed them.
Measured: a 20-claim flood returns as 1, with genuine entries still in the
answer.

That collapse happens **during** selection, not after. Doing it afterwards
was a real defect in the first version: the flood filled all ten slots,
dedup then removed nine, and the answer was a single flood claim with every
genuine entry gone. Filtering after a cutoff cannot restore what the cutoff
discarded.

Near-duplicates are deliberately left alone. They are a `possible_duplicate`
relation to surface, not a merge to perform — aggressive normalisation makes
DIFFERENT content collide, and a memory that silently merges two different
claims is worse than one that shows a duplicate.

---

## 7. Environment contract

The failure class behind the others: correctness rests on properties that
live outside the codebase. `src/environment.mjs` checks them and names the
layer that owns each. `mem doctor --strict` makes an unverifiable guarantee
a failure — for CI, where refusing to determine a property *is* the defect.

| guarantee | layer | how it is checked | if absent |
|---|---|---|---|
| `O_APPEND` atomicity | os/filesystem | filesystem type; **UNKNOWN** when undeterminable | concurrent writers may interleave (NFS) |
| `*.jsonl merge=union` | git | `.gitattributes` | a merge silently destroys entries |
| pre-commit hook | git | `core.hooksPath` + file | secrets reach git |
| clock | operational | newest `ts` vs. system clock | "newest" is wrong |

A check that guesses is worse than none: it turns an unknown into a false
assurance. Hence UNKNOWN rather than OK.

`mem init` now writes the merge driver (append, never clobber, idempotent)
and names `mem hooks install`. Before this round it shipped neither, so
every fresh memory started without the guarantee its own design depends on.

---

## 8. Threat model

| threat | attack | expected | detection | mitigation | residual |
|---|---|---|---|---|---|
| **T2 malicious agent** | supersede another's claim | refused | `doctor` integrity, `mem explain` | authority rule | can forge `author` with repo write |
| **T2** | flood disputed claims | no context effect *(measured, 50 claims)* | `doctor` | disputed is unindexed | disk grows |
| **T2** | short claim with the query words | **still works** | — | **unsolved** | see below |
| **T2** | flood under many author names | collapses to one *(measured)* | `mem explain` | identical bodies dedupe during selection | near-duplicates survive |
| **T1/T2** | read another scope | refused at the gateway | excluded-with-reason | capability | `search()` is still open by design |
| **T3 malicious document** | injection in a body | returned as a labelled record | — | structured retrieval | a client may re-flatten |
| **T3** | secret in a body | redacted before disk | canary, hook | 7 separator + 7 space look-alikes | an unknown shape |
| **T5 malicious merge** | conflict destroys lines | prevented | `env/merge-driver` | `merge=union` | driver must be present |
| **T7 corruption** | truncated line | skipped **and counted** | `doctor` integrity | — | the entry is gone |
| **T6 stale backup** | restore resurrects retired state | detected, ids named | `doctor` rollback | local watermark | fresh clone cannot detect; file is deletable |
| **T9 model output** | digest emits `authority: user` | demoted to `inferred` | `authority_clamped_from` | write-path ceiling | a writer without the ceiling set is unconstrained |

### Closed in the final verification round

**Rollback / resurrection (I12) — now detected.** `.mem/epoch.json` is a
LOCAL, gitignored high-water mark of what this machine has already seen:
claim count, newest `ts`, and the SET of retired ids. A checkout that
resurrects a superseded claim shrinks that set, and `mem doctor` reports it
as an ERROR naming the resurrected ids. `mem epoch record` refuses to lower
the mark without `--force`.

It is gitignored on purpose: a marker committed alongside the log travels
back with the checkout it is meant to detect. It stores no memory content —
only how far this machine has looked — so it is an observation about
history, not a second source of truth. Delete it and you lose detection,
not data.

Two limits, tested as explicitly as the guarantee: a **fresh clone** has no
mark and cannot detect anything on its first run (it establishes one), and
anyone who can write the repository can delete the file. This catches
accidents and stale restores, not a determined adversary with filesystem
access.

**Semantic versioning.** `SEMANTIC_VERSION` (currently 1) covers every rule
that changes DERIVED state — supersession, tier order, conflict resolution,
interval comparison, what counts as retired. A watermark taken under
different semantics is not compared: doing so would report a rules change
as a rollback and hide a real one in the noise. Not a migration engine;
nothing is rewritten, because old entries were correct under the rules of
their day.

**The model was an unconstrained writer.** The digest is the ONE place a
model writes claims into the log, and it had no ceiling: `authority` was
whatever the model emitted. That composes with injection — text inside a
captured transcript steers what the digest produces — so a sentence in
someone else's document could mint a `user`-tier claim and overrule
everything. `CHEAP_MEM_MAX_AUTHORITY` is now enforced on the WRITE path and
set to `inferred` by `bin/mem-digest`. Enforced rather than requested,
because an instruction is a request and the process being constrained is
precisely the one that may have been told otherwise. A demotion is
recorded in `authority_clamped_from`, never silent. The ceiling only ever
lowers: an unstamped write stays unstamped, since stamping it would raise
an entry of genuinely unknown provenance.

### Unsolved, explicitly

- **Ranking eviction.** A short claim containing the query terms outranks
  fifty genuine ones on BM25 length normalisation alone (measured; no term
  stuffing needed). Authority tiering only helps where the claims
  *conflict*, and detecting that is open (§5). Anyone who may write may
  still influence what is retrieved.
- **Near-duplicate flooding.** Byte-identical bodies collapse. Vary one
  word and the flood is back. Every similarity threshold is uncalibratable
  — the same objection that ruled out numeric confidence — so nothing is
  built here rather than something that would need a magic number.
- **Contradiction detection** (§5).
- **Identity.** Everything above rests on fields anyone with repo write
  access can set.

---

## 9. Invariants, and where each is verified

| | invariant | verified by |
|---|---|---|
| I1 | append-only; nothing is overwritten | `test/authority.test.mjs` |
| I2/I8 | replaying a log yields identical state | `test/properties.test.mjs` |
| I3 | no unauthorised supersession | `test/authority.test.mjs`, `bench/redteam.mjs` |
| I4/I5 | scope is a boundary, not a parameter | `test/retrieval.test.mjs` |
| I6 | temporal semantics are stated and tested | `test/retrieval.test.mjs` |
| I7 | disputed claims do not reach a context | `test/authority.test.mjs` |
| **I9a** | index: documents, docFreq, lexicon, avgLength **exact** | `test/properties.test.mjs` |
| **I9b** | index: learned graphs **approximate**, declared via `graphsStale` | `test/properties.test.mjs` |
| **I9c** | a fresh load removes the drift | `test/properties.test.mjs` |
| I10 | merge safety | `test/environment.test.mjs`, `bench/merge-driver.mjs` |
| I11 | secret patterns survive Unicode variants | `test/redaction-unicode.test.mjs` |
| I12 | rollback detection | `test/epoch.test.mjs` |
| I16 | semantic version guards derived-state comparison | `test/epoch.test.mjs` |
| I17 | a model cannot write above its ceiling | `test/write-ceiling.test.mjs` |
| I13 | resource bounds | `test/retrieval.test.mjs` |
| I14 | structured retrieval | `test/retrieval.test.mjs` |

I9 as originally stated — "rebuild == incremental" — is **false**, and
correctly so: `appendToIndex` does not extend the learned co-occurrence
graphs, because recomputing them means walking the whole corpus. A pair can
even drop out as the corpus grows (three learned pairs at 60 documents, two
at 71), so ranking differs, top-1 included. Split into three invariants
that are each true.


---

## 10. Are these guarantees enforced, or only written down?

Answered by breaking each mechanism on purpose and checking that a test
notices (`node bench/mutation.mjs`). A mutant that SURVIVES marks a
guarantee that lives in documentation and nowhere else.

**16 mutants, 16 caught.** Including: supersession always allowed,
`admits()` always true, the disputed filter removed, deduplication removed,
resource limits ignored, the redaction class narrowed back to ASCII, broken
lines silently skipped again, cycles never reported, the merge driver
always OK, `docFreq` not updated on append, `replaces_id` ignored entirely,
rollback never reported, the watermark allowed to move backwards, semantics
compared across a bump, the write ceiling ignored, and `clampTier` refusing
to lower.

It found a real one on the first run: the resource-limit test used 120
IDENTICAL claims, which deduplication collapsed into a single result, so
the assertion held whether or not the cap existed. It read like proof and
was worth nothing.

`node bench/fuzz.mjs` throws malformed and hostile input at every parser —
redaction, capability, temporal intervals, authority, the replacement
graph, dedup normalisation, and retrieval with a bogus capability. Looking
specifically for the failure that matters here: garbage producing a MORE
permissive answer rather than an error. Currently clean, and verified to
have teeth by breaking the capability boundary and confirming it fires.
