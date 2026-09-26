# cheap-mem compared with Mem0, Graphiti, Engram, Claude-Mem and Obsidian practice

Strategic analysis, 2026-09-08. Occasion: a concept list from GitHub
Copilot with 17 suggestions and the question of how cheap-mem can
become significantly stronger without losing its identity.

**None of this is built.** The report ends with a roadmap, not a
commit.

---

## How honest this report is

Two different kinds of knowledge are mixed into it, and they must not
be confused:

**About cheap-mem** I checked the code, not memory. Every statement in
Part 0 carries a file. Where a number appears, it comes from
`docs/scale.md`, measured with `bench/scale.mjs`.

**About the foreign systems** it is knowledge, not a measurement,
current as of May 2026. I mark, per system, how confident I am:

| System | Confidence | What I treat as established |
|---|---|---|
| Mem0 | high | LLM pipeline extracts facts and decides ADD/UPDATE/DELETE/NOOP against similar memories; vector store, optional graph |
| Graphiti (Zep) | high | Bi-temporal knowledge graph: `t_valid`/`t_invalid` kept separate from ingestion time; edges are **marked invalid** on contradiction, not deleted; search = semantic + BM25 + graph traversal |
| Obsidian practice | high | not a system but a way of working: Markdown vault, wikilinks, backlinks, atomic notes, MOCs, Dataview queries — retrieval is **human**, not automatic |
| Claude-Mem | medium | Plugin for Claude Code, condenses transcripts via hooks and loads them back in at session start |
| Engram | **low** | The name is used by multiple projects. I have no solid picture and won't pretend otherwise. Anyone who needs the comparison must tell me which Engram is meant. |

Where I am uncertain, that is stated. A report that sounds equally
confident everywhere is useless at exactly the point where it matters.

---

## Addendum, on my own account

The first version of this report claimed that `standing()` was used
nowhere and that backlinks had no command. Both were wrong: `mem
experiences` reads `standing()`, and `mem links <id>` shows both
directions. Two paragraphs after the sentence "whoever proposes
without looking at what already exists, proposes what already
exists," I had done exactly that.

The spots are corrected. What remained after the check is sharper
than the wrong version — not "unused," but **not a ranking factor**;
not "no command," but **not offered by the MCP bridge**. The addendum
stays in place, because a report about an append-only memory should
not wipe away its own corrections.

---

## Part 0 — What Copilot's analysis could not have known

Eleven of the seventeen points are built. Several of them in a form
superior to the one proposed, because it grew out of a measured
failure rather than an idea.

| # | Copilot's suggestion | Status | Where |
|---|---|---|---|
| 1 | Structured memory objects | **there** | `id`, `ts`, `author`, `authority`, `type`, `project`, `tags`, `origin`, `replaces_id`, `valid_from/until` — `src/memory.mjs` |
| 2 | Importance / Salience | **solved differently** | `standing()` counts citations instead of importance — `src/memory.mjs:475` |
| 3 | Usage tracking | **considered and rejected**, with the reasoning in the code | `src/memory.mjs:480` |
| 4 | Hybrid retrieval | **there** | BM25 + embeddings via Reciprocal Rank Fusion — `src/hybrid.mjs` |
| 5 | Entity layer | **partial** | exact-identifier lane (paths, versions, ticket numbers) — `src/entity.mjs`; **no** person/project nodes |
| 6 | Relationship system | **there, deliberately small** | `link` type with four fixed edges: `causes`, `generalizes`, `contradicts`, `resolves` — `src/memory.mjs:54` |
| 7 | Episodic vs. semantic | **there** | ten lanes; `event` is episodic, `timeline` semantic-changing, `learning` semantic-stable |
| 8 | Retrieval ranking | **partial** | field weights, freshness bonus (max +15 %, halved after 90 days), authority levels, MMR — `src/search.mjs`, `src/retrieval.mjs` |
| 9 | Temporal facts | **there** | `valid_from`/`valid_until`, `--key` for fact versions — `src/freshness.mjs` |
| 10 | Contradiction detection | **there** | `replaces_id` + authority levels + `contradicts` edge — `src/authority.mjs` |
| 11 | Historical recall | **there** | `retrieve({ asOf })` returns what held true BACK THEN — `src/retrieval.mjs:107` |
| 12 | Atomic memory units | **there** | one JSONL line = one unit, since the first commit |
| 13 | Reconsolidation | **there** | `replaces_id` never replaces, it supersedes; the digester checks first with `mem find` — `DIGEST.md` |
| 14 | Memory decay | **not there** | no hit for archive/decay/forget/prune in the whole source tree |
| 15 | Reinforcement through use | **considered and rejected** | see #3 |
| 16 | Scaling | **measured** | `docs/scale.md`, numbers from `bench/scale.mjs` |
| 17 | Research concepts | open | this report |

This is not a reproach to Copilot — it is evidence for a rule that
stands in `BUILDING.md` and has already held up three times today:
**whoever proposes without looking at what already exists, proposes
what already exists.** The analysis is valuable nonetheless, but its
value lies elsewhere than it itself assumes: not in the eleven built
points, but in the six open ones and in the question of whether the
built solutions are the right ones.

---

## Part 1 — Current strengths

**The guarantees live in the code, not in the docs.** `capability.mjs`
turns the scope into an object a caller must hold, instead of a
parameter it can forget. `state.mjs` enforces "the log decides what's
true; the index only what's quick to find." `authority.mjs` raises the
cost of poisoning from *one line* to *write access to the repo*. Every
one of these rules grew out of a measured hole.

**Retrieval costs no model call.** BM25 over weighted fields, extended
with a curated thesaurus and a tag graph learned from its own stock.
That is the difference from Mem0 and Graphiti, which both need a model
for ingestion *and* resolution: cheap-mem needs exactly one model call
every few hours (the digester), and it can be switched off.

**The stock is readable and versionable.** One line of JSON per
memory, `git log` as proof of provenance, a merge driver for
simultaneous writers. Neither Mem0 nor Graphiti give you that: there,
the memory sits in Qdrant or Neo4j, and you cannot diff what was in it
yesterday.

**There is a measurement rig.** `eval/` and `bench/` are not
decoration — `bench/redteam.mjs`, `bench/ranking-attack.mjs`,
`bench/byzantine.mjs`, `bench/scale.mjs`, a frozen reference run. That
is the real strength, because it makes all the others bearable: every
point on this roadmap can be decided instead of believed.

**Bi-temporal is already there.** `valid_from`/`valid_until` kept
separate from `ts` is exactly Graphiti's core idea, and cheap-mem has
it without a graph.

---

## Part 2 — Current weaknesses

**The biggest one is not technical.** Measured today: a connected
agent had `mem_log` for a whole day and wrote **zero** entries. The
capability was there, the occasion was missing. A memory that only
one session writes to grows like one session. Addressed (house rules
+ tool descriptions + PreToolUse hook), **effect not yet measured**.

**The index is the wall.** At 200 000 entries, 1,7 s load time before
every answer, of which 1,2 s is `JSON.parse`. Every `mem find` is a
fresh process. Recommendation today: stay under 50 000 and split. That
is an honest limit, but it is one.

**A memory is only found by whoever hits its words.** The thesaurus
and the tag graph soften that; the embeddings lane covers genuine
paraphrase but is optional and therefore off by default. Where
Graphiti can traverse edges ("what hangs off this project"), cheap-mem
has to guess which words are in the entry.

**There are no entities.** "Lukas," "Lucky" and "lucky.hauenstein@…"
are three strings to the index. The tag graph stitches that together
as a stopgap, but there is no place that states: *this is the same
person*.

**Nothing ever gets quieter.** A mistake from a year ago that nobody
has superseded ranks today exactly as it did on day one. `standing()`
and the freshness bonus push against that, but weakly — +15 %, halved
after 90 days, is little against a running-text hit with many matching
words.

**Outside agents reach only a third.** The CLI has 35 commands, the
MCP bridge offers eleven tools — and `links`, `experiences`, `topics`,
`facts`, `show` and `explain` are not among them. A connected agent
can therefore neither traverse the edge graph nor read the supported
experiences nor follow a topic thread, even though all three are
built, tested and usable by hand. That is the same gap as with
logging, just one level deeper: not "the capability is missing," but
"it is unreachable from where the work happens".

**Two repos drift.** lucky-mem and cheap-mem are siblings with
different languages. On 2026-09-07 that cost a real defect: a lesson
logged in lucky-mem did not reach cheap-mem. There is now a doctor
check on rule parity — but only for the rules, not for the code.

---

## Part 3 — Assessment of the concepts

Format per point: **Benefit** / **Risk** / **Effort** / **Fit** /
**Recommendation**.

### 1. Structured memory objects
Built. Open is only whether `confidence` and `importance` belong —
see 2 and 8. Notable: `authority.mjs` explicitly justifies why
**levels instead of a number** were chosen — "a number nobody can
calibrate becomes a value everyone rounds to 'probably fine'." That
is the most solid answer to Copilot's `confidence:` field there is,
and it already stands in the repo.
**Recommendation: change nothing.**

### 2. Importance / Salience
Benefit: high, if measured correctly. Risk: **very high**, if a model
assigns the importance — then every entry carries that day's opinion,
and the stock becomes incomparable. `standing()` solves it via
citations: how many other entries lean on this one. Every clone
computes the same number, it lives in no field, it cannot be forged
without write access.
**Recommendation: keep `standing()`, feed it into the ranking (see
8), but never let a model set importance.**

### 3. Usage tracking
Against five of the ten core principles. `times_retrieved` would be
**machine-local** — it does not travel with the repo, so every clone
would have a different memory, and "Git as truth" would be broken. It
also rewards popularity instead of usefulness: the entry that comes up
on every other question because it is broadly worded wins against the
precise one.
**Recommendation: not a fit. Stays rejected.** The reasoning already
stands in the code; it also belongs in the public docs, so the
suggestion does not come back every three months.

### 4. Hybrid retrieval
Built, via RRF. The real open point is a different one: the
embeddings lane is **off by default**, so hybrid is plain BM25 in the
normal case. A local embedding model (Ollama, ONNX) would keep "Local
First" and close the blind spot.
**Recommendation: worthwhile from medium maturity onward** — first
measure how many questions fail on genuine paraphrase. The eval
corpus can do that.

### 5. Entity layer
The strongest of the open points. Benefit: high, and in two ways — at
retrieval ("everything about this project," without hitting the exact
wording) and at write time (merging aliases). Risk: a full graph
destroys the simplicity and brings an extraction stage that does not
work without a model. Effort: medium to high.
**Recommendation: worthwhile from medium maturity onward — but in the
small form.** Not Neo4j, not LLM extraction: an `entities.jsonl` with
`id`, `kind`, `name`, `aliases`, maintained by the digester and by
hand. Aliases alone already bring most of the benefit, cost hardly
any complexity, and stay readable.

### 6. Relationship system
Built, with four edges. The reasoning for the narrowness is strong:
"a graph whose edges mean whatever the writer felt on that day is not
traversable by code — only re-readable by a model, and that is
exactly the cost this design is meant to avoid."
Copilot's suggestions (`works_on`, `uses`, `owns`, `depends_on`) are
**entity** edges, not entry edges. They belong to point 5, not here —
that is the most interesting finding in his list.
**Recommendation: leave the four entry edges untouched. Assess entity
edges separately, together with 5.**

### 7. Episodic vs. semantic
Built, finer than proposed: ten lanes instead of two. The split does
not run along episodic/semantic, but along **what it will be needed
for later** — and that is the more useful axis.
**Recommendation: change nothing.**

### 8. Retrieval ranking
This is where the best benefit-per-effort of the whole report lies.
Present: relevance, freshness, authority, MMR. Not present:
`standing()` as a ranking factor. It is computed and read by `mem
experiences`, but neither `search()` nor `retrieve()` asks for it —
the number for how much the stock backs an entry has zero influence
on its findability.
Risk: every additional factor makes the ranking harder to explain,
and ranking changes are delicate (the exact-lane bug of 2026-09-07
cost coverage@3 dropping from 6/6 to 5/6, unnoticed).
**Recommendation: worthwhile right away — but only with a
before/after measurement on the eval corpus, and only one factor at a
time.**

### 9. Temporal facts
Built. `valid_from`/`valid_until` plus `--key`. What's missing is the
second half of Graphiti's bi-temporality: cheap-mem has validity time
and write time, but there is no query "what did we believe on July
1st held true on June 1st." `asOf` answers only the one axis.
**Recommendation: change nothing.** The second axis is impressive and
solves no problem for Lucky. `git log` answers it in an emergency.

### 10. Contradiction detection
Built: a new line with `replaces_id`, authority decides who may
supersede whom, `contradicts` marks instead of deleting. Copilot's
four options (overwrite / version / ask / historicize) are all
answered — and the one chosen is the only one that fits append-only.
Open is only the **detection**: cheap-mem does not notice a
contradiction on its own, someone has to set `replaces_id`.
**Recommendation: automatic detection only for `timeline` entries with
the same `key` and overlapping validity windows.** That is
deterministic, model-free, and catches exactly the class that changes
most often. Anything beyond that needs semantics and therefore a
model — not a fit.

### 11. Historical Recall
Built (`asOf`). **Recommendation: change nothing.**

### 12. Atomic memory units
Built. **Recommendation: change nothing.**

### 13. Reconsolidation
Built. `DIGEST.md` explicitly instructs the digester to check with
`mem find` before writing. That is Mem0's ADD/UPDATE/NOOP — without a
model having to decide for every single fact.
**Recommendation: change nothing.** Measuring how well the digester
actually does this would still be worthwhile: duplicate rate in the
stock.

### 14. Memory Decay
Copilot asks the right question himself: *does decay even make sense
for a git-based system?* Answer: **no, not as deletion.** Deletion
breaks append-only and the provenance chain.
But there is a variant that fits: not forgetting, but **getting
quieter**. An entry that nothing has cited for two years and that is
not a `learning` could sink in rank. That is a ranking factor, not a
storage concept — and therefore belongs to 8.
**Recommendation: not a fit as deletion/archiving. As rank damping
for later versions.**

### 15. Reinforcement through use
See 3. **Not a fit.**

### 16. Scaling
Measured. The bottleneck is clear: `JSON.parse` of the index in a
fresh process. The docs name sharding as the answer; that is correct,
but it shifts the work onto the user.
The technically clean answer is an index format that does not need a
full parse (SQLite with FTS5, or a binary index with mmap). That does
**not** collide with "human-readable" — the index is already a
gitignored cache today, not a source of truth. `state.mjs` just
enforced that separation.
**Recommendation: worthwhile from medium maturity onward.** Only once
a real stock reaches 50 000 — before that it would be optimization on
suspicion.

### 17. Research concepts
- **Mem0's LLM resolution**: the idea is good, cheap-mem's digester
  does it cheaply (one call per few hours instead of per fact). Do
  not adopt.
- **Graphiti's edge invalidity**: conceptually already there
  (`valid_until` + `contradicts`), just without a graph. Do not
  adopt.
- **MemGPT's paging**: cheap-mem never loads everything, it fetches
  selectively instead. Already solved, differently.
- **Generative Agents' reflection**: "draw a higher insight from many
  observations" — that is exactly `generalizes` plus the digester.
  There. What's missing is measuring whether it actually does that.
- **Dynamic Cheatsheet / ACE**: a growing, task-specific cheat sheet
  in context. That is the closest neighbor to what was built today
  (house rules + path hook) — and the most interesting thread for
  2.x: a **project-specific** cheat sheet that the digester
  maintains.
- **Obsidian**: the backlink ("what points here") is there — `mem
  links <id>` shows both directions. It is only missing for outside
  agents because the MCP bridge does not offer it. That is the
  cheapest improvement in the whole report.

---

## Part 4 — Prioritization

### Worthwhile right away
1. **Measure the effect of today's change** — does a connected agent
   now write on its own? Without this number, everything else is
   building on suspicion.
2. **`standing()` into the RANKING.** It is computed today and used
   by `mem experiences` — but `search()` and `retrieve()` don't know
   it. So an entry that twelve others lean on ranks exactly like one
   nobody leans on. One factor, with before/after on the eval corpus.
3. **The six missing tools onto the MCP bridge** — `links`,
   `experiences`, `topics`, `facts`, `show`, `explain`. They exist as
   CLI commands with tests; only the bridge is missing. The cheapest
   gain in the whole report.
4. **The rejection reasoning into the public docs** (usage tracking,
   confidence number, decay-as-deletion). A no without a reason gets
   proposed again every three months.

### Worthwhile from medium maturity onward
5. **Entities in the small form** — `entities.jsonl` with aliases.
6. **Automatic contradiction detection for `timeline`** with the same
   `key`.
7. **Local embeddings** (Ollama/ONNX), after measuring how many
   questions fail on genuine paraphrase.
8. **Measure duplicate rate** — does the digester really consolidate?

### Only for later versions
9. **Index format without a full parse** (SQLite/FTS5 or mmap) — only
   from a real 50 000 entries onward.
10. **Entity edges** (`works_on`, `depends_on`) on the entity layer,
    never on the entry layer.
11. **Rank damping for long-uncited entries.**
12. **Project-specific cheat sheet** in the style of Dynamic
    Cheatsheet / ACE.

### Not a fit for cheap-mem
- Usage tracking (`times_retrieved`, `last_used`) — breaks "Git as
  truth," rewards popularity.
- Model-assigned `importance`/`confidence` — impossible to calibrate,
  impossible to compare.
- Decay as deletion or archiving — breaks append-only.
- A real graph store (Neo4j/FalkorDB) — breaks Local First,
  readability, "no unnecessary infrastructure."
- LLM resolution per fact as in Mem0 — breaks token efficiency and
  model independence.
- Bi-temporality as a second axis — impressive, solves no problem
  that exists here.

---

## Part 5 — Roadmap

### cheap-mem 1.x — "What is built should also work"
No new concept. The series' bet: cheap-mem has more capabilities than
usage, and the gap between them is cheaper to close than any new
capability.

- Measure the effect of the house rules (does an outside agent write
  on its own?)
- the six missing tools onto the MCP bridge
- `standing()` as a ranking factor, measured
- rejection reasoning into the docs
- measure duplicate rate

*Reasoning:* today it was shown that a capability without an occasion
is no capability. For reachability the same holds one notch harder:
`mem links` is built, tested and documented — and for every agent
except a Claude Code session with a shell, it simply does not exist.

### cheap-mem 2.x — "Things instead of words"
The one genuine conceptual leap I recommend.

- `entities.jsonl`: people, projects, tools, with aliases
- retrieval by entity in addition to by word
- automatic contradiction detection for `timeline`
- local embeddings, if the measurement from 1.x justifies them

*Reasoning:* this is the one place where Mem0 and Graphiti can
structurally do something cheap-mem cannot. Everything else, it can
already do, just more cheaply. And the small form costs no
infrastructure: one more JSONL file, still readable, still in git.

### cheap-mem 3.x — "Large and still quiet"
- index format without a full parse
- entity edges and traversal
- rank damping
- project-specific cheat sheet

*Reasoning:* all of this is only right once a real stock has the size
that justifies it. Before that, it would be optimization on
suspicion — exactly the class of error this repo has spent the whole
summer building against.

---

## The answer to the closing question

*How can cheap-mem become significantly stronger without losing its
identity?*

**Not through more concepts.** Eleven of the seventeen are built —
and lie idle. `standing()` influences no ranking. `mem links`, `mem
experiences` and `mem topics` exist, but no connected agent can call
them: of 35 CLI commands, eleven are available as MCP tools. And such
an agent wrote nothing for a whole day, even though it was allowed to.

The pattern is the same everywhere: **built, but unreachable from
where the work happens.**

The biggest measurable gain lies in **1.x** — making what exists
effective. The biggest conceptual one lies in **2.x**, and at exactly
one place: cheap-mem knows words, but not things. An entity layer in
the small form (one JSONL file with aliases, no database, no LLM
extraction) closes the one structural lead that Mem0 and Graphiti
genuinely have — and costs none of the ten principles.

Everything else these systems can do, cheap-mem can already do. Just
more cheaply, more readably, and without a server.

---

## Addendum 2 — The entity thesis, measured (2026-09-08)

Copilot responded to the report, fairly, and with two objections. One
of them lands; the other could be measured rather than disputed.

### What I concede

**"cheap-mem has temporality" does not mean "cheap-mem plays in
Graphiti's league."** That is correct, and my phrasing "Graphiti's
core idea, without the graph" was too flattering. `valid_from`/
`valid_until` is ONE building block. Graphiti additionally has edge
invalidity as a derivation rule, bi-temporal inference, entity
traversal and a provenance graph. One building block is not a league.

Conversely, the same sentence also holds: "Graphiti has more building
blocks" does not mean "Graphiti is better for this stock." That
needed measuring — and now it has been.

### The measurement

Copilot's core point: **entity resolution** is the real gap, with the
standard example `Lukas = Lucky = the email address`. I had used the
same example in Part 2. Measured against lucky-mem, 1070 digested
entries (`scratchpad/alias.mjs`, read-only):

| Entity | Mentions | most common spelling covers |
|---|---:|---:|
| Person Lucky | 394 (`lucky`) / 14 (`hauenstein`) / 12 (`luckyno777`) / **1** (`lukas`) | **94 %** |
| Project cheap-mem | 196 | **100 %** |
| VM diggi | 291 | **100 %** |
| Agent Bibliothekar | 138 / 1 (`librarian`) | **99 %** |
| MCP bridge | 12 (`mcp-bruecke`) / 9 (`mcp-server`) / 7 (`mem-mcp`) | **43 %** |

**The standard example is a non-problem here.** `lukas` appears in
1070 entries exactly **once**. People, projects and machines already
carry, in practice, a canonical name in the grown stock — nobody had
to enforce that, it happened by itself.

**Where it is real is components.** The MCP bridge is named three
different ways, and no spelling has the majority. That is exactly
where the stock falls apart.

Two counter-checks:

- `mem finde "lukas"` returns **one** hit. The other 393 Lucky entries
  are invisible. So the alias shortage is real on the query side, even
  if small on the stock side.
- `mem finde "mcp bridge"` — a spelling that appears **zero** times in
  the stock — finds the `mcp-bruecke` entries anyway (score 8,8). The
  thesaurus and compound-word splitting already bridge part of this
  today, without a graph.

### What follows from this — sharper than both earlier versions

The one hit on `lukas` is the entry **"Lucky's full legal name"**.
That means: *the memory knows that Lukas and Lucky are the same
person.* It is there as content. It is simply not usable, because no
retrieval can read an entry as a rule.

That is the precise version of the gap, and it is smaller and cheaper
than "cheap-mem needs entity resolution":

> An entity layer would give this memory **no new knowledge**. It
> would make existing knowledge **operational**.

That changes the recommendation for 2.x in two points:

1. **Don't start with people, start with components.** That is where
   the decay is measured (43 %), not with people (94 %).
2. **The layer must be fillable from the existing stock**, not by
   hand: the identity statements already sit there as entries. A
   digester run that collects them is cheaper than a maintained
   register — and stays append-only, because the register is a
   derivation, not a source.

### On "which paradigm is the most powerful in the long run"

Copilot still sees Graphiti, Engram and Mem0 ahead there. Three
remarks on that, without claiming to refute him:

**The generation ladder is a taxonomy, not a ranking.** Text → fact →
entity → temporal graph describes increasing *structure*. That
increasing structure means increasing *power* is the actual claim —
and it only holds as long as you don't count the price of the
structure. For Graphiti and Mem0, that price is a model in the
ingestion loop. That is exactly the quantity cheap-mem minimizes; it
is not a feature that's missing, but one that was rejected.

**"Most powerful" without stock and budget is untestable.** At 10
million facts and a team, Graphiti is right. At 1070 entries, one
person and a browser-SSH on a phone, you'd pay for a server and a
model call per fact for a traversal that BM25 with a thesaurus
already achieves with a score of 8,8. Both sentences can be true.

**On the score.** 6,5 → 7,8–8,2 is generous, but it is a number
without a scale and without a measurement procedure — and thus
exactly what `authority.mjs` rejects about `confidence` fields: "a
number nobody can calibrate becomes a value everyone rounds to
'probably fine'." More useful would be: *which question can system A
answer that system B cannot?* For the entity question, the answer now
stands above, with numbers.

### Where Copilot is unreservedly right

His classification of cheap-mem as a **fact store** is correct, and
it is more useful than any score. The categories describe what a
system is built for, instead of sorting them on one axis. And his
statement that his analysis was architectural and not code forensics
is a precision I could have saved myself in my own Addendum 1, had I
had it beforehand.

---

## Addendum 3 — Why the score says nothing about cheap-mem

Copilot has revised his assessment a second time: 6,5 → 7,8–8,2 →
8,5–9, cheap-mem in 1st place on two of three rankings. Two things
about that, and the second is more important than the first.

### The premise is wrong

He writes that most of the architecture presumably sits "in a larger
codebase (lucky-mem/private predecessor)".

That is not so. Everything I cited lives in **this** repo, on
`origin/main`, publicly: `src/authority.mjs`, `src/capability.mjs`,
`src/retrieval.mjs`, `src/state.mjs`, `src/epoch.mjs`,
`src/freshness.mjs`, `src/hybrid.mjs`, `src/entity.mjs`, and
`standing()`, `linksOf()`, `experiences()`, `topicEntries()` in
`src/memory.mjs`. Checked against `origin/main`, not against the
working tree.

There is no private predecessor. lucky-mem is the **sister project**
— Lucky's personal memory, German-language, with the same design.
None of it had to be fetched from there for this report.

The correction makes his upgrade better justified, not worse: what he
thought was hidden is readable. But it also shifts what the first
pass actually showed — not "the repo hides something," but "`src/`
was never opened".

### The score measures the reader, not the system

The same question has now been answered about the same subject four
times:

| when | who | score | basis |
|---|---|---|---|
| 2026-09-02 | Gemini | diverging, lower | without reading the repos |
| 2026-09-03 | ChatGPT | **9,1 / 10** | actually read the repos, cited real files |
| 2026-09-08 | Copilot, first round | 6,5 | README, architecture diagrams, DeepWiki |
| 2026-09-08 | Copilot, third round | **8,5–9** | this report |

The number does not follow the quality of cheap-mem — that was the
same the whole time. It follows **how much the reviewer read**.
Whoever opens `src/` lands at ~9; whoever reads the docs, at 6,5.

So a score of this kind is not a property of the system, but a
property of the process. It is not fit to serve as a basis for
decisions.

### And agreement is not confirmation

Copilot writes about the entity question: "That's exactly where I
fully agree with Claude."

He agrees with a claim that I half-withdrew in **Addendum 2**.
Measured: `lukas` appears in 1070 entries exactly once, 94 % of
mentions are canonical. The textbook example he names, and that I
myself had used, is a non-problem on this stock.

Two models reading each other thus converge on **agreement**, not on
truth — even when a measurement in between already speaks against it.
That is not a criticism of him; I made the same mistake in the same
report, two paragraphs after the warning against it. It is the reason
why, in this repo, arguments must not replace measurements.

### What to do instead

On 2026-09-05 exactly that had already been decided
(`projekte/cheap-mem/entscheidungen.jsonl`, `fremdvergleich-ai-memory`):
hard counter-checking of cheap-mem alone first, then a **narrow
comparison on five to six axes** against Engram, Zep and Mem0 — and
explicitly **not** the big criteria matrix.

Three rankings across three categories are that matrix in different
clothing. The report therefore delivers no counter-ranking. What it
delivers are numbers on exactly one of the contested axes — and the
next axis should be treated the same way.
