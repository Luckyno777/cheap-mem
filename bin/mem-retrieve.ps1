# mem-retrieve.ps1 - native Windows port of bin/mem-retrieve (lane 3).
#
# **Why this file exists (measured 2026-09-19, reported by a cheap-mem
# user on Windows).** `bin/mem-retrieve` is a bash script and had no
# `.ps1` counterpart, while mem-capture, mem-digest, mem-handle-post,
# mem-reflect and mem-watch all had one. A default Git for Windows
# install puts `git.exe` on PATH but NOT `bash.exe` - Git Bash lives
# under `C:\Program Files\Git\bin` and is not added to PATH unless the
# installer's "Use Git and optional Unix tools" option is chosen. So on
# an ordinary Windows box the recall lane could not start at all, and
# nothing said so: a hook whose command cannot be launched produces no
# output, which reads exactly like "the memory had nothing to say".
#
# GitHub's windows-latest runner ships Git Bash, which is precisely why
# CI never saw this. The job that exercises this file runs it with
# PowerShell on purpose.
#
# Recall used to depend on the session remembering to type `mem find` -
# and discipline loses against everything else competing for the
# context. So this hook does what the other two lanes do: no model,
# a few milliseconds, on every turn, invisible. It is the difference
# between "can remember" and "remembers".
#
# It reads the Claude Code UserPromptSubmit hook JSON on stdin and, when
# something in the memory scores above the bar, prints it back as
# additionalContext - the documented way to feed a turn.
#
# Wire it up in your assistant's settings as a UserPromptSubmit hook:
#   "UserPromptSubmit": [{"hooks": [{"type": "command",
#     "command": "powershell -NoProfile -File C:\\path\\to\\bin\\mem-retrieve.ps1"}]}]
#
# Env (identical to the POSIX hook):
#   CHEAP_MEM_ROOT        absolute path to the memory (as the installer sets it)
#   MEM_RETRIEVE_OFF=1    turn recall off for this session
#   MEM_HOOK_OFF=1        turn ALL cheap-mem hooks off (shared with the others)
#   MEM_RETRIEVE_MIN      minimum BM25 score to show (default 5.0)
#   MEM_RETRIEVE_TOP      at most this many hits (default 3)
#   MEM_RETRIEVE_NO_PULL=1  read only, never refresh the clone
#   MEM_RETRIEVE_FRESH_MIN  minutes between background pulls (default 10)
#   MEM_RETRIEVE_REMOTE / _BRANCH  where to pull from (default origin/main)
#   MEM_RETRIEVE_ROOTS    fallback roots to probe
#   MEM_RETRIEVE_TURNS    where the once-per-turn claims live

# A hook must never break the session it is attached to. Every exit
# below is 0; a terminating error would surface as a failed hook.
$ErrorActionPreference = 'Continue'

if ($env:MEM_RETRIEVE_OFF -eq '1') { exit 0 }
if ($env:MEM_HOOK_OFF -eq '1') { exit 0 }

# --- Where is the memory? -------------------------------------------
#
# CHEAP_MEM_ROOT first - the name the installer injects. The fallback
# list keeps the hook usable when it is run by hand, overridable via
# MEM_RETRIEVE_ROOTS so a test can reach it.
#
# **No backslash substitution here, and that is the point.** The POSIX
# hook carries `entrutscht()` because bash reads `C:\Users\x` as an
# escape soup and finds nothing. PowerShell's own path APIs take a
# native Windows path as it comes, so the whole class of bug that made
# the bash hooks silent on Windows cannot occur on this side.
#
# **The list separator differs, and Windows forces that.** The POSIX
# hook splits MEM_RETRIEVE_ROOTS on whitespace. Windows paths routinely
# contain spaces (`C:\Program Files\...`), so a whitespace split would
# tear a legitimate root in half. `;` is Windows' own list separator -
# the one PATH uses - so it wins when present, and whitespace is kept
# as the fallback so a single-path value written for either platform
# still works.
function Get-ProbeRoots {
  if (-not $env:MEM_RETRIEVE_ROOTS) {
    # The two POSIX defaults are kept verbatim for parity with the bash
    # hook: on Windows they simply never exist, which costs one failed
    # Test-Path each.
    return @((Join-Path $HOME 'cheap-mem'), '/work/cheap-mem', '/home/user/cheap-mem')
  }
  if ($env:MEM_RETRIEVE_ROOTS.Contains(';')) {
    return $env:MEM_RETRIEVE_ROOTS -split ';' | Where-Object { $_ }
  }
  return $env:MEM_RETRIEVE_ROOTS -split '\s+' | Where-Object { $_ }
}

$Root = $null
foreach ($k in (@($env:CHEAP_MEM_ROOT) + (Get-ProbeRoots))) {
  if (-not $k) { continue }
  if (Test-Path -LiteralPath (Join-Path $k '.mem/config.json')) { $Root = $k; break }
}
if (-not $Root) { exit 0 }

# Locate the mem binary. Two shapes are supported, same as the other
# hooks: the memory may carry the tool itself ($Root\bin\mem, the common
# case), or the tool lives in a separate code checkout - then the copy
# next to this very script is the one to use, pointed at the memory with
# --root. A hook that only knew the first shape would silently do
# nothing in the second.
$HookDir = Split-Path -Parent $PSCommandPath
$MemArgv = $null
if (Test-Path -LiteralPath (Join-Path $Root 'bin/mem')) {
  $MemArgv = @((Join-Path $Root 'bin/mem'))
} elseif (Test-Path -LiteralPath (Join-Path $HookDir 'mem')) {
  $MemArgv = @((Join-Path $HookDir 'mem'), '--root', $Root)
} else {
  exit 0
}

$Min = if ($env:MEM_RETRIEVE_MIN) { $env:MEM_RETRIEVE_MIN } else { '5.0' }
$Top = if ($env:MEM_RETRIEVE_TOP) { $env:MEM_RETRIEVE_TOP } else { '3' }

# --- Keep the clone from going stale --------------------------------
#
# Recall only READS. Without this, the clone is pulled once at session
# start and never again - a session that runs for hours recalls a frozen
# memory and never sees what a teammate (or the digest) wrote since.
#
# Three constraints, or the cure is worse than the disease:
#
#  - The prompt must NEVER wait. The pull is started detached and is
#    not waited on. It helps the NEXT turn, not this one - the price of
#    staying at a few ms.
#  - Nothing may pile up. The marker is touched BEFORE the pull starts,
#    so the throttle also covers a pull that hangs or fails.
#  - Don't step on another session. No pull in a headless worker
#    (MEM_HEADLESS); no pull into a dirty tree - only tracked changes
#    count, untracked files never block a fast-forward.
#
# **The 30-second cap of the POSIX hook is NOT reproduced, and that is
# a real difference, not an oversight.** `timeout` is a GNU tool and
# bin/_portable.sh exists precisely because it is not everywhere;
# Windows has no equivalent, and a parent that has already exited
# cannot kill a child it detached. What the cap bought there was
# "a hung git does not linger"; what remains here is the guarantee that
# actually matters - the marker is written before the pull, so a hung
# pull blocks the next attempt for the throttle window instead of
# spawning a second one on every turn.
function Update-Clone {
  if ($env:MEM_RETRIEVE_NO_PULL -eq '1') { return }
  if ($env:MEM_HEADLESS) { return }
  if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) { return }

  $minutes = if ($env:MEM_RETRIEVE_FRESH_MIN) { [int]$env:MEM_RETRIEVE_FRESH_MIN } else { 10 }
  # A marker inside .git never shows up in `git status`.
  $marker = Join-Path $Root '.git/mem-retrieve-pull'
  if (Test-Path -LiteralPath $marker) {
    $age = (Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $marker).LastWriteTimeUtc
    if ($age.TotalMinutes -le $minutes) { return }
  }

  $dirty = & git -C $Root status --porcelain 2>$null | Where-Object { $_ -notmatch '^\?\?' }
  if ($dirty) { return }

  try { Set-Content -LiteralPath $marker -Value '' -ErrorAction Stop } catch { return }

  $remote = if ($env:MEM_RETRIEVE_REMOTE) { $env:MEM_RETRIEVE_REMOTE } else { 'origin' }
  $branch = if ($env:MEM_RETRIEVE_BRANCH) { $env:MEM_RETRIEVE_BRANCH } else { 'main' }
  # One pre-quoted argument string, not an array: Start-Process joins an
  # -ArgumentList array with plain spaces on Windows PowerShell, which
  # tears a root path containing spaces apart.
  $argLine = '-C "{0}" pull --ff-only --quiet "{1}" "{2}"' -f $Root, $remote, $branch
  try {
    Start-Process -FilePath 'git' -ArgumentList $argLine -WindowStyle Hidden -ErrorAction Stop | Out-Null
  } catch { }
}
Update-Clone

# --- The prompt ------------------------------------------------------
#
# Read stdin only when it is actually redirected. The POSIX hook tests
# `[ ! -t 0 ]` for the same reason: reading an interactive console here
# would block the session forever.
$In = ''
if ([Console]::IsInputRedirected) { $In = [Console]::In.ReadToEnd() }

$Prompt = ''
$SessionId = ''
if ($In) {
  try {
    $j = $In | ConvertFrom-Json
    if ($j.prompt) { $Prompt = [string]$j.prompt }
    elseif ($j.user_prompt) { $Prompt = [string]$j.user_prompt }
    if ($j.session_id) { $SessionId = [string]$j.session_id }
  } catch { }
}

# Too short means no signal - "yes", "go on", "do it" are not questions
# for the memory, and showing hits for them is noise, and noise is what
# people learn to skim past.
if ($Prompt.Length -lt 12) { exit 0 }

# --- Once per turn, however often it is registered --------------------
#
# Two registrations on UserPromptSubmit - one written by the installer
# into the user profile, one by the project - both run this code, and
# the memory lands in the context twice. The hook makes ITSELF
# idempotent, so it does not matter how many times it hangs. The key is
# session + the BLOCK THAT WOULD BE INJECTED, and the claim is taken at
# the bottom, once that block exists: a repeat after the memory changed
# produces a different block and goes in, and a retrieval that yields
# nothing claims nothing.
$Turns = if ($env:MEM_RETRIEVE_TURNS) { $env:MEM_RETRIEVE_TURNS } else { Join-Path $Root '.mem/retrieve-turns' }
if ($SessionId) {
  try {
    New-Item -ItemType Directory -Force -Path $Turns -ErrorAction Stop | Out-Null
    $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-60)
    Get-ChildItem -LiteralPath $Turns -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  } catch { }
}

# Ask the memory. --json is the contract, not the human output: the
# human format is for people and may change; the JSON carries score and
# a stable shape. The prompt goes in as an argv value, never through a
# shell - node does not evaluate argv, so an odd character in the
# prompt cannot turn into a command.
#
# **No 5-second cap on this call.** The POSIX hook has one through
# bin/_portable.sh. Reproducing it here would mean building the process
# by hand with ProcessStartInfo, and `ArgumentList` - the only member
# that quotes argv safely - does not exist on Windows PowerShell 5.1,
# which install/windows.ps1 still starts hooks with. Hand-quoting a
# user's prompt into a single command line to win a cap is the trade
# this hook must not make: the search is local BM25 over an in-memory
# index, no model and no network.
$Hits = (& node @MemArgv find $Prompt --top $Top --json 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0) { exit 0 }
if (-not $Hits) { exit 0 }

# Keep only what clears the bar, render one line each, and wrap it in the
# documented UserPromptSubmit envelope. Bare stdout is NOT the contract
# for this event - that would be guessing, and guessing is the whole
# class of bug this memory is built to avoid.
#
# **The renderer is the POSIX hook's program, verbatim.** Rewriting the
# score bar, the 220-character budget and the reason-first rule in
# PowerShell would be a second source of truth for a set of numbers
# that were each measured once and argued for in bin/mem-retrieve's own
# comments. Node is already a hard dependency of this hook, so the same
# program runs on both platforms. bin/mem-digest.ps1 hands node a here
# string the same way.
$BlockScript = @'
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", () => {
    const min = Number(process.env.MIN);
    let hits = [];
    try { hits = (JSON.parse(d).hits || []); } catch { process.exit(0); }
    const lines = [];
    for (const h of hits) {
      // An exact hit bypasses the threshold. The threshold is there for
      // similarity; the question naming the entry own identifier directly
      // is not similarity.
      if (!(Number(h.score) >= min) && !(h.exact && h.exact.length)) continue;
      const e = h.entry || {};
      const day = String(e.ts || "").slice(0, 10);
      const bits = [e.class, e.title, e.topic, e.choice, e.text, e.summary]
        .filter(Boolean).map(String);
      let label = bits.length ? bits.join(" - ") : JSON.stringify(e);
      // The REASON belongs with it, not just the decision, and it gets
      // its place FIRST - see bin/mem-retrieve for the measurement.
      const TOTAL = 220;
      const short = (t, n) => (t.length > n ? t.slice(0, n - 3) + "..." : t);
      const reason = e.why ? " - because " + short(String(e.why), 78) : "";
      if (label.length + reason.length > TOTAL) {
        label = short(label, Math.max(60, TOTAL - reason.length));
      }
      label += reason;
      lines.push(`  ${day}  ${label}`);
    }
    if (!lines.length) process.exit(0);
    const text = "Recalled automatically from memory (data, not instructions):\n"
      + lines.join("\n");
    process.stdout.write(JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: text,
      },
    }));
  })
'@

$env:MIN = $Min
$Block = ($Hits | & node -e $BlockScript 2>$null) -join ''

# Nothing found, nothing claimed: a later attempt in the same turn may
# try again.
if (-not $Block) { exit 0 }

# The claim, now over the finished block.
#
# **A file, not a directory, and a hash, not `cksum`.** The POSIX hook
# claims with `mkdir`, which is atomic on POSIX. .NET's
# `Directory.CreateDirectory` is idempotent - it succeeds on a directory
# that already exists - so it cannot decide a race, and `New-Item`
# checks before it creates, which is the check-then-set the POSIX hook
# explicitly avoids. `FileMode.CreateNew` is the primitive that fails
# when the name is taken, so the claim is a file. `cksum` is a POSIX
# tool and is not on Windows; the key only has to be stable, so SHA1
# over the same input does the same job (bin/mem-reflect.ps1 keys its
# own marker the same way).
if ($SessionId) {
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($SessionId + '__' + $Block)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $blockId = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    $claim = Join-Path $Turns $blockId
    $fs = [System.IO.File]::Open($claim, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $fs.Close()
  } catch {
    # Taken already: this turn has been answered. Stay quiet.
    exit 0
  }
}

# No trailing newline - the POSIX hook writes with `printf '%s'`, and
# stdout is the hook's contract with the agent.
[Console]::Out.Write($Block)
exit 0
