# Star-search experiment — 2026-09-29

A dated snapshot (see `docs/benchmarks-2026-09-28.md`'s own note: a
filename with a date is exempt from the number ratchets that guard
README.md — these numbers are not re-derived by any test and are free
to go stale).

## The question

Lucky asked whether a Windows-search-style prefix operator
("`hoden*`") would bring more results. Two things were built to answer
it:

1. **The explicit operator** (shipped): `word*` in `mem find` (behind
   `--wildcard`, opt-in), the dashboard's retrieval probe, and
   `mem_find` over MCP. See `src/search.mjs`'s `resolveWildcards()` /
   `expandWildcardPrefix()`. The automatic retrieval hook
   (`bin/mem-retrieve` -> `mem find "$PROMPT" --top N --json`) never
   passes `--wildcard`, so it is unaffected — proved in
   `test/wildcard-prefix.test.mjs`.
2. **This measurement**: what would happen if prefix expansion were
   applied IMPLICITLY, to every long query word, with no `*` and no
   opt-in — i.e. baked into the automatic path. Answered offline, in
   `bench/`, wired into nothing.

## Corpus

cheap-mem ships empty; there is no grown, human-labelled gold set with
a matching decoy/bait set the way lucky-mem's
`bench/selten-wort-gold.tsv` + Köder set are (see
`docs/benchmarks-2026-09-28.md`'s "Not measured here, and why" —
that gap is named there independently of this build). The only
labelled corpus this house has is `bench/retrieval.mjs`'s synthetic
one: 67 entries, 42 queries, three kinds (lexical / paraphrase /
concept). That is what this experiment runs over —
`bench/star-search-experiment.mjs`.

## The four variants

| # | variant | what it does |
|---|---|---|
| 0 | today | `search()` exactly as shipped |
| 1 | implicit-prefix | every query token ≥5 chars is ALSO expanded as a prefix (0.45 weight, same discount and mechanism as the explicit operator), silently, no `*` |
| 2 | compound-split | **finding, not a knob**: `buildIndex()` already splits compound index terms by default, for English too (`splitCompound`, technical compounds like `datastore`/`codebase`/`runtime`) — there is no still-off switch to flip without editing `src/`, which this experiment does not do. Measured as identical to variant 0. |
| 3 | both | 1 + 2, which given the above is exactly variant 1 |

## Measured (2026-09-29, `node bench/star-search-experiment.mjs`)

```
variant                      R@1   R@3   MRR  median ms  p95 ms
---------------------------------------------------------------
today                        76%   90% 0.833      0.051   0.212
implicit-prefix              76%   90% 0.833      0.053   0.164
compound-split (= today)     76%   90% 0.833      0.051   0.169
both (= variant 1)           76%   90% 0.833      0.057   0.147
```

`today`'s numbers match `docs/benchmarks-2026-09-28.md`'s own snapshot
(R@1 76%, R@3 90%, MRR 0.83) — the same corpus, the same queries, no
drift.

Latency: p50/p95 move within noise across variants (~0.05–0.06 ms
median, sub-run-to-run variance on a corpus this small); the honest
statement is "no measurable cost", not a specific percentage, at 67
entries. `bench/atlas/phase-load.mjs`'s larger-corpus numbers
(1k/10k/100k) were not re-run with this change — a real cost, if any,
would show up there, not here.

## Reading it

Implicit prefix expansion moved **zero** queries on this corpus, in
either direction. Two candidate reasons, not separated by this
experiment:

- the synthetic corpus's vocabulary is small and mostly disjoint per
  query, so a 5+-char prefix rarely lands on more than the word
  already found literally;
- BM25's own scoring plus the coverage floor may already be doing what
  the prefix expansion would add, on THIS corpus.

A larger, real, human-labelled corpus (the gap `docs/benchmarks-2026-09-28.md`
already names) is the more honest place to re-run this before drawing
a conclusion either way.

## Recommendation for the automatic hook

**Do not wire implicit prefix expansion into `bin/mem-retrieve`.**
Reasons:

1. Measured zero benefit here — nothing quantifies the "more results"
   Lucky asked about, on the one corpus available.
2. It would remove the "small factor <1, exact beats expansion"
   safety property from a path nobody can intervene on: the automatic
   hook already over-triggers on common short words in some corpora
   (see `test/coverage-floor.test.mjs`'s dilution finding), and a
   silent prefix expansion widens the candidate set precisely where
   that is riskiest — no human is reading the query before it runs.
3. The explicit operator already gives a person (or an MCP-connected
   agent, or the dashboard) the "more results" lever on demand, with a
   visible signal (the `*`) and a visible discount, without changing
   what the hook shows on every single turn.

If Lucky wants this re-opened, the next step is not "ship variant 1"
but "get a real gold+decoy set for cheap-mem" — without one, "helps"
and "measured zero, on 67 synthetic entries" are the same sentence.
