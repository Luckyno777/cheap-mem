# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# shellcheck shell=bash
#
# _owntool.sh - which copy of the tool a hook may run. SOURCED, never executed.
# The installer also copies this file next to the hook shims, as
# ~/.claude/hooks/cheap-mem-own-tool.sh, so the shims and bin/ share ONE rule.
#
# windows-parity-ok: bin/_owntool.ps1 is the PowerShell twin; the decision is
# the same and test/own-tool.test.mjs holds both to it.
#
# **The rule (tool-trust-cm, 2026-10-16).** A hook runs the INSTALLED tool
# (CHEAP_MEM_CODE) or the tool it sits in. A memory's own `bin/` and `src/` are
# used only when the user said so, locally and outside every repository: the
# real path of the memory is a line in
#   ${XDG_CONFIG_HOME:-~/.config}/cheap-mem/own-tool-roots     (Windows: %APPDATA%\cheap-mem\...)
# which `mem trust-own-tool` writes. A `git pull` cannot write that file. Why
# it exists at all: src/owntool.mjs.
#
# Fails closed: anything unreadable, unresolvable or missing means "not trusted".

# The directory part of a path, resolved to its physical form ('' when it does not exist).
mem_own_real() { ( cd "$1" 2>/dev/null && pwd -P ); }

# The form the switch file stores: physical path, '/' separators; on Windows
# (Git Bash, cygpath present) the mixed form, lower-cased - paths ignore case there.
mem_own_key() {
  local p
  p="$(mem_own_real "$1")" || return 1
  [ -n "$p" ] || return 1
  if command -v cygpath >/dev/null 2>&1; then
    p="$(cygpath -m "$p" 2>/dev/null)" || return 1
    p="$(printf '%s' "$p" | tr 'A-Z' 'a-z')"
  fi
  printf '%s' "$p"
}

# Where the switch file is.
mem_own_file() {
  local base
  if [ -n "${APPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
    base="$(cygpath -u "$APPDATA" 2>/dev/null)" || return 1
  else
    case "${XDG_CONFIG_HOME:-}" in
      /*) base="$XDG_CONFIG_HOME" ;;
      *) [ -n "${HOME:-}" ] || return 1; base="$HOME/.config" ;;
    esac
  fi
  printf '%s/cheap-mem/own-tool-roots' "$base"
}

# mem_own_tool_trusted ROOT - 0 when the memory at ROOT is in the switch file.
mem_own_tool_trusted() {
  local key file line
  key="$(mem_own_key "$1")" || return 1
  [ -n "$key" ] || return 1
  file="$(mem_own_file)" || return 1
  [ -f "$file" ] && [ -r "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ "$line" = "$key" ] && return 0
  done < "$file"
  return 1
}

# mem_own_inside DIR ROOT - 0 when DIR is ROOT or lies below it (physical paths).
mem_own_inside() {
  local d r
  d="$(mem_own_key "$1")" || return 1
  r="$(mem_own_key "$2")" || return 1
  case "$d/" in "$r"/*) return 0 ;; esac
  return 1
}

# mem_own_ships ROOT - 0 when the memory carries a tool of its own (bin/mem*, or a src/ module a hook would load).
mem_own_ships() {
  local f
  for f in "$1"/bin/mem "$1"/bin/mem-*; do [ -e "$f" ] && return 0; done
  for f in subagentstart answercheck closingreport; do [ -f "$1/src/$f.mjs" ] && return 0; done
  return 1
}

# mem_pick_tool ROOT REL [SELF] - which copy of REL (e.g. bin/mem-retrieve) to run.
#   Sets mem_picked (the path, '' when none) and MEM_OWN_SKIPPED (1 when a copy
#   from the memory was passed over because it is not trusted - the caller says so).
#   Order: the memory's own copy, ONLY with the switch; the installed tool
#   (CHEAP_MEM_CODE); the tool SELF sits in (SELF is a directory: its bin/ twin
#   one level up, or the file next to it). A candidate that lies inside the
#   memory counts as the memory's own copy, whoever named it.
mem_pick_tool() {
  local root="$1" rel="$2" self="${3:-}" trusted=0 c
  mem_picked=""; MEM_OWN_SKIPPED=0
  mem_own_tool_trusted "$root" && trusted=1
  if [ "$trusted" = 1 ] && [ -f "$root/$rel" ]; then mem_picked="$root/$rel"; return 0; fi
  [ ! -f "$root/$rel" ] || MEM_OWN_SKIPPED=1
  for c in "${CHEAP_MEM_CODE:+$CHEAP_MEM_CODE/$rel}" "${self:+$self/../$rel}" "${self:+$self/${rel#bin/}}"; do
    [ -n "$c" ] && [ -f "$c" ] || continue
    if [ "$trusted" = 0 ] && mem_own_inside "$(dirname "$c")" "$root"; then MEM_OWN_SKIPPED=1; continue; fi
    mem_picked="$c"; return 0
  done
  return 1
}
