# cheap-mem — final scorecard, 2026-09-05

Three rounds: two of analysis, one of implementation. This is the honest
reading afterwards. Where something is unsolved it is scored as unsolved;
where a guarantee stops, the score says where.

Everything is reproducible: `npm test` (348), `node bench/redteam.mjs`,
`bench/gateway-attack.mjs`, `bench/selectivity.mjs`, `bench/scale.mjs`,
`bench/merge-driver.mjs`, `bench/overlooked.mjs`.

---

## Scores

| area | score | why |
|---|--:|---|
| Architecture | 8/10 | Append-only with read-time resolution is the right core and every change fitted inside it without a migration. Costs a point for the two layers a caller must know apart (`search` ranks, `retrieve` bounds) and one for a design whose primitive was only named in round two. |
| Correctness | 8/10 | Replay determinism, order independence, tie-breaking and index equivalence are property-tested over seeded random logs. Two real bugs came out of writing those tests. Not 9: I9 needed splitting into three because the original was false, and the only reason that was found is that a test was given teeth after passing vacuously. |
| Security | 6/10 | Supersession is authorised, scope is a boundary at the gateway, secrets survive fourteen Unicode variants, disputed claims cannot reach a context, floods collapse. But **ranking eviction still works**, **rollback resurrection is undetected**, and everything rests on fields anyone with repo write access can forge. Six is what "several real holes closed, two named ones open" is worth. |
| Retrieval | 7/10 | Deterministic, no model, milliseconds, and now structured with provenance. Loses points for the linear scan (WAND designed, not built) and for having no semantic recall: a paraphrase with no shared vocabulary is not found, and the thesaurus only softens that. |
| Scalability | 6/10 | Measured, not guessed: 1.07 ms at 1k, 15.5 ms at 10k, 174 ms at 100k, ~1.8 s at 1M. Linear at ~1.7 µs/document. Bands and numeric triggers are defined; none of the work past the first band is built. Adequate for years at ~48 entries/day, and that is exactly what a 6 means. |
| Reliability | 8/10 | Concurrent appends intact at 60 kB lines from four processes; a destroyed index cache recovers; a truncated line is skipped **and counted**; merges are safe with the driver, which `init` now writes. Not 9 because a crash mid-rebuild is reasoned about but not simulated. |
| Explainability | 8/10 | `mem explain` answers the question nothing else does — why a NAMED claim did *not* come back — deterministically, with no model and nothing computed the ranker did not compute anyway. Short of full because scoring internals are not yet broken out per term. |
| Developer experience | 7/10 | One binary, no service, no key, readable errors, and `doctor` now says which layer owns each guarantee. Costs points for a CLI grown to ~2,300 lines and for two retrieval entry points where one would be simpler to explain. |
| Git friendliness | 9/10 | Text on disk, `git log` is the audit trail, `merge=union` shipped by default, byte-identical lines dedupe on merge. Not 10 only because the guarantee still lives in a file that can be deleted — now at least checked. |
| Privacy | 8/10 | Local-first, no network, no key, redaction before disk with a canary and a pre-commit hook. Not higher: deletion in an append-only log is a tombstone, not an erasure, and the hook is a local setting a clone does not inherit. |
| Maintainability | 7/10 | Every invariant maps to a test, comments carry the measurement that caused them, benchmarks are in the repo. Held back by module count growth in one day and by `bin/mem` being long enough to hide things. |
| **Overall** | **7/10** | A memory whose guarantees are now mostly checkable rather than assumed — with two named holes still open and one performance ceiling designed but unbuilt. |

---

## What changed, in one list

| | before | after |
|---|---|---|
| secret with `＝` | reached disk and passed the hook | redacted; 14 Unicode variants tested |
| broken line | skipped silently | counted, located, `doctor` reports |
| replacement graph | unchecked, no depth cap | cycles, forks, dangling refs, depth |
| `mem init` | no merge driver, no hook | writes the driver; names the hook step |
| environment guarantees | unstated, unverified | checked, layer named, `--strict` for CI |
| supersession | any writer, any claim | same author or higher tier; else disputed |
| scope | optional parameter | capability at the gateway; fails closed |
| retrieval output | text | structured claims with provenance |
| limits | unbounded | five bounds, all with numbers |
| "why not returned?" | unanswerable | `mem explain` |
| tests | 270 | 348 |

---

## Still open, and why each is not "just do it"

**Ranking eviction.** A short claim containing the query terms outranks
fifty genuine ones on BM25 length normalisation alone — measured before and
after the gateway. Authority tiering only decides where claims *conflict*,
and deterministic conflict detection is the open problem underneath. Not
fixable by "harder ranking": anyone who may write may influence a lexical
ranking, and a vector index has the same property.

**Rollback / resurrection (I12).** Restoring an old checkout makes a
superseded claim current again and nothing notices. A monotonic epoch or
signed checkpoint would detect it — and would add a second source of truth
to a design whose entire strength is having one. Choosing badly here is
worse than waiting.

**Contradiction detection.** "uses PostgreSQL" versus "uses SQLite" is
obvious to a person and invisible to BM25. Three approaches exist (topic +
interval + scope heuristics; an explicit `contradicts` field an attacker
simply omits; detection in the digest, where a model call already happens).
The third looks right and is not built.

**WAND.** Designed with the exhaustive scan kept as its oracle; not
implemented. Its trigger is a number — p50 above 25 ms — which is about two
years out at the observed growth rate.

**Identity.** Everything above rests on `author` and `authority` being
honest. This raised poisoning from one line to repository write access. It
is not cryptography and is never described as such.

---

## The three things this exercise actually taught

**A measurement is only as good as the environment it was taken in.** Two
round-one findings were wrong because I measured a property in a setup
stripped of the thing that provides it: a git merge in a repo without
`.gitattributes`, and a "future timestamp attack" against a recency clamp
that already existed. Same shape both times.

**A passing test can be worth nothing.** The index-equivalence test
appended 37% new material, past the threshold where the code deliberately
does a full rebuild — so it compared a full build against a full build,
passed, and proved nothing. It only became useful once it asserted that the
path under test had actually run. With teeth it failed immediately, and the
invariant it was testing turned out to be false as stated.

**The deepest finding was not a bug but a category.** Correctness here
rested on three properties living outside the codebase — filesystem
atomicity, one line in `.gitattributes`, a local git config — each
invisible when present, silent when absent, verified by nothing. Every
API-level hole found in round one was the same disease one floor up: scope,
authority and provenance were also assumed rather than enforced. Naming the
category was worth more than any individual fix, because it says where to
look next.
