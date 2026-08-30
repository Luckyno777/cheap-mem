# Install on Linux

## Prerequisites

- Node.js 18+
- git 2.x
- systemd (any recent distro)
- A private git remote for your memory

## Install cheap-mem

```bash
git clone https://github.com/Luckyno777/cheap-mem ~/cheap-mem
cd ~/cheap-mem && npm install
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

## Install the watcher (systemd --user)

```bash
CHEAP_MEM_ROOT=~/my-memory MEM_WATCH_WHO=librarian \
  bash ~/cheap-mem/install/linux.sh
```

That writes `~/.config/systemd/user/cheap-mem-watch.service`, enables
it, and starts it. The watcher:

- Polls the remote every 15s via `git ls-tree`
- On new inbox mail, pulls and runs `bin/mem-handle-post`
- `Restart=always` — survives crashes
- Starts at login

### Survive logout / start on boot

By default, `--user` units stop when your last login session ends. To
have the watcher run without an active session:

```bash
sudo loginctl enable-linger $USER
```

### Check it

```bash
systemctl --user status cheap-mem-watch
tail -f ~/my-memory/.mem/watch.log
```

### Stop / remove

```bash
systemctl --user stop cheap-mem-watch
systemctl --user disable cheap-mem-watch
rm ~/.config/systemd/user/cheap-mem-watch.service
```

## Wire Claude Code to it

```bash
CHEAP_MEM_ROOT=~/my-memory bash ~/cheap-mem/install/claude-code.sh
```

Every subsequent Claude Code session on this box will:

- Print `FACTS.md` + `mem context` at start
- Run the reflector (byte-delta throttled) at Stop

## Wire other MCP clients

See [mcp-setup.md](mcp-setup.md).

## Customize the handler

The default `mem-handle-post` spawns `claude -p`. To use a different
model:

```bash
systemctl --user edit cheap-mem-watch
# add under [Service]:
#   Environment=MEM_HANDLER_CMD=gemini -p
systemctl --user restart cheap-mem-watch
```

## Container / server / no-desktop hosts

`systemd --user` needs a user manager. If you're on a bare server:

```bash
sudo loginctl enable-linger $USER
# reconnect once, then the unit runs without a login shell.
```

Or install as a system service instead (write the unit to
`/etc/systemd/system/cheap-mem-watch.service`, run it as your user via
`User=`). Left as an exercise.
