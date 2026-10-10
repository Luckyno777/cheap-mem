# Recall levers ported from lucky-mem: measurement (2026-10-10)

Two levers of lucky-mem's recall hook were ported to the recall hook of cheap-mem:

- **Request frame** (`src/requestframe.mjs`, `MEM_RETRIEVE_REQUEST_FRAME`): a request verb that opens a
  question ("explain relativity", "please show me X", "can you tell me X") is not a word of the subject
  and is not searched. **On by default.**
- **Cut with a guard for a tie** (`src/tiecut.mjs`, `MEM_RETRIEVE_TIE`): the first hit behind the cut that
  scores within a relative spread (1 % in lucky-mem) of the last shown hit comes along, at most one.
  **Built, shipped OFF by default** (`MEM_RETRIEVE_TIE=0.01` switches it on).

Both act on the hook's own call only (`mem find --recall`); an explicit `mem find --top N` stays N.

## How this was measured

`node bench/recall-levers.mjs` (add `--size 3000` for the larger memory, `--json` for the raw numbers).
Source of every number below. Run at the commit that adds the script; the old state is the pinned commit
`b5959ed38a2d859a762df7da893f6ce17b0ee0cb` (origin/main before the two levers), taken with `git archive`
and run with the hook call it made then (no `--recall`).

- Every question goes through the hook-shaped call `mem find Q --top 3 --recall --json`; "shown" is what
  clears the hook's own bar (score >= 5.0, or an exact hit).
- Sets: the 45 gold cases with an expected id (`bench/gold/cases.jsonl`, the known gap excluded), the same
  cases wrapped in a request frame, the 28 decoys (`bench/gold/decoys.jsonl`), the decoys wrapped the same
  way. The wrapped sets are derived and synthetic: they show what a frame does to a question that has
  one, not how often real questions have one.
- "pass" = an expected id is shown and no forbidden id is shown. "forbidden shown" counts cases with a
  forbidden id in what is shown. "answered" = a decoy got at least one shown hit (target 0).
- Worlds: the 54-entry gold world alone, and the same world inside 3000 synthetic notes
  (`bench/scale.mjs`, seed 42).

**Not comparable with lucky-mem's numbers.** lucky-mem measured on a sample, a held-back set, 12 decoys
and a 35-question synthetic world. Here there is one synthetic gold set, no held-back set and nothing from
a real memory. The numbers show whether a lever costs gold here, not how much it gains elsewhere.

## Results

Gold world only (54 entries):

| | old state | frame only (shipped) | tie only | both |
|---|---|---|---|---|
| gold pass (of 45) | 29 | 29 | 29 | 29 |
| gold, framed (of 45) | 28 | 29 | 28 | 29 |
| hits shown, gold / framed gold | 34 / 31 | 34 / 34 | 34 / 31 | 34 / 34 |
| decoys answered (of 28), plain / framed | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |

The tie lever never fired at the hook bar in this small world (13 candidate extra hits, none above 5.0).

3000 notes:

| | old state | frame only (shipped) | tie only | both |
|---|---|---|---|---|
| gold pass (of 45) | 34 | 34 | 33 | 33 |
| forbidden shown (cases) | 1 | 1 | 2 | 2 |
| gold, framed (of 45) | 34 | 34 | 33 | 33 |
| hits shown / bytes, gold | 84 / 20647 | 84 / 20647 | 94 / 22971 | 94 / 22971 |
| hits shown / bytes, framed gold | 92 / 22864 | 84 / 20647 | 107 / 26525 | 94 / 22971 |
| decoys answered (of 28), plain | 7 | 7 | 7 | 7 |
| decoys answered (of 28), framed | 8 | 7 | 8 | 7 |

### Request frame

Neutral on the plain questions (no plain gold question starts with a request verb, so there is nothing for
it to change), and it removes the cost of a frame: a framed gold question returns what the plain one
returns (28 to 29 in the small world, 92 hits back to 84 at 3000 notes), and one framed decoy stops
getting an answer (8 to 7). That is the same direction as lucky-mem's finding (a decoy fewer, gold
unchanged). Kept on.

### Cut with a guard for a tie

At 3000 notes the lever added 10 hits to 45 questions (84 to 94, +11 % bytes) and gained no gold:

- 0 of the 10 extra hits is an expected entry.
- 7 of the 10 extra hits lay ABOVE the score of rank 3. They are not ties: MMR had moved them behind a
  lower-scoring but more diverse hit, and the rule takes them back (the rule as ported says "at most x
  below", so a hit above qualifies, as in lucky-mem). Only 3 are real ties below or equal.
- The one gold loss is `time-07` ("who is on call"): the extra hit is `g-oncall-old`, an older version of
  the same decision (9.09 against 9.12 for the newer one). The case forbids the older version, so the
  forbidden +1 turns a pass into a failure. Whether showing both versions is wrong for a person reading
  them is a different question; the gold case says it is.

No evidence of a gain on this set, one case lost, and a cost in bytes: so the lever ships off. Its
tests (`test/tie-cut.test.mjs`) switch it on explicitly and have a probe that the default cuts hard at
`top`. Open questions for a later decision: restricting the extra hit to scores at or below the last shown
one would drop the 7 MMR-displaced hits but not the `time-07` loss; a memory with many near-duplicate
versions may behave differently from this synthetic one.

## Reproduce

```
node bench/recall-levers.mjs               # about 4 minutes
node bench/recall-levers.mjs --size 3000   # about 6 minutes
```
