# cheap-mem — state, retrieval, and the line between them

Post-closure round, 2026-09-05. The question: **does the log decide what is
true, with retrieval deciding only what we see?**

**Answer: yes, now.** It did not when this round began.

Reproduce: `npm test` (392) · `bench/mutation.mjs` (48/48) ·
`bench/query-independence.mjs` · `bench/cache-attack.mjs` ·
`bench/composed.mjs` · `bench/byzantine.mjs` · `bench/fuzz.mjs`

---

## 1. The four fundamental failures, and the one assumption behind them

| | failure | wrong architectural assumption |
|---|---|---|
| 1 | status recomputed from the retrieval HITS | "a subset of the log is enough to derive state" |
| 2 | candidacy decided by volume | "policy applied after ranking can protect integrity" |
| 3 | an answer returned without saying it was contested | "returning everything is the same as being honest" |
| 4 | status read from the index cache | "a correct value in a cache is as good as one from the log" |

Not four unrelated bugs. **One assumption in four costumes: that something
other than the whole log may decide what the log means.**

Why earlier tests missed all four: every fixture let the target and the
line retiring it share query words; every quota test ran on a corpus where
the quota was not the binding constraint; every cache test checked that a
*corrupt* cache recovers, never that a *plausible* one lies. Mechanism
mutants could not find them either — every mechanism was present and ran.
It took **architectural mutants**: state from a subset, state from the
cache, scope after assembly, conflict from raw hits.

---

## 2. The invariant

> **`state(log)` takes no query. Retrieval selects from state; it never
> produces it.**

Carried by two signature decisions rather than by discipline:

- `deriveState(root)` takes a **root**, not entries — no caller can hand it
  a subset, which is exactly how failure 1 happened.
- It takes **no query** — relevance cannot reach semantics by accident.

Verified by: `test/state.test.mjs` (query independence over six queries
hitting disjoint subsets), `bench/query-independence.mjs`, and four
architectural mutants that all fail tests when applied.

---

## 3. Layer matrix

| layer | may derive state | may enforce security | may rank | may present |
|---|:--:|:--:|:--:|:--:|
| log (JSONL) | source of truth | — | — | — |
| `state.mjs` | **yes, only here** | authorises supersession | — | — |
| `integrity.mjs` | reports, never decides | — | — | — |
| index / cache | **no** | **no** | yes | — |
| `search.mjs` | **no** | **no** | yes | — |
| gateway (`retrieval.mjs`) | no — consumes | scope, tier, limits | orders | — |
| CLI / MCP | no | no | no | yes |

The two cells that were wrong before this round: *index → may derive state*
(failure 4) and *gateway → may derive state* (failure 1). Both are now no.

---

## 4. Every cache, and what it may decide

| cache | contains | correctness-critical | security-critical | rebuildable | authoritative |
|---|---|:--:|:--:|:--:|:--:|
| `.mem/search-index.json` | documents, term stats, learned graphs | for *what is found* | **no** (since this round) | yes, from the log | **no** |
| learned tag/term graphs | co-occurrence | no — ranking only | no | yes | no |
| `.mem/epoch.json` | high-water mark | no | **detection only** | no — it *is* the observation | no |
| thesaurus user groups | synonyms | no | no | yes | no |

`.mem/epoch.json` is the subtle one: it is not a cache of the log but a
record of *what this machine has seen*. It cannot be rebuilt, because
rebuilding it from the current log is precisely the operation a rollback
performs. It decides nothing about truth — only whether to raise an alarm.

---

## 5. Composed attacks — `bench/composed.mjs`

Every fundamental bug here was a composition failure, so these combine
mechanisms rather than testing them. All seven held:

1. low authority + high relevance + flooding → the user claim is present
2. valid replacement + tampered index + selective query → the superseded claim stays out
3. scope boundary + global claim + conflict → global inherited, sibling refused
4. rollback + new claims on top → detected and named
5. exact + near duplicates + rotating authors → 0/40 identical bodies kept, the genuine claim present
6. injection + digest ceiling + provenance → model demoted `user`→`inferred`, recorded, claim disputed
7. git merge + replacement fork + resolution → one supersession from two branches, fork reported, both corrections returned, no winner picked

Attack 4 is worth reading twice. After a rollback the log *genuinely* says
the resurrected claim is active — and it is right, for that log. That is
why detection cannot be a state field: it is a statement about history, not
about the log, and it must live somewhere the log cannot revert.

---

## 6. Retrieval quality vs. integrity

Three separate properties, and the formal rule between them:

    Semantic Integrity      the state derived from the log is correct
    Retrieval Completeness  everything relevant is reachable
    Retrieval Relevance     the most useful ranks highest

> **Integrity must never be a function of completeness or relevance.**
> Poor retrieval may hide a true claim. It must never make a false one true,
> nor a retired one active.

That is exactly what failures 1 and 4 violated, and what query independence
now enforces. Failure 2 was a *completeness* failure with an integrity
consequence — the memory could not produce what it contained — which is why
candidacy is fixed but the flood is still *visible* in the answer. Making
it invisible would be a relevance judgement the memory cannot justify.

---

## 7. Conflict detection: the epistemic boundary

| class | example | who decides |
|---|---|---|
| deterministic | identical bodies; explicit `replaces_id`; overlapping validity, same scope, same topic, different authors | the core, now |
| model-detectable | "runs in Frankfurt" vs. "runs in Berlin"; "moved to Frankfurt in 2025" vs. "runs in Berlin" | a model may PROPOSE, as a claim of its own at `inferred` |
| human-reviewable | "primary server in Frankfurt" vs. "server in Berlin" — different subjects or not? | a person |
| undecidable | "currently in Frankfurt" vs. "migrated to Berlin yesterday", with no timestamps | nobody, from the text alone |

A model may never write `true`. It may write a `PotentialConflict` claim,
at its own tier, subject to the same ceiling and the same authorisation as
any other claim — at which point the deterministic core decides what
follows. Nothing in this pipeline is built yet, and the boundary above is
what would govern it.

---

## 8. Provenance: three words that must not be confused

| | means | cheap-mem |
|---|---|---|
| **Declared** provenance | the claim *says* where it came from | yes — `source`, `evidence` |
| **Verified** provenance | the system can check the claim came from there | **no** |
| **Cryptographic** provenance | the origin is unforgeable without a key | **no** |

`source: "official-doc.md"` is a **claim about provenance**, not
provenance. Anyone who can write a claim can write its source. This is
stated here because the previous round's documentation used "provenance"
for all three.

---

## 9. Rollback: exactly what is and is not detectable

| scenario | detected | why |
|---|:--:|---|
| repo rolled back, marker preserved | **yes** | the retired set shrank |
| repo rolled back, new claims written on top | **yes** | the retired set still shrank |
| repo rolled back, marker deleted | **no** | nothing to compare against; reports `first` |
| repo and marker rolled back together | **no** | both sides of the comparison moved |
| repo and marker copied to a new machine | **no** | consistent pair, no history to contradict |
| fresh clone | **no** | establishes the mark instead |

Everything in the "no" column has the same cause: the marker is local,
unsigned and deletable. That is not security theatre only because it is
written down here rather than implied. It catches accidents and stale
restores — not an adversary with filesystem access.

---

## 10. Decisions taken this round

**Signed provenance — NO, not in the core.** It would close the last
structural weakness (identity), and it would put key management into a
system whose entire proposition is "no service, no key, no network". The
threat it addresses is an attacker with repository write access, who can
also delete the epoch marker and rewrite `.gitattributes`. Signing only
helps once someone *verifies* signatures, which needs a trusted key list,
which needs distribution. **Correct shape: an optional trust layer that
verifies git commit signatures already present** — no new PKI, no core
change. Not built, because nobody here has that threat model yet.

**Near-duplicates — NO.** Exact bodies collapse (NFC, CRLF→LF, whitespace;
no case folding). SimHash, MinHash and shingles all need a distance
threshold, and an uncalibratable threshold is exactly what ruled out
numeric confidence. A wrong merge is invisible; a visible duplicate is not.
Composed attack 5 shows the cost honestly: near duplicates survive.

**WAND — NO, not yet, and now for a second reason.** Its trigger (p50 >
25 ms) is unchanged, but this round added one: state derivation is 174 ms
at 100k, which now dominates a 174 ms search. Optimising the ranker while
the semantic layer costs the same would be optimising the wrong half. When
the trigger fires, the first question is whether state derivation can be
made incremental *without* letting a cache decide meaning again.

---

## 11. Remaining risks, classified

| risk | class |
|---|---|
| semantic contradiction undecidable without a world model | **FUNDAMENTAL / epistemic** |
| identity is a JSON field | **OUTSIDE TRUST BOUNDARY** |
| a rule-abiding writer can fill the context with plausible falsehoods | **QUALITY**, with a stated integrity floor (§6) |
| rollback undetectable when marker and repo move together | **OUTSIDE TRUST BOUNDARY** |
| near-duplicate flooding | **QUALITY** (deliberate, §10) |
| state derivation is O(log) per query | **PERFORMANCE** |
| linear search | **PERFORMANCE** |
| no semantic recall | **PRODUCT** |
| the epoch marker is per machine | **OPERATIONS** |

Nothing here is labelled SECURITY, and that is deliberate: every issue that
*was* a security issue this round is now closed and has a failing mutant
proving it.

---

## 12. Final trust boundary

| property | what cheap-mem guarantees | under what condition |
|---|---|---|
| Append-only | nothing is ever overwritten or deleted | always |
| State correctness | status derived from the whole log, no query, no cache | always |
| Scope isolation | the gateway admits only what a capability names | callers use `retrieve`, not `search` |
| Authority | supersession requires same author or higher tier | fields are honest |
| Conflict | flags overlapping same-tier claims; resolves only what is mechanical | — |
| Temporal validity | `valid_from` inclusive, `valid_until` exclusive, as-of queries | timestamps are honest |
| Retrieval | every tier that matches is represented; relevance orders | — |
| Provenance | declared and carried with every claim | **declared only, never verified** |
| Identity | **nothing** | repo write access ≠ trusted identity |
| Rollback | resurrection detected and named | a marker exists and was not rolled back with the repo |
| Integrity | no cache or query can change meaning | always |
| Availability | bounded query, result, body, context, author share | — |
| Privacy | local, no network, redaction before disk | the pre-commit hook is installed *in this clone* |

---

## 13. The answer

> **Yes.** The log determines the state of the memory, and retrieval
> determines only which part of that state we see.

Proven by, not asserted from:

- **Architecture** — `deriveState(root)` cannot be given a subset or a
  query; the layer matrix in §3 has no cell where a cache may decide state.
- **Invariants** — query independence, cache non-authority, and the
  integrity floor in §6.
- **Property tests** — six queries over disjoint subsets agree on every
  claim's status; retrieval never mutates log or state.
- **Mutation tests** — 48/48, of which seven are architectural. Restoring
  any of the four historical failures makes tests fail.
- **Adversarial tests** — cache tampering in both directions, seven
  composed attacks, the Byzantine writer, fuzzing for permissive failure.

**One fundamental limit remains, and it is epistemic rather than a defect:**
semantic contradiction is undecidable without a world model. The memory
refuses to resolve what it cannot judge, flags it, and returns everything.

**And one honest caveat about this whole exercise.** Four rounds each ended
with "nothing fundamental is open". Three of those were wrong. The fourth
is stated with better evidence than the others — 48 mutants, seven composed
attacks, a query-independence property — but the base rate of that claim in
this project is 1 in 4. Take the evidence; discount the confidence.
