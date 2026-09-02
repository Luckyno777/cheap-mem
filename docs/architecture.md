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

---

## Lane 3 — Search (`src/search.mjs`, `src/thesaurus.mjs`)

```
score = BM25(tokens)              k1=1.2, b=0.75
      + thesaurus expansion       curated, weight 0.6
      + tag-graph expansion       learned, weight = nPMI (max 0.5)
      × field weight              title 3.0 … text 1.0
      × recency                   max +15%, halved after 90 days
```

Every expansion stays **below 1.0**, so a synonym never outranks a
literal hit.

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
