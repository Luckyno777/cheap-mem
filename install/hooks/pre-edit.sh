#!/usr/bin/env bash
# pre-edit.sh — Claude Code PreToolUse hook (Edit|Write|NotebookEdit).
# Delegates to mem-before-edit, which recalls what the memory knows
# about the file being touched — before it is touched.
#
# A thin shim, not a copy, for the same reason as user-prompt.sh: two
# copies drift and then nobody can tell which one is wrong.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0
[ -z "${CHEAP_MEM_ROOT:-}" ] && exit 0
[ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ] && exit 0

# Three shapes, in order: the memory carries the tool; a separate code
# checkout the installer told us about; the script's own directory.
# The installed copy lives in ~/.claude/hooks/, where neither of the
# last two exists on their own — CHEAP_MEM_CODE is what makes the
# separate-checkout case work at all, and without it this shim would be
# registered and quietly do nothing.
[ -f "$CHEAP_MEM_ROOT/bin/mem-before-edit" ] && exec bash "$CHEAP_MEM_ROOT/bin/mem-before-edit"
[ -n "${CHEAP_MEM_CODE:-}" ] && [ -f "$CHEAP_MEM_CODE/bin/mem-before-edit" ] \
  && exec bash "$CHEAP_MEM_CODE/bin/mem-before-edit"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/mem-before-edit" ] && exec bash "$HERE/mem-before-edit"
exit 0
