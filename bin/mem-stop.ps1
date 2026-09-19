# mem-stop.ps1 — native Windows port of bin/mem-stop, the ONE
# environment-independent Stop hook.
#
# **Why this file exists (measured 2026-09-19, reported by a cheap-mem
# user on Windows).** `bin/mem-stop` is a bash script and had no `.ps1`
# counterpart, while mem-capture, mem-digest, mem-handle-post,
# mem-reflect and mem-watch all had one. A default Git for Windows
# install puts `git.exe` on PATH but NOT `bash.exe`, so on an ordinary
# Windows box this hook could not be started at all — and a Stop hook
# that cannot start ends the session without capturing and without
# saying so. GitHub's windows-latest runner ships Git Bash, which is
# why CI never saw it.
#
# The problem the POSIX hook fixes, and this one fixes on Windows: the
# installed Stop hook delegated to mem-reflect (a MODEL call), and the
# model-free mem-capture was not the registered hook. In a cloud sandbox
# the model call does not run, so the session captured NOTHING. And even
# where capture ran, nothing pushed it — the watcher only pulls inbound
# mail, it never pushes captures out.
#
# This hook makes capture model-free AND persistent, everywhere:
#
#   1. Capture   model-free (~50ms), ALWAYS, every environment / repo.
#   2. Persist   commit raw/ + push — SYNCHRONOUS, best-effort. Nothing
#                else pushes captures, so this hook does. Synchronous
#                because an ephemeral environment is reclaimed right
#                after; a detached push would not arrive. Best-effort
#                because an offline laptop keeps the capture committed
#                locally and the next run pushes it. Opt out with
#                MEM_STOP_NO_PUSH=1.
#   3. Reflect   the MODEL summary (mem-reflect.ps1) runs only when
#                opted in (MEM_REFLECT=1) — off by default so the Stop
#                path stays model-free, matching cheap-mem's design.
#
# Wire it up in your assistant's settings as a Stop hook:
#   "Stop": [{"hooks": [{"type": "command",
#     "command": "powershell -NoProfile -File C:\\path\\to\\bin\\mem-stop.ps1"}]}]
#
# Env (identical to the POSIX hook):
#   CHEAP_MEM_ROOT       absolute path to the memory
#   MEM_HOOK_OFF=1       turn ALL cheap-mem hooks off
#   MEM_CAPTURE_OFF=1    disable capture for this session
#   MEM_HEADLESS         set = we are a machine session, do not capture
#   MEM_STOP_NO_PUSH=1   capture, but never touch git
#   MEM_REFLECT=1        also run the model summary
#   MEM_STOP_ROOTS       fallback roots to probe
#
# Always exits 0: a Stop hook must never break the session it is
# attached to.

$ErrorActionPreference = 'Continue'

if ($env:MEM_HOOK_OFF -eq '1') { exit 0 }
if ($env:MEM_CAPTURE_OFF -eq '1') { exit 0 }
# Never capture ourselves — the digest/worker sets this to avoid the
# snake eating its tail.
if ($env:MEM_HEADLESS) { exit 0 }

# **No backslash substitution here, and that is the point.** The POSIX
# hook carries `entrutscht()` because bash reads `C:\Users\x` as an
# escape soup and exits 0 in silence. PowerShell's path APIs take the
# native Windows path as it comes.
#
# The list separator differs because Windows forces it: `;` when the
# value carries one, because a whitespace split would tear
# `C:\Program Files\...` in half.
function Get-ProbeRoots {
  if (-not $env:MEM_STOP_ROOTS) {
    return @((Join-Path $HOME 'cheap-mem'), '/work/cheap-mem', '/home/user/cheap-mem')
  }
  if ($env:MEM_STOP_ROOTS.Contains(';')) {
    return $env:MEM_STOP_ROOTS -split ';' | Where-Object { $_ }
  }
  return $env:MEM_STOP_ROOTS -split '\s+' | Where-Object { $_ }
}

$Root = $null
foreach ($k in (@($env:CHEAP_MEM_ROOT) + (Get-ProbeRoots))) {
  if (-not $k) { continue }
  if (Test-Path -LiteralPath (Join-Path $k '.mem/config.json')) { $Root = $k; break }
}
if (-not $Root) { exit 0 }

$Here = Split-Path -Parent $PSCommandPath

$StdinJson = ''
if ([Console]::IsInputRedirected) { $StdinJson = [Console]::In.ReadToEnd() }

# Which PowerShell is running this hook? The sub-hooks below must be
# started with the SAME host: install/windows.ps1 wires hooks up with
# `powershell -NoProfile -File`, while a developer or CI may run them
# under `pwsh`. Hardcoding either name would work on one machine and
# fail silently on the other — the exact failure class this file exists
# to close.
$HostExe = 'powershell'
try {
  $p = (Get-Process -Id $PID).Path
  if ($p) { $HostExe = $p }
} catch { }

# --- A time cap on git, the Windows way ------------------------------
#
# The POSIX hook reaches for `timeout` through bin/_portable.sh. Windows
# has no such tool, so the cap is built from the process object itself:
# start it, wait a bounded time, kill it if it overruns. Output goes to
# temp files because Start-Process cannot redirect to a variable, and
# because stdout belongs to the hook's contract with the agent — a
# stray git line there would be read as a reply.
$GitOut = Join-Path ([System.IO.Path]::GetTempPath()) "cheap-mem-stop-$PID.out"
$GitErr = "$GitOut.err"

function Invoke-Git {
  param([string]$ArgLine, [int]$Seconds = 30)
  $r = [pscustomobject]@{ Ok = $false; Out = '' }
  try {
    $proc = Start-Process -FilePath 'git' -ArgumentList $ArgLine -NoNewWindow -PassThru `
      -RedirectStandardOutput $GitOut -RedirectStandardError $GitErr -ErrorAction Stop
    if (-not $proc.WaitForExit($Seconds * 1000)) {
      try { $proc.Kill() } catch { }
      return $r
    }
    $r.Ok = ($proc.ExitCode -eq 0)
    if (Test-Path -LiteralPath $GitOut) {
      $r.Out = [string](Get-Content -LiteralPath $GitOut -Raw -ErrorAction SilentlyContinue)
    }
  } catch { }
  return $r
}

try {

# --- 1) Capture (model-free, always) --------------------------------
$Capture = $null
foreach ($c in @((Join-Path $Root 'bin/mem-capture.ps1'), (Join-Path $Here 'mem-capture.ps1'))) {
  if (Test-Path -LiteralPath $c) { $Capture = $c; break }
}
if ($Capture) {
  $env:CHEAP_MEM_ROOT = $Root
  try { $StdinJson | & $HostExe -NoProfile -File $Capture *> $null } catch { }
}

# --- 2) Persist (commit raw/ + its record + push, best-effort) ------
#
# The capture and its RECORD belong together. The record lives at the
# root (src/archive.mjs RECORD_FILE), not under raw/, so staging only
# raw/ leaves it behind — in the sibling memory that happened in 626 of
# 627 capture commits, and the one exception was made by hand.
#
# Three quiet consequences, all measured there:
#   1. A left-behind change to a TRACKED file makes the tree dirty, and
#      the session-start hook's `pull --ff-only` aborts.
#   2. A janitor that classifies paths by directory prefix does not
#      recognise a root-level file as memory content and reports it as
#      foreign code, round after round.
#   3. With the archive moved off the repo (MEM_RAW_ARCHIVE), raw/ is
#      empty, the condition never fires, and the only thing that would
#      ever have reached git stays behind.
#
# As a PATHSPEC only if the file exists: git aborts on a pathspec that
# matches nothing and then stages NOTHING AT ALL — not even the
# captures. A memory that has never captured has no record, and that is
# not an edge case, it is every memory's first day.
$RecordPaths = @()
foreach ($n in @('raw-record.jsonl', 'raw-nachweis.jsonl')) {
  if (Test-Path -LiteralPath (Join-Path $Root $n)) { $RecordPaths += $n }
}
$Pathspec = (@('raw/') + $RecordPaths | ForEach-Object { '"{0}"' -f $_ }) -join ' '

if ($env:MEM_STOP_NO_PUSH -ne '1' -and (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
  $status = Invoke-Git ('-C "{0}" status --porcelain {1}' -f $Root, $Pathspec) 5
  if ($status.Out -and $status.Out.Trim()) {
    # Bring the remote in first (untracked captures never block a
    # fast-forward), then stage ONLY raw/ and the record — never
    # `git add -A`, which would drag local pipeline state in.
    Invoke-Git ('-C "{0}" pull --ff-only -q' -f $Root) 30 | Out-Null
    # Two sessions ending at once fight over .git/index.lock, and git
    # simply fails. Measured: of eight concurrent capture-commits, one
    # got through. Every loser swallowed its error and the hook still
    # reported success — so in a container that gets reclaimed, that
    # capture was gone. Waiting a moment turns the collision into a
    # queue.
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      $added = Invoke-Git ('-C "{0}" add {1}' -f $Root, $Pathspec) 30
      if ($added.Ok) { break }
      Start-Sleep -Seconds 1
    }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
    $committed = Invoke-Git ('-C "{0}" commit -q -m "capture: {1}"' -f $Root, $stamp) 30
    if ($committed.Ok) {
      $pushed = Invoke-Git ('-C "{0}" push -q origin HEAD:main' -f $Root) 30
      if (-not $pushed.Ok) {
        # Remote moved ahead — rebase once and retry.
        Invoke-Git ('-C "{0}" pull --rebase -q' -f $Root) 30 | Out-Null
        Invoke-Git ('-C "{0}" push -q origin HEAD:main' -f $Root) 30 | Out-Null
      }
    }
  }
}

# --- 3) Reflect (model, opt-in only) --------------------------------
if ($env:MEM_REFLECT -eq '1') {
  $Reflector = $null
  foreach ($c in @((Join-Path $Root 'bin/mem-reflect.ps1'), (Join-Path $Here 'mem-reflect.ps1'))) {
    if (Test-Path -LiteralPath $c) { $Reflector = $c; break }
  }
  if ($Reflector) {
    $env:CHEAP_MEM_ROOT = $Root
    try { $StdinJson | & $HostExe -NoProfile -File $Reflector *> $null } catch { }
  }
}

} finally {
  foreach ($t in @($GitOut, $GitErr)) {
    Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue
  }
}

exit 0
