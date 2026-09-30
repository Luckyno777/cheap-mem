#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# install/macos.sh — install cheap-mem watcher as a macOS launchd
# service. Starts at login, restarts on failure.
#
# Usage:
#   CHEAP_MEM_ROOT=/absolute/path/to/memory \
#   MEM_WATCH_WHO=librarian \
#   bash install/macos.sh
#
# Uninstall:
#   launchctl bootout gui/$UID ~/Library/LaunchAgents/com.cheap-mem.watch.plist
#   rm ~/Library/LaunchAgents/com.cheap-mem.watch.plist
#   bash install/serve-service.sh uninstall   (the optional `mem serve` service)

set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: this script is for macOS. On Linux use install/linux.sh" >&2
  exit 2
fi
if [ -z "${CHEAP_MEM_ROOT:-}" ]; then
  echo "error: env CHEAP_MEM_ROOT missing" >&2
  exit 2
fi
if [ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ]; then
  echo "error: $CHEAP_MEM_ROOT/.mem/config.json not found — run 'mem init' first" >&2
  exit 2
fi
if [ -z "${MEM_WATCH_WHO:-}" ]; then
  echo "error: env MEM_WATCH_WHO missing" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not on PATH" >&2
  exit 2
fi

LABEL="com.cheap-mem.watch"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/${LABEL}.plist"
mkdir -p "$PLIST_DIR"

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
    <string>/bin/bash</string>
    <string>${HERE}/bin/mem-watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHEAP_MEM_ROOT</key>
    <string>${CHEAP_MEM_ROOT}</string>
    <key>MEM_WATCH_WHO</key>
    <string>${MEM_WATCH_WHO}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$(dirname "$NODE_BIN")</string>
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
  <string>${CHEAP_MEM_ROOT}/.mem/watch.log</string>
  <key>StandardErrorPath</key>
  <string>${CHEAP_MEM_ROOT}/.mem/watch.log</string>
</dict>
</plist>
PLIST_EOF

echo "wrote $PLIST"

# Bootout first (in case previously loaded), then bootstrap.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

# --- Optional: `mem serve` as a service (M10) -----------------------------
#
# The dashboard plus the warm recall server (recall answered by a running
# process instead of a fresh `node` per turn). OFF unless asked for:
# CHEAP_MEM_SERVE_SERVICE=yes|no answers without a prompt; otherwise an
# interactive shell is asked, and anything but "y" keeps it off. A
# non-interactive run (CI, a pipe) never installs it.
want_serve=no
case "${CHEAP_MEM_SERVE_SERVICE:-}" in
  yes|1) want_serve=yes ;;
  no|0) want_serve=no ;;
  *)
    if [ -t 0 ]; then
      printf "Also run 'mem serve' (dashboard + warm recall) as a user service? [y/N] "
      read -r answer || answer=""
      case "$answer" in y|Y|yes|YES) want_serve=yes ;; esac
    fi ;;
esac
if [ "$want_serve" = yes ]; then
  bash "$HERE/install/serve-service.sh" install
else
  echo "mem serve service: not installed (default). Later: bash $HERE/install/serve-service.sh install"
fi

echo ""
echo "=== done ==="
echo "status:  launchctl print gui/$(id -u)/${LABEL} | head"
echo "logs:    tail -f $CHEAP_MEM_ROOT/.mem/watch.log"
