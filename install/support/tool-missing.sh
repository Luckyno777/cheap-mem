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
# 30 minutes per hook (a marker under <memory>/.pipeline/, gitignored):
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
set -u
name="${1:-hook}"
tool="${2:-mem}"
code="${CHEAP_MEM_CODE:-}"
skipped="${MEM_OWN_SKIPPED:-0}"
[ -n "$code" ] || [ "$skipped" = "1" ] || exit 0
if [ "$skipped" = "1" ]; then
  why="the memory ships its own tool and it is not trusted, and no installed tool was found"
  [ -n "$code" ] && why="$why (CHEAP_MEM_CODE=$code has no bin/$tool)"
elif [ ! -d "$code" ]; then why="CHEAP_MEM_CODE=$code does not exist"
else why="CHEAP_MEM_CODE=$code has no bin/$tool"; fi

root="${CHEAP_MEM_ROOT:-}"
if [ -n "$root" ]; then
  mark="$root/.pipeline/tool-missing-$name"
  if [ -n "$(find "$mark" -mmin -30 2>/dev/null)" ]; then exit 0; fi
  mkdir -p "$root/.pipeline" 2>/dev/null && : > "$mark" 2>/dev/null
fi

msg="cheap-mem: the $name hook is SILENT - it cannot find its tool ($why), so it recalls nothing. Fix: run install/claude-code.sh from a current cheap-mem checkout (CHEAP_MEM_ROOT=<memory> bash <checkout>/install/claude-code.sh, or mem setup claude)."
[ "$skipped" = "1" ] && msg="$msg To run the memory's own tool instead: mem trust-own-tool (yourself, in a terminal; see docs/security-model.md)."
msg="$msg Said at most every 30 minutes."
printf '%s\n' "$msg" >&2
esc="${msg//\\/\\\\}"
esc="${esc//\"/\\\"}"
printf '{"systemMessage":"%s"}\n' "$esc"
exit 0
