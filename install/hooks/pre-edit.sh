#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# pre-edit.sh — Claude Code PreToolUse hook (Edit|Write|NotebookEdit|Bash).
# Delegates to mem-before-edit, which recalls what the memory knows
# about the file being touched — before it is touched.
#
# A thin shim, not a copy, for the same reason as user-prompt.sh: two
# copies drift and then nobody can tell which one is wrong.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0
[ -z "${CHEAP_MEM_ROOT:-}" ] && exit 0
[ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ] && exit 0

# **Where the tool comes from (tool-trust-cm, 2026-10-16).** The INSTALLED tool
# (CHEAP_MEM_CODE, set by the installer), else the tool next to this shim. The
# memory's own bin/ only when the user switched that on, locally
# (`mem trust-own-tool`): the memory is a git clone pulled from origin, so code
# taken from it is code its remote can ship. cheap-mem-own-tool.sh (a copy of
# bin/_owntool.sh) holds the rule; without it nothing is run from anywhere but
# the tool-missing message below.
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
  mem_pick_tool "$CHEAP_MEM_ROOT" bin/mem-before-edit "$HERE"
  [ -n "$mem_picked" ] && exec bash "$mem_picked"
fi
# Nothing usable: say so (tool-missing.sh), do not just exit.
for missing_helper in "$HERE/cheap-mem-tool-missing.sh" "$HERE/../support/tool-missing.sh"; do
  [ -f "$missing_helper" ] && MEM_OWN_SKIPPED="$MEM_OWN_SKIPPED" exec bash "$missing_helper" pre-edit mem-before-edit
done
exit 0
