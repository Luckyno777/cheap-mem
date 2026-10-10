// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The register of every environment variable cheap-mem reads.
 *
 * **Why it exists.** Environment variables are the one configuration
 * surface nobody sees from the outside: a hook is switched off by
 * `MEM_HOOK_OFF=1`, the search grows a lane behind `MEM_EXPAND=1`, a
 * server binds somewhere else because of `CHEAP_MEM_SERVE_HOST`, and
 * none of it shows up in `--help`. A port agent found that `MEM_EXPAND`
 * could not be written down anywhere; the gap was the register's.
 * (Port of lucky-mem's `schalterregister`, n20.)
 *
 * **Every read is registered.** `scanReads()` walks `src/`, `bin/`,
 * `install/` and `hooks/` and finds each place a variable is read:
 * `process.env.NAME` / `env.NAME` / `env['NAME']`, a constant named
 * `...ENV... = 'NAME'` that is later used as `env[ENV]`, `$NAME` /
 * `${NAME}` in a shell script for the cheap-mem prefixes, and
 * `$env:NAME` in a PowerShell script. `checkComplete()` holds the
 * result against {@link REGISTER}: a name read but not registered, or
 * registered but read nowhere, fails `test/envregister.test.mjs`. Standard
 * operating-system variables ({@link STANDARD}) are skipped.
 *
 * **What a row says.** `kind` tells a reader whether the variable
 * changes WHAT happens (`switch`), only HOW MUCH or HOW LONG (`tuning`),
 * WHERE (`path`), TO WHOM (`connection`), WHO (`identity`), or is a
 * secret (`secret`), a hand-over between two of cheap-mem's own
 * processes (`internal`) or a test hook (`test`). `default` is what
 * happens when nothing is set; `meaning` is one sentence.
 *
 * **The documentation cannot drift.** `docs/environment-variables.md` carries a
 * table between two marker lines that `renderTable()` produces; the same
 * test compares the two. `mem envvars --markdown` prints the block.
 */

import fs from 'node:fs';
import path from 'node:path';

export const KINDS = Object.freeze({
  SWITCH: 'switch',
  TUNING: 'tuning',
  PATH: 'path',
  CONNECTION: 'connection',
  IDENTITY: 'identity',
  SECRET: 'secret',
  INTERNAL: 'internal',
  TEST: 'test',
});

/**
 * Variables every operating system or shell sets for its own reasons.
 * They are read, but nobody configures cheap-mem through them.
 */
export const STANDARD = Object.freeze([
  'HOME', 'USER', 'USERNAME', 'LOGNAME', 'USERPROFILE', 'APPDATA', 'PATH', 'TMPDIR', 'SSH_CONNECTION',
]);

const sw = (name, kind, def, meaning) => ({ name, kind, default: def, meaning });
const { SWITCH, TUNING, PATH, CONNECTION, IDENTITY, SECRET, INTERNAL, TEST } = KINDS;
const OFF = (what) => `${what} is switched off by \`1\``;

export const REGISTER = Object.freeze([
  // --- where the memory lives --------------------------------------------------
  sw('CHEAP_MEM_ROOT', PATH, 'not set (the CLI walks up from the current directory to a `.mem/config.json`)', 'The memory root. The installer writes it into every hook; the CLI, the hooks and the servers read it.'),
  sw('CHEAP_MEM_CODE', PATH, 'not set (the hook uses the root as the code directory)', 'Where the cheap-mem code lives when it is not the memory root itself (the sub-agent and session-start hooks).'),
  sw('CHEAP_MEM_PKG', PATH, 'set by the git hook installer', 'The package directory the installed git hooks call back into.'),
  sw('CHEAP_MEM_ARCHIVE', PATH, 'not set (`raw/YYYY/MM/` inside the root, or the place `mem archive` recorded)', 'Where the raw archive is kept; a mount outside the repository.'),
  sw('CHEAP_MEM_RELEASE_BASE', PATH, '`<root>-release`', 'Base directory of the release copies.'),
  sw('CHEAP_MEM_GOLD_FILE', PATH, '`~/.cheap-mem-gold/...` outside the repository', 'The gold-question log; kept outside the repository on purpose.'),
  sw('CHEAP_MEM_VERIFY_FILE', PATH, '`~/.cheap-mem-verify/...` outside the repository', 'The verification log.'),
  sw('CHEAP_MEM_MISS_GOLD', PATH, '`<root>/.mem/local/miss-gold.jsonl`', 'The local, never-committed file of real retrieval misses.'),
  sw('CHEAP_MEM_CHECK_FILE', PATH, '`<root>/checked.jsonl`', 'Where `bin/mem-check-record` writes its rows.'),
  sw('CHEAP_MEM_USER_PATTERNS', PATH, 'not set (the built-in patterns)', 'A JSON file of the user-habit patterns for `mem user`.'),
  sw('CHEAP_MEM_STATE_SIGNAL_WORDS', PATH, 'not set (the built-in word list)', 'A file of the words that mark a question as being about the current state.'),
  sw('CHEAP_MEM_SERVE_LOGIN_DIR', PATH, '`.pipeline/` of the root (gitignored)', 'Where the viewer keeps its login state.'),
  sw('MEM_BEFORE_EDIT_MARKS', PATH, '`<root>/.mem/before-edit`', 'Directory of the per-session marks of the before-edit hook.'),
  sw('MEM_COMMAND_GUARD_MARKS', PATH, '`<root>/.mem/command-guard-marks`', 'Directory of the per-session marks of the command guard.'),
  sw('MEM_WORKFLOW_MARKS', PATH, '`<root>/.mem/workflow-marks`', 'Directory of the per-session marks of the workflow hint.'),
  sw('MEM_AFTER_FAILURE_TURNS', PATH, '`<root>/.mem/after-failure-turns`', 'Directory of the once-per-turn claims of the after-failure hook.'),
  sw('MEM_CATCH_FAIL_TURNS', PATH, '`<root>/.mem/catch-fail-turns`', 'Directory of the once-per-turn claims of the swallowed-failure hook.'),
  sw('MEM_RECALL_SERVER_DIR', PATH, '`.pipeline/` of the root', 'Where the warm recall server keeps its socket and key; set it when the root path is too long for a Unix socket.'),
  sw('MEM_RECALL_SERVER_SHORT_BASE', PATH, '`/tmp`', 'Base directory for the short socket directory the recall server picks on its own when the default socket path is too long (macOS temp dirs); only used when MEM_RECALL_SERVER_DIR is unset.'),
  sw('MEM_RECALL_SERVER_CODE_STATE', PATH, 'the server\'s own code directory', 'Tests only: which directory\'s `src/` the server watches to restart itself after a code change.'),
  sw('MEM_RETRIEVE_ROOTS', PATH, '`~/cheap-mem /work/cheap-mem /home/user/cheap-mem`', 'Space-separated roots the recall and after-failure hooks probe when `CHEAP_MEM_ROOT` is not set.'),
  sw('MEM_STOP_ROOTS', PATH, '`~/cheap-mem /work/cheap-mem /home/user/cheap-mem`', 'The same probe list for the stop hook.'),
  sw('MEM_WATCH_LOG', PATH, '`<root>/.mem/watch.log`', 'Log file of `bin/mem-watch`.'),
  sw('MEM_DIGEST_LOG', PATH, '`<root>/.mem/digest.log`', 'Log file of `bin/mem-digest`.'),
  sw('MEM_WATCH_HANDLER', PATH, '`bin/mem-handle-post` next to the watcher', 'The program the watcher starts for a new letter.'),
  sw('CLAUDE_HOME', PATH, '`~/.claude`', 'Where the Claude Code user configuration lives (`mem doctor`, the installer).'),
  sw('CLAUDE_CONFIG_DIR', PATH, 'not set', 'Claude Code\'s own configuration directory; its `skills/` is added to the skill catalogue and the MCP setup looks there.'),
  sw('CLAUDE_TRANSCRIPT_PATH', PATH, 'not set (the hook input names the transcript)', 'The session transcript the capture hook reads, when the hook input does not name one.'),

  // --- switches that change what happens ---------------------------------------
  sw('MEM_HOOK_OFF', SWITCH, 'off (all hook stages active)', `Emergency stop for the whole hook chain in one session: ${OFF('every hook stage')}. A session without hooks has no memory.`),
  sw('MEM_RETRIEVE_OFF', SWITCH, 'off', OFF('The recall hook (the relevant entries shown on a question)')),
  sw('MEM_RETRIEVE_NO_PULL', SWITCH, 'off (the hook pulls when the clone is older than `MEM_RETRIEVE_FRESH_MIN`)', 'With `1` the recall hook never runs `git pull` first.'),
  sw('MEM_RECALL_SERVER', SWITCH, 'on (the hook asks the warm server when its socket exists)', 'With `0` the recall hook never asks the warm recall server and always searches directly.'),
  sw('MEM_AFTER_FAILURE_OFF', SWITCH, 'off', OFF('The after-failure hook (what the memory knows about a command that just failed)')),
  sw('MEM_CATCH_FAIL_OFF', SWITCH, 'off', OFF('The swallowed-failure hook')),
  sw('MEM_BEFORE_EDIT_OFF', SWITCH, 'off', OFF('The before-edit hook (what the memory knows about a file about to change)')),
  sw('MEM_SUBAGENT_START_OFF', SWITCH, 'off', OFF('The sub-agent start hook')),
  sw('MEM_SUBAGENT_TASK_OFF', SWITCH, 'off', 'With `1` the sub-agent start no longer adds the block for the assignment (errors, learnings, duties, procedures, skills that fit the task); the base block stays.'),
  sw('MEM_SOLUTION_ATTACH', SWITCH, 'on (`0` switches it off)', 'With `0` the recall hooks no longer put the newest valid solution (a `resolves` link) as one line under a shown error.'),
  sw('MEM_SKILL_ACCOUNT_OFFER', SWITCH, 'on (`0` switches it off)', 'With `0` a skill offer no longer brings the two most important lines of the skill\'s experience account.'),
  sw('MEM_CAPTURE_OFF', SWITCH, 'off', OFF('The raw capture of a session transcript')),
  sw('MEM_STOP_NO_PUSH', SWITCH, 'off (the stop hook commits and pushes)', 'With `1` the stop hook does not push.'),
  sw('MEM_REFLECT', SWITCH, 'off (opt-in)', 'With `1` the stop hook starts the model-backed reflector.'),
  sw('MEM_HEADLESS', SWITCH, 'not set', 'Marks an unattended run (the digest, the reflector, any `claude -p` worker); its value names the run. Such a run is not captured, writes with a lowered authority, and may not confirm projects, categories, appointments or mail permits.'),
  sw('MEM_ANSWER_CHECK', SWITCH, 'on', 'With `0` the stop-time answer check never blocks a turn.'),
  sw('MEM_CLOSING_REPORT', SWITCH, 'on', 'With `0` the closing report of open duties is not shown.'),
  sw('MEM_BROADCAST_OFF', SWITCH, 'off (a new error entry is broadcast)', 'With `1` `mem log error` does not broadcast the new error to the other sessions.'),
  sw('MEM_CORRECTION_WARN_OFF', SWITCH, 'off', 'With `1` `mem correction` does not warn when a rare word of the old entry is missing from the correction.'),
  sw('MEM_RAW_EXCLUDE', SWITCH, 'off', 'With `1` the raw capture skips the session (the environment form of the exclude mark).'),
  sw('MEM_EXPAND', SWITCH, 'off', 'With `1` the search also reads the `asked_as` phrasings stored next to an entry (document expansion, weight 0.3). Off, the search is bit-identical to before.'),
  sw('MEM_RETRIEVE_REQUEST_FRAME', SWITCH, 'on (`0` switches it off)', 'With `0` the request frame at the start of a question ("explain", "can you show me") is searched like every other word, in the recall hook and in the content-word query.'),
  sw('MEM_SEARCH_LEVERS', SWITCH, 'the levers\' own defaults', '`off`, `all` or a list such as `h1,h3`: which Block H search levers are on (`mem search-levers`).'),
  sw('MEM_REWRITES', SWITCH, 'on (the table ships empty)', '`off` switches the whole query-rewrite table off.'),
  sw('MEM_GOLD_DAILY', SWITCH, 'yes', 'With `no` the digest does not run the daily gold-miss collection.'),
  sw('MEM_WATCH_APPOINTMENTS', SWITCH, 'on (when an appointments file exists)', 'With `off` the watcher\'s clock does not tick the appointments.'),
  sw('MEM_WATCH_APPOINTMENTS_SYNC', SWITCH, 'off', 'With `1` the appointment tick also syncs to the outside calendar.'),
  sw('MEM_SKIP_DIGEST', SWITCH, 'off', 'Windows installer: with `1` the digest task is not registered.'),
  sw('CHEAP_MEM_PROFILE', SWITCH, 'off', 'With `1` the hooks write a profile of where their time went.'),
  sw('CHEAP_MEM_MAX_AUTHORITY', SWITCH, 'not set (no ceiling; the digest sets `inferred`)', 'The highest authority a process may claim in what it writes. A model-backed writer must never produce a `user` entry; the digest and the reflector run under a lower ceiling.'),
  sw('CHEAP_MEM_MCP_READONLY', SWITCH, 'off (full tool profile)', 'With `1` the MCP bridge offers only the read tools.'),
  sw('CHEAP_MEM_SERVE_READONLY', SWITCH, 'off', 'With `1` the viewer shows everything and sets nothing.'),
  sw('CHEAP_MEM_SERVE_OFFLINE', SWITCH, 'off', 'With `1` the viewer loads nothing from outside.'),
  sw('CHEAP_MEM_SERVE_LOGIN', SWITCH, 'on', 'With `off` the viewer\'s login is skipped (tests, local only).'),
  sw('CHEAP_MEM_SERVE_SERVICE', SWITCH, 'not set', 'Installer: whether to register the viewer as a service (`1`/`yes`).'),
  sw('CHEAP_MEM_CALENDAR_ROUTE', SWITCH, 'not set (no outside calendar)', 'Which route puts an appointment into a real calendar: SMTP invitation or the Google Calendar API.'),
  sw('CHEAP_MEM_CHECK_HOUSE', IDENTITY, '`package.json` name, else the directory name', 'The house a check-record row names.'),
  sw('CHEAP_MEM_CHECK_MACHINE', IDENTITY, '`cloud` or a short hostname', 'The machine a check-record row names; tests override it.'),

  // --- tuning ------------------------------------------------------------------
  sw('MEM_RETRIEVE_MIN', TUNING, '5.0', 'Score a hit needs before the recall hook shows it.'),
  sw('MEM_RETRIEVE_TOP', TUNING, '3', 'How many hits the recall hook shows at most.'),
  sw('MEM_RETRIEVE_TIE', TUNING, '0 (off)', 'Relative score spread within which ONE more hit than `MEM_RETRIEVE_TOP` comes along when it ties the last one shown (the recall hook only; `0.01` is the 1 % of lucky-mem; valid above 0 up to 0.5, anything else is the hard cut). Off by default: on the gold set it gained nothing and cost one gold case (`docs/recall-levers-2026-10-10.md`).'),
  sw('MEM_SUBAGENT_TASK_SECONDS', TUNING, '2 seconds', 'Time budget of the sub-agent start block for the assignment; past it the base block comes alone (the POSIX hook runs a first, tighter pass and falls back).'),
  sw('MEM_RETRIEVE_TIME', TUNING, '5 seconds', 'Time budget of one recall search, server and direct fallback alike.'),
  sw('MEM_RETRIEVE_FRESH_MIN', TUNING, '10', 'Minutes the clone counts as fresh before the recall hook pulls.'),
  sw('MEM_RETRIEVE_REMOTE', TUNING, 'origin', 'Remote the recall hook pulls from.'),
  sw('MEM_RETRIEVE_BRANCH', TUNING, 'main', 'Branch the recall hook pulls.'),
  sw('MEM_RETRIEVE_TURNS', PATH, '`<root>/.mem/retrieve-turns`', 'Directory of the once-per-turn claims of the recall hook.'),
  sw('MEM_RECALL_SERVER_RESTART_MS', TUNING, '60000', 'Shortest gap between two automatic restarts of the recall server after a code change.'),
  sw('MEM_RECALL_SERVER_WAIT_MS', TUNING, '2500', 'How long the recall client waits for the server before searching directly.'),
  sw('MEM_AFTER_FAILURE_MIN', TUNING, '2.0', 'Score a hit needs before the after-failure hook shows it.'),
  sw('MEM_AFTER_FAILURE_TOP', TUNING, '3', 'How many hits the after-failure hook shows at most.'),
  sw('MEM_CATCH_FAIL_MIN', TUNING, '2.0', 'Score a hit needs before the swallowed-failure hook shows it.'),
  sw('MEM_CATCH_FAIL_TOP', TUNING, '3', 'How many hits the swallowed-failure hook shows at most.'),
  sw('MEM_BEFORE_EDIT_TOP', TUNING, '3', 'How many hits the before-edit hook shows at most.'),
  sw('MEM_BEFORE_EDIT_TRACE', TUNING, 'off', 'With `1` the before-edit hook says on stderr where it exited.'),
  sw('MEM_CAPTURE_MIN', TUNING, '4096', 'Smallest transcript, in bytes, the capture hook keeps (Windows hook).'),
  sw('MEM_CORRECTION_RARE_DF', TUNING, '3', 'Document frequency at or below which a word counts as rare in the correction warning.'),
  sw('MEM_DOCTOR_FULLBUILD_MAX_MIB', TUNING, '32 (never above 1/40 of the heap limit)', 'Source MiB up to which the doctor builds a full search index; above it the index findings say "not measurable".'),
  sw('MEM_DOCTOR_FULLREAD_FACTOR', TUNING, '5', 'Factor of source bytes to heap limit above which whole-corpus doctor findings say "not measurable" instead of dying.'),
  sw('MEM_SKILLUSAGE_DAYS', TUNING, '30', 'Days of capture coverage `mem skills usage` needs before it gives a verdict.'),
  sw('MEM_SKILLUSAGE_TIME_MS', TUNING, '8000', 'Time cap, in milliseconds, for reading the captures.'),
  sw('MEM_ANSWER_CHECK_PATTERNS', PATH, 'not set (`.mem/answer-check-patterns.json` or the built-ins)', 'A JSON file of the answer-check patterns.'),
  sw('MEM_TZ', IDENTITY, '`config.timezone`, else the system zone', 'Time zone for dates `mem` prints.'),
  sw('CHEAP_MEM_TZ', IDENTITY, '`config.timezone`, else the system zone', 'Time zone for appointments (input and output; UTC is stored).'),
  sw('CHEAP_MEM_PARITY_DEBT_WARN_DAYS', TUNING, '14', 'Days a parity debt may stand before `mem doctor` warns.'),
  sw('MEM_ALARM_SECONDS', TUNING, '8', 'Session-start hook: seconds `mem doctor --alarm` may take.'),
  sw('MEM_TODAY_SECONDS', TUNING, '5', 'Session-start hook: seconds `mem today --line` may take.'),
  sw('MEM_DIGEST_TIMEOUT', TUNING, '600', 'Seconds one digest run may take.'),
  sw('MEM_DIGEST_MAX_BYTES', TUNING, '16000000', 'Largest batch of raw captures one digest run reads.'),
  sw('MEM_DIGEST_AGE_RESERVE_PCT', TUNING, '25', 'Share of a digest batch reserved for the oldest captures.'),
  sw('MEM_DIGEST_DEDUP_SINCE', TUNING, 'not set (whole memory)', 'Window such as `30d`, `24h` or `90m` of entries the digest compares against for duplicates.'),
  sw('MEM_DIGEST_STALE_MIN', TUNING, '120', 'Minutes after which a digest lock counts as stale.'),
  sw('MEM_DIGEST_VOLUME_NOW_KB', TUNING, 'not set (the due check\'s own default, 500 KB)', 'Pending raw volume in KB at which a digest is due at once, however fresh the last capture.'),
  sw('MEM_DIGEST_VOLUME_MIN_KB', TUNING, 'not set (the due check\'s own default, 32 KB)', 'Pending raw volume in KB below which a digest is not worth a call, until the ceiling.'),
  sw('MEM_DIGEST_QUIET_MIN', TUNING, 'not set (the due check\'s own default)', 'Minutes without a new capture before a digest becomes due.'),
  sw('MEM_DIGEST_CEILING_H', TUNING, 'not set (the due check\'s own default)', 'Hours after which a digest is due regardless.'),
  sw('MEM_DIGEST_CMD', PATH, '`claude -p`', 'The model command the digest starts (Windows: `claude`, arguments from `MEM_DIGEST_ARGS`).'),
  sw('MEM_DIGEST_ARGS', TUNING, '`-p`', 'Windows digest: arguments of the model command.'),
  sw('MEM_GOLD_TIMEOUT', TUNING, '300', 'Seconds the digest gives the daily gold-miss collection.'),
  sw('MEM_HANDLER_CMD', PATH, '`claude -p`', 'The model command that handles an incoming letter.'),
  sw('MEM_HANDLER_PROMPT', TUNING, 'the built-in prompt', 'The prompt the letter handler gives the model.'),
  sw('MEM_REFLECT_CMD', PATH, '`claude -p`', 'The model command of the reflector.'),
  sw('MEM_REFLECT_PROMPT', TUNING, 'the built-in prompt', 'The prompt the reflector gives the model.'),
  sw('MEM_REFLECT_THRESHOLD_BYTES', TUNING, '400000', 'Transcript growth, in bytes, before the reflector runs again.'),
  sw('MEM_REFLECT_TIMEOUT', TUNING, '90', 'Seconds one reflector run may take.'),
  sw('MEM_WATCH_INTERVAL', TUNING, '15', 'Seconds between two polls of the inbox watcher.'),
  sw('MEM_WATCH_BROKEN_WAIT', TUNING, '60', 'Seconds the watcher waits after a failed poll.'),
  sw('MEM_WATCH_HANDLER_TIMEOUT', TUNING, '300', 'Seconds the letter handler may take.'),
  sw('MEM_WATCH_STALE_MIN', TUNING, '120', 'Minutes after which the watcher\'s lock counts as stale.'),
  sw('MEM_WATCH_REMOTE', CONNECTION, 'not set (`origin`)', 'Remote the inbox watcher fetches from.'),
  sw('MEM_WATCH_BRANCH', CONNECTION, 'not set (`main`)', 'Branch the inbox watcher checks.'),
  sw('MEM_WATCH_WHO', IDENTITY, 'required by the watcher and the letter handler', 'Who this installation is in the inbox (a participant name from `.mem/config.json`).'),
  sw('CHEAP_MEM_AGENT', IDENTITY, '`MEM_AGENT`, else the system user', 'Names the agent behind a write; a deployment sets it for an MCP-bridged agent.'),
  sw('MEM_AGENT', IDENTITY, 'not set', 'Older spelling of `CHEAP_MEM_AGENT`; read when that is not set.'),
  sw('MEM_SURFACE', IDENTITY, 'detected (`cloud`, `ssh`, `headless:<run>`, `local`)', 'Overrides where a session says it runs; only a known value counts for the origin.'),
  sw('CLAUDE_CODE_REMOTE', IDENTITY, 'set by Claude Code in its cloud', 'Marks the cloud surface; read, never set.'),
  sw('CLAUDE_CODE_SESSION_ID', IDENTITY, 'set by Claude Code', 'The session `mem raw-capture` captures when `--session` is not given.'),

  // --- servers and outside connections -----------------------------------------
  sw('CHEAP_MEM_SERVE_HOST', CONNECTION, '127.0.0.1', 'Address the viewer binds to; anything but localhost needs a token.'),
  sw('CHEAP_MEM_SERVE_PORT', CONNECTION, '8847', 'Port of the viewer.'),
  sw('CHEAP_MEM_SERVE_HOSTS', CONNECTION, 'not set', 'Extra host names the viewer answers to.'),
  sw('CHEAP_MEM_SERVE_ORIGINS', CONNECTION, 'not set', 'Extra origins allowed to POST to the viewer.'),
  sw('CHEAP_MEM_SERVE_TITLE', IDENTITY, '`cheap-mem`', 'Title of the viewer page.'),
  sw('CHEAP_MEM_SERVE_TOKEN', SECRET, 'not set (localhost only)', 'Bearer token of the viewer; never printed.'),
  sw('CHEAP_MEM_SERVE_HEAD_ENTRIES', TUNING, '120', 'How many of the newest entries the viewer\'s first answer carries.'),
  sw('CHEAP_MEM_SERVE_FULL_BUILD_MB', TUNING, 'measured in `src/dashboard-head.mjs`', 'Store size in MB above which the viewer builds only the light head.'),
  sw('CHEAP_MEM_SERVE_WINDOW_ENTRIES', TUNING, '30000', 'How many of the newest entries the compact build lists.'),
  sw('CHEAP_MEM_SERVE_TEMPO_TEST_MS', TEST, 'not set', 'Probes only: delays the viewer\'s build so a test can watch the tempo.'),
  sw('CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS', TEST, 'not set', 'Probes only: the sync window of the viewer\'s cache.'),
  sw('CHEAP_MEM_SERVE_CACHE_GAP_TEST_MS', TEST, '0', 'Probes only (with the sync switch): the minimum gap between two background builds of the viewer\'s cache.'),
  sw('CHEAP_MEM_MCP_HOST', CONNECTION, '127.0.0.1', 'Address the HTTP MCP bridge binds to.'),
  sw('CHEAP_MEM_MCP_PORT', CONNECTION, '8849', 'Port of the HTTP MCP bridge.'),
  sw('CHEAP_MEM_MCP_HOSTS', CONNECTION, 'not set', 'Extra host names the MCP bridge answers to.'),
  sw('CHEAP_MEM_MCP_ORIGINS', CONNECTION, 'not set', 'Extra origins the MCP bridge accepts.'),
  sw('CHEAP_MEM_MCP_TOKEN', SECRET, 'not set', 'Bearer token of the HTTP MCP bridge; never printed.'),
  sw('CHEAP_MEM_SMTP_HOST', CONNECTION, 'not set', 'SMTP server for appointment invitations.'),
  sw('CHEAP_MEM_SMTP_PORT', CONNECTION, 'not set (465; 587 is STARTTLS)', 'SMTP port.'),
  sw('CHEAP_MEM_SMTP_TLS', CONNECTION, 'from the port', '`ssl`, `starttls` or `plain` (plain only against your own machine).'),
  sw('CHEAP_MEM_SMTP_USER', IDENTITY, 'not set', 'SMTP login name.'),
  sw('CHEAP_MEM_SMTP_FROM', IDENTITY, 'not set', 'Sender of the invitation.'),
  sw('CHEAP_MEM_SMTP_TO', IDENTITY, 'not set', 'Recipient of the invitation.'),
  sw('CHEAP_MEM_SMTP_PASSWORD_FILE', SECRET, 'not set', 'Path of a file holding the SMTP password (permissions checked); the password never sits in a variable.'),
  sw('CHEAP_MEM_CALENDAR_ID', CONNECTION, 'not set', 'Google calendar the appointments go into.'),
  sw('CHEAP_MEM_CALENDAR_KEY_FILE', SECRET, 'not set', 'Path of the Google service-account key file; its content never sits in a variable.'),
  sw('CHEAP_MEM_CALENDAR_REMIND_MIN', TUNING, 'not set (config, else 15)', 'Minutes before the appointment the outside calendar alarms.'),
  sw('OLLAMA_HOST', CONNECTION, 'http://localhost:11434', 'Where the Ollama embedding backend listens.'),
  sw('OPENAI_API_KEY', SECRET, 'not set (`.mem/embed.env` is read next)', 'Key of the OpenAI embedding backend; never printed.'),
  sw('VOYAGE_API_KEY', SECRET, 'not set (`.mem/embed.env` is read next)', 'Key of the Voyage embedding backend; never printed.'),

  // --- handed from one cheap-mem process to the next ---------------------------
  sw('CM_REBUILD_LOCK', INTERNAL, 'set by the component-table rebuild', 'Lock file the detached rebuild child removes when it ends.'),
  sw('MEM_RECALL_SERVER_PARENT', INTERNAL, 'set by the keeper', 'Pid of the keeper; the server exits when that process is gone.'),
  sw('MEM_AF_SESSION', INTERNAL, 'set by the hook script', 'After-failure hook: the session id handed to the journal.'),
  sw('MEM_AF_REASON', INTERNAL, 'set by the hook script', 'After-failure hook: why nothing was shown.'),
  sw('MEM_AF_START_MS', INTERNAL, 'set by the hook script', 'After-failure hook: start time for the latency figure.'),
  sw('MEM_BE_START_MS', INTERNAL, 'set by the hook script', 'Before-edit hook: start time for the latency figure.'),
  sw('MEM_HOOK_START_MS', INTERNAL, 'set by the hook script', 'Recall hook: start time for the latency figure.'),
  sw('MEM_J_BYTES', INTERNAL, 'set by the hook script', 'Before-edit journal line: bytes shown.'),
  sw('MEM_J_HITS', INTERNAL, 'set by the hook script', 'Before-edit journal line: number of hits.'),
  sw('MEM_J_FILE', INTERNAL, 'set by the hook script', 'Before-edit journal line: the path the tool touched (two segments, relative).'),
  sw('MEM_J_TOOL', INTERNAL, 'set by the hook script', 'Before-edit journal line: the name of the tool that set the hook off.'),
  sw('MEM_J_IDS', INTERNAL, 'set by the hook script', 'Before-edit journal line: ids of the solutions shown below errors, comma separated.'),
  sw('MEM_J_PATH', INTERNAL, 'set by the hook script', 'Recall journal line: which path answered.'),
  sw('MEM_J_PATH_REASON', INTERNAL, 'set by the hook script', 'Recall journal line: why that path.'),
  sw('MEM_J_QB', INTERNAL, 'set by the hook script', 'Recall journal line: size of the question in bytes.'),
  sw('MEM_J_REASON', INTERNAL, 'set by the hook script', 'Journal line: why nothing was shown.'),
  sw('MEM_J_ROOT', INTERNAL, 'set by the hook script', 'Journal line: the memory root.'),
  sw('MEM_J_SESSION', INTERNAL, 'set by the hook script', 'Journal line: the session id.'),
  sw('MEM_J_SRC', INTERNAL, 'set by the hook script', 'Journal line: path of the injection module to import.'),
  sw('MEM_J_START', INTERNAL, 'set by the hook script', 'Journal line: start time.'),
  sw('MEM_RH_CWD', INTERNAL, 'set by the recall hook script', 'Recall hook: working directory for the context reorder.'),
  sw('MEM_RH_MIN', INTERNAL, 'set by the recall hook script', 'Recall hook: score threshold handed to the search.'),
  sw('MEM_RH_PATH', INTERNAL, 'set by the recall hook script', 'Recall hook: which path answered.'),
  sw('MEM_RH_PATH_REASON', INTERNAL, 'set by the recall hook script', 'Recall hook: why that path.'),
  sw('MEM_RH_PROMPT', INTERNAL, 'set by the recall hook script', 'Recall hook: the question.'),
  sw('MEM_RH_QB', INTERNAL, 'set by the recall hook script', 'Recall hook: size of the question in bytes.'),
  sw('MEM_RH_SESSION', INTERNAL, 'set by the recall hook script', 'Recall hook: the session id.'),
  sw('MEM_RH_START_MS', INTERNAL, 'set by the recall hook script', 'Recall hook: start time.'),
  sw('MEM_RH_TRANSCRIPT', INTERNAL, 'set by the recall hook script', 'Recall hook: the transcript for the context reorder.'),
  sw('MEM_RH_TURNS', INTERNAL, 'set by the recall hook script', 'Recall hook: directory of the once-per-turn claims.'),
  sw('MEM_RH_WORKFLOW', INTERNAL, 'set by the recall hook script', 'Recall hook: the workflow hint found for the question.'),
  sw('MEM_SS_START_MS', INTERNAL, 'set by the installer hook', 'Session-start hook (Windows): start time.'),
  sw('MEM_SS_SRC', INTERNAL, 'set by the installer hook', 'Session-start hook (Windows): injection module to import.'),
  sw('MEM_SS_INPUT', INTERNAL, 'set by the installer hook', 'Session-start hook (Windows): the hook input JSON.'),
  sw('MEM_BT_CMD', INTERNAL, 'set by the hook script', 'Before-edit hook (Windows): the Bash command whose write targets are extracted.'),
  sw('MEM_PICK', INTERNAL, 'set by the hook script', 'Before-edit hook (Windows): the hits chosen to be shown.'),
  sw('MEM_ERRSIG', INTERNAL, 'set by the hook script', 'Swallowed-failure hook (Windows): path of the error-signature module.'),
  sw('MEM_MARK', INTERNAL, 'set by the hook script', 'Before-edit hook: the mark file of the current file.'),
  sw('MEM_LEVEL', INTERNAL, 'set by the hook script', 'Before-edit hook: the store\'s current level.'),
  sw('MEM_FP', INTERNAL, 'set by the hook script', 'Before-edit hook: fingerprint of what was shown.'),
  sw('MEM_COUNT', INTERNAL, 'set by the hook script', 'Before-edit hook: how many hits were shown.'),
  sw('MEM_Q', INTERNAL, 'set by the hook script', 'Before-edit hook: the path being asked about.'),
  sw('MEM_ROOT_ARG', INTERNAL, 'set by the hook script', 'Before-edit hook: the root handed to an inline `node -e`.'),
  sw('MEM_DETOUR_REASON', INTERNAL, 'set by the letter handler', 'Letter handler: why it retried once.'),
  sw('MEM_START', INTERNAL, 'shell array', 'Shell array holding the model command; not an environment variable.'),
  sw('MEM_CAP', INTERNAL, 'shell array', 'Shell array `timeout`/`gtimeout` in `_portable.sh`; not an environment variable.'),
  sw('MEM_CLI', INTERNAL, 'shell variable', 'Path of `bin/mem` inside the watcher; not an environment variable.'),
  sw('MEM_ALARM', INTERNAL, 'shell variable', 'Session-start hook: the output of `mem doctor --alarm`.'),
  sw('MEM_ALARM_RC', INTERNAL, 'shell variable', 'Session-start hook: its exit code.'),
  sw('MEM_TODAY', INTERNAL, 'shell variable', 'Session-start hook: the output of `mem today --line`.'),
  sw('MEM_USER_HABITS', INTERNAL, 'shell variable', 'Session-start hook: the output of `mem user --session-start`.'),
  sw('MEM_SS_CODE', INTERNAL, 'shell variable', 'Session-start hook: the directory the injection module was found in.'),
  sw('MEM_SS_IN', INTERNAL, 'shell variable', 'Session-start hook: the hook input read from stdin.'),
  sw('TRANSCRIPT_PATH', INTERNAL, 'set by the reflector script', 'Reflector (Windows): the transcript path the prompt names.'),
  sw('TRANSCRIPT_PATH_ENV', TEST, 'not set', 'Reflector (Windows): a way to hand the transcript in by hand.'),
  sw('ROOT', INTERNAL, 'set by the digest script', 'Digest: the root handed to the batch-selection `node -e`.'),
  sw('MAX', INTERNAL, 'set by the digest script', 'Digest: byte budget handed to the batch selection.'),
  sw('RESERVE', INTERNAL, 'set by the digest script', 'Digest: age reserve handed to the batch selection.'),
]);

// ----------------------------------------------------------------------------
// The scan.
// ----------------------------------------------------------------------------

/** Where reads can live. `docs/` and `test/` are not read: nothing there configures the product. */
export const SCAN_DIRS = Object.freeze(['src', 'bin', 'install', 'hooks']);

const NODE_READS = [
  /\b(?:process\.env|env)\??\.([A-Z][A-Z0-9_]*)/g,
  /\benv\??\.?\[\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  // `export const ENV = 'MEM_EXPAND'` ... `env[ENV]`: the name is a constant.
  /\bconst\s+[A-Z_]*ENV[A-Z_]*\s*=\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
];
const SHELL_READS = [/\$\{?((?:CHEAP_)?MEM_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+)/g];
const POWERSHELL_READS = [/\$env:([A-Za-z_][A-Za-z0-9_]*)/g];

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(full); } else if (e.isFile()) yield full;
  }
}

/** A line with its comment dropped: a whole-line comment is nothing, a trailing `// ...` or `# ...` is cut. */
function code(line) {
  if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return '';
  return line.replace(/\s\/\/\s.*$/, '').replace(/\s#\s.*$/, '');
}

/**
 * Every read of an environment variable under `root`:
 * `[{ name, file, line }]`, `file` relative to `root`. Standard variables are left out.
 */
export function scanReads(root, { dirs = SCAN_DIRS } = {}) {
  const found = [];
  for (const dir of dirs) {
    for (const file of walk(path.join(root, dir))) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue;
      const patterns = [...NODE_READS, ...SHELL_READS, ...(file.endsWith('.ps1') ? POWERSHELL_READS : [])];
      // Always posix: the place is compared with registered rows and printed (Windows gave bin\\x).
      const rel = path.relative(root, file).split(path.sep).join('/');
      text.split('\n').forEach((raw, i) => {
        const line = code(raw);
        if (!line) return;
        for (const re of patterns) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line))) {
            if (!STANDARD.includes(m[1])) found.push({ name: m[1], file: rel, line: i + 1 });
          }
        }
      });
    }
  }
  return found;
}

/**
 * Hold the reads of `root` against the register.
 * `{ ok, unregistered, unread, reads }`: `unregistered` is `[{ name, places }]` (read, no row),
 * `unread` the names with a row that nothing reads any more.
 */
export function checkComplete(root, { register = REGISTER } = {}) {
  const reads = scanReads(root);
  const known = new Set(register.map((s) => s.name));
  const places = new Map();
  for (const r of reads) {
    if (!places.has(r.name)) places.set(r.name, []);
    places.get(r.name).push(`${r.file}:${r.line}`);
  }
  const unregistered = [...places].filter(([n]) => !known.has(n))
    .map(([name, p]) => ({ name, places: p })).sort((a, b) => a.name.localeCompare(b.name));
  const unread = register.map((s) => s.name).filter((n) => !places.has(n)).sort();
  return { ok: unregistered.length === 0 && unread.length === 0, unregistered, unread, reads };
}

// ----------------------------------------------------------------------------
// The documentation table.
// ----------------------------------------------------------------------------

const TABLE_BEGIN = '<!-- envvars:begin (generated by `mem envvars --markdown`; test/envregister.test.mjs compares it) -->';
const TABLE_END = '<!-- envvars:end -->';

const cell = (t) => String(t).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The markdown block between the two markers: every row, grouped by kind, `internal` rows as one list. */
export function renderTable(register = REGISTER) {
  const lines = [TABLE_BEGIN, ''];
  const order = [SWITCH, TUNING, PATH, CONNECTION, IDENTITY, SECRET, TEST];
  const heading = {
    [SWITCH]: 'Switches — they change what happens',
    [TUNING]: 'Tuning — how much, how long, how often',
    [PATH]: 'Places — where something lives',
    [CONNECTION]: 'Connections — servers, ports, remotes',
    [IDENTITY]: 'Identity — who, which zone, which surface',
    [SECRET]: 'Secrets — never printed',
    [TEST]: 'Test hooks',
  };
  for (const kind of order) {
    const rows = register.filter((s) => s.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    if (!rows.length) continue;
    lines.push(`### ${heading[kind]}`, '', '| Variable | Default | Meaning |', '| --- | --- | --- |');
    for (const s of rows) lines.push(`| \`${s.name}\` | ${cell(s.default)} | ${cell(s.meaning)} |`);
    lines.push('');
  }
  const internal = register.filter((s) => s.kind === INTERNAL).map((s) => `\`${s.name}\``).sort();
  lines.push('### Internal — handed from one cheap-mem process to the next', '',
    'Set by a hook script for the program it starts, or plain shell variables that only look like environment',
    `variables. Nothing to configure: ${internal.join(', ')}.`, '', TABLE_END);
  return lines.join('\n');
}

/** The block currently in `text` (markers included), or `null`. */
export function tableIn(text) {
  const a = text.indexOf(TABLE_BEGIN);
  const b = text.indexOf(TABLE_END);
  return a >= 0 && b > a ? text.slice(a, b + TABLE_END.length) : null;
}
