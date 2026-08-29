# mem-handle-post.ps1 — Windows PowerShell port of bin/mem-handle-post.
#
# Default handler run by mem-watch.ps1 when new inbox mail arrives.
# Spawns an AI CLI in headless mode to process it.
#
# Override with env MEM_WATCH_HANDLER=<path> for a custom flow.
#
# Required env (set by mem-watch.ps1):
#   CHEAP_MEM_ROOT
#   MEM_WATCH_WHO
#   MEM_HEADLESS   set to 'watcher'
#
# Optional:
#   MEM_HANDLER_CMD     AI CLI (default: `claude -p`)
#   MEM_HANDLER_PROMPT  override prompt

$ErrorActionPreference = 'Stop'

if (-not $env:CHEAP_MEM_ROOT) {
  Write-Error "CHEAP_MEM_ROOT not set"
  exit 2
}
if (-not $env:MEM_WATCH_WHO) {
  Write-Error "MEM_WATCH_WHO not set"
  exit 2
}

$CmdLine = if ($env:MEM_HANDLER_CMD) { $env:MEM_HANDLER_CMD } else { 'claude -p' }

$defaultPrompt = @"
You are the '$($env:MEM_WATCH_WHO)' role in this cheap-mem installation. Read `$CHEAP_MEM_ROOT\.mem\config.json for context. Then process new inbox mail addressed to you:

  1. node `$CHEAP_MEM_ROOT\bin\mem inbox new --as $($env:MEM_WATCH_WHO)
  2. For each new message: node `$CHEAP_MEM_ROOT\bin\mem inbox show <name> --as $($env:MEM_WATCH_WHO)
  3. Do what the message asks. If a log entry: node `$CHEAP_MEM_ROOT\bin\mem log <type> ...
  4. If a reply: node `$CHEAP_MEM_ROOT\bin\mem inbox write --as $($env:MEM_WATCH_WHO) --to <sender> --subject ...
  5. Acknowledge: node `$CHEAP_MEM_ROOT\bin\mem inbox ack <name> processed
  6. Commit and push to main:
       git -C `$CHEAP_MEM_ROOT add -A
       git -C `$CHEAP_MEM_ROOT commit -m 'handler: <summary>'
       git -C `$CHEAP_MEM_ROOT push origin HEAD:main

Exit after the last message.
"@

$prompt = if ($env:MEM_HANDLER_PROMPT) { $env:MEM_HANDLER_PROMPT } else { $defaultPrompt }

$parts = $CmdLine -split '\s+' | Where-Object { $_ }
$exe = $parts[0]
$argList = @()
if ($parts.Length -gt 1) { $argList = $parts[1..($parts.Length - 1)] }
$argList += $prompt

& $exe @argList
