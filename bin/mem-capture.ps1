# SPDX-FileCopyrightText: 2026 Lucky H.
# SPDX-License-Identifier: MIT
# mem-capture.ps1 - native Windows port of bin/mem-capture.
#
# Lane 1: the Stop hook. Copies the new part of the session transcript
# into the memory, redacted and gzipped. **Starts no model.**
#
# Wire it up in your assistant's settings as a Stop hook:
#   "Stop": [{"hooks": [{"type": "command",
#     "command": "powershell -NoProfile -File C:\\path\\to\\bin\\mem-capture.ps1"}]}]
#
# Environment:
#   CHEAP_MEM_ROOT      memory root (otherwise searched upward from cwd)
#   MEM_CAPTURE_MIN     bytes of growth before capturing (default 4096)
#   MEM_CAPTURE_OFF=1   disable for this session
#   MEM_RAW_EXCLUDE=1   exclude this session (recorded, unlike OFF);
#                       from inside a session: `mem raw exclude`
#   MEM_HEADLESS        set = we are a machine session, do not capture
#
# The hook receives the assistant's JSON on stdin; we read the
# transcript path from it and fall back to $env:CLAUDE_TRANSCRIPT_PATH.

$ErrorActionPreference = 'Continue'

if ($env:MEM_CAPTURE_OFF -eq '1') { exit 0 }

# Never capture ourselves. The digest sets this flag, otherwise the
# digest session's own transcript becomes the next thing to digest.
if ($env:MEM_HEADLESS) { exit 0 }

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Mem  = Join-Path $Here 'mem'

# Read the hook payload only when stdin is actually a pipe. Reading
# an interactive console here would block the session forever.
$StdinJson = ''
if ([Console]::IsInputRedirected) {
  $StdinJson = [Console]::In.ReadToEnd()
}

$Transcript = $env:CLAUDE_TRANSCRIPT_PATH
# The session id, for `mem raw exclude` (otherwise the transcript's file
# name stands in, see src/raw.mjs capture()).
$Session = ''
if ($StdinJson) {
  try {
    $o = $StdinJson | ConvertFrom-Json
    if (-not $Transcript) {
      if ($o.transcript_path) { $Transcript = $o.transcript_path }
      elseif ($o.transcriptPath) { $Transcript = $o.transcriptPath }
    }
    if ($o.session_id) { $Session = [string]$o.session_id }
  } catch { }
}

if (-not $Transcript) { exit 0 }
if (-not (Test-Path $Transcript)) { exit 0 }

$MinBytes = if ($env:MEM_CAPTURE_MIN) { $env:MEM_CAPTURE_MIN } else { '4096' }

# A hook that fails must never break the session it is attached to.
# Errors go nowhere and the exit code stays 0.
try {
  if ($Session) {
    & node $Mem raw-capture --transcript $Transcript --min-bytes $MinBytes --session $Session *> $null
  } else {
    & node $Mem raw-capture --transcript $Transcript --min-bytes $MinBytes *> $null
  }
} catch { }
exit 0
