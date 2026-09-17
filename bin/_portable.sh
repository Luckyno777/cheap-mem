# _portable.sh — the two POSIX tools that are not everywhere, in one place.
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
  # shellcheck disable=SC2064 -- $lockdir is wanted at trap time, not later
  trap "rmdir '$lockdir' 2>/dev/null || true" EXIT
  return 0
}
