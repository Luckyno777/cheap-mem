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

### Security - hard HTTP limits for the dashboard server and the MCP bridge (slow headers, dripping body, connection flood)

`mem serve` and `mem-mcp --http` ran with the Node defaults: headers could take 90 s in practice (60 s, checked every 30 s), a body 330 s,
and the number of open connections was unlimited. Measured on a real service (8 slow connections, 600 silent ones): slow headers held
89.5 s, a dripping body 329.5 s, 600 silent connections freed only after 89.4 s. `src/http-limits.mjs` `hardenServer()` now sets head 10 s, request 30 s,
idle 5 s, 100 header lines, a check every 2 s and `maxConnections` per service (dashboard 512, MCP 256; never 0, Node drops every
connection at 0), right after `createServer`. Measured after: slow headers closed at ~11.6 s, dripping body at ~31.5 s, 600 silent
connections freed by ~11.9 s with the surplus dropped at once. The limits bound only the receiving of a request, so a long answer or a
stream does not break. Residual risk, documented and not coded: the MCP bridge streams (`GET /mcp` opens an SSE stream with a
`: keepalive` every 15 s), and every open stream holds one of its 256 seats for good, so 256 held streams lock the bridge; that needs
the token, except with `--local-no-token` on loopback. `test/http-limits.test.mjs` (slow headers, silent connections, dripping body, flood at cap 8, header lines, long
answer, the real services as processes, the recall socket with a hung client; one mutation per probe) and the listener inventory in
`test/serve-token-refuse-cm.test.mjs` (every listed HTTP service must call `hardenServer` with a named cap) hold it. The recall
server (Unix socket) got no cap, with the reason in `docs/security-model.md` ("HTTP service limits"). No new environment variable.

### Fixed - three leftovers of `mem setup codex-cloud` (codex-rest-cm)

- **The report of a failed skill write said ".gitignore was put back as it was" even when this run had never touched
  `.gitignore`.** It now says so only when the file was really rewritten and written back.
- **A failure while putting `.gitignore` back masked the error that made it necessary** (the exception replaced the
  report, and the folders this run made were not taken back). The first error now stays, a second line names the failed
  restore and the file to put back by hand, and `changed` is true, because the file still holds the new rules.
- **No probe held a foreign file in a folder this run had made**, so a recursive delete in place of `rmdir` survived the
  mutation sweep. Three probes now put a file into each of the three folders during the failing write; it must stay. Four
  mutants in `bench/mutation.mjs` (recursive delete, the false claim, the two masked restores) are caught.

### Fixed - leftovers of the masked transcript copy and of the pin words (small-rest2-cm)

Five items checked, three were real:

- **A key as ONE JSON string (`\n` escapes)** was already masked whole (structured line, a line cut off inside the string,
  a string inside a string): no defect. The one real gap beside it: the short LAST line of a key (fewer than 20 characters)
  survived in an open block (no END) and in a block past the 8 KB bound of the complete-block rule. It now falls, but only
  when it ends its line, so prose after an open block stays.
- **The block cut of `bin/mem-mask-copy.mjs`** (20000 lines or 2 MiB) split a key that began just before it: the part
  behind the cut stayed in the clear (297 of 300 key lines in the probe). A cut now carries the header of a block that is
  still open into the next block; it is masked to the END or to the end of the file.
- **`pinhashes`** (one word, plural of `pinhash`) is a counter key like `pincodes`. Bare `pins`, `spins`, `hairpins`,
  `kingpins` stay free, as before.
- **`bin/mem-reflect.ps1`**: the helper already got root and transcript as separate arguments (a space or an apostrophe
  in a path was no problem); the root now loses a trailing separator, which Windows PowerShell 5.1 would turn into an
  escaped closing quote.
- **Parallel runs of the two mask test files** (the mutation baseline runs every suite in one `node --test`):
  `test/reflect-masked-copy.test.mjs` counted `mem-reflect-*` directories in the shared temp directory and saw the copies
  of a file running beside it (red in 3 of 4 double runs). Both files now work in their own temp directory
  (TMPDIR, TEMP, TMP), and the count is taken there (double run: 6 of 6 red before, 10 of 10 green after).
- **`test/no-jump.test.mjs`**: the 20 s limit timer of the held-request wait was never cleared and kept the test process
  alive after the test (the single test: 26.7 s wall, 11.0 s with `clearTimeout` in a `finally`).

### Security - unattended model sessions no longer read a project's settings or `.mcp.json` (digest, mail handler, reflector)

Without `--bare`, `claude -p` runs the hooks of the `.claude/settings.json` of its working directory and connects the servers of its `.mcp.json`, in a folder nobody trusted and with no dialog
(Claude Code documentation, 2026-10). The digest and the mail handler started inside the memory, the reflector in the host session's repository: anyone who could push into a memory could plant a
hook and have the next tick run it. One starter now decides every launch (`src/headless.mjs`, `bin/mem-headless.mjs`, `mem_headless_plan` in `bin/_portable.sh`, `bin/_headless.ps1`):
- **Every configured command starts in a neutral empty directory outside the memory** (a wrapper, an alias, `gemini`: hooks come from the working directory only). The memory comes through
  `CHEAP_MEM_ROOT` and absolute paths; `MEM_HEADLESS_CWD` names the parent folder. The directory is checked (no symlink, the user's own, 0700, no `.claude`/`.mcp.json`/`CLAUDE.md`/`.gemini`), else a
  fresh per-run one is made and removed; the temp fallback is `mkdtemp`. Whether a place is inside the memory is decided before anything is made there; none outside means no start.
- **A command recognised as claude also gets `--setting-sources user --strict-mcp-config`** (and `--add-dir <memory>` for the digest and the handler), after the prompt. Recognition looks through
  `env`, `sudo`, `nice`, `timeout`, `nohup`, `npx`, `bunx`, `pnpm dlx` and the like; an alias is not recognised, runs neutral without the flags, and the log says `command not recognised as claude`.
- A claude too old for the flag is named in the log (also across a line break) and never started open. `bin/mem-reflect` keeps no temp file for its output. `bin/mem-handle-post.ps1` now hands on the
  model's exit code: the Windows watcher counts a failure (loop guard after three, 900 s) and the mail is tried again later.
- `DIGEST.md` uses `git -C <root>`; the install docs say `gemini` runs neutral now. A custom `MEM_WATCH_HANDLER` still starts inside the memory (documented). Limits and residual risk, including that the
  ratchet is a text scanner: `docs/security-model.md` section 11. `test/headless-start.test.mjs`: red on `9ee3441` and, for `env`/`npx`/`sudo`/`nice`/an alias, on the first version (`9efe57d`).
- Merge note: `bin/_owntool.sh` no longer carries the `windows-parity-ok` marker (its twin `bin/_owntool.ps1` exists, so it never needed one); with `bin/_headless.ps1` and `bin/_portable.sh` the exemptions stay at the two `test/hook-parity.test.mjs` allows.

### Added - `--as-me`: the writer is this install, and a card names its author with name AND rank

A write without `--agent` and without `CHEAP_MEM_AGENT` was stamped `human:<os user>`: true at a shell, but in a cloud session
every agent line read `human:root`, and that name reads as a person (`authority.isHumanName`). `mem log`, `mem correction`,
`mem sources add|bridge` and `mem card add` now take `--as-me`: the writer is `CHEAP_MEM_AGENT`, else the stored `mem whoami`
(which must still be a configured participant - no name is written into `src/`). With neither, or a blank or stale `whoami`, the
write is refused and nothing is written; the OS account is never the fallback. The switch carries no rank: the tier stays what
the write path gives, it does not combine with `--authority` or `--agent`, and a name that reads as a person (`owner`,
`human:<name>`) or the configured human participant is refused. Without the switch nothing changes; the MCP bridge needed no change (it stamps the connected identity,
takes no writer parameter, clamps the tier). Port of lucky-mem F1b / `quelle add --ich`, with the source of the name the other
way round (lucky-mem takes the typed name, cheap-mem the install's).

A decision card now carries `byline` `{name, rank, rank_state, text, by_human}` (`name (rank)`), and `origin.by_human` is the
same flag: true only for the RANK `user` - the name alone no longer makes a card a person's (it did for `human:<name>`, `owner`
and the configured human participant, whatever the tier). A rank the line does not carry is `missing`, `empty` or `broken`
(`authority.tierState`), never an invented tier; `mem today`, `mem card list` and `mem_card_list` say `tier unknown (missing)` (`authority.rankWord`). Old lines stay readable and are not
changed. Measured: `test/writer-identity.test.mjs` 28 probes (22 of the first 25 red on the base `04ca129`, 3 green controls); 24 mutants in `bench/mutation.mjs`, all caught.

### Fixed - CI run 1074: macOS and Windows red - the cache probe's base, Git Bash paths, a held temp directory, the cleanup order

- **Tool and memory paths under Git Bash.** MSYS2 translates a POSIX path for a native program, but leaves alone any value that holds an
  apostrophe, a backtick, `*`, `?`, `[` or `]` (msys2-runtime `msys2_path_conv.cc`). The installer baked `pwd` into every shim and the hooks
  built their tool directory with `pwd`; with the tool under a folder with an apostrophe, node.exe read `/tmp/x/mem's root` as `C:\tmp\...` and
  every installed shim answered with nothing. `install/claude-code.sh` and the hooks (`mem-retrieve`, `mem-before-edit`, `mem-after-failure`,
  `mem-catch-fail`, `mem-stop`, `mem-subagent-start`, `mem-capture`) ask `pwd -W` first (Git Bash: the Windows form; any other bash refuses
  the flag and `pwd` stands). `test/msys-native-paths.test.mjs`, red on `04ca129`.
- **`bin/mem-mask-copy.mjs`** opens the transcript before it makes anything, and closes both files before it removes its directory on an
  error: on Windows a directory with an open file in it stays, and a failed read left an empty `mem-reflect-*` directory in the temp dir.
  `test/reflect-masked-copy.test.mjs`, red on `04ca129`.
- **Probes that asked the wrong place.** `test/hook-compile-cache.test.mjs` looked for the macOS cache under `.cache` (the hook writes
  `Library/Caches`), and compared Git Bash's view of HOME with the Windows spelling it was handed; `test/hook-spaces.test.mjs` ran the root
  lookups under Git Bash with nothing but PATH and HOME and compared spellings instead of directories; `test/installed-hooks-run.test.mjs`
  ran the `.ps1` shims with a PATH without `System32\WindowsPowerShell\v1.0`, so their `& powershell -File ...` hand-over failed.
- **Cleanup order.** node:test runs `after` hooks in the order they were added and stops at the first that throws. The memory of
  `test/serve-token-refuse-cm.test.mjs` was removed before its services were stopped: ENOTEMPTY on Windows, the stopping hooks skipped,
  one service kept the file alive until the 15-minute timeout. Each test now stops its services first and says so if one still runs.
  `test/temp-dir.mjs` cleans up through `test/fixture/cleanup.mjs` (waits for both background builds, retries, never a red test over a cleanup).
- `test/before-edit-twin.test.mjs` names the twin's exit on stderr when it answers with nothing (traced run) - the Windows PowerShell 5.1
  run of `bin/mem-before-edit.ps1` gave exit 0 and zero bytes in runs 1066 and 1074, cause not yet measured.

### Fixed - recall: an identifier with an underscore is found, one bar for "what the hook shows", one index language per memory (abruf-stamm-cm; port of lucky-mem decision 2pbqt66q0wdj "merge the recall trunk", steps 2 and 3, and its K1 finding)

**K1.** A question with a snake_case identifier (`session_id`; with a capital umlaut `ABSICH...CH_KEINNERN` in the sibling's finding) found nothing on three paths: `mem find --content-words` (also the after-failure hook), the H1 lever of the recall hook call and the SubagentStart task query.
The index holds `a_b` as ONE term and holds a word with an umlaut in the spelling of the language the entry was read as; every question-side word cutter cut at `_` and wrote umlauts as `ae` (`session` + `id`: terms no entry carries; and an `ae` spelling that an English-read entry never holds, so the typed umlaut is part of the fix here; in the sibling it was innocent).
`search.contentWords(text, { typed: true })` and `search.typedWords()` keep `_` and the typed umlaut (the filter still looks at the `ae` spelling); `retrievalQuery` and the H1 split use them, `search()` normalises per language pack as it does for a plain `mem find`.
Text-against-text readers (error fixes, neighbours, the project check) keep the old cut; the hyphen still cuts (the index holds the whole and the parts). Plain `mem find` and the hook's default call already found it (control in the probe).
Probe `test/k1-underscore.test.mjs` (pure cutters, three paths, the real hook script, red proof against the base), four mutants.
**What K1 costs (named, kept for parity with the sibling, held by a probe).** A snake_case token in a question is now searched as a WHOLE word only; the loose part hits on prose are gone. Example: the entry "the peer closed the socket" is no longer found by the question `socket_closed_by_peer` over `find --content-words --weak` (the path of `bin/mem-after-failure`): it scored 8.02 on a seven-entry scratch memory before (16.88 in the reviewer's corpus) and gives no hit now; an entry that carries `socket_closed_by_peer` itself is found, and the same words typed with spaces still find the prose entry. The probe (`test/k1-underscore.test.mjs`, D) holds this on purpose, so a later "whole word AND its parts" is a decision, not a drift; that question is open.

**One predicate.** "Score at or over the bar, or an exact hit" was written out in the renderer, in the H5 path of the hook, in the journal line of `mem find` and, with a bar of its own, in `bench/recall-levers.mjs` (twice) and `bench/coverage-floor-sweep.mjs` (the measurement of what the hook would show; it also mapped an exact hit to a boolean).
`recallrender.clears()` and `RECALL_MIN` are now the one place; the renderer, the H5 filter, the journal line of `mem find --journal-session`, the SubagentStart bar and the two benches (`recall-levers`, `coverage-floor-sweep`) use them, and `test/recall-bar.test.mjs` holds `bin/mem-retrieve`, its `.ps1` twin and the environment register to the one number.
The hook's block is byte for byte the old one (6 hit lists x 7 settings; renderHits over 5 bars). `bench/gold-compare.mjs` and the other benches already go through `bin/mem find` and were not touched.

**One index language, one load.** The index cache is kept per language and a cache of another language is `stale`. `mem find` asked for the memory's configured language; the SubagentStart block, the short-prompt check of the hook, the content-word shortening and a dozen readers asked for nothing, i.e. 'en': on a memory configured for another language they and `mem find` took turns rebuilding the cache (`stale` on every alternate load, the cache directory replaced each time).
`search.loadIndex()` now takes the config's language when the caller names none (English memories unchanged; a named language still wins). `mem find --content-words` on a long question loaded the index for the shortening and again for the search; it opens it once (2 loads before, 1 now).
The SubagentStart query also reads the request-frame switch from the `env` it is given (it read the process's). Probes `test/recall-index-language.test.mjs`, `test/subagent-given-env.test.mjs`; thirteen mutants in all.
What was NOT built, with the evidence for the follow-up, is in the branch report: a total byte budget over the pieces of the hook's answer (header, clone line, hit lines, skill offer, workflow block) and over the SubagentStart blocks, and one search plan for `mem find`, `mem_find` (a hand-written copy of the ranked branch without the exact lane, the echo filter or MMR), the hook and the task query.

### Fixed / Performance - dashboard tempo: the stamp ignores every derived cache, "Confirm answer" is fresh at once, a waiting part retry is dropped (dashboard-tempo-cm, port of the sibling's D-C, H7 and R4)

Inventory first, against the sibling's building blocks (deferred parts, page versions, cache with a generation stamp,
full-build line, the headline, H7, R4). Already in cheap-mem and NOT built again: deferred parts with a bounded retry
(0d74136), page files with a version mark (`?v=`, immutable, ETag, gzip), the cache with stamp, TTL from the end of the
build and the minimum gap, the head on disk, the placeholder and the quick head, the full-build line (64 MB, then the
compact build) and the doctor's full-build and full-read switches, live parts after a write of your own (d068d4d), full
width (ef130c1), browser probes that wait for an end state (startView, e1c24d6). The sibling's incremental usage table
has no counterpart here (cheap-mem has no usage bonus in the ranking). Built:

- **The stamp (R4).** One search with `MEM_EXPAND=1` wrote `.mem/search-index-expand`, which the stamp counted: the
  dashboard took the store as changed and rebuilt. The same for the component table the pre-edit hook rebuilds (with its
  lock and log), the time track (with its build lock), the drawer locks and the scratch names of an atomic write.
  `isDerived()` strips the expand suffix and the scratch forms; DERIVED names the rest. `recallserver.codeState()` adds
  the newest ctime: a change of the same size with the mtime set back went unseen. Probe
  `test/dash-stamp-r4-cm.test.mjs`, red 3 of 7 on dc6b69d.
- **"Confirm answer" (H7).** The task `question-confirm` was rebuild-only: after the click the page read the stored
  state, the question still "answered, waiting for you", the button still there, also after a reload. Now it names the
  live part `questions` (the open and the waiting questions through `dashboardData.questionLists`, the one place the
  build calls too). 107 ms median on 5000 entries with 60 questions against 5.7 s for the full build (load about 15,
  4 cores). A compact store keeps its stored lists and says why. Probe `test/dash-confirm-fresh-cm.test.mjs` (module,
  data route, browser with the rebuild held 120 s), red 4 of 4 on dc6b69d.
- **An unreadable question drawer (review).** `question.all()` skipped a drawer it could not read (`catch { continue; }`):
  with `global/questions.jsonl` a folder (EISDIR; on Windows also a file a scanner holds) the new live part reported no
  error and open 0 / waiting 0, so after a confirm every question vanished silently as a fresh state. It now throws the
  `memory.ReadError` that names the drawer (a missing drawer still reads as none). Every caller says it: the live part
  names it in `live_errors` and keeps the stored lists, the dashboard and board tiles read "not measurable", the
  per-project counts are `null` (the page says "questions unknown"), `mem questions` and `mem questions confirm` exit 1
  with the message and write nothing, the MCP tool returns it as an error. Probe `test/question-unreadable-cm.test.mjs`
  (a real folder in place of the drawer), red 4 of 5 on 764e829.
- **A waiting part retry.** When a newer data load starts its own round of parts, the retry still waiting from the round
  before is dropped (it fetched every part a second time; seen once on a cold start whose first answer was the quick
  head, 0 of 7 further cold starts). Probe `test/dash-later-once-cm-browser.test.mjs`, red on dc6b69d.

Measured with `bench/board-tempo.mjs --browser --warm 5` on a synthetic store of 5000 entries (`bench/scale.mjs`), the
head on disk removed before each run, 5 runs each, median, load 11.7-17.6 on 4 cores:

| | first display, cold | done, cold | first display, warm (25) | done, warm (25) |
|---|---|---|---|---|
| base dc6b69d (run 1, load median 12.7) | 1045 ms | 10.49 s | 1179 ms | 4.99 s |
| base dc6b69d (run 2, load median 14.1) | 1035 ms | 10.50 s | 1138 ms | 5.21 s |
| this branch (load median 12.0) | 758 ms | 9.85 s | 400 ms | 4.88 s |

The differences lie within the scatter of the runs (cold done 9.6-11.1 s on the base, 9.1-11.5 s here; warm first
display is bimodal, about 0.3 s or 1.2-2.5 s, in both): these changes do not make the measured page faster on this store,
and none of them was meant to. They remove rebuilds and requests that a real store with document expansion, a busy
pre-edit hook or a quick head at the start pays for.

### Security - round 3 of the own-tool rule: the Windows start hook's provenance block, the provisioning variable, two honest limits (tool-trust-cm, review)

- **The Windows start hook imported `<memory>\src\provenance.mjs` without the switch.** The block "Which clone answers" in the generated hook took the memory's module first and ran it with `node -e`; the file
  asked the rule elsewhere, which hid it from the file-level ratchet. It goes through `Find-OwnTool` now, like every other lookup. The POSIX side was already right (the picking function of `bin/_owntool.sh`). The ratchet is per LINE now: a line
  that names `<memory>/bin|src` (or the tool file looked up under the memory root) must ask the rule itself or sit right behind the gate that does; the old block is its positive control; the mutant puts it back.
- **Deny `Bash(*CHEAP_MEM_PROVISION*)`** (and `PowerShell(...)` on Windows): that a variable in front of `node` leaves the allow list is the documented reading, not proved, and together with a quote-split command name it
  would be a way. The forms test has the three combinations. A shell line that mentions the variable (even a `grep`) is refused by this rule; a provisioning script sets it outside Claude Code.
- **Not blocked: `~/.claude/settings.json` and `~/.claude/hooks/`** (Write/Edit there is legitimate Claude Code work). A session that may write there can change the deny lines and `cheap-mem-own-tool.sh`; said in
  `docs/security-model.md` 4.1 and T10: a fence, not a lock. The `PowerShell(...)` rule name is marked UNVERIFIED: no other place in the repository uses it.

### Security - follow-up on the own-tool rule: the switch command could be reached around the deny rule, hooks installed earlier, a marker written through a symlink (tool-trust-cm, review)

- **The deny rule was narrow.** `Bash(node <tool>/bin/mem trust-own-tool:*)` is a prefix; `node <tool>/bin/mem --root <memory> trust-own-tool --non-interactive` matched the ALLOW rule `node <tool>/bin/mem:*`
  and not the deny rule, and ran ("Trusted", reproduced in a scratch). Now: (a) `--non-interactive` works only with `CHEAP_MEM_PROVISION=1` in the environment (new variable, `src/envregister.mjs`,
  `docs/environment-variables.md`); a variable in front of `node` takes the call out of the allow list; (b) the deny list holds `Bash(*trust-own-tool*)` (and `PowerShell(*trust-own-tool*)` on Windows);
  (c) `test/own-tool.test.mjs` matches eleven real call spellings against the rules the installer WRITES, with the documented reading of Claude Code's rule syntax; (d) the documentation says what this is:
  the rules work through the permission system, a session allowed to run any shell command (bypass/auto) can still write the switch file. Restrisiko, not closed.
- **`Write`/`Edit` were allowed across the board**, the switch file included: both are denied for `~/.config/cheap-mem/**` (or `$XDG_CONFIG_HOME`, `%APPDATA%\cheap-mem` in the `//c/Users/...` form).
- **Hooks installed before the rule are not protected.** `mem doctor` (`integration-contract`) now WARNs "installed hooks predate the own-tool rule - run the installer" for a shim that does not ask the rule or has no
  `cheap-mem-own-tool.sh|.ps1` beside it. The protection works only after the installer has run again.
- **A marker written through a symlink.** `install/support/tool-missing.sh` wrote `<memory>/.pipeline/tool-missing-<hook>` with `: >`; a committed symlink there cut a user's file to zero bytes (reproduced:
  `'' !== 'precious'`). The marker now lives in the user's state directory (`$XDG_STATE_HOME/cheap-mem`, `%LOCALAPPDATA%\cheap-mem`), a link at the marker place is not written through; the `.ps1` twin likewise.
- **Texts made true:** the start hook no longer advises checking the tool out "into that memory"; the installer's closing "tool:" line says NONE when the checkout lies inside the memory and is untrusted; the
  tool-missing message tells a MISSING tool from one that is there but lies in the memory; the start message comes at every SessionStart event (not "once"); the trust hangs on the PATH, so a re-clone at the same
  path inherits it (`--off` before deleting); a stale `allow` entry goes in its backslash spelling too, and an identical entry typed by hand cannot be told apart and goes with it.
- **PowerShell twin:** a directory that is itself a link/junction is followed (`ResolveLinkTarget`, 5.1: `Target`), a relative path is read against `$PWD`; a link in the middle of the path and 8.3 names stay
  unresolved and read "not trusted". **`setTrusted`** refuses a memory path with a line break.
- Unchanged and out of this change: files the hooks write into the memory elsewhere (turn counters, journals), and `claude -p` with its working directory in the memory (`bin/mem-watch`, `bin/mem-digest`).

### Security - a memory no longer runs its own code unless the user says so (tool-trust-cm; Lucky's decision 2026-10-16: only the installed tool, the exception by switch)

- **The hole.** All seven Claude Code hook shims looked for `<memory>/bin/mem-retrieve` (and the six others) BEFORE the installed tool (`CHEAP_MEM_CODE`). `bin/mem-retrieve`, `bin/mem-before-edit`,
  `bin/mem-after-failure` and `bin/mem-catch-fail` then preferred `<memory>/bin/mem` and loaded `<memory>/src/*.mjs`; `bin/mem-stop` took `src/answercheck.mjs`, `src/closingreport.mjs`, `bin/mem-capture` and
  `bin/mem-reflect` from the memory, `bin/mem-subagent-start` took `src/subagentstart.mjs`, the session-start hook ran `<memory>/bin/mem`, and the installer allowed `Bash(node <memory>/bin/mem:*)`.
  `mem-retrieve` pulls the memory from origin every ten minutes, so whoever could push there ran code at every prompt. Proof against base 151eb2f: a scratch memory with marker-writing
  `bin/mem-retrieve`, `bin/mem` and five more hook scripts, hooks installed into a scratch HOME, every installed shim started: all seven markers appeared. Now none does; with the switch all seven do.
- **The rule.** The installed tool first (`CHEAP_MEM_CODE`), else the tool next to the script. The memory's own `bin/` and `src/` only when the user switched that on, locally and outside every repository.
  A checkout that lies inside the memory counts as the memory's own. One rule, three implementations that are held to the same answer: `src/owntool.mjs` (the command), `bin/_owntool.sh`
  (installed next to the shims as `cheap-mem-own-tool.sh`) and `bin/_owntool.ps1` (`cheap-mem-own-tool.ps1`). Anything unreadable means "not trusted".
- **The switch.** `mem trust-own-tool [--off] [--status]` writes one line (the memory's real path) to `${XDG_CONFIG_HOME:-~/.config}/cheap-mem/own-tool-roots` (Windows `%APPDATA%\cheap-mem\`).
  Not `.mem/config.json` (versioned: the remote would set it), not `.git/config` (needs a `git` start on every prompt, a memory need not be a repository). A `git pull` cannot write it.
  The command needs a terminal (`--non-interactive` for provisioning), is on the installer's DENY list and is not an MCP tool. New command, so `src/cli/command-index.mjs`, the help block, README and quickstart.
- **Permissions.** `install/claude-code.sh` and `install/windows.ps1` allow `node <installed tool>/bin/mem:*` always and `node <memory>/bin/mem:*` only with the switch; an entry an earlier run wrote is removed
  when the switch is off. `mem-handle-post`, `mem-reflect` and the sub-agent hint now tell the model to call the installed tool (they named `<memory>/bin/mem`).
- **No silent deviation.** A memory that ships its own tool with the switch off: the session start says once `memory ships its own tool; using the installed one. To trust it: mem trust-own-tool`;
  with no installed tool it says nothing is loaded, and the other hooks' tool-missing message (`MEM_OWN_SKIPPED`, now also spoken without `CHEAP_MEM_CODE`) says why.
- **Cost, measured** (idle machine, Linux, bash 5.2, 200 calls): the decision in a shim (the picking function of `bin/_owntool.sh`, switch off, one candidate passed over) takes 0.53 ms, the trust check alone 0.19 ms. A first version
  that returned its results through `$(...)` took 16.7 ms: every command substitution is a fork, so `bin/_owntool.sh` hands results over in variables and runs no subshell and no `dirname`.
- **Changed behaviour.** An existing install whose memory carries its own tool (a lucky-mem style memory) runs the installed tool after this change until `mem trust-own-tool` is run for it and the installer
  is run again. `docs/security-model.md` section 4.1 and threat row T10; guard `test/own-tool.test.mjs`. `CHEAP_MEM_CODE`'s register row changed from "memory first" to "installed first".

### Fixed - CI run 1060: a test helper red under `npm test`, and the mutation job without history

`npm test` is `node --test` with no file list, so it also runs every helper under `test/`. `test/helpers/linear-probes.mjs`
ran its command-line branch there with no probe name and exited 2, which turned all six test jobs red; it now measures
only when a probe is named. The local chain runs the `*.test.mjs` list and never saw it: `test/plain-files-under-node-test.test.mjs`
runs the remaining files the way `npm test` does, with a positive control. The `guarantees` job checked out one commit,
and `bench/mutation.mjs` re-runs suites whose red proofs read a fixed old commit (`test/redaction-object-keys.test.mjs`):
"not a tree object" before any mutant ran. It now fetches the whole history and runs `bench/ci-history-check.mjs` first.

### Security - the shred keyring is ignored by `mem init`, and a tracked one is an ERROR

`.mem/keyring.json` (the keys of `shred: true` entries) had no `.gitignore` rule, and `mem-reflect` and `mem-handle-post` run `git add -A`. A keyring under git history
defeats the mechanism: destroying a key becomes a new commit, and the old key is recoverable from the commit before (`src/shred.mjs`, `docs/CAPABILITIES.md` 10.23). `mem init` writes the rule
(and one for the temp file of the atomic keyring write); the doctor finding `gitignore` is an ERROR when the rule is missing and when the file is already TRACKED - then with its own
sentence: entries shredded so far must NOT count as deleted, `git rm --cached` repairs the index only, the keys stay in the history. Documented in `docs/security-model.md` ("Unsolved,
explicitly"), `docs/CAPABILITIES.md` 10.23 and `docs/design.md`: the keyring does not travel with git (a second clone reads `unreadable: keyring-absent`), it is a single copy with no backup,
a lost file makes every shredded-capable entry permanently unreadable, and a restored old copy un-shreds. Distribution and one encrypted backup are manual, outside git.
`test/pipeline-ignore.test.mjs` (KEYRING).

### Fixed - round 3: negated patterns, hostile names in glob groups, an unknown index, base rules in the table

- **`!` patterns** `git check-ignore -v` answers a match by a negated pattern with a source, and the doctor counted it as ignored: `!.mem/embed.env` at the end of the file read green. A pattern
  cell that starts with `!` counts as NOT ignored now (ERROR for embed.env and the keyring). `test/gitignore-guards.test.mjs`, red on `57cbf82`.
- **Glob groups** `specMatcher` used `.` for the star, which skips line breaks: a tracked `.mem/EVIL<newline>FORGED.lock` fell out of every group (`STILL TRACKS 1 ... ()`) and the advice repaired
  nothing. `[\s\S]*` now, the first rule claims a file, files no group claims are counted as `+N elsewhere` and make the command name every runtime path with `--ignore-unmatch`. Probe with
  line break, CR, U+2028/U+2029, ESC and U+202E in both glob specs (Windows asserts the refusal of the first ones).
- **`mem init`** says `tracked runtime files: unknown` when `git ls-files` fails in a repository, instead of staying quiet. A quoted command carries the sentence that it is for bash or PowerShell.
- **Base rules** `embed.env`, `epoch.json`, `search-index*`, `vectors.db`, `tasks/`, `raw-offsets.json`, `local/`, `digest-*`, `hooks/` are rows of the table: a memory that committed one is reported.
  A tracked `embed.env` is an ERROR with its own sentence (rotate the keys).

### Fixed - review follow-up: no file name out of the index in the output, and the single runtime files under `.mem/` (B1, B2)

- **B1** `mem init` and the doctor finding `gitignore` printed the first tracked runtime paths raw, from the index. A legal POSIX file name can hold an escape or OSC sequence, a bell,
  a newline (a forged second line) or a U+202E, and the line goes to a terminal and from there into a model's context. They print folders and counts now
  (`3 in .pipeline, 1 in .mem/locks`), never a name; the command is built from the table, not from the index. `test/tracked-names.test.mjs` builds such a name at run time
  (Windows cannot hold a control character in a file name: that branch asserts the refusal and runs the bidi override alone); red on `862d815`, which printed the name.
- **B2** The same gap for single files. `src/trackedruntime.mjs` is now ONE table (`RUNTIME_RULES`: gitignore rule, pathspec, doctor probe, reason) that `mem init`, the doctor's
  required paths and the tracked check all read. New: `.mem/component-table.json`, `component-table-rebuild.log` and `.lock`, `backlinks.json`, `dashboard-head.json`, `timetrack/`
  (derived), `watch.log`, `serve.log`, `.mem/*.lock`, `.mem/*.lock.d/` (logs and locks), and the files the code itself calls gitignored, machine-local or not versioned
  (`console.json`, `console-log.jsonl`, `measurements.jsonl`, `raw-watermark.json`, `archive.json`, `rule-draft-week`, `embed.json`) or that this repo's own `.gitignore` lists as local state
  (`inbox-seen.json`, `inbox-whoami`, `reflect-marker/`). Left out on purpose, each with its reason in `test/pipeline-ignore.test.mjs`: `config.json`, `thesaurus.json`,
  `answer-patterns.json`, `langbridge/` (authored), `rewrites.jsonl`, `bridge-reports.jsonl`, `raw-exclusion-state.json`, `raw/` (`keyring.json` was on this list until round 3: see the Security entry above). An inventory test scans `src/`, `bin/` and `install/` for every `.mem/<name>` and asks git whether a fresh memory ignores it: a new file under `.mem/`
  is red until it is in the table or on the list.
  With about 35 paths the doctor asks git ONCE (`check-ignore -v -n --stdin -z`) instead of once per path: median 149 ms -> 7 ms for the finding (7 runs, this machine, loaded).

### Fixed - finish of the hook work: tracked runtime files, a warning without a reason, cut before mask (M1-1, N5-1, N2, #27)

- **M1-1** The doctor finding `gitignore` asked `git check-ignore --no-index`, which answers for the path and not for the index: a memory that had committed `.pipeline/*`
  before the rule existed got "git ignores all 6 required paths" after `mem init` while the tree stayed dirty and the recall hook's pull stayed blocked. It now also asks
  `git ls-files -ci --exclude-standard` (`src/trackedruntime.mjs`) and says WARN with the exact command, `git rm --cached -r .pipeline`; `mem init` names the same command.
  Red on `4229302`: init, write, commit, init - the doctor said ok (`test/pipeline-ignore.test.mjs`).
- **N5-1** A memory without a remote, with the default `defaultRemote: "origin"` that `mem init` writes, printed `WARNING ... is not a remote of this clone - using origin` at every
  session start - a warning with no reason, origin stays either way. Now only a value other than `origin` set against a clone that HAS a remote is warned about; a value that is
  not a plain name is still refused loudly. `bin/_portable.sh`, the inline twin in `install/hooks/session-start.sh`, `install/windows.ps1` (the last one read, not run: no PowerShell here).
- **N2** The clone gate cut the cached line at 300 characters BEFORE the mask: a token that began at character 280 came out as twenty characters in clear. `cutMasked(line, 300)` now;
  a raw U+202E in `test/clone-gate.test.mjs` is the escape `\u202e`.
- **#27** The same gap under `.mem/`: `before-edit/` and `workflow-marks/` (JSON marks per session), `command-guard-marks/` (empty `.warned` files, which git does track), `locks/`
  (lock files with the pid, host and start time of one machine) and the three `*-turns/` folders (claims taken by `mkdir`: empty folders, which git does not see - the rule keeps it so)
  are runtime state of one clone. `mem init` writes a rule for each, the doctor asks git about them, and a test holds `RUNTIME_DIRS` together with the register's per-session folders.

### Fixed - review follow-up of the hook work (M2, N1-N3, N5-N7)

- **N3** The touched file's name (last two path segments) left the before-edit hook unmasked: a file `.../ghp_<token>.sh` put the token into the answer, the pointer line,
  the journal's `file` field, the trace and the name of the once-per-file mark. The answer now passes `maskOutput`; journal field, trace and mark name take the masked query
  (a masked name is no path name for the journal, so the field is left out). `test/before-edit-mask.test.mjs`, token built at run time, red on `c1ad4a9`.
- **N1/N2** The clone gate shows nothing when its verdict cannot be written (it could not be throttled and would repeat on every prompt), and shows the cached line only cleaned:
  `Memory: ...` first, one line, no control or bidi characters, secret shapes masked, at most 300 characters.
- **N5** A `defaultRemote` that is no remote of the clone (`git remote get-url -- <name>`) is refused like a bad name: `git fetch <name>` reads it as a path or URL - a directory
  inside the clone was enough (red on `c1ad4a9` in `test/tracked-ref.test.mjs`). The refused value is printed clipped to 40 printable ASCII characters. Shell, inline twin, both PowerShell hooks.
- **N6** The PowerShell plain-name checks end in `\z`, not `$` (.NET lets `$` match before a trailing newline).
- **M2** The node-start counter loads with `--import` and a file URL (a backslash path in `NODE_OPTIONS --require` breaks on Windows); the compile-cache probes give the scratch home its own
  `LOCALAPPDATA` on Windows instead of deleting it.
- **N7** The figures in the code comments are the CHANGELOG's: 13 starts, median of 11 runs.

### Fixed - a memory's `.gitignore` covers the whole `.pipeline/` folder (review of the hook work, M1)

Only `.pipeline/observations.jsonl` had a line. `.pipeline/injections.jsonl` (the journal, written by every hook call) and the new `.pipeline/clone-gate.json`
had none, so `git add -A` (mem-reflect, mem-handle-post) tracked them: every hook write made the tree dirty, the recall hook's pull stopped, and two clones
met in add/add conflicts on files that each describe one machine. Red on `c1ad4a9`: init, write the files, `git add -A` tracks `clone-gate.json` and
`injections.jsonl`. `.pipeline/` is runtime state of one clone throughout (journals, verdict caches, the recall server's socket and key, the command-guard booklet,
cost journal, shrink baseline - "runtime state, per machine" in `src/shrink.mjs`), so the rule is the folder, not a list. `mem init` writes it; an existing memory
gets it by running `mem init` again (the "already initialized" branch repairs the file and says "added 1 missing .gitignore rule"); the doctor finding
`gitignore` now asks git about `.pipeline/injections.jsonl` and `.pipeline/clone-gate.json` and names that command when they are not ignored. Files that
a memory already committed stay tracked (git does not untrack by ignoring): `git rm --cached -r .pipeline` once. `test/pipeline-ignore.test.mjs`.

### Added - the gate "which clone answered" (D-B follow-up; lucky-mem decision 2villa33pdtl)

`src/provenance.mjs` was reached by one caller, the doctor finding `provenance` (and `checkBehind`'s lag count) - which speaks when somebody asks. The case it
was written for is the one where nobody does: a session that works for hours against a frozen clone because the recall hook's detached pull keeps failing.
Now the session start (shell and Windows) prints one line naming the clone that answers - directory, head, age, commits behind origin, whether tracked files
are changed - always, and the recall hook (`src/clonegate.mjs`) puts the same line under its header when, and only when, the clone is STALE (older than 90 minutes
AND behind origin or unable to tell; old but level with origin stays quiet, as the sibling house's decision demands), at most every 30 minutes, the verdict
cached 5 minutes in `.pipeline/clone-gate.json` (`provenance()` costs a median 24 ms of git processes - fine once, too much on every prompt of a hook that
answers in 60 ms against a warm server). `MEM_CLONE_GATE=0` turns it off. A directory that is no git tree is left alone and gets no cache file. Without a line
the recall text is byte-identical to the old one. Found while wiring it: `dirty` counted UNTRACKED files, so every memory in use (journal under `.pipeline/`,
marks under `.mem/`) read as "tree dirty - the hook does NOT pull then", which is false - the hook's pull is blocked by tracked changes only
(`bin/mem-retrieve`). `provenance()` now asks `git status --untracked-files=no`. Limits, said out loud: no network (a clone whose fetches ALL fail keeps its
last view of origin and reads as level; `git fetch` touches `FETCH_HEAD` even when it fails - measured - so that file cannot tell either).
`test/clone-gate.test.mjs`: the line shows once and waits, the cache holds for 5 minutes, fresh/no-git/off show nothing and write nothing, an old clone level
with origin stays quiet, the recall text is byte-identical without a line, the real hook shows it on a stale clone and not on a fresh one (mutation caught), the session
start prints it for both.

### Fixed - the warm recall server answers under the CALLER's switches (D4 follow-up; lucky-mem 484e11b75)

The server runs the same `find` handler as the direct path, but inside its own process: `MEM_RETRIEVE_REQUEST_FRAME`, `MEM_SEARCH_LEVERS` and
`MEM_RETRIEVE_TIE` came from the environment the SERVER was started with, not from the hook that asked. The same hook with the same switch answered
differently with and without a server (measured on a scratch memory, "explain the empty query guard to me", `MEM_RETRIEVE_REQUEST_FRAME=0`: direct
1.7 / 1.3, server 1.8 / 1.4). The sibling house fixed the same class for the request frame and its candidate cap (484e11b75); cheap-mem has no env-driven
candidate cap (its MMR pool is a constant, `mmrPoolFor`), so the request frame, the levers and the tie cut are what carried over. The client now sends
the value of each switch (`null` for one it does not have: the caller's absence wins), the server evaluates the question under that environment
(`COMMANDS.find({ rest, args, env })`). `MEM_EXPAND` shapes the index the server holds in memory and cannot be overridden per call: a different value is
REFUSED and the hook asks the direct path. An older client (no environment in the request) is answered as before.
Measured on the hook path, 11 runs each (scratch memory, 4 cores): `path: server` 11 of 11 in the journal with the server up, `path: direct` 11 of 11
with `MEM_RECALL_SERVER=0`, the 22 outputs byte-identical; median 603 ms with the server, 686 ms without (the node starts around the search dominate).
`test/recall-server-env.test.mjs`: red on the base for four of six probes.

### Fixed - a HOME with a space no longer breaks the default memory search (D5)

Six bash hooks (`mem-before-edit`, `mem-retrieve`, `mem-after-failure`, `mem-catch-fail`, `mem-stop`, `mem-subagent-start`) looked for the memory with
`for k in "$CHEAP_MEM_ROOT" $PROBE` - an unquoted `$PROBE`, default `$HOME/cheap-mem`. With `HOME=/home/Max Muster` that is two words, no memory, and the hook
exits 0 in silence (installed hooks bake `CHEAP_MEM_ROOT` in and never noticed; a hand-run hook and a fresh machine did). The roots are an array now: the
whole `MEM_RETRIEVE_ROOTS` / `MEM_STOP_ROOTS` value is tried first (one path may hold a space), then its whitespace-separated words, and `read -a` does not glob
where the unquoted expansion did. The PowerShell twins try the whole value before splitting it, and `mem-digest.ps1` passes the daily gold spawn ONE quoted
argument string (an `-ArgumentList` array of paths is joined with bare spaces on Windows PowerShell 5.1, and the catch around it hid the failure). Inventory
by `shellcheck` 0.11.0 over every hook plus grep: these were the only unquoted path expansions; kept on purpose and named in `test/hook-spaces.test.mjs`:
`$CMD` (a configured command line with flags) and `$RECORD_PATHS` (two repo-relative constants). Red on the old loop, mutation caught, end to end from a HOME with a space.

### Fixed - the session start and the recall hook follow the branch the memory tracks (D4; lucky-mem parity)

`install/hooks/session-start.sh` (and the inline Windows hook in `install/windows.ps1`) fetched `origin main`, checked out `main` and pulled,
whatever `.mem/config.json` said; the recall hook pulled `origin main` too. Reproduced: a clone on `develop` (config `defaultBranch: develop`,
the remote also has a `main`) came out of a session start on a NEW local `main` tracking `origin/main` - later writes went to the wrong branch -
and the recall hook's background pull never brought `develop` forward (the old hook is the red proof in `test/tracked-ref.test.mjs`). Both now ask the
memory (`defaultRemote` / `defaultBranch`, the keys `mem-watch` reads; `origin`/`main` when absent). The config is data out of a cloned repository:
only a plain name reaches git (a leading `-`, `..`, `//`, a trailing `/` or `.lock` and anything outside letters, digits and `._-/` are refused
with a warning and the default stands - a `--upload-pack=...` branch starts nothing). `MEM_RETRIEVE_REMOTE` / `MEM_RETRIEVE_BRANCH` still win.
The "memory state old" warning names the tracked ref instead of `origin/main`.

### Performance - the hooks keep a V8 compile cache, in the user's cache (R6; lucky-mem e146b45ce, c0b14705c)

Every hook call is a new node process that translates `src/*.mjs` from scratch. The hook shells (`mem-before-edit`, `mem-retrieve`,
`mem-after-failure`, `mem-catch-fail`, `mem-subagent-start`, `mem-stop`, the session start, and their PowerShell twins) now set
`NODE_COMPILE_CACHE` to `<user cache>/cheap-mem/node-cc` - `${XDG_CACHE_HOME:-~/.cache}` on Linux, `~/Library/Caches` on macOS,
`%LOCALAPPDATA%` on Windows - **not** in the memory (a git repository that travels between machines). A value the user set stays;
a directory that cannot be made means no cache and an unchanged hook; Node before 22.1 ignores the variable and runs cleanly without.
Measured on the (now single-start) before-edit hook, 15 interleaved runs, median: CPU 161 -> 145 ms per call (about 10 %); the wall figures of that run (256 vs 280 ms) lie inside the
noise of the loaded box - the sibling house measured about 50 ms on its heavier hook; with one lean start there is less to cache.
`test/hook-compile-cache.test.mjs`: source order (set before the first node, comments do not count), a real run fills the user cache
and leaves nothing in the memory, the user's value wins, an unmakeable directory is harmless, every platform branch of
`mem_compile_cache` (Linux with/without `XDG_CACHE_HOME`, macOS, Git Bash, no HOME); red on the old hook, mutation caught.
New variable in the register: `NODE_COMPILE_CACHE` (and `XDG_CACHE_HOME`, `LOCALAPPDATA` as standard OS variables).

### Performance - the before-edit hook runs in ONE node process (TB5; lucky-mem f17d5fa3d)

`bin/mem-before-edit` and its PowerShell twin cut one recall into a dozen `node -e` snippets plus a full `node bin/mem component`
(every command group loaded for one lookup). Measured on the old hook with the injection of a real hit (Linux 6.18, 4 cores,
Xeon 2.1 GHz, Node 22.22, median of 11 runs, marks reset each run): **13 node starts, 1079 ms**. (Re-measured at the end, old/new/new-with-cache INTERLEAVED, 15 runs each, on a box that other builders were loading: wall 1664 -> 256 ms, CPU user+sys 847 -> 161 ms; the load moves the wall figures, the ratio holds.) Now the shells keep the switches, the
root lookup and the two armed Bash guards, and hand the rest to `bin/mem-before-edit-core.mjs` (`src/beforeedit.mjs`):
**1 node start, 222 ms** (a Bash call that writes no file still starts none). `mem component --hook` and the hook share
`src/componenthook.mjs`; `compactLine` moved to its own small module (`src/compactline.mjs`, `display.mjs` re-exports it).
The output is unchanged byte for byte - `test/before-edit-golden.test.mjs` runs the old hook (kept verbatim as a fixture) beside the
new one over a hit, the pointer, an unrelated and a related new entry, no hit, a broken log, a missing and an empty memory,
duties and procedures, solution lines, Bash that writes and does not, and compares stdout, exit code, trace and journal line.
`test/before-edit-node-starts.test.mjs` counts the starts (red on the old hook: 13; ratchet 1; a mutated hook with one extra
start is caught). The PowerShell twin asks for ASCII on the wire (`MEM_BE_ASCII`, an `\uXXXX` escape for every non-ASCII character), so the
console code page cannot mangle the answer. A search that hangs is cut by one 8 s cap around the whole run and booked as
`rebuild`, as before. `git` run by the component table no longer leaks "not a git repository" onto stderr.

### Fixed / Security - a failed listen is a message; the listener inventory reads what ships and knows frameworks; the bridge refusal has its own words (serve-token-rest-cm; follow-up to serve-token-refuse-cm)

A taken port killed `bin/mem-serve` (and so `mem serve`) with `Unhandled 'error' event` and a stack, and `mem-mcp --http` with `mem-mcp fatal: Error: listen EADDRINUSE` and a stack. Now both print one line (`webauth.listenFailureMessage`: host and port, what is wrong, `CHEAP_MEM_SERVE_PORT` / `mem serve --port` or `CHEAP_MEM_MCP_PORT` as the way out; permission and address-not-available get their own words) and exit 1; no stack. The dashboard used to create its setup code BEFORE it bound, so a start that failed on a taken port left a `serve-setup-code` file in `.pipeline/` (measured on the old state: the file stayed); it is now written in the listening callback, after the bind. `mem serve` needed no change: it already turned a rejected `serve()` into a message. Probes: `test/serve-listen-error-cm.test.mjs` (port held through port 0 on loopback; exit 1, no stack frame, host and port named, no setup code left; positive control on a free port that DOES make the code).
The bridge refusal said "no password login stands behind this door"; the bridge has never had a login. `startDecision` takes `hasLogin` (default true; the bridge passes false): the bridge's refusal says the token is its only credential, and its start notice no longer mentions a login.
The listener inventory (`test/serve-token-refuse-cm.test.mjs`) now (1) reads what `package.json` "files" ships (so `assets/`, `docs/` and the root files; the list is derived, not typed), (2) sees server frameworks without a Node network import (`import express from 'express'; express().listen(8000, '0.0.0.0')`; express, fastify, koa, ws, hono, `@hono/node-server`, restify, polka, `@hapi/hapi`, socket.io, http-server; `.listen(`, `new WebSocketServer(`, hono's `serve(`), (3) sees `Server(` without `new`, `Server as S` imports, `process.getBuiltinModule('node:http')`, `createRequire(...)('node:http')`, the extensions `.mts` `.cts` `.jsx` `.tsx` and the shell/PowerShell extensions `.zsh` `.fish` `.cmd` `.bat` `.psm1`, and (4) sees `node -e` / `--eval` with a server, `php -S`, `ruby -run -e httpd`, `npx http-server`, `SimpleHTTPServer`, and JS that spawns such a command (`spawn('python3', ['-m', 'http.server'])`, `execSync('php -S ...')`, `spawn('node', ['-e', ...])`, `spawn('nc', ['-l', ...])`). Every pattern has a name and a sample; a mutant test switches each name off and its sample must go quiet, and switching all new parts off (the old detector) leaves all 30 new samples unseen. The limit stays: a ratchet against the common shapes, not a proof (a name built at run time, a listener inside a dependency, a framework behind a module not on the list are not seen). No change to the shipped code of the inventory's findings: the real tree still has exactly the two doored services and the three named exemptions.

### Changed / Security - the HTTP services refuse to start without a token, unless "local, no token" is set on purpose (serve-token-refuse-cm; owner decision 2026-10-14)

`mem serve` (`bin/mem-serve`) and `mem-mcp --http` are the two HTTP services in cheap-mem (the warm recall server is a Unix socket or named pipe with a key file, not a TCP port; `test/serve-token-refuse-cm.test.mjs` pins the list: a file under `bin/`, `src/`, `install/`, `hooks/`, `shared/`, `bench/` or `eval/` that imports `net`, `http`, `https`, `http2`, `tls` or `dgram` (static, dynamic or `require`) and creates a server by any of the common shapes must be one of the two doored services or a named exemption - a ratchet against the common shapes with a counter-probe per pattern, not a proof: a name built at run time is not seen).
Until now a door with no token and nothing else behind it started anyway and printed a `NOTICE`; the rule is now one shared decision, `webauth.startDecision`: no token, no password login (the dashboard's own credential) and no switch means the process exits with a code other than 0, a message that names the token variable, a command that makes a token and the switch, and **no port is bound**.
The switch is `--local-no-token` (on `mem serve`, `bin/mem-serve` and `mem-mcp --http`) or `CHEAP_MEM_SERVE_LOCAL_NO_TOKEN=1` / `CHEAP_MEM_MCP_LOCAL_NO_TOKEN=1` for a service unit. It lifts only that one refusal: it is honoured on loopback only (an allow list of three names; `0.0.0.0`, `::`, `127.0.0.2` and every other spelling refuse), a request that carries a proxy header is still turned away, and the start prints a `NOTICE` that the service runs without a token.
**What breaks:** a dashboard started with `CHEAP_MEM_SERVE_LOGIN=off` and no token, and an HTTP bridge started with no token; both now need a token or the switch. **What does not:** a dashboard with its password login on (the default, and what `install/serve-service.sh` installs) keeps starting, because the password is a credential; a start with a token is unchanged. The probes that started token-less servers (about 50 test files, three bench scripts) set the switch.
New environment variables `CHEAP_MEM_SERVE_LOCAL_NO_TOKEN` and `CHEAP_MEM_MCP_LOCAL_NO_TOKEN` are in `src/envregister.mjs` and `docs/environment-variables.md`; the way to a token is in `docs/dashboard.md`, `docs/mcp-setup.md` and in every refusal message.
Follow-up on the same branch: a refusal is now a message and exit 1 from `bin/mem-serve` and `bin/mem-mcp` too (it was a stack trace), the refusal names the PowerShell form of the token, and the older `openDoorNotice` (which said every proxy hit counts as local, against the new check that turns a forwarding-header request away) is replaced by one accurate start notice.

### Fixed / Performance - eighteen sites that took quadratic time on one long run of the same character (linear-regex-cm, task 26; cheap-mem only)

The redaction-keys round measured it: a run of 100,000 blanks, hyphens or line breaks plus one letter took 3.7 to 4.3 s PER pattern that ends in `+$` or `*$`
(each character of the run starts a match that walks to the end of the run and fails at the `$`). Inventory of `src/`, `bin/` and `install/` (1,301 regular expression
literals, every one run on 30 pathological inputs, plus the dynamic patterns read by eye), then, per site, whether foreign or model-written text reaches it and how large it can be.
Repaired, 18 sites in 14 files (measured at 1 MB, best of three, against the state before; the old state needs minutes for each):
`src/inbox.mjs` (`build`, `parse`: `trimEnd`; `In-Reply-To`), `src/agents.mjs` and `src/appointments.mjs` (`trimEnd`), `src/cli/githook.mjs` and `src/environment.mjs`
(the `.gitattributes` rules, the trailing line breaks, and the `.gitignore` repair, which looked a line up in an array per line and now in a set), `src/repetitionhint.mjs` (the
sentence with a marker word, one pass over the stretches between stops), `src/agentledger.mjs` (the package name), `src/component.mjs` (the lazy run in front of a file name: found by the
name, the run read backwards), `src/doctor.mjs` (the `<file>.jsonl:<line>` places), `src/gauges.mjs` (the paths of a command, the redirect pattern, the quoted stretches),
`src/bashtargets.mjs` (`/\d*>$/` is `endsWith('>')`) and `src/commandguard.mjs` (`hits`: the lead words in front of every place a rule's first word stands, found for every end in one
pass; `'xgit push '` x 20,000, 200 KB, took 17 s in the hook, 1 MB takes 0.14 s). New: `src/lineartext.mjs` (`trimEndNewlines`, `attributesOf`, `jsonlPlaces`).
The paths of a command and the idless-line places are read EXACTLY and come out whole: a first version cut a run of path characters at 512 (`boundRuns`), which turned a path of 619 characters
into 512 and lost one of 605; the golden tests below hold both.
Deliberate changes of behaviour, all on input no real file or tool produces:
(1) an `In-Reply-To` of more than 255 characters is refused as "not a message file name" (no file system holds a longer name; the old pattern took minutes to say it);
(2) `.gitattributes` is read the way git reads it, a set of words per line, the last word wins, a line with a word that is no attribute name (a trailing `# comment`) dropped as git drops it: `*.jsonl merge=union eol=lf`
in ONE line is both rules (`mem init` and `mem doctor` called the union driver "missing" and appended a second rule), a later line that takes the value back is respected, and a rule split over two lines is no rule.
The test for this is `git check-attr` on 28 shapes of the file.
Not reachable at a size that matters, and left alone: `src/skillregistry.mjs` and `src/categories.mjs` (the slug has no run of hyphens left),
`src/cardrules.mjs`, `src/viewer.mjs`, `src/recallrender.mjs` (cut to a budget of a few hundred characters first, whitespace folded),
`src/appointment-invite.mjs` (a mode-600 password file of the owner), `src/doctor.mjs` (`git rev-parse --show-prefix`, a path), `src/errorfixes.mjs`, `src/decisioncard.mjs`, `src/login.mjs`
(a run that cannot repeat the character in front of it: linear), `bin/mem-serve` (a header line is at most 16 KB), `src/gap.mjs`, `src/inbox.mjs` `fromFileName` (file names, and a name part is at most 64 characters),
`src/entity.mjs` and `src/netderive.mjs` (already bound by `boundRuns`).
Guards: `test/linear-trim.test.mjs` (20 probes: the site on 1 MB of the bad input in a child process, once at 1 MB and once at a quarter of it, read as a ratio, linear about 4, quadratic about 16, next to a generous
ceiling of 2 s; the state before is killed, over the ceiling or wrong on all 20),
`test/linear-trim-golden.test.mjs` (the old pattern written out as the reference, 4,000 to 120,000 random strings per site; `git check-attr` as the truth for the attributes; 17 mutants red).


### Fixed - review of the hook-shim fix: the time-cap branch, a dead code path, an apostrophe in a path (hook-shims-code-cm, second round)

- **The start hook died when the alarm hit its time cap.** `install/hooks/session-start.sh` named `$mem_show` in the "alarm hit its time cap" line, but set it only at the bottom; under `set -u`
  the installed shim ended with rc 1 ("unbound variable"), and the today line, the how-to block and the journal line never came (base 870788f: rc 0). It is set right after the tool lookup now.
  `test/doctor-alarm.test.mjs` H demands rc 0 and the rest of the output, and `test/installed-hooks-run.test.mjs` runs the installed shim with a 0.01 s alarm limit.
- **A dead `CHEAP_MEM_CODE` is said, not swallowed.** When the checkout the installer pointed at is moved or deleted, prompt recall, before-edit, swallowed-failure, real-failure, sub-agent and stop
  exited 0 with no byte. They now call `install/support/tool-missing.sh` (installed as `cheap-mem-tool-missing.sh`; `.ps1` twin on Windows), which prints one `systemMessage` JSON object
  (Claude Code shows it to the person and does not hand it to the model; exit 0, so it never blocks a prompt or an edit; stderr on exit 0 is not shown, which is why it is not the channel),
  at most every 30 minutes per hook (marker under `<memory>/.pipeline/`). The start hook names the baked path and the repair. It stays silent without `CHEAP_MEM_CODE` (a shim started by hand promised nothing).
  `mem doctor` finding `integration-contract` is ERROR when a registered shim's baked code path and memory hold no `bin/mem` ("registered, but SILENT"); it reads the installed files, not the journal.
- **An apostrophe in a path broke the shims.** The installer wrote `export CHEAP_MEM_CODE='<path>'` unescaped (bash -n rc 2); the memory path likewise. Both are escaped in all shims, and `windows.ps1` doubles
  the quote for both baked values and tests the tool paths with `-LiteralPath`.
- `CHEAP_MEM_CODE` in `src/envregister.mjs` and `docs/environment-variables.md` now says what is true: all seven hooks read it. The order (memory `bin/` before the installed tool) is unchanged.

### Fixed - the installed prompt hook was mute and the start hook said "NOT attached" (hook-shims-code-cm; lm counterpart: 7c9c414ab, another cause, same effect)

Installed with `install/claude-code.sh` into a scratch HOME and started the way Claude Code starts a hook (`env -i`, no `CHEAP_MEM_ROOT`, the hook JSON on stdin), two of the seven
shims delivered nothing: `UserPromptSubmit` exited 0 with 0 bytes on a prompt that the same memory answers through `bin/mem-retrieve`, and `SessionStart` printed
`cheap-mem NOT attached ... the tool (<memory>/bin/mem) is missing`. Both looked for the tool only inside the memory, and a memory made by `mem init` carries no `bin/`.
The other shims (pre-edit, catch-fail, after-failure, subagent-start, stop) already found it through `CHEAP_MEM_CODE`, which the installer bakes in; these two never got the line,
so no prompt of any session got recall and nothing failed to say so. Now `install/hooks/user-prompt.sh` and `install/hooks/session-start.sh` resolve the tool in the order of
`pre-edit.sh` (the memory, then `CHEAP_MEM_CODE`, then the shim's own directory), and `claude-code.sh` bakes `CHEAP_MEM_CODE` into the prompt shim. `install/windows.ps1` had the same
shape in all seven generated PowerShell hooks (and set `CHEAP_MEM_CODE` in none): each now looks under `$env:CHEAP_MEM_CODE`, falling back to the install location baked in as `$CodeHint`.
`install/linux.sh` and `install/macos.sh` install the watcher service and write no hook shims; `mem setup claude` runs `claude-code.sh`. New guard `test/installed-hooks-run.test.mjs`:
installs into a scratch HOME, starts every registered hook with a bare environment and a real hook JSON, and demands bytes in the context (and a capture from the Stop hook); the
.ps1 hooks are run on win32 with PowerShell, and checked statically on every platform.

### Fixed - reflector follow-up: lines that belong together, the env route, a temp directory inside the memory root (small-parity-cm, point 3; Parity lm=open)

- **A secret across lines is masked.** `bin/mem-mask-copy.mjs` masked a plain (non-JSON-object) line on its own, so a PEM private key lost its mask: no single line has its shape. Consecutive plain lines are now masked as one block, cut at
  20,000 lines or 2 MiB so the work stays linear (8 MB of plain lines took 2.0 s, measured). A bare number or string line counts as text. A secret longer than a cut (2 MiB) is the only thing a cut can split.
- **The env route.** `TRANSCRIPT_PATH_ENV` is unset right after it is read, so the model no longer inherits the raw path through it.
- **A temp directory inside the memory root fails closed.** If `TMPDIR`/`TEMP`/`TMP` points into the memory root the copy would be picked up by `git add -A`: the helper (`--root`) refuses, no model starts, the marker goes back.
- **ps1:** everything from the copy to the end of the job sits in one `try`/`finally` that removes the copy.
Probes in `test/reflect-masked-copy.test.mjs`, red against 37e1e25; five mutants added or re-anchored.

### Fixed - pin words with digits, `pinhash`/`pinvalue`/`pinnumber`, and the plural of a compound (small-parity-cm, follow-up to point 1; Parity lm=yes)

A word that ends in `pin` and digits (`pin1`, `PIN2`, `myPIN2`, `userpin2`) is a pin word, and so is `pin` + `code|hash|value|number|num|digest|salt` spelled in one word (`pinhash`, `pinvalue`, `pinnumber`, `userpinhash`).
The compound PLURAL (`userpins`, `bankpins`) follows the plural rule of the other keywords (`tokens`): a counter key, so a string falls and one number stays. The bare word `pins` stays free, also as a word of
`userPins`/`user_pins` (51 uses of `pins` in this tree, all the English word). Corpus measure (docs, test, README, src, bin, bench, shared, eval, CHANGELOG; and the 52 MB of node_modules): no word ends in `pin<digits>`, none is a
compound plural of `pin`, none is `pinhash`/`pinvalue`/`pinnumber`, so the stricter reading costs no false alarm there. `spin`, `spin2` and `spinvalue` stay (the English-words list is tested on the part up to `pin`).
Monotone against 870788f: 40,105 text cases and 60,000 random objects with the new key shapes, 0 regressions, every newly masked field under a path that holds `pin`. Four mutants added, 13/13 of `src/redaction.mjs` caught.

### Fixed - the reflector reads a MASKED copy of the transcript (small-parity-cm, point 3; Parity lm=open; decision "outgoing paths stay, with a mask")

`bin/mem-reflect` (and its `.ps1` twin) handed `claude -p` the path of the transcript as it lies on disk, so the model saw every secret in it, while the digest (`mem raw show`) and the mail handler (`mem inbox show`) read masked.
New `bin/mem-mask-copy.mjs` writes a copy through the same masking (`maskEntry` per JSON line, `maskText` for any other line) into a private directory under the OS temp directory (never under the memory root: the reflector
commits with `git add -A`); `$TRANSCRIPT_PATH` is the copy and it is removed when the reflector ends: on a normal end and on a timeout (sh: trap EXIT; ps1: `finally` around the whole run from the copy to the job). Honest limits: SIGKILL (or a power cut) cannot clean up; and a TERM, INT or HUP that reaches the sh script while the model runs is deferred by bash until the model has ended, then the copy is removed. Fail closed: if the copy cannot be made no model starts and the marker goes back
to where it was. `MEM_HEADLESS` is untouched. Probe `test/reflect-masked-copy.test.mjs` with a stand-in model (token, keyed value and PIN do not arrive; the raw path is in neither argument nor environment), red against the base; six mutants added.
The original path is not given to the model: not in the prompt, not in `TRANSCRIPT_PATH`, and the hand-in variable `TRANSCRIPT_PATH_ENV` is unset (`Remove-Item Env:` in the ps1) before the model starts. A model with file tools that guesses where its host keeps transcripts can still open one, which only a sandbox would prevent.

### Fixed - the answer check asks for the WHOLE corrected answer, not an addendum (small-parity-cm, point 2; Parity lm=yes)

After a block by the Stop hook the reason said "fix the answer if it applies". Under `claude -p` and over a bridge only the last message reaches the reader, and what came was an addendum that pointed at a first answer
the reader never saw. The reason now says: output the WHOLE answer again, corrected, not just an addendum, because whoever reads only the last message never sees the first one; a false alarm is still one sentence.
Held by `test/answer-check.test.mjs` (both `checkStop` and `bin/mem-stop`), red against the old wording; one mutant added to `bench/mutation.mjs`, caught.

### Fixed - `pincode`, `userpin` and `pincode_hash` fell open in an object (small-parity-cm, point 1; Parity lm=yes)

The object key rule knew `pin`, `pwd` and `passcode` as whole words only, so `{pincode: "4711"}`, `PINCODE`, `userpin` and `pincode_hash` stayed open in `redactObject` and `maskEntry`, as a string and as a number.
Now `pincode` is a pin word, and so is a one-word compound that ENDS in `pin` or `pincode` (`userpin`, `bankpin`, `userpincode`). A word that STARTS with `pin` is not (`pinned: true` is a flag; 194 uses of `pinned`,
44 of `pins`, 24 of `ping`, 22 of `pinning` in this tree). The one word of the corpus that ends in `pin` is `spin` (8 uses, none as a key); it and a short list of English words that end in `pin` (`hairpin`, `kingpin`, ...) stay.
The counter rule is that of `pin`: `pincode_count: 3` and `userpin_length: 4` are free numbers, `pincode_count: "1234"` falls. Measured against 870788f: 40,105 text cases and 60,000 random objects (two walkers), 0 regressions;
every newly masked field sits under a path that holds `pin`. Five mutants added to `bench/mutation.mjs`, 9/9 of `src/redaction.mjs` caught.

### Performance - measured, not built: a word-normalisation memo for the cold index build (cli-speed-cm TB9; cheap-mem only)

The order's lever: memoise the normalisation of a word. Measured first, on the 20,000-entry scratch memory, a cold `buildIndex`: the English pack normalised
827,000 words and the German one 403,000, of only 19,300 different ones, so a memo would hit about 98 times in 100, and `stripAccents` plus `deNormalize` stand at 201 of 1,840 ms
in a CPU profile of the build (11 %: that is the ceiling, a free normaliser). A memo with a ceiling in `src/language.mjs` was built as an experiment and measured,
child CPU time of `buildIndex` alone, 6 interleaved runs each, median: 1,808 -> 1,719 ms (5 %, 89 ms; wall time on this host swings from 1,700 to 4,800 ms at load 30 and says nothing).
Under the order's own bar (below 10 % is not built) it was thrown away. The larger parts of the build are `buildLexicon` (380 ms), `buildTermGraph` (242 ms) and the shard
writer (187 ms), not the normaliser. How often the build runs, counted in the code (`loadIndexCached` falling through to `buildIndex`): on a clone without `.mem/search-index`
(the cache is local), after a `CACHE_VERSION` or language change, when the cache does not read back whole, when a log file was rewritten or shrunk (a merge that reorders lines),
once the corpus has grown by 20 % since the last build (`REBUILD_AFTER_FRACTION`), with `--fresh`, and **on every non-closing `mem correction`**, which calls
`search.buildIndex(root)` directly (src/cli/commands/write.mjs, the content-loss warning) and never uses the cache: that one is where a cold build is paid again and again,
and a better lever than the normaliser (not built here: it needs the cached index to give the same `docFreq`, which is a question for its own order).

### Changed / Performance - `mem doctor` runs the concurrent-append probe only with `--full` (and `--strict`) and says so when it did not (cli-speed-cm TB7; cheap-mem only)

The probe of `env/append-atomicity` starts six writer threads on the memory's mount and was the slowest single part of a doctor run:
9 fresh processes took 167 to 445 ms for it (median 320 ms), and under load one ran past its own 400 ms limit and reported UNKNOWN anyway.
Without `--full` that one finding now reads `not measured on this run ... only runs with mem doctor --full` at level UNKNOWN, the third state, with
the way to the real answer in its advice; it never reads `ok`. A filesystem whose name is documented as unsafe is still a failure without the probe
(that answer needs no measuring). `--strict` includes the probe, because there an unverifiable guarantee is a failure and the documented CI call
`mem doctor --strict` must not turn red for a check it skipped. `--alarm` lists only errors and no longer measures tearing on every start. The library
default is unchanged: `doctor.checkAll(root)` measures, `checkAll(root, { full: false })` does not; the dashboard and `mem today` still call it as before.
Measured, interleaved against the commit before, child CPU time (wall time on this shared host is too noisy: load 6 to 31),
`mem doctor --quiet`: 300 entries 580 -> 290 ms (-50 %), 1,000 entries 620 -> 350 ms (-44 %), 20,000 entries 1,710 -> 1,450 ms (-15 %). The index was
already loaded once per run (counted: the cache manifest is read once, each document shard once); there was nothing to save there. Tested structurally
(`test/doctor-full.test.mjs`: the probe directory is created 0 times without `--full`, once with it). The output differs in exactly one finding
and in `mem doctor --help`; golden over a 400-entry scratch memory otherwise identical.
Through the real CLI the tests also hold: `--quiet` keeps the "not measured" line and the summary does not count it as good, `--alarm` neither measures nor prints it, and
a documented-unsafe filesystem (driven with a fake `stat` on PATH; skipped on Windows, where such a script is not found) is an error without `--full` and shows in `--alarm`.

### Performance - `mem retrieve` derives the retirements once and reads the log twice (cli-speed-cm TB6; cheap-mem only)

On a 20,000-entry scratch memory (5.2 MB) one `retrieve` took 1,080 ms (7 fresh processes, warm index cache). `retrieve` derived the log's
retirements for its own claims, and `loadIndex` derived them again for the index's retired flags (141 ms each at that size), each
time in three passes over the typed logs. Now `retrieve` derives once and hands the state to the index load
(`loadIndex(root, { derivedState })`; the state is still read from the log in this very call, never stored), and
`retiredMapFromFiles` keeps the few retirement lines (slim copies, not correction bodies) during its first read, so the files are read twice, not
three times. `docSimilarity` takes an optional per-ranking Map of norms (MMR compared the same vectors again and again and normed both in every
comparison; the value is unchanged to the last bit). Measured against the commit before (TB4 only), 15 interleaved runs, medians, load about
5 on 4 cores: 20,000 entries 898 -> 681 ms (-24 %), 5,000 entries 416 -> 355 ms (-15 %), 300 entries 184 -> 184 ms (no gain: below the
size where the log reads matter, which is why the order's threshold decides by size). In process, repeated: 611 -> 455 ms at 20,000. Structurally:
`retrieve` opens the typed logs 12 times instead of 21 on the test world (`test/retrieve-once.test.mjs`, which also counts the norms: 30 instead of 1,800
for 30 vectors compared 900 times). Ranking and claims unchanged: byte-identical `--json` over a 400-entry scratch memory with discards, dones, a supersession,
corrections and a refused (disputed) override, for `retrieve` with `--top`, `--as-of`, `--with-disputed`, `--type`, and for `find`.

### Performance - a CLI start loads the group of its command, not all six (cli-speed-cm TB4; counterpart in lucky-mem open)

`bin/mem` imported the six command groups statically, so `mem version` compiled the code of all 87 handlers to run one. Measured
with a fresh process per run, 21 runs interleaved old/new (median), 1000-entry scratch memory (261 KB), a container at load
about 6 on 4 cores, so the absolute times are high and only the pairs mean something: `mem version` 210 -> 139 ms, `mem --help`
231 -> 127 ms, an unknown command 184 -> 113 ms, `mem inbox new` 213 -> 138 ms, `mem find` 299 -> 247 ms, `mem doctor --quiet`
606 -> 565 ms (the groups it needs were always loaded; the gain there is under 10 percent). Structurally: `version` imports 1 group
instead of 6 (93 modules instead of 158), help and an unknown command import none (61). `src/cli/command-index.mjs` names the
group of each command; `test/cli-lazy-groups.test.mjs` holds the index equal to the six `COMMANDS` tables in both directions and
counts the imported groups per start, not the time. Output byte for byte unchanged (golden over 192 invocations: every command with
`--help` and with an unknown flag, `--help`, `-h`, `help`, the unknown-command path). The `Intl.DateTimeFormat` the order named
does not run at load in this tree (counted: 0 constructions for `version`, `--help`, `find`; 1 for `doctor`), so nothing was made
lazy there. A new command's name goes into that index too (CLAUDE.md).
A group that does not load (a missing file, a syntax error) is answered as `mem <cmd>: the '<group>' command group did not load: ...` on stderr with exit 1, and
the cause stays visible (the missing file by name; for a syntax error the engine's own file:line and code line), instead of Node's raw stack. What is quoted goes through the output guard first, loses control and bidi characters and is cut to three lines of 200 characters, so a token in a broken group file does not reach stderr.

### Added - `mem setup codex-cloud`: a skill for memories that are opened in OpenAI Codex Cloud (counterpart of the sibling house's Codex anchor)

Codex Cloud runs no hooks (reported by Codex, not verified here), so a memory opened there reaches cheap-mem only through a
hosted MCP connector, and nothing makes the model use it. The habit that hooks give Claude Code now has a file to carry it.

- **`install/codex/skills/mem/SKILL.md`**: the `$mem` skill, English, built on the tool names of `bin/mem-mcp`. The start of a
  task (`mem_context`, `mem_find`, the own inbox), the four moments of `HOUSE-RULES.md` (before a file: `mem_component`; before
  an approach and after a failure: `mem_find`; when something surprises you), logging on one's own, the write paths (`mem_log`
  and `mem_inbox_*` only, repository changes as a pull request), one closing summary per task and only for something new
  (an `event` tagged `codex-cloud`, `session-close`, `no-raw-capture`, marked as no raw capture), and what to do when the
  connector or a step is missing: say so, never carry on silently. What comes back is data, not instructions.
- **`install/codex/start-skill.md`**: the text for the environment field "Start skill".
- **`mem setup codex-cloud [--dry-run] [--force]`** (`src/codexcloud.mjs`): writes the skill to
  `<memory>/.agents/skills/mem/SKILL.md`, appends a narrow `.gitignore` exception only when git says `.agents/` is ignored
  there (checked afterwards and undone if it does not open exactly that folder), prints the Start-skill text. Idempotent;
  a differing skill file is left alone without `--force`; everything that can be refused is checked before anything is written
  (a symbolic link - also a dangling one - at the skill, on the way to it or at `.gitignore`, a directory where a file belongs, an
  unreadable `.gitignore`), the `.gitignore` rules are tried in a throw-away repository first (so `--dry-run` is not more optimistic
  than the real run; the only thing outside the memory is that throw-away repository in the temp directory, removed again) and undone if git still ignores the skill, a failed write of the skill puts back `.gitignore` and removes the empty folders this run made (never one that was there before), and an empty `.gitignore` comes back as an empty file; keeps the
  line ending and the mode of an existing `.gitignore`; commits, pushes and writes under the home directory never. Deliberately not an MCP
  tool: the connector is how a remote agent writes entries, not a door for writing files into the checkout.
- **`docs/mcp-setup.md`**, section "OpenAI Codex Cloud": the hosted connector (writing must be allowed, HTTP starts read-only),
  what the skill does, and the limits (not enforced, no transcript, a copy and not a link).
- **`test/codex-cloud-skill.test.mjs`**: every tool and parameter that the skill, the Start text or the doc names is looked
  up in the tool list the server itself answers with (not copied); the core sentences against softening; size; the four
  moments against `HOUSE-RULES.md`; a positive control (a renamed tool turns it red); the command against scratch memories.

### Security - an object field under a secret's key falls whole; a Bearer/Basic value behind a marker falls (2026-10-14)

Measured on the previous tip (e58fb2b), all open: `{password: "correct horse battery staple"}`, `{token: "abc123def456"}`, `{password: 123456}`,
and nested the way the raw capture sees them (`tool_use.input`): `{headers: {Authorization: "Basic ..."}}`, `{env: {API_KEY: "k1"}}`
(`redactObject`, `redactEntry` and `maskEntry` read each string alone, so the key meant nothing); and `Bearer [REDACTED:x]<32 characters>`,
`Bearer [REDACTED:x][REDACTED:y]<32>`, `Basic [REDACTED:x]<value>` (a marker right behind the scheme ended the pattern).

- **Object fields.** One walk (`walkSecrets`, `src/redaction.mjs`) serves the write path (`redactObject`, `redactEntry`: raw capture, every
  logged entry) and the output (`maskEntry`: `mem find`/`show`, the viewer payload, the MCP replies, `mem raw show`, the recall hooks). A string
  under a secret's key is masked whole as `[REDACTED:json-secret]`, however deep the key sits; a number or boolean directly under it too
  (a numeric PIN is a password). The key list is the one of `json-secret` (`JSON_KEY_WORDS`, no second copy), tested anywhere in the key, after
  NFKC and without zero-width characters; for objects the header name `authorization` / `proxy-authorization` is added, exactly. `null`, the empty
  string and a value of markers alone stay (idempotence). The strings below a secret key inherit it (`{secrets: {A: "x"}}`); numbers only where the key
  stands directly over them. **No false alarm on counters:** a counter is a single NUMBER under a counter key: `max_tokens: 4096`,
  `tokens_used: 1234`, `usage.input_tokens`, `"secrets": 120`, `password_length: 12` keep it (`*_count`/`*_limit`/`*_used`/`*_len`/`*_total`/
  `max_*`, or the plural of a keyword; the plural only for a number, which keeps docs/value-report/secrets.json free). A digit STRING
  (`"password_len": "123456"`, `"token_count": "4111 1111 1111 1111"`, `"secrets": "123456"`), a boolean, or a list of numbers
  (`"passwords": [1234, 5678]`) under such a key is a value and falls (review finding 2026-10-14). `token: 1234` and `authToken: 1234` fall. Pagination cursors
  (`nextPageToken`) stay, as in the text rule; a key that runs on long behind its keyword spares a prose string (`token_system_is_a_facade`), as the text
  rule does. `password_hint` is masked (a hint is where the password gets written down). Object-only key words (the text rule is unchanged):
  `pin`, `pwd`, `passcode`, `credential(s)` (the fetch option values `include`/`same-origin`/`omit` stay, whole values only; the counter rule applies:
  `pin_count: 3`, `passcode_length: 6` are free numbers; `pin_number`, `pin_num`, `pin_used` are the pin and fall; upper-case runs are split, `PINCode`, `PWDHash`), and `privateKey`/`accessKey`/`access-key` (camelCase and hyphen match the list; a suffix is
  counted in the key as written, so a camel key is never read looser than its snake form). A key is a counter only if neither the key as written nor its camel-cut form still shows a keyword once the counter
  words are out; a keyword with a capital inside it (`passWord`, `toKen`, `aPIkey`) is a keyword. A whole number of 1e12 and up (card-number length) falls
  even under a counter key. **Linear keys:** a key is read in linear time (a loop replaces `.replace(/[...]+$/, '')`, which was quadratic on a run
  of quotes, equals signs or backslashes: 1.4 s for 50,000 of them, minutes for 1 MB) and a key past 512 characters is a secret in doubt, not read at all.
  Bounded: a cycle ends in `[REDACTED:cycle]`, a depth over 64 or more than 2,000,000 nodes in `[REDACTED:depth]`; no crash.
- **Bearer / Basic / `Authorization: Token`.** One or more markers directly behind the scheme no longer end the pattern; the value after them
  falls, a stump after one or several markers inside the value too. A value of markers alone is no match. `Authorization: Token <value>` is new (header
  name required in front, so prose is not touched).
- **MCP replies that are JSON documents** (`mem_show`) went through the text mask only (`sanitizeForDisplay`): `{"API_KEY": "k1abc"}` stayed in the clear
  on the bridge while the CLI and the viewer masked it. A JSON string is now masked as a document first, then as text.
- **Legacy scan.** `mem raw check` and the doctor's legacy check count the fields this rule masks (`scanObject`), values never shown.

Measured: monotony against the base (every secret fragment masked by e58fb2b is still masked), 60,525 text cases + 60,000 object cases, 0
regressions, 0 idempotence failures; 1 MB shapes linear (`test/redaction-linear.test.mjs`, `test/redaction-object-keys.test.mjs`); corpus
docs/, test/, README.md, CHANGELOG.md (640 files, 15 JSON): no difference. `test/redaction-object-keys.test.mjs`.

### Security - recall server: concurrent starts no longer leave it deaf; a stop takes only its own socket (lucky-mem R3; both houses)

Two recall servers started at the same time: both wrote the key file before `listen`, the loser failed with EADDRINUSE and
removed the key again, and the server that held the socket had no key file - no client could authenticate, the hook fell back
to the direct path for good. Red on the previous tip with two real `bin/mem-recall-server.mjs` processes: 6 of 6 rounds deaf, the
loser exited 1 (the keeper then stays off). Now the key is written only after `listen`, the loser reports `busy` (exit
`BUSY_RC`, the keeper retries), `close()` removes only the socket it recorded by device and inode (an old server no longer
takes a newer one's socket away), and the stale-socket clean-up touches only a socket nobody listens on, never a regular file.
The clean-up looks at the file (device, inode, change time) BEFORE it asks whether anybody listens, pins the dead file's inode with
a hard link in the server's own 0700 directory for the length of the probe (a freed inode number is handed out again at once on
some file systems - measured on ext in this container: 300 of 300 - so device and inode alone cannot tell a new socket from the
dead one), and removes it only if it is still that very file afterwards. Without hard links the change time stands in.
The pinning links of a start that was killed during the probe (`recall.sock.hold.<pid>.<hex>`) are swept at the next start: only that
name, only sockets of the same uid, only for dead pids.

**Operator effect:** a regular file (or directory, or link) where the socket belongs now ends the server's start with exit code 1
(`not started: <path> exists and is not a socket - not touched`) instead of being deleted. The keeper treats exit 1 as a real
start failure and does not restart it, so the recall server stays off until someone moves the file away; the hook meanwhile
searches directly, as without a server. A concurrent second start exits with `BUSY_RC` (76), which the keeper retries.
`test/recall-server-concurrent-cm.test.mjs`.

### Security - the MCP SDK peer range carries the floor the suite runs on (lucky-mem F14)

`peerDependencies["@modelcontextprotocol/sdk"]` is `^1.30.0` (was `^1.0.0`), in `package.json` and the lock's root entry; every
install line names the range, quoted for `cmd.exe`. The request-body limit of the bridge is its own code and does not depend on the
SDK version. `test/mcp-sdk-floor-cm.test.mjs`.

### Security - start-up notice for a door with no token, and a wider list of proxy headers (lucky-mem A14)

A reverse proxy on this machine with no configuration (nginx defaults: connects from 127.0.0.1, `Host` = upstream, no forwarding
header) passes every "is this local" check, so a door with no token serves whoever reaches the proxy, and the bridge with
`CHEAP_MEM_MCP_READONLY=0` lets them write. Nothing is refused (a configured host name without a token is a tested setup), but
the bridge and the viewer now print `NOTICE: no token: anything that reaches this port through a local reverse proxy counts as
local - set a token before putting a proxy in front` at start. The proxy-header detection also covers the families `x-forwarded-*`,
`x-real-*`, `cf-*` and `via`, `true-client-ip`, `cdn-loop`, `fastly-client-ip`, `x-client-ip`, `x-cluster-client-ip`,
`x-original-forwarded-for`: a request with one of them is not local. The notice is printed by `serve()` itself, so `mem serve` shows it as
well as `bin/mem-serve`. `test/service-door-cm.test.mjs`.

### Security - guards for the service doors (lucky-mem A3, A5, A7, A8, A13; no defect found here)

Probes, not fixes: unparseable request targets and headers end neither service, the Host check covers every route of the viewer,
the bridge remembers nothing per process, the body limit is 1 MiB in bytes, and the loopback allow list refuses SIIT/NAT64/6to4
forms. `test/service-door-cm.test.mjs`.

### Dashboard - "For you" is what is owed to the human, and it goes by deadline (2026-10-13)

A duty of the configured human whose card was a replacement card (kind do-it) stood under "Agent work - nothing for you
to decide" on Today, in "Your next look" and in the duties list, because the page grouped by the kind of the card only.
Red in a real Chromium on `eddad97`, then fixed. `test/card-group-browser.test.mjs`.

- **Grouping by addressee.** Each open duty and question of the dashboard data carries `owner` (`human` | `agent` |
  `unassigned`, from the configuration, `cardfeed.ownerKind`; no name in the code). "For you" is everything owed to the
  human, whatever its card; "Agent work" is what is owed to an agent. Owed to nobody: the kind of the card still decides.
  Today lists only what is addressed to the human, so everything there is "For you".
- **By deadline.** "Your next look" (three items) and the duties list order "For you" like the Today card: overdue first,
  then due today, later, then no or an unreadable date in list order. Each open duty carries `dueAt` from the due core
  (`humandecisions.dueAtOf`, in the house zone); the page never reads the due field. Before, the overdue duty was cut
  from the three while one due in thirty days was shown. "Agent work" keeps the list order.
- **Honest hint.** When "Agent work" holds an item owed to nobody (no addressee, or an unknown name, a typo too), the hint
  says "Nobody owns some of these yet" instead of "nothing for you to decide". No third group yet.
- **Open.** The light-theme colour of the group heading reaches only 4.2 to 4.4 : 1 (existing `--quiet`), see
  `docs/dashboard.md`.

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
  value runs to the end of the line behind a quoted key, to the end of the text behind a bare key; the cap of 4096 bounds only
  what is judged (placeholder, prose and suffix exceptions), never how much falls, so masking twice is masking once. Single-quoted values count too (`'password': '...'`, `PASSWORD='...'`). Linear: forward only,
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
  a later line behind a bare key, a whole placeholder (`your password`, `<your password here>`, `${{ secrets.X }}`), a pagination
  cursor. The code-literal guard holds for an unescaped quote only: `{"env":"PASSWORD=\"...\""}` (a command line inside a JSON
  string, the usual shape in a transcript) is a value. Chosen on purpose, and a false alarm in the safe direction: a sentence under
  a quoted secret key falls (`{"token_budget": "ten thousand words per day"}`, `{"password_hint": "..."}`, `{"secret": "see the
  vault"}`, YAML `token: "..."` with a plain word). A bare key whose quote never closes and whose rest of the text is longer than the cap of 4096
  (a stray quote in a long line of prose, `Note: password: "see below. ..."`) is skipped, not masked: it would take the whole rest of the
  text; short, it falls to the end of the text. A bracket value is a placeholder or reference only without a credential-shaped run
  in it (`<Ab3x...>`, `{{Ab3x...}}`, `${{ Ab3x... }}` fall; some of these were open on 7a46a3a already), and a template reference is a
  dotted name, optionally called or piped (`${{ secrets.GITHUB_TOKEN }}`, `{{ lookup('env','X') }}`). `${{ horse battery staple }}` is
  NOT a reference (words, no name or call), so it falls: indistinguishable from a phrase secret, and the safe direction. The gaps these
  leave: a passphrase of twelve plain words behind a bare key; a phrase behind a key with a long suffix; a kebab key (`secret-value`)
  needs a credential-shaped value, as before.
- **Not covered, named** (the next order builds the key words and the object fields; none of it is new, all of it was open on 7a46a3a):
  Unicode quotation marks and `&quot;` as the quote; YAML block values (`password: |`); a raw line break inside a value; key words
  that are not in the list (`pwd`, `pin`, `passcode`, `credentials`, `authorization`, `kennwort`, `passwort`); and object fields
  without a key context: `redactObject`, `redactEntry` and `maskEntry` look at each string alone, so `{password: "..."}` as a REAL
  field is not masked (the raw capture of `tool_use.input` in `src/raw.mjs` is the main case); only a key written in the text is.
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
