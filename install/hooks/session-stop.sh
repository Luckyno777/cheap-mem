#!/usr/bin/env bash
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

# The memory may carry the tool ($ROOT/bin), or the code lives in a
# separate checkout — the installer injects CHEAP_MEM_CODE for that case.
STOP="$CHEAP_MEM_ROOT/bin/mem-stop"
[ -f "$STOP" ] || STOP="${CHEAP_MEM_CODE:-}/bin/mem-stop"
[ -f "$STOP" ] || exit 0
exec bash "$STOP"
