#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# catch-fail.sh — Claude Code PostToolUse hook (Bash).
# Delegates to mem-catch-fail, which recalls what the memory knows when a
# Bash call exited 0 but its own output carried a failure signature.
#
# A thin shim, not a copy, for the same reason as pre-edit.sh: two
# copies drift, and the real script sources bin/_portable.sh, which does
# not exist next to an installed copy in ~/.claude/hooks/. (Until X2b the
# installer copied the script itself: the installed copy could not source
# it, `capped` was undefined, and the hook stayed mute.)

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0
[ -z "${CHEAP_MEM_ROOT:-}" ] && exit 0
[ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ] && exit 0

# Three shapes, in order: the memory carries the tool; a separate code
# checkout the installer told us about; the script's own directory.
[ -f "$CHEAP_MEM_ROOT/bin/mem-catch-fail" ] && exec bash "$CHEAP_MEM_ROOT/bin/mem-catch-fail"
[ -n "${CHEAP_MEM_CODE:-}" ] && [ -f "$CHEAP_MEM_CODE/bin/mem-catch-fail" ] \
  && exec bash "$CHEAP_MEM_CODE/bin/mem-catch-fail"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/mem-catch-fail" ] && exec bash "$HERE/mem-catch-fail"
exit 0
