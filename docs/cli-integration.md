# CLI integration (for models without MCP)

Gemini CLI, Mistral CLI, and any other AI shell client can use cheap-mem
by calling the `mem` binary directly. No protocol needed — a shell tool
is enough.

## The contract

Give the model these commands and its cwd or PATH-visible `mem`:

```
mem context                              # session start dump
mem find "<pattern>"                     # look before you ask
mem log <type> --<field> <value> ...     # write when something happens
mem inbox new                            # any messages for me?
mem inbox write --to <name> --subject ... < body.md
```

Types: `decision`, `error`, `event`, `timeline`.

## System-prompt block you can drop in

```
You have access to a persistent memory via the `mem` CLI in your shell.
- Start: run `mem context` once to see recent errors, decisions, events.
- Before referencing a project/person/tool: `mem find "..."` — do not ask
  the user things you can look up.
- After a decision, error, or notable event: `mem log <type> --title "..." ...`
- To pass work to another session: `mem inbox write --to librarian --subject "..." < body.md`
  then `git add . && git commit -m "..." && git push`.

Memory root: <absolute path>
```

## Example — Gemini CLI

```bash
CHEAP_MEM_ROOT=~/my-memory gemini \
  --system "$(cat ~/cheap-mem/docs/system-prompt.txt)" \
  "help me pick a state manager"
```

The model reads `mem context`, sees you already decided on Zustand three
months ago (`mem find "state manager"`), and skips the whole discussion.

## Example — Mistral CLI

```bash
CHEAP_MEM_ROOT=~/my-memory mistral \
  --system-file ~/cheap-mem/docs/system-prompt.txt \
  chat
```

## Auto-log with a shell hook

Wrap your shell (bash/zsh):

```bash
# ~/.bashrc
mem-here() {
  CHEAP_MEM_ROOT=~/my-memory node ~/cheap-mem/bin/mem "$@"
}
alias mem=mem-here
```

Then every session that types `mem …` writes into the same memory.

## What's NOT worth doing

- **Do not** try to embed the full memory in the model prompt. That is
  exactly the pattern cheap-mem exists to replace.
- **Do not** put secrets in the memory. It is a git repo — treat it that way.
