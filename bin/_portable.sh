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
# Two things are deliberate here:
#
#   - The detour is PROBED, not assumed. `node <path>` makes things
#     worse for a native binary, so it only wins if it actually runs.
#   - Only 126 triggers it. Any other failure — an expired login, a
#     missing file, whatever — passes through untouched. Otherwise the
#     caller would report something other than what is wrong.
#
# Four outcomes, never two, and each one names itself in
# MEM_START_REASON so a log line says which happened:
#
#   not-found    `command -v` finds nothing. Nothing is rewritten; the
#                failure then says 127, which is the truth.
#   direct       the probe runs. The normal case.
#   detour       probe says 126 and `node <path>` runs. Detour taken.
#   both-dead    probe says 126 and `node <path>` fails too. Direct is
#                kept so the 126 still shows up in the log.
#
# Determined ONCE by the caller, not per tick: the probe costs a
# process start. If the mount changes, restart the service — there is
# no self-healing here, on purpose.
#
# mem_start_command <command-line> [probe-seconds]
#   sets MEM_START (array) and MEM_START_REASON (string)
MEM_START=()
MEM_START_REASON="not determined"
mem_start_command() {
  local raw="$1" probe="${2:-30}" name path rc
  local parts=() rest=()
  # Word-split the configured command line: it may carry flags
  # (`claude -p`), and only the FIRST word is a file to resolve.
  read -r -a parts <<< "$raw"
  if [ "${#parts[@]}" -eq 0 ]; then
    MEM_START=()
    MEM_START_REASON="not-found — empty command line"
    return 0
  fi
  name="${parts[0]}"
  rest=("${parts[@]:1}")
  # `${rest[@]+...}` because bash 3.2 (macOS) treats an empty array as
  # unset under `set -u` and aborts. The house targets that bash.
  path="$(command -v "$name" 2> /dev/null)" || path=""
  if [ -z "$path" ]; then
    MEM_START=("$name" ${rest[@]+"${rest[@]}"})
    MEM_START_REASON="not-found — '$name' is not on PATH; start stays direct so the failure says 127"
    return 0
  fi
  # Run it, THEN read the status. Writing `if cmd; then ... fi` and
  # reading `$?` afterwards reads the status of the `if` construct,
  # which is 0 when no branch ran — the 126 case would never fire and
  # the detour would be dead wood that looks green.
  capped "$probe" "$path" --version > /dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    MEM_START=("$name" ${rest[@]+"${rest[@]}"})
    MEM_START_REASON="direct — $path runs"
    return 0
  fi
  if [ "$rc" -ne 126 ]; then
    MEM_START=("$name" ${rest[@]+"${rest[@]}"})
    MEM_START_REASON="direct — probe exited $rc, which is not the noexec case ($path)"
    return 0
  fi
  if capped "$probe" node "$path" --version > /dev/null 2>&1; then
    MEM_START=(node "$path" ${rest[@]+"${rest[@]}"})
    MEM_START_REASON="detour — direct start gives 126 (noexec or missing x-bit), but 'node $path' runs"
    return 0
  fi
  MEM_START=("$name" ${rest[@]+"${rest[@]}"})
  MEM_START_REASON="both-dead — direct start gives 126 AND 'node $path' fails too; start stays direct so the 126 shows in the log"
  return 0
}
