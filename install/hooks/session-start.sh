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

# **"attached" only when the tool is reachable (Z1c, external brief
# 2026-09-30).** The header used to be printed as soon as a memory
# directory was found. With a memory that has no `bin/mem` (a checkout
# apart from the tool, a partial clone) every `mem` call below is skipped
# and the session got NO context, no alarm and no today line - under a
# header that said it was attached. "Found the directory" and "can read
# it" are two facts; the header states the one that is true, and says
# what is unknown.
if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  echo "=== cheap-mem attached ==="
else
  echo "=== cheap-mem NOT attached: memory found at $CHEAP_MEM_ROOT, but the tool ($CHEAP_MEM_ROOT/bin/mem) is missing ==="
  echo "Recent context, alarm state and today line: UNKNOWN (not loaded, not 'nothing')."
  echo "Fix: check out the tool into that memory, or point CHEAP_MEM_ROOT at one that has it."
fi
echo ""

# Best-effort: bring the memory up to date, and force main so a
# feature-branch checkout doesn't misroute later writes.
git -C "$CHEAP_MEM_ROOT" fetch origin main 2>&1 | tail -1 || true
if git -C "$CHEAP_MEM_ROOT" rev-parse --verify main >/dev/null 2>&1; then
  git -C "$CHEAP_MEM_ROOT" checkout main 2>&1 | tail -1 || true
else
  git -C "$CHEAP_MEM_ROOT" checkout -B main origin/main 2>&1 | tail -1 || true
fi
git -C "$CHEAP_MEM_ROOT" pull --ff-only 2>&1 | tail -1 || true

echo ""
if [ -f "$CHEAP_MEM_ROOT/FACTS.md" ]; then
  echo "=== FACTS (always loaded) ==="
  cat "$CHEAP_MEM_ROOT/FACTS.md"
  echo ""
fi

if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  echo "=== mem context ==="
  node "$CHEAP_MEM_ROOT/bin/mem" context --n 10 2>/dev/null || true
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
if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  MEM_USER_HABITS="$(node "$CHEAP_MEM_ROOT/bin/mem" user --session-start 2>/dev/null || true)"
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
if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  if command -v timeout >/dev/null 2>&1; then
    MEM_ALARM="$(timeout "${MEM_ALARM_SECONDS:-8}" node "$CHEAP_MEM_ROOT/bin/mem" doctor --alarm 2>/dev/null)"
  else
    MEM_ALARM="$(node "$CHEAP_MEM_ROOT/bin/mem" doctor --alarm 2>/dev/null)"
  fi
  MEM_ALARM_RC=$?
  if [ -n "$MEM_ALARM" ]; then
    echo "=== DOWN RIGHT NOW (mem doctor --alarm) ==="
    echo "$MEM_ALARM"
    echo ""
  elif [ "$MEM_ALARM_RC" -eq 124 ]; then
    echo "=== DOWN RIGHT NOW ==="
    echo "The alarm hit its time cap (${MEM_ALARM_SECONDS:-8}s) — NOT checked."
    echo "By hand: node $CHEAP_MEM_ROOT/bin/mem doctor --quiet"
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
if [ -f "$CHEAP_MEM_ROOT/bin/mem" ]; then
  if command -v timeout >/dev/null 2>&1; then
    MEM_TODAY="$(timeout "${MEM_TODAY_SECONDS:-5}" node "$CHEAP_MEM_ROOT/bin/mem" today --line 2>/dev/null)"
  else
    MEM_TODAY="$(node "$CHEAP_MEM_ROOT/bin/mem" today --line 2>/dev/null)"
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
for MEM_SS_CODE in "${CHEAP_MEM_CODE:-}" "$CHEAP_MEM_ROOT"; do
  [ -n "$MEM_SS_CODE" ] && [ -f "$MEM_SS_CODE/src/injection.mjs" ] && break
  MEM_SS_CODE=""
done
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
  node $CHEAP_MEM_ROOT/bin/mem log event    --title "..." --tags ...
  node $CHEAP_MEM_ROOT/bin/mem log decision --topic "..." --choice ... --why ...
  node $CHEAP_MEM_ROOT/bin/mem log error    --class ... --title "..." --text ...

Look for known context before asking:
  node $CHEAP_MEM_ROOT/bin/mem find "..."

Send an inbox message (delivered after commit + push):
  node $CHEAP_MEM_ROOT/bin/mem inbox write --as session --to librarian --subject "..." < body.md

The Stop hook (session-stop.sh) will reflect automatically once the
transcript grows past the byte-delta threshold.
HINTS
