#!/usr/bin/env bash
# test/start-command.sh
#
# Drives mem_start_command() from bin/_portable.sh — the real function,
# sourced, not a copy.
#
# What is at stake: on 2026-09-18 the AI CLI in the sister house sat on
# a mount flagged `noexec`. Every tick ended with
# `timeout: failed to run command 'claude': Permission denied` and exit
# 126 — all night, without one session starting, while the service
# reported `active` throughout. The fix is the house detour: a file that
# may not be EXECUTED may still be READ, so `node <path>`.
#
# A detour taken ALWAYS would be worse than none — for a native binary
# it breaks what worked. Hence four outcomes, and a case for each.
#
# **How 126 is produced here without building a noexec mount:** a file
# with the x-bit whose shebang points at a DIRECTORY. `execve()` then
# returns EACCES, exactly as on noexec — and does so for root too. The
# obvious route (mode 0111, i.e. not readable) does not work: root may
# read any file, measured, the run was green and checked nothing. CI
# here runs in a container as root.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=bin/_portable.sh
. "$ROOT/bin/_portable.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GREEN=0; RED=0
ok()  { GREEN=$((GREEN+1)); echo "  ok   $1"; }
bad() { RED=$((RED+1));     echo "  FAIL $1"; }

NAME=claude
ORIG_PATH="$PATH"

# A PATH that carries NO real CLI of that name — measured, not assumed.
# With $ORIG_PATH appended, `capped 10 claude --version` does NOT end in
# 126 when an unusable file sits in front: execvp() remembers the EACCES
# and keeps searching, and finds the machine's real CLI, which happily
# reports 0. A case then checks this machine instead of its own setup.
#
# (That is also a statement about the callers: while the configured
# command is a bare name, the start skips an unusable copy and takes the
# next one on PATH. Fine in production; not something a probe may lean
# on.)
WITHOUT=""
IFS=: read -r -a PARTS <<< "$ORIG_PATH"
for p in "${PARTS[@]}"; do
  [ -n "$p" ] || continue
  [ -e "$p/$NAME" ] && continue
  WITHOUT="${WITHOUT:+$WITHOUT:}$p"
done

shop() { BIN="$WORK/$1"; mkdir -p "$BIN"; PATH="$BIN:$WITHOUT"; }
runnable()   { printf '#!/bin/sh\nexit %s\n' "${2:-0}" > "$BIN/$1"; chmod 755 "$BIN/$1"; }
# x-bit set, interpreter is a directory -> execve gives EACCES -> 126.
unstartable() { printf '#!%s\nexit 0\n' "$WORK" > "$BIN/$1"; chmod 755 "$BIN/$1"; }

echo "0) positive control of the setup: the unusable file really gives 126"
shop preflight
unstartable claude
capped 10 "$BIN/claude" --version > /dev/null 2>&1
PRE=$?
[ "$PRE" -eq 126 ] && ok "setup yields 126" \
  || bad "setup yields $PRE, not 126 — every 126 case below checks nothing"

echo "1) not on PATH at all -> rewrite nothing, let 127 stand"
shop empty
if [ -z "$(command -v "$NAME" 2> /dev/null)" ]; then
  ok "setup: '$NAME' really is off the PATH"
else
  bad "setup: '$NAME' still on PATH — case 1 checks nothing"
fi
mem_start_command "claude -p"
[ "${MEM_START[*]}" = "claude -p" ] && ok "start stays direct, flags kept" \
  || bad "start rewritten to '${MEM_START[*]}'"
case "$MEM_START_REASON" in not-found*) ok "reason names it" ;;
  *) bad "reason says: $MEM_START_REASON" ;; esac

echo "2) runs directly -> no detour"
shop direct
runnable claude 0
mem_start_command "claude -p"
[ "${MEM_START[*]}" = "claude -p" ] && ok "start stays direct" \
  || bad "detour taken although direct works: '${MEM_START[*]}'"
case "$MEM_START_REASON" in direct*) ok "reason names it" ;;
  *) bad "reason says: $MEM_START_REASON" ;; esac

echo "3) 126 and the interpreter can run it -> detour"
shop detour
unstartable claude
runnable node 0
mem_start_command "claude -p"
[ "${MEM_START[0]}" = "node" ] && ok "detour taken" \
  || bad "no detour: '${MEM_START[*]}'"
# The flags must survive the rewrite. Without this line the detour could
# drop `-p` and the model would be started interactively — a session
# that waits forever and looks, from outside, exactly like a slow one.
[ "${MEM_START[*]: -1}" = "-p" ] && ok "flags survive the rewrite" \
  || bad "flags lost: '${MEM_START[*]}'"
case "$MEM_START_REASON" in detour*) ok "reason names it" ;;
  *) bad "reason says: $MEM_START_REASON" ;; esac
# The assurance that matters: the CHOSEN command actually starts.
# Without it the case only checks that two words were reordered.
if capped 10 "${MEM_START[0]}" "${MEM_START[1]}" --version > /dev/null 2>&1; then
  ok "the chosen start really runs"
else
  bad "the chosen start does not run (rc=$?)"
fi

echo "4) 126 and the interpreter cannot run it either -> stay direct so 126 shows"
shop bothdead
unstartable claude
runnable node 1
mem_start_command "claude -p"
[ "${MEM_START[*]}" = "claude -p" ] && ok "start stays direct" \
  || bad "detour taken although it does not run either: '${MEM_START[*]}'"
case "$MEM_START_REASON" in both-dead*) ok "reason names it" ;;
  *) bad "reason says: $MEM_START_REASON" ;; esac

echo "5) a DIFFERENT failure is not the noexec case -> no detour"
# The boundary. Without this case every broken CLI — expired login,
# missing file, whatever — would be pushed through the interpreter, and
# the caller would afterwards report something other than what is wrong.
shop other
runnable claude 3
runnable node 0
mem_start_command "claude -p"
[ "${MEM_START[*]}" = "claude -p" ] && ok "start stays direct" \
  || bad "detour taken at rc=3: '${MEM_START[*]}'"
case "$MEM_START_REASON" in *"exited 3"*) ok "reason names the real value" ;;
  *) bad "reason says: $MEM_START_REASON" ;; esac

echo "6) a command with no flags at all"
# bash 3.2 on macOS treats an empty array as unset under `set -u` and
# aborts. This house targets that bash, so the no-flag path gets its
# own case rather than a comment.
shop noflags
unstartable claude
runnable node 0
mem_start_command "claude"
[ "${#MEM_START[@]}" -eq 2 ] && [ "${MEM_START[0]}" = "node" ] \
  && ok "detour without flags yields exactly two words" \
  || bad "unexpected: '${MEM_START[*]}' (${#MEM_START[@]} words)"

PATH="$ORIG_PATH"
echo
echo "start-command: $GREEN green, $RED red"
[ "$RED" -eq 0 ]
