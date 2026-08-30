#!/usr/bin/env bash
# install/claude-code.sh — installs cheap-mem into Claude Code
# (user-level hooks and permissions), so every Claude Code session on
# this machine loads the memory context, and the Stop hook triggers
# the reflector.
#
# Usage:
#   CHEAP_MEM_ROOT=/absolute/path/to/memory \
#   bash install/claude-code.sh
#
# What it does:
#   1. Copies install/hooks/session-start.sh and session-stop.sh into
#      ~/.claude/hooks/ (with CHEAP_MEM_ROOT hardcoded into each).
#   2. Merges ~/.claude/settings.json — keeps existing config, adds
#      hooks entries + permissions.allow for `node <root>/bin/mem:*`
#      and safe git ops.
#
# Why user-level (~/.claude/) and not repo-level (.claude/settings.json):
#   Repo-scoped Claude Code permissions require workspace trust, which
#   ephemeral cloud clones never have. User settings apply globally
#   without a trust dialog.
#
# Idempotent — safe to re-run.

set -euo pipefail

if [ -z "${CHEAP_MEM_ROOT:-}" ]; then
  echo "error: env CHEAP_MEM_ROOT missing" >&2
  exit 2
fi
CHEAP_MEM_ROOT="$(cd "$CHEAP_MEM_ROOT" && pwd)"
if [ ! -f "$CHEAP_MEM_ROOT/.mem/config.json" ]; then
  echo "error: $CHEAP_MEM_ROOT/.mem/config.json not found — run 'mem init' first" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_HOME/hooks"
SETTINGS="$CLAUDE_HOME/settings.json"

mkdir -p "$HOOKS_DIR"

# Copy hooks, injecting CHEAP_MEM_ROOT so they work regardless of the
# calling shell's env.
{
  echo "#!/usr/bin/env bash"
  echo "export CHEAP_MEM_ROOT='${CHEAP_MEM_ROOT}'"
  tail -n +2 "$HERE/hooks/session-start.sh"
} > "$HOOKS_DIR/cheap-mem-session-start.sh"
chmod +x "$HOOKS_DIR/cheap-mem-session-start.sh"

{
  echo "#!/usr/bin/env bash"
  echo "export CHEAP_MEM_ROOT='${CHEAP_MEM_ROOT}'"
  tail -n +2 "$HERE/hooks/session-stop.sh"
} > "$HOOKS_DIR/cheap-mem-session-stop.sh"
chmod +x "$HOOKS_DIR/cheap-mem-session-stop.sh"

# Merge settings.json without touching unrelated config.
node - "$SETTINGS" "$HOOKS_DIR" "$CHEAP_MEM_ROOT" <<'NODE_MERGE'
const fs = require('fs');
const path = require('path');
const [, , settingsPath, hooksDir, memRoot] = process.argv;

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch {}

cfg.hooks = cfg.hooks || {};
function upsertHook(event, cmd) {
  cfg.hooks[event] = cfg.hooks[event] || [];
  cfg.hooks[event] = cfg.hooks[event].filter((entry) => {
    if (!entry.hooks) return true;
    return !entry.hooks.some((h) => h.command && h.command.includes(hooksDir) && h.command.includes('cheap-mem'));
  });
  cfg.hooks[event].push({ hooks: [{ type: 'command', command: cmd }] });
}
upsertHook('SessionStart', path.join(hooksDir, 'cheap-mem-session-start.sh'));
upsertHook('Stop',         path.join(hooksDir, 'cheap-mem-session-stop.sh'));

cfg.permissions = cfg.permissions || {};
const allow = [
  'Bash(git -C:*)',
  'Bash(git pull:*)',
  'Bash(git fetch:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git ls-tree:*)',
  'Bash(git ls-files:*)',
  'Bash(git rev-parse:*)',
  `Bash(node ${memRoot}/bin/mem:*)`,
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
];
const deny = [
  'Bash(rm -rf:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git reset --hard:*)',
];
cfg.permissions.allow = Array.from(new Set([...(cfg.permissions.allow || []), ...allow]));
cfg.permissions.deny  = Array.from(new Set([...(cfg.permissions.deny  || []), ...deny]));

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`[install] ${settingsPath} updated`);
NODE_MERGE

echo ""
echo "=== done ==="
echo "hooks:    $HOOKS_DIR/cheap-mem-session-{start,stop}.sh"
echo "settings: $SETTINGS"
echo ""
echo "Next Claude Code session on this machine:"
echo "  - SessionStart hook prints FACTS.md + mem context"
echo "  - Stop hook triggers mem-reflect (byte-delta throttled)"
