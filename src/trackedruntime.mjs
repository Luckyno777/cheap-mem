// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Runtime files of `.pipeline/` and of the runtime paths under `.mem/` that a memory has ALREADY committed.
 *
 * A `.gitignore` rule does not untrack: a memory that committed `.pipeline/injections.jsonl` before the
 * rule existed keeps tracking it - the tree turns dirty at every hook write, the recall hook's pull stops, and
 * two clones meet in add/add conflicts. `git check-ignore --no-index` says "ignored" all the same (it ignores the
 * index on purpose), so the doctor's answer "git ignores all paths" was false good for exactly these memories.
 * This asks git for what is tracked AND ignored under those paths.
 *
 * It reports FOLDERS AND COUNTS and never a file name: the names come out of the index, which anybody who can commit can fill
 * (an escape sequence, a newline or a bidi override is a legal file name on POSIX), and the line goes to a terminal and
 * into a model's context.
 */

import { spawnSync } from 'node:child_process';

// The wildcard is built from parts: a slash and a star side by side inside a string open a block comment for the source scanners
// of the guards (test/english-only.test.mjs and its kin), which then read code as comment text to the end of the file.
const STAR = '*';
const KEYRING_NOTE = '.mem/keyring.json is TRACKED: its keys are in the history. An entry that was shredded must NOT count as deleted - '
  + 'the destroyed key is still in an earlier commit, and `git rm --cached` repairs the index only, not the history.';

/**
 * Every path under `.pipeline/` and `.mem/` that is runtime state of ONE clone and nothing else, with the gitignore rule
 * `mem init` writes for it, the pathspec git is asked with (and `git rm --cached` is told), a concrete path the doctor
 * asks `check-ignore` about, and why. Evidence is the code that writes it (the comment names the sibling in `.gitignore`
 * or the module). test/pipeline-ignore.test.mjs holds this table, the rules `mem init` writes and the register of the
 * per-session folders together.
 *
 * `secret` names what a missing rule exposes (the doctor turns ERROR); `trackedNote` is the sentence for the same file being TRACKED,
 * which is worse than a dirty tree (a secret in the history): the doctor says it in its own sentence and turns ERROR.
 *
 * Deliberately NOT here (owner's data or an open question, see the CHANGELOG): `.mem/config.json`, `.mem/thesaurus.json`,
 * `.mem/answer-patterns.json`, `.mem/langbridge/` (authored settings), `.mem/rewrites.jsonl` (an append-only table),
 * `.mem/bridge-reports.jsonl`, `.mem/raw-exclusion-state.json`, `raw/` and the ledgers (tracked on purpose).
 */
export const RUNTIME_RULES = Object.freeze([
  // The rules a memory has had since before this table (the first ones from the hand-written list of `writeMemoryGitignore`):
  // they stand here so that a memory which COMMITTED one of them before the rule is reported, not only one that lacks the rule.
  { rule: '.mem/embed.env', spec: '.mem/embed.env', probe: '.mem/embed.env', why: 'API keys. NEVER commit this.', secret: 'embed.env holds API keys',
    trackedNote: '.mem/embed.env holds API keys and is in the history now: rotate the keys. `git rm --cached` only takes it out of the index.' },
  { rule: '.mem/epoch.json', spec: '.mem/epoch.json', probe: '.mem/epoch.json',
    why: 'Local rollback watermark. Never commit: a tracked one\n     travels back with the checkout it is meant to detect.' },
  // Both names of the search cache, and that is not an oversight. Since B8 (2026-09-20) `loadIndex` writes it as a DIRECTORY,
  // `.mem/search-index/`; `.mem/search-index.json` is the old single-file name. A memory created before that change carries only
  // the old line and would COMMIT the new directory - found by measuring exactly this line. The old line stays because a
  // leftover file from before the change can still be lying around.
  { rule: '.mem/search-index.json', spec: '.mem/search-index.json', probe: '.mem/search-index.json', why: 'derived: rebuilt in milliseconds (old single-file name)' },
  { rule: '.mem/search-index/', spec: '.mem/search-index', probe: '.mem/search-index/', why: 'derived: the shard cache, rebuilt in milliseconds' },
  { rule: '.mem/vectors.db', spec: '.mem/vectors.db', probe: '.mem/vectors.db', why: 'derived: rebuild with `mem embed backfill`' },
  { rule: '.mem/tasks/', spec: '.mem/tasks', probe: '.mem/tasks/', why: 'per-machine task log (E1.7): started/progress/result/cancelled\n     lines for `mem-serve`\'s /task route, and the export it writes into' },
  { rule: '.mem/raw-offsets.json', spec: '.mem/raw-offsets.json', probe: '.mem/raw-offsets.json', why: 'per-machine read positions' },
  { rule: '.mem/local/', spec: '.mem/local', probe: '.mem/local/', why: 'per-machine private files (miss-gold question text) must never travel' },
  { rule: '.mem/digest-bell.json', spec: '.mem/digest-bell.json', probe: '.mem/digest-bell.json', why: 'transient' },
  { rule: '.mem/digest.lock', spec: '.mem/digest.lock', probe: '.mem/digest.lock', why: 'transient' },
  { rule: '.mem/digest.log', spec: '.mem/digest.log', probe: '.mem/digest.log', why: 'local log' },
  { rule: '.mem/hooks/', spec: '.mem/hooks', probe: '.mem/hooks/', why: 'generated by `mem hooks install`, machine-specific' },
  // The WHOLE folder (2026-10-14), not file by file. `.pipeline/` is runtime state of ONE clone: the injection journal, the
  // clone-gate verdict, the recall server's socket and key, the command-guard booklet, the cost journal, the shrink
  // baseline. Each appeared there by a different feature, and only the observation ledger had a line - so `git add -A`
  // (mem-reflect, mem-handle-post) tracked the others, every hook write made the tree dirty and blocked the recall hook's
  // pull, and two clones met in add/add conflicts on files that describe one machine each.
  { rule: '.pipeline/', spec: '.pipeline', probe: '.pipeline/injections.jsonl', why: 'runtime state of ONE clone (journals, verdict caches, server key, baselines): never travels' },
  // The shred keys (docs/CAPABILITIES.md 10.23, src/shred.mjs): a keyring under git history defeats the whole mechanism - destroying a key
  // becomes a new commit and the old key stays recoverable from the one before. mem-reflect and mem-handle-post run `git add -A`.
  { rule: '.mem/keyring.json', spec: '.mem/keyring.json', probe: '.mem/keyring.json',
    why: 'the shred keys: under git history a destroyed key stays in the commit before. Never travels, never committed',
    secret: 'keyring.json holds the shred keys', trackedNote: KEYRING_NOTE },
  // The atomic write goes through a temp file next to it (`keyring.json.<pid>.<hex>.tmp`); a `git add -A` at that moment would take the keys.
  { rule: `.mem/keyring.json.${STAR}.tmp`, spec: `.mem/keyring.json.${STAR}.tmp`, probe: '.mem/keyring.json.1234.abcdef.tmp',
    why: 'the temp file of the atomic keyring write', secret: 'the keyring temp file holds the shred keys', trackedNote: KEYRING_NOTE },
  // Per-session marks, hook claims and lock files (2026-10-16).
  { rule: '.mem/before-edit/', spec: '.mem/before-edit', probe: '.mem/before-edit/', why: 'per-session marks of the before-edit hook (JSON: level and fingerprint last shown)' },
  { rule: '.mem/workflow-marks/', spec: '.mem/workflow-marks', probe: '.mem/workflow-marks/', why: 'per-session marks of the workflow hint' },
  { rule: '.mem/command-guard-marks/', spec: '.mem/command-guard-marks', probe: '.mem/command-guard-marks/', why: 'per-session marks of the command guard (empty .warned files, which git tracks)' },
  { rule: '.mem/locks/', spec: '.mem/locks', probe: '.mem/locks/', why: 'drawer lock files: owner pid, host and start time of this machine' },
  // Claims taken by `mkdir`, swept after 60 minutes: empty folders, which git does not see - the rule keeps it so.
  { rule: '.mem/retrieve-turns/', spec: '.mem/retrieve-turns', probe: '.mem/retrieve-turns/', why: 'once-per-turn claims of the recall hook' },
  { rule: '.mem/catch-fail-turns/', spec: '.mem/catch-fail-turns', probe: '.mem/catch-fail-turns/', why: 'once-per-turn claims of the swallowed-failure hook' },
  { rule: '.mem/after-failure-turns/', spec: '.mem/after-failure-turns', probe: '.mem/after-failure-turns/', why: 'once-per-turn claims of the after-failure hook' },
  // Derived caches (the module says "derived" / "always rebuildable").
  { rule: '.mem/component-table.json', spec: '.mem/component-table.json', probe: '.mem/component-table.json', why: 'derived: the offline-built path/symbol register of `mem component` (src/component-table.mjs)' },
  { rule: '.mem/component-table-rebuild.log', spec: '.mem/component-table-rebuild.log', probe: '.mem/component-table-rebuild.log', why: 'log of the background rebuild of the component table' },
  { rule: '.mem/component-table-rebuild.lock', spec: '.mem/component-table-rebuild.lock', probe: '.mem/component-table-rebuild.lock', why: 'lock of the background rebuild of the component table' },
  { rule: '.mem/backlinks.json', spec: '.mem/backlinks.json', probe: '.mem/backlinks.json', why: 'derived: the backlink register, always rebuildable (src/backlinks.mjs)' },
  { rule: '.mem/dashboard-head.json', spec: '.mem/dashboard-head.json', probe: '.mem/dashboard-head.json', why: 'derived: the head the dashboard server lays down after every build' },
  { rule: '.mem/timetrack/', spec: '.mem/timetrack', probe: '.mem/timetrack/', why: 'derived: the block tables of `mem` time-window search (src/timetrack.mjs)' },
  // Logs and locks of the background jobs.
  { rule: '.mem/watch.log', spec: '.mem/watch.log', probe: '.mem/watch.log', why: 'log of bin/mem-watch (this repo\'s own .gitignore lists it as local state)' },
  { rule: '.mem/serve.log', spec: '.mem/serve.log', probe: '.mem/serve.log', why: 'log of the `mem serve` service' },
  { rule: `.mem/${STAR}.lock`, spec: `.mem/${STAR}.lock`, probe: '.mem/watch.lock', why: 'lock files of the jobs (watch, timetrack build, ChatGPT import, appointments)' },
  { rule: `.mem/${STAR}.lock.d/`, spec: `.mem/${STAR}.lock.d/${STAR}`, probe: '.mem/watch.lock.d/', why: 'lock directories of the shell jobs (mkdir locks where flock is missing)' },
  // Per-machine state that the code itself calls gitignored / machine-local / not versioned.
  { rule: '.mem/inbox-seen.json', spec: '.mem/inbox-seen.json', probe: '.mem/inbox-seen.json', why: 'what this machine has seen in the inbox (this repo\'s own .gitignore lists it as local state)' },
  { rule: '.mem/inbox-whoami', spec: '.mem/inbox-whoami', probe: '.mem/inbox-whoami', why: 'who this installation is in the inbox (this repo\'s own .gitignore lists it as local state)' },
  { rule: '.mem/reflect-marker/', spec: '.mem/reflect-marker', probe: '.mem/reflect-marker/', why: 'reflector throttle state (this repo\'s own .gitignore lists it as local state)' },
  { rule: '.mem/console.json', spec: '.mem/console.json', probe: '.mem/console.json', why: 'machine-local console settings (src/console.mjs: "equally local")' },
  { rule: '.mem/console-log.jsonl', spec: '.mem/console-log.jsonl', probe: '.mem/console-log.jsonl', why: 'machine-local, gitignored console log (src/console.mjs)' },
  { rule: '.mem/measurements.jsonl', spec: '.mem/measurements.jsonl', probe: '.mem/measurements.jsonl', why: 'weekly instrument trace of THIS machine (src/measurements.mjs: "gitignored")' },
  { rule: '.mem/raw-watermark.json', spec: '.mem/raw-watermark.json', probe: '.mem/raw-watermark.json', why: 'capture watermark of this machine (src/raw.mjs: "gitignored, does not travel")' },
  { rule: '.mem/archive.json', spec: '.mem/archive.json', probe: '.mem/archive.json', why: 'machine-local archive location (src/archive.mjs: "gitignored and does NOT travel")' },
  { rule: '.mem/rule-draft-week', spec: '.mem/rule-draft-week', probe: '.mem/rule-draft-week', why: 'which week the weekly rule-draft tick did (src/ruledraft.mjs: "machine-local, gitignored")' },
  { rule: '.mem/embed.json', spec: '.mem/embed.json', probe: '.mem/embed.json', why: 'embedding provider config of this machine (src/embed/index.mjs: "not versioned")' },
]);

/** Folders and paths git is asked about (the pathspecs). */
export const RUNTIME_DIRS = Object.freeze(RUNTIME_RULES.map((r) => r.spec));

/**
 * A pathspec as a test over the whole path: `*` crosses `/` AND line breaks (git's own wildcard does; a `.` would let a
 * file name with a newline fall out of every group), a plain spec matches itself and what is under it.
 */
function specMatcher(spec) {
  if (!spec.includes('*')) return (f) => f === spec || f.startsWith(`${spec}/`);
  const re = new RegExp(`^${spec.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
  return (f) => re.test(f);
}

const shellWord = (spec) => (spec.includes('*') ? `'${spec}'` : spec);

/**
 * The tracked paths grouped by the runtime path they sit in: `{ groups: [{ spec, count, note }], elsewhere }`, in table
 * order. `elsewhere` counts what git listed for the pathspecs but no group claims - never swallowed. No file name in it.
 */
function groupTracked(files) {
  const matchers = RUNTIME_RULES.map((r) => specMatcher(r.spec));
  const counts = new Array(RUNTIME_RULES.length).fill(0);
  let elsewhere = 0;
  // The FIRST rule that claims a file gets it: a lock file that two rules name is counted once.
  for (const f of files) {
    const i = matchers.findIndex((m) => m(f));
    if (i < 0) elsewhere += 1; else counts[i] += 1;
  }
  const groups = RUNTIME_RULES.map((r, i) => ({ spec: r.spec, count: counts[i], note: r.trackedNote ?? null })).filter((g) => g.count > 0);
  return { groups, elsewhere };
}

/** "9 in .pipeline, 2 in .mem/locks": the count and the runtime path, nothing taken from the index. */
export function describeTracked(files) {
  const { groups, elsewhere } = groupTracked(files);
  const lead = groups.slice(0, 6).map((g) => `${g.count} in ${g.spec}`).join(', ');
  const more = groups.length > 6 ? `+${groups.length - 6} more places` : '';
  return [lead, more, elsewhere ? `+${elsewhere} elsewhere` : ''].filter(Boolean).join(', ');
}

/**
 * The repair for exactly the places that have tracked files: `git rm --cached -r .pipeline` when it is only that one.
 * Files no group claims make it name every runtime path with `--ignore-unmatch` (git's own matcher then decides).
 */
export function untrackCommand(files) {
  const { groups, elsewhere } = groupTracked(files);
  if (elsewhere) return `git rm --cached -r --ignore-unmatch ${RUNTIME_DIRS.map(shellWord).join(' ')}`;
  return `git rm --cached -r ${(groups.length ? groups.map((g) => g.spec) : ['.pipeline']).map(shellWord).join(' ')}`;
}

/** The sentence about the shell, when the command has a quoted word: bash and PowerShell take single quotes, cmd.exe does not. */
export function shellHint(command) {
  return command.includes("'") ? 'The command is for bash or PowerShell (cmd.exe does not take single quotes).' : '';
}

/** The extra sentences for tracked paths that are worse than a dirty tree (a secret now in the history); empty when none. */
export function trackedNotes(files) {
  return groupTracked(files).groups.filter((g) => g.note).map((g) => g.note);
}

/**
 * @returns {string[]|null} the tracked-but-ignored paths under the runtime paths (forward slashes);
 *   `null` when git cannot answer. Callers count them and group them; they never print one.
 */
export function trackedRuntimeFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-ci', '--exclude-standard', '-z', '--', ...RUNTIME_DIRS], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout).split('\0').filter(Boolean);
}
