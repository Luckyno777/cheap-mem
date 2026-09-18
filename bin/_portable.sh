# shellcheck shell=bash
#
# A `shell` directive, not a shebang: this file is SOURCED, never
# executed. A shebang would be a claim about a start that does not
# happen. shellcheck needs the declaration anyway — without it, it does
# not know which shell to check against and reports SC2148 at error
# level.
#
# And `bash`, not `sh`: this file uses arrays (`MEM_CAP=(timeout)`) and
# `local`, neither of which is POSIX. With `shell=sh` shellcheck would
# check bash code against the wrong rules.
#
# _portable.sh — the POSIX tools that are not everywhere, in one place.
#
# Sourced, never executed. `bin/` ships and installs as a whole (the
# launchd and systemd units point at ${HERE}/bin/..., they do not copy
# single files), so a sibling to source is safe.
#
# **Why this file exists at all (measured 2026-09-17).**
#
# `flock` and `timeout` are GNU tools. Neither is on macOS by default.
# Both fail in the same nasty way: not with a crash, but with a value
# that reads like ordinary operation.
#
#   - a missing `flock` makes `if ! flock -n 9` TRUE, so the caller
#     concludes "someone else holds the lock" and stands down. Every
#     tick, forever, exit 0.
#   - a missing `timeout` makes the wrapped command exit 127 before it
#     starts, which the caller reads as "the command failed".
#
# bin/mem-retrieve learned the `timeout` half months ago and wrote it
# down in its own comment. The lesson stayed in that file. On
# 2026-09-17 the first CI step that ever started bin/mem-digest found
# BOTH holes there, and a sweep then found seven more scripts across
# two repositories carrying the same lines. A lesson that lives only in
# the file where it was learned is half a lesson — so it lives here now,
# and test/portability.test.mjs holds every script to it.

# --- A time cap, or none -------------------------------------------
#
# GNU timeout, else gtimeout (coreutils via brew), else run it plain.
# Losing the cap is worse than having it, and far better than a command
# that never runs: a capped call that cannot start protects nothing.
if command -v timeout > /dev/null 2>&1; then MEM_CAP=(timeout)
elif command -v gtimeout > /dev/null 2>&1; then MEM_CAP=(gtimeout)
else MEM_CAP=(); fi

# capped <seconds> <cmd...>
capped() {
  local secs="$1"; shift
  if [ "${#MEM_CAP[@]}" -gt 0 ]; then "${MEM_CAP[@]}" "$secs" "$@"; else "$@"; fi
}

# --- An exclusive claim --------------------------------------------
#
# flock on FD 9 where it exists; a directory otherwise. `mkdir` is
# atomic on POSIX — exactly one caller wins, which is the whole
# guarantee flock provides here.
#
# A directory left behind by a crashed run is recognised by its age.
# Without that, one crash blocks the job forever — the same trap the
# PowerShell ports name for their PID files.
#
# mem_take_lock <lockfile> <lockdir> [stale-minutes]
mem_take_lock() {
  local lock="$1" lockdir="$2" stale="${3:-120}"
  if command -v flock > /dev/null 2>&1; then
    exec 9> "$lock"
    flock -n 9 && return 0
    return 1
  fi
  # **The rmdir must be CONDITIONAL (measured 2026-09-17).** The first
  # version cleared the directory unconditionally before creating it:
  #
  #     rmdir "$lockdir" 2>/dev/null || true
  #     mkdir "$lockdir" 2>/dev/null || return 1
  #
  # Between the loser's `[ -d ]` check and its rmdir, the winner can
  # create the directory — and then the loser DELETES the winner's lock
  # and takes one of its own. Both run. The CI step that measures two
  # concurrent ticks caught it as a flicker: one run red, the next green,
  # same code. A race that only sometimes loses is the worst kind, and
  # the only reason it showed at all is that the probe runs the two ticks
  # for real instead of reasoning about them.
  #
  # So: clear it ONLY when it was found stale, and let `mkdir` alone
  # decide the winner. mkdir is atomic; a check-then-clear is not.
  if [ -d "$lockdir" ]; then
    if [ -z "$(find "$lockdir" -maxdepth 0 -mmin "+$stale" 2>/dev/null)" ]; then
      return 1
    fi
    rmdir "$lockdir" 2> /dev/null || return 1
  fi
  mkdir "$lockdir" 2> /dev/null || return 1
  # Double quotes are DELIBERATE: `$lockdir` must be substituted NOW,
  # not when the trap fires. By then the variable may hold something
  # else, or be gone.
  #
  # The reason goes on its OWN line, not behind the directive. Written
  # with a trailing `-- reason`, shellcheck cannot parse the line at
  # all: SC1072/SC1073, both at error level. A suppression that trips
  # the checker does not suppress — it aborts it. The sister house
  # learned this on this very line on 2026-09-17 and wrote it down; it
  # never travelled here, because nothing ever ran shellcheck on this
  # repo.
  # shellcheck disable=SC2064
  trap "rmdir '$lockdir' 2>/dev/null || true" EXIT
  return 0
}

# --- A command that may not be allowed to EXECUTE -------------------
#
# Measured 2026-09-18 in the sister house (lucky-mem). The AI CLI lived
# on a mount flagged `noexec`:
#
#   /dev/sda1 on /work type ext4 (rw,nosuid,nodev,noexec,relatime,...)
#
# `execve()` refuses every file there, whatever its permission bits say
# — root included. The watcher ticked all night, each tick ending with
#
#   timeout: failed to run command 'claude': Permission denied
#
# and exit 126. Not one session started. The service reported `active`
# throughout.
#
# The way around it is the same one the hooks have used for a while:
# a file that may not be EXECUTED may still be READ. For a shell that
# is `bash <path>`; for a Node CLI, `node <path>`.
#
# **This does NOT probe the command first, and the first version did
# (found by CI, 2026-09-18).** That version ran `<path> --version` once
# at startup to see whether a detour was needed. The digest CI step
# plants a fake model that tallies every invocation and then demands
# EXACTLY ONE model call — and it went red, correctly: a probe that
# starts the configured command is a model call nobody asked for, and
# for a command that is not idempotent it is worse than a lost cap.
#
# So the detour is taken only AFTER a real call came back 126, and only
# when that call produced nothing. Both conditions together mean the
# process never started, which makes a second attempt free of doubt:
#
#   - 126 alone is not enough. A program may exit 126 of its own accord,
#     after doing its work. Re-running that one costs a second model
#     call for nothing.
#   - No output alone is not enough either — a session can fail early
#     and say nothing.
#
# mem_detour_cmd <command-line>
#   On success sets MEM_START (array) to the interpreter form and
#   MEM_DETOUR_REASON, and returns 0. Returns 1 when no detour exists,
#   with the reason in MEM_DETOUR_REASON — nothing is rewritten then,
#   so the original failure keeps speaking for itself.
MEM_START=()
MEM_DETOUR_REASON="not determined"
mem_detour_cmd() {
  local raw="$1" name path
  local parts=() rest=()
  # Word-split the configured command line: it may carry flags
  # (`claude -p`), and only the FIRST word is a file to resolve. The
  # flags must survive the rewrite — a detour that drops `-p` starts the
  # model interactively, and a session waiting forever looks, from
  # outside, exactly like a slow one.
  read -r -a parts <<< "$raw"
  if [ "${#parts[@]}" -eq 0 ]; then
    MEM_START=()
    MEM_DETOUR_REASON="the configured command line is empty"
    return 1
  fi
  name="${parts[0]}"
  rest=("${parts[@]:1}")
  path="$(command -v "$name" 2> /dev/null)" || path=""
  if [ -z "$path" ]; then
    MEM_START=()
    MEM_DETOUR_REASON="'$name' is not on PATH — that is a 127, not a noexec case"
    return 1
  fi
  if ! command -v node > /dev/null 2>&1; then
    MEM_START=()
    MEM_DETOUR_REASON="no node on PATH to read '$path' with"
    return 1
  fi
  # `${rest[@]+...}` because bash 3.2 (macOS) treats an empty array as
  # unset under `set -u` and aborts. This house targets that bash.
  MEM_START=(node "$path" ${rest[@]+"${rest[@]}"})
  MEM_DETOUR_REASON="reading '$path' with node instead of executing it"
  return 0
}

# mem_never_started <exit-code> <bytes-before> <output-file>
#   True when the command cannot have run: exit 126, and everything
#   written since <bytes-before> is an exec failure rather than the
#   command speaking for itself.
#
# **"Wrote nothing" was the first rule and it was wrong (measured
# 2026-09-18).** The time cap writes its own complaint to the same
# stream the command does:
#
#   timeout: failed to run command 'claude': Permission denied
#
# so the log grows by some seventy bytes precisely when nothing ran,
# and a byte comparison would have said "it spoke" every single time —
# the detour would never have fired where it is needed. Found by the
# probe on the first run, not in production.
#
# So the new output is READ, not weighed. That is the same lesson this
# whole detour comes from: an exit code and a message say different
# things, and the message is the one that names the cause.
mem_never_started() {
  local rc="$1" before="$2" file="$3" fresh
  [ "$rc" -eq 126 ] || return 1
  fresh="$(tail -c "+$((before + 1))" "$file" 2> /dev/null || true)"
  # Nothing at all: the caller sent the wrapper's complaint elsewhere,
  # or there is no wrapper. Still an exec failure.
  [ -z "$fresh" ] && return 0
  printf '%s' "$fresh" | grep -qiE \
    'failed to run command|permission denied|cannot execute|not executable|bad interpreter'
}
