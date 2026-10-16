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

# **Why CHEAP_MEM_CODE matters (2026-10-16).** The installed copy lives in
# ~/.claude/hooks/, where no tool sits next to it, and a memory made
# by `mem init` carries no bin/ - so without CHEAP_MEM_CODE this shim was
# registered, ran, exited 0 with no byte, and every prompt of every
# session went without recall. Nothing failed, which is why nobody saw it.
#
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
  mem_pick_tool "$CHEAP_MEM_ROOT" bin/mem-retrieve "$HERE"
  [ -n "$mem_picked" ] && exec bash "$mem_picked"
fi
# Nothing usable: say so (tool-missing.sh), do not just exit.
for missing_helper in "$HERE/cheap-mem-tool-missing.sh" "$HERE/../support/tool-missing.sh"; do
  [ -f "$missing_helper" ] && MEM_OWN_SKIPPED="$MEM_OWN_SKIPPED" exec bash "$missing_helper" user-prompt mem-retrieve
done
exit 0
