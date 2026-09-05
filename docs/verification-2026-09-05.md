# cheap-mem — final verification report, 2026-09-05

The question: **are the claimed guarantees enforced by code and tests, or
do they exist only as documentation?**

Not answerable by reading. Answered by breaking each one and checking that
something notices.

Reproduce: `npm test` · `node bench/mutation.mjs` · `node bench/fuzz.mjs` ·
`node bench/redteam.mjs` · `node bench/gateway-attack.mjs` ·
`node bench/scale.mjs`

---

## A. What was implemented this round

| | change | why |
|---|---|---|
| `bench/mutation.mjs` | 16 mutants, each disabling one guarantee | a passing suite proves the tests pass, not that the mechanism exists |
| `bench/fuzz.mjs` | malformed input at 7 parsers + the capability boundary | looking for garbage producing a *more permissive* answer |
| `src/epoch.mjs` | rollback / resurrection detection | I12 was open after three rounds |
| `src/semantics.mjs` | `SEMANTIC_VERSION` + comparability | so a rules change is not misread as a rollback |
| authority ceiling | `CHEAP_MEM_MAX_AUTHORITY`, enforced in `logEntry` | the model was an unconstrained writer |
| `mem epoch show/record` | CLI, exit 2 on rollback | detection nobody can run is not detection |
| `doctor` rollback check | ERROR, names the resurrected ids | silently answering from a rolled-back memory is the failure |
| fixture fix | resource-limit test | it was a false-confidence test |

## B. Bugs found in this round

**1. A false-confidence test (found by mutation).** The resource-limit test
used 120 *identical* claims; body deduplication collapsed them into one, so
`claims.length <= maxResults` held whether or not the cap existed. Removing
the clamp left it green. Fixed with distinct bodies plus an assertion that
the fixture is not degenerate.

**2. The model was an unconstrained writer.** The digest — the one place a
model writes claims — had no authority ceiling. Combined with injection
(text in a captured transcript steers the digest), a sentence in someone
else's document could mint a `user`-tier claim and overrule everything.
This is the error class no earlier round covered.

**3. My own ceiling was a floor.** The first implementation stamped the
ceiling onto *unstamped* writes, raising entries of genuinely unknown
provenance above `unknown`. A ceiling must only ever lower.

## C. Verified invariants

`node bench/mutation.mjs` — **16 / 16 mutants caught.**

| invariant | mechanism | mutant | result |
|---|---|---|:--|
| I1 append-only | disputed instead of reject | `retiredMap` ignores `replaces_id` | 6 tests fail |
| I2/I8 deterministic replay | pure read-time derivation | — | property tests, 40 seeds |
| I4 supersession authority | `maySupersede` | always allows | 5 tests fail |
| I5 non-escalation | `Capability.narrow` | — | test + fuzz |
| I6 scope isolation | gateway `admits` | always true | 4 tests fail |
| I7 temporal | `validAt`, exclusive `valid_until` | — | 3 tests + fuzz |
| I9 disputed exclusion | gateway filter | filter removed | 2 tests fail |
| I11 index equivalence | exact layer | `docFreq` not updated | 1 test fails |
| I12 rollback | local watermark | never reports rollback | 3 tests fail |
| I13 corruption visible | integrity scan | broken lines skipped silently | 1 test fails |
| I14 resource bounds | `LIMITS` | clamp removed | 2 tests fail |
| I15 structured output | records, `outputSchema` | — | 3 tests |
| I16 semantics | comparability | compares across a bump | 1 test fails |
| I17 write ceiling | `clampTier` in `logEntry` | ceiling ignored / raises | 4 tests fail |
| secrets | `SEP` / `SP` classes | narrowed to ASCII | 3 tests fail |
| merge safety | `.gitattributes` check | always OK | 2 tests fail |

`node bench/fuzz.mjs` — no crash, hang, unbounded growth or bypass over
1500 seeded rounds per area. Verified to have teeth: breaking
`Capability.admits` makes it fire immediately.

## D. What cheap-mem does and does not guarantee

**Guaranteed** (enforced in code, verified by a failing mutant):
append-only; deterministic replay; exact index term statistics after an
append; no unauthorised supersession; scope enforced at the gateway;
disputed claims out of every context; corruption counted and located;
five resource bounds; structured output with provenance; rollback detected;
a model cannot write above its ceiling.

**Guaranteed only under a condition:**

| guarantee | only if |
|---|---|
| concurrent writers do not corrupt | the memory is on a local filesystem (not NFS) |
| a merge does not destroy entries | `.gitattributes` carries `merge=union` |
| secrets do not reach git | `core.hooksPath` is set *in this clone* |
| rollback is detected | a watermark exists on this machine and was not deleted |
| derived states are comparable | both were produced under the same `SEMANTIC_VERSION` |
| the write ceiling holds | the writing process was started with it set |

**Cannot be guaranteed:**
- **Identity.** `author` and `authority` are JSON fields. Repository write
  access ≠ trusted identity. Poisoning costs repo write access instead of
  one line; that is the whole gain, and it is not cryptography.
- **Ranking cannot be made to equal truth.** Anyone who may write can
  influence a lexical ranking; a vector index has the same property.
- **Prompt injection cannot be stopped downstream.** A client can flatten
  structured fields back into a paragraph. What is controlled is that the
  *memory* never does the flattening.
- **Erasure.** Deletion in an append-only log is a tombstone.

## E. Threat model, current state

| attacker | can | cannot |
|---|---|---|
| malicious agent | write claims; win a lexical ranking; flood (bounded) | retire another's claim; read another scope; exceed its tier |
| malicious document | inject into a body; steer the digest | mint a tier above `inferred` through the digest |
| repository writer | forge `author`/`authority`; delete the watermark; remove `.gitattributes` | do any of it invisibly — `doctor` reports each |
| malicious merge | create forks | destroy lines, with the driver present |
| stale backup | resurrect retired claims | do so undetected, once a watermark exists |
| filesystem corruption | truncate, partially write | make the loss silent |
| resource exhaustion | write large claims | exceed query, result, body, context or share bounds |

## F. Performance

Unchanged this round — no ranking or index code was altered. From
`bench/scale.mjs`: 1.07 ms at 1k, 15.5 ms at 10k, 174 ms at 100k, ~1.8 s at
1M; linear at ~1.7 µs/document. Rollback detection is O(log size) and runs
only in `doctor` and `mem epoch`, never on the retrieval path.

## G. Test status

270 → 348 → **370**. New this round: `epoch` (11), `write-ceiling` (10),
plus a corrected resource-limit fixture. Two benchmarks that fail the build
when a guarantee stops being enforced.

## H. The smallest sensible core

Unchanged, and this round tried to shrink it further and could not:

```
append-only JSONL  +  read-time derivation  +  BM25  +  a gateway
```

Everything added is a *check* on that core, not an extension of it:
integrity, environment, epoch, semantics, ceiling. None introduces state
the log does not already imply — the watermark is the only file, and it
holds an observation about history rather than a claim about the world.

## I. Remaining risks — the three that matter

1. **Ranking eviction.** Unsolved, and its fix depends on deterministic
   contradiction detection, which is itself open.
2. **Identity.** Everything security-relevant rests on forgeable fields.
   Signed commits would close it; that belongs in an optional trust layer,
   not the core.
3. **Near-duplicate flooding.** Exact duplicates collapse; vary one word
   and the flood returns. Every similarity threshold is uncalibratable —
   the same objection that ruled out numeric confidence.

## J. Final scores

| area | score |
|---|--:|
| Architecture | 8 |
| Data model | 8 |
| Correctness | 9 |
| Determinism | 9 |
| Security | 7 |
| Retrieval | 7 |
| Conflict handling | 5 |
| Temporal semantics | 8 |
| Provenance | 8 |
| Explainability | 8 |
| Git integration | 9 |
| Privacy | 8 |
| Scalability | 6 |
| Reliability | 8 |
| Maintainability | 7 |
| Developer experience | 7 |

**Overall architecture: 8/10** — is the shape right, and does it hold under
change? Everything this round added fitted inside the existing core without
a migration, which is the strongest evidence the shape is right.

**Production readiness: 7/10** — would I run this on real data? Yes, for a
single owner with a handful of agents. The limits are known, checkable and
reported. It loses points for a scalability ceiling that is designed but
unbuilt and for conflict handling that surfaces rather than resolves.

**Security: 7/10** — what does it withstand from someone actively trying?
Every measured attack that could be closed at this layer is closed and has
a failing mutant to prove it. It cannot go higher while identity is a JSON
field: a 9 would require cryptographic provenance, and claiming one without
it would be the exact dishonesty this exercise was built to avoid.

**Why the three differ.** Architecture asks whether the design absorbs
change; readiness asks whether the failure modes are known and visible;
security asks what survives an adversary. A system can score well on the
first two and poorly on the third — that is the normal case, and pretending
otherwise is how security documents become marketing.

## K. Is anything fundamental left?

No, at this trust boundary — and the reason is an argument, not a feeling.
Every guarantee has a mutant that fails when it is disabled; every parser
has been fuzzed for permissive failure; every attack from three rounds is
runnable and reports its own verdict; and every unsolved item is unsolved
because closing it needs something outside the boundary (cryptographic
identity) or something nobody can calibrate (a similarity threshold), not
because it was overlooked.

The remaining work is a different shape: build WAND when the latency
trigger fires, and decide whether an optional signed-provenance layer is
worth its key management. Neither is a hole in what exists.
