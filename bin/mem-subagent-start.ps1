# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# mem-subagent-start.ps1 - native Windows port of bin/mem-subagent-start,
# the SubagentStart hook.
#
# A subagent is its own thread: it never saw whatever SessionStart or
# UserPromptSubmit showed its parent, and it gets neither event itself
# (see src/gauges.mjs). Left alone it starts knowing nothing this memory
# holds - including any procedure a human wrote specifically for how an
# agent assignment is supposed to run (src/procedure.mjs,
# `forSubagentStart`, tag `subagent-start`). This hook is what puts that
# in front of the subagent before its first task.
#
# No model, no network: the tag lookup and the context recap
# (src/subagentstart.mjs) are both deterministic reads over the memory's
# own JSONL logs. Always exits 0 - a hook that starts a subagent must
# never be the reason it fails to start.
#
# Env:
#   CHEAP_MEM_ROOT           absolute path to the memory
#   MEM_HOOK_OFF=1           turn ALL cheap-mem hooks off
#   MEM_SUBAGENT_START_OFF=1 disable this hook only
#   MEM_STOP_ROOTS           fallback roots to probe

$ErrorActionPreference = 'Continue'

if ($env:MEM_HOOK_OFF -eq '1') { exit 0 }
if ($env:MEM_SUBAGENT_START_OFF -eq '1') { exit 0 }

# Same probe as mem-stop.ps1's Get-ProbeRoots - kept local rather than
# shared, the same call this codebase already made for mem-stop.ps1
# itself (a one-function library for one caller is not worth a shared
# file yet).
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

# Two shapes, same as mem-before-edit.ps1: the memory carries the
# module itself, or a separate code checkout does.
$Module = $null
foreach ($c in @((Join-Path $Root 'src/subagentstart.mjs'), (Join-Path $Here '../src/subagentstart.mjs'))) {
  if (Test-Path -LiteralPath $c) { $Module = $c; break }
}
if (-not $Module) { exit 0 }

# The stdin JSON carries session_id etc., but nothing here is keyed on
# it - it is only drained so a malformed or absent stdin cannot upset
# anything downstream.
if ([Console]::IsInputRedirected) { [Console]::In.ReadToEnd() | Out-Null }

# A native Windows path breaks `import()` (Node reads the drive letter
# as a URL scheme) - the same trap mem-before-edit.ps1 already carries
# a note about. A file:// URL is what survives on both platforms.
$ModuleUrl = ([System.Uri]::new($Module)).AbsoluteUri

$Script = @'
import(process.argv[1]).then((m) => {
  const r = m.hookResult(process.env.CHEAP_MEM_ROOT);
  if (r) process.stdout.write(JSON.stringify(r));
}).catch(() => {});
'@

$env:CHEAP_MEM_ROOT = $Root
try {
  [Console]::Out.Write(((& node -e $Script $ModuleUrl 2>$null) -join ''))
} catch { }

exit 0
