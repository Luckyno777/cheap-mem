# mem-reflect.ps1 — native Windows PowerShell port of bin/mem-reflect.
#
# Stop-Hook style reflector: reads the session transcript and, throttled
# by byte-delta, spawns an AI headless session that decides whether
# anything substantial happened and writes a log entry + inbox message +
# git push.
#
# Wired in Claude Code (Windows) as a Stop hook — see install/windows.ps1.
# Stdin (JSON with transcript_path) is read directly.
#
# Required env:
#   CHEAP_MEM_ROOT
#
# Optional env:
#   MEM_HEADLESS                if set, skip (avoids infinite recursion)
#   MEM_REFLECT_THRESHOLD_BYTES default 400000
#   MEM_REFLECT_CMD             AI CLI. Default: `claude -p`
#   MEM_REFLECT_TIMEOUT         seconds (default 90)
#   MEM_REFLECT_PROMPT          override the prompt

$ErrorActionPreference = 'SilentlyContinue'

# Never recurse.
if ($env:MEM_HEADLESS) { exit 0 }

if (-not $env:CHEAP_MEM_ROOT) { exit 0 }
if (-not (Test-Path (Join-Path $env:CHEAP_MEM_ROOT '.mem\config.json'))) { exit 0 }

$Threshold = if ($env:MEM_REFLECT_THRESHOLD_BYTES) { [int64]$env:MEM_REFLECT_THRESHOLD_BYTES } else { 400000 }
$Timeout   = if ($env:MEM_REFLECT_TIMEOUT)         { [int]$env:MEM_REFLECT_TIMEOUT }         else { 90 }
$CmdLine   = if ($env:MEM_REFLECT_CMD)             { $env:MEM_REFLECT_CMD }                  else { 'claude -p' }

# Read stdin (JSON from Claude Code's Stop hook).
$stdinJson = ''
if (-not [Console]::IsInputRedirected -eq $false) {
  $stdinJson = [Console]::In.ReadToEnd()
}

$transcriptPath = ''
if ($stdinJson) {
  try {
    $j = $stdinJson | ConvertFrom-Json
    if ($j.transcript_path) { $transcriptPath = $j.transcript_path }
  } catch {}
}
if (-not $transcriptPath -and $env:TRANSCRIPT_PATH_ENV) {
  $transcriptPath = $env:TRANSCRIPT_PATH_ENV
}

if (-not $transcriptPath -or -not (Test-Path $transcriptPath)) {
  exit 0
}

# Marker keyed by transcript path (hashed).
$hash = [System.Security.Cryptography.SHA1]::Create().ComputeHash(
  [System.Text.Encoding]::UTF8.GetBytes($transcriptPath)
) | ForEach-Object { $_.ToString('x2') }
$hashHex = -join $hash

$markerDir = Join-Path $env:CHEAP_MEM_ROOT '.mem\reflect-marker'
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
$marker = Join-Path $markerDir $hashHex

$curSize = (Get-Item $transcriptPath).Length
$lastSize = 0
if (Test-Path $marker) {
  $lastSize = [int64](Get-Content $marker -ErrorAction SilentlyContinue)
}

$delta = $curSize - $lastSize
if ($delta -lt $Threshold) {
  # Under threshold — silent success. Do not update marker.
  exit 0
}

# Above threshold — record now, then run reflector.
$curSize | Set-Content -LiteralPath $marker

$defaultPrompt = @"
You are the reflector for cheap-mem. Read the transcript at `$TRANSCRIPT_PATH (env). Decide whether anything substantial happened since the last reflect.

If YES: write ONE inbox message to the librarian summarizing what you saw, and log at most three JSONL entries. Use absolute paths since your cwd is NOT the memory root:

  git -C `$CHEAP_MEM_ROOT pull --ff-only
  node `$CHEAP_MEM_ROOT\bin\mem log <type> --title ... --tags ...
  node `$CHEAP_MEM_ROOT\bin\mem inbox write --as session --to librarian --subject ... < body.md
  git -C `$CHEAP_MEM_ROOT add -A
  git -C `$CHEAP_MEM_ROOT commit -m 'reflect: <summary>'
  git -C `$CHEAP_MEM_ROOT push origin HEAD:main

If NO substantial change: exit silently, no log, no commit.
"@

$prompt = if ($env:MEM_REFLECT_PROMPT) { $env:MEM_REFLECT_PROMPT } else { $defaultPrompt }

$env:TRANSCRIPT_PATH = $transcriptPath
$env:MEM_HEADLESS    = 'reflector'

# Split CmdLine on whitespace into an exe + args array.
$parts = $CmdLine -split '\s+' | Where-Object { $_ }
$exe = $parts[0]
$argList = @()
if ($parts.Length -gt 1) { $argList = $parts[1..($parts.Length - 1)] }
$argList += $prompt

$job = Start-Job -ScriptBlock {
  param($e, $a, $tp, $root, $env_h)
  $env:TRANSCRIPT_PATH = $tp
  $env:CHEAP_MEM_ROOT  = $root
  $env:MEM_HEADLESS    = $env_h
  & $e @a
} -ArgumentList $exe, $argList, $transcriptPath, $env:CHEAP_MEM_ROOT, 'reflector'

$null = Wait-Job -Job $job -Timeout $Timeout
if ($job.State -eq 'Running') {
  Stop-Job -Job $job
}
Remove-Job -Job $job -Force
exit 0
