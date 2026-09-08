#!/usr/bin/env bash
# install/claude-code.sh — installs cheap-mem into Claude Code
# (user-level hooks and permissions), so every Claude Code session on
# this machine loads the memory context, and the Stop hook captures the
# session model-free and persists it (push) — see bin/mem-stop.
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

# **The hook command names its interpreter, and it is not optional.**
#
# This installer used to write the bare `.sh` path as the command. That
# fails in two different ways, and we have now paid for both:
#
#   Linux/macOS — exit 126 the moment the execute bit is missing, which
#   happens by itself on a clone where core.fileMode is false. Loud, at
#   least; found in lucky-mem on 2026-09-01.
#
#   Windows — `bash` is not on the PATH that cmd.exe sees. A test run
#   through cmd did not fail, it HUNG. A UserPromptSubmit hook that
#   hangs blocks every single message until the timeout, so the memory
#   turns the assistant unusable rather than merely staying silent.
#   Reported 2026-09-07 from a fresh Windows install.
#
# So the interpreter is resolved HERE, where a working bash is proven
# to exist (this script is running in it), and written out in full.
BASH_BIN="$(command -v bash || true)"
[ -n "$BASH_BIN" ] || BASH_BIN="bash"
HOOKS_DIR_CMD="$HOOKS_DIR"
# Under Git Bash / MSYS the paths this shell uses (`/c/Users/...`) mean
# nothing to a Windows process. `cygpath` is the translator, and its
# presence is also the most reliable sign that we are on Windows.
#   -w for the executable: backslashes, the form Windows always accepts.
#   -m for the script: forward slashes, which bash reads happily and
#      which survive JSON without escaping.
if command -v cygpath >/dev/null 2>&1; then
  BASH_BIN="$(cygpath -w "$BASH_BIN")"
  HOOKS_DIR_CMD="$(cygpath -m "$HOOKS_DIR")"
fi

# Copy hooks, injecting CHEAP_MEM_ROOT so they work regardless of the
# calling shell's env.
{
  echo "#!/usr/bin/env bash"
  echo "export CHEAP_MEM_ROOT='${CHEAP_MEM_ROOT}'"
  tail -n +2 "$HERE/hooks/session-start.sh"
} > "$HOOKS_DIR/cheap-mem-session-start.sh"
chmod +x "$HOOKS_DIR/cheap-mem-session-start.sh"

CODE_ROOT="$(dirname "$HERE")"
{
  echo "#!/usr/bin/env bash"
  echo "export CHEAP_MEM_ROOT='${CHEAP_MEM_ROOT}'"
  # Where the code lives — so the stop hook finds bin/mem-stop even when
  # the memory does not carry the tool (separate checkout).
  echo "export CHEAP_MEM_CODE='${CODE_ROOT}'"
  tail -n +2 "$HERE/hooks/session-stop.sh"
} > "$HOOKS_DIR/cheap-mem-session-stop.sh"
chmod +x "$HOOKS_DIR/cheap-mem-session-stop.sh"

{
  echo "#!/usr/bin/env bash"
  echo "export CHEAP_MEM_ROOT='${CHEAP_MEM_ROOT}'"
  tail -n +2 "$HERE/hooks/user-prompt.sh"
} > "$HOOKS_DIR/cheap-mem-user-prompt.sh"
chmod +x "$HOOKS_DIR/cheap-mem-user-prompt.sh"

# Recall DURING the work. The hook above fires only when the person
# types; between two of their messages is where the building — and the
# breaking — happens. Measured 2026-09-08 on four Windows-install
# defects: three had an entry naming the very file being touched.
{
  echo "#!/usr/bin/env bash"
  echo "export CHEAP_MEM_ROOT='${CHEAP_MEM_ROOT}'"
  echo "export CHEAP_MEM_CODE='${CODE_ROOT}'"
  tail -n +2 "$HERE/hooks/pre-edit.sh"
} > "$HOOKS_DIR/cheap-mem-pre-edit.sh"
chmod +x "$HOOKS_DIR/cheap-mem-pre-edit.sh"

# Merge settings.json without touching unrelated config.
node - "$SETTINGS" "$HOOKS_DIR_CMD" "$CHEAP_MEM_ROOT" "$BASH_BIN" <<'NODE_MERGE'
const fs = require('fs');
const path = require('path');
const [, , hooksDir, memRoot, bashBin] = process.argv.slice(1);
const settingsPath = process.argv[2];

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch {}

cfg.hooks = cfg.hooks || {};

// Quote anything with a space. `C:\\Program Files\\Git\\bin\\bash.exe` is
// the normal case on Windows, not an exotic one.
const q = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);

// An old install is recognised by the SCRIPT NAME, not by the path.
// The path form changes between install runs — MSYS on one, Windows on
// the next — and a filter keyed on the path would leave the old entry
// in place and add a second one next to it. Two hooks on
// UserPromptSubmit means every message pays twice.
function upsertHook(event, script, matcher) {
  const datei = `cheap-mem-${script}.sh`;
  cfg.hooks[event] = cfg.hooks[event] || [];
  cfg.hooks[event] = cfg.hooks[event].filter((entry) => {
    if (!entry.hooks) return true;
    return !entry.hooks.some((h) => h.command && h.command.includes(datei));
  });
  const cmd = `${q(bashBin)} ${q(`${hooksDir.replace(/[\\/]$/, '')}/${datei}`)}`;
  const entry = { hooks: [{ type: 'command', command: cmd }] };
  if (matcher) entry.matcher = matcher;
  cfg.hooks[event].push(entry);
}
upsertHook('SessionStart', 'session-start');
upsertHook('Stop', 'session-stop');
upsertHook('UserPromptSubmit', 'user-prompt');
// With a matcher — otherwise it would also run on Read and Bash, and
// the path of a file being READ is not an intention to change it.
upsertHook('PreToolUse', 'pre-edit', 'Edit|Write|NotebookEdit');

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
echo "hooks:    $HOOKS_DIR/cheap-mem-{session-start,session-stop,user-prompt,pre-edit}.sh"
echo "settings: $SETTINGS"
echo ""
echo "Next Claude Code session on this machine:"
echo "  - SessionStart hook prints FACTS.md + mem context"
echo "  - UserPromptSubmit hook recalls matching memory on every message"
echo "  - PreToolUse hook warns before editing a file the memory knows about"
echo "  - Stop hook triggers mem-reflect (byte-delta throttled)"
