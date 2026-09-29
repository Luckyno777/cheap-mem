# Integration contract

A tool being available guarantees three things about the memory
**nothing**: that it is searched in time, that anything is logged, that
duties are honoured. That was the outside criticism of 2026-09-29, and
it is right about the wiring: some occasions are covered by a hook that
fires on its own, others only by a tool somebody has to remember to call.
This page says which is which, per occasion and per client, and the
doctor checks that it stays true.

## The five occasions

| Occasion | Meaning |
|---|---|
| session-start | the session begins |
| task-start | a task begins, or a relevant message arrives |
| before-change | before an important change (a file is about to be edited) |
| after-error | after a failure, before the second attempt |
| task-end | the task is finished |

## The three clients

- **Claude Code**: hooks, registered by `install/claude-code.sh` (the
  Windows installer `install/windows.ps1` registers its own set).
- **MCP clients** (a chat bridge, an IDE): the tools of `bin/mem-mcp`, no
  hooks. Nothing in the protocol makes a client call a tool.
- **Plain CLI**: `mem <command>`, run by hand. No trigger at all.

## The three states

- **full**: an automatic trigger exists (a registered hook), its file
  exists, and it does what the occasion asks for.
- **partial**: an entry exists, but it covers only part of the occasion
  or must be called by someone. A missing hook is written down here as
  partial support. It is not left out.
- **missing**: nothing exists.

## The three measures

Every occasion can be read three ways, and they are different claims:

- **Delivered**: the hook put text into the context (journal line with
  reason null).
- **Retrieved**: a search actually ran, whatever it found. Every journal
  line counts, including the ones that found nothing, with their reason
  (no signal, empty, too weak). That tells "never searched" from
  "searched, nothing found".
- **Considered**: afterwards an entry was named, opened or edited within
  the window (`src/effect.mjs`). Approximate, and only reported past its
  floor of pairs. Being delivered is not being used.

"Not measured" is written as such. It is never counted as zero.

## The matrix

The block below is generated from `src/integrationcontract.mjs`. Do not
edit it by hand; run `node src/integrationcontract.mjs --write`. The test
`test/integration-contract.test.mjs` fails when the block and the code
differ, and when a cell marked `full` points at a file, a registration or
a tool that does not exist.

<!-- BEGIN GENERATED: integration-matrix -->
| Occasion | Claude Code (hooks) | MCP clients | plain CLI |
|---|---|---|---|
| session-start | full | partial | partial |
| task-start | full | partial | partial |
| before-change | full | partial | partial |
| after-error | partial | partial | partial |
| task-end | partial | partial | partial |

Evidence and scope per cell:

- **claude-code / session-start: full.** Core facts and recent context at every start; a subagent gets its own block.
  - `installer registers SessionStart -> cheap-mem-session-start.sh`
  - `install/hooks/session-start.sh`
  - `installer registers SubagentStart -> cheap-mem-subagent-start.sh`
  - `install/hooks/subagent-start.sh`
  - `bin/mem-subagent-start`
- **claude-code / task-start: full.** Every message is searched; the top hits above the score bar are injected.
  - `installer registers UserPromptSubmit -> cheap-mem-user-prompt.sh`
  - `install/hooks/user-prompt.sh`
  - `bin/mem-retrieve`
- **claude-code / before-change: full.** Literal path lookup before Edit, Write and NotebookEdit; once per file per session. Reading a file or a shell command does not trigger it.
  - `installer registers PreToolUse[Edit|Write|NotebookEdit] -> cheap-mem-pre-edit.sh`
  - `install/hooks/pre-edit.sh`
  - `bin/mem-before-edit`
- **claude-code / after-error: partial.** Only failures the exit code hid (exit 0, failure in the output). There is NO hook on PostToolUseFailure: a command that really exits nonzero gets no recall. The error-log hint (src/errorcontext.mjs) fires on writing an error, not on having one.
  - `installer registers PostToolUse[Bash] -> cheap-mem-catch-fail.sh`
  - `bin/mem-catch-fail`
- **claude-code / task-end: partial.** Captures and persists the session and checks the last answer against logged error patterns. Nothing checks open duties or asks for a log entry at the end.
  - `installer registers Stop -> cheap-mem-session-stop.sh`
  - `install/hooks/session-stop.sh`
  - `bin/mem-stop`
  - `src/answercheck.mjs`
- **mcp / session-start: partial.** Tool exists; nothing makes the client call it at the start (docs/system-prompt.txt only asks).
  - `bin/mem-mcp (contains name: 'mem_context')`
- **mcp / task-start: partial.** Tools exist; the client decides whether and when to search.
  - `bin/mem-mcp (contains name: 'mem_retrieve')`
  - `bin/mem-mcp (contains name: 'mem_find')`
- **mcp / before-change: partial.** Component lookup by path exists; no trigger before an edit.
  - `bin/mem-mcp (contains name: 'mem_component')`
- **mcp / after-error: partial.** Search and error logging exist; no trigger after a failure.
  - `bin/mem-mcp (contains name: 'mem_find')`
  - `bin/mem-mcp (contains name: 'mem_log')`
- **mcp / task-end: partial.** Logging and the duty list exist; nothing asks for either at the end.
  - `bin/mem-mcp (contains name: 'mem_log')`
  - `bin/mem-mcp (contains name: 'mem_duties')`
- **cli / session-start: partial.** `mem context`, run by hand.
  - `src/cli/commands/search.mjs (contains context: async)`
- **cli / task-start: partial.** `mem find`, run by hand.
  - `src/cli/commands/search.mjs (contains find: async)`
- **cli / before-change: partial.** `mem component <path>`, run by hand.
  - `src/cli/commands/setup.mjs (contains component: async)`
- **cli / after-error: partial.** `mem find` and `mem log error`, run by hand.
  - `src/cli/commands/search.mjs (contains find: async)`
  - `src/cli/commands/write.mjs (contains log: async)`
- **cli / task-end: partial.** `mem duties` and `mem log`, run by hand.
  - `src/cli/commands/write.mjs (contains duties: async)`
  - `src/cli/commands/write.mjs (contains log: async)`

Budget per occasion:

| Occasion | Puts in | Budget |
|---|---|---|
| session-start | FACTS.md, `mem context --n 10`, the working-style block; for a subagent the tagged procedures plus a recap | 10 context entries; a subagent block gets the remainder of its byte budget |
| task-start | up to 3 hits above the score bar for the message | MEM_RETRIEVE_TOP=3, MEM_RETRIEVE_MIN=5.0; 4000 ms latency budget (src/latencybudget.mjs) |
| before-change | up to 3 entries that name the file about to be changed | MEM_BEFORE_EDIT_TOP=3, once per file per session; 1000 ms latency budget |
| after-error | up to 3 entries matching the failure signature | MEM_CATCH_FAIL_TOP=3, MEM_CATCH_FAIL_MIN=2.0, once per session per signature; capped at 5 s |
| task-end | nothing is retrieved; the answer check may block once, the capture is written and pushed | capture about 50 ms; push best-effort |

Measured today on the hook path:

| Occasion | Delivered | Retrieved | Considered | Where |
|---|---|---|---|---|
| session-start | not measured | not measured | not measured | the start hook prints straight to the context; it books no journal line |
| task-start | measured | measured | approximate | src/injection.mjs (occasion question, reason null = delivered, any reason = retrieved); src/effect.mjs (30-minute window, floor of pairs) |
| before-change | not measured | not measured | not measured | the journal vocabulary has occasion before-edit (and a latency budget), but no writer books it |
| after-error | not measured | not measured | not measured | the catch-fail hook books no journal line |
| task-end | not measured | not measured | not measured | the stop hook writes the raw capture (that is the record), not a delivery line |
<!-- END GENERATED: integration-matrix -->

## How the doctor reads it

The finding `integration-contract` has four states:

- **good**: every occasion of the installed client is full.
- **warning**: partial support. This is the state to expect for Claude
  Code today (after-error and task-end are partial).
- **error**: a cell declared full whose hook file, registration or tool
  does not exist. The contract claims more than the tree holds.
- **unknown**: cannot tell which client is installed. Only Claude Code
  leaves a trace (its hooks in a settings file); an MCP client or a shell
  leaves none.

## What is not built

No hook was added for this contract. It makes visible what is there and
what is missing. The open gaps are the two `partial` cells of Claude Code
and the not-measured cells of the last table.
