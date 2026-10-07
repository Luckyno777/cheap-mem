# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# mem-retrieve.ps1 - native Windows port of bin/mem-retrieve (lane 3).
#
# **Why this file exists (measured 2026-09-19, reported by a cheap-mem
# user on Windows).** `bin/mem-retrieve` is a bash script and had no
# `.ps1` counterpart, while mem-capture, mem-digest, mem-handle-post,
# mem-reflect and mem-watch all had one. A default Git for Windows
# install puts `git.exe` on PATH but NOT `bash.exe` - Git Bash lives
# under `C:\Program Files\Git\bin` and is not added to PATH unless the
# installer's "Use Git and optional Unix tools" option is chosen. So on
# an ordinary Windows box the recall lane could not start at all, and
# nothing said so: a hook whose command cannot be launched produces no
# output, which reads exactly like "the memory had nothing to say".
#
# GitHub's windows-latest runner ships Git Bash, which is precisely why
# CI never saw this. The job that exercises this file runs it with
# PowerShell on purpose.
#
# Recall used to depend on the session remembering to type `mem find` -
# and discipline loses against everything else competing for the
# context. So this hook does what the other two lanes do: no model,
# a few milliseconds, on every turn, invisible. It is the difference
# between "can remember" and "remembers".
#
# It reads the Claude Code UserPromptSubmit hook JSON on stdin and, when
# something in the memory scores above the bar, prints it back as
# additionalContext - the documented way to feed a turn.
#
# Wire it up in your assistant's settings as a UserPromptSubmit hook:
#   "UserPromptSubmit": [{"hooks": [{"type": "command",
#     "command": "powershell -NoProfile -File C:\\path\\to\\bin\\mem-retrieve.ps1"}]}]
#
# Env (identical to the POSIX hook):
#   CHEAP_MEM_ROOT        absolute path to the memory (as the installer sets it)
#   MEM_RETRIEVE_OFF=1    turn recall off for this session
#   MEM_HOOK_OFF=1        turn ALL cheap-mem hooks off (shared with the others)
#   MEM_RETRIEVE_MIN      minimum BM25 score to show (default 5.0)
#   MEM_RETRIEVE_TOP      at most this many hits (default 3)
#   MEM_RETRIEVE_NO_PULL=1  read only, never refresh the clone
#   MEM_RETRIEVE_FRESH_MIN  minutes between background pulls (default 10)
#   MEM_RETRIEVE_REMOTE / _BRANCH  where to pull from (default origin/main)
#   MEM_RETRIEVE_ROOTS    fallback roots to probe
#   MEM_RETRIEVE_TURNS    where the once-per-turn claims live

# A hook must never break the session it is attached to. Every exit
# below is 0; a terminating error would surface as a failed hook.
$ErrorActionPreference = 'Continue'

if ($env:MEM_RETRIEVE_OFF -eq '1') { exit 0 }
if ($env:MEM_HOOK_OFF -eq '1') { exit 0 }

# --- Where is the memory? -------------------------------------------
#
# CHEAP_MEM_ROOT first - the name the installer injects. The fallback
# list keeps the hook usable when it is run by hand, overridable via
# MEM_RETRIEVE_ROOTS so a test can reach it.
#
# **No backslash substitution here, and that is the point.** The POSIX
# hook carries `to_slashes()` because bash reads `C:\Users\x` as an
# escape soup and finds nothing. PowerShell's own path APIs take a
# native Windows path as it comes, so the whole class of bug that made
# the bash hooks silent on Windows cannot occur on this side.
#
# **The list separator differs, and Windows forces that.** The POSIX
# hook splits MEM_RETRIEVE_ROOTS on whitespace. Windows paths routinely
# contain spaces (`C:\Program Files\...`), so a whitespace split would
# tear a legitimate root in half. `;` is Windows' own list separator -
# the one PATH uses - so it wins when present, and whitespace is kept
# as the fallback so a single-path value written for either platform
# still works.
function Get-ProbeRoots {
  if (-not $env:MEM_RETRIEVE_ROOTS) {
    # The two POSIX defaults are kept verbatim for parity with the bash
    # hook: on Windows they simply never exist, which costs one failed
    # Test-Path each.
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

# Locate the mem binary. Two shapes are supported, same as the other
# hooks: the memory may carry the tool itself ($Root\bin\mem, the common
# case), or the tool lives in a separate code checkout - then the copy
# next to this very script is the one to use, pointed at the memory with
# --root. A hook that only knew the first shape would silently do
# nothing in the second.
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

$Min = if ($env:MEM_RETRIEVE_MIN) { $env:MEM_RETRIEVE_MIN } else { '5.0' }
$Top = if ($env:MEM_RETRIEVE_TOP) { $env:MEM_RETRIEVE_TOP } else { '3' }
# H5 search lever (src/searchlevers.mjs): shorter lines, so up to five fit
# the same byte budget. Only the default moves; MEM_RETRIEVE_TOP still wins.
if (-not $env:MEM_RETRIEVE_TOP -and (",$($env:MEM_SEARCH_LEVERS)," -match ',(h5|all),')) { $Top = '5' }

# --- Keep the clone from going stale --------------------------------
#
# Recall only READS. Without this, the clone is pulled once at session
# start and never again - a session that runs for hours recalls a frozen
# memory and never sees what a teammate (or the digest) wrote since.
#
# Three constraints, or the cure is worse than the disease:
#
#  - The prompt must NEVER wait. The pull is started detached and is
#    not waited on. It helps the NEXT turn, not this one - the price of
#    staying at a few ms.
#  - Nothing may pile up. The marker is touched BEFORE the pull starts,
#    so the throttle also covers a pull that hangs or fails.
#  - Don't step on another session. No pull in a headless worker
#    (MEM_HEADLESS); no pull into a dirty tree - only tracked changes
#    count, untracked files never block a fast-forward.
#
# **The 30-second cap of the POSIX hook is NOT reproduced, and that is
# a real difference, not an oversight.** `timeout` is a GNU tool and
# bin/_portable.sh exists precisely because it is not everywhere;
# Windows has no equivalent, and a parent that has already exited
# cannot kill a child it detached. What the cap bought there was
# "a hung git does not linger"; what remains here is the guarantee that
# actually matters - the marker is written before the pull, so a hung
# pull blocks the next attempt for the throttle window instead of
# spawning a second one on every turn.
function Update-Clone {
  if ($env:MEM_RETRIEVE_NO_PULL -eq '1') { return }
  if ($env:MEM_HEADLESS) { return }
  # Test-Path takes a file too: in a linked worktree `.git` is a file.
  if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) { return }
  $gitDir = (& git -C $Root rev-parse --absolute-git-dir 2>$null)
  if (-not $gitDir) { return }
  # Worktree (`.git` is a FILE): no automatic pull (same rule as lucky-mem,
  # R10c - agents control their own state). Leave a note in the git dir so the
  # skip is not silent; the recall itself runs.
  if (Test-Path -LiteralPath (Join-Path $Root '.git') -PathType Leaf) {
    try {
      $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      Set-Content -LiteralPath (Join-Path $gitDir 'mem-retrieve-worktree-no-pull') -Value "$stamp worktree: .git is a file -> no automatic pull here (agents control their own state)" -ErrorAction Stop
    } catch { }
    return
  }

  $minutes = if ($env:MEM_RETRIEVE_FRESH_MIN) { [int]$env:MEM_RETRIEVE_FRESH_MIN } else { 10 }
  # A marker inside the git dir never shows up in `git status`
  # (in a worktree that is the per-worktree dir, not $Root/.git).
  $marker = Join-Path $gitDir 'mem-retrieve-pull'
  if (Test-Path -LiteralPath $marker) {
    $age = (Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $marker).LastWriteTimeUtc
    if ($age.TotalMinutes -le $minutes) { return }
  }

  $dirty = & git -C $Root status --porcelain 2>$null | Where-Object { $_ -notmatch '^\?\?' }
  if ($dirty) { return }

  try { Set-Content -LiteralPath $marker -Value '' -ErrorAction Stop } catch { return }

  $remote = if ($env:MEM_RETRIEVE_REMOTE) { $env:MEM_RETRIEVE_REMOTE } else { 'origin' }
  $branch = if ($env:MEM_RETRIEVE_BRANCH) { $env:MEM_RETRIEVE_BRANCH } else { 'main' }
  # One pre-quoted argument string, not an array: Start-Process joins an
  # -ArgumentList array with plain spaces on Windows PowerShell, which
  # tears a root path containing spaces apart.
  $argLine = '-C "{0}" pull --ff-only --quiet "{1}" "{2}"' -f $Root, $remote, $branch
  try {
    Start-Process -FilePath 'git' -ArgumentList $argLine -WindowStyle Hidden -ErrorAction Stop | Out-Null
  } catch { }
}
Update-Clone

# --- The prompt ------------------------------------------------------
#
# Read stdin only when it is actually redirected. The POSIX hook tests
# `[ ! -t 0 ]` for the same reason: reading an interactive console here
# would block the session forever.
$In = ''
if ([Console]::IsInputRedirected) { $In = [Console]::In.ReadToEnd() }

$Prompt = ''
$SessionId = ''
$HookCwd = ''
$HookTranscript = ''
if ($In) {
  try {
    $j = $In | ConvertFrom-Json
    if ($j.prompt) { $Prompt = [string]$j.prompt }
    elseif ($j.user_prompt) { $Prompt = [string]$j.user_prompt }
    if ($j.session_id) { $SessionId = [string]$j.session_id }
    # For the h2 search lever (src/searchlevers.mjs): context, read only there.
    if ($j.cwd) { $HookCwd = [string]$j.cwd }
    if ($j.transcript_path) { $HookTranscript = [string]$j.transcript_path }
  } catch { }
}

# Short prompts (Z1c, mirrored from bin/mem-retrieve - PowerShell is not
# runnable where this was written, so this twin is a mirror, not a run).
# Under 12 characters is still "no signal" for ordinary words - "yes",
# "go on", "do it" are noise - but a short prompt that names an ID, a
# file, an error code or a word in at most three documents of the whole
# memory is a search. The same node program decides on both platforms
# and books the "no" as `no-signal`; pure confirmations never search.
$RecallJs = Join-Path $ToolRoot 'src/recallhook.mjs'
$QuestionBytes = [System.Text.Encoding]::UTF8.GetByteCount($Prompt)
# Machine turns (P10, mirrored from bin/mem-retrieve): a prompt that
# BEGINS with a foreign-turn marker (harness relay, Stop-hook feedback,
# subagent hand-back) is not searched and is booked as `machine`, never
# as a miss. The same node program decides (`recallhook.mjs machine`,
# list in src/recallsignal.mjs); the first-character test only spares the
# common case a node call - every marker begins with [, A, S or a.
$Lead = $Prompt.TrimStart()
if ($Lead.Length -gt 0 -and '[ASa'.Contains($Lead.Substring(0, 1)) -and (Test-Path -LiteralPath $RecallJs)) {
  $env:CHEAP_MEM_ROOT = $Root
  $env:MEM_RH_SESSION = $SessionId
  $env:MEM_RH_QB = [string]$QuestionBytes
  $Machine = ($Prompt | & node $RecallJs machine 2>$null) -join ''
  if ($Machine -eq 'machine') { exit 0 }
}
# Workflows (wf-bc B2 port, mirrored from bin/mem-retrieve): a workflow
# whose `triggers` match the prompt goes out with the recall block, or
# alone when the search shows nothing (src/workflowdetect.mjs decides).
# The node start is paid only when a workflow drawer holds `triggers`.
$WfText = ''
try {
  $wfDrawers = @(Join-Path $Root 'global/workflows.jsonl')
  $wfProj = Join-Path $Root 'projects'
  if (Test-Path -LiteralPath $wfProj) {
    $wfDrawers += @(Get-ChildItem -LiteralPath $wfProj -Directory | ForEach-Object { Join-Path $_.FullName 'workflows.jsonl' })
  }
  $wfArmed = $false
  foreach ($d in $wfDrawers) {
    if ((Test-Path -LiteralPath $d) -and (Select-String -LiteralPath $d -Pattern '"triggers"' -Quiet)) { $wfArmed = $true; break }
  }
  if ($wfArmed -and (Test-Path -LiteralPath $RecallJs) -and (Test-Path -LiteralPath (Join-Path $ToolRoot 'src/workflowdetect.mjs'))) {
    $env:CHEAP_MEM_ROOT = $Root
    $env:MEM_RH_SESSION = $SessionId
    $WfText = (($Prompt | & node $RecallJs workflow 2>$null) -join "`n")
  }
} catch { $WfText = '' }
# The exits that never reach `recallhook.mjs recall` still deliver it.
function Send-WorkflowOnly {
  if (-not $WfText) { return }
  try {
    $env:CHEAP_MEM_ROOT = $Root
    $env:MEM_RH_SESSION = $SessionId
    $env:MEM_RH_TURNS = if ($env:MEM_RETRIEVE_TURNS) { $env:MEM_RETRIEVE_TURNS } else { Join-Path $Root '.mem/retrieve-turns' }
    $env:MEM_RH_QB = [string]$QuestionBytes
    $env:MEM_RH_WORKFLOW = $WfText
    & node $RecallJs workflow-only 2>$null
  } catch { }
}
if ($Prompt.Length -lt 12) {
  if (-not (Test-Path -LiteralPath $RecallJs)) { exit 0 }
  $env:CHEAP_MEM_ROOT = $Root
  $env:MEM_RH_SESSION = $SessionId
  $env:MEM_RH_QB = [string]$QuestionBytes
  $Verdict = ($Prompt | & node $RecallJs signal 2>$null) -join ''
  if ($Verdict -ne 'search') { Send-WorkflowOnly; exit 0 }
}

# --- Once per turn, however often it is registered --------------------
#
# Two registrations on UserPromptSubmit - one written by the installer
# into the user profile, one by the project - both run this code, and
# the memory lands in the context twice. The hook makes ITSELF
# idempotent, so it does not matter how many times it hangs. The key is
# session + the BLOCK THAT WOULD BE INJECTED, and the claim is taken at
# the bottom, once that block exists: a repeat after the memory changed
# produces a different block and goes in, and a retrieval that yields
# nothing claims nothing.
$Turns = if ($env:MEM_RETRIEVE_TURNS) { $env:MEM_RETRIEVE_TURNS } else { Join-Path $Root '.mem/retrieve-turns' }
if ($SessionId) {
  try {
    New-Item -ItemType Directory -Force -Path $Turns -ErrorAction Stop | Out-Null
    $cutoff = (Get-Date).ToUniversalTime().AddMinutes(-60)
    Get-ChildItem -LiteralPath $Turns -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  } catch { }
}

# Ask the memory. --json is the contract, not the human output: the
# human format is for people and may change; the JSON carries score and
# a stable shape. The prompt goes in as an argv value, never through a
# shell - node does not evaluate argv, so an odd character in the
# prompt cannot turn into a command.
#
# **No 5-second cap on this call.** The POSIX hook has one through
# bin/_portable.sh. Reproducing it here would mean building the process
# by hand with ProcessStartInfo, and `ArgumentList` - the only member
# that quotes argv safely - does not exist on Windows PowerShell 5.1,
# which install/windows.ps1 still starts hooks with. Hand-quoting a
# user's prompt into a single command line to win a cap is the trade
# this hook must not make: the search is local BM25 over an in-memory
# index, no model and no network.
# No --journal-session here (Z1c, as in bin/mem-retrieve): `find` used to
# book the question BEFORE anything was printed, so a second registration
# of the same turn booked a second "delivered" and printed nothing. The
# line is booked by `recallhook.mjs recall`, after the answer went out.
#
# **M10: the warm recall server first, else direct** (as in
# bin/mem-retrieve). `mem serve` writes a key file under
# <root>\.pipeline\recall\ while its recall server listens (on Windows a
# named pipe); no key file -> exactly the path from before M10. The
# client waits at most MEM_RECALL_SERVER_WAIT_MS (default 2500 ms) and
# prints nothing on any failure, so a dead or hung server costs that
# wait once and the direct `find` below runs as before. The path and the
# reason for a fallback go into the journal (MEM_RH_PATH/_PATH_REASON).
$RecallPath = 'direct'
$RecallReason = ''
$Hits = $null
$ClientJs = Join-Path $ToolRoot 'bin/mem-retrieve-client.mjs'
$RecallKey = if ($env:MEM_RECALL_SERVER_DIR) { Join-Path $env:MEM_RECALL_SERVER_DIR 'key' } else { Join-Path $Root '.pipeline/recall/key' }
if ($env:MEM_RECALL_SERVER -ne '0' -and (Test-Path -LiteralPath $RecallKey) -and (Test-Path -LiteralPath $ClientJs)) {
  $Hits = (& node $ClientJs $Root $Prompt $Top 2>$null) -join "`n"
  switch ($LASTEXITCODE) {
    0 { $RecallPath = 'server' }
    3 { $RecallReason = 'server-gone' }
    4 { $RecallReason = 'server-timeout' }
    5 { $RecallReason = 'server-refused' }
    6 { $RecallReason = 'server-stale' }
    default { $RecallReason = 'server-error' }
  }
}
if ($RecallPath -ne 'server') {
  $Hits = (& node @MemArgv find $Prompt --top $Top --json 2>$null) -join "`n"
}
# K3 (mirrored from bin/mem-retrieve, not runnable here): the POSIX hook
# books reason `timeout` when the 5-second cap kills `find` (exit 124/137).
# This hook has NO cap (see above), so it has no timeout branch to book;
# the day a cap is added here, that exit must book `timeout` too.
if ($LASTEXITCODE -ne 0) { Send-WorkflowOnly; exit 0 }
if (-not $Hits) { Send-WorkflowOnly; exit 0 }

# Keep only what clears the bar, render one line each, claim the turn,
# print, book: all of it is `recallhook.mjs recall` - the ONE renderer
# (src/recallrender.mjs, fields from retrieval.BODY_FIELDS) shared with
# bin/mem-retrieve, bin/mem-catch-fail and src/afterfailure.mjs. It used
# to be a copy of the line builder here that knew six of thirteen body
# fields: a learning showed as its title. Rewriting the score bar, the
# budget and the reason-first rule in PowerShell would be a second source
# of truth; node is already a hard dependency of this hook.
#
# The claim (once per turn, however often the hook is registered) is
# taken in node with an exclusive mkdir, which fails when the name is
# taken on Windows too; a second registration books `already-shown`.
# Node writes to the hook's own stdout and books the journal line after
# that write, so the line follows the output. No trailing newline.
if (-not ((Test-Path -LiteralPath $RecallJs) -and (Test-Path -LiteralPath (Join-Path $ToolRoot 'src/recallrender.mjs')))) { exit 0 }
$env:CHEAP_MEM_ROOT = $Root
$env:MEM_RH_MIN = $Min
$env:MEM_RH_SESSION = $SessionId
$env:MEM_RH_TURNS = $Turns
$env:MEM_RH_QB = [string]$QuestionBytes
$env:MEM_RH_PATH = $RecallPath
$env:MEM_RH_PATH_REASON = $RecallReason
$env:MEM_RH_CWD = $HookCwd
$env:MEM_RH_TRANSCRIPT = $HookTranscript
$env:MEM_RH_WORKFLOW = $WfText
# The skill offer reads the prompt (src/recallhook.mjs skillOffer).
$env:MEM_RH_PROMPT = $Prompt
$Hits | & node $RecallJs recall 2>$null
exit 0
