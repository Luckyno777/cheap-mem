# install/windows.ps1 — install cheap-mem on native Windows.
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

param(
  [switch]$SkipTask,
  [switch]$SkipClaudeDesktop,
  [switch]$SkipClaudeCode
)

$ErrorActionPreference = 'Stop'

if (-not $env:CHEAP_MEM_ROOT) {
  Write-Error "env CHEAP_MEM_ROOT missing"
  exit 2
}
if (-not (Test-Path (Join-Path $env:CHEAP_MEM_ROOT '.mem\config.json'))) {
  Write-Error "$env:CHEAP_MEM_ROOT\.mem\config.json not found — run 'node bin\mem init' first"
  exit 2
}

# Resolve the repo root (this script sits under <root>\install\).
$RepoRoot = (Get-Item (Split-Path -Parent $PSCommandPath)).Parent.FullName
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

  # Remove any prior task before re-registering — idempotent.
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
}

# ---------- 2. Claude Desktop MCP registration ----------

if (-not $SkipClaudeDesktop) {
  $CdConfig = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
  New-Item -ItemType Directory -Force -Path (Split-Path $CdConfig) | Out-Null

  $cfg = @{}
  if (Test-Path $CdConfig) {
    try {
      $cfg = Get-Content -LiteralPath $CdConfig -Raw | ConvertFrom-Json -AsHashtable
    } catch {
      Write-Warning "existing $CdConfig is not JSON — leaving it alone (skipping Claude Desktop wiring)"
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

  # Copy hooks with CHEAP_MEM_ROOT baked in.
  $startHookSrc = Join-Path $RepoRoot 'install\hooks\session-start.sh'
  $stopHookSrc  = Join-Path $RepoRoot 'install\hooks\session-stop.sh'

  # On native Windows, Claude Code hooks are PowerShell too.
  $startHookDst = Join-Path $HooksDir 'cheap-mem-session-start.ps1'
  $stopHookDst  = Join-Path $HooksDir 'cheap-mem-session-stop.ps1'

  @"
# cheap-mem SessionStart hook (Windows).
`$env:CHEAP_MEM_ROOT = '$($env:CHEAP_MEM_ROOT)'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
if (-not (Test-Path (Join-Path `$env:CHEAP_MEM_ROOT '.mem\config.json'))) { exit 0 }

Write-Host '=== cheap-mem attached ==='
Write-Host ''
& git -C `$env:CHEAP_MEM_ROOT fetch origin main 2>&1 | Select-Object -Last 1
& git -C `$env:CHEAP_MEM_ROOT checkout main 2>&1 | Select-Object -Last 1
& git -C `$env:CHEAP_MEM_ROOT pull --ff-only 2>&1 | Select-Object -Last 1
Write-Host ''

`$facts = Join-Path `$env:CHEAP_MEM_ROOT 'FACTS.md'
if (Test-Path `$facts) {
  Write-Host '=== FACTS (always loaded) ==='
  Get-Content `$facts
  Write-Host ''
}

`$mem = Join-Path `$env:CHEAP_MEM_ROOT 'bin\mem'
if (Test-Path `$mem) {
  Write-Host '=== mem context ==='
  & node `$mem context --n 10
  Write-Host ''
}
"@ | Set-Content -LiteralPath $startHookDst -Encoding UTF8

  @"
# cheap-mem Stop hook (Windows). Delegates to mem-reflect.ps1.
`$env:CHEAP_MEM_ROOT = '$($env:CHEAP_MEM_ROOT)'
if (`$env:MEM_HOOK_OFF -eq '1') { exit 0 }
if (-not (Test-Path (Join-Path `$env:CHEAP_MEM_ROOT '.mem\config.json'))) { exit 0 }
`$reflect = Join-Path `$env:CHEAP_MEM_ROOT 'bin\mem-reflect.ps1'
if (-not (Test-Path `$reflect)) { exit 0 }
& powershell -NoProfile -ExecutionPolicy Bypass -File `$reflect
"@ | Set-Content -LiteralPath $stopHookDst -Encoding UTF8

  # Merge settings.json.
  $cfg = @{}
  if (Test-Path $Settings) {
    try {
      $cfg = Get-Content -LiteralPath $Settings -Raw | ConvertFrom-Json -AsHashtable
    } catch {
      Write-Warning "$Settings is not JSON — leaving it alone (skipping hook registration)"
      $cfg = $null
    }
  }

  if ($null -ne $cfg) {
    if (-not $cfg.ContainsKey('hooks')) { $cfg['hooks'] = @{} }

    function Upsert-Hook {
      param($h, $event, $cmd)
      if (-not $h.ContainsKey($event)) { $h[$event] = @() }
      # Remove any prior entry that references our hooks dir.
      $h[$event] = @($h[$event] | Where-Object {
        $keep = $true
        if ($_.ContainsKey('hooks')) {
          foreach ($hk in $_.hooks) {
            if ($hk.command -and $hk.command -match 'cheap-mem-session') { $keep = $false }
          }
        }
        $keep
      })
      $h[$event] += @{ hooks = @(@{ type = 'command'; command = $cmd }) }
    }
    Upsert-Hook $cfg['hooks'] 'SessionStart' "powershell -NoProfile -ExecutionPolicy Bypass -File `"$startHookDst`""
    Upsert-Hook $cfg['hooks'] 'Stop'         "powershell -NoProfile -ExecutionPolicy Bypass -File `"$stopHookDst`""

    if (-not $cfg.ContainsKey('permissions')) { $cfg['permissions'] = @{} }
    $allowNeeded = @(
      'Bash(git -C:*)', 'Bash(git pull:*)', 'Bash(git fetch:*)',
      'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
      'Bash(git show:*)', 'Bash(git ls-tree:*)', 'Bash(git ls-files:*)',
      'Bash(git rev-parse:*)',
      "Bash(node $($env:CHEAP_MEM_ROOT -replace '\\','/')/bin/mem:*)",
      'Read', 'Edit', 'Write', 'Glob', 'Grep'
    )
    $denyNeeded = @(
      'Bash(rm -rf:*)', 'Bash(git push --force:*)',
      'Bash(git push -f:*)', 'Bash(git reset --hard:*)'
    )
    if (-not $cfg['permissions'].ContainsKey('allow')) { $cfg['permissions']['allow'] = @() }
    if (-not $cfg['permissions'].ContainsKey('deny'))  { $cfg['permissions']['deny']  = @() }
    $cfg['permissions']['allow'] = @($cfg['permissions']['allow'] + $allowNeeded | Select-Object -Unique)
    $cfg['permissions']['deny']  = @($cfg['permissions']['deny']  + $denyNeeded  | Select-Object -Unique)

    ($cfg | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $Settings -Encoding UTF8
    Write-Host "  Claude Code hooks:    $HooksDir\cheap-mem-session-{start,stop}.ps1"
    Write-Host "  Claude Code settings: $Settings"
  }
  Write-Host ""
}

Write-Host "=== done ==="
Write-Host ""
Write-Host "Verify:"
Write-Host "  Get-ScheduledTask -TaskName cheap-mem-watch"
Write-Host "  Get-Content '$env:CHEAP_MEM_ROOT\.mem\watch.log' -Tail 20 -Wait"
