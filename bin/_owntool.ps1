# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# _owntool.ps1 - which copy of the tool a hook may run. DOT-SOURCED, never
# executed. The Windows installer also copies this file next to the hook
# shims (cheap-mem-own-tool.ps1), so the shims and bin\ share ONE rule.
#
# This is the PowerShell twin of bin/_owntool.sh; src/owntool.mjs states the
# rule and why. In short: a hook runs the INSTALLED tool (CHEAP_MEM_CODE) or
# the tool it sits in. A memory's own bin\ and src\ are used only when the user
# said so, locally and outside every repository: the memory's path is a line
# in %APPDATA%\cheap-mem\own-tool-roots, which `mem trust-own-tool` writes and
# a git pull cannot. Fails closed: anything unreadable means "not trusted".
#
# Platform branch, stated: on Windows the key is the absolute path, '/' as
# separator, lower-cased (paths ignore case there). A directory that is itself a
# link or junction is followed; a link in the middle of the path and 8.3 names
# are not resolved here; `mem trust-own-tool` writes every spelling it can
# resolve, so a miss reads "not trusted", never a wrong match. On a PowerShell
# that runs on Linux or macOS the path is compared as it is (case counts).

function Get-OwnToolKey {
  param([string]$Path)
  if (-not $Path) { return $null }
  # A relative path is relative to the PowerShell location ($PWD), not to the working directory of the .NET
  # process, which `cd` in PowerShell does not move.
  if (-not [System.IO.Path]::IsPathRooted($Path)) { $Path = Join-Path (Get-Location).ProviderPath $Path }
  try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return $null }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { return $null }
  # A directory that is itself a link or junction is followed to its target, as the node side does with
  # realpath. ResolveLinkTarget exists on .NET 6 and later (PowerShell 7); Windows PowerShell 5.1 falls back to the
  # first Target the item reports. Links in the MIDDLE of the path are not resolved here (see the note above):
  # such a path reads "not trusted", never a wrong match.
  try {
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($item.LinkType) {
      $dest = $null
      try { $dest = [System.IO.Directory]::ResolveLinkTarget($full, $true) } catch { $dest = $null }
      if ($dest) { $full = $dest.FullName }
      elseif ($item.Target) {
        $t = @($item.Target)[0]
        if ($t -and [System.IO.Path]::IsPathRooted($t)) { $full = [System.IO.Path]::GetFullPath($t) }
      }
    }
  } catch { }
  $k = $full.Replace('\', '/')
  if ($k.Length -gt 3 -and $k.EndsWith('/')) { $k = $k.Substring(0, $k.Length - 1) }
  if ([System.IO.Path]::DirectorySeparatorChar -eq '\') { $k = $k.ToLowerInvariant() }
  return $k
}

function Get-OwnToolFile {
  if ([System.IO.Path]::DirectorySeparatorChar -eq '\') {
    $base = $env:APPDATA
    if (-not $base) { $base = Join-Path $HOME 'AppData\Roaming' }
  } else {
    $base = $env:XDG_CONFIG_HOME
    if (-not $base -or -not $base.StartsWith('/')) { $base = Join-Path $HOME '.config' }
  }
  return (Join-Path (Join-Path $base 'cheap-mem') 'own-tool-roots')
}

function Test-OwnToolTrusted {
  param([string]$Root)
  $key = Get-OwnToolKey $Root
  if (-not $key) { return $false }
  $file = Get-OwnToolFile
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  try { $lines = [System.IO.File]::ReadAllLines($file) } catch { return $false }
  foreach ($line in $lines) { if ($line -ceq $key) { return $true } }
  return $false
}

function Test-OwnToolInside {
  param([string]$Dir, [string]$Root)
  $d = Get-OwnToolKey $Dir
  $r = Get-OwnToolKey $Root
  if (-not $d -or -not $r) { return $false }
  return (($d + '/').StartsWith(($r + '/'), [System.StringComparison]::Ordinal))
}

# Does the memory carry a tool of its own (bin\mem*, or a src\ module a hook would load)?
function Test-OwnToolShips {
  param([string]$Root)
  $bin = Join-Path $Root 'bin'
  if (Test-Path -LiteralPath $bin -PathType Container) {
    if (@(Get-ChildItem -LiteralPath $bin -Filter 'mem*' -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
  }
  foreach ($m in @('subagentstart', 'answercheck', 'closingreport')) {
    if (Test-Path -LiteralPath (Join-Path $Root "src\$m.mjs") -PathType Leaf) { return $true }
  }
  return $false
}

# Find-OwnTool -Root R -Rel bin\mem-retrieve.ps1 [-Self <dir>]
# Returns an object: Path (the copy to run, $null when none) and Skipped ($true
# when a copy from the memory was passed over because it is not trusted).
# Order: the memory's own copy, ONLY with the switch; the installed tool
# (CHEAP_MEM_CODE); the tool Self sits in. A candidate inside the memory counts
# as the memory's own copy, whoever named it.
function Find-OwnTool {
  param([string]$Root, [string]$Rel, [string]$Self)
  $res = [pscustomobject]@{ Path = $null; Skipped = $false }
  $trusted = Test-OwnToolTrusted $Root
  $own = Join-Path $Root $Rel
  if (Test-Path -LiteralPath $own -PathType Leaf) {
    if ($trusted) { $res.Path = $own; return $res }
    $res.Skipped = $true
  }
  $cands = @()
  if ($env:CHEAP_MEM_CODE) { $cands += (Join-Path $env:CHEAP_MEM_CODE $Rel) }
  if ($Self) {
    $cands += (Join-Path $Self (Join-Path '..' $Rel))
    $cands += (Join-Path $Self (Split-Path -Leaf $Rel))
  }
  foreach ($c in $cands) {
    if (-not (Test-Path -LiteralPath $c -PathType Leaf)) { continue }
    if ((-not $trusted) -and (Test-OwnToolInside (Split-Path -Parent $c) $Root)) { $res.Skipped = $true; continue }
    $res.Path = $c
    return $res
  }
  return $res
}
