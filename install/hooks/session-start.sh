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

if [ -z "${CHEAP_MEM_ROOT:-}" ]; then
  # Nothing to do without a memory attached.
  exit 0
fi
if [ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ]; then
  exit 0
fi

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
