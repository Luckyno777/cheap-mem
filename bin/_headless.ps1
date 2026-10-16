# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# _headless.ps1 - how an unattended job starts `claude -p` (dot-sourced, never run).
#
# windows-parity-ok: the PowerShell half of one starter, dot-sourced and never run as a hook; the POSIX half is
# `mem_headless_plan` in bin/_portable.sh (itself sourced), and both ask the same node program (bin/mem-headless.mjs).
#
# The PowerShell side of the one starter. The decision lives in
# src/headless.mjs (reached through bin/mem-headless.mjs); the POSIX side is
# mem_headless_plan in bin/_portable.sh. Why: `claude -p` without `--bare` runs
# the hooks of `.claude/settings.json` and connects the servers of `.mcp.json`
# of the folder it starts in, even one nobody trusted, with no dialog. The
# digest, the mail handler and the reflector must not hand that to whoever can
# push into the memory. EVERY command starts in a neutral empty directory
# outside the memory; a command recognised as claude also gets the flags.
# See docs/security-model.md.
#
# Used by bin/mem-digest.ps1, bin/mem-handle-post.ps1, bin/mem-reflect.ps1:
#   . (Join-Path $PSScriptRoot '_headless.ps1')
#   $plan = Get-HeadlessPlan -CmdLine $CmdLine -Root $env:CHEAP_MEM_ROOT
#   if (-not $plan) { ... refuse, start NOTHING ... }
#
# $plan.Isolated  $true when the command is recognised as claude
# $plan.Cwd       where the session must start (never empty)
# $plan.Args      goes AFTER the prompt (`--add-dir` takes a list and is last); empty unless claude
# $plan.Note      a sentence for the log when the command was not recognised ($null otherwise)
# $plan.Clean     a per-run directory to remove after the job (Remove-HeadlessDir)

$script:HeadlessHelper = Join-Path $PSScriptRoot 'mem-headless.mjs'

function Get-HeadlessPlan {
  param([string]$CmdLine, [string]$Root, [bool]$AddDir = $true)
  $ErrorActionPreference = 'Continue'
  $a = @($script:HeadlessHelper, 'plan', '--cmd', $CmdLine, '--root', $Root)
  if (-not $AddDir) { $a += '--no-add-dir' }
  $lines = @(& node @a 2>$null)
  if ($LASTEXITCODE -ne 0) { return $null }
  $plan = @{ Isolated = $false; Cwd = $null; Args = @(); Note = $null; Clean = $null }
  foreach ($l in $lines) {
    $s = [string]$l
    if ($s -eq 'isolated=1') { $plan.Isolated = $true }
    elseif ($s -eq 'isolated=0') { }
    elseif ($s.StartsWith('cwd=')) { $plan.Cwd = $s.Substring(4) }
    elseif ($s.StartsWith('arg=')) { $plan.Args += $s.Substring(4) }
    elseif ($s.StartsWith('note=')) { $plan.Note = $s.Substring(5) }
    elseif ($s.StartsWith('cleanup=')) { $plan.Clean = $s.Substring(8) }
    else { return $null }
  }
  # No plan without a working directory; a claude plan without its flags is none either.
  if (-not $plan.Cwd) { return $null }
  if ($plan.Isolated -and $plan.Args.Count -lt 3) { return $null }
  return $plan
}

# Removes the per-run neutral directory, if the plan made one (the helper checks name and type).
function Remove-HeadlessDir {
  param($Plan)
  if ($Plan -and $Plan.Clean) {
    & node $script:HeadlessHelper 'cleanup' $Plan.Clean 2>$null | Out-Null
    $Plan.Clean = $null
  }
}

# The lines of the message when the text shows a claude that does not know
# `--setting-sources` (too old); $null otherwise. The text goes through a pipe,
# not a temp file (a temp directory inside the memory would put one there).
function Get-OldClaudeMessage {
  param([string]$Text)
  $ErrorActionPreference = 'Continue'
  $m = @($Text | & node $script:HeadlessHelper 'old-claude' '-' 2>$null)
  if ($LASTEXITCODE -eq 0) { return $m }
  return $null
}

# Start-Process joins its argument array with plain spaces and does not quote:
# an element with a space (a memory under C:\Users\Max Muster\...) must be quoted by hand.
function ConvertTo-StartProcessArg {
  param([string]$Arg)
  if ($Arg -match '\s') { return '"' + $Arg + '"' }
  return $Arg
}
