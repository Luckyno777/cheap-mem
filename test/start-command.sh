#!/usr/bin/env bash
# test/start-command.sh
#
# Drives mem_detour_cmd() and mem_never_started() from bin/_portable.sh
# — the real functions, sourced, not copies — and then the two of them
# together against a real command on a real file.
#
# What is at stake: on 2026-09-18 the AI CLI in the sister house sat on
# a mount flagged `noexec`. Every tick ended with
# `timeout: failed to run command 'claude': Permission denied` and exit
# 126 — all night, without one session starting, while the service
# reported `active` throughout. The way through is the house detour: a
# file that may not be EXECUTED may still be READ, so `node <path>`.
#
# **Why there is no probe to test.** The first version of this decided
# at startup by running `<path> --version`. CI killed it, correctly: the
# digest step plants a fake model that tallies invocations and demands
# EXACTLY ONE model call, and the probe was a second. So the detour is
# taken only after a real call came back 126 having written nothing —
# both together mean the process never started.
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
WITHOUT=""
IFS=: read -r -a PARTS <<< "$ORIG_PATH"
for p in "${PARTS[@]}"; do
  [ -n "$p" ] || continue
  [ -e "$p/$NAME" ] && continue
  WITHOUT="${WITHOUT:+$WITHOUT:}$p"
done

shop() { BIN="$WORK/$1"; mkdir -p "$BIN"; PATH="$BIN:$WITHOUT"; }
# A stand-in CLI that RECORDS every invocation, like the one CI plants.
# Counting is the point: the detour must cost exactly one extra call,
# and only when the first one never started.
runnable() {
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit %s\n' "$1" "$BIN/calls" "${2:-0}" > "$BIN/$1"
  chmod 755 "$BIN/$1"
}
# x-bit set, interpreter is a directory -> execve gives EACCES -> 126.
unstartable() { printf '#!%s\nexit 0\n' "$WORK" > "$BIN/$1"; chmod 755 "$BIN/$1"; }
calls() { [ -f "$BIN/calls" ] && wc -l < "$BIN/calls" | tr -d ' ' || echo 0; }

echo "0) positive control of the setup: the unusable file really gives 126"
shop preflight
unstartable claude
capped 10 "$BIN/claude" --version > /dev/null 2>&1
PRE=$?
[ "$PRE" -eq 126 ] && ok "setup yields 126" \
  || bad "setup yields $PRE, not 126 — every 126 case below checks nothing"

echo "1) mem_never_started reads the message, it does not weigh bytes"
printf '' > "$WORK/empty"; printf 'the session said something\n' > "$WORK/spoke"
printf "timeout: failed to run command 'claude': Permission denied\n" > "$WORK/wrapper"
# The case the byte rule got wrong. The time cap writes its complaint to
# the SAME stream, so the log grows by some seventy bytes exactly when
# nothing ran. A byte comparison says "it spoke" every single time and
# the detour never fires where it is needed.
mem_never_started 126 0 "$WORK/wrapper" \
  && ok "the wrapper's own exec complaint still counts as never started" \
  || bad "the time cap's message is read as the command speaking — the detour never fires"
mem_never_started 126 0 "$WORK/empty" && ok "126 + no output -> never started" \
  || bad "126 with no output not recognised"
mem_never_started 126 0 "$WORK/spoke" \
  && bad "a run that WROTE is treated as never started — a second model call for nothing" \
  || ok "126 but output present -> not a detour case"
mem_never_started 1 0 "$WORK/empty" \
  && bad "any failure counts as never started" \
  || ok "a different code is not a detour case"
mem_never_started 0 0 "$WORK/empty" \
  && bad "a SUCCESSFUL run counts as never started" \
  || ok "success is not a detour case"
# The offset half: output that was already there before the call must
# not count as this call speaking. Without it, an appended log makes
# every 126 look like a run that said something, and the detour never
# fires where it is needed.
mem_never_started 126 "$(wc -c < "$WORK/spoke")" "$WORK/spoke" \
  && ok "only growth past the offset counts as output" \
  || bad "older log content is read as this run's output"

echo "2) no detour where none exists"
shop nothing-here
mem_detour_cmd "claude -p" && bad "claimed a detour although nothing is on PATH" \
  || ok "no detour offered"
case "$MEM_DETOUR_REASON" in *"not on PATH"*) ok "reason names it" ;;
  *) bad "reason says: $MEM_DETOUR_REASON" ;; esac
mem_detour_cmd "" && bad "claimed a detour for an empty command line" \
  || ok "empty command line refused"

echo "3) a detour is offered, with the flags kept"
shop detour
unstartable claude
runnable node 0
mem_detour_cmd "claude -p" && ok "detour offered" || bad "no detour: $MEM_DETOUR_REASON"
[ "${MEM_START[0]}" = "node" ] && ok "node reads the file" \
  || bad "unexpected start: '${MEM_START[*]}'"
# The flags must survive the rewrite. Without this line the detour could
# drop `-p` and the model would be started interactively — a session
# that waits forever and looks, from outside, exactly like a slow one.
[ "${MEM_START[*]: -1}" = "-p" ] && ok "flags survive the rewrite" \
  || bad "flags lost: '${MEM_START[*]}'"
[ "${#MEM_START[@]}" -eq 3 ] && ok "exactly node, path, flag" \
  || bad "unexpected word count: '${MEM_START[*]}'"

echo "4) the whole thing, end to end, counting the calls"
# The assurance that matters, and the one a rearranged array cannot
# fake: an unstartable CLI, a real call, a real decision, a real retry —
# and EXACTLY ONE extra invocation.
shop endtoend
unstartable claude
runnable node 0
OUT="$BIN/out"
: > "$OUT"
BEFORE="$(wc -c < "$OUT")"
# shellcheck disable=SC2086
capped 10 claude -p "prompt" >> "$OUT" 2>&1
CODE=$?
[ "$CODE" -eq 126 ] && ok "the direct call really comes back 126" \
  || bad "the direct call came back $CODE — the case below proves nothing"
[ "$(calls)" = "0" ] && ok "nothing ran yet" || bad "$(calls) call(s) before the retry"
if mem_never_started "$CODE" "$BEFORE" "$OUT"; then
  ok "recognised as never started"
  mem_detour_cmd "claude -p" || bad "no detour offered: $MEM_DETOUR_REASON"
  "${MEM_START[@]}" "prompt" >> "$OUT" 2>&1
  RETRY=$?
  [ "$RETRY" -eq 0 ] && ok "the retry runs" || bad "the retry came back $RETRY"
  [ "$(calls)" = "1" ] && ok "exactly one invocation in total" \
    || bad "$(calls) invocations — the detour must cost exactly one"
else
  bad "not recognised as never started — the detour never fires"
fi

echo "5) a CLI that speaks and THEN fails is not retried"
# The boundary, and the reason mem_never_started weighs the output at
# all: a program may exit 126 of its own accord after doing its work.
# Re-running that one costs a second model call for nothing.
shop spoke-then-fail
printf '#!/bin/sh\necho "%s $*" >> "%s"\necho "I refuse"\nexit 126\n' claude "$BIN/calls" > "$BIN/claude"
chmod 755 "$BIN/claude"
runnable node 0
OUT="$BIN/out"; : > "$OUT"
BEFORE="$(wc -c < "$OUT")"
# shellcheck disable=SC2086
capped 10 claude -p "prompt" >> "$OUT" 2>&1
CODE=$?
[ "$CODE" -eq 126 ] && ok "it really exits 126 by itself" || bad "exited $CODE"
mem_never_started "$CODE" "$BEFORE" "$OUT" \
  && bad "a CLI that wrote output would be run a second time" \
  || ok "not retried — it had already spoken"
[ "$(calls)" = "1" ] && ok "one invocation, as it should be" \
  || bad "$(calls) invocations"

PATH="$ORIG_PATH"
echo
echo "start-command: $GREEN green, $RED red"
[ "$RED" -eq 0 ]
