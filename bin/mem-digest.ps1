# mem-digest.ps1 — native Windows port of bin/mem-digest.
#
# Lane 2: the one model call. Runs on a Scheduled Task, checks whether
# the pile is ripe, and if so makes EXACTLY ONE model call that sorts
# the raw material into drawers.
#
# Required:
#   CHEAP_MEM_ROOT        absolute path to the memory
#
# Optional:
#   MEM_DIGEST_MAX_BYTES  most raw material per run (default 2000000)
#   MEM_DIGEST_TIMEOUT    seconds for the model call (default 600)
#   MEM_DIGEST_CMD        model CLI (default: claude)
#   MEM_DIGEST_ARGS       arguments before the prompt (default: -p)
#   MEM_DIGEST_LOG        log file (default: $ROOT\.mem\digest.log)
#
# Exit codes:
#   0  ran, or nothing to do
#   1  the model call failed, or did nothing
#   2  configuration error

$ErrorActionPreference = 'Continue'

if (-not $env:CHEAP_MEM_ROOT) { Write-Error 'env CHEAP_MEM_ROOT missing'; exit 2 }
$Root = $env:CHEAP_MEM_ROOT
if (-not (Test-Path (Join-Path $Root '.mem'))) {
  Write-Error "'$Root' has no .mem — run 'mem init' first"; exit 2
}

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Mem     = Join-Path $Here 'mem'
$Timeout = if ($env:MEM_DIGEST_TIMEOUT) { [int]$env:MEM_DIGEST_TIMEOUT } else { 600 }
$Cmd     = if ($env:MEM_DIGEST_CMD) { $env:MEM_DIGEST_CMD } else { 'claude' }
$CmdArgs = if ($env:MEM_DIGEST_ARGS) { $env:MEM_DIGEST_ARGS -split ' ' } else { @('-p') }
$MaxBytes = if ($env:MEM_DIGEST_MAX_BYTES) { [int]$env:MEM_DIGEST_MAX_BYTES } else { 2000000 }
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
$State = & node $Mem --root $Root digest due 2>&1
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
# a stale one from a crashed run is recognised — otherwise one crash
# blocks the digest forever.
$LockPath = Join-Path $Root '.mem\digest.lock'
if (Test-Path $LockPath) {
  $OldPid = (Get-Content $LockPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  $Alive = $false
  if ($OldPid -match '^\d+$') {
    $Alive = $null -ne (Get-Process -Id ([int]$OldPid) -ErrorAction SilentlyContinue)
  }
  if ($Alive) { Note "already running (pid $OldPid), skipping"; exit 0 }
  Note "stale lock from pid $OldPid — taking over"
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $LockPath -Value $PID

try {
  $PendingJson = & node $Mem --root $Root raw pending --json 2>&1
  if (-not $PendingJson) { Note 'could not read the pending state'; exit 1 }

  # Only hand one run as much material as a session can actually read.
  # The rest stays pending and the next tick takes it, so a backlog
  # drains over several runs instead of failing in one.
  $SelectScript = @'
const fs=require("fs"), path=require("path");
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  let o;try{o=JSON.parse(d)}catch{process.exit(1)}
  const max=Number(process.env.MAX), root=process.env.ROOT;
  if(!root){process.stderr.write("selection: ROOT missing\n");process.exit(2)}
  // A file whose size we cannot read counts as LARGE. The other way
  // round lets a silent stat error eat the whole cap.
  // Smallest first, so one huge capture does not block the rest.
  const sized=(o.open||[]).map(f=>{
    let s=Infinity;
    try{s=fs.statSync(path.join(root,f)).size}catch(e){}
    return {f,s};
  }).sort((a,b)=>a.s-b.s);
  const chosen=[];let sum=0;
  for(const {f,s} of sized){
    if(chosen.length && sum+s>max) break;
    chosen.push(f);sum+=s;
    if(sum>=max) break;
  }
  console.log(chosen.join("\n"));
});
'@
  $env:MAX = $MaxBytes
  $env:ROOT = $Root
  $Chosen = ($PendingJson | & node -e $SelectScript) -split "`n" | Where-Object { $_ }
  if (-not $Chosen) { Note 'nothing selected — nothing to do'; exit 0 }

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
2. Before writing, check for duplicates: mem find "<keyword>" --since 7d
3. Sort into drawers, every entry WITH --origin
4. Close any duty that is now fulfilled (mem duties lists them)
5. Mark as digested: mem raw digested <path1> <path2> ...
6. Commit and push.

Three to ten entries is normal. More than fifteen means you are not
condensing enough. Stop after the push.
"@

  # Remember how much was pending. The model call's exit code alone
  # says NOTHING about whether work happened — a session that fails on
  # permissions explains itself at length and exits 0.
  $CountScript = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String((JSON.parse(d).open||[]).length))}catch{process.stdout.write("-1")}})'
  $Before = (& node $Mem --root $Root raw pending --json 2>$null | & node -e $CountScript)

  # MEM_HEADLESS stops this call from triggering the Stop hook.
  # Start-Process cannot append, it truncates. Writing the model output
  # straight to $LogPath would erase every Note line above it — the log
  # would only ever show the last run's model chatter and none of the
  # decisions that led to it. So: temp files, appended afterwards.
  $OutTmp = Join-Path ([System.IO.Path]::GetTempPath()) "cheap-mem-digest-$PID.out"
  $ErrTmp = "$OutTmp.err"

  $env:MEM_HEADLESS = 'digest'
  try {
    $proc = Start-Process -FilePath $Cmd -ArgumentList ($CmdArgs + @($Prompt)) `
      -WorkingDirectory $Root -NoNewWindow -PassThru `
      -RedirectStandardOutput $OutTmp -RedirectStandardError $ErrTmp
    $Finished = $proc.WaitForExit($Timeout * 1000)
  } finally {
    # Also cleared on the timeout path — otherwise this process would
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
    Note 'effect not measurable (raw pending unreadable) — treating as failure'
    exit 1
  }
  if ([int]$After -ge [int]$Before) {
    Note "FAILED: the model call exited 0 but digested nothing ($Before -> $After)."
    Note '  Most common cause: the session was not allowed to run node.'
    Note "  The end of $LogPath shows what the session reported."
    exit 1
  }
  Note ("done — {0} captures digested" -f ([int]$Before - [int]$After))
  exit 0
}
finally {
  Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}
