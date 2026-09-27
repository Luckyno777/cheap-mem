# The desk's views, one module each

**As of 2026-09-27.** `src/astra.mjs` held all seven of the desk's
views — `deskView`, `knowledgeView`, `spaceView`, `projectsView`,
`agentsView`, `netView`, `setView` — plus the helpers they all leaned
on (`h`, `safeJson`, `CELL`, `INK`, `tone`, `NAV`, `LIST_MAX`) in one
1237-line file. Preparation for dashboard block D2-D8: several agents
extend one view each in parallel, and a shared file is exactly where
they would meet. This is a pure refactor — no behaviour change, checked
below — not new dashboard work itself.

## The split

- `src/astra/shared.mjs` — escaping, the study's palette, state-to-colour
  (`tone`), the rail's glyphs (`NAV`), `LIST_MAX`. Nothing view-specific.
- `src/astra/desk.mjs`, `knowledge.mjs`, `space.mjs`, `projects.mjs`,
  `agents.mjs`, `net.mjs`, `set.mjs` — one view function each, named
  after its id in `dashboard.VIEWS`. Each imports only what it needs
  from `shared.mjs` (and, for `desk.mjs`/`net.mjs`, from
  `dashboard.mjs`/`net.mjs` directly — the same modules the whole view
  already depended on).
- `src/astra.mjs` stays the facade: same exports (`VIEWS`, `LIST_MAX`,
  `renderHtml`, `build`), same signatures, every caller unchanged. It
  imports the seven view functions and wires them into `renderHtml`;
  the CSS and browser-side `SCRIPT` templates stay here too, since they
  are shared across every view's tab, not owned by one of them, and
  `test/astra-design.test.mjs` reads them from this file directly.

Not split: `src/dashboard.mjs` (the data layer `astra.mjs` already
called through `dashboard.collect()` — untouched) and `src/net.mjs`
(the declared-edges data module — untouched; `src/astra/net.mjs` is a
different file that happens to share the view id `net`).

**Why a subdirectory, not `src/astra-<view>.mjs`.** Two module-count
guards read `src/` non-recursively (`bench/readme-numbers.mjs`'s
`modules` counter, `test/capability-doc.test.mjs`'s `modules()`), the
same way `src/cli/commands/` and `src/embed/` already sit as
subdirectories without inflating that count. A flat
`src/astra-<view>.mjs` would have added seven names to that count for
a refactor that changes no behaviour and answers no capability
question; `src/astra/<view>.mjs` follows the house's own precedent
instead. `test/english-only.test.mjs`'s walker and `package.json`'s
`"src/"` files-glob both recurse, so the new files are covered for
German-comment scanning and for the published tarball without any
change to either.

## Measured

| Field | Value |
|---|---|
| Metric | lines in `src/astra.mjs`; view functions declared per file |
| Baseline | `src/astra.mjs` was a 1237-line file holding all seven views |
| Expected | `src/astra.mjs` shrinks to the facade (CSS/SCRIPT/renderHtml/build); each view function declared in exactly one file under `src/astra/`, never in `astra.mjs` itself (latched by `test/astra-modules.test.mjs`) |
| Abort | the rendered HTML or the collected data for the fixed fixture corpus, at a fixed `now`, is not byte-identical to the pre-split output |

**The byte-identity probe.** `git worktree add --detach <path> HEAD`
checked out the pre-split commit (`09c9a9a`) into a separate directory,
kept only long enough to render once, then removed
(`git worktree remove`). One fixture memory (agents, a decision, an
error, a duty, a question, an event, three declared links including one
dangling, one retired entry, and 430 filler entries past `LIST_MAX`) was
built once and read, unmodified, by both checkouts' `astra.build()`,
with the same fixed `now` (`2026-02-01T00:00:00Z`), `title`, `cfg` and
`env`. Old and new agreed byte for byte:

```
out-old.html   359984 bytes  sha256 48bbec05…acf8f5
out-new.html   359984 bytes  sha256 48bbec05…acf8f5
out-old.json   300716 bytes  sha256 4bd80020…505551
out-new.json   300716 bytes  sha256 4bd80020…505551
```

(`.json` is `astra.build()`'s returned `data`, i.e. `dashboard.collect()`'s
output as `astra.mjs` sees it — unaffected by this refactor by
construction, included as a second, independent check.) `VIEWS` and
`LIST_MAX` matched too. The probe files were scratch scripts, not
committed — the structure latch below is what stays.

**The structure latch.** `test/astra-modules.test.mjs` keeps the
promise from drifting back: each of the seven view functions is
declared in exactly one file, that file lives under `src/astra/`, no
two views share a module, and `astra.mjs` itself declares none of them.
It also checks the facade's export surface has not changed shape.
