#!/usr/bin/env bash
# session-start.sh — Claude Code SessionStart hook.
#
# Copy to ~/.claude/hooks/session-start.sh and register in
# ~/.claude/settings.json under hooks.SessionStart (see install/claude-code.sh
# for the merge script).
#
# Prints the memory context at the start of every session so the model
# knows where to look, without needing to grep the whole repo.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0

# Resolve the memory instead of trusting a baked-in path.
#
# **The finding (2026-09-08, second machine.)** The installer wrote the
# absolute path of the FIRST machine into the hook. On the second one
# that directory does not exist, so the hook fell through the check
# below and exited 0 — no memory, no error, no clue. The session simply
# started without knowing anything, and looked exactly like a session
# that had nothing to know.
#
# Two changes. The path is now LOOKED UP, and a failed lookup SAYS SO.
# `MEM_HOOK_OFF=1` stays the one silent exit, because that one is a
# decision somebody made on purpose.
mem_root=""
for kandidat in \
  "${CHEAP_MEM_ROOT:-}" \
  "$HOME/cheap-mem" \
  "$HOME/my-memory" \
  "$HOME/.cheap-mem" \
  "$HOME/memory"
do
  [ -n "$kandidat" ] || continue
  if [ -f "$kandidat/.mem/config.json" ]; then mem_root="$kandidat"; break; fi
done

if [ -z "$mem_root" ]; then
  echo "cheap-mem: no memory found - this session starts WITHOUT it." >&2
  if [ -n "${CHEAP_MEM_ROOT:-}" ]; then
    echo "  CHEAP_MEM_ROOT=$CHEAP_MEM_ROOT (no .mem/config.json there)" >&2
  else
    echo "  CHEAP_MEM_ROOT is not set" >&2
  fi
  echo "  Looked in: \$HOME/cheap-mem, \$HOME/my-memory, \$HOME/.cheap-mem, \$HOME/memory" >&2
  echo "  Fix: clone the memory and set CHEAP_MEM_ROOT to it, or run install/claude-code.sh again." >&2
  exit 0
fi
CHEAP_MEM_ROOT="$mem_root"
export CHEAP_MEM_ROOT

echo "=== cheap-mem attached ==="
echo ""

# Best-effort: bring the memory up to date, and force main so a
# feature-branch checkout doesn't misroute later writes.
git -C "$CHEAP_MEM_ROOT" fetch origin main 2>&1 | tail -1 || true
if git -C "$CHEAP_MEM_ROOT" rev-parse --verify main >/dev/null 2>&1; then
  git -C "$CHEAP_MEM_ROOT" checkout main 2>&1 | tail -1 || true
else
  git -C "$CHEAP_MEM_ROOT" checkout -B main origin/main 2>&1 | tail -1 || true
fi
git -C "$CHEAP_MEM_ROOT" pull --ff-only 2>&1 | tail -1 || true

echo ""
if [ -f "$CHEAP_MEM_ROOT/FACTS.md" ]; then
  echo "=== FACTS (always loaded) ==="
  cat "$CHEAP_MEM_ROOT/FACTS.md"
  echo ""
fi

if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  echo "=== mem context ==="
  node "$CHEAP_MEM_ROOT/bin/mem" context --n 10 2>/dev/null || true
  echo ""
fi

# --- How the human user works, measured (parity with lucky-mem N2) ---
#
# `mem user --session-start` (src/userhabits.mjs, `sessionStartLines()`)
# is a generic, English, code-only habit meter over the user's OWN
# captured transcripts — no name, no phrase belonging to any one person.
# It already enforces every guarantee this line needs, so the hook adds
# NOTHING beyond calling it and deciding whether to print what came
# back:
#   - at most 5 lines total, header included (SESSION_START_MAX_LINES);
#   - only patterns/metrics at or above MIN_EVIDENCE_DISPLAY (8 hits,
#     deliberately higher than the 5-hit measurement threshold — a line
#     shown on EVERY session start is a stronger claim than a row in
#     `mem user`'s own table) AND actionable (a session can act on a
#     habit, not on when it happens to be called — see the module doc
#     for why "UTC hour-of-day" never appears here);
#   - captured into a variable first, the same shape as MEM_ALARM below:
#     "not enough evidence yet" and "no capture readable at all" both
#     come back as an EMPTY string, and an empty string prints nothing —
#     silence, never the false claim "no habits".
if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  MEM_USER_HABITS="$(node "$CHEAP_MEM_ROOT/bin/mem" user --session-start 2>/dev/null || true)"
  if [ -n "$MEM_USER_HABITS" ]; then
    echo "$MEM_USER_HABITS"
    echo ""
  fi
fi

# --- What is down right now ------------------------------------------
#
# **Why (2026-09-17).** On the sibling house's machine a VM reboot wiped
# three systemd units together with a door secret — that OS keeps /etc
# on an overlay backed by /tmp. Dashboard, mail poller and a public
# server were down for 52 minutes. `mem doctor` had the answer the whole
# time: two findings at level ERROR, both correct. Nobody heard them,
# because the doctor only runs when someone types it.
#
# `--alarm` prints level ERROR only, and prints NOTHING when nothing is
# red — which is why there is no `echo` outside the `if`. A banner that
# appears on every start is background within three days.
#
# The cap reports its own expiry. `timeout` returns 124; without that
# branch "timed out" looks exactly like "all fine", and that confusion
# is what carried the outage above for so long. Where `timeout` does not
# exist the check runs uncapped rather than silently not at all.
if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  if command -v timeout >/dev/null 2>&1; then
    MEM_ALARM="$(timeout "${MEM_ALARM_SECONDS:-8}" node "$CHEAP_MEM_ROOT/bin/mem" doctor --alarm 2>/dev/null)"
  else
    MEM_ALARM="$(node "$CHEAP_MEM_ROOT/bin/mem" doctor --alarm 2>/dev/null)"
  fi
  MEM_ALARM_RC=$?
  if [ -n "$MEM_ALARM" ]; then
    echo "=== DOWN RIGHT NOW (mem doctor --alarm) ==="
    echo "$MEM_ALARM"
    echo ""
  elif [ "$MEM_ALARM_RC" -eq 124 ]; then
    echo "=== DOWN RIGHT NOW ==="
    echo "The alarm hit its time cap (${MEM_ALARM_SECONDS:-8}s) — NOT checked."
    echo "By hand: node $CHEAP_MEM_ROOT/bin/mem doctor --quiet"
    echo ""
  fi
fi

cat <<HINTS
=== how to use this memory this session ===

Log substantial things as they happen:
  node $CHEAP_MEM_ROOT/bin/mem log event    --title "..." --tags ...
  node $CHEAP_MEM_ROOT/bin/mem log decision --topic "..." --choice ... --why ...
  node $CHEAP_MEM_ROOT/bin/mem log error    --class ... --title "..." --text ...

Look for known context before asking:
  node $CHEAP_MEM_ROOT/bin/mem find "..."

Send an inbox message (delivered after commit + push):
  node $CHEAP_MEM_ROOT/bin/mem inbox write --as session --to librarian --subject "..." < body.md

The Stop hook (session-stop.sh) will reflect automatically once the
transcript grows past the byte-delta threshold.
HINTS
