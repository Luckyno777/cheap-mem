#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# install/linux.sh — install cheap-mem watcher as a systemd USER service
# on Linux. Restart on failure, autostart on login (or on boot if
# `loginctl enable-linger $USER` is set).
#
# Usage:
#   CHEAP_MEM_ROOT=/absolute/path/to/memory \
#   MEM_WATCH_WHO=librarian \
#   bash install/linux.sh
#
# The script:
#   1. Verifies CHEAP_MEM_ROOT contains .mem/config.json
#   2. Writes ~/.config/systemd/user/cheap-mem-watch.service
#   3. Enables and starts the unit
#
# Uninstall:
#   systemctl --user disable --now cheap-mem-watch
#   rm ~/.config/systemd/user/cheap-mem-watch.service

set -euo pipefail

if [ -z "${CHEAP_MEM_ROOT:-}" ]; then
  echo "error: env CHEAP_MEM_ROOT missing" >&2
  echo "usage: CHEAP_MEM_ROOT=/path/to/memory MEM_WATCH_WHO=<name> bash install/linux.sh" >&2
  exit 2
fi
if [ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ]; then
  echo "error: $CHEAP_MEM_ROOT/.mem/config.json not found — run 'mem init' first" >&2
  exit 2
fi
if [ -z "${MEM_WATCH_WHO:-}" ]; then
  echo "error: env MEM_WATCH_WHO missing (participant name from .mem/config.json)" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not on PATH" >&2
  exit 2
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/cheap-mem-watch.service"
mkdir -p "$UNIT_DIR"

# What was there before this run (dash-fix4, 2026-09-28): a watcher that
# is ALREADY running keeps its old unit — and its old CHEAP_MEM_ROOT /
# MEM_WATCH_WHO — through `enable --now`, which starts only what is
# stopped. The sibling house saw exactly that: the installer said all was
# running while the service ran without its new environment. So the old
# content and the running state are taken now, and a changed unit gets a
# restart below, with the reason.
OLD_UNIT=""
[ -f "$UNIT" ] && OLD_UNIT="$(cat "$UNIT")"
WAS_ACTIVE="$(systemctl --user is-active cheap-mem-watch.service 2> /dev/null || true)"

# One-line ExecStart — multi-line with backslashes is fragile in
# systemd unit files.
cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=cheap-mem inbox watcher for ${MEM_WATCH_WHO}
After=network-online.target

[Service]
Type=simple
Environment=CHEAP_MEM_ROOT=${CHEAP_MEM_ROOT}
Environment=MEM_WATCH_WHO=${MEM_WATCH_WHO}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE_BIN")
ExecStart=/usr/bin/env bash ${HERE}/bin/mem-watch
Restart=always
RestartSec=15
StandardOutput=append:${CHEAP_MEM_ROOT}/.mem/watch.log
StandardError=append:${CHEAP_MEM_ROOT}/.mem/watch.log

[Install]
WantedBy=default.target
UNIT_EOF

echo "wrote $UNIT"

systemctl --user daemon-reload
systemctl --user enable --now cheap-mem-watch.service

if [ -n "$OLD_UNIT" ] && [ "$OLD_UNIT" != "$(cat "$UNIT")" ] && [ "$WAS_ACTIVE" = "active" ]; then
  if systemctl --user try-restart cheap-mem-watch.service; then
    echo "restarted cheap-mem-watch.service: unit changed"
  else
    echo "NOT RESTARTED cheap-mem-watch.service (unit changed) — it keeps running with the old unit" >&2
    echo "  by hand: systemctl --user restart cheap-mem-watch" >&2
    exit 1
  fi
elif [ -n "$OLD_UNIT" ] && [ "$WAS_ACTIVE" = "active" ]; then
  echo "unchanged cheap-mem-watch.service — no restart needed"
fi

echo ""
echo "=== done ==="
echo "status:  systemctl --user status cheap-mem-watch"
echo "logs:    tail -f $CHEAP_MEM_ROOT/.mem/watch.log"
echo ""
echo "To survive logout (start on boot without an active session):"
echo "  sudo loginctl enable-linger \$USER"
