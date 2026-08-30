#!/usr/bin/env bash
# session-stop.sh — Claude Code Stop hook. Delegates to mem-reflect.
#
# Stdin (JSON with transcript_path) is passed through unchanged.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0
[ -z "${CHEAP_MEM_ROOT:-}" ] && exit 0
[ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ] && exit 0

REFLECTOR="$CHEAP_MEM_ROOT/bin/mem-reflect"
[ ! -f "$REFLECTOR" ] && exit 0

exec bash "$REFLECTOR"
