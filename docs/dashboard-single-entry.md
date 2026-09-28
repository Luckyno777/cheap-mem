# The desk's single-entry route

**As of 2026-09-27.** `GET /entry.json?id=<id>` (`bin/mem-serve`) answers
with ONE entry, resolved directly through `dashboard.getEntryFast()`
(`src/dashboard.mjs`) — never through `dashboard.collect()`, which builds
every view of the desk, every drawer, every project, just to hand back
one row. This is cheap-mem's half of Bauplan D1; lucky-mem's mirror is
`schreibtisch.holeEintragSchnell()` (its commit `6f5280f0`, section "D1
Datenvertrag Einzelabruf" in its own dashboard coverage notes).

## The path taken

`getEntryFast(root, id)` locates the drawer through the same three
primitives `memory.findEntryLocation()` already uses —
`memory.listProjects`, `memory.TYPES`, `memory.iterLog` — walked in the
same order, stopping the instant the id turns up. It then reads:

1. drawers, one type at a time, until `id` appears (early stop — never
   every type of every project);
2. the ONE drawer it lives in, in full (for its line number, and for any
   correction or tombstone of it — both land in that same drawer, by
   the convention `memory.retireEntry()`/`memory.correctionEntry()`
   follow: they always append to the same `(type, project)` as the
   entry they retire or replace);
3. the `link` drawer, once per project (every hand-drawn edge touching
   `id`, in either direction).

Never all ~13 types across every project, and never the desk's own
markup.

## The contract

```
found       { state:'ok',      entry, source:{file,line}, asOf }        -> 200
not found   { state:'unknown', id, reason? }                            -> 404
unreadable  { state:'error',   id, reason }                             -> 500
partial     { state:'warning', entry, source, asOf, reason }            -> 200
```

- `state:'unknown'` means every drawer this route searched was readable,
  and none of them carried the id — never a guess dressed up as a clean
  miss.
- `state:'error'`/`'warning'` mean at least one source line could not be
  read while the answer was being built. That gap travels in `reason`;
  it is never folded into a silent not-found or a silently thinner
  answer.
- `asOf` is the mtime of the drawer actually read (`fs.statSync`), never
  an invented cache timestamp.
- `entry` carries the exact fields `dashboard.collect()`'s own `entries`
  array shows for that id, built from the same functions —
  `viewer.TYPE_LABEL`/`viewer.headline`, `basis.markOf`,
  `authority.tierOf`/`authority.authorOf`, `capability.scopeOf`,
  `dashboard.declaredDerivedFrom()`, `memory.retiredMap`, and
  `net.linksOf`. None of it is computed a second, competing way here.

## The one honest gap

`dashboard.collect()` finds an INCOMING `derived_from` edge, and the
citation count `memory.standing()` gives an entry, by reading every
drawer of every project and asking each entry there what it cites —
there is no address to look up "who cites this id" at, only that full
pass, which is exactly what this route exists to avoid paying for on
every single lookup.

**Closed by D1b.** Until D1b, `cited`, `backlinks` and `contradictedBy`
counted only this id's own drawer and the `link` drawer, and every
answer carried a constant `graphNote` saying so. Now the route reads
the backlink index (`src/backlinks.mjs`, E1.4): one file, built from the
same `net.linksOf()` in the same order as `dashboard.collect()`'s own
pass, so the same list. `graphNote` is gone. When the index is not
fresh (never built, corrupt, stale), the answer falls back to the
locally visible edges and says so as `state: 'warning'` with the
index's reason. `/entry.json` runs `backlinks.update()` first, which
rebuilds only when the corpus changed. Probe:
`test/backlinks-wired.test.mjs`.

## The desk's UI

**Superseded 2026-09-28.** The desk is gone. The dashboard's detail
drawer fetches one entry through `/dashboard/entry.json`
(`docs/dashboard.md`). The paragraph below is the record of the desk.

The desk's knowledge view already has a detail pane (`#detail` in
`src/astra.mjs`), but it is filled entirely from data embedded in the
page at build time, cut at `LIST_MAX` — by the same file's own stated
design ("no fetch, so there is no failed fetch"; see `dashboard.mjs`'s
header). There is no client-side code path in the desk today that
fetches a single entry, so `/entry.json` is not wired into that pane:
doing so would mean adding the very fetch that file's design
deliberately does not have, which is a larger change than this route.
An entry beyond `LIST_MAX` is reachable through this route directly
(`/entry.json?id=<id>`), just not yet from a click on the desk itself.

## Measured

| Field | Value |
|---|---|
| Measure | file opens (`fs.openSync`/`fs.readFileSync`) per single lookup |
| Baseline | grows with the whole corpus (every drawer of every project, several times over — `dashboard.readPass` + `viewer.collectMemory` + `consolePage.collect`) |
| Expected | independent of the corpus size (checked at two filler sizes, 20 vs. 4000 lines in unrelated drawers: same open count) |
| Abort | the surface breaks, or the answer disagrees with `dashboard.collect()` in substance |

Checked in `test/dashboard-entry-fast.test.mjs` (12 probes): the
`/entry.json` branch never calls `dashboard.collect()` (source
evidence); file opens at two filler sizes; a positive control against
the old path (`dashboard.collect()` + its `entries` map), including a
linked, contested and superseded entry; an unknown id → 404/`unknown`;
a broken line → `error`/`warning`, never a silent not-found; and the
same auth guard every other route on this server carries. Red on the
pre-D1 state (`97fc9db`) in a separate, detached `git worktree add`
(12 of 12 probes red), removed afterward.
