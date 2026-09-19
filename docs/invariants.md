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

## Two neighbours, same shape

Two more latches were built on 2026-09-18, in the same spirit: a narrow,
human-kept catalogue, a positive control on every run, and a third state
so the tool never has to be switched off.

### Calculations — `shared/calculations.jsonl`, `bench/calculations.mjs`

Does this house work the same thing out twice? The catalogue records,
per question that is answered by computing, which file owns it and what
a second version would look like. What is not in the catalogue is not
searched for.

The first run found one: `checkDrawers` in `src/doctor.mjs` walked every
drawer and counted its own unparsable lines — four hundred lines below
`checkIntegrity`, which calls `scanIntegrity` for the very same walk.
Neither was wrong. That is what makes the shape dangerous: they only
drift apart later, and then you believe the wrong one.

Every entry carries a marker (`// calculation: <id>`-style in the sister
house) inside its owner, and the tool checks that the pattern still fires
there. A pattern that matches nothing finds nothing and reports quiet —
the same silent no-op the invariant tool once had about itself.

One entry is `discarded` with its measurement: the drawer enumeration
(`Object.keys(memory.TYPES)`) occurs in 35 places, almost all of them
asking something else entirely. A latch that reports 34 innocents gets
switched off, and then it stops catching the guilty too.

### Doctor findings — `shared/finding-map.jsonl`, `bench/finding-mirror.mjs`

Do both houses know the same doctor findings? Measured on 2026-09-19:
27 here, 53 in the sister house, 21 of them the same question in two
languages.

An entry is either a pair, or reasoned one-sided (`nur: "finding"` /
`nur: "befund"`, naming the house by its call shape rather than by point
of view — the first version said "here", and the same file read from the
other house inverted every entry). `luecke: true` separates "rightly
absent over there" from "genuinely missing over there": as a count those
look identical and they are opposites. Ten gaps are named today, five of
them in the sister house — `environment`, `gitignore`, `integrity`,
`rollback`, `synonyms` — and five here: `abrufquote`, `dubletten`,
`offene-funde`, `plattenplatz`, `tagform`. `config` is no longer among
them: it is reasoned one-sided, because in this house the memory is any
folder with a config file that can be missing or broken, and over there
the repository *is* the memory.

Only the unjudged remainder is red. Without that, the tool would have
been permanently red on its first run — 27 findings only in the sister
house, almost all of them a subsystem this house does not have — and a
check that points at unfixable red gets switched off.

Both copies of the map must stay identical; each tool reports it when
they drift. That file describes a fact *between* the houses, so the same
sentence holds for both — unlike `invariants.jsonl`, where each house
writes its own prose under a shared id.
