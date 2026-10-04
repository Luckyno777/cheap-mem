# cheap-mem — for AI assistants working on this repo

This is the source code for cheap-mem itself. It is NOT a memory
installation — it is the tool that creates memories.

## What lives where

- `bin/mem`            — the CLI's entry point (Node, ESM, no dependencies):
                         argument pre-scan, the merge of the six command
                         groups, dispatch. About 232 lines, and it stays
                         that way — a handler that lands back in here
                         belongs in its group. It was 4503 before the
                         split on 2026-09-18, the largest file here.
- the CLI's own modules, under `src/cli/`:
  - `commands/`        — the 85 handlers, in six groups cut by the
                         QUESTION a command answers: write, search,
                         capture, agents, setup, admin
  - `shell.mjs`        — what holds across commands: arguments, output,
                         refusal, finding the root, knowing who writes
  - `display.mjs`      — how handlers print, and how `--as-of` is read
  - `githook.mjs`      — installing the pre-commit hook, proving it fires
  - `appointments.mjs` — the words around `mem appointment <sub>`
- `bin/mem-mcp`        — MCP server (uses `@modelcontextprotocol/sdk`)
- `bin/mem-serve`      — the dashboard server behind `mem serve` (the only UI;
                         writes from the page are off unless allowed)
- `bin/mem-watch`      — Bash poller (systemd/launchd wrap this); also ticks
                         the appointment clock
- `bin/mem-retrieve`, `bin/mem-before-edit`, `bin/mem-after-failure`,
  `bin/mem-subagent-start` — the recall hooks (each with a `.ps1` twin)
- `bin/mem-release`    — the release rail for a service install
- `bin/mem-reflect`    — Stop-hook style transcript reflector
- `bin/mem-handle-post`— default AI handler for new inbox mail
- `src/config.mjs`     — `.mem/config.json` reader/writer, `findRoot()`
- `src/memory.mjs`     — JSONL logs (append-only)
- `src/inbox.mjs`      — file-based cross-session inbox
- `shared/`            — the finding map, calculation and invariant registers
                         the benches and the doctor read
- `bench/`             — measurements and guards (`npm run verify`,
                         `bench/readme-numbers.mjs`, `bench/parity.mjs`)
- `eval/`              — the paired model evaluation (see `eval/README.md`)
- `hooks/`             — the repository's own git hooks (pre-commit, pre-push)
- `install/`           — macOS, Linux, Windows and Claude Code installers,
                         the `mem serve` service installer, and `hooks/`
- `test/*.test.mjs`    — node:test suites (run: `node --test test/*.test.mjs`)
- `docs/`              — English user docs

## Design commitments (do NOT break)

1. **Append-only.** No function may modify an existing JSONL line.
   Corrections go through `memory.correctionEntry()` which writes a new
   line with `replaces_id`.
2. **Three states.** Reads distinguish missing / empty / broken. Never
   collapse to `[]` on failure.
3. **Config-driven participants.** No participant names are hardcoded
   in `src/`. All names come from `.mem/config.json`.
4. **No workspace-trust dependencies.** The Claude Code installer
   writes to `~/.claude/`, not repo-scoped settings.
5. **The watcher's poll never `git pull`s.** Only `git fetch` + `git ls-tree`
   against the remote. Otherwise it fights builders for the working tree.
   Only the handler step after new mail runs `git pull --ff-only`
   (`bin/mem-watch`).
6. **Reflector has an anti-recursion env.** `MEM_HEADLESS=reflector` (or
   `watcher`) makes the Stop hook skip itself, else infinite loop.

## When you change something

- Update tests. `node --test test/*.test.mjs` must be green.
- A commit that changes `src/` or `bin/` carries a trailer line
  `Parity: lm=yes|no|open` (is the counterpart in the sibling house built,
  deliberately not built, or pending). `test/parity-gate.test.mjs` checks it
  is present; `node bench/parity.mjs` counts it (BUILDING.md, rule 17).
- A new environment variable goes into `src/envregister.mjs` and into
  `docs/environment-variables.md` (`mem envvars --markdown` prints the table;
  a test compares the two).
- Numbers in `README.md` come from `bench/readme-numbers.mjs`; do not type
  them by hand: `node bench/readme-numbers.mjs --write` pulls them forward
  (`test/readme-numbers.test.mjs`).
- Everything shipped is English (`test/english-ratchet.test.mjs`).
- Update `README.md` if a user-facing surface changed.
- Update `docs/` for the affected client.
- Do not rename `.mem/config.json` — old memories exist.

## When you add a new subcommand

1. Add the handler in the matching group under `src/cli/commands/`.
2. Add the tool to `bin/mem-mcp` (`TOOLS` array + `handleCall` switch).
3. Add tests.
4. Update README.md commands table and `docs/quickstart.md` if user-facing.

## Testing without polluting the user's memory

```bash
export CHEAP_MEM_ROOT=/tmp/cheap-mem-scratch
mkdir -p $CHEAP_MEM_ROOT
node bin/mem init
# ... your tests ...
rm -rf $CHEAP_MEM_ROOT
```

Never test against the user's real memory.
