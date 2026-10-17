#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# tool-missing.sh <hook-name> <tool-file> - what a hook shim says when the
# tool it delegates to cannot be found. Not a hook itself; installed next
# to the shims as cheap-mem-tool-missing.sh, called by them as the last step.
#
# **Why it exists (2026-10-16).** A shim that cannot find its tool used to
# exit 0 with no byte - the same as "nothing to recall". When the code
# path the installer baked in (CHEAP_MEM_CODE) points at a checkout that
# was moved or deleted, every hook but SessionStart went silent and
# nothing said so: the original defect, one level down.
#
# **How it speaks.** Exit code 0 stays (a hook must never block a
# prompt or an edit; exit 2 would). The message goes out as the common
# JSON field `systemMessage` on stdout, which Claude Code shows to the
# person and does NOT add to the model's context; the same text goes to
# stderr, which on exit 0 is only visible in debug mode. At most once per
# 30 minutes per hook (a marker in the user's state directory, see below):
# a line before every edit would be skimmed past within a day.
#
# **When it stays silent.** Without CHEAP_MEM_CODE in the environment: the
# installer always sets it, so its absence means the shim was started by
# hand or by a test, and there nothing was promised.
#
# **The memory's own tool, not trusted (tool-trust-cm, 2026-10-16).** The shim
# passes MEM_OWN_SKIPPED=1 when the memory ships the tool but the user never
# switched that on (`mem trust-own-tool`), and no installed tool could take its
# place. That case speaks even without CHEAP_MEM_CODE: the installer was never
# run, and the hook would otherwise be silent on every prompt for a reason a
# person can fix in one line.
#
# **A bad CHEAP_MEM_CODE is said, not shown (shim-rest-cm, 2026-10-17).** The shims reject a CHEAP_MEM_CODE
# with a control character in it (bin/_owntool.sh, mem_code_clean) and hand the rejection on as
# MEM_CODE_REJECTED; this helper speaks for it. A value that reaches here with control characters anyway
# (started by hand) is shown in printf %q form - never raw, so it cannot move a terminal cursor or start
# a new line in front of the person - and the whole message is JSON-escaped (every U+0000..U+001F).
set -u
name="${1:-hook}"
tool="${2:-mem}"
code="${CHEAP_MEM_CODE:-}"
skipped="${MEM_OWN_SKIPPED:-0}"
rejected="${MEM_CODE_REJECTED:-}"
[ -n "$rejected" ] || [ -n "$code" ] || [ "$skipped" = "1" ] || exit 0
# What a path looks like in the message: as it is, unless it holds a control character.
shown_code="$code"
case "$code" in *[[:cntrl:]]*) shown_code="$(printf '%q' "$code")" ;; esac
case "$rejected" in *[[:cntrl:]]*) rejected="$(printf '%q' "$rejected")" ;; esac
nocode="CHEAP_MEM_CODE is not set"
[ -n "$rejected" ] && nocode="CHEAP_MEM_CODE was rejected because it contains a control character such as a line break, tab or escape; value: $rejected"
if [ "$skipped" = "1" ]; then
  # Two different facts, said apart: the tool is MISSING, or it is THERE but lies in the memory and was passed over.
  why="the memory ships its own tool, which is not trusted"
  if [ -z "$code" ]; then why="$why, and no installed tool is configured ($nocode)"
  elif [ -f "$code/bin/$tool" ]; then why="$why; the installed tool (CHEAP_MEM_CODE=$shown_code) lies inside the memory, so it counts as the memory's own and was passed over"
  else why="$why, and the installed tool is missing (CHEAP_MEM_CODE=$shown_code has no bin/$tool)"; fi
elif [ -z "$code" ]; then why="$nocode, so the hook has no installed tool"
elif [ ! -d "$code" ]; then why="CHEAP_MEM_CODE=$shown_code does not exist"
else why="CHEAP_MEM_CODE=$shown_code has no bin/$tool"; fi

# The "at most every 30 minutes" marker lives in the USER's state directory, never in the memory.
# It used to be <memory>/.pipeline/tool-missing-<hook>, written with `: >`, and a memory is a git
# clone: a committed symlink at that path (or at .pipeline itself) made the shell cut whatever file
# it pointed at to zero bytes (found by the reviewer, 2026-10-16). Nothing from the memory is
# followed any more; the memory only contributes its path, as a checksum in the marker's name.
root="${CHEAP_MEM_ROOT:-}"
if [ -n "$root" ]; then
  state=""
  case "${XDG_STATE_HOME:-}" in
    /*) state="$XDG_STATE_HOME" ;;
    # Git Bash hands a Windows value on as it is (MSYS2 converts only PATH, HOME and the temp variables): `C:\x` or
    # `C:/x` is absolute there too. It used to fall through to ~/.local/state (CI run 1103, Windows).
    [A-Za-z]:[\\/]*)
      case "$(uname -s 2>/dev/null)" in
        MINGW* | MSYS* | CYGWIN*) state="${XDG_STATE_HOME//\\//}" ;;
        *) [ -n "${HOME:-}" ] && state="$HOME/.local/state" ;;
      esac ;;
    *) [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1 && state="$(cygpath -u "$LOCALAPPDATA" 2>/dev/null)"
       [ -n "$state" ] || { [ -n "${HOME:-}" ] && state="$HOME/.local/state"; } ;;
  esac
  if [ -n "$state" ]; then
    sum="$(printf '%s' "$root" | cksum 2>/dev/null | cut -d' ' -f1)"
    dir="$state/cheap-mem"
    mark="$dir/tool-missing-$name-${sum:-0}"
    # A marker that is a symlink or not a plain file is not trusted: say it (the message is the point), write nothing.
    if [ -L "$mark" ] || { [ -e "$mark" ] && [ ! -f "$mark" ]; }; then mark=""; fi
    if [ -n "$mark" ]; then
      if [ -n "$(find "$mark" -mmin -30 2>/dev/null)" ]; then exit 0; fi
      if [ ! -L "$dir" ]; then (umask 077; mkdir -p "$dir" 2>/dev/null && : > "$mark" 2>/dev/null); fi
    fi
  fi
fi

msg="cheap-mem: the $name hook is SILENT - it cannot find its tool ($why), so it recalls nothing. Fix: run install/claude-code.sh from a current cheap-mem checkout (CHEAP_MEM_ROOT=<memory> bash <checkout>/install/claude-code.sh, or mem setup claude)."
[ "$skipped" = "1" ] && msg="$msg To run the memory's own tool instead: mem trust-own-tool (yourself, in a terminal; see docs/security-model.md)."
msg="$msg Said at most every 30 minutes."
printf '%s\n' "$msg" >&2
# JSON string escape, by hand (a hook has no jq): backslash and quote first, then the five short forms, then every
# other control character U+0000..U+001F (and DEL) as \u00XX. Without it a tab or a line break in a path made the
# line invalid JSON, which Claude Code drops - the message this helper exists to deliver would vanish.
esc="${msg//\\/\\\\}"
esc="${esc//\"/\\\"}"
esc="${esc//$'\t'/\\t}"
esc="${esc//$'\n'/\\n}"
esc="${esc//$'\r'/\\r}"
esc="${esc//$'\b'/\\b}"
esc="${esc//$'\f'/\\f}"
case "$esc" in
  *[[:cntrl:]]*)
    for i in 1 2 3 4 5 6 7 11 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 127; do
      printf -v oct '%03o' "$i"
      printf -v ch "\\$oct"
      printf -v uni '\\u%04x' "$i"
      esc="${esc//"$ch"/$uni}"
    done ;;
esac
printf '{"systemMessage":"%s"}\n' "$esc"
exit 0
