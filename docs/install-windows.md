# Install on Windows

Two paths — pick the one that matches your setup.

## Path A: WSL2 (recommended)

If you already run Linux tooling under WSL2, use the Linux path — it
works unchanged.

```bash
# inside your WSL2 distro
git clone https://github.com/Luckyno777/cheap-mem ~/cheap-mem
cd ~/cheap-mem && npm install

mkdir ~/my-memory && cd ~/my-memory
node ~/cheap-mem/bin/mem init
node ~/cheap-mem/bin/mem whoami librarian
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:<you>/my-memory.git
git push -u origin main

CHEAP_MEM_ROOT=~/my-memory MEM_WATCH_WHO=librarian \
  bash ~/cheap-mem/install/linux.sh

sudo loginctl enable-linger $USER   # survive logout
```

Windows-side Claude Desktop wiring: see the MCP config in
[mcp-setup.md](mcp-setup.md) — point it at `\\wsl$\<distro>\home\<user>\cheap-mem\bin\mem-mcp`.

## Path B: Native PowerShell

For users without WSL2, or who want everything native.

### Prerequisites

- **Node.js 18+** for Windows (from nodejs.org or `winget install OpenJS.NodeJS.LTS`)
- **Git for Windows**
- **PowerShell 5.1+** (built-in) or **PowerShell 7** (`winget install Microsoft.PowerShell`)

### Install cheap-mem

```powershell
git clone https://github.com/Luckyno777/cheap-mem $HOME\cheap-mem
cd $HOME\cheap-mem
npm install
```

### Create your memory

```powershell
mkdir $HOME\my-memory
cd $HOME\my-memory
node $HOME\cheap-mem\bin\mem init
node $HOME\cheap-mem\bin\mem whoami librarian
git init
git add -A
git commit -m "init cheap-mem"
git remote add origin git@github.com:<you>/my-memory.git
git push -u origin main
```

### Install the watcher + Claude wiring

```powershell
$env:CHEAP_MEM_ROOT = "$HOME\my-memory"
$env:MEM_WATCH_WHO  = "librarian"
powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\cheap-mem\install\windows.ps1
```

That does three things:

1. **Registers a Scheduled Task** `cheap-mem-watch` — runs
   `bin/mem-watch.ps1` at logon, restarts once a minute on failure.
2. **Wires Claude Desktop** — merges the MCP server config into
   `%APPDATA%\Claude\claude_desktop_config.json`. Restart Claude Desktop
   to pick it up.
3. **Wires Claude Code** — drops PowerShell hooks into
   `%USERPROFILE%\.claude\hooks\` (`cheap-mem-session-start.ps1`,
   `cheap-mem-session-stop.ps1`) and merges hook + permission entries
   into `%USERPROFILE%\.claude\settings.json`.

You can skip individual pieces:
```powershell
# only wire Claude Desktop, don't touch the scheduler or Claude Code:
powershell -File install\windows.ps1 -SkipTask -SkipClaudeCode
```

### Verify

```powershell
Get-ScheduledTask -TaskName cheap-mem-watch
Get-Content "$HOME\my-memory\.mem\watch.log" -Tail 20 -Wait
```

You should see a `[UTC-time] watcher awake` line within seconds.

### Common Windows gotchas

- **Execution policy.** The install script uses
  `-ExecutionPolicy Bypass` per-invocation so you don't need to change
  your machine-wide policy.
- **Node on PATH.** The scheduled task inherits your user PATH. If Node
  is only on the system PATH, add it to user PATH too (or use
  `[Environment]::SetEnvironmentVariable('PATH', ..., 'User')`).
- **AV / EDR flagging PowerShell watchers.** A background PowerShell
  loop can trip aggressive endpoint tooling. Whitelist
  `<repo>\bin\mem-watch.ps1`.
- **Long paths.** If your memory root has spaces or is deeper than
  ~200 chars, wrap it in double-quotes in every command and enable long
  paths (`git config --global core.longpaths true`).

### Uninstall

```powershell
# stop and remove the scheduled task
Unregister-ScheduledTask -TaskName cheap-mem-watch -Confirm:$false

# remove Claude Code hooks
Remove-Item $HOME\.claude\hooks\cheap-mem-session-*.ps1

# unset user env
[Environment]::SetEnvironmentVariable('CHEAP_MEM_ROOT', $null, 'User')
[Environment]::SetEnvironmentVariable('MEM_WATCH_WHO',  $null, 'User')

# remove Claude Desktop MCP entry: edit %APPDATA%\Claude\claude_desktop_config.json manually
```

## Customize the handler

The default handler spawns `claude -p`. To use a different CLI:

```powershell
# set for the current user (task inherits on next start)
[Environment]::SetEnvironmentVariable('MEM_HANDLER_CMD', 'gemini -p', 'User')
Stop-ScheduledTask  -TaskName cheap-mem-watch
Start-ScheduledTask -TaskName cheap-mem-watch
```

## Which path to pick

- You have WSL2 already → **Path A**. Fewer moving parts, same tooling
  as Linux, Windows Claude Desktop can still reach it over `\\wsl$\`.
- You don't want WSL2 or need everything native → **Path B**. Fully
  native, no cross-boundary calls, uses Windows Task Scheduler.
