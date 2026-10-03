# Quickstart

Get a working cheap-mem in ~5 minutes.

## 1. Install the tool

```bash
git clone https://github.com/Luckyno777/cheap-mem ~/cheap-mem
cd ~/cheap-mem       # nothing to npm install — the core has no dependencies
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
Customize with `mem init --participants me,my-agent,helper` — the first
name given (`me` above) is marked as **the human**; name a different one
with `--human`, e.g. `mem init --participants me,my-agent,helper --human me`.

That mark (`"human": true` on one participant in `.mem/config.json`) is
what the dashboard's inbox tray and its reply form (`mem serve`) use to
find you — never a hardcoded name, so renaming your participant later
is safe as long as the mark moves with it:

```json
"participants": {
  "me": { "role": "The human.", "human": true },
  "my-agent": "..."
}
```

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

A project is created once, before anything is logged into it
(`--project <unknown>` is refused rather than creating a half-made
directory):
```bash
mem project new garden --title "Garden planning" --reason "came up in three sessions"
mem project confirm garden          # a person, once, after a look
mem project suggestions             # dry run: which topics look like a project
mem log decision --project garden --topic beds --choice raised --why "drainage"
```
`mem project new` names the existing project when your name is too like
one (or like a topic alias) — use that one. For a quick skeleton with no
checks, `mem project init <name>` still exists.

Topics can be grouped under categories, a layer above them. A fresh
memory has none; make your own or adopt a neutral starter list:
```bash
mem category create --suggested     # coding, design, testing, operations, ...
mem category create beekeeping "Beekeeping"
mem category initial-assign --write # keyword rules PROPOSE a category per topic
mem category open                   # proposals, unassigned topics, new categories
mem category confirm --all-proposals
mem find "kiln" --category design   # search inside one category
```
Entries are never changed; the layer is four append-only files under
`global/`. The digest may propose a category for a new topic
(`mem log ... --category <key>`); a brand-new category only comes into
being when three different topics were proposed it independently, and
a person confirms, renames or merges it (`mem category --help`).

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
mem inbox write --as user --to librarian --intent request --subject "please update FACTS.md" <<'EOF'
Add: preferred deploy target is Fly.io (moved from Vercel last week).
EOF
mem inbox permit <the file name it printed> --authority user
git add -A && git commit -m "inbox: FACTS update ask" && git push
```

A request wakes the librarian's watcher (a paid model run) only with
your permission: `mem inbox permit` for one message, or a budget with
`mem inbox allow --letters N --authority user`. A message without
`--intent request` is information: it is read at the next pickup and
never starts a model on its own.

The librarian on any of your machines will see it via `mem inbox watch`
and act on it (see [docs/install-linux.md](install-linux.md) or
[install-macos.md](install-macos.md) to set up the auto-runner).

## 8. Wire your AI

See [docs/mcp-setup.md](mcp-setup.md) for per-model setup:
- Claude Code / Claude Desktop / Cursor / OpenAI Codex CLI: MCP
- Gemini CLI / Mistral CLI: shell integration

## Next steps

- [Install the watcher on macOS](install-macos.md)
- [Install the watcher on Linux](install-linux.md)
- [Wire into your AI (MCP setup)](mcp-setup.md)
- [Design notes](design.md)
