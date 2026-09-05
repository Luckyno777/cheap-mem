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
| **T1/T2** | read another scope | refused at the gateway | excluded-with-reason | capability | `search()` is still open by design |
| **T3 malicious document** | injection in a body | returned as a labelled record | — | structured retrieval | a client may re-flatten |
| **T3** | secret in a body | redacted before disk | canary, hook | 7 separator + 7 space look-alikes | an unknown shape |
| **T5 malicious merge** | conflict destroys lines | prevented | `env/merge-driver` | `merge=union` | driver must be present |
| **T7 corruption** | truncated line | skipped **and counted** | `doctor` integrity | — | the entry is gone |
| **T6 stale backup** | restore resurrects retired state | **undetected** | — | **unsolved** | see below |

### Unsolved, explicitly

- **Ranking eviction.** A short claim containing the query terms outranks
  fifty genuine ones on BM25 length normalisation alone (measured; no term
  stuffing needed). Authority tiering only helps where the claims
  *conflict*, and detecting that is open (§5). Anyone who may write may
  still influence what is retrieved.
- **Rollback / resurrection (I12).** Restoring an old checkout or backup
  makes a superseded claim current again, and nothing notices. A monotonic
  epoch or trusted checkpoint would detect it; neither is built, and
  choosing one badly would add a second source of truth to a design whose
  whole strength is having one.
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
| I12 | rollback detection | **not built** |
| I13 | resource bounds | `test/retrieval.test.mjs` |
| I14 | structured retrieval | `test/retrieval.test.mjs` |

I9 as originally stated — "rebuild == incremental" — is **false**, and
correctly so: `appendToIndex` does not extend the learned co-occurrence
graphs, because recomputing them means walking the whole corpus. A pair can
even drop out as the corpus grows (three learned pairs at 60 documents, two
at 71), so ranking differs, top-1 included. Split into three invariants
that are each true.
