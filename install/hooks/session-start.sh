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
