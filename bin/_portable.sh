# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
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
# windows-parity-ok: sourced by bash hooks only; it exists to paper over
# missing GNU tools on POSIX, and the .ps1 hooks use native PowerShell
# for the same jobs, so there is nothing here to port. (Marker read by
# test/hook-parity.test.mjs, added 2026-09-19 when three bash-only hooks
# turned out to be unstartable on a Windows box without Git Bash.)
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
# GNU timeout, else gtimeout (coreutils via brew), else the perl
# watchdog below, else the node watchdog, else run it plain - and SAY so
# (mem_cap_kind=none; see `capped`).
#
# **The plain run used to be the answer on a stock Mac, and it was wrong
# (CI run 37692975754).** A "cap" that does not cap is not a cap: the
# K3 probe (a hanging `find` must come back as exit 124 plus a journal
# line with reason `timeout`) and the digest probe (a hanging collection
# is ended by its cap) both got no 124 on macOS-latest, because nothing
# ended the call. perl ships with macOS (and with git for Windows), so
# a stock Mac now has a real cap: `mem_cap_perl` below, same contract as
# GNU timeout - exit 124 when it expired, the command's own code
# otherwise, 128+n when it died of a signal.
mem_cap_perl() {
  perl -MTime::HiRes=alarm -e '
    my $s = shift @ARGV; my $p = fork();
    defined $p or exit 125;
    if (!$p) {
      exec { $ARGV[0] } @ARGV;
      # GNU timeout semantics: 127 = not found, 126 = found but not startable
      # (noexec mount, bad interpreter). A flat 127 made the noexec detour
      # (mem_never_started wants 126) never fire where perl is the cap, i.e. on macOS.
      my $nf = $!{ENOENT}; my $e = "$!";
      print STDERR "timeout: failed to run command \x27$ARGV[0]\x27: $e\n";
      exit($nf ? 127 : 126);
    }
    my $hit = 0;
    $SIG{ALRM} = sub { if (!$hit) { $hit = 1; kill "TERM", $p; alarm 2 } else { kill "KILL", $p } };
    alarm $s;
    my $r; while (($r = waitpid($p, 0)) < 0) { last unless $!{EINTR} }
    alarm 0;
    exit 124 if $hit;
    exit(($? & 127) ? 128 + ($? & 127) : ($? >> 8));
  ' "$@"
}
# The same contract with Node as the watchdog, for a box that has neither
# a GNU timeout nor perl (minimal containers, a Windows Git Bash without
# perl). Every hook already needs node, so this is the cap of last resort
# that is still a cap. It only ever signals ITS OWN child (TERM, then KILL
# two seconds later) - never a process it did not start.
mem_cap_node() {
  node -e '
    const { spawn } = require("node:child_process");
    const secs = Number(process.argv[1]);
    const argv = process.argv.slice(2);
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    let hit = false;
    let hard = null;
    const soft = setTimeout(() => {
      hit = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
    }, Math.max(1, secs * 1000));
    child.on("error", (e) => {
      clearTimeout(soft);
      const nf = e && e.code === "ENOENT";
      process.stderr.write("timeout: failed to run command \x27" + argv[0] + "\x27: " + (e && e.message) + "\n");
      process.exit(nf ? 127 : 126);
    });
    child.on("exit", (code, sig) => {
      clearTimeout(soft); if (hard) clearTimeout(hard);
      if (hit) process.exit(124);
      if (sig) process.exit(128 + (require("node:os").constants.signals[sig] || 0));
      process.exit(code === null ? 1 : code);
    });
  ' "$@"
}
# mem_cap_kind says WHICH cap this shell got: timeout | gtimeout | perl |
# node | none. "none" is the only dishonest one, so it is never silent:
# `capped` says so on stderr (once per process), and the Stop hook says
# so to the session.
if command -v timeout > /dev/null 2>&1; then MEM_CAP=(timeout); mem_cap_kind=timeout
elif command -v gtimeout > /dev/null 2>&1; then MEM_CAP=(gtimeout); mem_cap_kind=gtimeout
elif command -v perl > /dev/null 2>&1; then MEM_CAP=(mem_cap_perl); mem_cap_kind=perl
elif command -v node > /dev/null 2>&1; then MEM_CAP=(mem_cap_node); mem_cap_kind=node
else MEM_CAP=(); mem_cap_kind=none; fi

mem_cap_warned=0
# capped <seconds> <cmd...>
capped() {
  local secs="$1"; shift
  if [ "${#MEM_CAP[@]}" -gt 0 ]; then "${MEM_CAP[@]}" "$secs" "$@"; return $?; fi
  if [ "$mem_cap_warned" != 1 ]; then
    mem_cap_warned=1
    echo "cheap-mem: NO time cap available (no timeout, gtimeout, perl or node on PATH) - '$1' runs without a limit" >&2
  fi
  "$@"
}

# --- A compile cache for the hooks' node starts (R6) ----------------
#
# Every hook call is a NEW node process, and each one translates the
# `src/*.mjs` it imports from scratch. `NODE_COMPILE_CACHE` (Node >= 22.1)
# keeps the translated code in a directory and reads it back at the next
# start. Measured 2026-10-14 on the before-edit hook, now one start
# (Linux 6.18, 4 cores, Node 22.22, median of 15): see CHANGELOG.
#
# **Where it lives: the USER's cache, not the memory.** The memory is a git
# repository that travels between machines; a directory of machine code for
# one Node version has no business in it (the sibling house keeps it under
# the memory's `.pipeline/`, which it ignores - here the user cache is the
# honest place, and one cache serves every memory on the machine):
#
#   Linux / other   ${XDG_CACHE_HOME:-$HOME/.cache}/cheap-mem/node-cc
#   macOS           $HOME/Library/Caches/cheap-mem/node-cc
#   Git Bash (Win)  $LOCALAPPDATA/cheap-mem/node-cc
#
# **A value the user set stays** (NODE_COMPILE_CACHE already in the
# environment). **The cache only speeds up:** if the directory cannot be
# made (no HOME, read-only, disk full) the hook runs without it - a hook
# that falls silent over a cache is worse than one that needs 20 ms more.
# Node 20 does not know the variable and ignores it. A relative
# XDG_CACHE_HOME is ignored, as the specification says.
mem_compile_cache() {
  [ -n "${NODE_COMPILE_CACHE:-}" ] && return 0
  local base="" dir
  case "$(uname -s 2> /dev/null)" in
    Darwin) [ -n "${HOME:-}" ] && base="$HOME/Library/Caches" ;;
    MINGW* | MSYS* | CYGWIN*) base="${LOCALAPPDATA:-}"; base="${base//\\//}" ;;
    *)
      case "${XDG_CACHE_HOME:-}" in
        /*) base="$XDG_CACHE_HOME" ;;
        *) [ -n "${HOME:-}" ] && base="$HOME/.cache" ;;
      esac ;;
  esac
  [ -n "$base" ] || return 0
  dir="$base/cheap-mem/node-cc"
  [ -d "$dir" ] || (umask 077; mkdir -p "$dir") 2> /dev/null || return 0
  [ -d "$dir" ] && export NODE_COMPILE_CACHE="$dir"
  return 0
}

# --- Which remote and branch does this memory TRACK? (D4) -----------
#
# `.mem/config.json` says: `defaultRemote` and `defaultBranch` - the same
# keys `mem-watch` reads. Until 2026-10-14 the recall hook pulled
# `origin main` and the session start fetched `origin main`, checked out
# `main` and pulled, whatever the memory said. Reproduced: a clone on
# `develop` (config `defaultBranch: develop`, the remote also has a
# `main`) came out of a session start on a NEW local `main` tracking
# `origin/main` - every later write went to the wrong branch. The hook
# had been "forcing main so a feature-branch checkout cannot misroute
# writes"; for a memory that does not live on main it did the misrouting.
#
# Sets mem_track_remote and mem_track_branch (default origin / main, when the
# file or the key is missing) and mem_track_note (empty, or one sentence
# when a value was refused). The config is DATA out of a cloned repository:
# a value goes to git only if it is a plain name (letters, digits, `._-`,
# `/` inside a branch) that starts with a letter or digit (a leading `-` would
# be read by git as an option), holds no `..` or `//` and does not end in `/`
# or `.lock`. Anything else is refused LOUDLY
# (the note), and the default stands - never a half-trusted value.
#
# install/hooks/session-start.sh carries an inline twin of this function (the
# installed hook has no _portable.sh next to it); test/tracked-ref.test.mjs runs
# both over the same cases.
#
# A remote that is not one of THIS clone's is refused as well (N5): `git fetch <name>` with a name that is no remote is
# read by git as a path or URL, and the name comes out of a file in a cloned repository. Checked with
# `git remote get-url -- <name>`; where the directory is no git repository nothing is fetched anyway and nothing is asked.
# N5-1: no warning where the answer is the same anyway: the default "origin" that is no remote (a memory without a remote) and any
# value in a clone that has no remote at all. A warning needs a value set on purpose AND remotes it could have named.
# The refused value is shown clipped (40 characters, printable ASCII only): it is data, and it is printed.
#
# mem_tracked_ref <memory root>
mem_clip() {
  local c; c="$(printf '%s' "$1" | LC_ALL=C tr -cd '\040-\176' | cut -c1-40)"
  [ "${#1}" -gt 40 ] && c="$c..."
  printf '%s' "$c"
}
mem_tracked_ref() {
  local cfg="$1/.mem/config.json" v
  mem_track_remote="origin"; mem_track_branch="main"; mem_track_note=""
  [ -f "$cfg" ] || return 0
  v="$(grep -o '"defaultRemote"[[:space:]]*:[[:space:]]*"[^"]*"' "$cfg" 2> /dev/null | head -n 1 | sed 's/^[^:]*:[[:space:]]*"\(.*\)"$/\1/')"
  if [ -n "$v" ]; then
    case "$v" in
      [!A-Za-z0-9]* | *[!A-Za-z0-9._-]* | *..*) mem_track_note="config defaultRemote '$(mem_clip "$v")' is not a plain remote name - using origin" ;;
      *)
        if git -C "$1" rev-parse --git-dir > /dev/null 2>&1 && ! git -C "$1" remote get-url -- "$v" > /dev/null 2>&1; then
          # N5-1: origin stays either way, so a warning is only for a value somebody SET against a clone that has remotes.
          # The default name ("origin", which `mem init` writes) and a clone without any remote say nothing.
          if [ "$v" != origin ] && [ -n "$(git -C "$1" remote 2> /dev/null)" ]; then
            mem_track_note="config defaultRemote '$(mem_clip "$v")' is not a remote of this clone - using origin"
          fi
        else mem_track_remote="$v"; fi ;;
    esac
  fi
  v="$(grep -o '"defaultBranch"[[:space:]]*:[[:space:]]*"[^"]*"' "$cfg" 2> /dev/null | head -n 1 | sed 's/^[^:]*:[[:space:]]*"\(.*\)"$/\1/')"
  if [ -n "$v" ]; then
    case "$v" in
      [!A-Za-z0-9]* | */ | *//* | *..* | *.lock | *[!A-Za-z0-9._/-]*) mem_track_note="${mem_track_note:+$mem_track_note; }config defaultBranch '$(mem_clip "$v")' is not a plain branch name - using main" ;;
      *) mem_track_branch="$v" ;;
    esac
  fi
  return 0
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

# --- How a model session is started from an unattended job ------------
#
# The ONE place for the shells (the .ps1 twins call the same helper).
# `claude -p` without `--bare` runs the hooks of `.claude/settings.json`
# and connects the servers of `.mcp.json` of the folder it starts in,
# even a folder nobody trusted, with no dialog. The digest and the mail
# handler used to start IN the memory: whoever could push to it could
# plant a hook and have the next tick run it. src/headless.mjs says what
# is done about it and why: EVERY configured command starts in a neutral
# empty directory outside the memory (also a wrapper, an alias, another
# agent CLI), and a command recognised as claude also gets
# `--setting-sources user --strict-mcp-config`.
#
# mem_headless_plan <command-line> <memory-root> [0]
#   Sets MEM_HL_CWD (where the session must start; never empty on
#   success), MEM_HL_ISOLATED (1 = recognised as claude), MEM_HL_ARGS
#   (array; goes AFTER the prompt, `--add-dir` is variadic and last),
#   MEM_HL_NOTE (a sentence for the log when the command was not
#   recognised) and MEM_HL_CLEAN (a per-run directory to remove after the
#   job, see mem_headless_cleanup). A third argument of 0 leaves
#   `--add-dir` off (a job that never reads the memory). Returns 1 when no
#   safe start exists: the caller must NOT start the model then, and must
#   not fall back to starting in the memory or without the flags.
MEM_HL_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mem-headless.mjs"
MEM_HL_ISOLATED=0
MEM_HL_CWD=""
MEM_HL_NOTE=""
MEM_HL_CLEAN=""
MEM_HL_ARGS=()
mem_headless_plan() {
  local cmd="$1" root="$2" adddir="${3:-1}" out line v
  MEM_HL_ISOLATED=0; MEM_HL_CWD=""; MEM_HL_NOTE=""; MEM_HL_CLEAN=""; MEM_HL_ARGS=()
  local a=(plan --cmd "$cmd" --root "$root")
  [ "$adddir" = "1" ] || a+=(--no-add-dir)
  out="$(node "$MEM_HL_HELPER" "${a[@]}")" || return 1
  while IFS= read -r line; do
    v="${line#*=}"
    case "$line" in
      isolated=1) MEM_HL_ISOLATED=1 ;;
      isolated=0) ;;
      cwd=*) MEM_HL_CWD="${v//\\//}" ;;
      arg=*) MEM_HL_ARGS+=("${v//\\//}") ;;
      note=*) MEM_HL_NOTE="$v" ;;
      cleanup=*) MEM_HL_CLEAN="$v" ;;
      *) return 1 ;;
    esac
  done <<< "$out"
  # No plan without a working directory; a claude plan without its flags is none either.
  [ -n "$MEM_HL_CWD" ] || return 1
  if [ "$MEM_HL_ISOLATED" = "1" ] && [ "${#MEM_HL_ARGS[@]}" -lt 3 ]; then return 1; fi
  return 0
}

# mem_headless_cleanup
#   Removes the per-run neutral directory, if the plan made one (the helper
#   checks the name and the type; nothing else is ever removed).
mem_headless_cleanup() {
  if [ -n "${MEM_HL_CLEAN:-}" ]; then
    node "$MEM_HL_HELPER" cleanup "$MEM_HL_CLEAN" > /dev/null 2>&1 || true
    MEM_HL_CLEAN=""
  fi
}

# mem_headless_old_claude <file> [<bytes-before>]
#   True (and prints the message) when what was written to <file> after
#   <bytes-before> shows a claude that does not know the isolation flags.
#   Nothing is written to a temp file: the text goes through a pipe, and a
#   TMPDIR that points into the memory cannot put a file there.
mem_headless_old_claude() {
  local file="$1" before="${2:-0}"
  tail -c "+$((before + 1))" "$file" 2> /dev/null | node "$MEM_HL_HELPER" old-claude -
}
