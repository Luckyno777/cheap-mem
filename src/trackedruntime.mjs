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

/**
 * Every path under `.pipeline/` and `.mem/` that is runtime state of ONE clone and nothing else, with the gitignore rule
 * `mem init` writes for it, the pathspec git is asked with (and `git rm --cached` is told), a concrete path the doctor
 * asks `check-ignore` about, and why. Evidence is the code that writes it (the comment names the sibling in `.gitignore`
 * or the module). test/pipeline-ignore.test.mjs holds this table, the rules `mem init` writes and the register of the
 * per-session folders together.
 *
 * Deliberately NOT here (owner's data or an open question, see the CHANGELOG): `.mem/config.json`, `.mem/thesaurus.json`,
 * `.mem/answer-patterns.json`, `.mem/langbridge/` (authored settings), `.mem/rewrites.jsonl` (an append-only table),
 * `.mem/bridge-reports.jsonl`, `.mem/raw-exclusion-state.json`, `.mem/keyring.json` (the shred keys: a committed key
 * survives in history and defeats the shredding - the owner decides), `raw/` and the ledgers (tracked on purpose).
 */
// The wildcard is built from parts: a slash and a star side by side inside a string open a block comment for the source scanners
// of the guards (test/english-only.test.mjs and its kin), which then read code as comment text to the end of the file.
const STAR = '*';
export const RUNTIME_RULES = Object.freeze([
  // The WHOLE folder (2026-10-14), not file by file. `.pipeline/` is runtime state of ONE clone: the injection journal, the
  // clone-gate verdict, the recall server's socket and key, the command-guard booklet, the cost journal, the shrink
  // baseline. Each appeared there by a different feature, and only the observation ledger had a line - so `git add -A`
  // (mem-reflect, mem-handle-post) tracked the others, every hook write made the tree dirty and blocked the recall hook's
  // pull, and two clones met in add/add conflicts on files that describe one machine each.
  { rule: '.pipeline/', spec: '.pipeline', probe: '.pipeline/injections.jsonl', why: 'runtime state of ONE clone (journals, verdict caches, server key, baselines): never travels' },
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

/** A pathspec as a regular expression over the whole path: `*` crosses `/`, a plain spec matches itself and what is under it. */
function specMatcher(spec) {
  if (!spec.includes('*')) return (f) => f === spec || f.startsWith(`${spec}/`);
  const re = new RegExp(`^${spec.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (f) => re.test(f);
}

const shellWord = (spec) => (spec.includes('*') ? `'${spec}'` : spec);

/** The tracked paths grouped by the runtime path they sit in: `[{ spec, count }]`, in table order. Never a file name. */
function groupTracked(files) {
  return RUNTIME_RULES.map((r) => ({ spec: r.spec, count: files.filter(specMatcher(r.spec)).length })).filter((g) => g.count > 0);
}

/** "9 in .pipeline, 2 in .mem/locks": the count and the runtime path, nothing taken from the index. */
export function describeTracked(files) {
  const groups = groupTracked(files);
  const lead = groups.slice(0, 6).map((g) => `${g.count} in ${g.spec}`).join(', ');
  return groups.length > 6 ? `${lead}, +${groups.length - 6} more places` : lead;
}

/** The repair for exactly the places that have tracked files: `git rm --cached -r .pipeline` when it is only that one. */
export function untrackCommand(files) {
  const groups = groupTracked(files);
  return `git rm --cached -r ${(groups.length ? groups.map((g) => g.spec) : ['.pipeline']).map(shellWord).join(' ')}`;
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
