# Invariants — what both houses have to know

`shared/invariants.jsonl` holds the lessons that do not concern this
project alone. Each under one id; each house writes its own prose.

## What it is for

On 2026-09-16 three defects were fixed in the project this tool was
extracted from. All three were still sitting here unchanged — they had
travelled across with the code and were never revisited. No tool found
them; somebody happened to look.

The obvious approach would have been a name-level diff between the two
sides: which module here corresponds to which module there. That needs
a maintained translation table — and a maintained table was decided
against the same day, for measured reasons (see
`docs/deliberately-not-built.md`, entity resolution).

So the comparison does not hang on names. It hangs on assurances.

## Two kinds

**`invariant`** — something that MUST hold and deserves a guard. Each
one carries the incident it came from, not a principle.

**`discarded`** — negative knowledge: measured, with the number, and
deliberately NOT built. The rarer and more expensive half. What nobody
writes down, the next session builds again — and only discovers after
measuring that the measurement already existed. Every discarded entry
therefore carries `neu_pruefen_wenn`: what would make the decision worth
retaking.

A discarded entry is never reported as uncovered. Demanding a guard for
it would push the next session towards the very thing that was decided
against.

## How a test declares itself responsible

A marker, anywhere in the test file:

```
// invariant: klon-marke-im-namen
```

The id is the contract between the houses; the word in front of it is
not. `invariante:` is read the same way, so each house can comment in
its own language.

## Looking

```
node bench/invariants.mjs
node bench/invariants.mjs --against /path/to/the/other/house
```

What gets reported:

| Finding | Means |
|---|---|
| `NO TEST` | in the catalogue, no test names it |
| `MARKER WITHOUT ENTRY` | a marker points at an id that does not exist — a typo, and it looks exactly like coverage |
| `MALFORMED MARKER` | a line that wants to be a marker and is not (missing colon, capital letter) |
| `CATALOGUE ONLY HERE/THERE` | one house does not know the lesson at all — heavier than an uncovered invariant |
| `GUARDED ONLY HERE/THERE` | both know it, only one guards it |

Exit 0 only when none of those is open. A catalogue with no invariants
exits 2 — nothing checked is not a pass.

## When an invariant does not apply here

Then that is a test, not an exemption list. A silent exemption stays in
place when the precondition changes; a test goes red. Write one that
asserts the precondition for non-applicability, so it fails the moment
the invariant starts to apply.

## Adding an entry

Append-only like everything else. One JSONL line, the same id in the
other house with its own prose. Then, in both houses, either build a
guard or — if it does not apply there — a test that fails as soon as it
begins to.
