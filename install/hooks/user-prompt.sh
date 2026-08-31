#!/usr/bin/env bash
# user-prompt.sh — Claude Code UserPromptSubmit hook. Delegates to
# mem-retrieve, which recalls matching memory for the turn (no model,
# a few milliseconds) and prints it back as additionalContext.
#
# This is deliberately a thin shim, not a copy. The logic lives in
# bin/mem-retrieve with its tests beside it; a second copy would drift,
# and then one of the two is wrong and nobody can tell which.
#
# Stdin (the hook JSON with the prompt) is passed through unchanged.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0
[ -z "${CHEAP_MEM_ROOT:-}" ] && exit 0
[ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ] && exit 0

RETRIEVE="$CHEAP_MEM_ROOT/bin/mem-retrieve"
# If the memory does not carry the tool, fall back to a mem-retrieve
# sitting next to this shim (a separate code checkout). Either way, a
# missing tool means a silent exit — a hook that stalls a person's
# message because recall is unavailable is worse than no recall.
if [ -f "$RETRIEVE" ]; then
  exec bash "$RETRIEVE"
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/mem-retrieve" ] && exec bash "$HERE/mem-retrieve"
exit 0
