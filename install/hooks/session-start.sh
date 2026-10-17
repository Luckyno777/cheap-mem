#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# session-start.sh — Claude Code SessionStart hook.
#
# Copy to ~/.claude/hooks/session-start.sh and register in
# ~/.claude/settings.json under hooks.SessionStart (see install/claude-code.sh
# for the merge script).
#
# Prints the memory context at the start of every session so the model
# knows where to look, without needing to grep the whole repo.

set -u
[ "${MEM_HOOK_OFF:-}" = "1" ] && exit 0

# Hook time starts here — the journal line at the bottom carries it.
if [ -n "${EPOCHREALTIME:-}" ]; then
  _s="${EPOCHREALTIME%.*}"; _f="${EPOCHREALTIME#*.}"
  MEM_SS_START_MS="${_s}${_f:0:3}"
  unset _s _f
else
  MEM_SS_START_MS="$(( $(date +%s) * 1000 ))"
fi

# The hook JSON (session id, source) — read for the journal line only.
# Capped: a start hook must never wait on a stdin nobody closes.
MEM_SS_IN=""
if [ ! -t 0 ]; then
  if command -v timeout >/dev/null 2>&1; then MEM_SS_IN="$(timeout 2 cat 2>/dev/null || true)"
  else MEM_SS_IN="$(cat 2>/dev/null || true)"; fi
fi

# Resolve the memory instead of trusting a baked-in path.
#
# **The finding (2026-09-08, second machine.)** The installer wrote the
# absolute path of the FIRST machine into the hook. On the second one
# that directory does not exist, so the hook fell through the check
# below and exited 0 — no memory, no error, no clue. The session simply
# started without knowing anything, and looked exactly like a session
# that had nothing to know.
#
# Two changes. The path is now LOOKED UP, and a failed lookup SAYS SO.
# `MEM_HOOK_OFF=1` stays the one silent exit, because that one is a
# decision somebody made on purpose.
mem_root=""
for candidate in \
  "${CHEAP_MEM_ROOT:-}" \
  "$HOME/cheap-mem" \
  "$HOME/my-memory" \
  "$HOME/.cheap-mem" \
  "$HOME/memory"
do
  [ -n "$candidate" ] || continue
  if [ -f "$candidate/.mem/config.json" ]; then mem_root="$candidate"; break; fi
done

if [ -z "$mem_root" ]; then
  echo "cheap-mem: no memory found - this session starts WITHOUT it." >&2
  if [ -n "${CHEAP_MEM_ROOT:-}" ]; then
    echo "  CHEAP_MEM_ROOT=$CHEAP_MEM_ROOT (no .mem/config.json there)" >&2
  else
    echo "  CHEAP_MEM_ROOT is not set" >&2
  fi
  echo "  Looked in: \$HOME/cheap-mem, \$HOME/my-memory, \$HOME/.cheap-mem, \$HOME/memory" >&2
  echo "  Fix: clone the memory and set CHEAP_MEM_ROOT to it, or run install/claude-code.sh again." >&2
  exit 0
fi
CHEAP_MEM_ROOT="$mem_root"
export CHEAP_MEM_ROOT

# **Where the TOOL is (hook-shims fix, 2026-10-16; trust rule tool-trust-cm,
# 2026-10-16).** The memory and the code are two checkouts as often as one: a
# memory made by `mem init` carries no `bin/mem`, and the installer then tells
# every shim where the code lives (CHEAP_MEM_CODE, see install/claude-code.sh).
# The order is: the INSTALLED tool (CHEAP_MEM_CODE), else the tool next to this
# hook. The memory's own `bin/mem` only when the user switched that on, locally
# (`mem trust-own-tool`): the memory is a git clone pulled from origin, so code
# taken from it is code its remote can ship. cheap-mem-own-tool.sh (a copy of
# bin/_owntool.sh) holds the rule. Nothing found: mem_bin stays empty and the
# header below says so.
SS_HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=bin/_owntool.sh
for own_lib in "$SS_HERE/cheap-mem-own-tool.sh" "$SS_HERE/../../bin/_owntool.sh"; do
  [ "$own_lib" = "$SS_HERE/cheap-mem-own-tool.sh" ] || [ -d "$SS_HERE/../support" ] || continue
  [ -f "$own_lib" ] && { . "$own_lib"; break; }
done
unset own_lib
mem_picked=""; MEM_OWN_SKIPPED=0
if type mem_pick_tool >/dev/null 2>&1; then
  mem_pick_tool "$CHEAP_MEM_ROOT" bin/mem "$SS_HERE"
fi
mem_bin="$mem_picked"
# A memory that ships its own tool without the switch is not an error, but it
# is not silent either: the session is told, once (this hook runs once per
# session), which tool it got and how to change that.
own_tool_note=""
if type mem_own_ships >/dev/null 2>&1 && ! mem_own_tool_trusted "$CHEAP_MEM_ROOT" \
   && { [ "$MEM_OWN_SKIPPED" = "1" ] || mem_own_ships "$CHEAP_MEM_ROOT"; }; then
  if [ -n "$mem_bin" ]; then
    own_tool_note="memory ships its own tool; using the installed one. To trust it: mem trust-own-tool"
  else
    own_tool_note="memory ships its own tool and no installed tool was found; nothing is loaded. To trust it: mem trust-own-tool"
  fi
fi
# What the hints and the time-cap line show; set here, before anything uses it
# (set -u: a variable first set at the bottom broke the cap branch, 2026-10-16).
mem_show="${mem_bin:-${CHEAP_MEM_CODE:-<installed cheap-mem>}/bin/mem}"

# R6: a V8 compile cache for the node starts below (context, habits, alarm,
# today, journal - five in a row). Inline twin of bin/_portable.sh
# `mem_compile_cache` (this hook is installed alone): in the USER's cache,
# never in the memory; a value the user set stays; a directory that cannot
# be made means no cache, never a silent hook. test/hook-compile-cache.test.mjs
# holds both to the same directory.
if [ -z "${NODE_COMPILE_CACHE:-}" ]; then
  mem_cc_base=""
  case "$(uname -s 2>/dev/null)" in
    Darwin) [ -n "${HOME:-}" ] && mem_cc_base="$HOME/Library/Caches" ;;
    MINGW*|MSYS*|CYGWIN*) mem_cc_base="${LOCALAPPDATA:-}"; mem_cc_base="${mem_cc_base//\\//}" ;;
    *)
      case "${XDG_CACHE_HOME:-}" in
        /*) mem_cc_base="$XDG_CACHE_HOME" ;;
        *) [ -n "${HOME:-}" ] && mem_cc_base="$HOME/.cache" ;;
      esac ;;
  esac
  if [ -n "$mem_cc_base" ]; then
    mem_cc_dir="$mem_cc_base/cheap-mem/node-cc"
    [ -d "$mem_cc_dir" ] || (umask 077; mkdir -p "$mem_cc_dir") 2>/dev/null
    [ -d "$mem_cc_dir" ] && export NODE_COMPILE_CACHE="$mem_cc_dir"
  fi
fi

# **"attached" only when the tool is reachable (Z1c, external brief
# 2026-09-30).** The header used to be printed as soon as a memory
# directory was found. With a memory that has no `bin/mem` (a checkout
# apart from the tool, a partial clone) every `mem` call below is skipped
# and the session got NO context, no alarm and no today line - under a
# header that said it was attached. "Found the directory" and "can read
# it" are two facts; the header states the one that is true, and says
# what is unknown.
if [ -n "$mem_bin" ]; then
  echo "=== cheap-mem attached ==="
else
  mem_code_none="not set"; [ -z "${MEM_CODE_REJECTED:-}" ] || mem_code_none="rejected, see below"
  echo "=== cheap-mem NOT attached: memory found at $CHEAP_MEM_ROOT, but no tool to read it with (installed: ${CHEAP_MEM_CODE:-$mem_code_none}) ==="
  echo "Recent context, alarm state and today line: UNKNOWN (not loaded, not 'nothing')."
  if [ -n "${CHEAP_MEM_CODE:-}" ]; then
    # The installer baked a code path in. Name it: a checkout that was moved
    # or deleted silences UserPromptSubmit, PreToolUse, SubagentStart and Stop
    # too - this line is the one place a person sees it at the start.
    echo "The code path baked in by the installer has no tool: CHEAP_MEM_CODE=$CHEAP_MEM_CODE (nothing under bin/ there)."
    echo "The other hooks (prompt recall, before-edit, subagent, stop) are SILENT for the same reason."
    echo "Fix: run install/claude-code.sh from a current cheap-mem checkout: CHEAP_MEM_ROOT=$CHEAP_MEM_ROOT bash <checkout>/install/claude-code.sh (or mem setup claude)."
  elif [ -n "${MEM_CODE_REJECTED:-}" ]; then
    # bin/_owntool.sh (mem_code_clean) threw the value out: it held a control character. Printable form only.
    echo "The code path baked in by the installer was REJECTED: CHEAP_MEM_CODE holds a control character (a line break, tab or escape; value: $MEM_CODE_REJECTED), so no tool was run from it."
    echo "The other hooks (prompt recall, before-edit, subagent, stop) are SILENT for the same reason."
    echo "Fix: run install/claude-code.sh from a current cheap-mem checkout: CHEAP_MEM_ROOT=$CHEAP_MEM_ROOT bash <checkout>/install/claude-code.sh (or mem setup claude)."
  else
    echo "Fix: run install/claude-code.sh from a cheap-mem checkout (it sets CHEAP_MEM_CODE and installs the tool the hooks run)."
    echo "A tool inside the memory is not run unless you trust that memory yourself (mem trust-own-tool)."
  fi
fi
if [ -n "$own_tool_note" ]; then
  echo "[hook] cheap-mem: $own_tool_note"
  echo "[hook]   (run it yourself in a terminal: node ${CHEAP_MEM_CODE:-<installed cheap-mem>}/bin/mem trust-own-tool --root $CHEAP_MEM_ROOT; why: docs/security-model.md)"
fi
echo ""

# Which remote and branch does this memory TRACK? `.mem/config.json` says
# (defaultRemote / defaultBranch, the keys mem-watch reads). This block used
# to fetch `origin main`, check out `main` and pull, whatever the memory said:
# a clone on `develop` came out of a session start on a NEW local `main`
# tracking origin/main, and every later write went to the wrong branch
# (reproduced 2026-10-14, test/tracked-ref.test.mjs). Inline twin of
# bin/_portable.sh `mem_tracked_ref` (this hook is installed alone, with no
# _portable.sh next to it); the test runs both over the same cases. The
# config is DATA out of a cloned repository: only a plain name goes to git.
mem_remote="origin"; mem_branch="main"; mem_track_note=""
# The refused value is shown clipped (40 characters, printable ASCII only): it is data out of a file, and it is printed.
mem_clip() {
  c="$(printf '%s' "$1" | LC_ALL=C tr -cd '\040-\176' | cut -c1-40)"
  [ "${#1}" -gt 40 ] && c="$c..."
  printf '%s' "$c"
}
mem_cfg="$CHEAP_MEM_ROOT/.mem/config.json"
if [ -f "$mem_cfg" ]; then
  v="$(grep -o '"defaultRemote"[[:space:]]*:[[:space:]]*"[^"]*"' "$mem_cfg" 2>/dev/null | head -n 1 | sed 's/^[^:]*:[[:space:]]*"\(.*\)"$/\1/')"
  if [ -n "$v" ]; then
    case "$v" in
      [!A-Za-z0-9]*|*[!A-Za-z0-9._-]*|*..*) mem_track_note="config defaultRemote '$(mem_clip "$v")' is not a plain remote name - using origin" ;;
      *)
        # N5: a name that is no remote of this clone would be read by git as a path or URL.
        if git -C "$CHEAP_MEM_ROOT" rev-parse --git-dir >/dev/null 2>&1 && ! git -C "$CHEAP_MEM_ROOT" remote get-url -- "$v" >/dev/null 2>&1; then
          # N5-1: origin stays either way, so a warning is only for a value somebody SET against a clone that has remotes.
          if [ "$v" != origin ] && [ -n "$(git -C "$CHEAP_MEM_ROOT" remote 2>/dev/null)" ]; then
            mem_track_note="config defaultRemote '$(mem_clip "$v")' is not a remote of this clone - using origin"
          fi
        else mem_remote="$v"; fi ;;
    esac
  fi
  v="$(grep -o '"defaultBranch"[[:space:]]*:[[:space:]]*"[^"]*"' "$mem_cfg" 2>/dev/null | head -n 1 | sed 's/^[^:]*:[[:space:]]*"\(.*\)"$/\1/')"
  if [ -n "$v" ]; then
    case "$v" in
      [!A-Za-z0-9]*|*/|*//*|*..*|*.lock|*[!A-Za-z0-9._/-]*) mem_track_note="${mem_track_note:+$mem_track_note; }config defaultBranch '$(mem_clip "$v")' is not a plain branch name - using main" ;;
      *) mem_branch="$v" ;;
    esac
  fi
fi
[ -n "$mem_track_note" ] && echo "[hook] WARNING: $mem_track_note"

# Best-effort: bring the memory up to date, and put it on the branch it
# tracks so a feature-branch checkout doesn't misroute later writes.
#
# The explicit refspec keeps refs/remotes/<remote>/<branch> current even in a
# clone that has no tracking ref (a single-URL or shallow clone), and the
# count of commits behind below reads exactly that ref.
fetch_out="$(git -C "$CHEAP_MEM_ROOT" fetch "$mem_remote" "$mem_branch" "+$mem_branch:refs/remotes/$mem_remote/$mem_branch" 2>&1)"; fetch_rc=$?
[ -n "$fetch_out" ] && printf '%s\n' "$fetch_out" | tail -n 1
if git -C "$CHEAP_MEM_ROOT" rev-parse --verify "refs/heads/$mem_branch" >/dev/null 2>&1; then
  git -C "$CHEAP_MEM_ROOT" checkout "$mem_branch" 2>&1 | tail -1 || true
else
  git -C "$CHEAP_MEM_ROOT" checkout -B "$mem_branch" "$mem_remote/$mem_branch" 2>&1 | tail -1 || true
fi
git -C "$CHEAP_MEM_ROOT" pull --ff-only "$mem_remote" "$mem_branch" 2>&1 | tail -1 || true

# AU1 (lucky-mem parity): if the clone is STILL behind its tracked branch after the
# pull, the session is about to read an OLD memory - say so loudly, with the
# rescue path from the doctor finding (hook-root-stranded), and reset
# NOTHING. An automatic `reset --hard` would throw away exactly the captures
# the rescue path exists to save. Only after a successful fetch: without a
# fresh origin the "behind" count is unknown, and the line above says so.
if [ "$fetch_rc" -eq 0 ]; then
  behind_n="$(git -C "$CHEAP_MEM_ROOT" rev-list --count "HEAD..$mem_remote/$mem_branch" 2>/dev/null)"
  if [ -n "$behind_n" ] && [ "$behind_n" -gt 0 ] 2>/dev/null; then
    ahead_n="$(git -C "$CHEAP_MEM_ROOT" rev-list --count "$mem_remote/$mem_branch..HEAD" 2>/dev/null)"
    echo "[hook] ================================================================"
    if [ -n "$ahead_n" ] && [ "$ahead_n" -gt 0 ] 2>/dev/null; then
      echo "[hook] MEMORY STATE OLD: $behind_n commits behind $mem_remote/$mem_branch, $ahead_n only local (diverged)."
    else
      echo "[hook] MEMORY STATE OLD: $behind_n commits behind $mem_remote/$mem_branch (fast-forward failed)."
    fi
    echo "[hook] This session reads the OLD state: newer entries, errors and decisions are missing."
    echo "[hook] The hook resets nothing (no reset --hard: that would throw local work away)."
    if [ -n "$ahead_n" ] && [ "$ahead_n" -gt 0 ] 2>/dev/null; then
      echo "[hook] Rescue path (mem doctor, finding hook-root-stranded): do not rebase/merge (diverged): create a"
      echo "[hook]   separate worktree from $mem_remote/$mem_branch (git -C $CHEAP_MEM_ROOT worktree add --detach <place> $mem_remote/$mem_branch),"
      echo "[hook]   copy raw/ and raw-record.jsonl from $CHEAP_MEM_ROOT over there, commit and push there -"
      echo "[hook]   only THEN bring $CHEAP_MEM_ROOT up to the new $mem_remote/$mem_branch with fetch + reset --hard."
    else
      echo "[hook] Rescue path: secure local changes in $CHEAP_MEM_ROOT (git -C $CHEAP_MEM_ROOT status), then"
      echo "[hook]   git -C $CHEAP_MEM_ROOT merge --ff-only $mem_remote/$mem_branch; the finding is hook-root-stranded (mem doctor)."
    fi
    echo "[hook] ================================================================"
    echo ""
  fi
fi

# AU1 addendum: the git identity of the memory clone. Without its own, every
# session commits under the global one (a placeholder identity in cloud
# sessions) and GitHub may show the commits as Unverified. Set ONLY when the
# clone itself (--local) has none AND an explicit source exists:
# CHEAP_MEM_GIT_EMAIL + CHEAP_MEM_GIT_NAME, both. Nothing is invented or
# guessed from the memory's contents; without a source the line says so.
if [ -d "$CHEAP_MEM_ROOT/.git" ] \
   && [ -z "$(git -C "$CHEAP_MEM_ROOT" config --local --get user.email 2>/dev/null)" ] \
   && [ -z "$(git -C "$CHEAP_MEM_ROOT" config --local --get user.name 2>/dev/null)" ]; then
  id_mail="${CHEAP_MEM_GIT_EMAIL:-}"
  id_name="${CHEAP_MEM_GIT_NAME:-}"
  nl='
'
  case "$id_mail$id_name" in *"$nl"*|*'<'*|*'>'*) id_mail=""; id_name="" ;; esac
  if [ -n "$id_mail" ] && [ -n "$id_name" ]; then
    if git -C "$CHEAP_MEM_ROOT" config --local user.email "$id_mail" 2>/dev/null \
       && git -C "$CHEAP_MEM_ROOT" config --local user.name "$id_name" 2>/dev/null; then
      echo "[hook] git identity set in the clone (from CHEAP_MEM_GIT_EMAIL/CHEAP_MEM_GIT_NAME): $id_name <$id_mail>"
    else
      echo "[hook] WARNING: could not set the git identity in the clone - commits may show as Unverified on GitHub"
    fi
  else
    id_effective="$(git -C "$CHEAP_MEM_ROOT" config --get user.email 2>/dev/null)"
    echo "[hook] WARNING: the clone has no git identity and there is no source (CHEAP_MEM_GIT_EMAIL + CHEAP_MEM_GIT_NAME)."
    echo "[hook]   Commits go out as ${id_effective:-<no identity at all>} and may show as Unverified on GitHub."
    echo "[hook]   Fix: set both variables in the environment; the hook adopts them at the next start."
  fi
fi

# Where the code lives: the memory itself, or the separate checkout the installer told us about
# (CHEAP_MEM_CODE) - the journal line at the end and the clone line below load src/ from there.
# The memory's own copy only with the switch (tool-trust-cm; bin/_owntool.sh decides).
MEM_SS_CODE=""
if type mem_pick_tool >/dev/null 2>&1; then
  mem_pick_tool "$CHEAP_MEM_ROOT" src/injection.mjs "$SS_HERE"
  [ -n "$mem_picked" ] && MEM_SS_CODE="${mem_picked%/src/injection.mjs}"
fi

# --- Which clone answers (D-B: src/provenance.mjs as a gate) -----------
#
# This memory exists more than once - a clone on the server, one per container, one per cloud session -
# and they all look alike and answer willingly. One line names the one that answers HERE: its directory, its
# state and age, how far behind origin, whether the tree is dirty (then the recall hook does not pull). Always,
# at the start: that is where the question is answered before anybody asks it. During the session the recall
# hook adds the same line only when the clone is STALE (src/clonegate.mjs). Best-effort and silent when the
# code is not there: a missing line is not "fresh", and the next lines say what is attached.
if [ -n "$MEM_SS_CODE" ] && [ -f "$MEM_SS_CODE/src/provenance.mjs" ]; then
  mem_clone_line="$(MEM_SS_PROV="$MEM_SS_CODE/src/provenance.mjs" node -e '
    import(require("node:url").pathToFileURL(process.env.MEM_SS_PROV).href).then((m) => {
      process.stdout.write(m.asLine(m.provenance(process.env.CHEAP_MEM_ROOT)));
    }).catch(() => {});' 2>/dev/null || true)"
  [ -n "$mem_clone_line" ] && echo "$mem_clone_line"
fi

echo ""
if [ -f "$CHEAP_MEM_ROOT/FACTS.md" ]; then
  echo "=== FACTS (always loaded) ==="
  cat "$CHEAP_MEM_ROOT/FACTS.md"
  echo ""
fi

if [ -n "$mem_bin" ]; then
  echo "=== mem context ==="
  node "$mem_bin" context --n 10 2>/dev/null || true
  echo ""
fi

# --- How the human user works, measured (parity with lucky-mem N2) ---
#
# `mem user --session-start` (src/userhabits.mjs, `sessionStartLines()`)
# is a generic, English, code-only habit meter over the user's OWN
# captured transcripts — no name, no phrase belonging to any one person.
# It already enforces every guarantee this line needs, so the hook adds
# NOTHING beyond calling it and deciding whether to print what came
# back:
#   - at most 5 lines total, header included (SESSION_START_MAX_LINES);
#   - only patterns/metrics at or above MIN_EVIDENCE_DISPLAY (8 hits,
#     deliberately higher than the 5-hit measurement threshold — a line
#     shown on EVERY session start is a stronger claim than a row in
#     `mem user`'s own table) AND actionable (a session can act on a
#     habit, not on when it happens to be called — see the module doc
#     for why "UTC hour-of-day" never appears here);
#   - captured into a variable first, the same shape as MEM_ALARM below:
#     "not enough evidence yet" and "no capture readable at all" both
#     come back as an EMPTY string, and an empty string prints nothing —
#     silence, never the false claim "no habits".
if [ -n "$mem_bin" ]; then
  MEM_USER_HABITS="$(node "$mem_bin" user --session-start 2>/dev/null || true)"
  if [ -n "$MEM_USER_HABITS" ]; then
    echo "$MEM_USER_HABITS"
    echo ""
  fi
fi

# --- What is down right now ------------------------------------------
#
# **Why (2026-09-17).** On the sibling house's machine a VM reboot wiped
# three systemd units together with a door secret — that OS keeps /etc
# on an overlay backed by /tmp. Dashboard, mail poller and a public
# server were down for 52 minutes. `mem doctor` had the answer the whole
# time: two findings at level ERROR, both correct. Nobody heard them,
# because the doctor only runs when someone types it.
#
# `--alarm` prints level ERROR only, and prints NOTHING when nothing is
# red — which is why there is no `echo` outside the `if`. A banner that
# appears on every start is background within three days.
#
# The cap reports its own expiry. `timeout` returns 124; without that
# branch "timed out" looks exactly like "all fine", and that confusion
# is what carried the outage above for so long. Where `timeout` does not
# exist the check runs uncapped rather than silently not at all.
if [ -n "$mem_bin" ]; then
  if command -v timeout >/dev/null 2>&1; then
    MEM_ALARM="$(timeout "${MEM_ALARM_SECONDS:-8}" node "$mem_bin" doctor --alarm 2>/dev/null)"
  else
    MEM_ALARM="$(node "$mem_bin" doctor --alarm 2>/dev/null)"
  fi
  MEM_ALARM_RC=$?
  if [ -n "$MEM_ALARM" ]; then
    echo "=== DOWN RIGHT NOW (mem doctor --alarm) ==="
    echo "$MEM_ALARM"
    echo ""
  elif [ "$MEM_ALARM_RC" -eq 124 ]; then
    echo "=== DOWN RIGHT NOW ==="
    echo "The alarm hit its time cap (${MEM_ALARM_SECONDS:-8}s) — NOT checked."
    echo "By hand: node $mem_show doctor --quiet"
    echo ""
  fi
fi

# --- "Today" (N8/N21 parity: one source, three surfaces) --------------
#
# `mem today --line` (src/today.mjs, `today()`/`line()`) — the SAME
# function `mem today` and the dashboard's Today card read, not a
# separate calculation here. `line()` returns nothing at all when there
# is nothing notable ("only when there is something", same rule the
# habit line above already follows) — so there is no bare `echo` outside
# the `if`.
#
# Own time cap, same shape as the alarm above: today() reads
# doctor.checkAll() and every open duty, and a session start must never
# hang waiting on either.
if [ -n "$mem_bin" ]; then
  if command -v timeout >/dev/null 2>&1; then
    MEM_TODAY="$(timeout "${MEM_TODAY_SECONDS:-5}" node "$mem_bin" today --line 2>/dev/null)"
  else
    MEM_TODAY="$(node "$mem_bin" today --line 2>/dev/null)"
  fi
  if [ -n "$MEM_TODAY" ]; then
    echo "$MEM_TODAY"
    echo ""
  fi
fi

# --- The journal line (X2b) -------------------------------------------
#
# The session-start occasion had no journal line: every other hook
# booked what it delivered, this one printed straight into the context
# and left no trace, so "did the start block arrive?" could not be
# answered from the journal. One line, occasion `session-start`, reason
# null (delivered); bytes and hits are not counted here (the block is
# printed in several pieces — not measured is not 0). Best-effort and
# silent: a measurement must not stop what it measures.
if [ -n "$MEM_SS_CODE" ]; then
  MEM_SS_START_MS="$MEM_SS_START_MS" MEM_SS_INPUT="$MEM_SS_IN" MEM_SS_SRC="$MEM_SS_CODE/src/injection.mjs" \
    node -e '
      import(require("node:url").pathToFileURL(process.env.MEM_SS_SRC).href).then((m) => {
        let session = null;
        try { session = String(JSON.parse(process.env.MEM_SS_INPUT).session_id || "") || null; } catch { /* no JSON: no session id */ }
        const start = Number(process.env.MEM_SS_START_MS);
        m.book(process.env.CHEAP_MEM_ROOT, {
          session, occasion: m.OCCASION.SESSION_START, reason: null,
          bytes: null, hits: 0, searched: null,
          durationMs: Number.isFinite(start) && start > 0 ? Date.now() - start : null,
        });
      }).catch(() => {});' >/dev/null 2>&1 || true
fi

cat <<HINTS
=== how to use this memory this session ===

Log substantial things as they happen:
  node $mem_show log event    --title "..." --tags ...
  node $mem_show log decision --topic "..." --choice ... --why ...
  node $mem_show log error    --class ... --title "..." --text ...

Look for known context before asking:
  node $mem_show find "..."

Send an inbox message (delivered after commit + push):
  node $mem_show inbox write --as session --to librarian --subject "..." < body.md

The Stop hook (session-stop.sh) will reflect automatically once the
transcript grows past the byte-delta threshold.
HINTS
