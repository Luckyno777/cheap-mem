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
#   MEM_RETRIEVE_ROOTS       fallback roots to probe

$ErrorActionPreference = 'Continue'

if ($env:MEM_CATCH_FAIL_OFF -eq '1') { exit 0 }
if ($env:MEM_HOOK_OFF -eq '1') { exit 0 }

function Get-ProbeRoots {
  if (-not $env:MEM_RETRIEVE_ROOTS) {
    return @((Join-Path $HOME 'cheap-mem'), '/work/cheap-mem', '/home/user/cheap-mem')
  }
  if ($env:MEM_RETRIEVE_ROOTS.Contains(';')) {
    return $env:MEM_RETRIEVE_ROOTS -split ';' | Where-Object { $_ }
  }
  return $env:MEM_RETRIEVE_ROOTS -split '\s+' | Where-Object { $_ }
}

$Root = $null
foreach ($k in (@($env:CHEAP_MEM_ROOT) + (Get-ProbeRoots))) {
  if (-not $k) { continue }
  if (Test-Path -LiteralPath (Join-Path $k '.mem/config.json')) { $Root = $k; break }
}
if (-not $Root) { exit 0 }

$HookDir = Split-Path -Parent $PSCommandPath
$MemArgv = $null
$ToolRoot = $null
if (Test-Path -LiteralPath (Join-Path $Root 'bin/mem')) {
  $MemArgv = @((Join-Path $Root 'bin/mem'))
  $ToolRoot = $Root
} elseif (Test-Path -LiteralPath (Join-Path $HookDir 'mem')) {
  $MemArgv = @((Join-Path $HookDir 'mem'), '--root', $Root)
  $ToolRoot = Split-Path -Parent $HookDir
} else {
  exit 0
}

# --- Read the hook JSON, and check tool_name + the exact signature ----
$In = ''
if ([Console]::IsInputRedirected) { $In = [Console]::In.ReadToEnd() }
if (-not $In) { exit 0 }

$ErrSigPath = Join-Path $ToolRoot 'src/errorsignature.mjs'
$CheckScript = @'
  let d = "";
  process.stdin.on("data", (c) => (d += c)).on("end", async () => {
    let j; try { j = JSON.parse(d); } catch { process.exit(0); }
    if (String(j.tool_name ?? "") !== "Bash") process.exit(0);
    let sig;
    try {
      const m = await import(require("node:url").pathToFileURL(process.env.MEM_ERRSIG).href);
      sig = m.errorSignature(m.bashOutput(j.tool_response));
    } catch { process.exit(0); }
    if (!sig) process.exit(0);
    const command = String(j.tool_input?.command ?? "").trim().split(/\s+/)[0] || "";
    const query = command ? `${command} ${sig}` : sig;
    process.stdout.write(JSON.stringify({ sig, query, session: String(j.session_id ?? "") }));
  })
'@
$env:MEM_ERRSIG = $ErrSigPath
$Parsed = ($In | & node -e $CheckScript 2>$null) -join ''
if (-not $Parsed) { exit 0 }

$Fields = $null
try { $Fields = $Parsed | ConvertFrom-Json } catch { exit 0 }
$Sig = [string]$Fields.sig
$Query = [string]$Fields.query
$SessionId = [string]$Fields.session
if (-not $Sig) { exit 0 }

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
    exit 0
  }
}

$Top = if ($env:MEM_CATCH_FAIL_TOP) { $env:MEM_CATCH_FAIL_TOP } else { '3' }
# --weak: this hook holds its own, lower bar; the h3 answer gate of
# `mem find` is tuned for a spoken question (mirror of bin/mem-catch-fail).
$Hits = (& node @MemArgv find $Query --top $Top --json --weak 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0) { exit 0 }
if (-not $Hits) { exit 0 }

# One renderer (Z1c): `recallhook.mjs catch` -> src/recallrender.mjs, the
# same program as bin/mem-catch-fail and bin/mem-retrieve (content from
# retrieval.BODY_FIELDS, the entry ID, a marked cut, bidi neutralised).
# A lower bar than mem-retrieve.ps1's default - see bin/mem-catch-fail's
# own comment on MIN for the measurement behind this number.
$RecallJs = Join-Path $ToolRoot 'src/recallhook.mjs'
if (-not ((Test-Path -LiteralPath $RecallJs) -and (Test-Path -LiteralPath (Join-Path $ToolRoot 'src/recallrender.mjs')))) { exit 0 }
$env:MEM_RH_MIN = if ($env:MEM_CATCH_FAIL_MIN) { $env:MEM_CATCH_FAIL_MIN } else { '2.0' }
$Block = ($Hits | & node $RecallJs catch 2>$null) -join ''
if (-not $Block) { exit 0 }

[Console]::Out.Write($Block)
exit 0
