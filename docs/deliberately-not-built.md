# Deliberately not built

Every entry here was proposed, weighed, and turned down — with a reason
that is measurable rather than a matter of taste. It exists because a
"no" without a reason gets proposed again every few months, and the
third time nobody remembers why it was a no.

Each item names **what would change our mind**. A rejection you cannot
argue with is a dogma, and this project has no room for one.

---

## Usage tracking (`times_retrieved`, `last_used`)

**Proposed:** count how often an entry is recalled; rank frequently
recalled entries higher.

**Why not.** Two independent reasons, either sufficient.

*It breaks git as the source of truth.* A retrieval counter is written
where the reading happens. Two clones of the same memory would hold
different numbers, so the same log would rank differently on two
machines — and `git diff` would show either constant churn or nothing at
all, depending on whether the counter is committed. Both are wrong.

*It rewards popularity, not usefulness.* The entry that comes back on
every second query does so because it is broadly worded. The precise
entry that answers one question exactly right is recalled rarely and is
worth more. A usage counter inverts that.

**What we do instead.** `standing()` counts **citations**: how many
other entries lean on this one, through `origin.derived_from` and link
edges. Deliberately written, present in the corpus, identical in every
clone.

**What would change our mind:** a measurement showing that recall
frequency predicts usefulness better than citation count does, on a real
corpus, with usefulness defined before the measurement.

---

## A `confidence` number on entries

**Proposed:** each entry carries `confidence: 0.0–1.0`.

**Why not.** From `src/authority.mjs`, where the same question was
settled for supersession: *"a float nobody can calibrate becomes a
number everybody rounds to 'probably fine', and two 0.7s from different
pipelines are not comparable."*

Confidence answers *how sure was the writer* — unverifiable after the
fact. Authority tiers answer *who asserted this* — checkable against the
log. Only the second can be argued about.

**What we do instead.** Authority tiers, plus `contested` for
falsifiability: a `contradicts` edge flags a claim rather than quietly
weakening it, so it keeps standing in the open with its challenge
attached.

**What would change our mind:** a source of confidence values that is
calibrated and comparable across writers. A model's self-report is not
one.

---

## Memory decay as deletion or archiving

**Proposed:** old, unused entries get deleted, archived, or moved out of
the active set.

**Why not.** It breaks append-only, and with it the provenance chain and
the replay property: the same log plus the same semantic version must
always yield the same state. Delete an entry and every earlier
conclusion that cited it becomes unexplainable. In a git-backed memory
the storage argument is weak anyway — text is cheap, and the index is a
gitignored cache that can be rebuilt.

**Open, and different:** decay as a *ranking* effect — an entry nothing
has cited for a very long time sinking in rank — does not break
anything, because ranking is not truth. That one is on the roadmap for a
later version, and it is a rank factor, not a storage concept.

**What would change our mind about deletion:** a legal or privacy
requirement to remove content. That is a different problem (redaction of
a specific entry, on request, recorded) and would be solved as one.

---

## A graph database (Neo4j, FalkorDB, …)

**Proposed:** store entities and relations in a real graph store, like
Graphiti does.

**Why not.** It breaks four of the ten principles at once: local first,
git as the source of truth, human-readable data, no unnecessary
infrastructure. A memory you cannot `cat`, `grep` and `git diff` is a
different product.

**Measured, 2026-09-08:** the textbook case for an entity graph — one
person under several names — is a non-problem on a real corpus. In 1070
entries `lukas` occurred **once**; 94 % of mentions used one spelling,
projects and machines 99–100 %. Where the corpus really did fragment was
component names (43 %). See `bench/alias-fragmentation.mjs` — run it on
your own memory before believing either answer.

**What would change our mind:** a corpus where traversal answers
questions BM25 plus a thesaurus cannot, measured on the eval set, and
where the cost of the store is smaller than the gain.

---

## An LLM in the ingestion loop (Mem0-style per-fact resolution)

**Proposed:** on every new fact, retrieve similar memories and have a
model decide ADD / UPDATE / DELETE / NOOP.

**Why not.** It breaks token efficiency and model independence — the two
properties that make this thing cheap enough to run on every message.
One model call per fact, forever, is exactly the cost this design
exists to avoid.

**What we do instead.** The digest runs once every few hours, is the
only model call in the memory, and is told to check with `mem find`
before writing (see `DIGEST.md`). Same effect, three orders of magnitude
fewer calls.

**What would change our mind:** a measured duplicate rate high enough
that the digest is demonstrably not consolidating. That measurement is
on the roadmap and has not been run.

---

## Bi-temporality as a second axis

**Proposed:** besides "when was this true", also track "when did we
believe it" — Graphiti's full bi-temporal model.

**Why not.** Not because it is wrong — it is elegant. Because it solves
no problem anyone here has had. `valid_from`/`valid_until` plus
`retrieve({ asOf })` answers what held at a point in time; `git log`
answers what we believed at a point in time, in the rare case it comes
up.

**What would change our mind:** a real question that needs both axes at
once, asked more than once.
