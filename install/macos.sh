#!/usr/bin/env bash
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

echo ""
echo "=== done ==="
echo "status:  launchctl print gui/$(id -u)/${LABEL} | head"
echo "logs:    tail -f $CHEAP_MEM_ROOT/.mem/watch.log"
