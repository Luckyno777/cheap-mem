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

# Three shapes, in order: the memory carries the tool; a separate code
# checkout the installer told us about; the script's own directory.
[ -f "$CHEAP_MEM_ROOT/bin/mem-after-failure" ] && exec bash "$CHEAP_MEM_ROOT/bin/mem-after-failure"
[ -n "${CHEAP_MEM_CODE:-}" ] && [ -f "$CHEAP_MEM_CODE/bin/mem-after-failure" ] \
  && exec bash "$CHEAP_MEM_CODE/bin/mem-after-failure"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/mem-after-failure" ] && exec bash "$HERE/mem-after-failure"
exit 0
