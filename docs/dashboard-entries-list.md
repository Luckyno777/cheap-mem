# The desk's paged list route

**As of 2026-09-27.** `GET /entries.json?type=&project=&q=&after=<cursor>&n=`
(`bin/mem-serve`) answers with ONE page of entries, filtered server-side
and resolved directly through `pages.page()` (`src/pages.mjs`) — never
through `dashboard.collect()`, which builds every view of the desk,
every drawer, every project, just to hand back a slice of one list.
This is cheap-mem's half of Bauplan E1.3; lucky-mem's mirror is
`seiten.seite()` (its commit `01da1319`, section "E1.3 Datenvertrag
Listen" in its own dashboard coverage notes).

## The path taken

Type/project filters decide WHICH drawers are opened at all — "over the
drawers", never a corpus pass afterward. From there:

- **without `q`:** `memory.iterLog()` (already streaming, constant
  memory per line) over exactly the drawers the filter selected;
- **with `q`:** the EXISTING search path, `search.loadIndex()` /
  `search.search()` — not a second, hand-rolled text search. The
  candidates come straight out of the search index, without opening the
  drawers a second time.

Both paths feed the same narrow top-N selection: at most `n` entries are
ever held at once during the pass, never the whole hit set or the whole
drawer.

## The contract

```
page               { state:'ok',      entries, next, asOf }        -> 200
partial            { state:'warning', entries, next, asOf, reason } -> 200
unknown filter     { state:'unknown', entries:[], next:null,
                      asOf:null, reason }                          -> 400
unreadable         { state:'error',   entries:[], next:null,
                      asOf:null, reason }                          -> 500
```

- `state:'unknown'` means the FILTER itself names something that does
  not exist (a type outside `memory.TYPES`, a project outside
  `memory.listProjects()`/`'global'`) — no corpus pass, no guessing. A
  valid filter with no matches is `state:'ok'` with `entries:[]`, never
  `'unknown'`.
- `state:'error'` means the cursor could not be read, or the search
  index for `q` could not be built. A broken cursor NEVER silently
  answers page 1.
- `state:'warning'` carries two independent reasons, together in
  `reason`: (a) at least one source line could not be read while
  building this page, (b) the corpus mark in the given cursor no longer
  matches the current one ("Corpus changed", see below). Either way a
  page still comes back — never a silent nothing.

Every entry on a page carries exactly: `id`, `ts`, `type`, `typeLabel`,
`project`, `headline`, `agent`, `basis`, `tags`, `source` — the same
narrow fields `dashboard.collect()`'s own `entries` array would show,
built from the same functions (`viewer.TYPE_LABEL`/`viewer.headline`,
`basis.markOf`), but with no graph edges: computing `net.linksOf()` per
row would be a `link`-drawer scan PER ENTRY of a page, which would blow
the file-open ceiling immediately. A caller that needs the edges of one
entry calls `/entry.json` (`dashboard.getEntryFast()`, D1) for that id.

## Stable order and the cursor

`ts` descending, `id` ascending on a tie — `id` is unique and immutable
per entry, the only field that gives an exact, repeatable order when two
entries share a timestamp exactly (not rare: several lines written
within the same second).

The cursor encodes `(ts, id)` of the last entry shown on this page, plus
a `stamp`: a fingerprint over exactly the drawers this filter touches
(path + size + mtime of each file, plus the filter's own
type/project/query context), modelled on `search.corpusStamp()`'s own
reasoning (stat, not content) but scoped to the touched drawers plus the
filter rather than the whole corpus. If the stamp on the next call
disagrees, the answer is `state:'warning'`/"Corpus changed" rather than
silently turning the page.

**Why this is not `test/paging.test.mjs`'s cursor, rebuilt.** That file
removed a cursor over RANKED search results because the selection
producing a ranked top-k (author-share cap, context budget, MMR) works
on the *selection*, not the corpus — two pages of the *same* corpus came
back with one entry duplicated, and a snapshot-bound cursor could not
tell "the corpus changed" apart from "the question changed". `pages.mjs`
never ranks: without `q` there is no selection to drift; with `q` the
search call asks for the UNRANKED, COMPLETE candidate set
(`minScore: 0, mmr: false`, `top` at least the whole index) and discards
`search()`'s relevance order — only its candidate list survives, sorted
afterward by the same `(ts, id)` rule the no-`q` path uses. One
selection rule, not two that can quietly disagree.

## The known gap

`buildIndex()` (`src/search.mjs`) drops a document from the index
entirely when it has zero weighted terms (`addDoc`'s
`if (doc.weights.size === 0) return;`) — an entry with none of the
weighted fields (`title`, `topic`, `tags`, `text`, … the full list is
`FIELD_WEIGHTS`) is never a `search()` candidate, no matter the query.
So a page filtered by `q` can miss such an entry even though the very
same entry shows up fine on a page with no `q` — the no-`q` path reads
the drawers directly and does not care whether an entry has any weighted
text at all. This is the same CLASS of gap lucky-mem's own mirror names
for its `q` path (an entry the index's own build chose to skip stays
invisible to a text query, however the query is phrased), reached here
by a different cause (empty weighted content, not a default index-scope
choice). `withRetired: true` is passed on every `q` call, so a retired
entry is specifically NOT part of this gap.

Checked directly in `test/pages.test.mjs`'s "known gap" probe: an entry
with only structural fields (`id`, `ts`, `version`) is found on a page
with no `q`, and missed on a page with `q` naming the very value it
carries.

## Measured

| Field | Value |
|---|---|
| Measure | file opens (`fs.openSync`/`fs.readFileSync`) per page, at a fixed type/project filter |
| Baseline | not measured (the route did not exist before this task) |
| Expected | independent of the corpus size within the touched drawers (checked at a 20-row vs. a 4000-row filler in the same drawer: same open count); with no type/project filter, independent of content, dependent only on the drawer count |
| Abort | a page duplicates/loses entries across several pages, a broken cursor answers page 1 instead of `error`, or a corpus change between two pages goes unnoticed |

Checked in `test/pages.test.mjs` (probes (a)-(f) plus extras, in the
order the assignment names them): (a) all pages in sequence give the
full, stably sorted list without a duplicate or gap, including ties on
an identical timestamp (tie-break by id); (b) a `q` hit beyond the
first page is found through the cursor; (c) a corpus change between two
pages -> `warning`/"Corpus changed", unchanged stays `ok`; (d) a broken
cursor -> `error`, never page 1 (function level and HTTP 500); (e) file
opens per page are bounded at a fixed type/project filter, and without
a filter depend only on the drawer count, not the content; (f) the same
auth guard every other route on this server carries applies unchanged
(a wrong token gets the same bare 404, a valid request carries the same
`cache-control: no-store` header); plus an unknown type/project ->
`unknown` (function level and HTTP 400), a valid filter with no hits
stays `ok` with an empty list, a broken line -> `warning`, type/project
filters provably select only the matching drawers, the contract shape
per state, the page-size cap, cursor encode/decode as inverses
(including every malformed input -> `null`, never a crash), and the
known gap above. Red on the pre-E1.3 state in a separate, detached
`git worktree add`, removed afterward (the new test file fails with
`ERR_MODULE_NOT_FOUND` — the module does not exist yet).

## The list as a page (D3b, 2026-09-30)

`GET /entries?type=&project=&q=&after=<cursor>&n=` (`src/entries-page.mjs`)
answers with the SAME list as `/entries.json`, rendered by the server as
a page in the dashboard's look — this is what the "Full list page" link
in Knowledge → Entries opens in a new tab, instead of the raw JSON.

- Same filters, same cursor, same `pages.page()`; there is one list.
- A plain GET form (type, project, text) and a "Next page" link that
  carries the cursor. No script, nothing loaded from outside.
- The four states are visible: `ok` (good), `warning` (with its reason,
  the readable rows still shown), `unknown` (a filter that names
  something that does not exist, HTTP 400, its own dashed tone), `error`
  (HTTP 500). A valid filter without matches is `ok` and says so: an
  empty list is not an error.
- Host check (`HOST_GUARDED`, now also on `/entries.json`), no CORS
  header, the dashboard's content security policy, behind the token door
  like every route.
