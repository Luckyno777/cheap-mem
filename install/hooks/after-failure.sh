#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# after-failure.sh — Claude Code PostToolUseFailure hook (Bash|Edit|Write).
# Delegates to mem-after-failure, which recalls what the memory knows
# about the failure that just happened — before the second attempt.
#
# A thin shim, not a copy, for the same reason as pre-edit.sh: two
# copies drift, and the real script sources bin/_portable.sh, which does
# not exist next to an installed copy in ~/.claude/hooks/.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0
[ -z "${CHEAP_MEM_ROOT:-}" ] && exit 0
[ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ] && exit 0

# Which tool runs (tool-trust-cm): the installed one (CHEAP_MEM_CODE), else the one next to this shim; the
# memory's own bin/ only with `mem trust-own-tool` (bin/_owntool.sh, installed as cheap-mem-own-tool.sh).
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=bin/_owntool.sh
for own_lib in "$HERE/cheap-mem-own-tool.sh" "$HERE/../../bin/_owntool.sh"; do
  # (the second is the repository layout: install/hooks/ next to install/support/)
  [ "$own_lib" = "$HERE/cheap-mem-own-tool.sh" ] || [ -d "$HERE/../support" ] || continue
  [ -f "$own_lib" ] && { . "$own_lib"; break; }
done
unset own_lib
mem_picked=""; MEM_OWN_SKIPPED=0
if type mem_pick_tool >/dev/null 2>&1; then
  mem_pick_tool "$CHEAP_MEM_ROOT" bin/mem-after-failure "$HERE"
  [ -n "$mem_picked" ] && exec bash "$mem_picked"
fi
# Nothing usable: say so (tool-missing.sh), do not just exit.
for missing_helper in "$HERE/cheap-mem-tool-missing.sh" "$HERE/../support/tool-missing.sh"; do
  [ -f "$missing_helper" ] && MEM_OWN_SKIPPED="$MEM_OWN_SKIPPED" exec bash "$missing_helper" after-failure mem-after-failure
done
exit 0
