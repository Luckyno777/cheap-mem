# Changelog

A memory tool that could not say what changed between two of its own
states was the joke this file ends. Started 2026-09-08, after an
external review pointed out that a project built on "measured, not
guessed" had no record of its own history beyond `git log`.

Entries before that date are reconstructed from the commit history and
are therefore coarser than what follows. Where a day's work was
measured, the measurement is here rather than a summary of it.

Format follows [Keep a Changelog](https://keepachangelog.com). Dates
are the day the work landed on `main`.

## Unreleased

### Security / Privacy — no entry text goes to an embedding vendor; Voyage and OpenAI removed (2026-10-13; breaking for users of `voyage` / `openai`)

Owner decision (2026-10-13), both houses: no text goes to an embedding third party, not even masked. External embedding paths
are removed, only local ones stay. Before this, `mem embed backfill` and `mem find-embed` / `find-hybrid` sent the text of
every entry (and of every query) to `api.voyageai.com` or `api.openai.com`, with the key from `VOYAGE_API_KEY` /
`OPENAI_API_KEY` or `.mem/embed.env`. Red proof on the previous tip: with `{"provider":"voyage"}` in `.mem/embed.json` and a
key in the environment, `embed.embed(root, text)` called `fetch('https://api.voyageai.com/v1/embeddings')` with the entry text
in the body (OpenAI the same); `test/embed-local-only.test.mjs` makes the same calls and now sees none.

- **Removed**: `src/embed/voyage.mjs` and `src/embed/openai.mjs`, and every way to reach them. `mem embed setup --provider
  voyage|openai` is refused and writes nothing; the default provider is now `ollama`.
- **ollama only on a loopback address** (`src/embed/loopback.mjs`): `127.0.0.0/8`, `::1`, `::ffff:127.x`, or the name `localhost`
  if the resolver returns only loopback addresses. Any other host name is refused WITHOUT being resolved (a name is not
  proof), as are private and link-local addresses, `0.0.0.0`, `https`, and credentials in the URL. The connection goes to the
  approved address (not the name again), through a private agent (no proxy environment) and without following redirects.
- **Old configuration is recognised and refused, never silent.** `.mem/embed.json` naming `voyage`, `openai`, no provider (the
  old default was voyage) or any other non-local provider, or an `OLLAMA_HOST` that is not loopback: `mem find-hybrid` and
  `mem find-embed` print `external embedding providers are disabled: no entry text leaves this machine; using lexical search`
  on stderr and answer with the lexical search; the first line of the answer says `lexical only - REFUSED`. Three states are
  told apart (local / not configured / refused), plus a config that cannot be read. A configured local model that is down no
  longer reads as "no hits": `bm25 only - local semantic search failed: ...`. `mem embed backfill` refuses (exit 2) before
  touching anything, also with `--force`.
- **Stored vectors are kept, not used.** Entries an external provider embedded stay in `.mem/vectors.db` (it is your data);
  search ranks only vectors of the current local model; `mem embed status` says how many came from a removed provider.
  `mem embed backfill --force` with a local setup moves such a store to `.mem/local/kept-vectors/` instead of deleting it.
- **`VOYAGE_API_KEY`, `OPENAI_API_KEY`, `.mem/embed.env`** are no longer read by anything (marked REMOVED in
  `docs/environment-variables.md` and `src/envregister.mjs`); `mem embed status` names them when present, never their values.
- **Rails**: `test/embed-local-only.test.mjs` fails when a file appears in `src/embed/` that is not on its allowlist, or when
  one of them imports a network module, calls `fetch`, spawns a process or spells a non-loopback URL.
  `test/network-allowlist.test.mjs` watches all of `src/` and `bin/` (and the shell scripts in `bin/`, `hooks/`, `install/`):
  a `fetch`, a network-module import (`http`, `https`, `net`, `tls`, `dns`, ...), `http(s).request/get`, `net.connect`,
  `tls.connect`, `WebSocket` or `createRequire` is allowed only in the files named there, each with its reason, and the
  embedding adapter's request must go to exactly the address the loopback check approved. A stale allowlist entry is red too.
- `mem embed backfill` (also `--force`) now checks that the optional sqlite packages are installed BEFORE it moves or deletes
  anything, and stops with exit 2 and the install hint if they are not.

**What you have to do if you used voyage or openai:** nothing breaks (`mem find`, `mem retrieve` and the hooks never used
embeddings), but `find-hybrid` / `find-embed` are lexical from now on. For semantic search again, locally: install ollama,
`ollama pull nomic-embed-text`, `mem embed setup`, `mem embed backfill --force` (the vector size differs, the old store is
not reusable). Revoke the keys you only had for this, and delete `.mem/embed.env`.

### Changed — the headline names an entry with one field (counterpart of lucky-mem "Lesbare Schlagzeilen in Suche und Netz")

`viewer.headline(e)` took up to two filled fields from `class, title, topic, choice, ...` and joined them with " — ": an error
read "<class> — <title>", a learning "<title> — <start of the text>". Now it is exactly one naming field (`title`; else `rule`,
`question`, `fact`; a decision its `choice`, else its `topic`), or without one the first whole sentence of the content (markdown
removed, never cut inside the first twelve characters, longer than 90 characters at a word boundary with "…"). Lists and objects
are never printed as JSON. The output guard still masks first, a procedure keeps its mark (now behind the name), a locked entry
stays `[locked]`. `headline(e, { type })` takes the drawer where the caller knows it (viewer, dashboard, pages, compact pass,
light head, project package). The class is no longer part of the line.

Deliberate deviations from lucky-mem: a list field (`steps`) reads as its FIRST item, where lucky-mem reads "1. a 2. b" and cuts
inside the numbering; and the output guard masks the raw field text BEFORE the line is split or cut (a key shape that reaches over
the 90/160 cut would otherwise stay behind as a fragment). An envelope opened in memory (`__body.state` ok) reads like any entry; an
unreadable one carries its own label once; a rule of markdown characters only falls on to question/fact and keeps its mark.

### Added — the due dates in the day brief (build plan Q7, step 6b, branch B; 2026-10-13)

The due-date core was there and nothing in the day brief used it. Now `mem today`, the session-start line, the briefing, the
dashboard card, the doctor and the before-edit hook ask the core (`src/due.mjs`) and say what is late.

- **The line of the day** (`mem today --line`, the briefing's subject and first line): `n deadlines overdue`, `n due today`, then
  the old parts. Quiet is nothing; deadlines that cannot be read say `deadlines not measurable` (three states, never a quiet 0).
  Too long for the cap: whole parts fall away, the least important first (`src/dayline.mjs`) - the old line was cut at the limit
  with an ellipsis, in the middle of a word. The wording of the projects part stays `awaiting confirmation`.
- **`mem today`, part DEADLINES** (`src/deadlines.mjs`): the human's duties with a due date one by one, earliest first, at most 8
  and the rest counted (`… and 192 more: mem deadlines`); the duties of agents and unaddressed ones only as a number. The title is
  masked, then cut, and a right-to-left override is made visible (also in the briefing's list and in the decisions of `mem today --json`); an encrypted duty shows `[locked]`, its date stays readable.
  `--json` carries the same (`deadlines`, `counts.deadlinesOverdue`, `counts.deadlinesDue`; each decision for the human has
  `dueState`). The human comes from `.mem/config.json`.
- **One pass over the duties.** `today()` reads the duty drawers once and hands the fold to the decisions and the deadlines; the
  dashboard build hands in the fold it read (`todayOf(root, { duties })`). A counter over the drawer file pins it
  (`test/today-due.test.mjs`).
- **The Monday briefing carries a week review**, no new timer, no model: last week's deadlines (done, dropped, still open), overdue
  now, due this week, projects awaiting confirmation - only if a deadline of the human fell due last week or falls due this week;
  then it alone keeps the day from being "empty" (`mem appointment today --json`). The week is Monday to Monday in the HOUSE zone,
  never UTC (pinned across midnight and both clock changes).
- **Dashboard**: the Today card has a part "Deadlines" (counters: overdue, due today, later, unreadable; agents' duties as one number;
  no second list of the same duties) and a chip (overdue / due today / unreadable) on each decision card; the cards of the human
  stand by deadline, overdue first, duties without a due date after them in the old order;
  the data (`deadlines`) is in the full AND the compact build (the compact one above its module limit says "not computed", not 0).
  A due DAY is shown as written, not moved by the browser's zone.
- **Doctor**: finding `deadlines` (WARN only): a duty overdue for more than a day with no newer line, an unreadable value, an old
  field name (`due_date`, `until`, `deadline`, `by`: still read, only `due` is written). No open duty, or none with a due date, is
  UNKNOWN, not good. In `shared/finding-map.jsonl` as `nur-deadlines` until lucky-mem has its counterpart.
- **Before an edit**: the open duties for the file come overdue-first (the longest overdue first). Only the order; the retrieval
  ranking is untouched.

### Added — the due-date core (build plan Q1, step 6b, branch A)

A due date on a duty was read by three readers with guessed names (`today.mjs` and the dashboard `due ?? by`, the day list
`due / due_date / until / deadline`) and written by nobody. Now one module owns it: `src/due.mjs`.

- **`mem log duty --due`** (and `mem_log` with `due`, and a named `--due` in `mem correction`): exactly two forms, `YYYY-MM-DD` in
  the house zone or an ISO point in time WITH a zone; a date-time without a zone is refused loudly, nothing is written.
  Only a duty may carry it (any other type refuses the field). The check stands in the write core (`logCheckedEntry`,
  `correctionEntry`), so the CLI and the bridge cannot differ.
- **States** `fresh | due | overdue | unknown`, computed from the due date, never from the age of a line. The day boundary is
  midnight of the house zone (`.mem/config.json` timezone, else `CHEAP_MEM_TZ`, else the system zone), never UTC - also on
  the two clock changes (a day of 25 and one of 23 hours) and in a second zone. A broken value is `unknown`, not an error.
- **`mem deadlines [--json]`** and the MCP tool `mem_deadlines`; `mem duties` and `mem_duties` show the due date and its state.
- **Moving is append-only**: `mem correction duty <id> --due ...` inherits the rest, `--without due` removes the date; the
  duty replacement rule (authority, debtor) applies unchanged. "Open since" comes from the START of the chain (`_since`),
  so a moved due date does not make a duty look young.
- Only `due` is WRITTEN: `--due_date / --until / --deadline / --by` (and the same fields over the bridge) are refused with a
  hint to use `--due`, on a duty and on every other type. Older lines that carry them are still READ; `due.aliasUsed` names the
  alias for the doctor. The due date of an encrypted duty stays readable (`shred.NEVER_ENCRYPT`).
- **Who may move a due date**: a correction that changes or removes `due` counts only from the author or a higher tier - not
  from the debtor and not sideways from the same tier (`dutyReplaceVerdict`, the strict `authority.maySupersede`); a refused
  one stays on record and the original keeps its date. Closing a duty stays with the debtor.
- A broken old value (a number, a boolean, nonsense text) in `due` or its aliases no longer makes a line "broken": the duty stays
  open with the state `unknown`, and only text or null is passed on to the day list and the dashboard (`due.dueText`). An object
  or a list of objects there is still a broken line by the general field-shape rule.
- Invariant `frist-eine-stelle` / calculation `due-one-place`; the field names and states are paired with lucky-mem in
  `shared/field-names-parity.jsonl`, and `shared/due-states.jsonl` is the fixture both houses must answer the same.

### Dashboard — full width on a desktop, and a write of your own is what you see at once (2026-10-12)

Reproduced in a real Chromium on the previous tip first (red), then fixed (green). `test/dash-width-cm.test.mjs`,
`test/dash-write-fresh-cm.test.mjs`.

- **Width.** `main` no longer stops at 1700 px: at 2560 px it left 636 px empty. It fills the column next to the
  sidebar (1696 px at 1920, 2336 px at 2560). Reading text in cards keeps 110 characters per line (it ran to 208), the
  setting inputs 720 px (they ran to 1608). 390/720/950 px measure the same as before.
- **A write of your own.** Saving a setting, acknowledging or answering a message, rating a gold question, confirming a
  project and deleting a raw capture wrote correctly, and the page showed the OLD state, also after a reload, until the
  cache's rebuild (seconds on a real store, minutes with the gap) was through. `invalidate(parts)` now remembers which
  parts of `/dashboard.json` a write changed; `src/dashboard-live.mjs` computes just those from the small read functions
  (0.3-1.5 ms against a 3.2 s build on 2000 entries) and the server lays them over the stored answer, the deferred lists
  included. Holds until a build that started after the write is through. A read without a write computes nothing. A part
  that cannot be computed is named in `cache.live_errors` and said at its card, never silently old. Writes that change
  the whole entry stock (done, restore, merge) stay with the rebuild. New probe switch
  `CHEAP_MEM_SERVE_BUILD_PAUSE_TEST_MS`.

### Security - mask before cut: a key that crosses a cut boundary is no longer left as a stump (cm error 2tjgr4psniuh)

Found by counting, on `acff04e`, with probes that build a key-shaped bait at run time: a text was shortened first and masked
afterwards, so a key that crossed the cut left a rest under its pattern's minimum length (a github token needs 30 characters
after `ghp_`) and the rest was no longer recognised. The window cut of `raw.snippet` also cut at the FRONT, so a tail without
its prefix came out. Probes: `test/mask-before-cut.test.mjs` (every site, seven key families, red on `acff04e`);
the ratchet `test/mask-before-cut-ratchet.test.mjs`.

- **One order, in one place.** `src/outputguard.mjs` gains `cutMasked(text, n)` and `windowMasked(text, from, to)`: mask first,
  cut the masked text, drop a marker the cut tore in half. The sites below call them, or call `maskText` in front of their own
  cutter (word boundary, ellipsis) so their output for plain text stays byte for byte what it was.
- **Cut before the mask (output):** the raw search hit (`mem find --json`, the bridge), `raw.snippet` (both window edges),
  `retrieve` body (`mem retrieve`, `mem_retrieve`, the dashboard probe), `mem when --raw`, `mem questions` and the question
  tile of `mem board`, the command-guard booklet titles (on disk too), `mem log error` "most recent", error history lines,
  neighbour and learning notes, the Stop-hook closing report, the day list (`mem appointment today`, the session line, the
  letters), the dashboard (probe, facts, skill catalogue), `mem net --derived`, `mem observations`, the doctor's entry-form
  finding, the repetition hint, the answer check excerpt, `mem teach`, the skill registry (SKILL.md export, `mem skills list
  --json`), `bodyfields.restOfBody`.
- **Written path (the rest stays on disk for good):** `source.excerpt` redacts the whole text, then caps it; the unreadable
  line of a raw capture, the commit subject in a `resolves` link, the broadcast title, the rule-draft quote, the heartbeat
  `what` (which had no redaction at all), the shrink baseline `why` and the rewrites lock `reason` are masked before they are cut.
- **Output that went past the guarded `out()`:** `mem context`, `mem core` and `mem raw show` write to stdout directly and now
  mask there; `freshness.formatFact` masks (it fed the session-start block with the full value); the dashboard entry drawer
  (`entryWhole`) masks `raw` and `text`; `mem inbox all|new` masks the subject.
- **The CLI output guard is ON for every command** (it was an allow-list, `READ_COMMANDS`, and every command missing from it
  printed entry text in the clear: `inbox`, `skills`, `teach`, `net`, `observations`, `appointment`, `suggest`). The exception
  list `UNGUARDED` in `src/cli/shell.mjs` holds `serve` only (its setup code is what it exists to show).
- **`mem inbox show`** printed the message byte for byte past `out()` (and `bin/mem-handle-post` hands that to a model); it masks
  now. `mem suggest procedure` masks the error title in the draft command.
- **`mem serve`: one exit for all JSON.** `src/servemask.mjs` masks every JSON answer at the request handler (gzip aware, byte for
  byte unchanged when nothing needs masking): inbox subjects, message bodies and replies, fact values and experience titles left the
  server in the clear. The field masks in the routes stay as the first layer; a route added later is covered anyway.
- **Helpers that cut to a length they are handed** (`short(s, n)`, `clip`, `squash`, `cutAtBoundary`, `capBytes` ...) mask inside the
  helper, whatever their callers do; the new rule 3 of the ratchet judges every such helper in `src/` and `bin/`. The MCP bridge masks
  the text of a failed call (`Error: ...`) and the JSON-RPC error of its HTTP form. The static exports (`mem viewer`, the project
  package JSON and its offline HTML view) were checked and are green controls.
- **`mem serve` guard, second pass:** `text/plain` bodies (the 500 texts that carry `e.message`) are masked as well; the answer is
  held until the body is checked, and a body that cannot be read (a broken gzip) becomes a bare 500 instead of going out; what is
  asked for again and again (the packed dashboard body) is masked once. The MCP refusal of the read-only profile masks the tool name.
- **The PEM patterns are linear** (review blocker): the open-block pattern read every header line two ways (2^n, 37 s for 143
  characters of prose in its first form), the complete-block pattern scanned to the end of the text from every BEGIN line (2.8 MB:
  38 s); now unambiguous, and the span between BEGIN and END is capped at 8 KB. Probes with time limits in `test/redaction-linear.test.mjs`.
- **`git@github.com:Owner/repo.git`** is no credential pair any more (an scp-style remote); a bare secret after `git@host:` still is.
- **Card text, cost bounds before the fold** (review of the merge): `cardrules.clean` cut to `MAX_IN` BEFORE it squeezed white space,
  so with a long white-space lead and a token over the edge the cut-through rest of the token ended up at the END of the folded text,
  where no pattern knows it (and `mem card add` wrote it to the shelf). New `outputguard.costCut(text, n)`: a cost bound that drops
  the run the edge broke, used in `clean`, `plainText`, `partsOf` and `maskedCopy`. `cardstore.write` now says what the mask took
  out (`redacted: github-token x2`; it said nothing since `clean` masks before the write core sees the fields), on the CLI and in the
  bridge. Probes run against this tree and against mutant copies of it (`test/mask-before-cut.test.mjs`).
  Trade-off, known: a field longer than `MAX_IN` (8192) with no white space at all (a long URL, a long run of Chinese or Japanese
  text) now loses the broken run whole instead of being shortened, so such a card field can come back empty. Card fields show at
  most 320 characters, so only inputs far beyond that are touched.
- **An open PEM block** (header and key material, no END line: a text cut inside the key) is masked by `redaction.mjs` too; before,
  ~1990 characters of a key survived `questiontext.prepare` (cut at 8000 before it redacts, a cost bound), and any window that
  ended inside a block. A header alone in prose is not touched.

### Security - a secret that is a phrase, or that a marker cut in two, falls whole (torn-marker finding, 2026-10-13)

Measured on the previous tip (7a46a3a), all open: `{"password": "correct horse battery staple"}` and `{"api_key": "Ab3x Ab3xK9mQAb3xK9mQ"}`
(`json-secret` took a value without blanks only), `{"api_key": "T [REDACTED:x] T"}`, `api_key=[REDACTED:x]T`,
`x-api-key: [REDACTED:x]T`, `X-Amz-Signature=[REDACTED:x]T` (a value that BEGINS with a marker counted as a placeholder, the stump
behind it stayed), `PASSWORD='two words'` (only the first word fell: `[REDACTED:env-secret] words`).

- **JSON string values.** Under a secret key (the `json-secret` key list, now with `passphrase` and `api-key`/`x-api-key`) the WHOLE string
  value falls, from the opening quote to the closing quote of the same kind that is not escaped: blanks, `\"` and markers
  inside it included. Found by a scan in code (`redactJsonStrings`), not a pattern, because "not escaped" is a count of
  backslashes; a JSON object carried as a string inside a JSON line (`\"password\": \"...\"`) is read at its own nesting level.
  No cap on a string that ends (a cap would leave the tail of a long value behind). If no closing quote follows (cut text), the
  next 4096 characters fall. Single-quoted values count too (`'password': '...'`, `PASSWORD='...'`). Linear: forward only,
  a failed search for a closing quote is remembered per quote kind (`test/redaction-linear.test.mjs`, 1 MB shapes).
- **`key=value`.** A value that begins with a marker is no longer harmless while a stump follows it (`api_key=[REDACTED:x]T`); the
  same in the `x-api-key` rule (the value runs through markers) and in the signed-URL rule. A value of markers alone stays as it is
  (idempotent), as do markers followed only by closing punctuation or by a delimiter the value rules do not stop at themselves
  (a backslash, `%26`).
- **Not widened, on purpose.** An unquoted `key=value` with blanks in the value (`password=correct horse`) still ends at the blank:
  there the blank is the end of the value in prose and in shell (`export TOKEN=abc run it`), and widening would eat the sentence.
  `api_key=T [REDACTED:x] T` keeps its `T` (a single character is below every minimum). Quoted values are delimited, so they are
  taken whole.
- **False-alarm guards**, each measured on the corpus (docs, tests, src, bin, bench, README, 244,000 lines): a code literal that ends
  with the equals sign (`indexOf('FOO_TOKEN=')`), a key that continues for more than 12 characters behind the keyword with a prose
  value (`"token_system_is_a_facade": "<paragraph>"`), a bare key with a sentence of twelve words (`secrets: '...'`), a quote on
  a later line behind a bare key, a whole placeholder (`your password`, `<your password here>`), a pagination cursor. The gaps these
  leave: a passphrase of twelve plain words behind a bare key; a phrase behind a key with a long suffix; a kebab key (`secret-value`)
  needs a credential-shaped value, as before.
- Corpus before/after: two lines changed, both fixtures that hold a plaintext word behind `secret` (the old rule had masked only
  the first word). `test/redaction-json-string.test.mjs` (red on 7a46a3a); Parity: lm=open.

### Security - a placeholder is a placeholder only as a whole value (both houses, owner decision 2026-10-13)

The exception list of `src/redaction.mjs` excused every value that merely STARTED with `your`, `my`, `test`, `example`, `sample`,
`dummy`, `fake` or `placeholder`: a value such as `my` + `Secret123!` or `test` + `1234` after a `password` key went through unmasked. Now the whole value must be
a placeholder word (`your`, `my`, `dein`, `ihr`, `beispiel`, `example`, `sample`, `dummy`, `fake`, `placeholder`), alone or with exactly
one generic word behind it (`password`, `key`, `api_key`, `token`, `secret`, `value` ...), joined by `_`, `-` or nothing:
`your_password`, `my-token`, `example` stay; `test...` is no placeholder at all. The commit scan runs the same `redact()`; it keeps
no list of its own. One fixture value in bench/value-report.mjs (an exported API token that read `your-token-here`) became `your-token`. A random test value that
started with a placeholder word made `test/headline-rule.test.mjs` flake; its value now starts with `Q7`.
`test/redaction-placeholder.test.mjs` (red on acff04e).

### Security - a person's question closes only on the person's confirmation; a headless run never writes tier `user` (2026-10-12)

Port of lucky-mem `fragen-rang-lm` (owner decision, variant A). Reproduced on the previous tip first (red), then fixed
(green): `test/question-rank-cm.test.mjs`.

- **The `resolves` gap.** `question.all()` read "some `resolves` edge points at it" and never asked who wrote the edge, so
  `mem answer`, the bridge's `mem_answer` and a raw `mem log link --kind resolves` closed a question the owner had asked
  himself. A question of tier `user` is now closed only by an edge of tier `user` (`authority.mayCloseQuestion`); an
  agent's answer leaves it `waiting` ("answered, waiting for you") in `mem questions`, the board tile, the work tile, the
  dashboard payload (`waitingQuestions`, full and compact build) and the entry state. Every other question closes on any
  edge, as before. Nothing is rewritten: the state is folded from the graph (`question.stateFrom`).
- **The person's way.** `mem questions new "..." --authority user` asks as the person, `mem questions confirm <id>
  --authority user` closes an answered question, `mem answer ... --authority user` answers and closes at once; the
  dashboard has a "Confirm answer" button (task `question-confirm`, password session only, 403 for the token alone).
  The bridge has no confirm tool on purpose.
- **A headless run never writes as the person.** The guard moved from single commands into the write core
  (`memory.logEntry`): a line that would carry tier `user` from a run with `MEM_HEADLESS` set is refused, whatever the
  route. Under a lower `CHEAP_MEM_MAX_AUTHORITY` the claim is still lowered and recorded (digest, reflector unchanged).
  `authority.checkNotHeadless / checkUnderUserCeiling / checkUserWrite` are the shared parts; `mailpermit` uses them.
- **Existing data changes state, once, on update.** A question a person asked (tier `user`) that an agent has ALREADY
  closed before this update reads as `waiting` afterwards, not as closed: the rule is folded from the graph on every read,
  so no migration runs and no line changes. Look for them with `mem questions` and close each with
  `mem questions confirm <id> --authority user` (or leave it waiting). Questions asked by agents, and old ones without a
  tier, are unaffected.
- **What the headless guard is for.** It protects against accidental and injected writing (a watcher-woken or
  reflector session, a prompt that talks an agent into claiming the person's word). It is not a defence against an agent
  that has its own shell: whoever has a shell is a person for the CLI, as in `docs/security-model.md`.
- **Counts.** Waiting questions are counted apart, beside `open` and never inside it: the per-project `waitingQuestions`
  (full and compact build), the weekly metric `waitingQuestions` in the measurement series, and the board/work tiles.
- **The button.** "Confirm answer" is a live button only where the dashboard has a password session (the same test as the
  category clicks); otherwise it is shown disabled with the command to copy, instead of a click that ends in a 403.

### Security — second review of the shape rule (2026-10-12): one write gate, non-object lines, cache format 16

Each finding was reproduced on the previous tip first (red), then fixed (green). `test/closing-why-gate.test.mjs`,
`test/non-object-line.test.mjs`, `test/search-cache-round-two.test.mjs`, `test/asked-evidence-shape.test.mjs`,
`test/doctor-drawers-both.test.mjs`, `test/mcp-setup-token-doc.test.mjs`.

- **A closing line with `"why": true` (regression, blocker).** `mem done <id> --why`, `mem discard`, `mem supersede --by
  <id> --why`, `mem duties close <id> --why` and `mem_duty_close` with `why: true` / `why: 5` reported success and wrote
  a closing line the readers call broken, so the target stayed open and `mem doctor` failed. `memory.logEntry` is now the
  ONE write gate: it judges the line with `fieldshape.shapeProblem` before anything is written (and before a shred key is
  stored) and refuses with the field named - so the CLI, the bridge, `closeDuty`, `retireEntry`, `supersedeEntry` and an
  import are covered, and `logEntry(root, 'decision', {topic: {a: 1}})` no longer writes. A list flag without a list
  (`tags: true`) is refused there as well. The CLI also refuses a value-less `--why` (and `--title` / `--text` of `merge`)
  in `done`, `discard`, `supersede`, `duties close`, `restore`, `merge` and `topic-merge`, naming the flag; nothing is
  written. **Breaking for a script** that passed a bare `--why`.
- **A drawer line that is `null` (or a number, a text, a boolean, a list) crashed 43 of 85 read commands.** `shapeProblem`
  answered "fine" for everything that is not an object and `parseLine` handed the parsed `null` through. Any top-level
  non-object is a BROKEN line now, with a reason, in `parseLine`, the drawer memo and `shapeProblem`; `mem doctor` names
  it and `mem status` (the `content` step) does not count it as an entry.
- **Search-index cache format 16.** A version-15 index (built by the first round of the strict rule) still held the
  documents of `key: 5` / `title: true` lines and lacked the `tags: true` ones, and was served as it stood. Rebuilt once.
- **`asked_evidence` is a strict list of records.** A number or an object there ended `mem asked-learn` in "not
  iterable"; such a line is broken now, and both readers (`askedlearn.learnedWords`, `missgold` places) iterate only a
  real list.
- **`mem doctor` keeps the legacy-list warning next to a broken line.** The `drawers` finding returned at the first
  broken line and hid the "list field without a list" lines; it names both now.
- **`docs/mcp-setup.md`:** the proxy-shape code block carries the `CHEAP_MEM_MCP_TOKEN=` line itself (a placeholder the
  shell refuses until it is replaced), so a copied block does not start token-less.

### Security — external review 2026-10-11 (Fable): duty replacement, other people's mail, dashboard doors (breaking for bridge clients and tools)

Each finding was reproduced against a throwaway root first (red), then fixed (green).
`test/b1-duty-replace.test.mjs`, `test/b2-b4-inbox-ownership.test.mjs`, `test/b5-b9-dashboard.test.mjs`.

- **B1 (high).** `mem_log` with `replaces_id` made any duty vanish (user duties, auto-duties) and its
  replacement closed without the F4 proof. `openDuties` now judges a replacement with the closing rule
  (`authority.mayChangeState`) and keeps `error_ids` along the chain, so a replaced F4 duty still asks for
  evidence; refused replacements are listed in `refused` and counted by `mem doctor` (`contested-claims`).
  **Breaking:** the bridge refuses `replaces_id` on type `duty` (use `mem_duty_close` / a new `mem_log`).
- **B2 + B4.** `mem_inbox_ack` and `mem_inbox_claim` only for the addressee (ack also for the holder of a
  valid claim). **Breaking:** an agent can no longer ack or claim mail addressed to someone else over the
  bridge. A single claim over the bridge is at most 120 minutes (the cap renewals already had).
- **B5.** The bearer token no longer sets the first password (setup code only) and `/login/logout` needs a
  session. **Breaking:** tools that set the first password with the bearer must use the setup code.
- **B6 + B7.** `/inbox/reply`, `/inbox/state`, `/setting` and the two verdict routes need a password
  session (403 otherwise, also with `CHEAP_MEM_SERVE_LOGIN=off`); the `raw-delete` task is `humanOnly`; the
  dashboard can point the raw archive only into the root, home, temp or `CHEAP_MEM_ARCHIVE_BASES` (new).
  **Breaking:** a script that wrote through these routes with the bearer token alone loses that.
- **B8.** Host check on `/`, `/desk.json`, `/console.json`, `/entry.json`, `/task.json`.
- **B9 (breaking for tunnel setups).** The sign-in lock takes the socket address; `CF-Connecting-IP` only with the new
  `CHEAP_MEM_SERVE_BEHIND_TUNNEL=1` (set it if a tunnel on this machine fronts the viewer, else all visitors
  share one lock). The lock across all sources is gone.

### Security — review of the Fable fixes (2026-10-11), follow-ups on `agent/fable-sicher-cm`

`test/b1-auto-duty-chain.test.mjs`, `test/b7-human-tasks.test.mjs`, `test/bridge-type-shape.test.mjs`, `test/b5-b9-dashboard.test.mjs`.

- **Auto-duty chain (regression of B1).** A digest/reflector (`CHEAP_MEM_MAX_AUTHORITY=inferred`) extending an
  agent's auto-duty was refused by the new fold; every repeat added one more open duty (3 for one file+class,
  base 1). An automatic duty extended by more error ids (same class/file/title/text/owner, stays open, keeps
  every id) is exempt from the rank rule; it cannot reword, close or shed ids. The write warning, the duty list
  and `mem doctor` use one rule now (`memory.dutyReplaceVerdict`); the warning says "the duty stays open".
  The fold is iterative and linear (a 30000-stage chain overflowed the stack, 2000 stages took 1.5 s).
- **`done`, `restore`, `merge` are `humanOnly` (breaking for tools).** They write the human stamp; a bearer-only
  `POST /task kind=restore` brought back an entry a person had closed. They need a password session, like
  `raw-delete`.
- **`type` as an array or an object bypassed the bridge locks.** `mem_log {type: ["duty"], replaces_id}`, `["workflow"]`
  and `["procedure"]` passed the strict comparisons and were written. `mem_log` wants a string `type`, and every tool
  refuses an array or an object where its schema says string (stdio and `--http`). **Breaking** for a client that
  sent an array where a string is declared.
- **An auto-duty extension adds only its own errors.** Every newly added `error_id` must be an error of the duty's
  class at the duty's file, else the replacement is refused (an unrelated error with a `guard` let a duty close
  without evidence for its own errors). Applies to any replacement of a duty that grew out of errors.
- **`mem_log` field shapes (breaking for odd clients).** `tags`, `symbols`, `asked_as`, `placeholders`, `files` and
  `used_by` may be arrays of strings; every other field must be a scalar. `owner: ["x"]`, `authority: {..}` and
  `tags: [{..}]` were written as given; they are refused by name now.
- **Host check is central.** Every dashboard route that is not an asset checks the Host (`/dashboard` was missing).
- **One server line** (never the header value) when `CF-Connecting-IP` arrives from loopback without
  `CHEAP_MEM_SERVE_BEHIND_TUNNEL`. Docs: with `CHEAP_MEM_SERVE_LOGIN=off` the owner-writing routes answer `403`; use the shell.

### Security — port of the sister house's Fable run (lucky-mem, 2026-10-11)

lucky-mem's own security run (branch `agent/fable-sicher-lm`) found gaps cheap-mem shares. Each was reproduced against
a throwaway root first (red), then fixed (green). `test/poison-lines.test.mjs`, `test/task-cancel-person.test.mjs`,
`test/task-json-paths.test.mjs`, `test/redaction-viewer-access.test.mjs`, `test/bridge-no-decrypt.test.mjs`.

- **A poisoned line no longer takes the readers down (lucky-mem error 5katltp7cfkr).** A line whose text field is an
  object (`tags: {toString: "x"}`, `owner: {a: 1}`, a list as `title`) or whose `ts` / `id` is not text crashed
  `mem find`, `context`, `duties`, `viewer`, `doctor` ("Cannot convert object to primitive value", "localeCompare is
  not a function"), ended the dashboard server (`/entries.json`), and made the recall hook fail silently for everybody.
  The bridge refused such values when writing; a raw line, an old CLI or a merge never meets that gate. Every reader
  that interprets the fields of an entry goes through `memory.parseLine` (`src/fieldshape.mjs`; the write-time
  neighbour hints too, since the review of 2026-10-12): the line is BROKEN (`{__broken, raw, reason}`, the
  three-states rule), `mem doctor` names it with the field, and it leaves every other denominator. Nothing is
  deleted. The few raw scans that remain (the hash chain, the clock, the archive manifest) read only `id`, `ts` and the
  seal with type checks. Legitimate forms stay readable (a single tag as text, `origin`, `provenance`, `guard`,
  `chain_seal`). **Behaviour change:** a line with a numeric `ts` was found before and is reported as broken now.
- **A text field is text; a list flag without a value is refused (review 2026-10-12).** A number or a boolean in `key`,
  `text`, `why`, `valid_from` (and every other prose field) crashed `context`, `core`, `facts`, `viewer`, `today`,
  `/desk.json` and `/dashboard.json` while `mem doctor` stayed ok; the CLI itself wrote `"key": true` when `--key` had no
  value. Such a line is BROKEN now, like one with an object there, and the doctor names it; the readers that sort or slice
  coerce with `String()` as a second line. **Breaking for the write side:** `mem log` / `mem correction` refuse a flag
  without a value for every field except the real switches (`--shred`, `--automatic`, `--without-scaffold`,
  `--no-broadcast`) - `--tags`, `--asked`, `--rejected`, `--symbols`, `--files`, `--key` alone are an error and nothing is
  written; `mem_log` refuses a number or a boolean in a text field. **Behaviour change:** old lines that carry `"key":
  true` or `"title": true` are broken and vanish from the readers (the doctor lists them); old lines with `"tags": true`
  (a list flag without a value) stay readable as an empty list, and `mem doctor` WARNS (`drawers`). A line nested deeper
  than 32 levels is broken (an `origin` nested 40,000 deep overflowed the stack of find, viewer and doctor).
- **The shape rule is inverted (the same in lucky-mem).** A field the readers touch that the list did not name still
  crashed them (the search field weights, the subject field per type). Now EVERY top-level field is judged: a text, a
  number, a boolean, null, or a list of those; an object is wrong. The exception is a named allowlist of structured
  fields (`origin`, `provenance`, `guard`, `chain_seal`, `body_enc`, `references`, `asked_evidence`), derived from the
  real data (the CLI for every type, the fixtures, the bench corpora). No object carries a key that converts it
  (`toString`, `valueOf`, `constructor`, ...), nothing nests deeper than 32 levels. **Behaviour change:** a hand-written
  line with an object in a field outside the allowlist is broken now. `test/field-shape-inverted.test.mjs`.
- **Cancelling a task needs a password session (breaking for tools).** `POST /task/cancel` took the bearer token alone;
  now `403` without a session, checked before the kind and the state. `raw-delete` cannot be cancelled (`409`: it frees
  the bytes, then writes the tombstone). **`export` is `humanOnly` (breaking for tools):** it decompresses the raw
  captures into a folder; `integrity` only reads and stays open. `tasks.cancel(root, kind, { user: true })`.
- **`/task.json` names no server path.** Command, result and reason show `<root>` and `<code>`; the state file on disk
  keeps the full command.
- **The viewer's own ways in are redacted.** `?k=<token>`, `mem_k=` and `mem_session=` (also `%3Fk%3D`, `\u0026k=`,
  `&amp;k=`) fell in clear text in raw captures, stored lines and every output. New pattern `viewer-access`, canary 14
  (`redaction.CANARY_COUNT`); the value falls whole, the name stays.
- **The MCP bridge does not decrypt unless the operator says so (behaviour change).** The bridge process can read
  `.mem/keyring.json`, so a connected agent read entries written with `shred` that a clone of the git data cannot.
  They show as unreadable over the bridge now; `CHEAP_MEM_MCP_DECRYPT=1` restores the old behaviour. CLI and dashboard
  unchanged.
- **An index built before this fix is rebuilt once.** The search-index cache is version 15: a version-14 cache stays valid
  by its file stamps and could still hold documents of poisoned lines (`mem find` listed them, `mem retrieve` threw
  after the upgrade). `test/stale-index-fieldshape.test.mjs`.
- **No loopback trust behind a tunnel (lucky-mem B9/B14).** A request that carries a proxy header
  (`cf-connecting-ip`, `cf-ray`, `x-forwarded-*`, `x-real-ip`, `forwarded`) is not "local" for the token-less door when
  nothing stands behind it: the viewer with the login off, and the MCP bridge over HTTP. With the login on the password
  stands behind the door and nothing changes; with a token nothing changes. **Breaking** for a token-less, login-less
  viewer or bridge that is reached through a local tunnel: set a token. `test/loopback-proxy-headers.test.mjs`.
- **`mem doctor`'s `entry-form` still names the old swallowed-value damage** (`title: true` plus a field name with
  whitespace) although the readers call such a line broken: it looks at the parsed line, with its place and its advice
  (`drawers` counts the line too).
- **Derived files are rebuilt once:** `backlinks.json` (version 2), `component-table.json` (2), the dashboard head (2)
  and the time track of a drawer (3) join the search index (15), so nothing built from lines that are broken now is
  served. **Restart note:** a long-running `mem serve` or `mem-mcp` process keeps its old code and its old in-memory
  caches; restart it after the update (the unit file or `systemctl restart` for a service install).
- **Redaction `viewer-access` is stricter about code (review 2026-10-12):** `;k=` counts only inside a URL, and the value
  must be token-shaped and not run on into code (`k=someObject.longName`, a call). A dotted token is no longer caught.
- **`/task.json`** also covers a symlinked root (the real path) and both path separators.
- **Mem-mcp over HTTP (docs/mcp-setup.md):** the token-less reverse-proxy shape is `403` since the loopback change above;
  the setup text now says a token is required behind a proxy. `mem serve` prints one hint on stderr when a proxy-header
  request is turned away (no token, login off).
- `errorclass.coverage` and the `content` status step leave broken lines out of their counts.
- Checked, no gap here: an `In-Reply-To` letter never closes a request (state is addressee-only since B2); the
  dashboard's archive location (session + allowed bases) and the CLI split like lucky-mem's.

### Added — atlas phases `bridge` and `silent-errors`

Plan step 3 (T3, part 2). Quick sizes only (about four and six seconds); no full atlas run.

- **`bridge`** (`bench/atlas/phase-bridge.mjs`, a stdio client in `bench/atlas/bridge-client.mjs`): the
  doors the security ports closed, counted against a real `bin/mem-mcp`: fields refused per writable type
  and class (machine, shred, unknown), `closes_id` with the pointer to `mem_duty_close`, `guard`, the
  clamped authority, an appointment with `requested_by` + quote stays a proposal, a foreign `from` on
  `mem_inbox_write`, `mem_store_put` outside the intake (absolute, `..`, symlink, in the root, missing),
  and the longest unbroken run any pattern scan is handed for a very long title (preload
  `bench/atlas/run-counter.mjs`, bound 512, no wall clock). A positive control per group. 75 records;
  against `91b1afc` 52 of them are red, on this state none.
- **`silent-errors`** (`bench/atlas/phase-silent-errors.mjs`, injector `bench/atlas/inject-search-failure.mjs`):
  the three-state rule as records: `readLog` in five states, the same states on `mem find` / `mem context`
  over the CLI and the bridge, the client-visibility journal (E1) and the subagent task lane (E3). First
  measurement: E1 `fail` (`src/mcpvisibility.mjs` `read()` answers an unreadable journal like a missing
  one), E3 `fail` (`src/subagenttask.mjs`: a lane that throws is answered `null`, like "nothing found"),
  six `degraded` (a broken line is skipped without a word on `find` and `context`, over both doors; an
  unreadable log in `mem find` is an error that does not name the file). Recorded, not fixed.
- `test/atlas-phase-parity.json`: `bridge`/`bruecke` and `silent-errors`/`stille-fehler` mapped, and the
  sister house's other phases (wiederherstellung, lesekreis, weiche, netz-tempo, partition, nutzung, guard)
  listed as only there, each with its reason.

### Added — atlas phases `skala` and `identifiers`, and a phase-parity test with the sister house

Plan step 3 (T3, part 1). Quick sizes only so far; the real scale run comes later on a quiet machine.

- **`skala`** (`bench/atlas/phase-skala.mjs`): per rung (`--rungs`, quick 1,000 and 4,000, full 10,000 and
  100,000, 1,000,000 on request), the lines and bytes `mem find`, the retrieval hook and `mem context` read
  (a counting preload, `bench/atlas/io-counter.mjs`), documents visited and candidates per query, index
  bytes and peak RSS; wall-clock p50/p95 as a companion that reads `not-measured` under foreign load. The
  corpus comes from `bench/scale-gate.mjs` (`buildRoot` is exported, one owner). Growth across rungs is
  judged by slope. First measurement, at 1,000 and 4,000 entries: a warm `mem find` reads each typed log
  about three times (opened four times), the index once.
- **`identifiers`** (`bench/atlas/phase-identifiers.mjs`): identifiers with underscores and umlauts, with
  transliterated and in-sentence forms and comparison forms; counter is the rank, expected 3 or better,
  asked of `find`, `find --recall` and `find --content-words`. First measurement: red on the
  `--content-words` path for every underscore and umlaut form (`src/search.mjs` splits at `_`, the index
  keeps it), and red on `find` and `find --recall` for an umlaut identifier typed as its transliteration.
  Recorded, not fixed.
- `test/atlas-phase-parity.json` and `test/atlas-phase-parity.test.mjs`: the sister house's phase ids as a
  fixed list, deliberate differences with reasons, a positive control. `bench/atlas.mjs` takes `--rungs`.

### Changed — bridge hardening, second round: counterpart ids, `closes_id` / `guard`, sender identity, store intake (breaking for bridge clients)

Counter-check of the A6/A12 port (2026-10-11). `test/bridge-hardening.test.mjs`, red on fb48a54.

- **A counterpart id is an entry id.** `replaces_id` / `retires_id` count only as a string in the
  shape of an entry id (4 to 64 of letters, digits, `-`, `_`). `false`, `0`, `[]`, `{}`, `"x"` used to
  count as "an id is named" and let `state` / `by_id` through; they are refused by name now. A null
  or blank string is "no id" (and `state` / `by_id` stay refused without one).
- **A duty can be closed only by `mem_duty_close`.** `mem_log` with `closes_id` + `state: done`
  closed a duty WITHOUT the F4 proof (a guard on the error, or a test file) that `mem_duty_close`
  asks for. The bridge refuses `closes_id` on `mem_log` and names `mem_duty_close`. `guard` on an
  error is refused too: `memory.dutyHasEvidence` counts a guard object as F4 evidence, so a latch the
  writer wrote itself (pointing at a file that does not exist) opened that door. A human sets a guard
  at the CLI, which checks it at creation. (The F4 test that seeded its guard over the bridge now
  seeds it with `mem log error --guard-kind ...`.)
- **The sender of `mem_inbox_write` is the bridge's identity.** `from: "user"` wrote as the human.
  The sender is `CHEAP_MEM_AGENT` (else `mem whoami`), like `mem_inbox_claim`; a `from` that names
  someone else is refused, the same name is accepted.
- **`mem_store_put` reads only from an intake folder.** It took any path the server could read
  (`/etc/...`, a key file, another project's database) and an `agent` from the caller. Now the file
  must lie in `<root>/store/intake` or in a folder listed in the new `CHEAP_MEM_STORE_INTAKE`
  (compared by real path: a symlink out of the folder, `..` and a sibling folder with the same prefix
  do not count; the refusal does not say whether a path outside exists). The register's `agent` is
  the bridge's identity. The CLI (`mem store put <path>`) is a person at the keyboard and is unchanged.
- **The intake check and the read are one act (third round).** `store.put` with `noFollow` opens the
  file with `O_NOFOLLOW`, reads from the descriptor and re-checks that the path is still its own real path
  (a link swapped in for the file, or for a folder above it, after the check is refused). Size and the 25 MB
  limit come from the bytes read, not from `stat` (a `/proc` file reports 0), also at the CLI. A file named
  `..x` inside the intake folder is inside. `CHEAP_MEM_STORE_INTAKE` takes absolute paths only (a relative
  entry is ignored and named in the refusal); `/` opens everything, the operator's decision.
- The duty list takes `due`, `due_date`, `until`, `deadline`, `by`, `to`; the `mem_log` tool schema
  says which type takes `choice` / `class` / `from` and advertises `replaces_id`.
- The quote of the unverified appointment note is embedded as a JSON string: it cannot close the
  note and start a line that reads as verified.

**Release note.** Bridge clients that close duties through `mem_log`, send a `from`, hand
`mem_store_put` an arbitrary path or set a `guard` must change: use `mem_duty_close`, leave `from` out,
put the file in `store/intake`. Ship it with a minor-version bump.

### Fixed — hostile values: one entry with `<!--` blanked the standalone viewer, and one long title froze the dashboard build (A9)

A probe that feeds the same hostile corpus (script tags, event-handler breakouts out of
double and single quoted attributes, `javascript:` text, HTML entities, `</script>` and
`<!--` in the embedded data, U+2028/9, very long values) into title / text / tags / topic
and the type's own fields, and then looks at the DOM, found **no script injection**: the
dashboard (`mem serve`, all 32 screens, every drawer tab, the search box), `/entries`,
`mem board --html` and the viewer show every value as text, and a text typed as an entity
stays as typed. It found two other defects, both a hostile value stopping a surface:

- **`mem viewer` file stayed blank** when any entry contained `<!--`. `safeJson` wrote
  `<\!--`, which is not a JSON escape; `JSON.parse` of the data block threw. It now writes
  `\u003c` for the `<` of `</` and `<!--` (what `src/readview.mjs` always did).
- **One long title froze `mem serve`.** The write path accepts an entry up to 1 MiB, and
  `entity.PATTERNS` ('name', 'path') and `netderive.FILE_RE` were quadratic in the length of an
  unbroken run of characters: 60 000 characters cost `collectDashboard` 22 s of CPU, 150 000
  more than 90 s, event loop blocked; the same patterns run for the search index and the recall
  hook. `entity.boundRuns` now limits an unbroken run to 512 characters before those patterns
  scan it (no identifier, path or file name is longer). Text without such a run is
  untouched; a differential probe pins that. 150 000 characters now cost under a second.

**Release note.** A pasted blob or minified line longer than 512 characters without a space
is no longer scanned for identifiers and file names past its 512th character; everything
else about search is unchanged. `test/hostile-surfaces.test.mjs`.

### Changed — an appointment made over the bridge is always a proposal, also with `requested_by` + `quote` (behaviour change of a documented intent)

Port of lucky-mem's A12 (2026-10-10). The tool description and `docs/appointments.md`
said that a plain reminder with `requested_by: "user"` and the user's quoted sentence is
active at once. Nobody verified who said the sentence: `appointments.create` only checked
that `by` is `user` and the quote is not empty, so any connected agent got an active
reminder (it fires, it reaches the human's calendar) that also stayed out of the daily
cap on agent proposals. Same class as a claimed authority tier (Y4b).

Now `mem_appointment_new` over the bridge always creates a `proposed` appointment that
counts towards the cap. `requested_by` / `quote` are still required together (and only
`user` is accepted), but the claim is written into the text as a marked note
(`[Unverified: <agent> claims over the bridge that the user asked for this: "..."]`),
never as the `requested_by` field the clock and the cap read as a proven wish; the answer
carries `wishVerified: false`. A `private` appointment stores neither the text nor the
quote. **The CLI is unchanged:** `mem appointment new --requested-by user --quote "..."`
(what the digest uses) still makes a plain reminder active at once.

**Release note.** A client that relied on the bridge to get an active reminder now gets a
proposal; the human confirms it (`mem appointment confirm <id> --authority user`, or the
dashboard). `test/bridge-appointment-claim.test.mjs`.

### Changed — `mem_log` over the bridge takes an allow-list of fields per type; machine and audit fields are the bridge's, not the caller's (breaking for bridge clients)

Port of lucky-mem's A1/A6 (2026-10-10). `bin/mem-mcp` used to write every argument
key except `type/project/tags/agent/id/ts`, and `memory.logCheckedEntry` passed the
machine fields (`state`, `status`, `v`, `authority_clamped_from`, `guard_at_creation`)
through as stamps: a bridge caller could forge the record of a demotion it never had,
an audit result, a `status`, or switch the write to the encrypted-body mode with
`shred`. A block-list is as good as its author's memory, so it is now
`src/bridgefields.mjs`: per type, the fields that are allowed (body fields, access
words, validity dates, the few type fields the readers look at); any other field is
**refused by name, with the list of what is allowed, and nothing is written**, never
silently dropped. `replaces_id` / `retires_id` stay (their effect is
judged on read by `authority.mayChangeState`; `closes_id` was taken out again in the second round), and `state` / `by_id` travel only next
to one of them. `authority` stays clamped to `agent`; `authority_clamped_from` is
written by the bridge only. `agent`, `id` and `ts` are still set by the write path and
ignored if sent. A non-array `tags` is refused instead of dropped. The refusal is a
pure loop over the keys, before any read.

**Release note.** A client that used to send free extra fields over `mem_log` now gets
an error naming them. Put the content in `title` / `text` / `why`, or, if the field is
a legitimate one, add it to `src/bridgefields.mjs` with a reason. The CLI (`mem log`)
is unchanged: a human at the keyboard may still write any field.
`test/bridge-fields.test.mjs`. **Breaking for bridge clients: the release that ships this
needs a minor-version bump** (see the second round below, which tightens it further).

### Changed — the hooks no longer probe the maintainer's machine paths (behaviour change)

The default root chain of the recall, before-edit, after-failure, catch-fail,
subagent-start and stop hooks (six POSIX scripts and their six `.ps1` twins) is now `CHEAP_MEM_ROOT`, then `$HOME/cheap-mem` (`%USERPROFILE%\cheap-mem` on
Windows), and nothing else. `/work/cheap-mem` and `/home/user/cheap-mem` are
gone: on a shared machine a hook could read a stranger's memory from there and
the stop hook could push into it; on Windows `/work` means nothing.
`MEM_RETRIEVE_ROOTS` and `MEM_STOP_ROOTS` still replace the list.

**Release note.** If your memory lives at `/work/cheap-mem` and you ran the
hooks without `CHEAP_MEM_ROOT`, set `CHEAP_MEM_ROOT` (the installer does) or
`MEM_RETRIEVE_ROOTS` / `MEM_STOP_ROOTS`. `test/hook-root-chain.test.mjs` proves
it: the old source finds a root at a relocated old place, the new one does not.

### Added — the injection journal says where the session ran (`origin`), and `bench/injection-by-origin.mjs`

A line of `.pipeline/injections.jsonl` carries `origin`: `cloud`, `ssh`, `local` or
`unknown` (the closed vocabulary lives in `src/origin.mjs`; only the class is
recorded, never a host; old lines without the field read as `unknown`).
`node bench/injection-by-origin.mjs [--root DIR] [--before ISO] [--after ISO]
[--occasion a,b] [--json]` evaluates the journal per occasion and per origin:
line count, p50/p95 of `duration_ms`, the share served by the recall server and
why not. Read-only.

### Changed — documentation sweep (2026-10-04)

No behaviour change. The README's file tree and command list now cover every
drawer and every command `mem --help` prints; the install pages list all seven
Claude Code hooks; `docs/design.md` no longer says there is no encryption (it is
off by default, per entry, `src/shred.mjs`) and says the reflector is opt-in;
`docs/dashboard.md` lists every read route; `SECURITY.md` lists the output guard,
the signed-URL rule, the write switch and the door in front of the dashboard;
`CLAUDE.md` and `CONTRIBUTING.md` name the `Parity:` trailer and the rules for
numbers and environment variables. The environment register's descriptions of
`MEM_DIGEST_VOLUME_NOW_KB` and `MEM_DIGEST_VOLUME_MIN_KB` now say what the code
does (the digest's volume threshold and floor, not a test hook).

### Added — redaction knows signed-URL parameters (port of lucky-mem `signierte-url`)

`src/redaction.mjs` gets the rule `signed-url`: the value of `X-Amz-Security-Token`, `X-Amz-Signature`, `X-Amz-Credential`, `X-Goog-Signature`, `X-Goog-Credential` and of an Azure SAS `sig=` (only together with `sv=<date>`) is replaced by `[REDACTED:signed-url]`; the name and the equals sign stay. Plain, `%3D`/`%26`, `&amp;` and JSON-escaped (`\u0026`) forms are covered. Before this, `X-Amz-Signature=<64 hex>` survived raw capture and `X-Amz-Credential` lost only its `AKIA` prefix. Canary count 12 -> 13. Probe: `test/redaction-signed-url.test.mjs` (real capture path and real pre-commit hook).

### Added — the before-edit journal names file and tool (L1); Changed — the skill-effect window (L5) (port of lucky-mem `vorher-hook`, 2026-10-03)

- **L1:** a before-edit journal line carries `file` (the relative path, two segments, never
  absolute, never `..`, never content) and `tool` (Edit, Write, Bash, ...), in the bash and the
  PowerShell hook. Without them "too weak" could never be checked afterwards. Other lines stay
  byte-identical (`injection.fileNormal`). `test/before-edit-journal-file.test.mjs`.
- **L5:** `mem skills effect` counted an offer as "not fetched" when the capture reached past its
  window, whatever its start. Every offer made before the start of the one readable capture of its
  session therefore counted (in the sibling house "0 of 87" was a measuring artefact, really
  observed: 0 of 95). Now the capture must have BEGUN before the offer too, and several pieces
  count only as far as they join without a gap. `test/skill-effect-coverage.test.mjs`.

### Added — a subagent gets what fits its task (port of lucky-mem `unteragent: Auftragsabruf`)

- **`src/subagenttask.mjs`:** at SubagentStart a second block next to the old
  one (which stays byte-identical): at most 4 hits and 1,500 bytes of errors
  (with their solution line), learnings, duties, procedures and skills that
  fit the subagent's task. Lane 0: files the task names (component table, read
  only); lane 1: the task's content words, the recall hook's bar
  (`MEM_RETRIEVE_MIN`). Never encrypted entries, entries of the category
  `personal`, entries naming a person of `global/people.yaml`, a closed duty or
  any other type.
- **The task text is not in the documented hook input** (only `agent_id` and
  `agent_type`; the old `j.prompt` was an unproven assumption, and the workflow
  trigger that hung on it ran into nothing). It is read, fail-soft, from the
  subagent's own transcript (`<parent transcript>/<session>/subagents/agent-<id>.jsonl`,
  first user line; observed, not documented). The workflow match uses it too.
- **Time:** `MEM_SUBAGENT_TASK_SECONDS` (default 2). `bin/mem-subagent-start`
  runs a first pass under that cap and, on rc 124 or a failure, the old block
  alone; `MEM_SUBAGENT_TASK_OFF=1` switches only the extra off. (The PowerShell
  twin has the in-process cap only.)
- `test/subagent-task.test.mjs`; red proof against the fixed base commit, a
  positive control beside every "never".

### Added — the solution under its error, the account under a skill offer (port of lucky-mem `abrufanhang`, L3 + L4)

- **L3, `src/recallattach.mjs`:** where the question recall, the after-failure
  recall, the swallowed-failure recall, the before-edit hook (bash and
  PowerShell) or the subagent block show an error that has a valid solution,
  one line stands directly under it: `  ↳ Solution <id>: <core>`. The newest valid
  `resolves` link wins; its source is an entry in force or a commit proof
  (`commit:<hash>`); a replaced solution never shows. It counts in the byte
  budget of the short form (H5), where another hit gives way first.
- **L4:** a skill offer for a skill that declares a scope brings the two most
  important lines of its experience account (open or repeated errors first,
  then the newest learnings; at most 400 bytes). A skill without scope costs
  nothing: the store is not read. `experience.stock(root, { light: true })`
  reads only errors and learnings.
- **Loaded on demand:** the module (and what it pulls in, the link reading and the search
  module) is imported only when an error hit is shown (`recallrender.lazyAttach`,
  `recallhook.recallWith`, `afterfailure.finishWith`; the before-edit hook imports it only when an
  error hit stands among its hits), so a recall without an error costs nothing extra
  (`test/hookcost-cm.test.mjs` stays green).
- **The journal's new field `ids`** (only ids, never text): the hit ids and the
  ids an attachment brought; left out when empty, so other lines stay
  byte-identical. A before-edit line carries the solution ids.
- Switches `MEM_SOLUTION_ATTACH=0`, `MEM_SKILL_ACCOUNT_OFFER=0` (registered).
  Never encrypted entries or the category `personal`.
- `test/recall-attach.test.mjs`; red proofs against the fixed base commit for L3
  and L4, positive controls for every "never".

### Fixed — the scope of a skill and the files of an error are lists (port of lucky-mem `skill-geltung`)

- `mem log skill --topics '["mcp","skill"]'` stayed ONE string and the reader tore it apart at its
  commas into `["mcp"` and `"skill"]`, so the skill's experience account counted 0 cases. `--classes`,
  `--files` and `--topics` are now stored as lists (from a JSON list or a comma list, like `--tags`;
  half-JSON is refused), in `mem log` and `mem correction` alike. Old stock: a list stored as JSON
  text is read as a list (`experience.scopeOf`).
- The same change makes `errorfile.files()` see an error's `--files`: it reads arrays only and ignored
  the comma string. A lucky-mem finding for `--gefragt-als` as JSON does not apply here: `asked_as` was
  already stored as a list.
- `test/skill-scope-list.test.mjs`; red proof against the fixed base commit, positive controls.

### Fixed — a zombie holds no lock (port of lucky-mem `prozess-zombie`, `nachlese-sperre-zombie`)

- `process.kill(pid, 0)` also succeeds for a `<defunct>` process (ended, not collected by its
  parent). In the sibling house such a zombie held a night run's lock for eleven hours and made a
  resume path take an old build for a running one. **`src/processalive.mjs`**: on Linux the state
  in `/proc/<pid>/stat` counts (`Z`, `X` are dead); without `/proc` the signal decides as before.
- Read by the two places here that decided "alive" by the bare signal: the file lock's orphan
  takeover (`src/filelock.mjs`: a zombie holder's lock is taken over at once instead of waited out)
  and the doctor's running-code check (`src/doctor.mjs`). `test/process-alive-zombie.test.mjs`
  builds a real zombie; red proof against the fixed base commit, positive controls with a living
  and a gone pid.

### Added — the project rule: hand-made projects are visible, Today lists projects awaiting confirmation (port of lucky-mem `projekt-regel-lm`, `projekt-auto-lm`)

- **`projectnew.handmade(root)`:** a project that arose past the command (first
  entry on or after 2026-10-02, no `Project created` event, no `status` in
  `facts.yaml`) never carried the mark `new` and was invisible. It is now
  listed by `mem project suggestions` (also `--json`, key `handmade`). Read
  only.
- **`mem project confirm`** accepts such a project (also without a
  `facts.yaml`); otherwise the button on the Today card would be dead.
- **`mem today` / the Today card:** new part (f) "projects awaiting
  confirmation" (status `new` plus hand-made), with the existing confirm task
  of the Projects tab; nothing waiting takes no room. `counts.projectsAwaiting`
  and one clause in the session line.
- **The rule as one line** in `mem core` (before the facts, no budget cut drops
  it) and in the closing hint of the subagent start: a new project only through
  `mem project new ... --reason ...`, never a folder by hand. A session creates
  directly with status `new`; only an unattended run (`MEM_HEADLESS`) needs
  evidence (unchanged, now pinned by a test).
- `test/project-rule.test.mjs`; red proof against the fixed base commit with a
  positive control on today's tree.

### Changed — `mem correction` inherits what it does not name (port of lucky-mem `korrektur-erbt-lm`)

- **The new line takes over every content field of its predecessor.** Named
  fields override, `--without <field>[,<field>]` deletes one explicitly. The
  finding behind it: a correction naming only `--topic` replaced the entry
  whole; title, tags and asked-words were gone and the entry dropped out of
  the recall.
- **Never inherited (administration):** `id`, `ts`, `replaces_id`, `agent`,
  `project`, `state`, the life-cycle ids, the authority stamp, `origin`,
  `valid_from`, the restore/merge markers and the envelope of an encrypted
  line. A closing correction and an encrypted predecessor inherit nothing (the
  latter with a warning). The old line stays byte-identical, the new one
  stands complete. `memory.correctionEntry(..., { without })`,
  `memory.inheritedFields`, `memory.NOT_INHERITED`.
- `test/correction-inherits.test.mjs`; red proof against the fixed base
  commit, positive control on today's tree.

### Added — a register of every environment variable, with a guard (port of lucky-mem `schalterregister`, n20)

- **`src/envregister.mjs`.** One row per environment variable cheap-mem reads
  (200 in all): kind (switch, tuning, path, connection, identity, secret,
  internal, test hook), default, one-sentence meaning. Standard variables
  (`HOME`, `PATH`, `TMPDIR`, ...) are not registered. The finding behind it:
  `MEM_EXPAND` was read through a constant (`env[ENV]`) and could be written
  down nowhere.
- **The scan sees every spelling:** `process.env.X`, `env.X`, `env['X']`, a
  constant `...ENV = 'X'` later read as `env[ENV]`, `$X` / `${X}` in shell
  scripts, `$env:X` in PowerShell, over `src/`, `bin/`, `install/` and `hooks/`;
  comments are not reads.
- **`test/envregister.test.mjs`** fails when a variable is read but has no row,
  and when a row is read nowhere. Red proof: a planted, unregistered read of
  each spelling turns it red (fixture trees, and once in the real tree);
  a fixture with only registered names stays green.
- **`mem envvars [--json] [--markdown]`** prints the register with the value each
  variable has in the current shell; a secret shows `set` or `not set`, never
  a value. **`docs/environment-variables.md`** carries the same table, generated
  by `--markdown` and compared byte for byte by the test, so it cannot drift.

### Added — category click actions in the dashboard (port of lucky-mem `kategorie-*`)

- **Topics page, with a password session:** assign a topic by the select in its
  category cell; confirm one proposal or all of them (dialog); acknowledge an
  automatically created category; rename (dialog) and merge (dialog) a category;
  create a category by name. Six task kinds (`category-assign`, `category-confirm`,
  `category-acknowledge`, `category-rename`, `category-merge`, `category-create`),
  persons only, each one the CLI call `mem category ... --json` (answer
  `{ok, text}`; the write actions of `mem category` take `--json` now). Feedback
  in the button and a status line, a refusal names its reason. Without a password
  session the commands to copy stand in their place.
- Tests: `test/kat-klicks-cm.test.mjs`, `test/kat-klicks-cm-browser.test.mjs`
  (red proof pinned to `5f9170b`).

### Added — document expansion: the field `asked_as`, read by the search only behind `MEM_EXPAND=1` (port of lucky-mem `gefragt_als`)

- **`mem log --asked-as 'a|b|c'`** (and the MCP bridge) stores 8 to 12 short
  everyday phrasings next to an entry as `asked_as`. At write time what does not
  fit (a question, more than 8 words or 60 characters, a copy from the entry,
  a duplicate, the 13th and later) is dropped and named on stderr; the entry is
  always written. The digest prompt asks for it in the same call, next to `--asked`.
- **Search, off by default (`MEM_EXPAND=1`).** Weight 0.3, stop words stripped,
  a word the entry carries only through the field covers half a typed word and
  never counts for the gate's "whole question covered"; the exact-identifier
  lane and the recall fallback do not see it; its own index cache directory
  (`.mem/search-index-expand`). Off: bit-identical. `src/expand.mjs`,
  `test/expand-asked-as.test.mjs` (red proof against the pinned old state).

### Added — an output guard, BOM-tolerant reading, id-less lines in the doctor (port of the lucky-mem atlas B14 fixes)

- **Output guard (`src/outputguard.mjs`).** A secret that got into a drawer past
  the write path used to come out in the clear of `mem find`, `show`, `when`,
  `context`, `retrieve`, the viewer file, the recall hook and the MCP bridge.
  Every render path now masks known key shapes as `[REDACTED:type]` through
  `redaction.redact` (one pattern list, no second one), before any cut. The
  line on disk is untouched; `mem doctor` still reports it. Red proof against
  the pinned old state in `test/output-guard.test.mjs`.
- **A UTF-8 BOM at the start of a drawer is tolerated when reading**
  (`memory.withoutBom`): the first entry was invisible to `find`, `show`,
  `when` and the viewer, and the doctor called it a broken line. Nothing writes
  a BOM, the file is never changed. `test/read-bom.test.mjs`.
- **Doctor: `entry-form` reports a line without an id** (warning, with
  `<file>:<line>`; handled by a finding of class `idless-line`), and `mem
  doctor` prints no raw `fatal:` line on stderr in a fresh or shallow clone
  (the parity cutoff is "not measurable, not zero"). `test/doctor-idless-and-quiet.test.mjs`.

### Changed — the dashboard package ported from the sibling house (dash-paket-cm, 2026-10-03)

- **Topics as a list, not one tile per topic.** Topic, entries, types, "Open
  thread"; sortable, filterable, 30 rows and "Show more", a small switch to
  tiles (remembered in the browser). The list counts the real topic (field
  `topic`, aliases resolved, counted over the whole store); "Open thread"
  filters the entries page; the free tags are the second tab. A category
  column, filter and overview appear only when `D.categories` carries data.
- **Offline reading view.** The export studio's button now downloads the
  SAME project package as ONE self-contained HTML file (`src/readview.mjs`,
  `?format=html`): search, list, detail and references, no network call, no
  outside address; encrypted entries stay "encrypted".
- **New project: confirm by a click** (task `project-confirm`, password
  session only; `mem project confirm <name> --json`). The copy-command stays
  under "Details".
- **Settings save** reports in the button and a status line (saved / not
  saved and why); **raw capture review** explains an empty digest instead of
  saying nothing was found; the **network legend** is two short paragraphs
  and names the condensed atlas only when it is on.
- **Overview order:** title, (day slot for the calendar), figures, network
  with "Your next look", Today across the full width, recently connected.

### Added — a calendar inside the memory: reminders, a day briefing, planned agent actions, and an outlet into your own calendar (kalender-cm)

- **`mem appointment new|list|show|cancel|move|confirm|due|tick|cap|today|calendar`**
  (`src/appointments.mjs`, `appointment-clock.mjs`, `appointment-time.mjs`,
  `appointment-today.mjs`, `appointment-invite.mjs`), ported from lucky-mem's
  appointment clock in English. Append-only `appointments/`. Reminders are notes to
  the human participant; an action is a letter with a task to an agent; a briefing
  is the day list as a letter, by code. Time expressions are English ("tomorrow
  9:00", "weekdays 7:00"), the zone is `timezone` in `.mem/config.json` (else
  `CHEAP_MEM_TZ`, else the system zone), UTC is stored.
- **Rights.** Only `--authority user` arms an action, confirms a proposal or sets a
  cap; agents and headless runs only propose. The human's own planning is the
  permission for the action's one letter (a single grant line in
  `inbox/permissions.jsonl`), with no extra rights for the woken agent.
- **Exactly once**, late instead of a storm, a past action never fires, a daily cap
  on agent wake-ups and another on agent proposals. `bin/mem-watch` ticks the clock;
  `MEM_WATCH_APPOINTMENTS=off|MEM_WATCH_APPOINTMENTS_SYNC=1`.
- **Calendar outlet** (off until configured): SMTP with an `.ics` (RFC 5545, a
  `VTIMEZONE` derived for any zone) or the Google Calendar API with a service
  account; journal with backoff and idempotence; secrets only from 0600 files; the
  doctor finding `appointment-invite`. Microsoft 365 often has SMTP AUTH disabled; a
  Graph route is not built. On the Google route the calendar owner's default
  reminders apply, not the service account's.
- **Surfaces**: MCP tools `mem_appointment_new|list|cancel`, a Calendar tab and a
  "Today in the calendar" card in the dashboard (read only,
  `/dashboard/appointments.json`), a digest-prompt section. See `docs/appointments.md`.

### Added — categories above topics (port of the sibling's kategorien work)

- **A layer above topics, shipped empty.** Four append-only tables under
  `global/` (`categories`, `topic-category`, `category-aliases`,
  `category-wishes`), applied on read; entries are never touched.
  `mem category list|open|assign|confirm|create|acknowledge|rename|merge|initial-assign`.
  `mem category create --suggested` adopts a neutral list (coding, design,
  testing, operations, security, ai-agents, media, personal); nothing reads
  that list unless a person asks, and the sibling's ten starter categories
  are NOT carried over.
- **Categories create themselves** when 3 different topics were proposed the
  same new one (spelling variants count together, wishes persist across
  runs), protected like `mem project new`: a near-duplicate lands on the
  existing category, a project name is refused. A person acknowledges,
  renames or merges. `mem log --category <key>` / `--category-new "key|Label"`
  carry the digest's proposal; DIGEST.md has the rule.
- `mem find --category <key>`; doctor finding `categories` (good while the
  layer is unused, warning when more than half of the topics are unassigned
  or more than 100 proposals wait, never an error); dashboard data
  `categories` and `category` on each topic (contract in `categoriesState()`).
- The orphan-drawer check no longer reports the four tables.

### Changed — a store the full build cannot handle gets a real answer and a condensed 3D atlas (atlas-pass)

- **ONE pass replaces the light head above 64 MB of drawers.** The compact
  build (`src/dashboard-compact.mjs`, `src/dashboard-pass.mjs`) reads every
  drawer once, line by line, and keeps counters, bounded lists and a
  fingerprint table of about 14 bytes an entry — no entry list in memory. It
  yields the line total, the counters, the net, the open questions, the
  agents, the projects, the newest 30,000 entries and the condensed atlas;
  the same `collectDashboard()` as the full build builds the rest, so the
  answer has the same shape. A drawer with retiring or correcting lines is read
  a second time, only for those lines and their targets. Port of the sibling's
  dash-tempo2 work.
- **The 3D atlas is condensed**: the 240 largest topics, every drawer, the 600
  strongest topic pairs and the newest 60 entries of each as the first page,
  fixed size, no free text. Zooming in loads the entries of a topic or drawer
  60 at a time (`/dashboard/part.json?part=atlas`), from the pass's sample, the
  window of the newest entries, or a search in the build worker; the page says
  "searching", never an empty list. An entry counts in every topic it carries.
- **Modules that read the whole store themselves** (integrity scan, duties,
  facts, topics, learnings) run up to 128 MB of drawers; above, each is
  unknown with its reason. The doctor and the today card (measured: the doctor
  needs 8.6 s at 20,000 and 98 s at 250,000 entries) never run in the compact build. The project
  package is refused there (503).
- **The heap guard starts the build safely.** The worker reports `ready` and
  starts its build one turn later (`setImmediate`): stopping a worker in the
  middle of the evaluation of an ES module crashed V8 on Node 22.22. With
  `NODE_OPTIONS=--max-old-space-size` the worker's own limit does not hold at
  all, so tests that rely on a cap run without it. If the compact build with
  its modules goes over the cap, it is built again without them.
- **Measured** (`node bench/board-tempo.mjs --synthetic N`, 4 cores shared with other work, load average 6 to 10; server = cold process with no head on disk, first `GET /dashboard.json`, then polled until the first real build; `env -u NODE_OPTIONS`; before = commit 4d746f6, after = this change):

  | store | build | first answer | counters shown | first real build done | peak RSS of the server |
  |---|---|---|---|---|---|
  | 100,000 entries (26 MB) before | full (below the 64 MB line) | 46 ms placeholder | 1.1 s (light head) | 42.4 s | 1.39 GB |
  | 100,000 after (same line, unchanged) | full | 60 ms placeholder | 1.1 s (light head) | 41.7 s | 1.21 GB |
  | 100,000 after, line forced down (`CHEAP_MEM_SERVE_FULL_BUILD_MB=1`) | compact | 58 ms placeholder | 8.6 s (the compact build itself) | 8.6 s | 0.68 GB |
  | 1,000,000 (263 MB) before | light head only, tiles and atlas unknown | 40 ms placeholder | 4.1 s | 7.7 s (light head) | 0.23 GB |
  | 1,000,000 after | compact (net, questions, agents, condensed atlas) | 40 ms placeholder | 10.9 s | 10.9 s | 0.69 GB |

  The 100,000-entry store stays on the full build by default (26 MB is under the
  64 MB line); the forced row shows what the compact build does with it: 8.6 s
  and 0.68 GB instead of 41.7 s and 1.21 GB, with the net, the questions and the
  agents but without the doctor and the 3D view of single entries. At 1,000,000
  entries the compact build costs 3.2 s more than the light head and 0.46 GB
  more, and in return the page has the net, the open questions, the agents, the
  projects and the condensed atlas instead of "unknown". Measured per
  module on 250,000 entries (66 MB): pass 3.3 s and 235 MB, integrity scan 2.3 s
  and 287 MB, topics 12.0 s and 765 MB, learnings 3.1 s and 469 MB; on 500,000
  entries (132 MB): pass 4.2 s and 279 MB, integrity 4.2 s and 427 MB, topics
  23.3 s and 1.24 GB, learnings 7.7 s and 810 MB (maximum RSS of a process
  running the one call). The doctor: 8.6 s at 20,000 entries, 97.8 s and 1.43 GB at 250,000. Not measured: the
  browser's first display at these sizes, 10,000,000 entries.

### Changed — a new project is created on purpose, never by a typo (ported from the sibling house)

- **`mem log --project <unknown>` is refused** (and every other writer through
  `memory.logEntry`, the MCP bridge included) with a hint, instead of creating a
  half-made directory. An old half-made directory stays writable.
- **`mem project new <name> --title --reason [--captures p1,p2]`** creates a
  project the guarded way: a name too like a project or a topic alias is refused
  and the existing one is named; the project gets a reason, an event and
  `status: new` in `facts.yaml`. In an unattended run (`MEM_HEADLESS`) it needs 2
  evidenced captures on 2 different days, checked by code. `mem project confirm`
  (a person only) removes the mark; `mem project suggestions [--json]` is the dry
  run. MCP: `mem_project_new` (writes) and `mem_project_suggestions` (reads).
  The dashboard's Projects card shows "new · unconfirmed". The digest and reflector
  prompts and HOUSE-RULES.md carry the rule. Merging projects is not built.

### Changed — the dashboard's first page no longer waits for the store (board-tempo)

- **The first answer of `/dashboard.json` is a small head** (newest 120 entries,
  the open duties and questions, `overview` counters per type and project, the
  paths of the parts), whatever the store size. The rest of the entries comes
  page by page through `/dashboard/part.json?part=entries&from=&n=`; the page
  says "x of y entries loaded" and takes its counters from the server, never
  from the part it holds. `experiences` (the learnings with their citation
  counts) is a deferred part now too, and the unused per-topic `trail` lists are
  cut in the head. A part that is not built yet answers `building`; the page
  never shows it as an empty list. Port of the sibling's dash-tempo work.
- **A restart answers at once.** The head lies in `.mem/dashboard-head.json`
  (0600, atomic, machine-local) without any `text`, `fact` or `why`; a cold
  start serves it as `cache.source: "disk"`, never fresh, with its reason, and
  rebuilds in the background. Without a head a large store gets a placeholder,
  then a light head (one pass over the drawers, bounded memory), then the full
  build. Over 64 MB of drawers (`CHEAP_MEM_SERVE_FULL_BUILD_MB`) only the light
  head is built, and the page says so.
- **The build worker's heap cap now holds.** `resourceLimits` alone did not on
  Node 22.22 (a 64 MB limit ran on to 2 GB); the parent polls
  `worker.getHeapStatistics()` and stops a worker over the cap (at most 4 GB).
  The cache's age counts from the END of a build, and the gap to the next
  background build is at least four times the last build's duration. The size of
  the store counts the archive manifest and the archived shards
  (`storeBytes`); only the manifest and the drawers decide whether the full
  build runs.
- **Measured** (`node bench/board-tempo.mjs --synthetic N`, 4 cores shared with
  other work, load average 3 to 5; server = cold process, first `GET
  /dashboard.json`; browser = Chromium with software GL, first display with the
  start page's counters):

  | store | old: first answer | old: bytes (packed) | new: first answer | new: bytes (packed) | new: counters shown | new: full build |
  |---|---|---|---|---|---|---|
  | demo world, 213 entries | 0.48 s | 169 KB (23 KB) | 0.49 s (sync, small store) | 128 KB (20 KB) | = first answer | 0.5 s |
  | 10,000 | 3.6 s | 4.3 MB (521 KB) | 0.04 s placeholder | 1.6 KB | 0.56 s | 4.6 s |
  | 100,000 | 34.8 s | 43.0 MB (5.1 MB) | 0.03 s placeholder; 0.04 s with the head on disk (75 KB, 16 KB packed) | 1.6 KB | 0.54 s; 0.05 s with the head | 26 s |
  | 1,000,000 | 494 s | 432 MB (51 MB), peak 8.1 GB | 0.04 s placeholder; 0.04 s with the head on disk (29 KB, 4 KB packed) | 1.6 KB | 3.6 s (light head); 0.04 s with the head | light head only, peak 0.23 GB |

  Browser first display: 100,000 entries 45 s before, 2.7 s without a head,
  0.8 s with the head on disk (warm 0.9 to 1.5 s); 1,000,000 entries 0.7 s
  placeholder and 3.8 s with counters without a head, 0.7 s with the head (warm
  0.2 to 1.3 s). The old state could not show 1,000,000 entries at all within a
  sensible time (the server alone took 494 s and 8.1 GB).

### Added — command guard: the before-edit hook warns before a Bash command that hurt before

- **An error of the class `mishandling` may carry a `command_pattern`**
  (`mem log error ... --command-pattern "git add -A$ ;; git add --all$"`).
  The before-edit hook on Bash shows the error once per session and
  error when a command matches, and never blocks. Matching is literal: the
  first wording must stand where a command starts, so a sentence that only
  names the command triggers nothing. A shell prefilter starts node only on
  a keyword hit; with no pattern recorded there is no extra process.
  `mem command-guard build|show|check|seed` (seed writes correction lines
  for old errors, append-only). Ships empty. Measured on 500 synthetic
  ordinary commands with eight armed patterns: 0 false alarms, 0.1 ms per
  command including the booklet freshness check.

### Changed — mail between agents needs permission to wake anyone (breaking)

- **A message wakes the watcher only if it asks for something and the
  user allowed it.** Messages now carry an optional `Intent`
  (information, request, read, result, clarification, cancel). Only
  request, read and clarification can wake a recipient, and only with
  the user's permission for that message (`mem inbox permit`) or a
  budget (`mem inbox allow`). **Messages without an `Intent`, including
  broadcasts, no longer wake the watcher.** If you relied on "every
  message wakes", send with `--intent request` and grant a permit or a
  budget. Replies are results by default and carry `Turn: n of 6`; past
  turn 6 nothing in a chain wakes anyone. Mail to the human never waits.
- **Routes:** a session that picks up mail registers in
  `inbox/routes.jsonl` (a fingerprint, never the raw session id), and a
  reply goes back to the session that asked.

### Changed — English throughout: the last German names

- **`/desk.json` replaces `/pult.json`; `/pult` redirects.** The old
  desk's numbers answer at `/desk.json`. `/pult` and `/pult.json`, the
  sibling house's German names, answer with a 308 to `/dashboard` and
  `/desk.json` (query string kept), so bookmarks and scripts keep working.
- German identifiers, test file names and comments renamed or translated;
  no behaviour change. The English ratchet now also covers identifiers
  in `install/`, `hooks/`, `.github/`, `assets/` and `eval/`, and German
  words anywhere in a file name.

### Added — cold path: the long-lived processes keep the index in memory

- **In-process index memo** (`src/search.mjs` `setProcessMemo`): the recall
  server (`mem serve`) and the MCP server load the index once and check the
  file state (size, mtime, ctime, tail hash, O3 whole-range hash on growth)
  on every question; appended lines are added in memory. Encrypted entries
  are decrypted on a COPY; the memo key carries the key state (a hash of the
  keyring), so a destroyed or rotated key takes effect on the next question.
  Default OFF for the CLI. Recall server, 200k entries (synthetic, 4 cores,
  load ~8): p50 4076 ms -> 377 ms, p95 4262 -> 479 ms; 20k: 424 -> 38 ms;
  2k: 57 -> 10 ms (`bench/warm-recall.mjs`). Probe: `test/cold-index-memo.test.mjs`.

### Added — P11/V10/V11: chain-head content-loss finding, human confirmation

- **`correction-content-loss` follows the correction chain's HEAD**
  (`src/doctor.mjs`'s `correctionLossHits`), not only the direct
  successor — ported from lucky-mem (commit `b4c84379`). A warning a
  LATER correction already restores no longer sits forever.
- **`mem correction intended <old-id> <new-id> [--reason "..."]`**: a
  human confirms a flagged loss was intentional. Append-only
  (`global/correction-intent.jsonl`, `memory.confirmCorrectionIntent`),
  never rewrites the correction chain. Refused for a pair that is not
  currently flagged, one already confirmed, or a non-human writer (an
  MCP-bridged agent, stamped via `CHEAP_MEM_AGENT`, cannot confirm for
  itself — see `procedure.isHuman`). The finding now reports confirmed
  pairs separately ("N confirmed as intentional") instead of folding
  them silently into "good".

### Added — release rail and proof ledger (Bauplan P1)

- **`checked.jsonl`** (`src/checkrecord.mjs`, `bin/mem-check-record`):
  a tracked, append-only proof that a full `node --test` run was green
  for a given tree — one tier, not the sibling house's local-stamp +
  tracked-ledger pair, since a single-install product has no machine
  that runs a suite it never wrote itself.
- **`bin/mem-release`** (`src/release.mjs`): a frozen `git archive`
  copy under `<root>-release/<commit>`, an atomic `current` pointer, a
  rollback to the state before, and `code-path` for a service install
  (`install/linux.sh` and kin) to start its code from — gated on a
  matching `checked.jsonl` row, `--allow-unproven` forces it through
  with a loud warning.
- The dashboard's "Release state" and "Last test receipt" rows (Ops ›
  Versions) read these instead of "not available in cheap-mem": four
  real states, "unknown — no release yet" on a fresh install.

### Changed — the dashboard is the only UI

- **`/` serves the dashboard** (`src/dashboard-page.mjs`,
  `src/dashboard-data.mjs`, `assets/dashboard/`; `docs/dashboard.md`). It
  is the sibling house's dashboard, the same in function and look, in
  English, with cheap-mem's own mark. `/dashboard` and `/pult` serve the
  same page. `/console` and `/viewer` redirect into it. The Astra desk
  (`src/astra.mjs`, `src/astra/`) and the console's HTML page are
  removed; `/console.json`, `mem board` and `mem viewer` stay.
- **The old `/dashboard.json` is now `/pult.json`.** `/dashboard.json`
  is the new page's data. A tool that read the old route must switch.
- New: a read-only retrieval probe, facts at a date, a weekly measurement
  series (`.mem/measurements.jsonl`, 52 weeks), a PWA shell, raw-capture
  delete from the browser (preview, reason, confirmation), and
  acknowledging a message (`POST /inbox/state`, behind the write switch).
- three.js r180 (MIT) and DM Sans (OFL) are vendored under `assets/`.
  This is the one named exception to "no dependencies" (`NOTICE`).
- Every data route checks the Host header; the page sends a CSP and never
  a CORS header.

### Changed — migration needed if you set things from the dashboard

- **Writing from the dashboard is now OFF by default** (`src/writegate.mjs`,
  `bin/mem-serve`). Every writing route — `POST /setting`, `POST /task`,
  `POST /task/cancel` — answers 403 with the way to turn it on until either
  `"dashboard": { "allowWrites": true }` is in `.mem/config.json` or the
  server runs with `mem serve --allow-writes` (this run only). An
  open-source dashboard writes nothing before its owner allows it. The
  dashboard cannot turn the switch on itself. Read-only mode, the Host and
  the Origin checks stay in force behind it. The switch has four states
  (`on`, `off`, `unknown` for an unrecognised value, `error` for an
  unreadable config), shown on the console and the desk's Settings tab and
  in `/console.json` / `/dashboard.json` as `writes`. **If you used the
  console's forms before:** add the config key or the flag, or the forms
  stay disabled. See `docs/dashboard-writes.md`.

### Added

- **The "Today" card** (N8/N21 parity with lucky-mem's `heute.mjs`;
  `src/today.mjs`, `mem today [--json] [--line]`, the dashboard's
  overview, and the session-start hook's own time-capped line): one
  source for operations not calm (`doctor.checkAll()`, WARN/ERROR
  only), open duties addressed to the configured human participant,
  and uncertain facts to verify (timeline facts flagged stale or in
  conflict by `src/freshness.mjs`, capped at 3 — the honest equivalent
  of the sibling's gold-question queue: this house has no raw-capture-
  to-question pipeline, so real fact uncertainty is surfaced instead
  of a fabricated quiz). A verdict on a candidate
  (`POST /dashboard/verify-verdict`, `src/verifylog.mjs`) appends ONE
  line OUTSIDE the memory root — never a correction on the entry,
  never a write inside this repository. Review suggestions and word-
  pair suggestions are honestly "unknown — no source yet": neither a
  persisted weekly review report nor an open word-pair-suggestion
  queue exists here. Probes: `test/today.test.mjs`,
  `test/verify-verdict.test.mjs`, `test/verifylog.test.mjs`,
  `test/today-session-start.test.mjs`.
- **MCP client-visibility journal and live probe** (dash-fix3 parity;
  `src/mcpvisibility.mjs`, `src/mcplive.mjs`, wired into `bin/mem-mcp`
  and `bin/mem-serve`'s `catalog.mcp`): the Operations → MCP tools
  table now shows which client actually saw or called each tool
  (name, client, time — never call content, machine-local under
  `.pipeline/`, already gitignored) and whether the LOCAL bridge
  (`bin/mem-mcp --http`) really answers `tools/list` with it — a
  cached, backgrounded probe that never makes `/dashboard.json` await
  a network call. Probes: `test/mcp-visibility-journal.test.mjs`,
  `test/mcp-visibility-local.test.mjs`, `test/mcplive.test.mjs`,
  `test/dashboard-mcp-live-wiring.test.mjs`.
- **Model-cost journal and `mem effect` on the dashboard** (dash-fix3
  parity; `src/modelcost.mjs`, `mem modelcost [--days N] [--json]`,
  wired into `bin/mem-digest`'s one model call and into the Usage
  tab's "Application"/"Model costs" metrics): reads the
  usage/`total_cost_usd` fields a headless `claude -p --output-format
  json` run already returns — no second model call, no estimate from
  character counts, and every line is labelled "estimate, not a
  bill". Machine-local (`.pipeline/model-cost.jsonl`) rather than
  lucky-mem's committed `betrieb/modellkosten.jsonl`, since this is a
  personal single-install memory and a machine's own headless-caller
  telemetry should not travel between clones. `src/effect.mjs` (built
  earlier, never surfaced) is now wired into `dashboard-data.mjs`'s
  `usage.effect`, 5-minute cache. Probes:
  `test/modelcost-digest-wiring.test.mjs`,
  `test/usage-modelcost-effect-wiring.test.mjs`,
  `test/modelcost-cli.test.mjs`.
- **Freshness for state questions** (`src/statequestion.mjs`, wired into
  `search()`): a question carrying a state signal word ("current",
  "still", "latest", "status", ...; English defaults in
  `src/state-signal-words.default.json`, overridable per install via
  `CHEAP_MEM_STATE_SIGNAL_WORDS` or `stateSignalWords` in
  `.mem/config.json`) now dampens OLDER hits sharing a `topic` with a
  newer one among that query's own results (×0.35); the newest of the
  topic, and any entry with no readable `ts`, is untouched. A question
  without such a word is not affected. Probe: `test/statequestion.test.mjs`;
  reach and eval-ceiling guard: `bench/state-freshness.mjs`.
- **`mem effect`** (`src/effect.mjs`): did an injection get used? Of the
  (injection, entry) pairs the recall hook actually showed
  (`.pipeline/injections.jsonl`), the share named/opened/edited again
  within 30 minutes, with a 95% Wilson interval; "not-measurable" under
  1000 pairs. Reuses `askedlearn.mjs`'s session-reading (`mentions()`,
  its 30-minute window); a mention only explained by the memory
  re-showing the same place is dropped, not counted either way. A
  finding, never a ranking signal. Probe: `test/effect.test.mjs`.
- **Reply from the dashboard's inbox** (P1b, `POST /inbox/reply`,
  `inbox.reply()`): a reply form under each message in the human
  participant's tray on the Agents tab. It writes through the same
  `inbox.write()` as `mem inbox write` (same file name, header and body;
  nothing committed or pushed), sits behind the dashboard write switch
  (403 and a disabled form until `allowWrites` / `--allow-writes`), and
  keeps the readonly, Host and Origin latches. Only the message's
  recipient can answer it; the form carries no sender or recipient
  field. Probe: `test/inbox-reply.test.mjs`.
- **`/entry.json` shows every backlink, not only same-drawer ones**
  (D1b): `dashboard.getEntryFast()` merges in the E1.4 backlink index
  (`src/backlinks.mjs`), so an incoming `derived_from` from another
  drawer or project now appears, and the answer equals
  `dashboard.collect()`'s for the same id. `graphNote` and the
  not-yet-wired declaration for `backlinks` are gone; a missing or
  stale index answers `warning` with its reason. Probe:
  `test/backlinks-wired.test.mjs`.
- **`GET /entries.json?type=&project=&q=&after=<cursor>&n=`, a filtered,
  cursor-paged list that never builds the whole desk** (`bin/mem-serve`,
  `src/pages.mjs`). Until now, listing entries over the server meant
  `dashboard.collect()` — every drawer of every project, several passes
  over each, to hand back a slice of one list. `pages.page()` opens only
  the drawers the type/project filter selects; without `q` it streams
  them with `memory.iterLog()` (constant memory per line), with `q` it
  runs the EXISTING search path (`search.loadIndex()`/`search.search()`)
  rather than a second, hand-rolled text search — and either way feeds
  the same narrow top-N selection, holding at most `n` candidates at
  once. Stable order (`ts` descending, `id` ascending on a tie, since
  `ts` alone is not unique). The cursor encodes `(ts, id)` plus a stamp
  over exactly the touched drawers and the filter itself: a corpus
  change between two pages answers `state:'warning'`/"Corpus changed"
  rather than silently turning a stale or mismatched page, and a broken
  cursor answers `state:'error'` rather than silently restarting at page
  1. An unknown type/project answers `state:'unknown'` (400) before any
  drawer is opened — never confused with a valid filter's honest zero
  hits (`state:'ok'`, `entries:[]`). Behind the same auth guard as every
  other route — `/entries.json` is in `PATHS`, checked the same way.
  The known gap: `search.mjs`'s index build drops any entry with no
  weighted field at all, so the `q` path can miss such an entry even
  though the same entry appears fine without `q` — documented, not
  hidden, and reproduced directly in the test file. See
  `docs/dashboard-entries-list.md` for the full contract and
  `test/pages.test.mjs` (red on the pre-E1.3 state) for what backs it.

- **`GET /entry.json?id=<id>`, a single-entry route that never builds
  the whole desk** (`bin/mem-serve`, `src/dashboard.mjs`,
  `src/viewer.mjs`). Until now, looking up one entry over the server
  meant `dashboard.collect()` — every drawer of every project, several
  passes over each, just to hand back one row. `dashboard.
  getEntryFast()` resolves the id through the same primitives `memory.
  findEntryLocation()` already uses, reads only that one drawer plus
  the `link` drawer per project, and answers the same four states every
  other measurement in this repo does: `state:'ok'`/`'warning'` (200,
  found — the second with a disclosed read gap), `'unknown'` (404, no
  drawer this route searched carried the id), `'error'` (500, a source
  line could not be read while searching, so a not-found could not be
  established). Behind the same auth/origin guards as every other
  route — `/entry.json` is in `PATHS`, checked the same way. `viewer.
  TYPE_LABEL`/`viewer.headline` are exported additively so this route
  and `dashboard.collect()` share one label/headline rule, never two.
  The one honest gap: an incoming `derived_from` edge declared on an
  entry in a DIFFERENT drawer than this id's own is not searched (that
  needs the full pass this route exists to avoid) — every answer says
  so in `graphNote`, always, not only when it bites. See
  `docs/dashboard-single-entry.md` for the full contract and
  `test/dashboard-entry-fast.test.mjs` (12 probes, red on the pre-D1
  state) for what backs it.

- **Deleting a raw capture** — `mem raw review` and `mem raw delete`
  (`bin/mem`, `src/raw.mjs`, `src/archive.mjs`). The bytes leave the
  archive, outside git, and the append-only register keeps the capture's
  row and gains a tombstone with who, when and why. `--reason` is
  required; without `--yes` the command only prints what would happen
  and how many bytes. `review` lists every capture in one of three
  states — `present`, `deleted`, `unreachable` — because "the bytes are
  missing and nobody said so" is a broken archive, not a decision, and
  one word for both would hide a NAS that is not mounted behind a
  deliberate cleanup. Its time filter is `archive.inRange`, the same
  function `raw export` uses: there is one "in range" in this repo. The
  review deliberately cannot filter by topic — a capture carries no
  topic, only path, project, surface and session — and says so instead
  of faking it. The workspace shows the same three states under
  Settings, drawn from the same function, never recomputed.

### Changed

- **The desk's seven views split into one module each, under
  `src/astra/`** (`src/astra.mjs` and new `src/astra/shared.mjs`,
  `desk.mjs`, `knowledge.mjs`, `space.mjs`, `projects.mjs`,
  `agents.mjs`, `net.mjs`, `set.mjs`). Preparation for dashboard block
  D2-D8: several agents extending one view each would otherwise meet in
  one 1237-line file. Pure refactor, no behaviour change — `astra.mjs`
  stays the facade with the same exports and signatures; escaping, the
  study's palette and `LIST_MAX` moved to `shared.mjs` so nothing is
  duplicated. Checked byte-identical (rendered HTML and collected data,
  fixed fixture, fixed `now`) against the pre-split commit in a detached
  worktree; `test/astra-modules.test.mjs` latches that each view stays
  in exactly one module and that `astra.mjs` declares none of them. See
  `docs/dashboard-astra-split.md`. (Removed again with the Astra desk on
  2026-09-28; `src/astra*` and this test no longer exist.)

### Fixed

- **A mistyped reserved switch is refused instead of becoming a field**
  (`src/switches.mjs`, `bin/mem`). `mem log decision --projekt alpha`
  used to say nothing: `projekt` is not a reserved switch, so the open
  field vocabulary took it as a field, and with no project named the
  entry was filed globally rather than in the project. One keystroke,
  two wrong outcomes, exit 0. The open vocabulary stays — only the
  NARROW MISS of a reserved name is refused, and how narrow is measured
  rather than picked: over the 235 distinct `--switch` names this repo
  uses, `project` tolerates distance 2 at no cost, while `root` at
  distance 2 would eat `--font`, `--host`, `--out`, `--port`, `--role`
  and `--tool`, so a short name tolerates only 1.
- **The search cache is renamed into place, not written over itself**
  (`src/search.mjs`). `writeFileSync` straight onto the cache path left
  a window in which a parallel reader — the retrieval hook reads exactly
  that path on every prompt — saw half a file, `JSON.parse` threw, and
  the caller fell back to a full rebuild: inside a hook that means the
  time limit and silence. With a writer thread rewriting three megabytes
  in a loop, a reader caught torn JSON in 2000, 2000 and 1996 of 2000
  reads across three runs; after the rename, 0 of 2000. The scratch file
  carries the process id and a random suffix, so two rebuilds at once
  cannot rename each other's half.

- **An unreadable capture register no longer reads as an empty one.**
  The archive tile (`src/board.mjs`) let the register read throw, which
  took the whole desk page down with it; the workspace's own read caught
  the error into an empty list, which on that page is indistinguishable
  from "nothing has been captured yet". Both now report the fourth
  answer — unknown, with the read error — and the review's counters go
  to `null` rather than `0`, because a number nobody took must not
  arrive looking like a measurement. Found by a probe that replaces the
  register with a directory so `readFileSync` fails the way a genuinely
  broken file would.

- **The desk** (`/pult`, `src/dashboard.mjs`). Five views over one
  memory — desk, knowledge, projects, agents, net — beside the console
  rather than in place of it, read-only, at `/pult` with its numbers at
  `/dashboard.json`. The shape comes from a UI export; the data does
  not. That export fetched `/console.json` and gated every board tile
  behind `Array.isArray(x.board)`, which is false because
  `console.collect` returns an object, so it rendered a hardcoded demo
  constant under a status pill reading "Daten: /console.json" —
  measured against a running server, not inferred. This page therefore
  has no fallback at all: the data is embedded in it, there is no
  fetch, so there is no failed request to fall back from, and a memory
  that cannot be collected produces a 500 naming the reason. It derives
  nothing twice (board from `console.collect`, entries and agents from
  `viewer.collectMemory`, matrix from `net.build`, work counts from
  `memory.openDuties` and `question.all`), keeps four states on every
  count — a drawer nobody ever wrote to reads `not measured`, never
  `0 open` — and refuses a state outside `calm / watch / alarm /
  unknown` rather than rendering it as an uncoloured word. 14 probes,
  each made red once and green again.
- **`PATHS` is exported from `bin/mem-serve`.** The auth probe carried
  a hand-typed copy of three paths; when two more were added it would
  have gone on passing while saying nothing about them. It now reads
  the server's own list.

- **Cloud and local stores found by name** (`src/stores.mjs`).
  `mem raw archive --list-stores` finds Google Drive, iCloud, OneDrive
  and Dropbox on macOS, Windows and Linux, expanding the account
  wildcard those paths carry. `--set gdrive` then needs no path.
  Two candidates are reported as ambiguous rather than silently taking
  the first. A syncing store gets a warning naming all three
  consequences (eviction, no write barrier, shared use), attached to the
  path rather than to the command.
- **The archive** (`src/archive.mjs`). Raw captures live outside the
  repository; `raw-record.jsonl` stays tracked with one line per capture
  (stamp, span, line count, bytes, SHA-256, location, what was dropped).
  `mem raw archive`, `mem raw migrate`, `mem raw export --from/--to`
  with an optional hour window.
- **Machine-local archive location** (`.mem/archive.json`), set once via
  `mem raw archive --set`. `CHEAP_MEM_ARCHIVE` still wins for a single
  run; the report always names which of the three sources was used.
- `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`.
- A guard for the README's own numbers (`test/readme-numbers.test.mjs`),
  because numbers in prose have no guard and therefore rot.
- **The error-class vocabulary** (`src/errorclass.mjs`, `mem classes`).
  Twelve closed classes, each with the question that decides it
  (`looks-right-does-nothing` asks *"What would be visible if it did NOT
  work?"*). Counted in the sibling project that motivated it: 303 error
  entries in 212 class names, 167 used exactly once — the dominant
  defect type was invisible because everyone coined a fresh name.
  Old names map through a literal-only `ALIAS`; `normalise()` returns
  `null` rather than guessing, and `coverage()` names what it could not
  map. `mem log error` warns on an unknown class and **writes it
  anyway** — a write that fails on a naming rule loses the content.
- **The board** (`src/board.mjs`, `mem board`). Seven tiles on one
  screen: raw archive, digest, error classes, agents, open questions,
  installation, MCP bridge. Four states, never two — `calm`, `watch`,
  `alarm`, and `unknown`, which is deliberately not green. `--html`
  renders one self-contained page: no script, no external source,
  because a board that stays empty when a script fails to load reports
  calm by omission. Every tile carries its own age; a condition that is
  normal is never drawn as a loss (a capture recorded by another machine
  counts as `foreign`, not `missing`).
- `mem bridge report <short-hash>` — an MCP bridge reports the checkout
  it is serving. Reports are **appended** to
  `.mem/bridge-reports.jsonl`, never overwritten: the first draft
  rewrote one JSON file, which would have made it the only bridge tool
  that CHANGES something. Appending also answers a question the
  overwrite could not — since when has this server been on the same
  checkout, and how often has it restarted. The board cannot measure that from inside, so it stays
  `unknown` until something reports. On 2026-09-08 a bridge ran a whole
  day on the previous day's checkout and an outside agent noticed; a
  board that inferred the running state from the repo state would have
  shown green for that entire day.
- **Code symbols are findable by ranked search** (`symbols` field,
  `qualifiziert` identifier pattern). An entry was always allowed to
  carry `symbols` and `--literal` found it; ranked search did not.
  Measured: symbol in the title → 1 hit, the same symbol only in
  `symbols` → 0 hits, `--literal` → 1 hit. Two causes, both measured:
  `symbols` had no field weight, so BM25 never saw it, and none of the
  five identifier patterns recognised a dotted name — `bezeichner()` (now `identifiers()`)
  returned an EMPTY set for `TokenStore.write`. The exact lane, built
  for precisely this kind of question, was blind to code symbols.

  The new pattern requires at least two characters per segment, which
  keeps `z.B.`, `u.a.`, `d.h.`, `e.g.` and `i.e.` out of a German
  corpus, and it needs no stop list: the existing `platz` bound already
  removes anything occurring in more documents than the answer has
  slots. Measured on 1153 real entries: 7469 identifiers before, 8610
  after (+15.3 %), 488 distinct new ones, 416 of them (85 %) in at most
  three entries.
- **`bench/structural-recall.mjs`** — does a structural hop surface
  history that word retrieval misses? Measured on 1153 real entries and
  46 modules, with a random control and five seeds. Answer: **not
  demonstrated on this corpus, so nothing was built for it.** Reach is
  real (a name query returns that file's own history and nothing else,
  at any `--top`), relevance is not: 4 files of 25 show any effect, 2 of
  them at a perfect 1.000 on a sample of one entry. The mean of 0.108
  against 0.010 was carried by those two — an aggregate that reads like
  a finding, which is exactly the defect the bench was written to avoid
  in someone else's comparison. The per-file distribution caught it.
- **Procedures can be armed by error class** (`--on-class`). Filing an
  error of that class offers the rule that was written against it — at
  the one moment it is wanted, rather than when somebody remembers to
  run `mem procedures`. Cheap here and expensive elsewhere: matching by
  keyword is guessing, matching against twelve fixed names is a lookup.
  An unknown class is REFUSED at write time — the opposite of `mem log`
  everywhere else, because there is no content to lose and a trigger on
  a class that does not exist never fires while looking armed. Old class
  names are normalised on the way in.
- **`hasMore` and a corpus generation on every retrieval** — and,
  deliberately, no cursor. See the Fixed entry below for why the
  pagination this was meant to become was taken back out.
- **`coverage_state` on every retrieval.** The gateway returned
  `truncated: true|false` — two states for a three-state question. The
  missing third is the one that matters: *the search space could not be
  established*. An empty answer from a caller with no capability used to
  report `truncated: false`, which reads as "we looked and there was
  nothing" when nothing was searched at all.

  Now `known_complete` / `known_partial` / `unknown_coverage`, each with
  the reasons that produced it — a state with reasons, never a number,
  because 0.8 against 0.9 says nothing about WHICH limit bit. UNKNOWN
  beats PARTIAL: a run that could not establish its space must not
  report a mere partial. Printed by `mem retrieve` and by `mem_retrieve`
  at the bridge **even when the news is good**, because printing it only
  on a cut would teach that silence means completeness.

  `known_complete` means no limit cut THIS answer. It is never proof
  that nothing else exists, and the output says so.
- `mem find --brief` now appears in `find --help`. It existed, it was in
  the README, and it was missing from the one place someone looks.
- **The console** (`mem serve`, `src/console.mjs`, `bin/mem-serve`). One
  fixed link carrying the state, the settings, the installation steps,
  the connections and the viewer — and the only place where anything can
  be SET without a shell. `/`, `/viewer`, `/console.json`, `/health`.

  It is a daemon, which the viewer file deliberately was not, so it
  carries that file's two properties (renders only the redacted drawers,
  writes no rendered content to disk) plus a third: **fail-closed**.
  With no `CHEAP_MEM_SERVE_TOKEN` it serves localhost only, and binding
  to a public address without one is REFUSED — the process does not
  start. A request without a valid token gets exactly what an unknown
  path gets, a bare 404.

  Writing over HTTP has three latches: a closed `SETTINGS` list (an
  unknown field is refused, not ignored), the same writer the CLI uses
  (`archive.setLocation` with its write probe), and an Origin check
  stricter than the one for reads. Every change is logged to
  `.mem/console-log.jsonl`. `CHEAP_MEM_SERVE_READONLY=1` shows
  everything and sets nothing — and says so. Of any token, only WHETHER
  it is set ever appears on the page.
- **`src/webauth.mjs`** — the bind rule, the constant-time comparison,
  the auth decision and the POST origin check, in one place, because two
  copies of one door means one of them is tested and the other is the
  one with the hole.
- `docs/CAPABILITIES.md` gained a **module inventory** — every file in
  `src/`, one line each — plus sections 10.16 and 10.17 for the error
  classes and the board, and 7.4 for the console.
- **A release path** (`.github/workflows/release.yml`). Publishing runs
  on a `v*` tag and passes four gates: the tag must equal the manifest
  version and the changelog must name it; lint and tests run on the
  tagged commit; the tarball is packed, installed into an empty
  directory and the CLI is run from it — the only check that sees the
  package the way a stranger does, since every test in the repository
  runs from a checkout where nothing can be missing. It also fails if a
  memory, a raw capture or a `node_modules` reached the tarball.
  `npm publish --provenance` over OIDC; the job holding the registry
  token has read-only access to the repository. `workflow_dispatch`
  exercises everything except the publish, because a release path only
  ever run for real is one nobody has tested.
- **`mem_bridge_report` and `mem_board` at the MCP bridge.** The bridge
  tile asks whether the server outside is serving the code in this repo.
  From inside that is unmeasurable, so the server must report it — and
  the command for it existed only in the CLI, while the agents it is
  about come in over the bridge and have no CLI. The tile would have
  stayed `unknown` forever for exactly the cases it was built for.
- The bridge tool list is now **asserted by name** in
  `test/bridge-reach.test.mjs`. `docs/CAPABILITIES.md` had claimed that
  guard existed since the port; it did not. A guarantee stated in the
  reference and absent from the code is worse than a missing one,
  because a reader who believes it stops looking.
- Two guards for the parts CI cannot reach: `test/package-contents.test.mjs`
  walks every relative import from both entry points and asks whether
  `package.json`'s `files` list would ship it (an omission there fails
  only on a stranger's machine, after the release);
  `test/release-workflow.test.mjs` checks the workflow's own shape — no
  `needs:` pointing at a renamed job, the publish behind every gate and
  behind its condition, no literal token, and no cancel-in-progress on a
  release.
- **A guarded Streamable HTTP transport for `bin/mem-mcp`** (#24). Stdio
  stays the default; `mem-mcp --http` serves the identical tool
  definitions, profile checks and house rules at `/mcp` for a hosted
  client that cannot launch a local process — a second transport in the
  same program, not a separate wrapper that could drift from it. It
  starts **read-only by default** (`CHEAP_MEM_MCP_READONLY=0` opts a
  process into the full profile, deliberately, once), and a non-loopback
  bind with no `CHEAP_MEM_MCP_TOKEN` is refused before the socket ever
  opens. `Host` is checked against an exact allowlist
  (`CHEAP_MEM_MCP_HOSTS`) — `memory.example.org.attacker.invalid` must
  not pass because `memory.example.org` does — and `test/mcp-http.test.mjs`
  proves that exact boundary against a real socket, not a mock:
  the configured Host reaches the server, the suffix lookalike gets a
  403, and the unauthenticated non-loopback bind never listens at all.
  Documented in `docs/mcp-setup.md` under "Hosted clients — Streamable
  HTTP", with the reverse-proxy shape and a curl probe for both sides of
  the Host check.

### Changed

- **Captures drop what is not conversation.** Measured over 21 real
  transcripts (41.30 MB): `attachment` lines are 51.7 % of the volume,
  and the largest item inside them is the task reminder, re-dumped
  nearly every turn. Same 16.5 MB transcript captured both ways:
  4.83 MB gzipped without the filter, 2.09 MB with it — **56.8 % less**.
  `thinking` is deliberately kept. Every capture header books what was
  dropped and why.

### Fixed

- `--on-class` arrived hyphenated and would have been stored as
  `on-class` while the reader looked for `on_class` — the same trap
  `--issued-by` fell into once, one field later. A rule that exists and
  never fires is the class it was probably written against.

- **Snapshot-bound pagination was built and then removed, because it
  cost two measured defences.** The path is the record:

  First attempt (`selectWant = offset + want + 1`): one claim came back
  on page 2 AND page 3 — nine entries from nine authors, 9 rows, 1 of
  them twice. The author-share cap and the context budget work on the
  SELECTION, not the corpus, so a different selection size means
  different survivors and shifted offsets. A generation-bound cursor
  could never have caught it: the corpus had not changed, only the
  question about it had.

  Second attempt (`selectWant = maxResults + 1`, constant): pages fit
  together, and four existing probes went red. They were positive
  controls — "if MMR changes nothing on this fixture, the comparison
  above proves nothing". With 51 selected everything on a small fixture
  gets in, so MMR no longer shaped the selection, which is exactly its
  job here (measured 7/18 → 9/18 on the eval corpus). The flooding
  defence from 2026-09-05 rests on the same property.

  A measured defence had been traded for a convenience feature, and only
  the shape of the old probes caught it. What remains is the honest
  half: `hasMore`, derived from the selection loop stopping early, which
  costs no widening and claims nothing about how many more exist. A
  cursor is REFUSED rather than ignored — falling back to page one would
  answer a question nobody asked and look like success.

- **The secret latch flagged `token: env.FOO_TOKEN` as a secret.** That
  line NAMES an environment variable; it is not one. `process.env.X` was
  already treated as a reference, and a parameter literally called `env`
  is the house style for "the environment this was configured from" —
  exactly so a service does not read `process.env` behind its caller's
  back. The rule now covers the bare name `env` too. This widens
  PRECISION, never reach: the `looksLikeCredential` gate still applies,
  so a value that merely starts with `env.` and is credential-shaped is
  still caught, and `config.env.X` stays flagged because it could be
  anything. Three probes and two sabotages hold both directions.

- **`docs/CAPABILITIES.md` claimed an HTTP viewer that did not exist.**
  The Surfaces row and section 7.3 both described one; `mem viewer`
  writes a file. Third claim of the same family found this week, after
  the by-name tool list and the substring completeness guard. Rather
  than delete the claim, `mem serve` makes it true — and 7.3 now says
  plainly what the file mode is.
- The console's own store list announced four cloud drives on a Linux
  container that has none: `stores.discover()` returns every store with
  a possibly-empty `found` array, and the first draft mapped all of
  them. A claim about the machine, produced by not reading a field — in
  the page built to prevent exactly that.

- **The default archive location was gitignored, and that loses data.**
  It was `.mem/raw`; `.mem/` does not travel. On a machine with a disk
  that is fine, and it is false wherever the repository IS the disk — a
  cloud container, an ephemeral runner. Measured in the sibling
  project's own container on 2026-09-08: the last capture to reach the
  repository was at 19:36, and eight after it would have gone with the
  container, including the ones from the session that made the change.
  The default is now the tracked `raw/`; an archive elsewhere is a
  decision per machine (`mem raw archive --set`, `CHEAP_MEM_ARCHIVE`),
  and still wins.

  `test/stop-persists.sh` had been reporting this the whole time and was
  on a list as an outdated shell test. It was not outdated. It is green
  again without one line of it having changed, which is the proof of
  which side was wrong.

- **The record file had a German name in an English codebase.** The
  archive was ported from a German-language sibling and kept
  `raw-nachweis.jsonl`, while this CHANGELOG already called it
  `raw-record.jsonl` — two truths, one of them the code. Renamed, with a
  one-time move so a memory that already captured does not silently
  start a second, empty record.
- **The completeness guard for `docs/CAPABILITIES.md` was checking for
  substrings.** `board`, `classes` and `bridge` all passed while the
  reference named none of them: `board` sits inside "dashboard",
  `bridge` in prose about the MCP bridge. The guard now asks a narrower
  question per kind (a CLI command must be in the 7.1 block, a module
  must appear as `<name>.mjs`) and carries a positive control. The
  narrower guard immediately found 14 modules the reference had never
  named.
- **The README had two `## Commands` sections.** The lower one was older
  and had drifted — it still called `mem find` a "substring search",
  which stopped being true when ranking landed. Merged into one, with a
  guard against a second appearing.
- The command counts disagreed between the inventory table (44) and the
  section heading (45) of `docs/CAPABILITIES.md`. Both are now guarded
  against the code.
- Section 10 of `docs/CAPABILITIES.md` had two subsections numbered
  10.12 and its numbering ran 10.13, 10.14, 10.12, 10.11, 10.12.
  Renumbered in file order.

- **Redaction over-masked and reformatted while it did.** An env var
  *reference* was masked as if it were a value, and the separator around
  it was rewritten (a YAML colon came back as an equals sign). The
  digest reads these captures with a model, so this was corrupted source
  producing wrong facts, quietly.
- **A hook with a baked-in absolute path was dead on a second machine,
  and dead silently** — the session started without its memory and
  looked exactly like one that never had any. The root is now looked up,
  and a failed lookup says so and names the path. `MEM_HOOK_OFF=1`
  remains the only silent exit.
- **A transcript that shrank stopped being captured**, forever: the
  increment went negative and the capture reported "nothing new". (This
  one existed in the sibling project, not here — noted because the two
  are ported from each other and the asymmetry is the lesson.)

### Corrected

- The README claimed **"~500 lines of JS"** against a real ~18,900 —
  off by a factor of thirty-two — and **"all 17 MCP tools"** against a
  real 26. Neither was said on purpose; both were true once and nobody
  re-counted. For a project that argues for itself with honest
  self-description, that is the most expensive error available, so the
  counts now have a test.
- A historical measurement ("0 of 17 MCP tools" seen by three AI
  evaluations) is now dated, so it cannot be read as a current claim.

## 2026-09-08

The bridge caught up with the CLI: **20 → 26 MCP tools**, adding
heartbeats, open questions, procedures, sources, components and
neighbours. Provenance is stamped on every write by the server, never
accepted from the caller.

An id lane: asking for an entry id now returns that one entry. Reported
by a connected agent who wrote an entry over the bridge and could not
find it again — and the onboarding check had reported that route green,
because it queried a different lane.

Duplicate rate measured at **1.8 %**, and the raw figure that preceded
it was wrong.

## 2026-09-07

The error class asks itself at the moment of logging: entering one now
shows how often that class has occurred and when it last did.

## 2026-09-05

The largest single day (50 commits): the complete capability reference
in `docs/CAPABILITIES.md`, written after three AI evaluations read the
README and reported built features as missing.

## 2026-08-29 – 2026-09-03

Initial port from the private sibling project: the CLI, the entry types,
the inbox, the watcher, the MCP server, the install scripts, the Windows
port, CI on three platforms.
