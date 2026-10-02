# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# mem-digest.ps1 - native Windows port of bin/mem-digest.
#
# Lane 2: the one model call. Runs on a Scheduled Task, checks whether
# the pile is ripe, and if so makes EXACTLY ONE model call that sorts
# the raw material into drawers.
#
# Required:
#   CHEAP_MEM_ROOT        absolute path to the memory
#
# Optional:
#   MEM_DIGEST_MAX_BYTES  most raw material per run, bytes BEFORE packing (default 16000000)
#   MEM_DIGEST_AGE_RESERVE_PCT  share of MAX_BYTES for the OLDEST captures
#                         first (default 25; 0 = pure smallest first)
#   MEM_DIGEST_DEDUP_SINCE  window of the duplicate check, e.g. 30d
#                         (default empty = the whole memory)
#   MEM_DIGEST_TIMEOUT    seconds for the model call (default 600)
#   MEM_DIGEST_CMD        model CLI (default: claude)
#   MEM_DIGEST_ARGS       arguments before the prompt (default: -p)
#   MEM_DIGEST_LOG        log file (default: $ROOT\.mem\digest.log)
#   MEM_DIGEST_VOLUME_NOW_KB  dueness threshold: volume that is due at once
#   MEM_DIGEST_VOLUME_MIN_KB  dueness threshold: below this, never
#   MEM_DIGEST_QUIET_MIN      dueness threshold: quiet minutes
#   MEM_DIGEST_CEILING_H      dueness threshold: ceiling in hours
#
# Exit codes:
#   0  ran, or nothing to do
#   1  the model call failed, or did nothing
#   2  configuration error

$ErrorActionPreference = 'Continue'

if (-not $env:CHEAP_MEM_ROOT) { Write-Error 'env CHEAP_MEM_ROOT missing'; exit 2 }
$Root = $env:CHEAP_MEM_ROOT
if (-not (Test-Path (Join-Path $Root '.mem'))) {
  Write-Error "'$Root' has no .mem - run 'mem init' first"; exit 2
}

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Mem     = Join-Path $Here 'mem'
$Timeout = if ($env:MEM_DIGEST_TIMEOUT) { [int]$env:MEM_DIGEST_TIMEOUT } else { 600 }
# Same two knobs as the POSIX tick (bin/mem-digest says why and what was
# measured): the age reserve for the selection, and the window of the
# duplicate check - empty means the whole memory.
$AgeReservePct = if ($null -ne $env:MEM_DIGEST_AGE_RESERVE_PCT -and $env:MEM_DIGEST_AGE_RESERVE_PCT -ne '') { $env:MEM_DIGEST_AGE_RESERVE_PCT } else { '25' }
$DedupSince = [string]$env:MEM_DIGEST_DEDUP_SINCE
if ($DedupSince -and $DedupSince -notmatch '^[0-9]+[dhm]$') {
  [Console]::Error.WriteLine("error: MEM_DIGEST_DEDUP_SINCE='$DedupSince' is not a window like 30d, 24h or 90m (empty = whole memory)")
  exit 2
}
if ($DedupSince) {
  $DedupLine = "check for duplicates in the last ${DedupSince}: mem find `"<keyword>`" --since $DedupSince"
} else {
  $DedupLine = "check for duplicates across the whole memory: mem find `"<keyword>`""
}
$Cmd     = if ($env:MEM_DIGEST_CMD) { $env:MEM_DIGEST_CMD } else { 'claude' }
$CmdArgs = if ($env:MEM_DIGEST_ARGS) { $env:MEM_DIGEST_ARGS -split ' ' } else { @('-p') }
$MaxBytes = if ($env:MEM_DIGEST_MAX_BYTES) { [int]$env:MEM_DIGEST_MAX_BYTES } else { 16000000 }
$LogPath = if ($env:MEM_DIGEST_LOG) { $env:MEM_DIGEST_LOG } else { Join-Path $Root '.mem\digest.log' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Note($msg) {
  $line = "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $msg
  Write-Output $line
  Add-Content -Path $LogPath -Value $line
}

# --- Check dueness BEFORE taking the lock ---------------------------
#
# The tick runs often. In the normal case it must be back out within
# milliseconds and with no side effect. Only a ripe pile goes further.
#
# Exit codes of `mem digest due`: 0 no, 1 yes, 3 cannot tell.
#
# The thresholds are settable so that a TEST can establish dueness
# instead of borrowing it from however much raw material the checkout
# happens to carry. Without this a probe for "with work due, exactly one
# model call" is red below the volume threshold and green above it, with
# no code change in between - a colour that depends on the calendar
# rather than the code. The POSIX tick carries the same four knobs.
$DueArgs = @()
if ($env:MEM_DIGEST_VOLUME_NOW_KB) { $DueArgs += @('--volume-now', $env:MEM_DIGEST_VOLUME_NOW_KB) }
if ($env:MEM_DIGEST_VOLUME_MIN_KB) { $DueArgs += @('--volume-min', $env:MEM_DIGEST_VOLUME_MIN_KB) }
if ($env:MEM_DIGEST_QUIET_MIN)     { $DueArgs += @('--quiet',      $env:MEM_DIGEST_QUIET_MIN) }
if ($env:MEM_DIGEST_CEILING_H)     { $DueArgs += @('--ceiling',    $env:MEM_DIGEST_CEILING_H) }
$State = & node $Mem --root $Root digest due @DueArgs 2>&1
$DueCode = $LASTEXITCODE
switch ($DueCode) {
  0 { exit 0 }
  1 { }
  3 { Note "cannot tell whether due: $State"; exit 1 }
  default { Note "unexpected exit $DueCode from the dueness check"; exit 1 }
}
Note "due: $State"

# --- Never two digests at once --------------------------------------
#
# Windows has no flock. A lock file holding the PID works, as long as
# a stale one from a crashed run is recognised - otherwise one crash
# blocks the digest forever.
$LockPath = Join-Path $Root '.mem\digest.lock'
if (Test-Path $LockPath) {
  $OldPid = (Get-Content $LockPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  $Alive = $false
  if ($OldPid -match '^\d+$') {
    $Alive = $null -ne (Get-Process -Id ([int]$OldPid) -ErrorAction SilentlyContinue)
  }
  if ($Alive) { Note "already running (pid $OldPid), skipping"; exit 0 }
  Note "stale lock from pid $OldPid - taking over"
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $LockPath -Value $PID

try {
  $PendingJson = & node $Mem --root $Root raw pending --json 2>&1
  if (-not $PendingJson) { Note 'could not read the pending state'; exit 1 }

  # Only hand one run as much material as a session can actually read.
  # The rest stays pending and the next tick takes it, so a backlog
  # drains over several runs instead of failing in one.
  # Which captures: src/digestselect.mjs, the same module the POSIX tick
  # asks - an age reserve for the OLDEST captures first, then smallest
  # first. A capture with no known size counts as LARGE.
  # B19 (2026-09-30): bytes BEFORE packing (`rawSizes`), not gzipped.
  $SelectScript = @'
let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{
  let o;try{o=JSON.parse(d)}catch{process.exit(1)}
  if(!process.env.ROOT){process.stderr.write("selection: ROOT missing\n");process.exit(2)}
  if(!o.rawSizes){process.stderr.write("selection: raw pending --json has no rawSizes\n");process.exit(2)}
  let m;try{m=await import(process.argv[1])}catch(e){process.stderr.write("selection: "+e.message+"\n");process.exit(2)}
  const r=m.selectCaptures(o,{max:Number(process.env.MAX),reservePct:Number(process.env.RESERVE)});
  console.log(r.chosen.join("\n"));
});
'@
  $env:MAX = $MaxBytes
  $env:RESERVE = $AgeReservePct
  $env:ROOT = $Root
  $SelPath = [System.IO.Path]::GetFullPath((Join-Path $Here '../src/digestselect.mjs'))
  $SelUrl = ([System.Uri]::new($SelPath)).AbsoluteUri
  $Chosen = ($PendingJson | & node -e $SelectScript $SelUrl 2>$null) -split "`n" | Where-Object { $_ }
  # The selection stage's exit code is a verdict: a failure (unreadable
  # JSON, no rawSizes) leaves $Chosen empty and must not be reported as
  # "nothing to do".
  if ($LASTEXITCODE -ne 0) { Note "selection failed (exit $LASTEXITCODE)"; exit 1 }
  if (-not $Chosen) { Note 'nothing selected - nothing to do'; exit 0 }

  $Listing = ($Chosen | ForEach-Object { "  $_" }) -join "`n"
  $Prompt = @"
You are the digest for a cheap-mem memory. Read `$ROOT\DIGEST.md first and follow it.

Root: $Root
CLI:  node $Mem --root $Root <command>

Raw material for THIS run (only these, no more):
$Listing

Work like this:
1. Read each capture: mem raw show <path>
   Do NOT read a large capture in one go. Get the header first
   (--head reports __lines), then read in windows:
     mem raw show <path> --from 0 --count 400
   If a capture is too large to finish: do NOT mark it digested, write
   what you have, and log an error with --class digest-overflow.
2. Before writing, $DedupLine
3. Sort into drawers, every entry WITH --origin
   New project (DIGEST.md, section 'A new project'): ONLY when a topic
   appears in at least 2 captures on 2 different days and fits no
   existing project: mem project new <name> --title '<one sentence>'
   --reason '<how you saw it>' --captures '<path1,path2>'. Never guess;
   if the command names an existing project, use that one. A log with an
   unknown --project is refused: log it again without --project.
4. Close any duty that is now fulfilled (mem duties lists them)
5. Mark as digested: mem raw digested <path1> <path2> ...
6. Commit and push.

Three to ten entries is normal. More than fifteen means you are not
condensing enough. Stop after the push.
"@

  # Remember how much was pending. The model call's exit code alone
  # says NOTHING about whether work happened - a session that fails on
  # permissions explains itself at length and exits 0.
  $CountScript = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String((JSON.parse(d).open||[]).length))}catch{process.stdout.write("-1")}})'
  $Before = (& node $Mem --root $Root raw pending --json 2>$null | & node -e $CountScript)

  # MEM_HEADLESS stops this call from triggering the Stop hook.
  # Start-Process cannot append, it truncates. Writing the model output
  # straight to $LogPath would erase every Note line above it - the log
  # would only ever show the last run's model chatter and none of the
  # decisions that led to it. So: temp files, appended afterwards.
  $OutTmp = Join-Path ([System.IO.Path]::GetTempPath()) "cheap-mem-digest-$PID.out"
  $ErrTmp = "$OutTmp.err"

  $env:MEM_HEADLESS = 'digest'
  # Authority ceiling, as bin/mem-digest sets it: a model's output is an
  # inference, so `inferred` is the most it may claim (Y4b: this port
  # had lost it). src/memory.mjs enforces it on the write path.
  if (-not $env:CHEAP_MEM_MAX_AUTHORITY) { $env:CHEAP_MEM_MAX_AUTHORITY = 'inferred' }
  try {
    $proc = Start-Process -FilePath $Cmd -ArgumentList ($CmdArgs + @($Prompt)) `
      -WorkingDirectory $Root -NoNewWindow -PassThru `
      -RedirectStandardOutput $OutTmp -RedirectStandardError $ErrTmp
    $Finished = $proc.WaitForExit($Timeout * 1000)
  } finally {
    # Also cleared on the timeout path - otherwise this process would
    # keep MEM_HEADLESS set and silently stop capturing.
    Remove-Item Env:\MEM_HEADLESS -ErrorAction SilentlyContinue
  }

  foreach ($t in @($OutTmp, $ErrTmp)) {
    if (Test-Path $t) {
      Get-Content $t -ErrorAction SilentlyContinue | Add-Content -Path $LogPath
      Remove-Item $t -Force -ErrorAction SilentlyContinue
    }
  }

  if (-not $Finished) {
    try { $proc.Kill() } catch { }
    Note "model call timed out after ${Timeout}s"
    exit 1
  }
  $ModelExit = $proc.ExitCode

  if ($ModelExit -ne 0) { Note "model call exited $ModelExit"; exit 1 }

  # **Check the effect, do not trust the exit code.**
  $After = (& node $Mem --root $Root raw pending --json 2>$null | & node -e $CountScript)

  if ($Before -eq '-1' -or $After -eq '-1') {
    Note 'effect not measurable (raw pending unreadable) - treating as failure'
    exit 1
  }
  if ([int]$After -ge [int]$Before) {
    Note "FAILED: the model call exited 0 but digested nothing ($Before -> $After)."
    Note '  Most common cause: the session was not allowed to run node.'
    Note "  The end of $LogPath shows what the session reported."
    exit 1
  }
  Note ("done - {0} captures digested" -f ([int]$Before - [int]$After))
  exit 0
}
finally {
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}
