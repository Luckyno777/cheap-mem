#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
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

# Three shapes, in order, the same as pre-edit.sh: the memory carries the
# tool; a separate code checkout the installer told us about
# (CHEAP_MEM_CODE); a mem-retrieve sitting next to this shim. Either way,
# a missing tool means a silent exit - a hook that stalls a person's
# message because recall is unavailable is worse than no recall.
#
# **Why the middle one matters (2026-10-16).** The installed copy lives in
# ~/.claude/hooks/, where the third shape never exists, and a memory made
# by `mem init` carries no bin/ - so without CHEAP_MEM_CODE this shim was
# registered, ran, exited 0 with no byte, and every prompt of every
# session went without recall. Nothing failed, which is why nobody saw it.
RETRIEVE="$CHEAP_MEM_ROOT/bin/mem-retrieve"
if [ -f "$RETRIEVE" ]; then
  exec bash "$RETRIEVE"
fi
[ -n "${CHEAP_MEM_CODE:-}" ] && [ -f "$CHEAP_MEM_CODE/bin/mem-retrieve" ] \
  && exec bash "$CHEAP_MEM_CODE/bin/mem-retrieve"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/mem-retrieve" ] && exec bash "$HERE/mem-retrieve"
# Nothing found anywhere: say so (tool-missing.sh), do not just exit.
for missing_helper in "$HERE/cheap-mem-tool-missing.sh" "$HERE/tool-missing.sh"; do
  [ -f "$missing_helper" ] && exec bash "$missing_helper" user-prompt mem-retrieve
done
exit 0
