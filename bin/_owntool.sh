# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# shellcheck shell=bash
#
# _owntool.sh - which copy of the tool a hook may run. SOURCED, never executed.
# The installer also copies this file next to the hook shims, as
# ~/.claude/hooks/cheap-mem-own-tool.sh, so the shims and bin/ share ONE rule.
#
# The PowerShell twin is bin/_owntool.ps1 (so it needs no parity exemption); the decision is
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
#
# **No subshell on the hot path.** This runs before every prompt and every edit.
# The functions hand their result over in a variable (mem_own_r, mem_own_k,
# mem_own_f) instead of printing it, because every `$(...)` is a fork; measured
# 2026-10-16, the version with command substitutions cost 16.7 ms per decision,
# this one a fraction of that (see the CHANGELOG).

# mem_own_real DIR - sets mem_own_r to the physical path of DIR (symlinks resolved); rc 1 when DIR is not a directory.
mem_own_real() {
  local old="$PWD"
  mem_own_r=""
  [ -n "$1" ] || return 1
  CDPATH='' cd -P -- "$1" 2>/dev/null || return 1
  mem_own_r="$PWD"
  cd -- "$old" 2>/dev/null || cd / 2>/dev/null
  return 0
}

# mem_own_key DIR - sets mem_own_k to the form the switch file stores: the physical path with '/'
# separators; on Windows (Git Bash, cygpath present) the mixed form, lower-cased - paths ignore case there.
mem_own_key() {
  mem_own_k=""
  mem_own_real "$1" || return 1
  local p="$mem_own_r"
  if command -v cygpath >/dev/null 2>&1; then
    p="$(cygpath -m "$p" 2>/dev/null)" || return 1
    p="$(printf '%s' "$p" | tr 'A-Z' 'a-z')"
  fi
  mem_own_k="$p"
  return 0
}

# mem_own_file - sets mem_own_f to where the switch file is; rc 1 when that cannot be told.
mem_own_file() {
  local base
  mem_own_f=""
  if [ -n "${APPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
    base="$(cygpath -u "$APPDATA" 2>/dev/null)" || return 1
  else
    case "${XDG_CONFIG_HOME:-}" in
      /*) base="$XDG_CONFIG_HOME" ;;
      *) [ -n "${HOME:-}" ] || return 1; base="$HOME/.config" ;;
    esac
  fi
  mem_own_f="$base/cheap-mem/own-tool-roots"
  return 0
}

# mem_own_tool_trusted ROOT - 0 when the memory at ROOT is in the switch file.
mem_own_tool_trusted() {
  local key line
  mem_own_key "$1" || return 1
  key="$mem_own_k"
  [ -n "$key" ] || return 1
  mem_own_file || return 1
  [ -f "$mem_own_f" ] && [ -r "$mem_own_f" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ "$line" = "$key" ] && return 0
  done < "$mem_own_f"
  return 1
}

# mem_own_inside DIR ROOT - 0 when DIR is ROOT or lies below it (physical paths).
mem_own_inside() {
  local d r
  mem_own_key "$1" || return 1
  d="$mem_own_k"
  mem_own_key "$2" || return 1
  r="$mem_own_k"
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

# mem_code_clean - makes CHEAP_MEM_CODE safe to use and to print (shim-rest-cm, 2026-10-17).
#   The value comes from the first line of the installed shim (`export CHEAP_MEM_CODE='...'`) or, for a
#   shim started by hand, from the environment. Two things were never checked:
#   - a control character in it (a line break, a tab, an escape). The start hook prints the value into the
#     session's context (`CHEAP_MEM_CODE=<value> ...`), where a line break starts a line of the attacker's
#     choosing, and the missing-tool message put it into a JSON line. Such a value is REJECTED: loudly (one
#     stderr line, and MEM_CODE_REJECTED carries a printable form so the missing-tool message and the start
#     hook can say it), without a crash: CHEAP_MEM_CODE is unset, and the shim goes on with the tool next
#     to it, or says so. A hook must never break the session.
#   - a trailing separator (`/opt/cheap-mem/`): CLEANED, so the paths built from it have one slash.
#   Idempotent. Sets MEM_CODE_REJECTED (exported) to '' or the printable form of the rejected value.
mem_code_clean() {
  local c="${CHEAP_MEM_CODE:-}"
  # Nothing set (or already rejected by an earlier call): MEM_CODE_REJECTED stays as it is.
  [ -n "$c" ] || return 0
  MEM_CODE_REJECTED=""
  case "$c" in
    *[[:cntrl:]]*)
      printf -v MEM_CODE_REJECTED '%q' "$c"
      export MEM_CODE_REJECTED
      unset CHEAP_MEM_CODE
      printf 'cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character (value: %s)\n' "$MEM_CODE_REJECTED" >&2
      return 0 ;;
  esac
  while [ "${#c}" -gt 1 ] && [ "${c%/}" != "$c" ]; do c="${c%/}"; done
  [ "$c" = "${CHEAP_MEM_CODE:-}" ] || CHEAP_MEM_CODE="$c"
  return 0
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
  mem_code_clean
  mem_own_tool_trusted "$root" && trusted=1
  if [ "$trusted" = 1 ] && [ -f "$root/$rel" ]; then mem_picked="$root/$rel"; return 0; fi
  [ ! -f "$root/$rel" ] || MEM_OWN_SKIPPED=1
  for c in "${CHEAP_MEM_CODE:+$CHEAP_MEM_CODE/$rel}" "${self:+$self/../$rel}" "${self:+$self/${rel#bin/}}"; do
    [ -n "$c" ] && [ -f "$c" ] || continue
    if [ "$trusted" = 0 ] && mem_own_inside "${c%/*}" "$root"; then MEM_OWN_SKIPPED=1; continue; fi
    mem_picked="$c"; return 0
  done
  return 1
}
