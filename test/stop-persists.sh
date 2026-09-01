#!/usr/bin/env bash
# test/stop-persists.sh
#
# The core of environment-independent capture: the Stop hook must capture
# model-free AND persist it (commit + push), because nothing else pushes
# captures — the watcher only pulls. Without this an ephemeral environment
# (cloud) loses the capture and a machine without a watcher never syncs it.
#
# Effect is measured against a real bare remote, not the call.
set -u
ROOT_REPO="$(git rev-parse --show-toplevel)"
STOP="${1:-$ROOT_REPO/bin/mem-stop}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GREEN=0; RED=0
ok()  { GREEN=$((GREEN+1)); echo "  ok   $1"; }
bad() { RED=$((RED+1));     echo "  FAIL $1"; }

# A memory with a bare remote. Copy the working tree (not `git archive
# HEAD`) so the not-yet-committed bin/mem-stop comes along.
build_memory() {
  rm -rf "$WORK/remote" "$WORK/mem"
  git init -q --bare -b main "$WORK/remote"
  mkdir -p "$WORK/mem"
  tar --exclude=.git --exclude=node_modules -C "$ROOT_REPO" -cf - \
    bin src package.json 2>/dev/null | tar -xf - -C "$WORK/mem"
  node "$WORK/mem/bin/mem" --root "$WORK/mem" init >/dev/null 2>&1
  git -C "$WORK/mem" init -q -b main
  git -C "$WORK/mem" config user.email t@t
  git -C "$WORK/mem" config user.name T
  git -C "$WORK/mem" config core.hooksPath /dev/null
  git -C "$WORK/mem" add -A >/dev/null
  git -C "$WORK/mem" commit -qm base
  git -C "$WORK/mem" remote add origin "$WORK/remote"
  git -C "$WORK/mem" push -q -u origin main
}

# A transcript over the capture threshold (min-bytes 4096).
transcript() {
  local p="$WORK/transcript.jsonl"
  : > "$p"
  for i in $(seq 1 200); do
    printf '{"type":"assistant","message":{"content":"line %s: building the environment-independent capture, deploy watcher recall redaction %s"}}\n' "$i" "$((i*7919))" >> "$p"
  done
  printf '%s' "$p"
}

STOPJSON() { printf '{"transcript_path":"%s","cwd":"%s"}' "$1" "$WORK/mem"; }

echo "1) capture is committed AND pushed to the remote"
build_memory
T="$(transcript)"
BEFORE="$(git -C "$WORK/remote" rev-parse main)"
STOPJSON "$T" | env CHEAP_MEM_ROOT="$WORK/mem" bash "$STOP" >/dev/null 2>&1
AFTER="$(git -C "$WORK/remote" rev-parse main)"
[ "$AFTER" != "$BEFORE" ] && ok "remote has a new commit" || bad "remote unchanged — nothing pushed"
if git -C "$WORK/remote" ls-tree -r --name-only main | grep -q '^raw/.*\.jsonl\.gz$'; then
  ok "the pushed commit carries a raw/ capture"
else
  bad "no raw/ capture in the pushed tree"
fi

echo "2) MEM_STOP_NO_PUSH=1 -> captured locally, not pushed"
build_memory
T="$(transcript)"
BEFORE="$(git -C "$WORK/remote" rev-parse main)"
STOPJSON "$T" | env CHEAP_MEM_ROOT="$WORK/mem" MEM_STOP_NO_PUSH=1 bash "$STOP" >/dev/null 2>&1
[ "$(git -C "$WORK/remote" rev-parse main)" = "$BEFORE" ] && ok "remote unchanged" || bad "pushed despite NO_PUSH"
[ -n "$(git -C "$WORK/mem" status --porcelain raw/ 2>/dev/null)" ] \
  && ok "capture waits locally" || bad "no local capture"

echo "3) MEM_HOOK_OFF=1 -> nothing at all"
build_memory
T="$(transcript)"
BEFORE="$(git -C "$WORK/remote" rev-parse main)"
STOPJSON "$T" | env CHEAP_MEM_ROOT="$WORK/mem" MEM_HOOK_OFF=1 bash "$STOP" >/dev/null 2>&1
[ "$(git -C "$WORK/remote" rev-parse main)" = "$BEFORE" ] \
  && [ -z "$(git -C "$WORK/mem" status --porcelain raw/ 2>/dev/null)" ] \
  && ok "off means off" || bad "did something while off"

echo "4) no transcript -> quiet"
build_memory
BEFORE="$(git -C "$WORK/remote" rev-parse main)"
printf '{"cwd":"%s"}' "$WORK/mem" | env CHEAP_MEM_ROOT="$WORK/mem" bash "$STOP" >/dev/null 2>&1
[ "$(git -C "$WORK/remote" rev-parse main)" = "$BEFORE" ] && ok "no transcript, no push" || bad "pushed without a transcript"

echo "5) MEM_HEADLESS=1 -> skip (don't eat our own tail)"
build_memory
T="$(transcript)"
BEFORE="$(git -C "$WORK/remote" rev-parse main)"
STOPJSON "$T" | env CHEAP_MEM_ROOT="$WORK/mem" MEM_HEADLESS=1 bash "$STOP" >/dev/null 2>&1
[ "$(git -C "$WORK/remote" rev-parse main)" = "$BEFORE" ] \
  && [ -z "$(git -C "$WORK/mem" status --porcelain raw/ 2>/dev/null)" ] \
  && ok "headless stays silent" || bad "headless captured/pushed"

echo
echo "green=$GREEN red=$RED"
[ "$RED" = 0 ]
