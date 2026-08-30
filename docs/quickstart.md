# Quickstart

Get a working cheap-mem in ~5 minutes.

## 1. Install the tool

```bash
git clone https://github.com/Luckyno777/cheap-mem ~/cheap-mem
cd ~/cheap-mem && npm install
```

Optional: symlink so `mem` is on your PATH.
```bash
sudo ln -s ~/cheap-mem/bin/mem     /usr/local/bin/mem
sudo ln -s ~/cheap-mem/bin/mem-mcp /usr/local/bin/mem-mcp
```

## 2. Create your memory

```bash
mkdir ~/my-memory && cd ~/my-memory
mem init
```

That writes `.mem/config.json`, `FACTS.md`, and skeleton directories.

By default there are three participants: `user`, `session`, `librarian`.
Customize with `mem init --participants me,my-agent,helper`.

## 3. Tell this install who it is

```bash
mem whoami user
```

The choices come from `.mem/config.json` → `participants`.

## 4. Put it under git

```bash
git init
git add -A && git commit -m "init cheap-mem"
git remote add origin git@github.com:<you>/my-memory.git
git push -u origin main
```

**Use a private repo.** Your memory belongs to you.

## 5. Edit FACTS.md

Put things a session should know without asking:

```markdown
# FACTS
- Name: Jane
- Timezone: Europe/Berlin
- Editor: neovim
- Preferred JS runtime: node 22 (never bun)
```

Keep it short. Everything else lives in the JSONL logs.

## 6. Use it during a session

Log substantial things:
```bash
mem log event    --title "shipped auth flow" --tags auth,shipped
mem log decision --topic memory-backend --choice sqlite --why "smaller than postgres"
mem log error    --class flake --title "CI timed out on test/e2e/*" --text "reproduced locally"
```

Search:
```bash
mem find "auth"
mem find "flake" --since 7d
mem find "sqlite" --type decision
```

Session start dump:
```bash
mem context
```

## 7. Send a message to another session

```bash
mem inbox write --as user --to librarian --subject "please update FACTS.md" <<'EOF'
Add: preferred deploy target is Fly.io (moved from Vercel last week).
EOF
git add -A && git commit -m "inbox: FACTS update ask" && git push
```

The librarian on any of your machines will see it via `mem inbox watch`
and act on it (see [docs/install-linux.md](install-linux.md) or
[install-macos.md](install-macos.md) to set up the auto-runner).

## 8. Wire your AI

See [docs/mcp-setup.md](mcp-setup.md) for per-model setup:
- Claude Code / Claude Desktop / Cursor: MCP
- Gemini CLI / Mistral CLI / OpenAI codex: shell integration

## Next steps

- [Install the watcher on macOS](install-macos.md)
- [Install the watcher on Linux](install-linux.md)
- [Wire into your AI (MCP setup)](mcp-setup.md)
- [Design notes](design.md)
