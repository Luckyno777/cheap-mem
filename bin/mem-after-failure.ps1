# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# mem-after-failure.ps1 - native Windows port of bin/mem-after-failure
# (X2b; port of the sibling house's PostToolUseFailure hook).
#
# Recall AFTER a tool call really failed, before the second attempt.
# PostToolUse never fires on a failure, so mem-catch-fail cannot see a
# command that really exits nonzero; this hook hangs on PostToolUseFailure,
# matcher `Bash|Edit|Write`. The logic lives in src/afterfailure.mjs, the
# same program the POSIX hook calls - so the two platforms cannot
# disagree on what a failure is, what is shown, or what is booked. What
# stays here: finding the memory and the code, the once-per-session claim,
# and the calls. Every failure of THIS script is silent (a hook after a
# tool that just failed must never get in the way of the second attempt),
# but the nothing is booked in the injection journal with its reason.
#
# Wire it up in your assistant's settings as a PostToolUseFailure hook
# with matcher "Bash|Edit|Write":
#   "PostToolUseFailure": [{"matcher": "Bash|Edit|Write", "hooks": [{"type": "command",
#     "command": "powershell -NoProfile -File C:\\path\\to\\bin\\mem-after-failure.ps1"}]}]
#
# Env (identical to the POSIX hook):
#   CHEAP_MEM_ROOT             absolute path to the memory
#   MEM_AFTER_FAILURE_OFF=1    turn this hook off
#   MEM_HOOK_OFF=1             turn ALL cheap-mem hooks off
#   MEM_AFTER_FAILURE_TOP      at most this many hits (default 3)
#   MEM_AFTER_FAILURE_MIN      minimum BM25 score to show (default 2.0)
#   MEM_AFTER_FAILURE_TURNS    where the once-per-session marks live
#   MEM_RETRIEVE_ROOTS         fallback roots to probe

$ErrorActionPreference = 'Continue'

if ($env:MEM_AFTER_FAILURE_OFF -eq '1') { exit 0 }
if ($env:MEM_HOOK_OFF -eq '1') { exit 0 }

# Hook time starts here (the journal's `duration_ms`).
$env:MEM_AF_START_MS = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Get-ProbeRoots {
  if (-not $env:MEM_RETRIEVE_ROOTS) {
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

$HookDir = Split-Path -Parent $PSCommandPath
$MemArgv = $null
$ToolRoot = $null
if (Test-Path -LiteralPath (Join-Path $Root 'bin/mem')) {
  $MemArgv = @((Join-Path $Root 'bin/mem'))
  $ToolRoot = $Root
} elseif (Test-Path -LiteralPath (Join-Path $HookDir 'mem')) {
  $MemArgv = @((Join-Path $HookDir 'mem'), '--root', $Root)
  $ToolRoot = Split-Path -Parent $HookDir
} else {
  exit 0
}
$Af = Join-Path $ToolRoot 'src/afterfailure.mjs'
if (-not (Test-Path -LiteralPath $Af)) { exit 0 }
$env:CHEAP_MEM_ROOT = $Root

$In = ''
if ([Console]::IsInputRedirected) { $In = [Console]::In.ReadToEnd() }
if (-not $In) { exit 0 }

# The parse result comes back as JSON on stdout: nothing at all means
# "not a shape this hook reads".
$Parsed = ($In | & node $Af parse 2>$null) -join ''
if (-not $Parsed) { exit 0 }
$Fields = $null
try { $Fields = $Parsed | ConvertFrom-Json } catch { exit 0 }
$Kind = [string]$Fields.kind
$SessionId = [string]$Fields.session
$Query = [string]$Fields.query
$env:MEM_AF_SESSION = $SessionId

function Add-JournalLine([string]$Reason) {
  $env:MEM_AF_REASON = $Reason
  '' | & node $Af book 2>$null | Out-Null
}

# Aborted is not failed; a failure with no text is the outage. Each gets
# its own reason in the journal, and neither searches.
if ($Kind -eq 'interrupt') { Add-JournalLine 'interrupt'; exit 0 }
if ($Kind -eq 'no-input') { Add-JournalLine 'no-input'; exit 0 }
if ($Kind -ne 'failure' -or -not $Query) { exit 0 }

# --- Once per session per failure text ----------------------------------
#
# A file claim, not a directory, and a hash, not `cksum` - same reasoning
# as mem-retrieve.ps1: .NET directory creation is idempotent and cannot
# decide a race, `FileMode.CreateNew` can. The claim is taken BEFORE the
# search and handed back when nothing went out (a failure that found
# nothing must not count as handled for an hour: while one sits on an
# error, an entry about it gets written).
$Claim = $null
if ($SessionId) {
  $Turns = if ($env:MEM_AFTER_FAILURE_TURNS) { $env:MEM_AFTER_FAILURE_TURNS } else { Join-Path $Root '.mem/after-failure-turns' }
  try {
    New-Item -ItemType Directory -Force -Path $Turns -ErrorAction Stop | Out-Null
    $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-60)
    Get-ChildItem -LiteralPath $Turns -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  } catch { }
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($SessionId + '__' + $Query)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $safe = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    $Claim = Join-Path $Turns $safe
    $fs = [System.IO.File]::Open($Claim, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $fs.Close()
  } catch {
    # Taken already: this exact failure was shown this session.
    Add-JournalLine 'already-shown'
    exit 0
  }
}
function Release-Claim { if ($Claim) { Remove-Item -LiteralPath $Claim -Force -ErrorAction SilentlyContinue } }

$Top = if ($env:MEM_AFTER_FAILURE_TOP) { [int]$env:MEM_AFTER_FAILURE_TOP } else { 3 }
# A generous --top: the two lanes are picked out of the result.
# --weak: this hook holds its own, lower bar; the h3 answer gate of
# `mem find` is tuned for a spoken question (mirror of bin/mem-after-failure).
$Hits = (& node @MemArgv find $Query --content-words --top ($Top * 4) --json --weak 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0 -or -not $Hits) {
  Release-Claim
  Add-JournalLine 'empty'
  exit 0
}

# The hits go to the module in an environment variable, not on stdin:
# see mem-before-edit.ps1 - piping a string to a native command appends a
# newline PowerShell cannot suppress. Here the module reads JSON, so a
# trailing newline is harmless, and stdin stays the simple way.
$Block = ($Hits | & node $Af finish 2>$null) -join ''
if (-not $Block) { Release-Claim; exit 0 }

[Console]::Out.Write($Block)
exit 0
