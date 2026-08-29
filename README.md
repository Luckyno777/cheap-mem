# cheap-mem

> Cheap in tokens, rich in memory.

A local-first, git-backed persistent memory layer for AI coding assistants.
Works with **Claude Code**, **Claude Desktop**, **Cursor**, **ChatGPT**, **Gemini**,
**Mistral**, and any other model that speaks a shell or MCP.

Your memory is a directory of small text files in a git repo you own.
Cross-device sync is `git pull`. Cross-session messaging is `git push`.

## Why "cheap"?

Second-brain-in-context patterns (Obsidian-style dumps, RAG-heavy setups)
push the same big blob into every prompt. cheap-mem does the opposite:

- A **tiny always-loaded facts file** (~100 lines max)
- A **compact context dump** at session start (~20 recent items)
- **Append-only JSONL logs** searched on demand — never streamed in full
- **File-based inbox** — one 5-line header + body, pulled only when needed

Rough measurements against a full Obsidian-in-context pattern:
**~80–95% fewer tokens per session** for the same working recall.

## What lives where

```
your-memory/
  .mem/config.json         participants, defaults    (created by `mem init`)
  FACTS.md                 always-loaded facts       (~100 lines)
  global/
    facts.yaml             stable facts (YAML)
    people.yaml            people directory
    decisions.jsonl        append-only decision log
    errors.jsonl           append-only error log
    events.jsonl           append-only event log
    timeline.jsonl         append-only timeline
  projects/<name>/         same shape, per project
  inbox/                   messages between sessions (git-synced)
```

## Quickstart

```bash
git clone https://github.com/Luckyno777/cheap-mem ~/cheap-mem
cd ~/cheap-mem && npm install

# Create your memory
mkdir ~/my-memory && cd ~/my-memory
node ~/cheap-mem/bin/mem init
node ~/cheap-mem/bin/mem whoami user

# Put it under git and push somewhere private
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:you/your-memory.git
git push -u origin main

# Log something
node ~/cheap-mem/bin/mem log event --title "started using cheap-mem" --tags setup
node ~/cheap-mem/bin/mem context
```

## Autostart on macOS / Linux / Windows

Have the librarian watcher run at login and restart on failure:

**macOS (launchd)**
```bash
CHEAP_MEM_ROOT=~/my-memory MEM_WATCH_WHO=librarian \
  bash ~/cheap-mem/install/macos.sh
```

**Linux (systemd user)**
```bash
CHEAP_MEM_ROOT=~/my-memory MEM_WATCH_WHO=librarian \
  bash ~/cheap-mem/install/linux.sh
```

**Windows (Task Scheduler)** — [install-windows.md](docs/install-windows.md)
```powershell
$env:CHEAP_MEM_ROOT="$HOME\my-memory"; $env:MEM_WATCH_WHO="librarian"
powershell -File $HOME\cheap-mem\install\windows.ps1
```

The watcher polls the git remote every 15 seconds via `git ls-tree`
(never `git pull` — never fights a builder for the working tree).
When new inbox mail lands, it pulls and runs the handler.

## Wire into your AI

### Claude Code (hooks + MCP)

```bash
CHEAP_MEM_ROOT=~/my-memory bash ~/cheap-mem/install/claude-code.sh
```

This drops a SessionStart hook (prints `FACTS.md` + context) and a
Stop hook (byte-delta throttled reflector) into `~/.claude/hooks/`, and
merges the needed permissions into `~/.claude/settings.json`.

For MCP tools also:
```bash
claude mcp add cheap-mem --scope user \
  --env CHEAP_MEM_ROOT=~/my-memory \
  -- node ~/cheap-mem/bin/mem-mcp
```

### Claude Desktop / Cursor / any MCP-capable client

Add to the client's `mcp_servers` config:
```json
{
  "mcpServers": {
    "cheap-mem": {
      "command": "node",
      "args": ["/absolute/path/to/cheap-mem/bin/mem-mcp"],
      "env": { "CHEAP_MEM_ROOT": "/absolute/path/to/your-memory" }
    }
  }
}
```

See [docs/mcp-setup.md](docs/mcp-setup.md) for per-client instructions.

### CLI-only models (Gemini, Mistral, ChatGPT via `codex`, etc.)

Point the model at `~/cheap-mem/bin/mem` and tell it the commands.
No MCP needed — a shell tool is enough. See [docs/cli-integration.md](docs/cli-integration.md).

## Design principles

- **Append-only.** A log entry is never modified. Corrections write a
  new line with `replaces_id`. Deleting the past is worse than being wrong.
- **Three states, never two.** No config vs. valid config vs. broken.
  Empty inbox vs. no inbox vs. remote unreachable. A "no" that looks
  like "nothing" is worse than any real error.
- **The tool is small on purpose.** ~500 lines of JS. The system is the
  file layout and the rules — the code is the thin glue.
- **No hardcoded names.** Participants, branch, remote — all in
  `.mem/config.json`. cheap-mem does not assume anyone is called anything.

## Commands

```
mem init                                one-time setup
mem whoami [<name>]                     who this install is in the channel

mem log <type> --<field> ...            append a JSONL entry
mem find "<pattern>" [--type T]         substring search across logs
mem context [--n 20]                    compact recent-activity dump
mem project init <name>                 idempotent project skeleton
mem correction <type> <old-id> ...      append correction linked to old entry

mem inbox new  [--as N]                 what is new for me
mem inbox all  [--as N]                 all messages to me
mem inbox write --to N --subject ...    send a message
mem inbox show <name>                   read one message
mem inbox ack  <name> [state]           set state (replied|processed|closed)
mem inbox watch --as N                  poll remote (exit 0/1/3 for shells)

mem version
```

## License

MIT — see [LICENSE](LICENSE).

## Origin

Ported from the private `lucky-mem` design that has been running under
continuous use since summer 2026. The port is generic, English, and
adds `mem init`, launchd/systemd install scripts, and the MCP server.
