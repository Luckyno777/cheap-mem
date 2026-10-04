# Install on macOS

## Prerequisites

- Node.js 18+ (`brew install node` or fnm/nvm)
- git 2.x
- A private git remote for your memory

## Install cheap-mem

```bash
git clone https://github.com/Luckyno777/cheap-mem ~/cheap-mem
cd ~/cheap-mem       # nothing to npm install — the core has no dependencies
```

## Create your memory

```bash
mkdir ~/my-memory && cd ~/my-memory
node ~/cheap-mem/bin/mem init
node ~/cheap-mem/bin/mem whoami librarian
git init && git add -A && git commit -m "init cheap-mem"
git remote add origin git@github.com:<you>/my-memory.git
git push -u origin main
```

## Install the watcher (launchd)

```bash
CHEAP_MEM_ROOT=~/my-memory MEM_WATCH_WHO=librarian \
  bash ~/cheap-mem/install/macos.sh
```

That writes `~/Library/LaunchAgents/com.cheap-mem.watch.plist` and
starts the service. The watcher:

- Polls the remote every 15s via `git ls-tree` (no `git pull`)
- On new inbox mail, pulls and runs `bin/mem-handle-post`
- Auto-restarts on failure (`KeepAlive` in launchd)
- Starts at login

### Check it

```bash
launchctl print gui/$(id -u)/com.cheap-mem.watch | head -20
tail -f ~/my-memory/.mem/watch.log
```

### Stop it

```bash
launchctl bootout gui/$(id -u)/com.cheap-mem.watch
```

### Remove it

```bash
launchctl bootout gui/$(id -u)/com.cheap-mem.watch
rm ~/Library/LaunchAgents/com.cheap-mem.watch.plist
```

## Wire Claude Code to it

```bash
CHEAP_MEM_ROOT=~/my-memory bash ~/cheap-mem/install/claude-code.sh
```

That drops hooks into `~/.claude/hooks/` and merges permissions into
`~/.claude/settings.json`. Every subsequent Claude Code session on this
Mac will:

- Print `FACTS.md` + `mem context` at start (and whatever `mem doctor --alarm`
  finds down right now)
- Recall matching memory on every message, before a file is edited, after a
  failed tool call and when a subagent starts — no model call
- Capture the transcript at Stop, model-free; the model-backed reflector
  runs only with `MEM_REFLECT=1`

The seven hooks, and what each one does, are listed in the README under
"Claude Code (hooks + MCP)".

## Wire Claude Desktop / Cursor / Continue

See [mcp-setup.md](mcp-setup.md).

## Customize the handler

The default `mem-handle-post` spawns `claude -p`. To use a different
model (Gemini, Mistral, etc.):

```bash
launchctl setenv MEM_HANDLER_CMD "gemini -p"
launchctl kickstart -k gui/$(id -u)/com.cheap-mem.watch
```

Or edit the plist directly.


## Optional: `mem serve` as a service (dashboard + warm recall)

`install/macos.sh` asks at the end whether to also run `mem serve` as a
user service; the default is **no** (a non-interactive run never installs
it; `CHEAP_MEM_SERVE_SERVICE=yes|no` answers without a prompt). By hand:

```bash
CHEAP_MEM_ROOT=~/my-memory bash install/serve-service.sh install    # ~/Library/LaunchAgents/com.cheap-mem.serve.plist
bash install/serve-service.sh uninstall                             # boots it out and removes the agent
```

Recall works without it; the service only makes it warm (see
`docs/dashboard.md`, "Warm recall").
