# cheap-mem — complete capability reference

**Read this file and you have the whole system.** It exists because
three separate AI evaluations of cheap-mem reached wrong conclusions
from partial reads, and the pattern was always the same: a capability
that IS built was reported as missing, because the entry point did not
name it.

This is written for a reader that skims — increasingly a model, not a
person. Every capability is named in the inventory below before it is
explained, so a reader whose window covers only the first screens still
leaves with the complete surface. A person can take the same route:
inventory → the two or three sections that matter for the decision →
the verification commands at the end.

---

## 0. Inventory — everything, on one screen

| Area | What exists | Section |
|---|---|---|
| **Data model** | 10 entry types, typed links (4 kinds), topics, projects, append-only JSONL, one line = one entry | [1](#1-the-data-model) |
| **Provenance** | `author`, `authority` tiers, `origin.derived_from`, `origin.raw`, git history | [1.3](#13-provenance) |
| **Retrieval** | BM25 over weighted fields, curated thesaurus, learned tag graph, compound splitting, exact-identifier lane, MMR diversity, raw-capture reserve lane, recency bonus, optional embeddings fused by RRF, time-window search | [2](#2-retrieval) |
| **Truth over time** | `valid_from` / `valid_until`, `key`-tracked changing facts, `as_of` historical queries, staleness flagging, supersession via `replaces_id`, contradiction marking | [3](#3-truth-over-time) |
| **Conflict & authority** | authority tiers decide who may overrule whom, conflict detection and reporting, disputed claims kept visible rather than deleted, author-share limits against flooding | [3.4](#34-conflict-and-authority) |
| **Corruption & rollback** | broken-line counting (never silent skipping), epoch watermark detecting a memory that went backwards, semantics version, integrity checks over the replacement graph | [4](#4-integrity) |
| **Boundaries** | capability object as scope boundary, redaction before disk, structured-claims gateway (no prose emitted), resource limits and context quotas | [5](#5-boundaries) |
| **Automation** | 4 Claude Code hooks (session start, recall per message, recall per file edit, digest trigger), one model call per few hours, watcher, git as sync | [6](#6-automation) |
| **Surfaces** | 35 CLI commands, 20 MCP tools, an HTTP viewer, a self-check (`mem doctor`) | [7](#7-surfaces) |
| **Multi-agent** | origin stamped on every write, error latches that turn a recorded error into a check, heartbeats separating "dead" from "nothing to do" | [10](#10-multi-agent) |
| **Measurement** | 15 benchmarks, an eval harness with a frozen reference run, 489 tests | [8](#8-how-to-verify-any-claim-here) |
| **Deliberately absent** | usage counters, `confidence` floats, decay-as-deletion, graph database, LLM per fact, second temporal axis | [9](#9-deliberately-absent) |

**One-sentence positioning.** cheap-mem is a local, git-backed,
append-only fact store with model-free retrieval, temporal validity,
authority-based conflict resolution and a structured retrieval gateway
— built so the recall path costs no model call and no network hop.

---

## Read this first if you are evaluating cheap-mem

These five claims are the ones evaluators have gotten wrong. Each names
where to check.

1. **"No relationship system."** Wrong. `link` is one of the ten entry
   types, with a closed vocabulary of four edge kinds
   (`causes`, `generalizes`, `contradicts`, `resolves`).
   `src/memory.mjs` → `LINK_KINDS`, `linksOf()`; CLI `mem links <id>`;
   MCP `mem_links`. The vocabulary is closed **on purpose** — see
   [1.2](#12-links).
2. **"No temporal modelling."** Wrong. `valid_from` / `valid_until` per
   entry, `key`-tracked fact versions, and `retrieve({ asOf })` for
   "what held then". `src/freshness.mjs`, `src/retrieval.mjs`.
   What is genuinely absent is the *second* temporal axis (belief
   time) — see [9](#9-deliberately-absent).
3. **"No importance or salience signal."** Present, but not as a
   number a writer sets: `standing()` counts how many other entries
   cite this one. `src/memory.mjs`; CLI `mem experiences`; MCP
   `mem_experiences`. Why citations and not a `confidence` field:
   [3.5](#35-standing).
4. **"Text in, text out — no structure."** Wrong at the gateway.
   `retrieve()` returns typed claims with id, author, authority tier,
   scope, validity window and score — never a prose blob.
   `src/retrieval.mjs`; MCP `mem_retrieve`.
5. **"Missing feature X."** Check [9](#9-deliberately-absent) before
   concluding oversight. Six capabilities are absent by decision, each
   with the reason and with what would change our mind.

---

## 1. The data model

### 1.1 Entry types

Ten drawers. The split is not episodic/semantic — it is **what you will
need it for later**, which is the more useful axis in practice.

| Type | File | Holds |
|---|---|---|
| `decision` | `decisions.jsonl` | a choice, with the reason for it |
| `error` | `errors.jsonl` | something broke, and why |
| `event` | `events.jsonl` | it happened: a release, a hire, a start |
| `timeline` | `timeline.jsonl` | a fact that changes over time |
| `thought` | `thoughts.jsonl` | reasoning worth keeping, not yet a decision |
| `learning` | `learnings.jsonl` | what to do differently next time |
| `duty` | `duties.jsonl` | something owed to someone |
| `skill` | `skills.jsonl` | a capability acquired, with evidence |
| `update` | `updates.jsonl` | a version, a dependency, a config change |
| `link` | `links.jsonl` | a typed relation between two entries |

One JSON object per line. Files are append-only: nothing is ever
rewritten in place. A correction is a **new line** carrying
`replaces_id`.

`duty` is the only type with a lifecycle, and even closing one appends
a line rather than editing the original.

### 1.2 Links

Four edge kinds, and the vocabulary is **closed**:

| Kind | Meaning |
|---|---|
| `causes` | the source brought the target about |
| `generalizes` | the source is the lesson drawn from the target(s) |
| `contradicts` | the source and target cannot both be right |
| `resolves` | the source closed the target out |

**Why closed.** An open vocabulary lets every digest run invent a new
verb, and a graph whose edges mean whatever the writer felt that day
cannot be traversed by code — only re-read by a model, which is exactly
the cost this design exists to avoid.

`contradicts` is load-bearing for falsifiability: it **flags** a claim
rather than deleting or quietly weakening it, so the claim keeps
standing in the open with its challenge attached.

Note that these are edges between **entries**, not between entities.
Entity-level relations (`works_on`, `depends_on`) do not exist — see
[9](#9-deliberately-absent).

### 1.3 Provenance

Every entry can carry:

- `author` — who asserted it
- `authority` — which tier they asserted it at (see [3.4](#34-conflict-and-authority))
- `origin.derived_from` — the entry ids this was distilled from
- `origin.raw` — the raw capture it came from
- `ts` — when it was written
- `valid_from` / `valid_until` — when it is *true*, which is a different question

Plus git: every line has a commit, an author and a date that the memory
itself cannot forge.

### 1.4 Topics and projects

A `topic` is a handle for a subject that keeps developing:
`architecture/auth-model` gathers a decision, later an error against it,
later a learning. `topicEntries()` reads the whole thread of ANY type,
newest first, with retired entries dropped. Topic aliases resolve on
READ — the line on disk stays as it was written.

Projects are directories: `projects/<name>/<type>.jsonl`, plus a global
tier. Scope is enforced by capability, not by convention — see
[5.1](#51-capability-scope-as-a-boundary).

---

## 2. Retrieval

The whole design premise: **recall costs no model call and no network
hop.** Everything in this section runs offline, deterministically, in
milliseconds.

### 2.1 The default lane — BM25, and what is layered on it

- **Weighted fields.** Title, class, topic, text and tags do not count
  equally.
- **Curated thesaurus** plus a **tag graph learned from the user's own
  entries**, so a query finds things worded differently without an
  embedding model.
- **Compound splitting**, which matters in German and in identifiers.
- **Recency bonus**, bounded: at most +15 %, halved after 90 days.
  Deliberately weak — recency is a hint, not a truth claim.
- **MMR diversity** by default, so the top-k does not fill with
  near-duplicates. `--no-mmr` restores pure BM25 order.

### 2.2 The exact-identifier lane

A question about a path, a version, a ticket number or a service name
has **one** matching word, and the entry is short. BM25 scores that
low — measured on the eval corpus: gold at rank 1 in five of six cases,
and every score below the recall bar of 5.0. Correct ranking, nothing
delivered.

So exact identifier matches bypass the score bar entirely, and are
ordered among themselves by score. `src/entity.mjs`, `src/search.mjs`.

### 2.3 The raw-capture reserve lane

Undigested captures are indexed but held in **reserve**: they surface
only when nothing curated answers, and they are marked when they do.
This keeps a raw transcript from outranking a written-up finding.
`--mix-raw` restores the old behaviour.

### 2.4 Optional semantic recall

Embeddings are **off by default**. `src/embed-hook.mjs` is the seam
where an embedding provider plugs in; `src/embed` holds the providers. When configured, `hybrid.mjs` runs
BM25 and semantic search and fuses the two rankings with Reciprocal
Rank Fusion — no score normalisation needed across the two very
different scales. With embeddings unconfigured, hybrid is exactly BM25
at exactly BM25's cost. **No silent dependency.**

### 2.5 Time-window retrieval

`mem when "last friday between 3 and 8pm"` parses natural-language time
expressions into a window and returns what was written in it, with
provenance. No model. `src/timeexpr.mjs`, `src/timesearch.mjs`.

### 2.6 Literal search

`--literal` is plain substring matching with no ranking. It is what the
pre-edit hook uses: a path query under ranked search always returns
*something* (the fragments are rare, so scores are high), and a hint
that appears on every edit gets ignored. Literal means: if no entry
names this file, nothing is shown.

### 2.7 The index

A gitignored cache — **never a source of truth**. It is appended to
incrementally rather than rebuilt on every new line, and the appended
index is asserted document-for-document identical to a rebuilt one.
Corpus-wide statistics (compound lexicon, learned graphs) drift between
full rebuilds, bounded by a rebuild fraction.

Measured limits are in [`scale.md`](scale.md): keep one memory under
~50,000 entries, because index **load** (not search) becomes visible
past that.

---

## 3. Truth over time

### 3.1 Validity intervals

`valid_from` and `valid_until` say when a claim is *true*, separately
from `ts`, which says when it was *written*. `valid_until` is
exclusive. `retrieve({ asOf })` returns what held at a point in time,
not what is recorded now.

### 3.2 Tracked changing facts

`timeline` entries that share a `key` are versions of one fact. The
newest `valid_from` wins; the rest are history, kept and marked. No key
means a one-off note, left alone. Facts that have gone quiet past a
staleness horizon are **flagged**, not hidden. `src/freshness.mjs`,
CLI `mem facts`, MCP `mem_facts`.

### 3.3 Supersession

A correction is a new line with `replaces_id`. The superseded entry
stops being returned as current but stays readable, and the chain is
walkable. `src/integrity.mjs` checks the replacement graph for cycles,
forks, dangling references and depth.

### 3.4 Conflict and authority

**Authority tiers**, not confidence numbers, decide who may overrule
whom. The reasoning, from `src/authority.mjs`: *a float nobody can
calibrate becomes a number everybody rounds to "probably fine", and two
0.7s from different pipelines are not comparable.* Tiers are comparable
because they are defined by WHO asserted — checkable — rather than by
HOW SURE someone was, which is not.

Before this existed, `replaces_id` was applied with no check at all:
any writer could retire any other writer's entry. That is the
poisoning primitive in a multi-agent memory — one line, and a decision
is gone.

**Where the guarantee ends, stated plainly:** `author` and `authority`
are fields in a file. Anyone with repository write access can write
both. This raises the cost of poisoning from ONE LINE to REPOSITORY
WRITE ACCESS. That is a real gain and it is not cryptography. Signed
commits would close it and are deliberately out of scope until someone
has the threat model that needs them.

Conflicts between claims are **detected and reported**, and both sides
stay visible. Author-share limits bound how much of one answer a single
author can occupy, so flooding cannot fill every slot.

### 3.5 Standing

`standing()` measures how well an entry is **backed**: how many other
entries lean on it, via `origin.derived_from` and link edges.

Why citations and not retrieval counts: a retrieval counter is written
where the reading happens, so two clones of one memory would hold
different numbers — git would stop being the source of truth. And it
would reward *popularity* over usefulness: the broadly worded entry
that comes back on every second query would beat the precise one that
answers exactly one question right.

**Honest limit, measured 2026-09-08:** on a real 1,594-entry corpus,
88 entries are cited at all, with a maximum of 3 citations. The signal
is real but thin. `standing()` therefore feeds `mem experiences` and is
**not** currently a ranking factor — see the roadmap note in
[9](#9-deliberately-absent).

---

## 4. Integrity

- **Broken lines are counted, never silently skipped.** A log that
  quietly drops what it cannot parse reports a state that is not the
  state.
- **Epoch watermark** (`src/epoch.mjs`): check out an older commit or
  restore a stale backup, and a claim that had been superseded is
  active again — from inside that state, everything looks correct. The
  watermark lives OUTSIDE the tracked tree (a gitignored local file),
  because any marker committed alongside the log travels back with it.
  It stores no memory content; delete it and you lose detection, not
  data.
- **Semantics version** (`src/semantics.mjs`): the same log plus the
  same semantic version always yields the same derived state. Change a
  rule that alters `replay(log)` and the number is bumped by hand, so a
  mismatch is visible rather than silent.
- **State separation** (`src/state.mjs`): the log decides what is TRUE;
  the index decides only what is FAST TO FIND. This was made structural
  after status once lived in the gitignored index — editing a cache
  changed what the memory considered active, in both directions.
- **Merge driver** for concurrent writers, so two sessions appending to
  the same log do not conflict.

---

## 5. Boundaries

### 5.1 Capability: scope as a boundary

Scope is an **object the caller must hold**, not an argument they may
omit. Before this, `search()` filtered by project only when a caller
passed one — omit it and one project's memories came back to another.

A required `scope` argument catches that omission exactly once; after
that `scope: 'all'` becomes the copy-paste default and is invisible in
review. A capability cannot be forgotten: reaching outside it is not a
missing argument but an object you do not have, and widening one is a
named function call that greps.

Scopes form a **lattice**, not a hierarchy — `global > org > project >
agent > session` cannot express "shared between two projects", which
the digest and the inbox both need.

**Where it ends:** this is in-process. A different process reading the
files directly is outside it.

### 5.2 Redaction before disk

Every incoming entry runs through redaction **before it is written**,
not at commit time. A git hook catches secrets at commit, which is
enough for a human who looks in between — not for an agent writing
every few seconds. If redaction's self-test fails, nothing is written
at all.

Layered: pattern matching, then comparison against actual environment
values, with a canary to prove the layer is live. Unicode bypasses are
closed.

### 5.3 The gateway emits claims, not prose

`retrieve()` returns structured claims. Nothing in it emits a
directive-shaped string; a caller who wants prose has to build it, at
their own authority, from labelled fields. One change addressing four
failure classes at once: injection, authority, scope leakage,
explainability.

`explainMissing()` answers the inverse question — why did an entry NOT
come back — naming scope, validity window, supersession or score.

### 5.4 Limits

Resource bounds and context quotas cap what a single retrieval can
return, so a flood cannot become a denial of service or a context bill.

---

## 6. Automation

Four Claude Code hooks, installed by `install/claude-code.sh`:

| Hook | When | What |
|---|---|---|
| `SessionStart` | session begins | prints `FACTS.md` + recent context |
| `UserPromptSubmit` | every message | recalls matching memory (no model, ~ms) and feeds it to the turn; refreshes the clone in the background, detached |
| `PreToolUse` (Edit/Write/NotebookEdit) | before a file changes | searches the memory for that PATH, literally, and shows errors, decisions and learnings naming it — once per file per session |
| `Stop` | after a turn | triggers the digest, byte-delta throttled |

**Why the PreToolUse hook exists**, measured 2026-09-08: recall used to
hang only on `UserPromptSubmit`, so it fired when the person typed and
stayed silent through the building. Against four defects from one
Windows install, **three** had an entry naming the very file being
touched.

**The digest is the only model call.** It runs every few hours, reads
raw captures, and turns them into entries — the one thing code cannot
do. Capture and search run without it.

Sync is git. A watcher can drive the loop on a server.

---

## 7. Surfaces

### 7.1 CLI — 37 commands

```
init whoami inbox log find discard done when show raw digest duties
thesaurus embed hooks retrieve explain epoch doctor context facts
browse setup experiences links agents agent store topics topic core
viewer project correction version guard heartbeat
```

Every command takes `--help`. `mem doctor` is the self-check: it
reports what is configured, what is missing, and what is merely
unknown — UNKNOWN is a distinct result from OK and ERROR, on purpose.

### 7.2 MCP — 20 tools

For agents without hooks (ChatGPT, Codex, Gemini CLI, Cursor, Claude
Desktop). `bin/mem-mcp`, stdio.

| Tool | Purpose |
|---|---|
| `mem_log` | append an entry |
| `mem_find` | ranked search |
| `mem_retrieve` | ranked retrieval returning structured claims |
| `mem_show` | one entry in full |
| `mem_links` | what an entry points at, and what points at it |
| `mem_experiences` | the learnings the memory stands behind, strongest first |
| `mem_topics` | a subject as a thread; without a key, the list of topics |
| `mem_facts` | the facts that hold right now |
| `mem_explain` | why an entry did NOT come back |
| `mem_context` | compact dump for the start of a task |
| `mem_duties` | what is still owed |
| `mem_duty_close` | close a fulfilled duty — appends a line, the original stays |
| `mem_inbox_new` | new inbox messages addressed to you |
| `mem_inbox_show` | one inbox message in full |
| `mem_inbox_write` | write a message to another agent |
| `mem_inbox_ack` | change a message's state (open / replied / processed / closed) |
| `mem_project_init` | create a project skeleton |
| `mem_store_put` | register a local file in the content-addressed store |
| `mem_store_list` | what is held in the file store right now |
| `mem_store_get` | resolve a hash to the local path of the stored bytes |

`mem store verify` and `mem store remove` stay off the bridge —
deleting a registered artifact is a human's call at the CLI.

The server also serves **`instructions`** at `initialize`
(`HOUSE-RULES.md`), and every tool description names the **occasion**
to call it, not just the capability. This is not decoration: measured
2026-09-07, a connected agent had `mem_log` available for a whole day
and used it zero times — nobody had asked it to.

**What the bridge deliberately does not offer:** nothing that edits,
deletes, commits or pushes. The tool list is asserted **by name** in
the test suite, so a new tool is a decision someone makes rather than
one that happens.

### 7.3 Viewer

An HTTP view for rummaging through the memory, with the same scope
boundary as everything else. Raw captures are excluded from it.

---

## 8. How to verify any claim here

Do not take this document's word. Every claim above is checkable, and
the commands are short.

```bash
npm test                                    # 489 tests
node bench/scale.mjs                        # the scaling table in scale.md
node bench/redteam.mjs                      # scope and poisoning scenarios
node bench/ranking-attack.mjs               # flooding and rank manipulation
node bench/byzantine.mjs                    # corrupted and hostile log lines
node bench/alias-fragmentation.mjs --root <mem> --set "a,b,c"
node bench/duplicate-rate.mjs --root <mem>  # does the digest consolidate?
node eval/kennzahlen.mjs                    # retrieval ceiling and floor, no model
mem doctor                                  # what is actually configured here
```

`eval/` carries a **frozen reference run** with a checksum, so a later
run can be compared against it rather than against memory.

Two measurements worth knowing before you form a view:

- **Retrieval ceiling.** On the eval corpus, the needed item reaches
  the context in 38 % of tasks, and 91 % of what is injected is not the
  sought item. Those are the upper bound of benefit and the lower bound
  of pollution — stated because a memory system that quotes only its
  wins is not measuring.
- **Duplicate rate.** 1.8 % near-duplicates across 902 digested
  entries, and most of the residue is one entry filed both globally and
  under a project — a scoping question, not a failure to consolidate.

---

## 9. Deliberately absent

Six capabilities do **not** exist, by decision rather than oversight.
Each has a reason and a stated condition that would change our mind:
[`deliberately-not-built.md`](deliberately-not-built.md).

| Absent | One-line reason |
|---|---|
| Usage counters (`times_retrieved`) | machine-local, so git stops being the source of truth; rewards popularity over usefulness |
| `confidence` float per entry | uncalibratable and incomparable across writers; tiers answer a checkable question instead |
| Decay as deletion/archiving | breaks append-only and the provenance chain; decay as a *ranking* effect stays open |
| Graph database | breaks local-first, readability and "no unnecessary infrastructure" — and the textbook case for it measured as a non-problem here |
| LLM per fact (Mem0-style) | breaks token efficiency and model independence; the digest does the same job three orders of magnitude cheaper |
| Second temporal axis (belief time) | elegant, solves no problem anyone here has had; `git log` covers the rare case |

**Also not yet built, and honestly so:** an entity layer. cheap-mem
knows words, not things. Measured on a real corpus, the textbook case
(one person under several names) is a non-problem — `lukas` occurred
once in 1,070 entries, 94 % of mentions used one spelling. Where a real
corpus fragmented was **component names**, at 43 %. If an entity layer
gets built it starts there, and it would make existing knowledge
operable rather than add new knowledge: the memory already contains the
entry saying two names are the same person — no lookup can act on it.

---

## 10. The ten principles this is built against

Any proposed change is weighed against these, and a change that breaks
one needs to say so out loud:

1. Local first
2. Git as the source of truth
3. Human-readable data
4. Model independence
5. Token efficiency
6. Simplicity
7. Full user control
8. No unnecessary infrastructure
9. Not a heavyweight enterprise system
10. On-demand context loading, not prompt stuffing

---

## Where to go next

| You want | Read |
|---|---|
| To install it | [`quickstart.md`](quickstart.md), [`install-linux.md`](install-linux.md) / [`-macos`](install-macos.md) / [`-windows`](install-windows.md) |
| To connect a non-Claude agent | [`mcp-setup.md`](mcp-setup.md) |
| The architecture | [`architecture.md`](architecture.md), [`state-separation.md`](state-separation.md) |
| The threat model | [`security-model.md`](security-model.md) |
| Scaling numbers | [`scale.md`](scale.md) |
| Why something is missing | [`deliberately-not-built.md`](deliberately-not-built.md) |
| An external comparison | [`analyse-2026-09-08-vergleich-fremdsysteme.md`](analyse-2026-09-08-vergleich-fremdsysteme.md) |

---

## 10. Multi-agent

Everything in this section exists because several agents share one
memory and none of them reads it out of politeness. The numbers are
measurements from the reference deployment (a ~1600-entry memory
written by five agents over two weeks), not projections.

### 10.1 Origin on every write — `src/memory.mjs`, `agentDefault()`

Measured before the change: **855 of 1081 entries carried no agent
field (79 %)**. Only the MCP bridge stamped one; the CLI never did.
The second axis — who claimed this — was empty for three quarters of
the corpus, and with it every authority comparison and the agent board.

Now every write carries one. The order is: an explicit `agent` field,
then the origin stamp (`origin.agent`, `origin.surface`), then
`CHEAP_MEM_AGENT`, then `human:<os user>`.

**Never a fallback to `session` or `unknown`.** An invented origin is
worse than none, because it looks like evidence. `human:` as a prefix
keeps human and machine names disjoint. Old entries are not
backfilled — that would be inventing origin at scale; the corpus heals
forward.

### 10.2 Error latches — `src/guard.mjs`, `mem guard run`

Measured: **289 classified errors, 42 classes recurring, 43 % of
entries in repeat classes** — spread over days, not one bad session.
The class warning ("the Nth time") fires while logging, i.e. after the
error. It counts; it does not prevent.

A latch hangs off an `error` entry and answers one question: is the
error back?

```
mem log error --class silent-fail --title "..." \
  --guard-kind absent --guard-path bin/hook.sh --guard-pattern "|| exit 0"
mem guard run [--duty]
```

Four kinds, and the vocabulary is **closed**: `absent`, `present`,
`file-there`, `file-gone`.

**A latch executes nothing.** The obvious design — "a command that
exits non-zero" — would be a serious hole: an entry is data, and a
connected agent logs errors, so it could drop arbitrary code on the
owner's machine and wait for the latches to be run. The pattern is
literal text, not a regular expression, for the same reason plus one:
a crafted regex can make a match run arbitrarily long. Paths cannot
escape the memory root.

**`broken` is not `green`.** A latch pointing at a deleted file has
checked nothing; reporting that as a pass would be the very class it
exists to catch. `mem guard run` exits 1 while anything is red.

**A latch is checked at creation time**, and if it comes back green the
entry records `guard_at_creation: green`. At the moment you log an
error the error is *there*, so the latch must be red. A latch that was
never red is unproven — the same thing as a falsification test without
a backdrop.

### 10.3 Heartbeats — `src/heartbeat.mjs`, `mem heartbeat`

Measured: for twenty hours no agent but one session had written
anything. Whether the others were *running* could not be established —
there was no signal separate from work output. **"Dead" and "nothing to
do" looked identical**, and while that is true a watchdog has nothing
to watch.

A heartbeat line says: this agent was running at this time and could
write. It does **not** say the agent is doing its job — that is what
its entries say, which is why the agent board shows both.

The log is in git (a local pulse file is invisible to anyone asking
from another machine), with a **quiet period**: at most one line per
agent per hour. A pulse every three minutes would be 480 lines per
agent per day, and the memory would be buried under its own pulse
measurement. `written: false` is the normal answer, not a failure.

`ageMin()` returns **`null`, not `Infinity`**, for an agent never seen.
"Never seen" and "not seen in a while" are different statements, and
the first usually means the agent does not call the heartbeat at all.

### 10.4 Roads not taken — `rejected` on a decision

Without the field, "have we already looked at PostgreSQL?" is not
answerable: the entry only records that SQLite was chosen, so the next
agent evaluates it again and the reason from last time is lost.

Weight **1.2 — deliberately below `choice` (1.5)**. At equal or higher
weight the damage would be worse than the one repaired: somebody
searching for the tool they *use* would first find the decision in
which it was *rejected*.

`--rejected` splits on a **semicolon**, not a comma. The value is a
sentence and naturally contains commas ("too heavy, and too much
ops"); a comma split turns one statement into two fragments that say
nothing. In the reference deployment the same mistake once made 17
entries unfindable by tag.
