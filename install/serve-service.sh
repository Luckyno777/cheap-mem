#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# install/serve-service.sh — run `mem serve` (the dashboard AND the warm
# recall server, M10) as a user service. OPTIONAL: the installers ask,
# and the default answer is no.
#
# Usage:
#   CHEAP_MEM_ROOT=/absolute/path/to/memory bash install/serve-service.sh install
#   bash install/serve-service.sh uninstall
#
# Linux: a systemd USER unit ~/.config/systemd/user/cheap-mem-serve.service
# macOS: a launchd agent ~/Library/LaunchAgents/com.cheap-mem.serve.plist
# Windows: install/windows.ps1 -ServeService (a scheduled task at logon).
#
# What the service opens: the dashboard on 127.0.0.1:8847 (no token ->
# localhost only, see `mem serve --help`) and a Unix socket under
# <memory>/.pipeline/recall/ (mode 0700 directory, 0600 key). No other
# port. The recall hook (bin/mem-retrieve) uses the socket when it is
# there and runs `mem find` directly when it is not — stopping or
# removing this service never breaks recall, it only makes it cold again.
#
# Uninstall removes the unit/agent file and stops the service; nothing
# else on the machine is touched.

set -euo pipefail

MODE="${1:-}"
case "$MODE" in install|uninstall) ;; *)
  echo "usage: bash install/serve-service.sh install|uninstall" >&2
  exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/cheap-mem-serve.service"
LABEL="com.cheap-mem.serve"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ "$MODE" = uninstall ]; then
  if [ "$OS" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $PLIST"
  else
    systemctl --user disable --now cheap-mem-serve.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "removed $UNIT"
  fi
  exit 0
fi

if [ -z "${CHEAP_MEM_ROOT:-}" ]; then
  echo "error: env CHEAP_MEM_ROOT missing" >&2
  exit 2
fi
CHEAP_MEM_ROOT="$(cd "$CHEAP_MEM_ROOT" && pwd)"
if [ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ]; then
  echo "error: $CHEAP_MEM_ROOT/.mem/config.json not found — run 'mem init' first" >&2
  exit 2
fi
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not on PATH" >&2
  exit 2
fi

if [ "$OS" = Darwin ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${HERE}/bin/mem</string>
    <string>--root</string>
    <string>${CHEAP_MEM_ROOT}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHEAP_MEM_ROOT</key>
    <string>${CHEAP_MEM_ROOT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${CHEAP_MEM_ROOT}/.mem/serve.log</string>
  <key>StandardErrorPath</key>
  <string>${CHEAP_MEM_ROOT}/.mem/serve.log</string>
</dict>
</plist>
PLIST_EOF
  echo "wrote $PLIST"
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl enable "gui/$(id -u)/${LABEL}"
  echo "status:    launchctl print gui/$(id -u)/${LABEL} | head"
  echo "uninstall: bash $HERE/install/serve-service.sh uninstall"
  exit 0
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=cheap-mem dashboard and warm recall server (mem serve)

[Service]
Type=simple
Environment=CHEAP_MEM_ROOT=${CHEAP_MEM_ROOT}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE_BIN")
ExecStart=${NODE_BIN} ${HERE}/bin/mem --root ${CHEAP_MEM_ROOT} serve
Restart=on-failure
RestartSec=15
StandardOutput=append:${CHEAP_MEM_ROOT}/.mem/serve.log
StandardError=append:${CHEAP_MEM_ROOT}/.mem/serve.log

[Install]
WantedBy=default.target
UNIT_EOF
echo "wrote $UNIT"
systemctl --user daemon-reload
systemctl --user enable --now cheap-mem-serve.service
echo "status:    systemctl --user status cheap-mem-serve"
echo "uninstall: bash $HERE/install/serve-service.sh uninstall"
