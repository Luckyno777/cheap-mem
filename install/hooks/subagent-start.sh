#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# subagent-start.sh — Claude Code SubagentStart hook. Delegates to
# mem-subagent-start: the tagged procedures plus a context recap, shown
# once per subagent before its first task. See bin/mem-subagent-start
# for the full story.
#
# Thin shim, not a copy — same reason as the other shims in this
# directory: a second copy of the logic drifts and then one of them is
# wrong and nobody can tell which.
#
# Stdin (the hook JSON) is passed through unchanged.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0
[ -z "${CHEAP_MEM_ROOT:-}" ] && exit 0
[ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ] && exit 0

# The memory may carry the tool ($ROOT/bin), or the code lives in a
# separate checkout — the installer injects CHEAP_MEM_CODE for that case.
HOOK="$CHEAP_MEM_ROOT/bin/mem-subagent-start"
[ -f "$HOOK" ] || HOOK="${CHEAP_MEM_CODE:-}/bin/mem-subagent-start"
[ -f "$HOOK" ] || exit 0
exec bash "$HOOK"
