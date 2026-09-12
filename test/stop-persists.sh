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
  # The record must be TRACKED in the fixture, or the ff probe below
  # checks nothing: an untracked file never blocks a `pull --ff-only`,
  # and that block was the real damage.
  : >> "$WORK/mem/raw-record.jsonl"
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
# ... AND its record. This probe used to check the box and never the
# receipt, which is how the sibling shipped 626 captures without one.
# A probe that only looks for what it was built to find agrees with its
# author.
PUSHED_REC="$(git -C "$WORK/remote" show main:raw-record.jsonl 2>/dev/null || true)"
if [ -n "$PUSHED_REC" ]; then
  ok "the pushed commit carries the record"
else
  bad "raw-record.jsonl missing from the pushed tree — capture without a receipt"
fi
PUSHED_CAP="$(git -C "$WORK/remote" ls-tree -r --name-only main | grep '^raw/.*\.jsonl\.gz$' | head -1)"
if [ -n "$PUSHED_CAP" ] && printf '%s' "$PUSHED_REC" | grep -qF "$PUSHED_CAP"; then
  ok "the record names exactly the pushed capture"
else
  bad "the record does not name the pushed capture ($PUSHED_CAP)"
fi
# And nothing may be left behind: a left-over change to a TRACKED file
# aborts the next `pull --ff-only`.
LEFT="$(git -C "$WORK/mem" status --porcelain 2>/dev/null | grep -v '^??' || true)"
if [ -z "$LEFT" ]; then
  ok "nothing tracked left behind (the next ff-pull stays possible)"
else
  bad "left behind, blocks ff-pull: $(printf '%s' "$LEFT" | tr '\n' ' ')"
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

echo "6) archive moved off the repo: raw/ is empty, the record must still go out"
# The expensive case. CHEAP_MEM_ARCHIVE puts captures on a disk outside
# the repo; only the record stays behind. A condition that looks at
# raw/ alone never fires here, and not one byte of the session reaches
# git.
build_memory
T="$(transcript)"
mkdir -p "$WORK/disk"
BEFORE="$(git -C "$WORK/remote" rev-parse main)"
STOPJSON "$T" | env CHEAP_MEM_ROOT="$WORK/mem" CHEAP_MEM_ARCHIVE="$WORK/disk" bash "$STOP" >/dev/null 2>&1
if [ "$(git -C "$WORK/remote" rev-parse main)" != "$BEFORE" ] \
   && git -C "$WORK/remote" show main:raw-record.jsonl >/dev/null 2>&1; then
  ok "record pushed even though the archive lives outside the repo"
else
  bad "archive outside -> nothing reached the repo at all"
fi
if find "$WORK/disk" -name '*.jsonl.gz' | grep -q .; then
  ok "the capture is on the disk"
else
  bad "no capture on the disk — the case was never set up"
fi

echo "7) a capture waiting, no record -> the commit still happens"
# git aborts on a pathspec that matches nothing and then stages NOTHING
# — not even the captures it was supposed to stage. A memory that never
# captured has no record; that is every memory's first day. Porting
# this fix to the sibling without the existence guard killed its
# janitor outright (its cleanup test fell from 40/0 to 31/9).
build_memory
rm -f "$WORK/mem/raw-record.jsonl"
git -C "$WORK/mem" rm -q --cached raw-record.jsonl >/dev/null 2>&1 || true
git -C "$WORK/mem" commit -qm "without record" >/dev/null 2>&1 || true
git -C "$WORK/mem" push -q origin main >/dev/null 2>&1
mkdir -p "$WORK/mem/raw/2026/01"
printf 'x' | gzip > "$WORK/mem/raw/2026/01/old.jsonl.gz"
printf '{"type":"assistant","message":{"content":"tiny"}}\n' > "$WORK/tiny.jsonl"
BEFORE="$(git -C "$WORK/remote" rev-parse main)"
STOPJSON "$WORK/tiny.jsonl" | env CHEAP_MEM_ROOT="$WORK/mem" bash "$STOP" >/dev/null 2>&1
if [ -f "$WORK/mem/raw-record.jsonl" ]; then
  bad "precondition missed: the capture wrote a record after all"
elif [ "$(git -C "$WORK/remote" rev-parse main)" != "$BEFORE" ] \
     && git -C "$WORK/remote" ls-tree -r --name-only main | grep -q '^raw/2026/01/old\.jsonl\.gz$'; then
  ok "a missing record does not block the capture commit"
else
  bad "a missing record killed the whole commit"
fi

echo "8) the filename comes from the code, not from memory"
FROM_CODE="$(node -e 'import("'"$ROOT_REPO"'/src/archive.mjs").then(m=>process.stdout.write(m.RECORD_FILE))' 2>/dev/null)"
if [ -n "$FROM_CODE" ] && grep -qF "$FROM_CODE" "$STOP"; then
  ok "mem-stop names '$FROM_CODE' (= archive.RECORD_FILE)"
else
  bad "mem-stop does not know '$FROM_CODE' — hook and archive are decoupled"
fi

echo
echo "green=$GREEN red=$RED"
[ "$RED" = 0 ]
