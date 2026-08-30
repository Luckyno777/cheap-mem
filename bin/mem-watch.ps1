# mem-watch.ps1 — native Windows PowerShell port of bin/mem-watch.
#
# Endless loop: every N seconds, look at the remote via `mem inbox watch`.
# Exit 1 means "post ready". Then: git pull, run the handler, keep watching.
#
# Two required env vars:
#   CHEAP_MEM_ROOT   Absolute path to the memory root (has .mem/config.json)
#   MEM_WATCH_WHO    Who this installation is (e.g. librarian, user, session)
#
# Optional:
#   MEM_WATCH_INTERVAL       seconds between polls (default 15)
#   MEM_WATCH_BROKEN_WAIT    seconds after network error (default 60)
#   MEM_WATCH_LOG            log file (default $CHEAP_MEM_ROOT/.mem/watch.log)
#   MEM_WATCH_HANDLER        path to handler script (default mem-handle-post.ps1)
#   MEM_WATCH_HANDLER_TIMEOUT seconds max for one handler run (default 300)
#   MEM_WATCH_BRANCH         remote branch (default: config defaultBranch)
#   MEM_WATCH_REMOTE         remote name (default: config defaultRemote)
#
# Wired via Task Scheduler by install/windows.ps1. Restart-on-failure is
# handled by the scheduler, not the script itself.

$ErrorActionPreference = 'Continue'

if (-not $env:CHEAP_MEM_ROOT) {
  Write-Error "env CHEAP_MEM_ROOT missing"
  exit 2
}
if (-not (Test-Path (Join-Path $env:CHEAP_MEM_ROOT '.git'))) {
  Write-Error "CHEAP_MEM_ROOT='$env:CHEAP_MEM_ROOT' is not a git clone"
  exit 2
}
if (-not (Test-Path (Join-Path $env:CHEAP_MEM_ROOT '.mem/config.json'))) {
  Write-Error "no .mem/config.json under CHEAP_MEM_ROOT — run 'mem init' first"
  exit 2
}
if (-not $env:MEM_WATCH_WHO) {
  Write-Error "env MEM_WATCH_WHO missing"
  exit 2
}

$Interval    = if ($env:MEM_WATCH_INTERVAL)    { [int]$env:MEM_WATCH_INTERVAL }    else { 15 }
$BrokenWait  = if ($env:MEM_WATCH_BROKEN_WAIT) { [int]$env:MEM_WATCH_BROKEN_WAIT } else { 60 }
$HandlerTimeout = if ($env:MEM_WATCH_HANDLER_TIMEOUT) { [int]$env:MEM_WATCH_HANDLER_TIMEOUT } else { 300 }
$LogPath = if ($env:MEM_WATCH_LOG) { $env:MEM_WATCH_LOG } else { Join-Path $env:CHEAP_MEM_ROOT '.mem\watch.log' }

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

$Here = Split-Path -Parent $PSCommandPath
$MemCli = Join-Path $Here 'mem'
if (-not (Test-Path $MemCli)) { $MemCli = 'mem' }

$Handler = if ($env:MEM_WATCH_HANDLER) {
  $env:MEM_WATCH_HANDLER
} else {
  Join-Path $Here 'mem-handle-post.ps1'
}

$LockPath = Join-Path $env:CHEAP_MEM_ROOT '.mem\watch.lock'

function Write-Note {
  param([string]$msg)
  $t = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $line = "[$t] $msg"
  Write-Host $line
  Add-Content -LiteralPath $LogPath -Value $line
}

function Invoke-Handler {
  # Windows has no flock. Use a stale-lock check: PID in the lock file.
  # If that PID still runs → another handler is active. Else stale → take.
  if (Test-Path $LockPath) {
    $lockPid = Get-Content -LiteralPath $LockPath -ErrorAction SilentlyContinue
    if ($lockPid -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
      Write-Note "handler: already running (pid $lockPid), skipping"
      return $true
    }
    Write-Note "handler: stale lock (pid $lockPid gone), taking over"
  }
  $PID | Set-Content -LiteralPath $LockPath

  try {
    Write-Note "handler: git pull --ff-only"
    $pull = & git -C $env:CHEAP_MEM_ROOT pull --ff-only 2>&1
    Add-Content -LiteralPath $LogPath -Value ($pull -join "`n")
    if ($LASTEXITCODE -ne 0) {
      Write-Note "handler: git pull failed — not running handler"
      return $false
    }

    if (-not (Test-Path $Handler)) {
      Write-Note "handler: no handler script at $Handler — post remains for a human to process"
      return $false
    }

    Write-Note "handler: running $Handler (timeout ${HandlerTimeout}s)"
    $env:MEM_HEADLESS = 'watcher'
    $job = Start-Job -ScriptBlock {
      param($h, $root, $log)
      $env:CHEAP_MEM_ROOT = $root
      $env:MEM_HEADLESS   = 'watcher'
      Set-Location $root
      & powershell -NoProfile -ExecutionPolicy Bypass -File $h 2>&1 | Out-File -Append -FilePath $log
    } -ArgumentList $Handler, $env:CHEAP_MEM_ROOT, $LogPath

    $done = Wait-Job -Job $job -Timeout $HandlerTimeout
    if (-not $done) {
      Write-Note "handler: timeout after ${HandlerTimeout}s — stopping"
      Stop-Job -Job $job
      Remove-Job -Job $job -Force
      return $false
    }
    Receive-Job -Job $job | Out-Null
    $exit = $job.ChildJobs[0].JobStateInfo.State
    Remove-Job -Job $job
    if ($exit -eq 'Completed') {
      Write-Note "handler: done"
      return $true
    }
    Write-Note "handler: exited with state $exit"
    return $false
  } finally {
    Remove-Item -LiteralPath $LockPath -ErrorAction SilentlyContinue
  }
}

# Ctrl-C / task-scheduler stop
$null = Register-EngineEvent PowerShell.Exiting -Action {
  Write-Note "watcher shutting down"
} -SupportEvent

Write-Note "watcher awake. INTERVAL=${Interval}s BROKEN_WAIT=${BrokenWait}s WHO=$($env:MEM_WATCH_WHO) ROOT=$($env:CHEAP_MEM_ROOT)"

$Fail = 0
$FailMax = 3
$FailWait = 900

$watchArgs = @('inbox', 'watch', '--as', $env:MEM_WATCH_WHO, '--root', $env:CHEAP_MEM_ROOT)
if ($env:MEM_WATCH_BRANCH) { $watchArgs += @('--branch', $env:MEM_WATCH_BRANCH) }
if ($env:MEM_WATCH_REMOTE) { $watchArgs += @('--remote', $env:MEM_WATCH_REMOTE) }

while ($true) {
  $output = & node $MemCli @watchArgs 2>&1
  Add-Content -LiteralPath $LogPath -Value ($output -join "`n")
  $code = $LASTEXITCODE

  switch ($code) {
    0 { Start-Sleep -Seconds $Interval }
    1 {
      Write-Note "watch: exit=1 — post for '$($env:MEM_WATCH_WHO)' on the remote"
      if (Invoke-Handler) {
        $Fail = 0
      } else {
        $Fail++
        if ($Fail -ge $FailMax) {
          Write-Note "handler: $Fail failures in a row — long pause ${FailWait}s (loop-guard)"
          Start-Sleep -Seconds $FailWait
          $Fail = 0
          continue
        }
      }
      Start-Sleep -Seconds $Interval
    }
    3 {
      Write-Note "watch: exit=3 — remote unreachable, waiting ${BrokenWait}s"
      Start-Sleep -Seconds $BrokenWait
    }
    default {
      Write-Note "watch: unexpected exit $code, waiting ${BrokenWait}s"
      Start-Sleep -Seconds $BrokenWait
    }
  }
}
