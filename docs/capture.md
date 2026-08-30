# Capture and digest

Two lanes, and only one of them costs anything.

## Lane 1 — capture (no model)

A Stop hook copies the growth of the session transcript into the
memory: redacted, gzipped, incremental. Nothing decides what is
important, because deciding is the expensive part and it can wait.

### Wiring it up

**Claude Code / Claude Desktop** — in `~/.claude/settings.json`:

```json
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command",
    "command": "bash ~/cheap-mem/bin/mem-capture" }] }]
}
```

**Windows** — the same, pointing at the PowerShell port:

```json
"command": "powershell -NoProfile -File C:\\path\\to\\cheap-mem\\bin\\mem-capture.ps1"
```

Check it with `mem doctor`: the `stop-hook` finding says whether it
found one.

### Environment

| variable | meaning |
|---|---|
| `CHEAP_MEM_ROOT` | the memory root |
| `MEM_CAPTURE_MIN` | bytes of growth before capturing (default 4096) |
| `MEM_CAPTURE_OFF=1` | disable for this session |
| `MEM_HEADLESS` | set = machine session, do not capture |

`MEM_HEADLESS` is what stops the digest from capturing its own
transcript and giving itself more work every run.

### A hook must never break the session

`mem-capture` swallows every error and always exits 0. A memory tool
that can break the tool it observes will be uninstalled within a week,
and rightly so.

## Lane 2 — digest (one model call)

```bash
# Linux/macOS, every 10 minutes via cron or a systemd timer
CHEAP_MEM_ROOT=~/my-memory bash ~/cheap-mem/bin/mem-digest

# Windows: install/windows.ps1 registers this as a Scheduled Task
```

The tick is cheap on purpose. It asks `mem digest due` and is normally
back out in milliseconds — no lock, no git, no model. The decision sits
in the dueness check, not in the schedule:

| trigger | default | env |
|---|---|---|
| volume | 500 KB pending | `--volume-now` |
| quiet | 45 min since the **last** capture | `--quiet` |
| ceiling | 8 h since the **first** | `--ceiling` |

**No capture means no bell, and no bell means no call.** A week away
costs exactly zero.

Quiet counts from the last bell, not the first. Counting from the first
would fire the digest in the middle of your working day, when the
material is still arriving.

### How much per run

`MEM_DIGEST_MAX_BYTES` (default 2 MB) caps what one run is handed.
Files are chosen **smallest first**, so a single oversized capture that
no session can finish does not block everything behind it forever. The
rest stays pending and the next tick takes it — a backlog drains over
several runs instead of failing in one.

### Why the wrapper does not trust the exit code

The first real run of this reported "done" with exit 0 and had done
nothing. The session had failed on permissions, explained that
honestly, and exited cleanly.

So the wrapper counts pending captures before and after the call. No
change means failure, whatever the model claims, and the log says the
most likely cause:

```
FAILED: the model call exited 0 but digested nothing (2 -> 2).
  Most common cause: the session was not allowed to run 'node bin/mem'.
```

### Permissions

The digest starts a headless session that must run `node bin/mem` and
`git`. Without permission it refuses every call, explains itself, and
exits 0 — which is exactly the silent failure above.

**A human has to grant this, interactively.** A non-interactive session
cannot approve its own permissions, and it should not be able to: a
session that can write its own grants can open every other door too.

## What is in a capture

```json
{"__stamp": {"session_id": "a1b2c3d", "surface": "local",
             "ts_from": "...", "ts_to": "...", "project": null},
 "__captured_at": "...", "__lines": 301,
 "__offset_from": 0, "__offset_to": 43516,
 "__redacted": [{"type": "github-token", "count": 1}]}
```

The stamp says **where from**, never **who** — no login name, no
machine name. There is a test for that.

`__redacted` reports what was removed, by type and count. **The value
itself is never recorded**, not here and not in any log.

## Two checks that exist because of one bad afternoon

`mem doctor` carries two findings that are not about whether the system
runs, but about whether it is still protecting you.

### `legacy` — what was captured under weaker rules

The redaction only protects what was captured **after** it. Every gap
closed later leaves material behind that was written under the old
rules, and nobody looks again.

That is not hypothetical. A capture made at 05:52 held three dashboard
tokens in URLs; the pattern that would have caught them landed at
06:37. The values stayed in the repository, and it surfaced only
because a human grepped by hand.

So `mem doctor` re-runs today's rules over yesterday's captures:

```
FAIL  legacy       162 spots in old raw material that today's rules
                   would catch: env-secret x152, url-credentials x6
```

`mem raw check` lists where, by capture and line number. **Neither
prints a value** — printing it would spread it a second time, into
your terminal and your scrollback. To actually look, you ask for that
line explicitly.

The remedy is rotation, not history rewriting. Rewriting git history
is expensive, breaks every clone, and does not reach forks or caches.
Rotating a key takes a minute and is complete.

### `behind` — pushed is not fixed

Capture loads `src/redaction.mjs` from **its own clone** and never
pulls by itself. A security fix sitting on `main` takes effect only
after someone pulls — and in between, the machine keeps capturing with
the old rules.

That gap was an hour long once, and nobody noticed until the clone was
updated for an unrelated reason.

```
WARN  behind       3 commits behind origin/main
                   -> Capture uses the redaction from THIS clone.
                      While it lags, it captures with old rules.
```

The check reads only what git already fetched — no network call, so
`mem doctor` does not hang offline.
