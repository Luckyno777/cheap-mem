# Design notes

## What cheap-mem is (and is not)

cheap-mem is **a directory layout plus a git repo plus 500 lines of glue**.
The design is the file structure and the append-only discipline. The
JavaScript is thin — you could rewrite it in Python or Rust in an
afternoon and nothing would change.

It is *not* a database, a vector store, an embedding pipeline, or a
"second brain" app. It is not designed to be searched semantically.
Substring search + tags + human-edited YAML snapshots have carried a
year of real use so far. If you need vectors, wire them alongside; the
JSONL logs are trivial to index.

## Why git, not SQLite

- **Sync is free.** `git pull` is your cross-device sync. No server.
- **Merge is meaningful.** Two sessions can write in parallel; git
  reconciles append-only lines cleanly.
- **History is auditable.** Every change is a commit. Reasoning survives.
- **Backups are free.** GitHub, GitLab, self-hosted — all work.
- **AI can push and pull.** Every model that touches a shell can
  interact with your memory.

## Append-only, always

A log entry is never modified. If it turns out wrong, `mem correction`
writes a new line with `replaces_id: <old-id>`. The wrong line stays
visible. Deleting the past looks tidy but hides bugs in the process.

## Three states, never two

Empty inbox ≠ no inbox ≠ remote unreachable. A watcher that returns
"nothing new" when the remote is down is worse than one that returns
"unknown, tried". Every read function distinguishes:
- state A: does not exist
- state B: exists and is empty
- state C: exists and has content

## The inbox format

Five-line header, blank line, body. Nothing in the body can retroactively
change the header (the blank line is the only separator, and body
content that looks like a header is text, not fields). Filename encodes
time + sender + recipient so `ls` is the overview.

## The watcher (poll, don't push)

```
git fetch origin main --quiet
git ls-tree -r --name-only origin/main inbox/
```

Never `git pull`. The watcher lives outside the working tree so it
cannot fight a builder for `HEAD`. Exit code 0/1/3 (nothing / new /
unreachable). Shell-friendly.

## The reflector (throttled Stop hook)

The Stop hook fires after every assistant turn. Firing a fresh model
run each time is expensive. Throttle: only actually run when the
transcript has grown by ≥ 400KB (~100k tokens) since the last reflect.
Marker file per transcript. The threshold is the one setting we tuned;
smaller and the model gets called on trivial edits, larger and it
misses a long context.

## Why the inbox lives IN the memory repo

You might think a separate "messages" repo would be cleaner. In practice:
- One `git push` moves everything.
- One `git log` shows the whole conversation.
- The watcher only needs one remote.
- Backups are one repo.

## Why there's no encryption

Because your memory belongs on a private git remote and git has no
mainstream encryption story. If you need field-level encryption, add it
around `mem log` — it's a shell wrapper away. But the honest advice is:
use a private repo, don't put secrets in.

## What we ported from lucky-mem

- The 4-log JSONL taxonomy (decisions/errors/events/timeline)
- The 5-field inbox header with body-forgery resistance
- The watcher's poll-without-pull mechanism
- The reflector's byte-delta throttle
- The subshell FD isolation for lock files
- The "three states never two" discipline

## What we left out (yet)

- Windows install script (contributions welcome)
- The bibliothekar's "PROMPT.md" curator role (application-specific)
- The `mem post ich` dedup memory (still there, but simplified)
- Vector / embedding search (fine to add on top of the JSONL)
- Multi-remote / conflict-avoidance mechanics (not needed at 1 user)

## Where the tokens go

Ballpark for a 20-turn session that logs ~5 events:

| pattern              | prompt tokens per turn | notes |
|----------------------|-----------------------:|-------|
| Obsidian in-context  | 15k–40k                | whole vault in system prompt |
| RAG second-brain     | 5k–15k                 | top-N docs per turn |
| cheap-mem            | 400–1200               | FACTS.md + context + on-demand `mem find` |

Numbers vary wildly with vault size. The point is the shape: cheap-mem
is a small constant plus what you actually asked for.
