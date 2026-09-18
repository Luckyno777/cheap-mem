# Three lanes, one model call

The design in one line: **storing is cheap, thinking is expensive.**

So store everything immediately and stupidly, think about the whole
pile once every few hours, and read with pure code.

```
LANE 1  CAPTURE   every session    no model    ~50 ms   0 cost
LANE 2  DIGEST    when ripe        ONE call    ~30 s
LANE 3  SEARCH    every query      no model    ~3 ms    0 cost
```

Most memory tools put a model in the read path. That makes every recall
cost money and latency, and it makes the tool useless offline. Here the
model appears exactly once, on a timer, far away from anything you are
waiting for.

---

## Lane 1 — Capture (`src/raw.mjs`, `bin/mem-capture`)

A Stop hook. It copies the growth of the session transcript — nothing
more. No model decides what is important, because deciding is the
expensive part and it can wait.

Incremental through a byte offset per transcript, so the second capture
only takes what is new. Gzipped, roughly 3× on real transcripts.

### Redaction — the part that matters

A transcript holds everything that went through a terminal: `env`
output, `cat .env`, curl headers, a token someone pasted by mistake.
Without redaction, capture would be a secret leak **with version
history**, and git forgets nothing.

Three layers:

1. **Patterns** (`src/redaction.mjs`) — provider keys, JWTs, PEM
   blocks, bearer headers, URL credentials, `*TOKEN|SECRET|PASSWORD*`
   assignments. About twenty shapes.
2. **Env match** — the actual values in `process.env`, matched
   literally. This catches a secret whose *shape* nobody listed, which
   is the case patterns can never cover.
3. **A git pre-commit hook** — checks what is really about to be
   committed, whoever wrote it and however it arrived.

With three layers a leak needs two mistakes instead of one.

**The redacted value is never retained** — not in a log, not in a
return value. Only type and count:
`"__redacted": [{"type":"github-token","count":3}]`

A **canary self-test** runs before every capture. If a rule has fallen
over, capture aborts rather than writing unprotected. A silent failure
is the dangerous state: everything keeps running, just without cover.

> It is a net, not a guarantee. Regexes catch known shapes. The rule
> still stands: don't put secrets in your terminal.

### Provenance

Every capture carries `{session_id, surface, ts_from, ts_to, project}`.
It says **where from**, never **who** — no login name, no machine name.
There is a test for that.

---

## Lane 2 — Digest (`bin/mem-digest`, `DIGEST.md`)

One model call that sorts the raw material into drawers. It runs on a
timer, but it does not run *by* the clock — it runs by the pile.

### The bell

Every successful capture rings. Dueness follows from three thresholds:

| trigger | default | meaning |
|---|---|---|
| volume | 500 KB | big enough, go now |
| quiet | 45 min since the **last** bell | the burst is over |
| ceiling | 8 h since the **first** bell | a long day must not postpone forever |

**No bell, nothing happens.** A week away costs exactly zero model
calls. The quiet period counts from the last bell, not the first —
otherwise the digest fires in the middle of your working day.

The tick itself is cheap: it asks `mem digest due` and is back out in
milliseconds with no lock, no git, no model.

### Nine drawers

`decision` · `error` · `event` · `timeline` · `thought` · `learning` ·
`duty` · `skill` · `update` — all append-only.

**Duty is the only one with a lifecycle.** Closing one appends a line
with `closes_id`; `mem duties` folds the log into a current view. It is
the only folded view in the whole system, and it exists because an
unfolded duty list is useless.

### Why the wrapper does not trust the exit code

The first real run reported "done" with exit 0 and had done nothing:
the session had failed on permissions, explained that honestly, and
exited cleanly. So the wrapper counts pending captures before and
after. No change means failure, whatever the model claims.

### And why a non-zero code is read word for word

The mirror image of the same mistake. Until 2026-09-18 every failure
was logged as `model call exited N (timeout or error)` — one phrase for
four different situations. In the sister memory that phrasing cost a
whole night: the log said

```
timeout: failed to run command 'claude': Permission denied
[..] exited 126 (timeout or error)
```

and whoever read only the second line went looking for a time cap that
did not exist. The CLI sat on a mount flagged `noexec`, where `execve()`
refuses every file whatever its permission bits say — root included.

Three of those codes are specific sentences, so they are logged as such:

| code | means | first move |
|---|---|---|
| **124** | the time cap expired — and **only** that | raise `MEM_DIGEST_TIMEOUT`, or find out why the run is slow |
| **126** | found, but **not executable** | `ls -l "$(command -v claude)"` — missing x-bit, or a `noexec` mount |
| **127** | not found at all | `echo "$PATH"; command -v claude` |

For 126 there is also a way through, and it is the same one the git
hooks use: **a file that may not be executed may still be read.** For a
shell that is `bash <path>`; for a Node CLI, `node <path>`.
`mem_start_command` in `bin/_portable.sh` decides this once, before the
first call, with four outcomes rather than two:

| outcome | when | what happens |
|---|---|---|
| `not-found` | `command -v` finds nothing | nothing is rewritten — the failure then says 127, which is the truth |
| `direct` | the probe runs | the normal case |
| `detour` | probe says 126 **and** `node <path>` runs | start becomes `node <path>` |
| `both-dead` | probe says 126 **and** `node <path>` fails too | start stays direct, so the 126 still shows in the log |

Two things are deliberate. The detour is **probed, not assumed** — for a
native binary `node <path>` makes things worse. And **only 126 triggers
it**: any other failure passes through untouched, or the log would name
a different problem than the one that exists.

The chosen start is logged with its reason on every run, including the
normal one. A detour that stays silent is exactly the line missing next
time someone goes looking. There is no self-healing: the decision is
made once per run, so a changed mount needs a restart.

`test/start-command.sh` holds this to it, and produces the 126 with a
file whose shebang points at a directory — `execve()` returns `EACCES`
there, for root too. The obvious route (mode `0111`, unreadable) does
not work: root may read any file, so that run was green and checked
nothing.

---

## Lane 3 — Search (`src/search.mjs`, `src/thesaurus.mjs`)

```
score = BM25(tokens)              k1=1.2, b=0.75
      + thesaurus expansion       curated, weight 0.6
      + tag-graph expansion       learned, weight = nPMI (max 0.5)
      × field weight              title 3.0 … asked 2.0 … text 1.0
      × recency                   max +15%, halved after 90 days
```

Every expansion stays **below 1.0**, so a synonym never outranks a
literal hit.

Three things sit **beside** that score rather than inside it, because
each is a different kind of statement — and a weighted sum cannot say
which of its terms spoke:

- **The statistics exclude raw captures.** `docFreq`, `N` and average
  length come from the digested part only (`statsN`, `statsDocFreq`,
  `statsAvgLength`). The Stop hook files every message, so raw material
  contains every question verbatim — letting it decide what is *rare*
  makes the memory worse exactly where it is used most. Measured on a
  real memory: 53 % of average document frequency came from captures.
- **Raw is the reserve lane.** Captures fill only what curated entries
  leave open. A capture is by construction not yet a claim; putting one
  ahead of a reviewed decision makes lane 1 the main lane and the digest
  pointless. Measured: 42 % of injected slots went to captures, and
  every one of them was already digested — pure duplication.
- **An exact identifier match bypasses the threshold.** If the question
  names a path, ticket number, service name or version that occurs in at
  most `top` entries, that entry is admitted regardless of score. The
  threshold is for *similarity*; naming the thing is not similarity. The
  bound has no free parameter — it is the answer size. Limit: this helps
  when the question **names** the identifier, not when it **asks for**
  one.

And one field carries words that are deliberately **not** in the entry:
`asked`, written by the digest — three to five words someone would
*search* with. Retrieval cost: zero. Embeddings cost a call per query;
this costs a few tokens per digest run. Measured: gold in context
24/63 → 28/63, nothing lost.

### The tag graph is the actual trick

From the co-occurrence of your `tags` fields, via normalised pointwise
mutual information: if `ci` and `flake` appear together more often than
chance allows, they are associated. A search for `ci` then lifts
`flake` entries even when they never say "ci".

That **is** semantic association — learned from your own data instead
of bought from someone else's model. It needs at least two
co-occurrences, so a single coincidence never becomes a rule.

### Language

The tokenizer asks a language pack (`src/language.mjs`): stopwords,
character folding, stemming, and whether to attempt compound splitting.
`en` and `de` are complete; `nl`, `sv`, `da`, `no` get compound
splitting without stemming. An unknown language falls back to a neutral
pack — worse than a real one, but never wrong.

Compound splitting works against a lexicon built **from your own
corpus**: any word occurring twice on its own may be a part. No
dictionary file, no maintenance. It is on for English too, because
technical English is full of closed compounds — `datastore`,
`codebase`, `runtime`, `changelog`.

### Raw material is searchable immediately

The digest may take 45 minutes. In that window whatever was said would
be unfindable, although it has been on disk the whole time. So captures
are indexed as well — at weight 0.35 and marked `[raw, not yet
digested]`. Nothing is ever invisible; the delay affects only the
structure, not the findability.

### Where it honestly loses

True paraphrase with no lexical overlap. *"the customer was unhappy"*
finds *"complaint received"* only if a matching synonym pair exists.
For that case there are two escalations, never the default:

- `mem find-embed` — semantic search over the vector store alone.
- `mem find-hybrid` — runs BM25 **and** the semantic search and fuses the
  two rankings with Reciprocal Rank Fusion, so an entry surfaced by either
  ranker survives. RRF needs no score normalisation across the BM25
  magnitude and cosine scales — only the ranks matter, which is what makes
  it robust. Without embeddings configured it is exactly `mem find`, at
  the same cost; a missing key or empty store degrades silently to BM25,
  and the label reports what actually ran.

The measured shape of this loss lives in `bench/retrieval.mjs`: lexical
queries score 100% top-1, paraphrases reach 100% by rank 5, and the one
purely conceptual query sharing no term is the case `find-hybrid` exists
for. The benchmark prints that miss by name rather than burying it in an
average.

---

## Every check measures an effect

Learned the expensive way, three times in one deployment:

- The digest wrapper trusted the model's exit code. A session that
  failed on permissions exits 0.
- `mem doctor` read `core.hooksPath` and said "ok" while the hook could
  not execute at all (a `noexec` mount). A planted token was committed
  straight through.
- A size cap read an env var passed as an argument, so it was
  undefined, so every file counted as zero bytes, so the cap never
  applied.

All three looked healthy from outside. So: `mem hooks install` proves
itself with a decoy secret, `mem doctor` starts the hook rather than
reading its config, and the digest counts what actually changed.

And when a check fails, it fails **closed**: an unreadable file counts
as too large, a broken redaction stops the capture.
