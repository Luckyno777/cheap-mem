# Benchmarks — a snapshot, 2026-09-28

This is a dated record, not a living claim (see `test/doc-archive.mjs`
`isArchive()` — any filename with a date is exempt from the number
ratchets that guard README.md and the other living docs; numbers here
are free to move and are not re-derived by any test). Every figure below
was re-run on this date, on commit `ddb741f`, with the exact command
next to it. The README's own guarded numbers (`<!--packed-size-->`,
the CLI/MCP/module counts, the test count) are the living source of
truth and are not duplicated or hand-edited here — this page is the
place for the numbers that do not have a ratchet test of their own yet.

## Retrieval quality (synthetic labelled corpus)

cheap-mem ships empty — there is no grown, personal corpus to measure
against (see [Where your data goes](../README.md#where-your-data-goes)).
The only quality numbers this house can honestly report are against the
labelled synthetic corpus in `bench/retrieval.mjs` (67 entries, 42
queries), the same one the README's own "Does it actually find things?"
section quotes.

Command: `node bench/retrieval.mjs`. Re-run 2026-09-28:

```
set            n    R@1   R@3   R@5  R@10    MRR
lexical       20   100%  100%  100%  100%   1.00
paraphrase    16    50%   81%   88%   88%   0.65
concept        6    67%   83%   83%  100%   0.77
overall       42    76%   90%   93%   95%   0.83
```

Unchanged from the README's own quote (no drift since the last
measurement referenced there). Pure search latency at this corpus size
(**historical: 2026-09-28, commit `ddb741f`, WARM — index already loaded in
the process, search alone, not a fresh `mem find`**): median 0.048 ms, p95
0.199 ms over 8400 samples (same run). It differs from the 0.027 ms the
README used to quote for the same thing (another run, same warm state). Current
figures, cold and warm, with commit and hardware, are in
`bench/cold-find.json` and the README's Latency table.

**Not measured here, and why:** a real, grown, human-labelled corpus —
the equivalent of lucky-mem's `bench/nl-gold.mjs` (German, against
lucky-mem's own ~2500-entry memory: Top-1 42%, Top-3 67%, MRR 0.51,
measured 2026-09-28, see `lucky-mem/betrieb/MESSWERTE.md`). That number
is **not** transferable here — different language, different corpus,
different age. `bench/atlas/phase-real.mjs` names this exact gap in its
own header ("Section C is one blind spot named on purpose"); the
Atlas proposal in lucky-mem's `betrieb/ATLAS-VORSCHLAG.md` (phase
`P1`/`P2`) proposes folding both gold-set styles into the Atlas report.

## Install size

Command: `npm pack --dry-run --json`. Re-run 2026-09-28:

**886.9 kB packed, 2.6 MB unpacked, 192 files, 0 runtime dependencies.**

The README's own guarded figure (`<!--packed-size-->` marker,
`test/package-size.test.mjs`) currently reads 831 kB; the two are within
the test's own 15% tolerance (factor 1.07) and both are true statements
about a house that is being actively built — the guarded number is the
one `npm test` re-checks on every run, this one is a today snapshot. The
project's own history is worth repeating here because it is the reason
this number gets tested at all: on 2026-09-05 the README said 588 kB;
`test/package-size.test.mjs`'s own header records that by 2026-09-19
`npm pack` actually reported 4.8 MB (a GitHub branding kit had ridden
into the tarball unnoticed) — a factor of 8, caught by grepping, not by
a test, until this guard was written. The 588 kB figure from
2026-09-05 should not be quoted as current; it was already stale before
this task started.

## Test count

From the counting script, not by hand (`test( ` call sites under
`test/*.test.mjs`, the same count `test/readme-zahlen.test.mjs` checks
the README against with a 2% tolerance): **2240**, unchanged from the
README's own "As of 2026-09-26" line — no drift on this date.

## Hook / retrieval latency by trigger

Not yet broken out by trigger occasion the way lucky-mem's
`src/latenzbudget.mjs` does (before-edit / on-question / after-failure).
`bench/atlas/phase-load.mjs` measures wall-clock latency through the
real CLI process as corpus size grows (documented 2026-09-05 baseline:
1k → 0.785 ms p50 pure search, 10k → 7.4 ms, 100k → 114 ms), but not
split by what triggered the call. This is gap **P5** in the Atlas
proposal (lucky-mem's `betrieb/ATLAS-VORSCHLAG.md`).

## Scaling

Not independently re-measured on this date. `bench/atlas/phase-ceiling.mjs`
extrapolates to 5,000,000 entries with an honest counter-check (one rung
of the ladder held back, the fit re-checked against it) and names five
concrete walls (JSON parse limit ~978,395 entries, whole-file-read
memory, linear scan, append contention, git transport cost) rather than
a single number — see that file's own header for the full 2026-09-05/
2026-09-20 measurements it is built on. Re-running it end to end took
longer than this task's "keep load small" budget allowed; it was not
forced. Command to reproduce: `node bench/atlas.mjs --quick --phase ceiling`.

## Atlas — the full-surface benchmark

`node bench/atlas.mjs` runs all eight phases (surface, load, doctor,
defence, robust, ceiling, register, real) and writes a diffable JSON +
Markdown report under `bench/atlas-out/` (gitignored). Run 2026-09-28
in this environment (`--quick --phase surface,doctor,defence`, own
`TMPDIR`, to keep load down): **211 pass, 4 fail, 3 degraded, 12
not-measured, 16 named blind spots** (mostly missing optional
dependencies in this container — `@modelcontextprotocol/sdk`,
`VOYAGE_API_KEY` — not a design gap). The four `fail`s are real product
findings (two wrong `mem doctor` exit codes, a flood-defence number that
undershoots its own documented cap, tamper detection catching only 1 of
5 scenarios) — not Atlas bugs, and not fixed as part of this
documentation task. Full assessment, six identified gaps, and six
proposed new/rebuilt phases (retrieval quality on a real corpus,
latency by trigger, privacy/redaction probes, disk-full/kill-mid-write
robustness, a fair foreign-system comparison, and porting the whole
apparatus to lucky-mem for parity): lucky-mem's
`betrieb/ATLAS-VORSCHLAG.md` (German; the assessment itself, not the
proposal text, applies to this house too).
