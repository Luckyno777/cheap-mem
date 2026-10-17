# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# mem-catch-fail.ps1 - native Windows port of bin/mem-catch-fail (M19 port
# from lucky-mem, "the swallowed failure").
#
# PostToolUseFailure only fires when Bash exits nonzero. A command whose
# own OUTPUT says it did not succeed while the shell says otherwise -
# `npm test | tail -20`, `some-check || true`, a TAP/spec run that prints
# `# fail 3` and still exits 0 - runs straight past it. This hook hangs
# on PostToolUse instead, matcher `Bash` only, and calls into the same
# exact-check module the POSIX hook uses (src/errorsignature.mjs) so the
# two platforms can never disagree on what counts as a failure.
#
# **No bash-only cheap sieve here, and that is not a gap.** The POSIX
# hook's pure-bash substring check exists to avoid starting `node` after
# every ordinary, successful Bash call - a bash `case` statement is
# nearly free, a process start is not. This hook is ALREADY a process
# (powershell.exe) before a single line runs; there is no cheaper layer
# below it to skip to. What both platforms share is the one thing that
# matters for correctness: the SAME line-anchored signatures, decided by
# the SAME module.
#
# Wire it up in your assistant's settings as a PostToolUse hook with
# matcher "Bash":
#   "PostToolUse": [{"matcher": "Bash", "hooks": [{"type": "command",
#     "command": "powershell -NoProfile -File C:\\path\\to\\bin\\mem-catch-fail.ps1"}]}]
#
# Env (identical to the POSIX hook):
#   CHEAP_MEM_ROOT           absolute path to the memory
#   MEM_CATCH_FAIL_OFF=1     turn this hook off
#   MEM_HOOK_OFF=1           turn ALL cheap-mem hooks off
#   MEM_CATCH_FAIL_TOP       at most this many hits (default 3)
#   MEM_CATCH_FAIL_MIN       minimum BM25 score to show (default 2.0)
#   MEM_CATCH_FAIL_TURNS     where the once-per-session marks live
#   MEM_CATCH_FAIL_TRACE=1   name every exit on stderr (lengths and exit codes only)
#   MEM_RETRIEVE_ROOTS       fallback roots to probe

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

# **Which exit did it take?** `MEM_CATCH_FAIL_TRACE=1` makes every exit name itself on stderr, the way
# MEM_BEFORE_EDIT_TRACE does in mem-before-edit.ps1: the place, lengths and node exit codes, never a byte of the hook
# JSON or of the answer. Nothing is printed without it, and stdout - the hook's contract - is untouched. CI run 1180
# saw this twin deliver ZERO bytes on windows-latest with an empty stderr, so nobody could say where it stopped.
function Write-Trace { param([string]$where)
  if ($env:MEM_CATCH_FAIL_TRACE -eq '1') { [Console]::Error.WriteLine("mem-catch-fail: exit at $where") }
}
# The same, for a midpoint that does NOT exit ("exit at" would be a false statement there).
function Write-Note { param([string]$msg)
  if ($env:MEM_CATCH_FAIL_TRACE -eq '1') { [Console]::Error.WriteLine("mem-catch-fail: $msg") }
}

if ($env:MEM_CATCH_FAIL_OFF -eq '1') { Write-Trace 'off-switch'; exit 0 }
if ($env:MEM_HOOK_OFF -eq '1') { Write-Trace 'hook-off'; exit 0 }

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
if (-not $Root) { Write-Trace "no-root (CHEAP_MEM_ROOT set: $([bool]$env:CHEAP_MEM_ROOT))"; exit 0 }

$HookDir = Split-Path -Parent $PSCommandPath
$MemArgv = $null
$ToolRoot = $null
# The memory's own bin\ is NOT the default (tool-trust-cm, 2026-10-16): the
# memory is a git clone pulled from origin, and code taken from it is code its
# remote can ship. It is used only when the user switched that on, locally
# (`mem trust-own-tool`, bin\_owntool.ps1); otherwise the tool this script sits in.
$OwnToolTrusted = $false
$OwnToolLib = Join-Path $HookDir '_owntool.ps1'
if (Test-Path -LiteralPath $OwnToolLib) { . $OwnToolLib; $OwnToolTrusted = Test-OwnToolTrusted $Root }
if ($OwnToolTrusted -and (Test-Path -LiteralPath (Join-Path $Root 'bin/mem'))) {
  $MemArgv = @((Join-Path $Root 'bin/mem'))
  $ToolRoot = $Root
} elseif (Test-Path -LiteralPath (Join-Path $HookDir 'mem')) {
  $MemArgv = @((Join-Path $HookDir 'mem'), '--root', $Root)
  $ToolRoot = Split-Path -Parent $HookDir
} else {
  Write-Trace "no-tool (HookDir=$HookDir)"
  exit 0
}

# --- Read the hook JSON, and check tool_name + the exact signature ----
$In = ''
if ([Console]::IsInputRedirected) { $In = [Console]::In.ReadToEnd() }
# Size only, never content: on which side of the pipe to node the hook JSON was lost.
Write-Note "stdin: $($In.Length) chars, redirected=$([Console]::IsInputRedirected)"
# stdin to node (CI run 1141, src/hookstdin.mjs says why): Windows PowerShell 5.1 opens a native command's stdin in
# [Console]::InputEncoding and writes its preamble first - under code page 65001 a UTF-8 BOM before the hook JSON, and
# the core's JSON.parse failed in silence. Same code page without a preamble; what PowerShell writes into the pipe as
# UTF-8 without a BOM (or a non-ASCII path arrives as '?'). No console to set it on: the cores strip a BOM themselves.
try { if ([Console]::InputEncoding.CodePage -eq 65001 -and [Console]::InputEncoding.GetPreamble().Length -gt 0) { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } } catch { }
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if (-not $In) { Write-Trace 'no-stdin'; exit 0 }

$ErrSigPath = Join-Path $ToolRoot 'src/errorsignature.mjs'
# **No double quote in a `node -e` snippet (CI run 1180).** Windows PowerShell 5.1 hands an argument to a native
# command by wrapping it in double quotes when it holds a blank, and leaves the double quotes INSIDE it unescaped.
# node's command-line parser then reads the inner ones as quote toggles: the snippet arrived mangled (its first line
# `let d = "";` became `let d = ";`), node stopped at a SyntaxError (exit 1, stderr thrown away below), and this hook
# delivered ZERO bytes on every swallowed failure. PowerShell 7.3+ escapes them, 5.1 - the one install/windows.ps1 registers - does not. So the snippet
# carries single quotes and template literals only; test/ps51-node-snippet.test.mjs holds the rule for every .ps1.
# Exit codes, for the trace: 0 not Bash or no signature, 3 the hook JSON does not parse, 4 the signature module did
# not load, 1 node's own (the snippet itself did not run).
$CheckScript = @'
  let d = '';
  process.stdin.on('data', (c) => (d += c)).on('end', async () => {
    let j; try { j = JSON.parse(d.replace(/^[\uFEFF\s]+/, '')); } catch { process.exit(3); }
    if (String(j.tool_name ?? '') !== 'Bash') process.exit(0);
    let sig;
    try {
      const m = await import(require('node:url').pathToFileURL(process.env.MEM_ERRSIG).href);
      sig = m.errorSignature(m.bashOutput(j.tool_response));
    } catch { process.exit(4); }
    if (!sig) process.exit(0);
    const command = String(j.tool_input?.command ?? '').trim().split(/\s+/)[0] || '';
    const query = command ? `${command} ${sig}` : sig;
    process.stdout.write(JSON.stringify({ sig, query, session: String(j.session_id ?? '') }));
  })
'@
$env:MEM_ERRSIG = $ErrSigPath
$Parsed = ($In | & node -e $CheckScript 2>$null) -join ''
$CheckExit = $LASTEXITCODE
if (-not $Parsed) { Write-Trace "check-empty (node exit $CheckExit)"; exit 0 }

$Fields = $null
try { $Fields = $Parsed | ConvertFrom-Json } catch { Write-Trace "check-not-json ($($Parsed.Length) chars)"; exit 0 }
$Sig = [string]$Fields.sig
$Query = [string]$Fields.query
$SessionId = [string]$Fields.session
if (-not $Sig) { Write-Trace 'no-signature'; exit 0 }
Write-Note "signature: $($Sig.Length) chars, session id: $($SessionId.Length) chars"

# --- Once per session per signature, not silently ---------------------
#
# A file, not a directory, and a hash, not `cksum` - same reasoning as
# mem-retrieve.ps1's own claim: .NET directory creation is idempotent and
# cannot decide a race, `FileMode.CreateNew` can.
if ($SessionId) {
  $Turns = if ($env:MEM_CATCH_FAIL_TURNS) { $env:MEM_CATCH_FAIL_TURNS } else { Join-Path $Root '.mem/catch-fail-turns' }
  try {
    New-Item -ItemType Directory -Force -Path $Turns -ErrorAction Stop | Out-Null
    $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-60)
    Get-ChildItem -LiteralPath $Turns -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  } catch { }
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($SessionId + '__' + $Sig)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $safe = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    $claim = Join-Path $Turns $safe
    $fs = [System.IO.File]::Open($claim, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $fs.Close()
  } catch {
    # Taken already: this exact failure was shown this session. Stay quiet.
    Write-Trace 'already-shown'
    exit 0
  }
}

$Top = if ($env:MEM_CATCH_FAIL_TOP) { $env:MEM_CATCH_FAIL_TOP } else { '3' }
# --weak: this hook holds its own, lower bar; the h3 answer gate of
# `mem find` is tuned for a spoken question (mirror of bin/mem-catch-fail).
$Hits = (& node @MemArgv find $Query --top $Top --json --weak 2>$null) -join "`n"
$FindExit = $LASTEXITCODE
if ($FindExit -ne 0) { Write-Trace "find-failed (node exit $FindExit)"; exit 0 }
if (-not $Hits) { Write-Trace 'find-empty'; exit 0 }
Write-Note "find: $($Hits.Length) chars"

# One renderer (Z1c): `recallhook.mjs catch` -> src/recallrender.mjs, the
# same program as bin/mem-catch-fail and bin/mem-retrieve (content from
# retrieval.BODY_FIELDS, the entry ID, a marked cut, bidi neutralised).
# A lower bar than mem-retrieve.ps1's default - see bin/mem-catch-fail's
# own comment on MIN for the measurement behind this number.
$RecallJs = Join-Path $ToolRoot 'src/recallhook.mjs'
if (-not ((Test-Path -LiteralPath $RecallJs) -and (Test-Path -LiteralPath (Join-Path $ToolRoot 'src/recallrender.mjs')))) { Write-Trace "no-renderer (ToolRoot=$ToolRoot)"; exit 0 }
$env:MEM_RH_MIN = if ($env:MEM_CATCH_FAIL_MIN) { $env:MEM_CATCH_FAIL_MIN } else { '2.0' }
$Block = ($Hits | & node $RecallJs catch 2>$null) -join ''
$RenderExit = $LASTEXITCODE
if (-not $Block) { Write-Trace "render-empty (node exit $RenderExit)"; exit 0 }

[Console]::Out.Write($Block)
Write-Trace "delivered ($($Block.Length) chars)"
exit 0
