# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# install/windows.ps1 - install cheap-mem on native Windows.
#
# Sets up:
#   1. A Task Scheduler task that runs mem-watch.ps1 at logon and
#      restarts on failure.
#   2. Claude Desktop MCP server registration (writes to
#      %APPDATA%\Claude\claude_desktop_config.json).
#   3. Claude Code user-level hooks (writes to %USERPROFILE%\.claude\).
#
# Usage (PowerShell):
#   $env:CHEAP_MEM_ROOT = 'C:\path\to\your-memory'
#   $env:MEM_WATCH_WHO  = 'librarian'
#   powershell -NoProfile -ExecutionPolicy Bypass -File install\windows.ps1
#
# Uninstall:
#   Unregister-ScheduledTask -TaskName 'cheap-mem-watch' -Confirm:$false
#   Unregister-ScheduledTask -TaskName 'cheap-mem-digest' -Confirm:$false
#   powershell -File install\windows.ps1 -UninstallServeService   (optional mem serve task)

param(
  [switch]$SkipTask,
  [switch]$SkipClaudeDesktop,
  [switch]$SkipClaudeCode,
  # M10: optional `mem serve` task (dashboard + warm recall server).
  # Default OFF. -ServeService installs it without asking, -NoServeService
  # skips the question, -UninstallServeService removes it and exits.
  [switch]$ServeService,
  [switch]$NoServeService,
  [switch]$UninstallServeService
)

$ErrorActionPreference = 'Stop'

# ---------- 0. Removing the optional `mem serve` task (M10) ----------
#
# First, and on its own: uninstalling must work without CHEAP_MEM_ROOT
# and must touch nothing else.
$ServeTaskName = 'cheap-mem-serve'
if ($UninstallServeService) {
  Unregister-ScheduledTask -TaskName $ServeTaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed scheduled task: $ServeTaskName"
  exit 0
}

if (-not $env:CHEAP_MEM_ROOT) {
  Write-Error "env CHEAP_MEM_ROOT missing"
  exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $env:CHEAP_MEM_ROOT '.mem\config.json'))) {
  Write-Error "$env:CHEAP_MEM_ROOT\.mem\config.json not found - run 'node bin\mem init' first"
  exit 2
}

# Resolve the repo root (this script sits under <root>\install\).
$RepoRoot = (Get-Item -LiteralPath (Split-Path -Parent $PSCommandPath)).Parent.FullName
$WatchScript   = Join-Path $RepoRoot 'bin\mem-watch.ps1'
$McpScript     = Join-Path $RepoRoot 'bin\mem-mcp'
$ReflectScript = Join-Path $RepoRoot 'bin\mem-reflect.ps1'

# ---------- 1. Scheduled Task ----------

if (-not $SkipTask) {
  if (-not $env:MEM_WATCH_WHO) {
    Write-Error "env MEM_WATCH_WHO missing (participant name from .mem/config.json)"
    exit 2
  }

  $TaskName = 'cheap-mem-watch'

  # Remove any prior task before re-registering - idempotent.
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

  $action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchScript`""

  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650)

  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'cheap-mem inbox watcher' | Out-Null

  # Task Scheduler cannot itself set env vars per-task in a portable way.
  # We inject them by writing a small XML env-block via schtasks after
  # registration, or by having mem-watch.ps1 read from a per-user config.
  # Cleanest cross-version approach: set them in the user environment.
  [Environment]::SetEnvironmentVariable('CHEAP_MEM_ROOT', $env:CHEAP_MEM_ROOT, 'User')
  [Environment]::SetEnvironmentVariable('MEM_WATCH_WHO',  $env:MEM_WATCH_WHO,  'User')

  Start-ScheduledTask -TaskName $TaskName

  Write-Host "  scheduled task: $TaskName (starts at logon, restarts on failure)"
  Write-Host "  user env:       CHEAP_MEM_ROOT=$env:CHEAP_MEM_ROOT"
  Write-Host "  user env:       MEM_WATCH_WHO=$env:MEM_WATCH_WHO"
  Write-Host ""

  # ---------- 1b. The digest tick ----------
  #
  # A second task, every 10 minutes. It is deliberately cheap: it asks
  # `mem digest due` and is normally back out in milliseconds without a
  # lock, without git and without a model. The decision sits in the
  # dueness check (volume / quiet / ceiling), not in the schedule.
  #
  # Skip with MEM_SKIP_DIGEST=1 - useful when the digest should run on
  # a server rather than on this laptop.
  if ($env:MEM_SKIP_DIGEST -ne '1') {
    $DigestScript = Join-Path $RepoRoot 'bin\mem-digest.ps1'
    if (-not (Test-Path -LiteralPath $DigestScript)) {
      Write-Warning "mem-digest.ps1 not found at $DigestScript - skipping the digest task"
    } else {
      $DigestTask = 'cheap-mem-digest'
      Unregister-ScheduledTask -TaskName $DigestTask -Confirm:$false -ErrorAction SilentlyContinue

      $dAction = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DigestScript`""

      # At logon plus every 10 minutes, indefinitely.
      $dTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      $dTrigger.Repetition = (New-ScheduledTaskTrigger `
        -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 10) `
        -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

      # No RestartCount here: a failed digest must NOT be retried in a
      # tight loop. The next tick is ten minutes away, and that is the
      # right amount of patience for something that costs a model call.
      $dSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

      Register-ScheduledTask `
        -TaskName $DigestTask `
        -Action $dAction `
        -Trigger $dTrigger `
        -Settings $dSettings `
        -Principal $principal `
        -Description 'cheap-mem digest tick (one model call when the pile is ripe)' | Out-Null

      Write-Host "  scheduled task: $DigestTask (every 10 minutes)"
      Write-Host "                  it only checks; the model runs when the pile is ripe"
      Write-Host ""
    }
  }
}

# ---------- 2. Claude Desktop MCP registration ----------

if (-not $SkipClaudeDesktop) {
  $CdConfig = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
  New-Item -ItemType Directory -Force -Path (Split-Path $CdConfig) | Out-Null

  $cfg = @{}
  if (Test-Path -LiteralPath $CdConfig) {
    try {
      $cfg = Get-Content -LiteralPath $CdConfig -Raw | ConvertFrom-Json -AsHashtable
    } catch {
      Write-Warning "existing $CdConfig is not JSON - leaving it alone (skipping Claude Desktop wiring)"
      $cfg = $null
    }
  }

  if ($null -ne $cfg) {
    if (-not $cfg.ContainsKey('mcpServers')) { $cfg['mcpServers'] = @{} }
    $cfg['mcpServers']['cheap-mem'] = @{
      command = 'node'
      args    = @($McpScript)
      env     = @{ CHEAP_MEM_ROOT = $env:CHEAP_MEM_ROOT }
    }
    ($cfg | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $CdConfig -Encoding UTF8
    Write-Host "  Claude Desktop: $CdConfig updated"
    Write-Host "                  (restart Claude Desktop to pick up the change)"
  }
  Write-Host ""
}

# ---------- 3. Claude Code hooks + settings ----------

if (-not $SkipClaudeCode) {
  $ClaudeHome = Join-Path $env:USERPROFILE '.claude'
  $HooksDir   = Join-Path $ClaudeHome 'hooks'
  $Settings   = Join-Path $ClaudeHome 'settings.json'
  New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null

  # A hook script is written as UTF-8 WITH a byte-order mark, on every PowerShell. `Set-Content -Encoding UTF8` writes
  # the mark on Windows PowerShell 5.1 but not on PowerShell 7, and 5.1 - the `powershell` the hook commands start -
  # reads a script without one as ANSI: a baked path with a non-ASCII letter arrived as other characters, and some
  # of those are quote characters (shim-rest-cm, 2026-10-17). The text itself stays ASCII; the mark is the second belt.
  function Out-HookScript {
    param([string]$Path)
    $text = (@($input) -join [Environment]::NewLine) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($true)))
  }

  # Copy hooks with CHEAP_MEM_ROOT baked in.
  $startHookSrc = Join-Path $RepoRoot 'install\hooks\session-start.sh'
  $stopHookSrc  = Join-Path $RepoRoot 'install\hooks\session-stop.sh'

  # Where the CODE lives, as a hint for every hook below (the same job
  # CHEAP_MEM_CODE does in install/claude-code.sh). A memory made by
  # `mem init` carries no bin\, so a hook that looked only in the memory
  # found no tool, exited 0 and stayed silent (found 2026-10-16). The
  # environment variable wins when set; this baked path is the fallback.
  #
  # Baked into '...' strings, so every character PowerShell reads as a single quote is doubled, not only the ASCII one:
  # it also takes the typographic ones U+2018, U+2019, U+201A and U+201B as quotes, so a folder named with a curly
  # apostrophe ended the string early, the shim did not parse, and the hook was mute (shim-rest-cm, 2026-10-17).
  # Spelled with [char], because this file has to stay ASCII (Windows PowerShell 5.1 reads it as ANSI).
  $SingleQuoteChars = "['" + [char]0x2018 + [char]0x2019 + [char]0x201A + [char]0x201B + "]"
  $CodeHint = $RepoRoot -replace $SingleQuoteChars, '$0$0'
  # The memory path is baked in single quotes the same way (an apostrophe
  # in a path must not end the string).
  $RootHint = $env:CHEAP_MEM_ROOT -replace $SingleQuoteChars, '$0$0'

  # On native Windows, Claude Code hooks are PowerShell too.
  $startHookDst = Join-Path $HooksDir 'cheap-mem-session-start.ps1'
  $stopHookDst  = Join-Path $HooksDir 'cheap-mem-session-stop.ps1'
  # Measured 2026-09-19: these two did not exist, and neither did the
  # events that would have called them. See the note above Upsert-Hook.
  $promptHookDst = Join-Path $HooksDir 'cheap-mem-user-prompt.ps1'
  $editHookDst   = Join-Path $HooksDir 'cheap-mem-pre-edit.ps1'
  # The failure the exit code hid (M19 port from lucky-mem): PostToolUse,
  # matcher Bash only. See bin/mem-catch-fail.ps1's own header.
  $catchFailHookDst = Join-Path $HooksDir 'cheap-mem-catch-fail.ps1'
  # The failure the exit code REPORTED (X2b): PostToolUseFailure, matcher
  # Bash|Edit|Write. See bin/mem-after-failure.ps1's own header.
  $afterFailureHookDst = Join-Path $HooksDir 'cheap-mem-after-failure.ps1'
  # A subagent is its own thread and gets neither SessionStart nor
  # UserPromptSubmit (see src/subagentstart.mjs) - without this lane it
  # starts on Windows knowing nothing this memory holds, same class of
  # gap as the two lanes above.
  $subagentHookDst = Join-Path $HooksDir 'cheap-mem-subagent-start.ps1'
  $missingHookDst  = Join-Path $HooksDir 'cheap-mem-tool-missing.ps1'

  # Which copy of the tool a hook may run (tool-trust-cm, 2026-10-16): the one
  # rule, bin\_owntool.ps1, installed next to the hooks. Dot-sourced here too, to
  # know whether the user trusts this memory's own tool (the permission list).
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'bin\_owntool.ps1') -Destination (Join-Path $HooksDir 'cheap-mem-own-tool.ps1') -Force
  . (Join-Path $RepoRoot 'bin\_owntool.ps1')
  $ownTrusted = Test-OwnToolTrusted $env:CHEAP_MEM_ROOT
  $codeInsideMem = Test-OwnToolInside $RepoRoot $env:CHEAP_MEM_ROOT
  if ($codeInsideMem) {
    # The installed tool lies inside the memory: that is the memory's own tool,
    # whoever installed it - a git pull would change it under the hooks.
    if ($ownTrusted) {
      Write-Host '[install] this checkout lies inside the memory; trusted (mem trust-own-tool was run), so the hooks use it.'
    } else {
      Write-Warning "this checkout lies inside the memory, so it counts as the memory's own tool and the hooks will NOT run it until you trust it yourself: node $RepoRoot\bin\mem trust-own-tool --root $env:CHEAP_MEM_ROOT (see docs/security-model.md)"
    }
  }

  # What a hook says when its tool cannot be found (see
  # install/support/tool-missing.sh for the reasoning): systemMessage JSON on
  # stdout, exit 0 (never block), at most once per 30 minutes per hook.
  @'
param([string]$Name, [string]$Tool, [string]$Code, [string]$Root, [switch]$Skipped, [switch]$Rejected)
# -Skipped: the memory ships its own tool, the user never switched that on
# (mem trust-own-tool) and no installed tool could take its place (tool-trust-cm).
# That case speaks even without a code path: the hook would otherwise be silent
# on every prompt for a reason a person can fix in one line.
# -Rejected: the shim threw CHEAP_MEM_CODE out because it held a control character (shim-rest-cm); that speaks too.
if (-not $Code -and -not $Skipped -and -not $Rejected) { exit 0 }
# A control character is shown escaped, never raw (ConvertTo-Json below escapes the JSON; this keeps the terminal text clean).
if ($Code -match '[\x00-\x1f\x7f]') { $Code = [regex]::Replace($Code, '[\x00-\x1f\x7f]', { param($m) '\x{0:x2}' -f [int][char]$m.Value }) }
$noCode = 'no installed tool is configured'
if ($Rejected) { $noCode = 'CHEAP_MEM_CODE was rejected because it contains a control character such as a line break, tab or escape' }
if ($Skipped) {
  # Two different facts, said apart: the tool is MISSING, or it is THERE but lies in the memory and was passed over.
  $why = 'the memory ships its own tool, which is not trusted'
  if (-not $Code) { $why = "$why, and $noCode" }
  elseif (Test-Path -LiteralPath (Join-Path $Code "bin\$Tool")) { $why = "$why; the installed tool ($Code) lies inside the memory, so it counts as the memory's own and was passed over" }
  else { $why = "$why, and the installed tool is missing ($Code has no bin\$Tool)" }
}
elseif (-not $Code) { $why = "$noCode, so the hook has no installed tool" }
elseif (-not (Test-Path -LiteralPath $Code)) { $why = "the code path $Code does not exist" } else { $why = "$Code has no bin\$Tool" }
# The "at most every 30 minutes" marker lives in the USER's state directory, never in the memory: a memory is a
# git clone, and a committed symlink or junction at the old place (<memory>\.pipeline\tool-missing-<hook>) made the
# write land in whatever it pointed at (reviewer, 2026-10-16). The memory contributes only its path, as a hash.
if ($Root) {
  try {
    $base = $env:LOCALAPPDATA
    if (-not $base) { $base = Join-Path $HOME '.local\state' }
    $sha = New-Object System.Security.Cryptography.SHA1Managed
    $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Root))).Replace('-', '').Substring(0, 8)
    $dir = Join-Path $base 'cheap-mem'
    $mark = Join-Path $dir "tool-missing-$Name-$hash"
    $dirItem = Get-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    $markItem = Get-Item -LiteralPath $mark -Force -ErrorAction SilentlyContinue
    $linked = ($dirItem -and ($dirItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) -or ($markItem -and ($markItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint))
    if (-not $linked) {
      if ($markItem -and ((Get-Date) - $markItem.LastWriteTime).TotalMinutes -lt 30) { exit 0 }
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      Set-Content -LiteralPath $mark -Value ''
    }
  } catch { }
}
$msg = "cheap-mem: the $Name hook is SILENT - it cannot find its tool ($why), so it recalls nothing. Fix: run install\windows.ps1 from a current cheap-mem checkout."
if ($Skipped) { $msg = "$msg To run the memory's own tool instead: mem trust-own-tool (yourself, in a terminal; see docs/security-model.md)." }
$msg = "$msg Said at most every 30 minutes."
[Console]::Error.WriteLine($msg)
Write-Output (@{ systemMessage = $msg } | ConvertTo-Json -Compress)
exit 0
'@ | Out-HookScript $missingHookDst

  @"
# cheap-mem SessionStart hook (Windows).
#
# The path below is where the memory was at install time. It is a HINT,
# not the answer: on a second machine that directory does not exist. The
# hook used to exit 0 there - no memory, no error, no clue. Now it looks
# the memory up and SAYS SO when it cannot find one.
`$hint = '$RootHint'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
# Hook time starts here - the journal line at the bottom carries it.
`$hookStartMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# The hook JSON (session id) - read for the journal line only.
`$hookIn = ''
try { if ([Console]::IsInputRedirected) { `$hookIn = [Console]::In.ReadToEnd() } } catch { }

`$memRoot = `$null
foreach (`$candidate in @(
    `$env:CHEAP_MEM_ROOT,
    `$hint,
    (Join-Path `$env:USERPROFILE 'cheap-mem'),
    (Join-Path `$env:USERPROFILE 'my-memory'),
    (Join-Path `$env:USERPROFILE '.cheap-mem'))) {
  if ([string]::IsNullOrWhiteSpace(`$candidate)) { continue }
  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\config.json')) { `$memRoot = `$candidate; break }
}

if (-not `$memRoot) {
  Write-Host 'cheap-mem: no memory found - this session starts WITHOUT it.'
  Write-Host "  installed path was: `$hint"
  Write-Host '  Looked in: %USERPROFILE%\cheap-mem, \my-memory, \.cheap-mem'
  Write-Host '  Fix: clone the memory there, or re-run install\windows.ps1 on this machine.'
  exit 0
}
`$env:CHEAP_MEM_ROOT = `$memRoot

# Where the tool is (tool-trust-cm, 2026-10-16): the INSTALLED tool (the code
# path the installer named), else the tool next to this hook; the memory's own
# bin\mem only when the user switched that on (mem trust-own-tool). The memory is
# a git clone pulled from origin: code taken from it is code its remote can
# ship. cheap-mem-own-tool.ps1 (a copy of bin\_owntool.ps1) holds the rule.
`$codeRoot = if (`$env:CHEAP_MEM_CODE) { `$env:CHEAP_MEM_CODE } else { '$CodeHint' }
# A code path with a control character (a line break, tab, escape) is REJECTED, not used and not printed: the start hook
# writes it into the session's context, where a line break would start a line of someone else's choosing. Said on stderr,
# and by the missing-tool message (-Rejected); the hook goes on without it and never fails (shim-rest-cm, 2026-10-17).
`$codeRejected = `$false
if (`$codeRoot -match '[\x00-\x1f\x7f]') {
  `$codeRejected = `$true; `$codeRoot = ''; `$env:CHEAP_MEM_CODE = `$null
  [Console]::Error.WriteLine('cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character')
}
if (`$codeRoot -and (Test-Path -LiteralPath `$codeRoot)) { `$env:CHEAP_MEM_CODE = `$codeRoot }
`$mem = `$null
`$memOk = `$false
`$ownSkipped = `$false
`$ownShips = `$false
`$ownLib = Join-Path `$PSScriptRoot 'cheap-mem-own-tool.ps1'
if (Test-Path -LiteralPath `$ownLib) {
  . `$ownLib
  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel 'bin\mem' -Self `$PSScriptRoot
  if (`$found.Path) { `$mem = `$found.Path; `$memOk = `$true }
  `$ownSkipped = `$found.Skipped
  `$ownShips = (-not (Test-OwnToolTrusted `$env:CHEAP_MEM_ROOT)) -and (`$ownSkipped -or (Test-OwnToolShips `$env:CHEAP_MEM_ROOT))
}
if (-not `$mem) { `$mem = 'cheap-mem-tool-not-found' }

# R6: a V8 compile cache for the node starts below, in the USER's cache (never
# in the memory). Same rule as the other Windows hooks: a value already in the
# environment stays; a directory that cannot be made means no cache.
if (-not `$env:NODE_COMPILE_CACHE) {
  try {
    `$ccBase = `$null
    if (`$env:LOCALAPPDATA) { `$ccBase = `$env:LOCALAPPDATA }
    elseif (`$IsMacOS -and `$HOME) { `$ccBase = Join-Path `$HOME 'Library/Caches' }
    elseif (`$env:XDG_CACHE_HOME -and [System.IO.Path]::IsPathRooted(`$env:XDG_CACHE_HOME)) { `$ccBase = `$env:XDG_CACHE_HOME }
    elseif (`$HOME) { `$ccBase = Join-Path `$HOME '.cache' }
    if (`$ccBase) {
      `$ccDir = Join-Path (Join-Path `$ccBase 'cheap-mem') 'node-cc'
      New-Item -ItemType Directory -Force -Path `$ccDir -ErrorAction Stop | Out-Null
      `$env:NODE_COMPILE_CACHE = `$ccDir
    }
  } catch { }
}

if (`$memOk) {
  Write-Host '=== cheap-mem attached ==='
} else {
  Write-Host "=== cheap-mem NOT attached: memory found at `$env:CHEAP_MEM_ROOT, but no tool to read it with (installed: `$(if (`$codeRejected) { 'rejected, see below' } else { `$codeRoot })) ==="
  Write-Host "Recent context, alarm state and today line: UNKNOWN (not loaded, not 'nothing')."
  if (`$codeRoot) {
    Write-Host "The code path baked in by the installer has no tool: CHEAP_MEM_CODE=`$codeRoot (nothing under bin\ there)."
    Write-Host 'The other hooks (prompt recall, before-edit, subagent, stop) are SILENT for the same reason.'
    Write-Host "Fix: run install\windows.ps1 from a current cheap-mem checkout (CHEAP_MEM_ROOT=`$env:CHEAP_MEM_ROOT)."
  } elseif (`$codeRejected) {
    Write-Host 'The code path baked in by the installer was REJECTED: CHEAP_MEM_CODE holds a control character (a line break, tab or escape), so no tool was run from it.'
    Write-Host 'The other hooks (prompt recall, before-edit, subagent, stop) are SILENT for the same reason.'
    Write-Host "Fix: run install\windows.ps1 from a current cheap-mem checkout (CHEAP_MEM_ROOT=`$env:CHEAP_MEM_ROOT)."
  } else {
    Write-Host 'Fix: run install\windows.ps1 from a cheap-mem checkout (it names the code location and installs the tool the hooks run).'
    Write-Host 'A tool inside the memory is not run unless you trust that memory yourself (mem trust-own-tool).'
  }
}
if (`$ownShips) {
  if (`$memOk) {
    Write-Host '[hook] cheap-mem: memory ships its own tool; using the installed one. To trust it: mem trust-own-tool'
  } else {
    Write-Host '[hook] cheap-mem: memory ships its own tool and no installed tool was found; nothing is loaded. To trust it: mem trust-own-tool'
  }
  `$ownMemHint = if (`$codeRoot) { Join-Path `$codeRoot 'bin\mem' } else { '<installed cheap-mem>\bin\mem' }
  Write-Host "[hook]   (run it yourself in a terminal: node `$ownMemHint trust-own-tool --root `$env:CHEAP_MEM_ROOT; why: docs/security-model.md)"
}
Write-Host ''
# Which remote and branch does this memory TRACK? .mem\config.json says
# (defaultRemote / defaultBranch, the keys mem-watch reads). This hook used
# to fetch 'origin main', check out 'main' and pull, whatever the memory said:
# a clone on 'develop' ended up on a NEW local 'main' (see
# install/hooks/session-start.sh). Only a plain name goes to git: the config
# is data out of a cloned repository.
`$memRemote = 'origin'
`$memBranch = 'main'
try {
  `$trackCfg = Join-Path `$env:CHEAP_MEM_ROOT '.mem\config.json'
  if (Test-Path -LiteralPath `$trackCfg) {
    `$trackJson = Get-Content -LiteralPath `$trackCfg -Raw -ErrorAction Stop | ConvertFrom-Json
    `$r = [string]`$trackJson.defaultRemote
    `$b = [string]`$trackJson.defaultBranch
    if (`$r) {
      # The anchor is \z, not the end-of-line one (in .NET that also matches before a trailing newline). The refused value is printed clipped (40 characters,
      # printable ASCII only): it is data out of a file.
      `$rShow = (`$r -replace '[^\x20-\x7e]', '')
      if (`$rShow.Length -gt 40) { `$rShow = `$rShow.Substring(0, 40) + '...' }
      if (`$r -match '^[A-Za-z0-9][A-Za-z0-9._-]*\z' -and -not `$r.Contains('..')) {
        # A name that is no remote of THIS clone would be read by git as a path or URL.
        & git -C `$env:CHEAP_MEM_ROOT remote get-url -- `$r 2>`$null | Out-Null
        if (`$LASTEXITCODE -eq 0) { `$memRemote = `$r }
        else {
          # N5-1: origin stays either way, so a warning is only for a value somebody SET against a clone that has remotes.
          `$anyRemote = (& git -C `$env:CHEAP_MEM_ROOT remote 2>`$null | Out-String).Trim()
          if (`$r -cne 'origin' -and `$anyRemote) { Write-Host "[hook] WARNING: config defaultRemote '`$rShow' is not a remote of this clone - using origin" }
        }
      }
      else { Write-Host "[hook] WARNING: config defaultRemote '`$rShow' is not a plain remote name - using origin" }
    }
    if (`$b) {
      `$bShow = (`$b -replace '[^\x20-\x7e]', '')
      if (`$bShow.Length -gt 40) { `$bShow = `$bShow.Substring(0, 40) + '...' }
      if (`$b -match '^[A-Za-z0-9][A-Za-z0-9._/-]*\z' -and -not `$b.Contains('..') -and -not `$b.Contains('//') -and
          -not `$b.EndsWith('/') -and -not `$b.EndsWith('.lock')) { `$memBranch = `$b }
      else { Write-Host "[hook] WARNING: config defaultBranch '`$bShow' is not a plain branch name - using main" }
    }
  }
} catch { }
& git -C `$env:CHEAP_MEM_ROOT fetch `$memRemote `$memBranch 2>&1 | Select-Object -Last 1
& git -C `$env:CHEAP_MEM_ROOT checkout `$memBranch 2>&1 | Select-Object -Last 1
& git -C `$env:CHEAP_MEM_ROOT pull --ff-only `$memRemote `$memBranch 2>&1 | Select-Object -Last 1
Write-Host ''

# --- Which clone answers (D-B: src/provenance.mjs as a gate) -----------
#
# One line naming the clone that answers HERE: directory, state and age, how far behind
# origin, whether the tree is dirty. Always, at the start; during the session the recall hook adds
# the same line only when the clone is STALE (src/clonegate.mjs). Same as
# install/hooks/session-start.sh. Best-effort and silent.
try {
  # Through the rule (tool-trust-cm): the memory's own src\provenance.mjs is imported by node only with the switch.
  `$provSrc = `$null
  if (Test-Path -LiteralPath `$ownLib) { `$provSrc = (Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel 'src\provenance.mjs' -Self `$PSScriptRoot).Path }
  if (`$provSrc) {
    `$env:MEM_SS_PROV = ([System.Uri]::new([System.IO.Path]::GetFullPath(`$provSrc))).AbsoluteUri
    `$provScript = @'
      import(process.env.MEM_SS_PROV).then((m) => {
        process.stdout.write(m.asLine(m.provenance(process.env.CHEAP_MEM_ROOT)));
      }).catch(() => {});
'@
    `$provLine = (& node -e `$provScript 2>`$null) -join ''
    if (`$provLine) { Write-Host `$provLine }
  }
} catch { }

`$facts = Join-Path `$env:CHEAP_MEM_ROOT 'FACTS.md'
if (Test-Path -LiteralPath `$facts) {
  Write-Host '=== FACTS (always loaded) ==='
  Get-Content -LiteralPath `$facts
  Write-Host ''
}

if (`$memOk) {
  Write-Host '=== mem context ==='
  & node `$mem context --n 10
  Write-Host ''
}

# --- How the human user works, measured (parity with the POSIX hook) -
#
# mem user --session-start already enforces every guarantee this line
# needs (at most 5 lines, only patterns at or above the higher display
# bar, only actionable ones) - see install/hooks/session-start.sh for
# the reasoning. This hook adds nothing beyond calling it and deciding
# whether to print what came back: an empty string, from "not enough
# evidence" or "no capture readable at all" alike, prints nothing.
if (`$memOk) {
  try {
    `$habits = & node `$mem user --session-start 2>`$null
    if (`$habits) {
      `$habits | ForEach-Object { Write-Host `$_ }
      Write-Host ''
    }
  } catch { }
}

# --- What is down right now -------------------------------------------
#
# Same reasoning as install/hooks/session-start.sh: --alarm prints
# level ERROR only, and prints NOTHING when nothing is red, so there is
# no unconditional Write-Host outside the checks below. Windows has no
# timeout binary, so the cap is a background job with a wait limit -
# the same shape bin/mem-watch.ps1 and bin/mem-reflect.ps1 already use.
# A cap that expires reports itself as expired, never as "all fine".
if (`$memOk) {
  try {
    `$alarmSeconds = 8
    if (`$env:MEM_ALARM_SECONDS) { `$alarmSeconds = [int]`$env:MEM_ALARM_SECONDS }
    `$alarmJob = Start-Job -ScriptBlock {
      param(`$m)
      & node `$m doctor --alarm 2>`$null
    } -ArgumentList `$mem
    `$alarmDone = Wait-Job -Job `$alarmJob -Timeout `$alarmSeconds
    if (-not `$alarmDone) {
      Stop-Job -Job `$alarmJob -ErrorAction SilentlyContinue
      Remove-Job -Job `$alarmJob -Force -ErrorAction SilentlyContinue
      Write-Host '=== DOWN RIGHT NOW ==='
      Write-Host "The alarm hit its time cap (`$alarmSeconds s) - NOT checked."
      Write-Host "By hand: node `$mem doctor --quiet"
      Write-Host ''
    } else {
      `$alarmOut = Receive-Job -Job `$alarmJob -ErrorAction SilentlyContinue
      Remove-Job -Job `$alarmJob -Force -ErrorAction SilentlyContinue
      if (`$alarmOut) {
        Write-Host '=== DOWN RIGHT NOW (mem doctor --alarm) ==='
        `$alarmOut | ForEach-Object { Write-Host `$_ }
        Write-Host ''
      }
    }
  } catch { }
}

# --- "Today" (N8/N21 parity: one source, three surfaces) --------------
#
# Same reasoning as install/hooks/session-start.sh: `mem today --line`
# (src/today.mjs) is the SAME function `mem today` and the dashboard's
# Today card read, and it prints nothing at all when there is nothing
# notable, so there is no unconditional Write-Host outside the check
# below. Own time-cap job, same shape as the alarm above.
if (`$memOk) {
  try {
    `$todaySeconds = 5
    if (`$env:MEM_TODAY_SECONDS) { `$todaySeconds = [int]`$env:MEM_TODAY_SECONDS }
    `$todayJob = Start-Job -ScriptBlock {
      param(`$m)
      & node `$m today --line 2>`$null
    } -ArgumentList `$mem
    `$todayDone = Wait-Job -Job `$todayJob -Timeout `$todaySeconds
    if (-not `$todayDone) {
      Stop-Job -Job `$todayJob -ErrorAction SilentlyContinue
      Remove-Job -Job `$todayJob -Force -ErrorAction SilentlyContinue
    } else {
      `$todayOut = Receive-Job -Job `$todayJob -ErrorAction SilentlyContinue
      Remove-Job -Job `$todayJob -Force -ErrorAction SilentlyContinue
      if (`$todayOut) {
        `$todayOut | ForEach-Object { Write-Host `$_ }
        Write-Host ''
      }
    }
  } catch { }
}

# --- The journal line (X2b) -------------------------------------------
#
# The session-start occasion had no journal line: every other hook booked
# what it delivered, this one printed into the context and left no trace.
# One line, occasion `session-start`, reason null (delivered); bytes and
# hits are not counted here (the block is printed in several pieces - not
# measured is not 0). Same as install/hooks/session-start.sh. Best-effort
# and silent.
try {
  `$injection = `$null
  if (Test-Path -LiteralPath `$ownLib) { `$injection = (Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel 'src\injection.mjs' -Self `$PSScriptRoot).Path }
  if (`$injection) {
    `$env:MEM_SS_SRC = ([System.Uri]::new([System.IO.Path]::GetFullPath(`$injection))).AbsoluteUri
    `$env:MEM_SS_INPUT = `$hookIn
    `$env:MEM_SS_START_MS = [string]`$hookStartMs
    # Single quotes only: Windows PowerShell 5.1 passes the double quotes inside a native argument unescaped and node
    # cuts the snippet apart at them (CI run 1180; the rule: test/ps51-node-snippet.test.mjs).
    `$bookScript = @'
      import(process.env.MEM_SS_SRC).then((m) => {
        let session = null;
        try { session = String(JSON.parse(process.env.MEM_SS_INPUT).session_id || '') || null; } catch { }
        const start = Number(process.env.MEM_SS_START_MS);
        m.book(process.env.CHEAP_MEM_ROOT, {
          session, occasion: m.OCCASION.SESSION_START, reason: null,
          bytes: null, hits: 0, searched: null,
          durationMs: Number.isFinite(start) && start > 0 ? Date.now() - start : null,
        });
      }).catch(() => {});
'@
    & node -e `$bookScript 2>`$null | Out-Null
  }
} catch { }

Write-Host '=== how to use this memory this session ==='
Write-Host ''
Write-Host 'Log substantial things as they happen:'
Write-Host "  node `$mem log event    --title <text> --tags <tag1,tag2>"
Write-Host "  node `$mem log decision --topic <text> --choice <choice> --why <reason>"
Write-Host "  node `$mem log error    --class <name> --title <text> --text <details>"
Write-Host ''
Write-Host 'Look for known context before asking:'
Write-Host "  node `$mem find <query>"
Write-Host ''
Write-Host 'Send an inbox message (delivered after commit + push):'
Write-Host "  node `$mem inbox write --as session --to librarian --subject <text> < body.md"
Write-Host ''
Write-Host 'The Stop hook (cheap-mem-session-stop.ps1) will reflect automatically once the'
Write-Host 'transcript grows past the byte-delta threshold.'
"@ | Out-HookScript $startHookDst

  @"
# cheap-mem Stop hook (Windows). Delegates to mem-stop.ps1.
#
# NOT to mem-reflect.ps1, which is what stood here until 2026-09-19.
# That is a MODEL call, and bin/mem-stop exists precisely to replace it
# on this event: capture model-free and always, commit, push, and run
# the model summary only behind MEM_REFLECT=1. In a sandbox without a
# model the reflect path ran nothing at all, so the session captured
# nothing -- and told no one.
# Same lookup as the start hook - see the note there. This one stays
# quiet on a miss: the start hook has already said it once per session,
# and repeating it after every turn would train people to ignore it.
`$hint = '$RootHint'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
`$memRoot = `$null
foreach (`$candidate in @(
    `$env:CHEAP_MEM_ROOT,
    `$hint,
    (Join-Path `$env:USERPROFILE 'cheap-mem'),
    (Join-Path `$env:USERPROFILE 'my-memory'),
    (Join-Path `$env:USERPROFILE '.cheap-mem'))) {
  if ([string]::IsNullOrWhiteSpace(`$candidate)) { continue }
  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\config.json')) { `$memRoot = `$candidate; break }
}
if (-not `$memRoot) { exit 0 }
`$env:CHEAP_MEM_ROOT = `$memRoot
`$rel = 'bin\mem-stop.ps1'
`$codeRoot = if (`$env:CHEAP_MEM_CODE) { `$env:CHEAP_MEM_CODE } else { '$CodeHint' }
# A code path with a control character is rejected, not used (see the start hook); the missing-tool message says so.
`$codeRejected = `$false
if (`$codeRoot -match '[\x00-\x1f\x7f]') {
  `$codeRejected = `$true; `$codeRoot = ''; `$env:CHEAP_MEM_CODE = `$null
  [Console]::Error.WriteLine('cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character')
}
# Which tool runs (tool-trust-cm): the installed one, else the one next to this hook; the memory's own
# bin\ only with mem trust-own-tool (cheap-mem-own-tool.ps1, a copy of bin\_owntool.ps1).
`$stop = `$null
`$skipped = `$false
`$ownLib = Join-Path `$PSScriptRoot 'cheap-mem-own-tool.ps1'
if (Test-Path -LiteralPath `$ownLib) {
  . `$ownLib
  if (`$codeRoot) { `$env:CHEAP_MEM_CODE = `$codeRoot }
  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel `$rel -Self `$PSScriptRoot
  `$stop = `$found.Path
  `$skipped = `$found.Skipped
}
if (-not `$stop) {
  # Say so instead of exiting silent (cheap-mem-tool-missing.ps1).
  `$missing = Join-Path `$PSScriptRoot 'cheap-mem-tool-missing.ps1'
  if (Test-Path -LiteralPath `$missing) { & `$missing -Name 'session-stop' -Tool 'mem-stop.ps1' -Code `$codeRoot -Root `$env:CHEAP_MEM_ROOT -Skipped:`$skipped -Rejected:`$codeRejected }
  exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `$stop
"@ | Out-HookScript $stopHookDst

  # --- The two lanes that were missing entirely ------------------------
  #
  # **Measured 2026-09-19.** `install/claude-code.sh` registers FOUR
  # events (SessionStart, Stop, UserPromptSubmit, PreToolUse with the
  # matcher Edit|Write|NotebookEdit). This installer registered TWO.
  # There was no UserPromptSubmit and no PreToolUse registration at all.
  #
  # So on Windows the recall lane and the before-edit lane never ran -
  # not because they were broken, but because nothing ever called them.
  # The same week the PowerShell ports of those lanes were written and
  # guarded, which fixed the level below this one: the hooks existed,
  # were tested, executed on a Windows runner, and on a real install
  # still nobody asked for them. This repo has a name for that class:
  # `built-but-out-of-reach`.
  #
  # Both wrappers repeat the lookup of the start hook - the path baked
  # in here is a HINT, not the answer. They stay silent on a miss: the
  # start hook already said it once per session, and a hook that
  # complains before every message and every edit trains people to stop
  # reading it.

  @"
# cheap-mem UserPromptSubmit hook (Windows). Delegates to mem-retrieve.ps1.
# The recall lane: it runs before every message of yours and blends in
# what the memory already knows. Model-free.
`$hint = '$RootHint'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
`$memRoot = `$null
foreach (`$candidate in @(
    `$env:CHEAP_MEM_ROOT,
    `$hint,
    (Join-Path `$env:USERPROFILE 'cheap-mem'),
    (Join-Path `$env:USERPROFILE 'my-memory'),
    (Join-Path `$env:USERPROFILE '.cheap-mem'))) {
  if ([string]::IsNullOrWhiteSpace(`$candidate)) { continue }
  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\config.json')) { `$memRoot = `$candidate; break }
}
if (-not `$memRoot) { exit 0 }
`$env:CHEAP_MEM_ROOT = `$memRoot
`$rel = 'bin\mem-retrieve.ps1'
`$codeRoot = if (`$env:CHEAP_MEM_CODE) { `$env:CHEAP_MEM_CODE } else { '$CodeHint' }
# A code path with a control character is rejected, not used (see the start hook); the missing-tool message says so.
`$codeRejected = `$false
if (`$codeRoot -match '[\x00-\x1f\x7f]') {
  `$codeRejected = `$true; `$codeRoot = ''; `$env:CHEAP_MEM_CODE = `$null
  [Console]::Error.WriteLine('cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character')
}
# Which tool runs (tool-trust-cm): the installed one, else the one next to this hook; the memory's own
# bin\ only with mem trust-own-tool (cheap-mem-own-tool.ps1, a copy of bin\_owntool.ps1).
`$retrieve = `$null
`$skipped = `$false
`$ownLib = Join-Path `$PSScriptRoot 'cheap-mem-own-tool.ps1'
if (Test-Path -LiteralPath `$ownLib) {
  . `$ownLib
  if (`$codeRoot) { `$env:CHEAP_MEM_CODE = `$codeRoot }
  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel `$rel -Self `$PSScriptRoot
  `$retrieve = `$found.Path
  `$skipped = `$found.Skipped
}
if (-not `$retrieve) {
  # Say so instead of exiting silent (cheap-mem-tool-missing.ps1).
  `$missing = Join-Path `$PSScriptRoot 'cheap-mem-tool-missing.ps1'
  if (Test-Path -LiteralPath `$missing) { & `$missing -Name 'user-prompt' -Tool 'mem-retrieve.ps1' -Code `$codeRoot -Root `$env:CHEAP_MEM_ROOT -Skipped:`$skipped -Rejected:`$codeRejected }
  exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `$retrieve
"@ | Out-HookScript $promptHookDst

  @"
# cheap-mem PreToolUse hook (Windows). Delegates to mem-before-edit.ps1.
# The before-edit lane: it runs before an Edit/Write/NotebookEdit (or a
# Bash command that writes a file) and shows what the memory holds
# about THAT file. Model-free.
`$hint = '$RootHint'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
`$memRoot = `$null
foreach (`$candidate in @(
    `$env:CHEAP_MEM_ROOT,
    `$hint,
    (Join-Path `$env:USERPROFILE 'cheap-mem'),
    (Join-Path `$env:USERPROFILE 'my-memory'),
    (Join-Path `$env:USERPROFILE '.cheap-mem'))) {
  if ([string]::IsNullOrWhiteSpace(`$candidate)) { continue }
  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\config.json')) { `$memRoot = `$candidate; break }
}
if (-not `$memRoot) { exit 0 }
`$env:CHEAP_MEM_ROOT = `$memRoot
`$rel = 'bin\mem-before-edit.ps1'
`$codeRoot = if (`$env:CHEAP_MEM_CODE) { `$env:CHEAP_MEM_CODE } else { '$CodeHint' }
# A code path with a control character is rejected, not used (see the start hook); the missing-tool message says so.
`$codeRejected = `$false
if (`$codeRoot -match '[\x00-\x1f\x7f]') {
  `$codeRejected = `$true; `$codeRoot = ''; `$env:CHEAP_MEM_CODE = `$null
  [Console]::Error.WriteLine('cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character')
}
# Which tool runs (tool-trust-cm): the installed one, else the one next to this hook; the memory's own
# bin\ only with mem trust-own-tool (cheap-mem-own-tool.ps1, a copy of bin\_owntool.ps1).
`$before = `$null
`$skipped = `$false
`$ownLib = Join-Path `$PSScriptRoot 'cheap-mem-own-tool.ps1'
if (Test-Path -LiteralPath `$ownLib) {
  . `$ownLib
  if (`$codeRoot) { `$env:CHEAP_MEM_CODE = `$codeRoot }
  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel `$rel -Self `$PSScriptRoot
  `$before = `$found.Path
  `$skipped = `$found.Skipped
}
if (-not `$before) {
  # Say so instead of exiting silent (cheap-mem-tool-missing.ps1).
  `$missing = Join-Path `$PSScriptRoot 'cheap-mem-tool-missing.ps1'
  if (Test-Path -LiteralPath `$missing) { & `$missing -Name 'pre-edit' -Tool 'mem-before-edit.ps1' -Code `$codeRoot -Root `$env:CHEAP_MEM_ROOT -Skipped:`$skipped -Rejected:`$codeRejected }
  exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `$before
"@ | Out-HookScript $editHookDst

  @"
# cheap-mem PostToolUse hook (Windows), matcher Bash. Delegates to
# mem-catch-fail.ps1. Catches a Bash call that exits 0 while its own
# output carries a failure signature - PostToolUseFailure never fires
# for that case at all. Model-free.
`$hint = '$RootHint'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
`$memRoot = `$null
foreach (`$candidate in @(
    `$env:CHEAP_MEM_ROOT,
    `$hint,
    (Join-Path `$env:USERPROFILE 'cheap-mem'),
    (Join-Path `$env:USERPROFILE 'my-memory'),
    (Join-Path `$env:USERPROFILE '.cheap-mem'))) {
  if ([string]::IsNullOrWhiteSpace(`$candidate)) { continue }
  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\config.json')) { `$memRoot = `$candidate; break }
}
if (-not `$memRoot) { exit 0 }
`$env:CHEAP_MEM_ROOT = `$memRoot
`$rel = 'bin\mem-catch-fail.ps1'
`$codeRoot = if (`$env:CHEAP_MEM_CODE) { `$env:CHEAP_MEM_CODE } else { '$CodeHint' }
# A code path with a control character is rejected, not used (see the start hook); the missing-tool message says so.
`$codeRejected = `$false
if (`$codeRoot -match '[\x00-\x1f\x7f]') {
  `$codeRejected = `$true; `$codeRoot = ''; `$env:CHEAP_MEM_CODE = `$null
  [Console]::Error.WriteLine('cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character')
}
# Which tool runs (tool-trust-cm): the installed one, else the one next to this hook; the memory's own
# bin\ only with mem trust-own-tool (cheap-mem-own-tool.ps1, a copy of bin\_owntool.ps1).
`$catchFail = `$null
`$skipped = `$false
`$ownLib = Join-Path `$PSScriptRoot 'cheap-mem-own-tool.ps1'
if (Test-Path -LiteralPath `$ownLib) {
  . `$ownLib
  if (`$codeRoot) { `$env:CHEAP_MEM_CODE = `$codeRoot }
  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel `$rel -Self `$PSScriptRoot
  `$catchFail = `$found.Path
  `$skipped = `$found.Skipped
}
if (-not `$catchFail) {
  # Say so instead of exiting silent (cheap-mem-tool-missing.ps1).
  `$missing = Join-Path `$PSScriptRoot 'cheap-mem-tool-missing.ps1'
  if (Test-Path -LiteralPath `$missing) { & `$missing -Name 'catch-fail' -Tool 'mem-catch-fail.ps1' -Code `$codeRoot -Root `$env:CHEAP_MEM_ROOT -Skipped:`$skipped -Rejected:`$codeRejected }
  exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `$catchFail
"@ | Out-HookScript $catchFailHookDst

  @"
# cheap-mem PostToolUseFailure hook (Windows), matcher Bash|Edit|Write.
# Delegates to mem-after-failure.ps1 (X2b). The opposite case of the
# catch-fail hook above: a tool call that REALLY failed. PostToolUse
# never fires on a failure, so before this hook a command that exited
# nonzero got no recall at all. Model-free.
`$hint = '$RootHint'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
`$memRoot = `$null
foreach (`$candidate in @(
    `$env:CHEAP_MEM_ROOT,
    `$hint,
    (Join-Path `$env:USERPROFILE 'cheap-mem'),
    (Join-Path `$env:USERPROFILE 'my-memory'),
    (Join-Path `$env:USERPROFILE '.cheap-mem'))) {
  if ([string]::IsNullOrWhiteSpace(`$candidate)) { continue }
  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\config.json')) { `$memRoot = `$candidate; break }
}
if (-not `$memRoot) { exit 0 }
`$env:CHEAP_MEM_ROOT = `$memRoot
`$rel = 'bin\mem-after-failure.ps1'
`$codeRoot = if (`$env:CHEAP_MEM_CODE) { `$env:CHEAP_MEM_CODE } else { '$CodeHint' }
# A code path with a control character is rejected, not used (see the start hook); the missing-tool message says so.
`$codeRejected = `$false
if (`$codeRoot -match '[\x00-\x1f\x7f]') {
  `$codeRejected = `$true; `$codeRoot = ''; `$env:CHEAP_MEM_CODE = `$null
  [Console]::Error.WriteLine('cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character')
}
# Which tool runs (tool-trust-cm): the installed one, else the one next to this hook; the memory's own
# bin\ only with mem trust-own-tool (cheap-mem-own-tool.ps1, a copy of bin\_owntool.ps1).
`$afterFailure = `$null
`$skipped = `$false
`$ownLib = Join-Path `$PSScriptRoot 'cheap-mem-own-tool.ps1'
if (Test-Path -LiteralPath `$ownLib) {
  . `$ownLib
  if (`$codeRoot) { `$env:CHEAP_MEM_CODE = `$codeRoot }
  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel `$rel -Self `$PSScriptRoot
  `$afterFailure = `$found.Path
  `$skipped = `$found.Skipped
}
if (-not `$afterFailure) {
  # Say so instead of exiting silent (cheap-mem-tool-missing.ps1).
  `$missing = Join-Path `$PSScriptRoot 'cheap-mem-tool-missing.ps1'
  if (Test-Path -LiteralPath `$missing) { & `$missing -Name 'after-failure' -Tool 'mem-after-failure.ps1' -Code `$codeRoot -Root `$env:CHEAP_MEM_ROOT -Skipped:`$skipped -Rejected:`$codeRejected }
  exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `$afterFailure
"@ | Out-HookScript $afterFailureHookDst

  @"
# cheap-mem SubagentStart hook (Windows). Delegates to mem-subagent-start.ps1.
# A subagent gets neither SessionStart nor UserPromptSubmit (its own
# thread - src/gauges.mjs), so this shows it any procedure tagged
# 'subagent-start' plus a context recap. Model-free, no matcher: every
# subagent type gets the same block.
`$hint = '$RootHint'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
`$memRoot = `$null
foreach (`$candidate in @(
    `$env:CHEAP_MEM_ROOT,
    `$hint,
    (Join-Path `$env:USERPROFILE 'cheap-mem'),
    (Join-Path `$env:USERPROFILE 'my-memory'),
    (Join-Path `$env:USERPROFILE '.cheap-mem'))) {
  if ([string]::IsNullOrWhiteSpace(`$candidate)) { continue }
  if (Test-Path -LiteralPath (Join-Path `$candidate '.mem\config.json')) { `$memRoot = `$candidate; break }
}
if (-not `$memRoot) { exit 0 }
`$env:CHEAP_MEM_ROOT = `$memRoot
`$rel = 'bin\mem-subagent-start.ps1'
`$codeRoot = if (`$env:CHEAP_MEM_CODE) { `$env:CHEAP_MEM_CODE } else { '$CodeHint' }
# A code path with a control character is rejected, not used (see the start hook); the missing-tool message says so.
`$codeRejected = `$false
if (`$codeRoot -match '[\x00-\x1f\x7f]') {
  `$codeRejected = `$true; `$codeRoot = ''; `$env:CHEAP_MEM_CODE = `$null
  [Console]::Error.WriteLine('cheap-mem: CHEAP_MEM_CODE rejected: it contains a control character')
}
# Which tool runs (tool-trust-cm): the installed one, else the one next to this hook; the memory's own
# bin\ only with mem trust-own-tool (cheap-mem-own-tool.ps1, a copy of bin\_owntool.ps1).
`$subagent = `$null
`$skipped = `$false
`$ownLib = Join-Path `$PSScriptRoot 'cheap-mem-own-tool.ps1'
if (Test-Path -LiteralPath `$ownLib) {
  . `$ownLib
  if (`$codeRoot) { `$env:CHEAP_MEM_CODE = `$codeRoot }
  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel `$rel -Self `$PSScriptRoot
  `$subagent = `$found.Path
  `$skipped = `$found.Skipped
}
if (-not `$subagent) {
  # Say so instead of exiting silent (cheap-mem-tool-missing.ps1).
  `$missing = Join-Path `$PSScriptRoot 'cheap-mem-tool-missing.ps1'
  if (Test-Path -LiteralPath `$missing) { & `$missing -Name 'subagent-start' -Tool 'mem-subagent-start.ps1' -Code `$codeRoot -Root `$env:CHEAP_MEM_ROOT -Skipped:`$skipped -Rejected:`$codeRejected }
  exit 0
}
& powershell -NoProfile -ExecutionPolicy Bypass -File `$subagent
"@ | Out-HookScript $subagentHookDst

  # Merge settings.json.
  $cfg = @{}
  if (Test-Path -LiteralPath $Settings) {
    try {
      $cfg = Get-Content -LiteralPath $Settings -Raw | ConvertFrom-Json -AsHashtable
    } catch {
      Write-Warning "$Settings is not JSON - leaving it alone (skipping hook registration)"
      $cfg = $null
    }
  }

  if ($null -ne $cfg) {
    if (-not $cfg.ContainsKey('hooks')) { $cfg['hooks'] = @{} }

    # An old install is recognised by the SCRIPT NAME, not by the path -
    # the same rule the POSIX installer states above its upsertHook.
    #
    # **This filter was keyed on the literal 'cheap-mem-session'**, which
    # matched exactly the two scripts that existed on 2026-09-19 and
    # nothing else. The moment a third one arrived (cheap-mem-user-prompt,
    # cheap-mem-pre-edit) a re-install would have left the old entry in
    # place and added a second one beside it - and two hooks on
    # UserPromptSubmit means every message pays twice. Found while adding
    # exactly those two, not in the field.
    #
    # Now the caller names its own file, so the rule cannot fall behind
    # the set of files again.
    function Upsert-Hook {
      param($h, $event, $file, $cmd, $matcher)
      if (-not $h.ContainsKey($event)) { $h[$event] = @() }
      $h[$event] = @($h[$event] | Where-Object {
        $keep = $true
        if ($_.ContainsKey('hooks')) {
          foreach ($hk in $_.hooks) {
            if ($hk.command -and $hk.command -match [regex]::Escape($file)) { $keep = $false }
          }
        }
        $keep
      })
      $hookEntry = @{ hooks = @(@{ type = 'command'; command = $cmd }) }
      if ($matcher) { $hookEntry['matcher'] = $matcher }
      $h[$event] += $hookEntry
    }
    $ps = 'powershell -NoProfile -ExecutionPolicy Bypass -File'
    Upsert-Hook $cfg['hooks'] 'SessionStart' 'cheap-mem-session-start.ps1' "$ps `"$startHookDst`""
    Upsert-Hook $cfg['hooks'] 'Stop'         'cheap-mem-session-stop.ps1'  "$ps `"$stopHookDst`""
    Upsert-Hook $cfg['hooks'] 'UserPromptSubmit' 'cheap-mem-user-prompt.ps1' "$ps `"$promptHookDst`""
    # With a matcher - otherwise it would also run on Read, and the path
    # of a file being READ is not an intention to change it. Bash is in
    # when the command writes a file (src/bashtargets.mjs decides).
    # Same matcher as the POSIX side; it is the rule, not a preference.
    Upsert-Hook $cfg['hooks'] 'PreToolUse' 'cheap-mem-pre-edit.ps1' "$ps `"$editHookDst`"" 'Edit|Write|NotebookEdit|Bash'
    # Same matcher as the POSIX side (Bash only) - the rule, not a preference.
    Upsert-Hook $cfg['hooks'] 'PostToolUse' 'cheap-mem-catch-fail.ps1' "$ps `"$catchFailHookDst`"" 'Bash'
    # PostToolUseFailure (X2b): a tool call that really failed - another
    # event than the line above, so the two never register as duplicates.
    Upsert-Hook $cfg['hooks'] 'PostToolUseFailure' 'cheap-mem-after-failure.ps1' "$ps `"$afterFailureHookDst`"" 'Bash|Edit|Write'
    # No matcher: every subagent type gets the same tagged procedures
    # plus context recap - there is no agent-type axis to filter on here,
    # unlike PreToolUse above.
    Upsert-Hook $cfg['hooks'] 'SubagentStart' 'cheap-mem-subagent-start.ps1' "$ps `"$subagentHookDst`""

    if (-not $cfg.ContainsKey('permissions')) { $cfg['permissions'] = @{} }
    $allowNeeded = @(
      'Bash(git -C:*)', 'Bash(git pull:*)', 'Bash(git fetch:*)',
      'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
      'Bash(git show:*)', 'Bash(git ls-tree:*)', 'Bash(git ls-files:*)',
      'Bash(git rev-parse:*)',
      'Read', 'Edit', 'Write', 'Glob', 'Grep'
    )
    # Which `node ...\bin\mem` may run without asking (tool-trust-cm,
    # 2026-10-16): the INSTALLED tool always (the hooks run it, the session is
    # told to call it); the memory's own only with the local switch. Before this
    # the memory's was always allowed, and a memory is a git clone pulled from
    # origin. A checkout inside the memory IS the memory's own tool.
    function Get-MemCmd { param($r) "Bash(node $($r -replace '\\','/')/bin/mem:*)" }
    if ((-not $codeInsideMem) -or $ownTrusted) { $allowNeeded += (Get-MemCmd $RepoRoot) }
    if ($ownTrusted) { $allowNeeded += (Get-MemCmd $env:CHEAP_MEM_ROOT) }
    $denyNeeded = @(
      'Bash(rm -rf:*)', 'Bash(git push --force:*)',
      'Bash(git push -f:*)', 'Bash(git reset --hard:*)',
      # The switch is for a person, in a terminal. The command refuses without
      # one (unless CHEAP_MEM_PROVISION=1), and a variable written in front of
      # `node` takes the call out of the allow list. `*trust-own-tool*` refuses it
      # wherever the words stand in the line (--root in front, cd x && ..., env A=1
      # node ..., a relative path), for Bash and for the PowerShell tool; the two
      # prefix forms are for a Claude Code that does not read a `*` in the middle.
      # A session that may run any shell command (bypass/auto) can still write the
      # switch file: these rules are a fence, not a lock (docs/security-model.md).
      'Bash(*trust-own-tool*)', 'PowerShell(*trust-own-tool*)',
      'Bash(*CHEAP_MEM_PROVISION*)', 'PowerShell(*CHEAP_MEM_PROVISION*)',
      "Bash(node $($RepoRoot -replace '\\','/')/bin/mem trust-own-tool:*)",
      "Bash(node $($env:CHEAP_MEM_ROOT -replace '\\','/')/bin/mem trust-own-tool:*)"
    )
    # Write and Edit are allowed across the board; the switch file is taken out
    # again. Claude Code writes a Windows path the POSIX way in file rules
    # (//c/Users/...), `**` is any depth.
    $swDir = Split-Path -Parent (Get-OwnToolFile)
    if ($swDir -and $swDir.Length -gt 2 -and $swDir[1] -eq ':') {
      $swPosix = '/' + $swDir.Substring(0, 1).ToLowerInvariant() + $swDir.Substring(2).Replace('\', '/')
      foreach ($tool in @('Write', 'Edit')) { $denyNeeded += "$tool(/$swPosix/**)" }
    }
    if (-not $cfg['permissions'].ContainsKey('allow')) { $cfg['permissions']['allow'] = @() }
    # An allow entry for the memory's own tool that an earlier run wrote stays
    # only while the switch is on.
    if (-not $ownTrusted) {
      $stale = Get-MemCmd $env:CHEAP_MEM_ROOT
      $cfg['permissions']['allow'] = @($cfg['permissions']['allow'] | Where-Object { ([string]$_).Replace('\', '/') -ne $stale })
    }
    if (-not $cfg['permissions'].ContainsKey('deny'))  { $cfg['permissions']['deny']  = @() }
    $cfg['permissions']['allow'] = @($cfg['permissions']['allow'] + $allowNeeded | Select-Object -Unique)
    $cfg['permissions']['deny']  = @($cfg['permissions']['deny']  + $denyNeeded  | Select-Object -Unique)

    ($cfg | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $Settings -Encoding UTF8
    Write-Host "  Claude Code hooks:    $HooksDir\cheap-mem-{session-start,session-stop,user-prompt,pre-edit,catch-fail,after-failure,subagent-start}.ps1"
    Write-Host "  Claude Code settings: $Settings"
  }
  Write-Host ""
}

# ---------- 4. Optional: `mem serve` at logon (M10) ----------
#
# The dashboard plus the warm recall server: a named pipe that
# bin/mem-retrieve.ps1 asks (when the server's key file is there) before
# it starts `mem find` itself. OFF unless asked for - an
# interactive run is asked once, anything but "y" keeps it off, and a
# non-interactive run never installs it. Removing it (see the top of this
# file) never breaks recall; it only makes it cold again.
$wantServe = $false
if ($ServeService) { $wantServe = $true }
elseif (-not $NoServeService -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  $answer = Read-Host "Also run 'mem serve' (dashboard + warm recall) at logon? [y/N]"
  if ($answer -match '^(y|yes)$') { $wantServe = $true }
}
if ($wantServe) {
  $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $NodeExe) {
    Write-Warning "node not on PATH - the mem serve task was NOT installed"
  } else {
    Unregister-ScheduledTask -TaskName $ServeTaskName -Confirm:$false -ErrorAction SilentlyContinue
    $sAction = New-ScheduledTaskAction `
      -Execute $NodeExe `
      -Argument "`"$(Join-Path $RepoRoot 'bin\mem')`" --root `"$env:CHEAP_MEM_ROOT`" serve"
    $sTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $sSettings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -StartWhenAvailable `
      -RestartCount 999 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew `
      -ExecutionTimeLimit (New-TimeSpan -Days 3650)
    $sPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask `
      -TaskName $ServeTaskName `
      -Action $sAction `
      -Trigger $sTrigger `
      -Settings $sSettings `
      -Principal $sPrincipal `
      -Description 'cheap-mem dashboard and warm recall server (mem serve)' | Out-Null
    Start-ScheduledTask -TaskName $ServeTaskName
    Write-Host "  scheduled task: $ServeTaskName (mem serve at logon; remove with -UninstallServeService)"
  }
} else {
  Write-Host "  mem serve task: not installed (default). Later: install\windows.ps1 -ServeService -SkipTask -SkipClaudeDesktop -SkipClaudeCode"
}
Write-Host ""

Write-Host "=== done ==="
Write-Host ""
Write-Host "Verify:"
Write-Host "  Get-ScheduledTask -TaskName cheap-mem-watch"
Write-Host "  Get-Content '$env:CHEAP_MEM_ROOT\.mem\watch.log' -Tail 20 -Wait"
