# cheap-mem — security model, data model, environment contract

Describes what is **built**, as of 2026-09-05. Where something is not
solved it says so; where a guarantee stops, it says where.

Reproduce every claim marked *measured*:
`node bench/redteam.mjs`, `node bench/selectivity.mjs`, `node bench/scale.mjs`,
`npm test`.

---

## 1. The primitive: a claim

Every line in every drawer records **someone asserting something at a
time**. Not a fact (facts do not need `replaces_id`), not an event (that is
one drawer), not an observation (that loses the author).

```
id           identity, for reference and supersession
ts           transaction time — when the log learned it
body         the entry's own fields (choice/why/title/text/fact)
author       who asserts          — absent in pre-authority data
authority    the tier asserted in — absent reads as `unknown`
project      → scope
replaces_id  optional: the claim this supersedes
valid_from   optional: when the content began holding (default: ts)
valid_until  optional: when it stopped (exclusive)
```

**Derived, never stored.** `status` (active / superseded / disputed /
revoked) is computed from other claims at read time. Storing it would
require mutation, which is the one thing this design refuses. Same for
`topic` areas and for scope, which comes from `project`.

---

## 2. Authority

`user > system > agent > external > inferred > unknown` (`src/authority.mjs`).

Categorical with a total order, not a number. A float nobody can calibrate
becomes a number everybody rounds to "probably fine", and two 0.7s from
different pipelines are not comparable. Tiers compare because they are
defined by *who* asserted — which is checkable — rather than by *how sure*
someone was, which is not.

**One rule, no third case.** A supersession is honoured when the same
author corrects their own claim, or when a strictly higher tier overrules a
lower one. Otherwise the target stays active and the attempting claim reads
as `disputed`. Two `user`-tier lines count as the same author even when
different sessions wrote them down: `user` is one person, the writer is only
the scribe (aligned with lucky-mem, 2026-09-30). Agent against a different
agent stays strict.

**Legacy data still corrects.** An entry written before the rule has
neither field: both authors null, both tiers `unknown` → same author, same
tier, allowed. A rule that retroactively invalidated every correction ever
made would be a migration disguised as a security fix.

**Where it ends.** `author` and `authority` are fields in a file. Anyone
who can write the repository can write both. This raises the cost of
poisoning from ONE LINE to REPOSITORY WRITE ACCESS. It is not cryptography.
Signed commits would close it and are out of scope until someone has the
threat model that needs them.

---

## 3. Scope

A capability (`src/capability.mjs`) is a value the caller must hold.
Narrowing always succeeds; widening has no method — `grant` is the only way
to mint a broader one, from an identity, and it is a named call that greps.

Scopes are a **lattice**, not a chain: `global > org > project > agent >
session` cannot express "shared between two projects", which the digest and
the inbox already need.

**Two layers, and only one is a boundary.**

| layer | what it is | boundary? |
|---|---|:--|
| `search()` | a ranker over an index | **no** — `project` is an optional filter |
| `retrieve()` | the gateway | **yes** — fails closed, no capability no results |

Stated because the benchmark shows both: `search()` without a project still
returns everything, and that is its job. Code that needs a boundary calls
the gateway.

**`global` is the root, not a sibling.** Facts belonging to no project —
the person, the timezone, the setup — are visible to every read
capability. Found by attacking this design after building it: a project
capability first returned nothing global at all, which in production reads
as "the memory forgot who I am". A global fact is by definition not another
project's secret.

**Where it ends.** In-process. Another process can construct a permissive
capability; this is not a sandbox. What it prevents is the accident — the
forgotten argument, the copied call site, the helper that quietly widened.
That is what was measured.

---

## 4. Untrusted memory

`Memory ≠ Instruction` is enforced structurally, ranked by how much each
layer depends on a model behaving:

1. **Retrieval returns records, never a blob.** The body is the entry's own
   words joined in a fixed order — no framing, no headings, no word the
   entry did not contain. Depends on nothing.
2. **Authority travels with every claim**, so a consumer can weigh
   `external` differently from `user`. Depends on nothing.
3. **`evidence` is a pointer, never a copy.** Fetching is the caller's
   decision at the caller's authority.
4. **The body is never a template.** No interpolation on the read path.
5. **Labels in the envelope** — the only layer that depends on the model,
   and therefore last.

**Not solved.** A client can flatten structured fields back into a
paragraph, and then an injection in a body is an injection. MCP's
`structuredContent` does not prevent that; it removes the step where the
*memory* does the flattening, which is the step this side of the boundary
controls.

---

## 5. Conflict and time

- scopes do not intersect → not a conflict
- validity intervals do not overlap → not a conflict, a history
- a valid `replaces_id` → resolved
- overlapping, different tiers → higher tier wins
- overlapping, same tier → **not resolved**, surfaced

cheap-mem resolves only where resolution is mechanical. Interval and scope
comparison are arithmetic; the tier order is declared. Genuine same-tier
contradiction is a judgement, and a memory that judges silently is a memory
nobody can audit.

**Not solved: contradiction detection.** Nothing here decides that "uses
PostgreSQL" and "uses SQLite" contradict. Only explicit `replaces_id`,
overlapping validity and scope are checked. Detecting semantic
contradiction deterministically is open.

`ts` = when recorded. `valid_from` = when the content began holding
(inclusive, defaults to `ts`). `valid_until` = when it stopped
(**exclusive** — half of all interval bugs are this choice left unstated).
An `as_of` query filters on validity; the recency bonus ignores future
timestamps (`ageDays >= 0`), so a 2099 entry buys nothing — measured.

---

## 6. Resource bounds

`src/retrieval.mjs LIMITS`. Every one has a number; none is unbounded.

| bound | default | why |
|---|--:|---|
| query chars | 2000 | past this it is a paste, not a question |
| max results | 50 | a hard ceiling regardless of what a caller asks |
| body chars | 4000 | per claim, in the returned record only |
| context chars | 24000 | total across returned bodies |
| per-author share | 0.5 | no sub-user author takes half the CANDIDATES |
| entry bytes (write) | 1 MB | see below — a WRITE bound, not a retrieval one |

**A separate bound on the write path, not this table's `LIMITS`.**
`memory.MAX_ENTRY_BYTES` (`src/memory.mjs`) is checked in `logEntry`,
against `Buffer.byteLength` of the FINISHED JSON line — not any one
field, which a cap on a single field is trivially evaded by splitting
across several. It exists because `search.RAW_CAP` (20 KB) only trims
what the search index *weighs*; nothing bounded what `logEntry` was
*willing to write*, and a 7.6 MB field value went through without a
word (external audit, 2026-09-19). Over the cap: refused with the
actual and the allowed size in the error, never a silent truncation — a
truncated entry looks complete and is not, which is worse than none.
Configurable via `.mem/config.json`'s `maxEntryBytes`. Does **not**
apply to `raw/` captures (gzipped transcripts, written directly by
`src/raw.mjs`, which never calls `logEntry` at all and has no
per-field size bound of its own) — a capture is a copy of what a
session actually said, and a cap shaped for one typed entry is not the
right instrument for that. `search.RAW_CAP` still limits how much of a
capture the search INDEX weighs; nothing here limits what is written to
the capture archive itself.

The author limit is a **share**, not a flat count: a digest agent
legitimately writes most of a memory, and a flat cap would suppress the
most useful author. `user` tier is exempt — the owner cannot poison their
own memory in the sense this defends against.

**The share is of the candidates, not of the answer, and the difference is
not small.** The filter shrinks its own denominator: 9 flood claims plus 1
genuine one give cap 5, four are dropped, and the answer is 6 — of which 5
are the flood. A promised 50% delivers 83%. Measured by
`bench/byzantine.mjs`, 2026-09-05, after the docstring had claimed the
stronger property for weeks.

Computing the share against the answer instead was implemented and
reverted. It is correct and it terminates, but the corpus it shrinks is not
only the flood: a normal memory is one user claim plus a productive digest
agent, which has the same authorship shape as a flood, so the same fixed
point cuts a real answer to two claims. **Authorship cannot distinguish a
flood from a useful writer** — only content can, and near-duplicate
detection is rejected below for having no calibratable threshold.

So bounded domination is **not** a guarantee cheap-mem offers. What
actually catches a flood: `potentialConflicts` reports it as contested, the
`user`-tier claim is exempt from the cap and stays in the answer, and the
caller is told both. A caller who needs a real bound lowers
`perAuthorShare` themselves and accepts shorter answers.

**The share alone is nearly worthless, and the fix is content.** Attacking
it showed twenty identical claims under twenty author names passing
untouched: rotating a name costs an attacker nothing. So identical bodies
(NFC, CRLF→LF, whitespace collapsed — no case folding, no punctuation
stripping) collapse to the highest-ranked one, whoever signed them.
Measured: a 20-claim flood returns as 1, with genuine entries still in the
answer.

That collapse happens **during** selection, not after. Doing it afterwards
was a real defect in the first version: the flood filled all ten slots,
dedup then removed nine, and the answer was a single flood claim with every
genuine entry gone. Filtering after a cutoff cannot restore what the cutoff
discarded.

Near-duplicates are deliberately left alone. They are a `possible_duplicate`
relation to surface, not a merge to perform — aggressive normalisation makes
DIFFERENT content collide, and a memory that silently merges two different
claims is worse than one that shows a duplicate.

---

## 7. Environment contract

The failure class behind the others: correctness rests on properties that
live outside the codebase. `src/environment.mjs` checks them and names the
layer that owns each. `mem doctor --strict` makes an unverifiable guarantee
a failure — for CI, where refusing to determine a property *is* the defect.

| guarantee | layer | how it is checked | if absent |
|---|---|---|---|
| `O_APPEND` atomicity | os/filesystem | filesystem type; **UNKNOWN** when undeterminable | concurrent writers may interleave (NFS) |
| `*.jsonl merge=union` | git | `.gitattributes` | a merge silently destroys entries |
| pre-commit hook | git | `core.hooksPath` + file | secrets reach git |
| clock | operational | newest `ts` vs. system clock | "newest" is wrong |

A check that guesses is worse than none: it turns an unknown into a false
assurance. Hence UNKNOWN rather than OK.

`mem init` now writes the merge driver (append, never clobber, idempotent)
and names `mem hooks install`. Before this round it shipped neither, so
every fresh memory started without the guarantee its own design depends on.

---

## 8. Threat model

| threat | attack | expected | detection | mitigation | residual |
|---|---|---|---|---|---|
| **T2 malicious agent** | supersede another's claim | refused | `doctor` integrity, `mem explain` | authority rule | can forge `author` with repo write |
| **T2** | flood disputed claims | no context effect *(measured, 50 claims)* | `doctor` | disputed is unindexed | disk grows |
| **T2** | short claim with the query words | **still works** | — | **unsolved** | see below |
| **T2** | flood under many author names | collapses to one *(measured)* | `mem explain` | identical bodies dedupe during selection | near-duplicates survive |
| **T1/T2** | read another scope | refused at the gateway | excluded-with-reason | capability | `search()` is still open by design |
| **T3 malicious document** | injection in a body | returned as a labelled record | — | structured retrieval | a client may re-flatten |
| **T3** | secret in a body | redacted before disk | canary, hook | 7 separator + 7 space look-alikes | an unknown shape |
| **T3** | a secret that reached a drawer PAST the write path (typed by hand, an older version, a merge) | masked at the OUTPUT as `[REDACTED:type]`; the line on disk is untouched | `src/outputguard.mjs` — the very `PATTERNS` of `redaction.mjs`, no second list; `test/output-guard.test.mjs` | `maskText`/`maskEntry` at every render path: `display.compactLine` and `sanitizeForDisplay` (find, show, when, retrieve, the bridge), `shortline`, `memory.context()`, `browse`, the viewer payload, `recallrender` and the three hook outputs; plus `out()` for EVERY command (on by default; the short exception list `UNGUARDED` in `src/cli/shell.mjs`), the one exit of `mem serve` (`src/servemask.mjs`, all JSON answers) and the direct stdout writers (`context`, `core`, `raw show`, `inbox show`). **Mask before cut:** every site that shortens entry text masks first (`cutMasked`, `windowMasked`, or `maskText` in front of its own cutter), otherwise a key crossing the cut leaves a stump below its pattern's minimum length; `test/mask-before-cut.test.mjs`, ratchet `test/mask-before-cut-ratchet.test.mjs` | an unknown shape stays; a command that prints through `process.stdout.write` instead of `out()` and forgets the mask; the env-value layer is write-time only |
| **T5 malicious merge** | conflict destroys lines | prevented | `env/merge-driver` | `merge=union` | driver must be present |
| **T7 corruption** | truncated line | skipped **and counted** | `doctor` integrity | — | the entry is gone |
| **T7** | a historical line edited in the working tree, not merely appended to | flagged, first differing line named | `doctor` append-only-git (`checkAppendOnlyGit`) | working tree checked against `git show HEAD:<path>` — old must be a prefix of new | **whoever edits AND commits, or force-pushes rewritten history this clone then pulls, is invisible** — checked against git, deliberately not a second, weaker hash chain (see the long comment on `checkAppendOnlyGit` in `src/doctor.mjs`) |
| **T3** | Trojan-Source bidi-override characters ([CVE-2021-42574](https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2021-42574)) reorder how a body reads in a terminal or an agent's context | neutralised at DISPLAY time | `src/bidi.mjs` — a closed nine-codepoint list (U+202A-U+202E, U+2066-U+2069) | `bidi.visible()` in every render path: `display.compactLine` (`mem find`, `mem component`/pre-edit hook, `mem when`, board), `memory.context()` (SessionStart hook), `browse.fit()` (`mem browse`), and directly in `bin/mem-retrieve`'s per-turn hook (which reads the raw entry, not `compactLine`'s output) | the character is still ON DISK, unmarked, in any consumer that reads the JSONL directly instead of through one of these render paths — e.g. `git show`, a raw `cat`, or a future display path that forgets to call `bidi.visible()` |
| **T9 model output** | digest emits `authority: user` | demoted to `inferred` | `authority_clamped_from` | write-path ceiling | a writer without the ceiling set is unconstrained |

### Closed in the final verification round

**Rollback / resurrection (I12) — now detected.** `.mem/epoch.json` is a
LOCAL, gitignored high-water mark of what this machine has already seen:
claim count, newest `ts`, and the SET of retired ids. A checkout that
resurrects a superseded claim shrinks that set, and `mem doctor` reports it
as an ERROR naming the resurrected ids. `mem epoch record` refuses to lower
the mark without `--force`.

It is gitignored on purpose: a marker committed alongside the log travels
back with the checkout it is meant to detect. It stores no memory content —
only how far this machine has looked — so it is an observation about
history, not a second source of truth. Delete it and you lose detection,
not data.

Two limits, tested as explicitly as the guarantee: a **fresh clone** has no
mark and cannot detect anything on its first run (it establishes one), and
anyone who can write the repository can delete the file. This catches
accidents and stale restores, not a determined adversary with filesystem
access.

**Semantic versioning.** `SEMANTIC_VERSION` (currently 1) covers every rule
that changes DERIVED state — supersession, tier order, conflict resolution,
interval comparison, what counts as retired. A watermark taken under
different semantics is not compared: doing so would report a rules change
as a rollback and hide a real one in the noise. Not a migration engine;
nothing is rewritten, because old entries were correct under the rules of
their day.

**The model was an unconstrained writer.** The digest is the ONE place a
model writes claims into the log, and it had no ceiling: `authority` was
whatever the model emitted. That composes with injection — text inside a
captured transcript steers what the digest produces — so a sentence in
someone else's document could mint a `user`-tier claim and overrule
everything. `CHEAP_MEM_MAX_AUTHORITY` is now enforced on the WRITE path and
set to `inferred` by `bin/mem-digest`. Enforced rather than requested,
because an instruction is a request and the process being constrained is
precisely the one that may have been told otherwise. A demotion is
recorded in `authority_clamped_from`, never silent. The ceiling only ever
lowers: an explicit `unknown` stays `unknown`.

**New lines read as the lowest tier (Y4b, 2026-09-30).** Until then a
write that named no tier stayed unstamped and read as `unknown` — the
lowest tier — so the digest (`inferred`) could still close or retire
anything a session wrote. The write path now stamps `agent` when no tier
is given (under a ceiling, the ceiling), never `user`. `user` is only set
explicitly: `--authority user` on `mem done`, `discard`, `supersede`,
`duties close` and `correction`, or the dashboard's done task when a
PASSWORD session triggered it (not the bearer token, not a server with
the sign-in off). The MCP bridge lowers any claimed tier above `agent`,
and `bin/mem-reflect` sets the same ceiling as the digest. A line the
rule refuses is still written, warned about on stderr and read as
disputed; `mem doctor` counts those as `contested-claims`.

**What a bridge caller may write at all (A6 + A1 remainder, 2026-10-11).**
`mem_log` used to pass every argument key on, and the write path passed the
machine fields (`state`, `status`, `v`, `authority_clamped_from`,
`guard_at_creation`) straight through as stamps. It is now an allow-list per
type (`src/bridgefields.mjs`): a field outside it is REFUSED by name with the
list of what is allowed, nothing is written, nothing is dropped silently. The
counterpart ids (`replaces_id`, `retires_id`) stay, because their
effect is judged on read by `authority.mayChangeState`; `state` and `by_id`
travel only next to one of them. `authority` stays clamped, and the record of
the demotion (`authority_clamped_from`) is the bridge's to write, not the
caller's. `agent`, `id` and `ts` are still set by the write path and ignored
if sent. `test/bridge-fields.test.mjs`.

**Closing, identity and files over the bridge (second round, 2026-10-11).** A duty is closed only by
`mem_duty_close`, which asks for the F4 proof: `mem_log` refuses `closes_id`, and refuses `guard` (a latch
the writer wrote itself counts as F4 evidence and proves nothing; a human sets it at the CLI). The
sender of `mem_inbox_write` and the `agent` of `mem_store_put` are the identity of the bridge, never a
parameter. `mem_store_put` reads only from `store/intake` and from `CHEAP_MEM_STORE_INTAKE`, by real path.
A counterpart id must be an entry id. `test/bridge-hardening.test.mjs`.

**A claim of who said it is not evidence (A12, 2026-10-11).** Over the bridge
`mem_appointment_new` with `requested_by: "user"` and a quote used to make a
plain reminder active at once and kept it out of the daily cap on agent
proposals: the bridge cannot verify who said the sentence, the same
self-assertion as a claimed authority tier. An appointment made over the
bridge is now always a proposal and counts towards the cap; the claim stays in
the text as a marked, unverified note. The CLI (`--requested-by user --quote`)
is unchanged. `test/bridge-appointment-claim.test.mjs`.

**Scope, said plainly.** This hardening protects against clients WITHOUT a shell (a chat connector on the
bridge). Whoever has a shell on the machine is a person for the CLI: `mem appointment new --requested-by
user --quote ...` without `MEM_HEADLESS` creates an active appointment, `mem store put <path>` reads any
path, `mem log` writes any field; so does putting a hard link or a copy of a file into the intake
folder, which also takes a shell. The bridge cannot make that safer; the environment (who gets a
shell) has to. The store read itself is one act: the bridge opens the file without following a link,
reads from that descriptor, and checks again after the read that the path is still its own real
path, so a link swapped in after the intake check is refused.

**Hostile values on the pages (A9, 2026-10-11).** `test/hostile-surfaces.test.mjs` feeds one
corpus (script tags, attribute breakouts, `javascript:` text, entities, `</script>` / `<!--`,
U+2028/9, 150 000-character values) through the dashboard, `/entries`, the standalone viewer and
`mem board --html` and checks the DOM, not the source: nothing is live, the typed text is shown,
the page-level script count does not grow. It found no injection; it found a viewer that went
blank on `<!--` and quadratic patterns that let one long title freeze the dashboard build
(bounded now: `entity.boundRuns`). bidi controls are covered by the atlas (`bench/atlas`).

**External security review (Fable, 2026-10-11), bridge and dashboard.** Reproduced against throwaway
roots first, then fixed; `test/b1-duty-replace.test.mjs`, `test/b2-b4-inbox-ownership.test.mjs`,
`test/b5-b9-dashboard.test.mjs`.

- **B1 `replaces_id` on a duty.** `openDuties` retired the predecessor of any `replaces_id` line without a
  rule, so one `mem_log` removed a user duty or an auto-duty, and the replacing stage had no `error_ids`
  and closed without the F4 proof. Now the fold judges a replacement like a close
  (`authority.mayChangeState`); a duty that grew out of errors is replaced only by a stage that stays
  open and keeps its ids, the chain walked back to the stage that carries them (the newest stage inherits
  them, so closing it still asks for evidence). A refused replacement is not obeyed (the predecessor stays
  open) and is counted by `mem doctor` (`contested-claims`). The bridge does not offer `replaces_id` on a
  duty at all (the smaller safe option, like `closes_id`): a duty is closed by `mem_duty_close`, a new
  one is a new `mem_log`.
- **B2/B4 other people's mail over the bridge.** `mem_inbox_ack` and `mem_inbox_claim` work on mail
  addressed to the connected agent (ack: or held by it under a valid claim). One claim is at most
  `claim.MAX_EXTENSION_MIN` (120) minutes and a renew is capped at that total beyond the original
  `until`. The shell is unchanged.
- **B5-B9 dashboard.** The bearer no longer sets the first password or signs out; `/setting`,
  `/inbox/reply`, `/inbox/state`, the verdict routes and `raw-delete` need a password session; the raw
  archive can be pointed only into an allowed base; the Host check covers `/`, `/desk.json`,
  `/console.json`, `/entry.json`, `/task.json`; the sign-in lock is per source, and `CF-Connecting-IP`
  counts only with `CHEAP_MEM_SERVE_BEHIND_TUNNEL=1`.
- **Review of the fixes.** `done`, `restore`, `merge` are `humanOnly` too (they write the human stamp; a
  bearer-only `restore` revived an entry a person had closed). An automatic duty extended by more error ids
  is exempt from the rank rule (a digest under `CHEAP_MEM_MAX_AUTHORITY` must not add a duty per repeat) and
  the fold, the write warning and `mem doctor` share one rule (`memory.dutyReplaceVerdict`). The bridge refuses
  an array or an object where a tool's schema says string (`type: ["duty"]` passed the strict type locks).
  The Host check is central. Still open: `retires_id` on a
  duty over the bridge is judged by the same rule on read; it does not close a duty in the duty list.

**Port of the sister house's Fable run (2026-10-11).** lucky-mem's own security run found gaps cheap-mem shared;
each was reproduced against a throwaway root here first.

- **A poisoned line must not take the readers down** (lucky-mem error 5katltp7cfkr). A line whose text field is an
  object (`tags: {toString: "x"}`, `owner: {a: 1}`, a `title` that is a list) or whose `ts` / `id` is not text crashed
  `find`, `context`, `duties`, `viewer`, `doctor` and the dashboard (an uncaught throw in `/entries.json` ended
  the server), and the recall hook failed silently for everybody. The bridge already refused such values when writing;
  a raw line, an old CLI or a merge never meets that gate. Now every reader that interprets an entry's fields goes through `memory.parseLine`
  (`src/fieldshape.mjs` names the text and list fields): the line is BROKEN (`{__broken: true, raw, reason}`, the
  three-states rule), `mem doctor` names it with the field (`drawers`, `integrity`), and it is out of every other
  denominator. Nothing is deleted (append-only). Legitimate old forms stay readable: a single tag as a text, a boolean
  or number where a scalar is allowed, the structured fields (`origin`, `provenance`, `guard`, `chain_seal`, ...).
  `test/poison-lines.test.mjs`.
- **Cancelling needs the person too** (lucky-mem N1/N9). `POST /task/cancel` took the bearer token alone, so anybody
  handed the link could end a task an owner started. It needs a password session (403 otherwise, before the kind and
  the state are looked at). `raw-delete` is not cancellable (`interruptible: false`: it frees the bytes, then writes the
  tombstone). `export`, which decompresses the raw captures into a folder, is `humanOnly` now; `integrity` only reads.
  `test/task-cancel-person.test.mjs`.
- **`/task.json` names no server path** (lucky-mem B11). The command, result and reason show `<root>` and `<code>`
  instead of the absolute folders; the state file on disk keeps the full command. `test/task-json-paths.test.mjs`.
- **The viewer's own ways in are redacted** (lucky-mem B14/N6). `?k=<token>`, the cookies `mem_k=` and `mem_session=`,
  also URL-encoded (`%3Fk%3D`), JSON-escaped and HTML-escaped, fall in raw capture, stored lines and every output
  (`viewer-access`, canary 14). `test/redaction-viewer-access.test.mjs`.
- **The bridge does not decrypt** (lucky-mem "no decryption without a switch"). The bridge process can read
  `.mem/keyring.json`, so a connected foreign agent read entries written with `shred` that a clone of the git data cannot.
  Now they show as unreadable over the bridge unless the operator sets `CHEAP_MEM_MCP_DECRYPT=1`. The CLI and the
  dashboard are unchanged. `test/bridge-no-decrypt.test.mjs`.
- **A text field is text (review 2026-10-12).** A number or a boolean in `key`, `text`, `why`, `valid_from` ... crashed
  `context`, `facts`, `viewer`, `today` and the dashboard while the doctor was ok, and `--key` without a value wrote
  `true`. A text field is text now (the line is broken otherwise), `mem log` refuses a flag without a value except the
  real switches, `mem_log` refuses a number or a boolean there, and an old `tags: true` is read as an empty list with a
  doctor warning. A line nested deeper than 32 levels is broken. The rule is inverted: every top-level field is a scalar or a list of
  scalars, objects only in a named allowlist (`origin`, `provenance`, `guard`, `chain_seal`, `body_enc`, `references`,
  `asked_evidence`), and no object carries a key like `toString`. `test/field-text-strict.test.mjs`,
  `test/neighbours-poison.test.mjs` (the write-time neighbour hints read the drawer through the same rule).
- **Derived files** (`backlinks.json`, `component-table.json`, the dashboard head, the time track) carry a new format
  version like the search index, so data built from lines that are broken now is not served.
  `test/derived-caches-version.test.mjs`. A long-running `mem serve` / `mem-mcp` needs a restart after the update.
- **An old index is not served.** The search-index cache is version 16 (15 held the lines of the first round of the strict rule); a cache built before `fieldshape` could still
  hold documents of poisoned lines and was valid by its file stamps. `test/stale-index-fieldshape.test.mjs`.
- **One write gate for the shape.** `memory.logEntry` judges the line with `fieldshape.shapeProblem` before anything is
  written and refuses a field of the wrong shape (an object in a text field, `why: true`, a list flag without a list), so
  no door - CLI, bridge, `closeDuty`, `retireEntry`, `supersedeEntry`, an import - can write a line the readers call
  broken. A top-level non-object line (`null`, a number, a text, a list) is broken on read. `test/closing-why-gate.test.mjs`,
  `test/non-object-line.test.mjs`.
- **A tunnel is not "local"** (lucky-mem B9/B14). With no token and no login behind the door (the viewer with the login
  off, the MCP bridge over HTTP), a request that carries a proxy header (`cf-connecting-ip`, `cf-ray`, `x-forwarded-*`,
  `x-real-ip`, `forwarded`) no longer counts as loopback, since a tunnel on this machine connects from 127.0.0.1. With
  the login on, the password stands behind the door. `test/loopback-proxy-headers.test.mjs`.
- **Checked and not a gap here:** an `In-Reply-To` letter never closes a request (the state is its own act, addressee
  only since B2, and `inbox.write` checks the direction); the dashboard's archive location (session + allowed bases) and
  the CLI (unchecked, the operator's own hand) split the way lucky-mem's does.

### Unsolved, explicitly

- **Ranking eviction.** A short claim containing the query terms outranks
  fifty genuine ones on BM25 length normalisation alone (measured; no term
  stuffing needed). Authority tiering only helps where the claims
  *conflict*, and detecting that is open (§5). Anyone who may write may
  still influence what is retrieved.
- **Near-duplicate flooding.** Byte-identical bodies collapse. Vary one
  word and the flood is back. Every similarity threshold is uncalibratable
  — the same objection that ruled out numeric confidence — so nothing is
  built here rather than something that would need a magic number.
- **Contradiction detection** (§5).
- **Identity.** Everything above rests on fields anyone with repo write
  access can set.

---

## 9. Invariants, and where each is verified

| | invariant | verified by |
|---|---|---|
| I1 | append-only; nothing is overwritten | `test/authority.test.mjs`, and against real git history: `test/append-only-git.test.mjs`, `doctor` append-only-git |
| I2/I8 | replaying a log yields identical state | `test/properties.test.mjs` |
| I3 | no unauthorised supersession | `test/authority.test.mjs`, `bench/redteam.mjs` |
| I4/I5 | scope is a boundary, not a parameter | `test/retrieval.test.mjs` |
| I6 | temporal semantics are stated and tested | `test/retrieval.test.mjs` |
| I7 | disputed claims do not reach a context | `test/authority.test.mjs` |
| **I9a** | index: documents, docFreq, lexicon, avgLength **exact** | `test/properties.test.mjs` |
| **I9b** | index: learned graphs **approximate**, declared via `graphsStale` | `test/properties.test.mjs` |
| **I9c** | a fresh load removes the drift | `test/properties.test.mjs` |
| I10 | merge safety | `test/environment.test.mjs`, `bench/merge-driver.mjs` |
| I11 | secret patterns survive Unicode variants | `test/redaction-unicode.test.mjs` |
| I12 | rollback detection | `test/epoch.test.mjs` |
| I16 | semantic version guards derived-state comparison | `test/epoch.test.mjs` |
| I17 | a model cannot write above its ceiling | `test/write-ceiling.test.mjs` |
| I13 | resource bounds | `test/retrieval.test.mjs` |
| I14 | structured retrieval | `test/retrieval.test.mjs` |

I9 as originally stated — "rebuild == incremental" — is **false**, and
correctly so: `appendToIndex` does not extend the learned co-occurrence
graphs, because recomputing them means walking the whole corpus. A pair can
even drop out as the corpus grows (three learned pairs at 60 documents, two
at 71), so ranking differs, top-1 included. Split into three invariants
that are each true.


---

## 10. Are these guarantees enforced, or only written down?

Answered by breaking each mechanism on purpose and checking that a test
notices (`node bench/mutation.mjs`). A mutant that SURVIVES marks a
guarantee that lives in documentation and nowhere else.

**110 mutants, 110 caught.** Including: supersession always allowed,
`admits()` always true, the disputed filter removed, deduplication removed,
resource limits ignored, the redaction class narrowed back to ASCII, broken
lines silently skipped again, cycles never reported, the merge driver
always OK, `docFreq` not updated on append, `replaces_id` ignored entirely,
rollback never reported, the watermark allowed to move backwards, semantics
compared across a bump, the write ceiling ignored, and `clampTier` refusing
to lower.

It found a real one on the first run: the resource-limit test used 120
IDENTICAL claims, which deduplication collapsed into a single result, so
the assertion held whether or not the cap existed. It read like proof and
was worth nothing.

`node bench/fuzz.mjs` throws malformed and hostile input at every parser —
redaction, capability, temporal intervals, authority, the replacement
graph, dedup normalisation, and retrieval with a bogus capability. Looking
specifically for the failure that matters here: garbage producing a MORE
permissive answer rather than an error. Currently clean, and verified to
have teeth by breaking the capability boundary and confirming it fires.
