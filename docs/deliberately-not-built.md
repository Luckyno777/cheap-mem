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

**Measured, 2026-09-08.** The rate is **1.8 %** — 8 suspect pairs among
902 digested entries on a real corpus (`bench/duplicate-rate.mjs`,
Jaccard ≥ 0.6 over title and text, no model). And the residue is not
what the objection assumes: most pairs are the SAME entry filed both
globally and under a project. That is a scoping question, not a digest
failing to consolidate.

A first run reported 5.6 %. It was counting alias records — four
legitimate topic mappings that share one justification text. Excluding
mappings (they are relations, not findings) brought it to 1.8 %. The
raw number would have blamed the digest for something that is not a
fault; the tool now excludes them and says so.

**What would change our mind:** a rate high enough that the digest is
demonstrably not consolidating. 1.8 %, dominated by double-filing, is
not it. Re-run the bench on your own corpus before believing this
number — it is one memory.

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

---

## Entity resolution / an alias table

**Proposed:** merge spelling variants of the same thing, so that a
memory fragmented across several spellings retrieves as one. Justified
by a real observation: of 845 distinct tag values, 56 % are used
exactly once.

**Why not.** The premise was measured before anything was built, and it
does not hold. Under two independent normalisations — suffix stripping,
and word-set regardless of order inside a compound — the share of
values that are actually spelling variants is:

| Field | distinct values | used once | spelling variants |
|---|---|---|---|
| tags | 845 | 56 % | 24 / 20 → 3 % / 2 % |
| class | 185 | 74 % | 1 / 0 → 1 % / 0 % |

The groups that do exist are `hook/hooks`, `test/tests`,
`tool/tools`, `release/releases`. The single-use values are not typos
but different words: *metrics, noise, statistics, optimisation,
diversity, provenance, authority, ergonomics*.

Nobody types the same word differently. Everyone picks a different
word. The dispersion sits in the vocabulary, not in the spelling — an
alias table would have collected about 2.5 % of it and created a table
to maintain. On the class field it would have changed nothing at all.

That also answers the question that always follows, "who maintains the
aliases": nobody, because there are none.

It is the same answer as the closed class vocabulary, from the other
side: against a sprawling vocabulary a closed list helps and a synonym
table does not.

**What would change our mind:** the share of spelling variants rising
above 15 %. `bench/name-dispersion.mjs` measures it, and a test fails
once it does — so the decision gets retaken rather than quietly carried
forward.

---

## Two measurement cuts for "a field nothing writes"

**Proposed:** find guards that read a field no write path ever sets, by
comparing what the code reads against what gets written.

**Why not** — for these two cuts specifically. The defect is real and
the instrument is built; these two ways of measuring it were tried
first and thrown away, and saying so is part of the instrument.

*"Read in code, never written in code"* gave 222 candidates, nearly all
of them file extensions and standard-library properties.

*"Read in code, absent from the corpus"* gave 714 of 727, for the same
reason: most fields a program reads are not corpus fields at all.

What makes the third cut work is not a better pattern but a narrower
question — a field a **decision** depends on, intersected with fields
the corpus actually knows. On a live corpus that is a few hundred down
to eleven, and a person can read eleven.

**What would change our mind:** nothing for these two. A field the
corpus has never seen is reported separately and is explicitly not a
finding.

---

Entries here that concern both this project and the one it was
extracted from also live in `shared/invariants.jsonl` under
`art: "discarded"`, so the other side does not rebuild them either.
See `docs/invariants.md`.

---

## A guard comparing each command's help flags to the flags it accepts

**Proposed:** after `test/help-covers-cli.test.mjs` tied the command
list to the help, do the same one level down — every `--flag` a
command's own `--help` prints must be one `checkFlags` accepts. A flag
the help promises and the CLI rejects is a lie the reader hits on their
first try.

**Why not.** Measured on 2026-09-17, across all sixty commands then in
the table. The naive reading reported nine commands with a mismatch:

```
facts: value, valid, source     find: valid        init: strict
links: from, to, kind, why      procedures: title, rule, issued-by, …
questions: with                 raw: set, list-stores, remove, into
show: brief                     topics: topic, title
```

Then each one was driven against the real binary, and read in context.
**All nine are cross-references to other commands**, not promises:

| line in the help | the flag really belongs to |
|---|---|
| ``show``: "`find --brief` returns compact hits" | `find` |
| ``topics``: "e.g. `mem log decision --topic … --title …`" | `log` |
| ``questions``: "`mem answer <id> --with <entry-id>`" | `answer` |
| ``links``: "`mem log link --from … --kind causes`" | `log` |
| ``raw``: "`mem raw archive [--set <path>]`" | the `raw archive` subcommand |

Zero real defects. A guard shipped on that reading starts life with nine
false alarms, and a check that cries wolf on day one is switched off
inside a week — this repository has that written down as
`guard-checks-the-wrong-thing`, and building a fresh instance of it to
catch nothing would be a poor trade.

The help's prose does not mark which flags an example belongs to, and
teaching it to would mean restructuring every command's help around a
machine-readable shape. That is a bigger change than the defect it
prevents, and the defect is currently zero.

**What would change our mind.** A real occurrence: a command whose help
advertises a flag *of its own* that `checkFlags` rejects. One such bug in
the wild pays for the restructuring — the count is the argument, and
right now the count is nought. The cheap first step then is not the
guard but the shape: a per-command `FLAGS` list that both `checkFlags`
and the help text are generated from, after which the comparison is
trivial and cannot produce a false positive at all.
