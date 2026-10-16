#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# session-stop.sh — Claude Code Stop hook. Delegates to mem-stop:
# model-free capture + persist (push where nothing else will). The model
# reflect runs only if MEM_REFLECT=1. See bin/mem-stop for the full story.
#
# Thin shim, not a copy — the logic (and its test) live in bin/mem-stop;
# a second copy would drift and then one is wrong and nobody can tell which.
#
# Stdin (the hook JSON with transcript_path) is passed through unchanged.

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
  mem_pick_tool "$CHEAP_MEM_ROOT" bin/mem-stop "$HERE"
  [ -n "$mem_picked" ] && exec bash "$mem_picked"
fi
# Nothing usable: say so (tool-missing.sh), do not just exit.
for missing_helper in "$HERE/cheap-mem-tool-missing.sh" "$HERE/../support/tool-missing.sh"; do
  [ -f "$missing_helper" ] && MEM_OWN_SKIPPED="$MEM_OWN_SKIPPED" exec bash "$missing_helper" session-stop mem-stop
done
exit 0
