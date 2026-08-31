#!/usr/bin/env bash
# test/retrieve.sh
#
# Exercises bin/mem-retrieve — lane 3, automatic recall — against real
# git repos and a real memory.
#
# The most expensive assurance here is the second one: this hook runs on
# EVERY message in EVERY session. If it waits even a few seconds on a
# hung network, the memory stops being invisible and starts being in the
# way — and then it gets turned off. So the test measures the WAIT TIME
# against a git that deliberately hangs on pull, not just "does it run".
set -u
ROOT_REPO="$(git rev-parse --show-toplevel)"
HOOK="${1:-$ROOT_REPO/bin/mem-retrieve}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GREEN=0; RED=0
ok()  { GREEN=$((GREEN+1)); echo "  ok   $1"; }
bad() { RED=$((RED+1));     echo "  FAIL $1"; }

# Epoch milliseconds, portably. `date +%s%N` is a GNU-ism — BSD date
# (macOS) has no %N and returns a literal N, which would make the wait
# arithmetic garbage. node's clock is the same everywhere. (Fitting,
# for a test in a project whose whole theme is GNU-vs-BSD skew.)
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# A memory that carries the tool (memory == code repo, cheap-mem's
# hook shape). Built with `git archive` so it has a clean one-commit
# history that can be pushed to an empty bare remote — a shallow clone
# cannot ("shallow update not allowed").
build_memory() {
  rm -rf "$WORK/remote" "$WORK/mem"
  git init -q --bare -b main "$WORK/remote"
  mkdir -p "$WORK/mem"
  git -C "$ROOT_REPO" archive HEAD | tar -x -C "$WORK/mem"
  git -C "$WORK/mem" init -q -b main
  git -C "$WORK/mem" config user.email t@t
  git -C "$WORK/mem" config user.name T
  git -C "$WORK/mem" config core.hooksPath /dev/null
  node "$WORK/mem/bin/mem" --root "$WORK/mem" init >/dev/null 2>&1
  for i in 1 2 3 4 5 6; do
    node "$WORK/mem/bin/mem" --root "$WORK/mem" \
      log event --title "routine note $i about deploys and builds" --tags misc >/dev/null 2>&1
  done
  node "$WORK/mem/bin/mem" --root "$WORK/mem" \
    log error --class flaky-ci --title "flaky payment integration test" \
    --text "retry loop timeout too short under heavy load" >/dev/null 2>&1
  git -C "$WORK/mem" add -A >/dev/null
  git -C "$WORK/mem" commit -qm memory
  git -C "$WORK/mem" remote add origin "$WORK/remote"
  git -C "$WORK/mem" push -q -u origin main
}

# Move the remote one commit ahead.
remote_ahead() {
  rm -rf "$WORK/second"
  git clone -q "$WORK/remote" "$WORK/second"
  ( cd "$WORK/second" && git config user.email t@t && git config user.name T \
    && git config core.hooksPath /dev/null \
    && node bin/mem --root . log event --title "from another session" --tags x >/dev/null 2>&1 \
    && git add -A && git commit -qm second && git push -q origin main ) >/dev/null 2>&1
  REMOTE_HEAD="$(git -C "$WORK/remote" rev-parse main)"
}

run() { printf '%s' "$FRAGE" | env "$@" CHEAP_MEM_ROOT="$WORK/mem" HOME="$WORK" bash "$HOOK" 2>/dev/null; }
pulled() {
  for _ in $(seq 1 40); do
    [ "$(git -C "$WORK/mem" rev-parse HEAD)" = "$REMOTE_HEAD" ] && return 0
    sleep 0.25
  done
  return 1
}

FRAGE='{"prompt":"why is the flaky payment integration test failing on timeout?"}'

echo "1) a real question yields context, and it is valid JSON"
build_memory
# Split into two halves so a failure names the guilty side, not "test 1":
# first the search itself (corpus + tokenisation), then the hook wrapping
# it. BM25 scores vary a little across Node/platform, so the hook half
# uses a low, deterministic threshold — the point here is the envelope
# and the banner, not the exact score (test 9 guards the threshold).
Q="$(printf '%s' "$FRAGE" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).prompt))')"
HITS="$(node "$WORK/mem/bin/mem" --root "$WORK/mem" find "$Q" --top 3 --json 2>/dev/null)"
N="$(printf '%s' "$HITS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String((JSON.parse(d).hits||[]).length))}catch{process.stdout.write("0")}})')"
if [ "${N:-0}" -ge 1 ]; then ok "search finds the entry ($N hit(s))"; else
  bad "search found nothing — corpus/tokenisation problem"
  echo "     find --json said: $(printf '%s' "$HITS" | head -c 200)"
fi
OUT="$(run MEM_RETRIEVE_MIN=1 MEM_RETRIEVE_NO_PULL=1)"
printf '%s' "$OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  if(!d)process.exit(1); try{const o=JSON.parse(d);
    process.exit(o.hookSpecificOutput&&o.hookSpecificOutput.hookEventName==="UserPromptSubmit"?0:1);
  }catch{process.exit(1)}})' \
  && ok "additionalContext, valid envelope" || { bad "no/!invalid context"; echo "     hook said: $(printf '%s' "$OUT" | head -c 200)"; }
printf '%s' "$OUT" | grep -q "Recalled automatically from memory" \
  && ok "carries the data-not-instructions banner" || bad "banner missing"

echo "2) the hook does NOT wait, even when the pull hangs"
build_memory
remote_ahead
mkdir -p "$WORK/bin"
rm -f "$WORK/pull-started"
REAL_GIT="$(command -v git)"        # resolve BEFORE the stub shadows it
cat > "$WORK/bin/git" <<GITEND
#!/usr/bin/env bash
for a in "\$@"; do
  [ "\$a" = "pull" ] && { echo x >> "$WORK/pull-started"; sleep 25; exit 0; }
done
exec "$REAL_GIT" "\$@"
GITEND
chmod +x "$WORK/bin/git"
START=$(now_ms)
printf '%s' "$FRAGE" | env PATH="$WORK/bin:$PATH" MEM_RETRIEVE_FRESH_MIN=0 \
  CHEAP_MEM_ROOT="$WORK/mem" HOME="$WORK" bash "$HOOK" >/dev/null 2>&1
MS=$(( $(now_ms) - START ))
echo "     waited ${MS} ms (hanging git: 25 s)"
[ "$MS" -lt 3000 ] && ok "returns at once" || bad "waited ${MS} ms — stdout held open"
# The pull is detached: the parent returns first, the child reaches the
# git stub a moment later. Checking pull-started synchronously right
# after the 129 ms return is a race — it passed on the fast Linux runner
# and lost on macOS. So wait for the side-effect, up to a few seconds.
STARTED=""
for _ in $(seq 1 40); do
  [ -f "$WORK/pull-started" ] && { STARTED=1; break; }
  sleep 0.25
done
[ -n "$STARTED" ] && ok "the hanging pull was actually started" \
  || bad "no pull attempted — the timing proves nothing"

echo "3) throttle: a second call within the window does not pull again"
build_memory
remote_ahead
run MEM_RETRIEVE_FRESH_MIN=0 >/dev/null
pulled && ok "first pull ran" || bad "first pull did not run"
remote_ahead
BEFORE="$(git -C "$WORK/mem" rev-parse HEAD)"
run MEM_RETRIEVE_FRESH_MIN=10 >/dev/null
sleep 2
[ "$(git -C "$WORK/mem" rev-parse HEAD)" = "$BEFORE" ] \
  && ok "no second pull inside the window" || bad "pulled again"

echo "4) dirty tree -> no pull"
build_memory
remote_ahead
echo '{"ts":"local"}' >> "$WORK/mem/global/events.jsonl"
BEFORE="$(git -C "$WORK/mem" rev-parse HEAD)"
run MEM_RETRIEVE_FRESH_MIN=0 >/dev/null
sleep 2
[ "$(git -C "$WORK/mem" rev-parse HEAD)" = "$BEFORE" ] \
  && ok "left the dirty tree alone" || bad "pulled into a dirty tree"

echo "5) an untracked scratch file does NOT block the pull"
build_memory
remote_ahead
echo scratch > "$WORK/mem/.scratch-note"
run MEM_RETRIEVE_FRESH_MIN=0 >/dev/null
pulled && ok "pulled anyway" || bad "a scratch file blocked the pull"

echo "6) MEM_HEADLESS -> no pull (don't race a worker)"
build_memory
remote_ahead
BEFORE="$(git -C "$WORK/mem" rev-parse HEAD)"
run MEM_RETRIEVE_FRESH_MIN=0 MEM_HEADLESS=1 >/dev/null
sleep 2
[ "$(git -C "$WORK/mem" rev-parse HEAD)" = "$BEFORE" ] \
  && ok "no pull in a headless session" || bad "raced the worker"

echo "7) MEM_RETRIEVE_OFF silences it entirely"
build_memory
OUT="$(run MEM_RETRIEVE_OFF=1 MEM_RETRIEVE_NO_PULL=1)"
[ -z "$OUT" ] && ok "no output when off" || bad "spoke while off"

echo "8) too-short prompt -> nothing, but the clone still refreshes"
build_memory
remote_ahead
OUT="$(printf '%s' '{"prompt":"yes"}' | env MEM_RETRIEVE_FRESH_MIN=0 \
  CHEAP_MEM_ROOT="$WORK/mem" HOME="$WORK" bash "$HOOK" 2>/dev/null)"
[ -z "$OUT" ] && ok "no context for 'yes'" || bad "showed context for 'yes'"
pulled && ok "still refreshed" || bad "a short prompt froze the clone"

echo "9b) works even when timeout is absent (the macOS case)"
# GNU timeout is not on macOS by default. A hard dependency on it made
# the whole hook silently produce nothing there. Reproduce it: a PATH
# with the tools the hook needs but NO timeout/gtimeout.
build_memory
SAFE="$WORK/safe-path"; mkdir -p "$SAFE"
for t in node git bash env cat printf grep find sed awk date sleep mktemp          dirname touch wc head tail tr cut basename rm mkdir chmod ln seq; do
  p="$(command -v "$t" 2>/dev/null)"; [ -n "$p" ] && ln -sf "$p" "$SAFE/$t"
done
if PATH="$SAFE" command -v timeout >/dev/null 2>&1 \
   || PATH="$SAFE" command -v gtimeout >/dev/null 2>&1; then
  echo "     (skipped: this box still exposes timeout on the trimmed PATH)"
else
  OUT="$(printf '%s' "$FRAGE" | env PATH="$SAFE" MEM_RETRIEVE_MIN=1 MEM_RETRIEVE_NO_PULL=1 \
    CHEAP_MEM_ROOT="$WORK/mem" HOME="$WORK" bash "$HOOK" 2>/dev/null)"
  printf '%s' "$OUT" | grep -q "Recalled automatically from memory" \
    && ok "context produced without timeout on PATH" \
    || { bad "hook went silent without timeout"; echo "     hook said: $(printf '%s' "$OUT" | head -c 120)"; }
fi

echo "9) below-threshold match stays hidden"
build_memory
OUT="$(printf '%s' '{"prompt":"a totally unrelated question about weather"}' \
  | env MEM_RETRIEVE_NO_PULL=1 CHEAP_MEM_ROOT="$WORK/mem" HOME="$WORK" bash "$HOOK" 2>/dev/null)"
[ -z "$OUT" ] && ok "nothing shown for an unrelated prompt" || bad "showed noise"

echo
echo "green=$GREEN red=$RED"
[ "$RED" = 0 ]
