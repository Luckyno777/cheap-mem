#!/usr/bin/env bash
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

echo ""
echo "=== done ==="
echo "status:  systemctl --user status cheap-mem-watch"
echo "logs:    tail -f $CHEAP_MEM_ROOT/.mem/watch.log"
echo ""
echo "To survive logout (start on boot without an active session):"
echo "  sudo loginctl enable-linger \$USER"
