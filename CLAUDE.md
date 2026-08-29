# cheap-mem — for AI assistants working on this repo

This is the source code for cheap-mem itself. It is NOT a memory
installation — it is the tool that creates memories.

## What lives where

- `bin/mem`            — the CLI (Node, ESM, ~500 lines)
- `bin/mem-mcp`        — MCP server (uses `@modelcontextprotocol/sdk`)
- `bin/mem-watch`      — Bash poller (systemd/launchd wrap this)
- `bin/mem-reflect`    — Stop-hook style transcript reflector
- `bin/mem-handle-post`— default AI handler for new inbox mail
- `src/config.mjs`     — `.mem/config.json` reader/writer, `findRoot()`
- `src/memory.mjs`     — JSONL logs (append-only)
- `src/inbox.mjs`      — file-based cross-session inbox
- `install/*.sh`       — macOS + Linux + Claude Code installers
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
5. **The watcher never `git pull`s.** Only `git fetch` + `git ls-tree`
   against the remote. Otherwise it fights builders for the working tree.
6. **Reflector has an anti-recursion env.** `MEM_HEADLESS=reflector` (or
   `watcher`) makes the Stop hook skip itself, else infinite loop.

## When you change something

- Update tests. `node --test test/*.test.mjs` must be green.
- Update `README.md` if a user-facing surface changed.
- Update `docs/` for the affected client.
- Do not rename `.mem/config.json` — old memories exist.

## When you add a new subcommand

1. Add the handler in `bin/mem`.
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
