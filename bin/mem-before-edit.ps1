# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# mem-before-edit.ps1 - native Windows port of bin/mem-before-edit.
#
# **Why this file exists (measured 2026-09-19, reported by a cheap-mem
# user on Windows).** `bin/mem-before-edit` is a bash script and had no
# `.ps1` counterpart, while mem-capture, mem-digest, mem-handle-post,
# mem-reflect and mem-watch all had one. A default Git for Windows
# install puts `git.exe` on PATH but NOT `bash.exe`, so on an ordinary
# Windows box this hook could not be started at all - and a hook whose
# command cannot be launched prints nothing, which reads exactly like
# "the memory has nothing to say about this file". GitHub's
# windows-latest runner ships Git Bash, which is why CI never saw it.
#
# What the hook does: recall DURING the work, not only on a user's
# message. `mem-retrieve` hangs on UserPromptSubmit and so fires exactly
# when the person types something, staying silent through all the time
# in between - which is when the building actually happens.
#
# Measured 2026-09-08 against four defects from one Windows install:
# for THREE of them an entry already existed naming the very file that
# was being touched. None was shown, because between the person's
# message and the write there is no event a hook hangs on.
#
# So: PreToolUse on Edit|Write|NotebookEdit, and on Bash when the command
# writes a file (src/bashtargets.mjs); the query is the PATH.
#
# Wire it up in your assistant's settings as a PreToolUse hook:
#   "PreToolUse": [{"matcher": "Edit|Write|NotebookEdit|Bash", "hooks": [{"type": "command",
#     "command": "powershell -NoProfile -File C:\\path\\to\\bin\\mem-before-edit.ps1"}]}]
#
# Env (identical to the POSIX hook):
#   CHEAP_MEM_ROOT          absolute path to the memory
#   MEM_BEFORE_EDIT_OFF=1   turn this hook off
#   MEM_HOOK_OFF=1          turn ALL cheap-mem hooks off
#   MEM_BEFORE_EDIT_TOP     at most this many hits (default 3)
#   MEM_BEFORE_EDIT_MARKS   where the once-per-file marks live
#   MEM_BEFORE_EDIT_TRACE=1 name every early exit on stderr
#   MEM_RETRIEVE_ROOTS      fallback roots to probe

$ErrorActionPreference = 'Continue'

# R6: V8 compile cache for this hook's node starts, in the USER's cache
# (never in the memory repo). The why is in bin/_portable.sh
# (mem_compile_cache): a value already in the environment stays, a
# directory that cannot be made means no cache - never a silent hook.
if (-not $env:NODE_COMPILE_CACHE) {
  try {
    $CcBase = $null
    if ($env:LOCALAPPDATA) { $CcBase = $env:LOCALAPPDATA }
    elseif ($IsMacOS -and $HOME) { $CcBase = Join-Path $HOME 'Library/Caches' }
    elseif ($env:XDG_CACHE_HOME -and [System.IO.Path]::IsPathRooted($env:XDG_CACHE_HOME)) { $CcBase = $env:XDG_CACHE_HOME }
    elseif ($HOME) { $CcBase = Join-Path $HOME '.cache' }
    if ($CcBase) {
      $CcDir = Join-Path (Join-Path $CcBase 'cheap-mem') 'node-cc'
      New-Item -ItemType Directory -Force -Path $CcDir -ErrorAction Stop | Out-Null
      $env:NODE_COMPILE_CACHE = $CcDir
    }
  } catch { }
}

# **Which exit did it take?** `MEM_BEFORE_EDIT_TRACE=1` makes every
# early exit name itself on stderr. Nothing is printed without it, and
# stdout is never touched - the hook's contract is unchanged.
#
# This exists because two plausible causes were repaired, both of them
# real bugs verified on Linux, and neither was the reported failure:
# the hook kept exiting 0 in silence on Windows. A branch that says its
# own name costs one line.
function Write-Trace { param([string]$where)
  if ($env:MEM_BEFORE_EDIT_TRACE -eq '1') { [Console]::Error.WriteLine("mem-before-edit: exit at $where") }
}
# The same trace, but for a midpoint state instead of an exit.
# `Write-Trace` prints "exit at ..." - at a point that does NOT exit,
# that would be a false statement in its own diagnostic tool.
function Write-Note { param([string]$msg)
  if ($env:MEM_BEFORE_EDIT_TRACE -eq '1') { [Console]::Error.WriteLine("mem-before-edit: $msg") }
}

# Hook time starts here - the journal line carries it (`duration_ms`).
$HookStartMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if ($env:MEM_BEFORE_EDIT_OFF -eq '1') { Write-Trace 'off-switch'; exit 0 }
if ($env:MEM_HOOK_OFF -eq '1') { Write-Trace 'hook-off'; exit 0 }

# **No backslash substitution here, and that is the point.** The POSIX
# hook carries `to_slashes()` because bash reads the native Windows path
# the agent hands it - `C:\Users\x\...` - as an escape soup, finds
# nothing, and exits 0 without a word. PowerShell's path APIs take that
# path as it comes.
#
# The list separator differs because Windows forces it: `;` when the
# value carries one (Windows' own list separator, as in PATH), because
# a whitespace split would tear `C:\Program Files\...` in half.
function Get-ProbeRoots {
  if (-not $env:MEM_RETRIEVE_ROOTS) {
    return @(Join-Path $HOME 'cheap-mem')
  }
  if ($env:MEM_RETRIEVE_ROOTS.Contains(';')) {
    return $env:MEM_RETRIEVE_ROOTS -split ';' | Where-Object { $_ }
  }
  # D5: the WHOLE value first (it may be one path with a space in it, e.g.
  # D:\Max Muster\memory), then its whitespace-separated words.
  return @($env:MEM_RETRIEVE_ROOTS) + ($env:MEM_RETRIEVE_ROOTS -split '\s+' | Where-Object { $_ })
}

$Root = $null
foreach ($k in (@($env:CHEAP_MEM_ROOT) + (Get-ProbeRoots))) {
  if (-not $k) { continue }
  if (Test-Path -LiteralPath (Join-Path $k '.mem/config.json')) { $Root = $k; break }
}
if (-not $Root) { Write-Trace "no-root (CHEAP_MEM_ROOT=$($env:CHEAP_MEM_ROOT))"; exit 0 }

# Two shapes, same as the other hooks: the memory may carry the tool
# itself, or the tool lives in a separate checkout next to this script.
$HookDir = Split-Path -Parent $PSCommandPath
$ToolRoot = $null
if (Test-Path -LiteralPath (Join-Path $Root 'bin/mem')) {
  $ToolRoot = $Root
} elseif (Test-Path -LiteralPath (Join-Path $HookDir 'mem')) {
  $ToolRoot = Split-Path -Parent $HookDir
} else {
  Write-Trace "no-tool (Root=$Root HookDir=$HookDir)"
  exit 0
}

$In = ''
if ([Console]::IsInputRedirected) { $In = [Console]::In.ReadToEnd() }

if ($In -and $In -match '"tool_name"\s*:\s*"Bash"') {
  try {
    $cgd = Join-Path $ToolRoot 'src/commandguard.mjs'
    $cgDir = Join-Path $Root '.pipeline/command-guard'
    $cgRules = Join-Path $cgDir 'rules.json'
    $cgWords = Join-Path $cgDir 'words.txt'
    $cgDrawers = @(Join-Path $Root 'global/errors.jsonl')
    $cgProj = Join-Path $Root 'projects'
    if (Test-Path -LiteralPath $cgProj) {
      $cgDrawers += @(Get-ChildItem -LiteralPath $cgProj -Directory | ForEach-Object { Join-Path $_.FullName 'errors.jsonl' })
    }
    $cgNeeded = $false
    $cgStale = $false
    if (Test-Path -LiteralPath $cgRules) {
      $cgTime = (Get-Item -LiteralPath $cgRules).LastWriteTimeUtc
      foreach ($d in $cgDrawers) {
        if ((Test-Path -LiteralPath $d) -and ((Get-Item -LiteralPath $d).LastWriteTimeUtc -gt $cgTime)) { $cgStale = $true; break }
      }
      if (-not $cgStale) {
        if ((Test-Path -LiteralPath $cgWords) -and ((Get-Item -LiteralPath $cgWords).Length -gt 0)) {
          foreach ($w in (Get-Content -LiteralPath $cgWords)) {
            if ($w -and $In.Contains($w)) { $cgNeeded = $true; break }
          }
        }
      }
    }
    if ((-not (Test-Path -LiteralPath $cgRules)) -or $cgStale) {
      foreach ($d in $cgDrawers) {
        if ((Test-Path -LiteralPath $d) -and (Select-String -LiteralPath $d -Pattern '"command_pattern"' -Quiet)) { $cgNeeded = $true; break }
      }
    }
    if ($cgNeeded -and (Test-Path -LiteralPath $cgd)) {
      $env:CHEAP_MEM_ROOT = $Root
      $cgOut = (($In | & node $cgd bash 2>$null) -join '')
      if ($cgOut) {
        [Console]::Out.Write($cgOut)
        Write-Trace 'command-guard'
        exit 0
      }
    }
  } catch { }
}

# Workflows first on a Bash call (wf-bc B3 port), independent of any
# written file: `npm test` writes none. Same module and same rule as
# bin/mem-before-edit (src/workflowdetect.mjs decides and books); the
# node start is paid only when a workflow drawer holds `tool_patterns`.
if ($In -and $In -match '"tool_name"\s*:\s*"Bash"') {
  try {
    $wfd = Join-Path $ToolRoot 'src/workflowdetect.mjs'
    $drawers = @(Join-Path $Root 'global/workflows.jsonl')
    $projDir = Join-Path $Root 'projects'
    if (Test-Path -LiteralPath $projDir) {
      $drawers += @(Get-ChildItem -LiteralPath $projDir -Directory | ForEach-Object { Join-Path $_.FullName 'workflows.jsonl' })
    }
    $armed = $false
    foreach ($d in $drawers) {
      if ((Test-Path -LiteralPath $d) -and (Select-String -LiteralPath $d -Pattern '"tool_patterns"' -Quiet)) { $armed = $true; break }
    }
    if ($armed -and (Test-Path -LiteralPath $wfd)) {
      $env:CHEAP_MEM_ROOT = $Root
      $wfOut = (($In | & node $wfd bash 2>$null) -join '')
      if ($wfOut) {
        [Console]::Out.Write($wfOut)
        Write-Trace 'workflow'
        exit 0
      }
    }
  } catch { }
}

# The query is the path, but not all of it: an absolute path never
# appears in an entry (it belongs to one machine), the last two
# segments do - `install/claude-code.sh`, `src/search.mjs`. That is
# how people write about code. Either separator, because the path the
# agent hands this hook on Windows carries backslashes.
# **One node process for everything else (TB5, 2026-10-14).** Reading the
# path, the watermark and the mark, the component lookup, the pick, the
# second decision, the mark and the journal line used to be a dozen
# `node -e` snippets plus a full `node bin/mem component` - the POSIX hook
# measured 13 node starts and 1079 ms (median of 11) for one edit with a hit. They are now
# plain function calls in bin/mem-before-edit-core.mjs (src/beforeedit.mjs);
# this script keeps what is shell business.
#
# The core sits next to whichever tool is about to run, else next to this
# script.
$CorePath = Join-Path $ToolRoot 'bin/mem-before-edit-core.mjs'
if (-not (Test-Path -LiteralPath $CorePath)) { $CorePath = Join-Path $HookDir 'mem-before-edit-core.mjs' }
if (-not (Test-Path -LiteralPath $CorePath)) { Write-Trace "no-core (ToolRoot=$ToolRoot HookDir=$HookDir)"; exit 0 }

# MEM_BE_ASCII: the final text carries an ASCII hyphen where the POSIX hook
# writes an em dash, and every non-ASCII character in the answer leaves as a
# \uXXXX escape. Same JSON, parsed - but it no longer depends on the console
# code page, which on Windows PowerShell 5.1 is not UTF-8 and mangled the dash.
$env:CHEAP_MEM_ROOT = $Root
$env:MEM_BE_START_MS = [string]$HookStartMs
$env:MEM_BE_ASCII = '1'

# The hook JSON goes to node on stdin (it can be large: a Write carries the
# whole file, far over what an environment variable holds). `$OutputEncoding`
# decides what bytes PowerShell pipes to a native command - UTF-8 without a
# BOM here, or a path with an umlaut arrives as `?`.
$SavedEncoding = $OutputEncoding
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { $Answer = (($In | & node $CorePath) -join "`n") }
finally { $OutputEncoding = $SavedEncoding }
if ($Answer) { [Console]::Out.Write($Answer) }
exit 0
