// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Runtime files of `.pipeline/` and of the runtime folders under `.mem/` that a memory has ALREADY committed.
 *
 * A `.gitignore` rule does not untrack: a memory that committed `.pipeline/injections.jsonl` before the
 * rule existed keeps tracking it - the tree turns dirty at every hook write, the recall hook's pull stops, and
 * two clones meet in add/add conflicts. `git check-ignore --no-index` says "ignored" all the same (it ignores the
 * index on purpose), so the doctor's answer "git ignores all paths" was false good for exactly these memories.
 * This asks git for what is tracked AND ignored under those folders.
 */

import { spawnSync } from 'node:child_process';

/**
 * The folders that hold runtime state of ONE clone and nothing else, each one with a rule in the memory's `.gitignore`
 * (`writeMemoryGitignore`; test/pipeline-ignore.test.mjs holds the two lists together):
 *   .pipeline/                the injection journal, verdict caches, the recall server's socket and key, baselines
 *   .mem/before-edit/         per-session marks of the before-edit hook (JSON: the level and fingerprint last shown)
 *   .mem/workflow-marks/      per-session marks of the workflow hint (the same JSON)
 *   .mem/command-guard-marks/ per-session `<session>__<error id>.warned` files of the command guard (empty files: git tracks those)
 *   .mem/locks/               drawer lock files - owner pid, host and start time of THIS machine, only while held
 *   .mem/retrieve-turns/, .mem/catch-fail-turns/, .mem/after-failure-turns/
 *                             once-per-turn claims of three hooks, taken by `mkdir`, swept after 60 minutes (empty folders:
 *                             git does not see those today, the rule keeps it so)
 */
export const RUNTIME_DIRS = Object.freeze([
  '.pipeline', '.mem/before-edit', '.mem/workflow-marks', '.mem/command-guard-marks', '.mem/locks',
  '.mem/retrieve-turns', '.mem/catch-fail-turns', '.mem/after-failure-turns',
]);

/** The repair for exactly the folders that have tracked files: `git rm --cached -r .pipeline` when it is only that one. */
export function untrackCommand(files) {
  const dirs = RUNTIME_DIRS.filter((d) => files.some((f) => f.startsWith(`${d}/`)));
  return `git rm --cached -r ${(dirs.length ? dirs : ['.pipeline']).join(' ')}`;
}

/**
 * @returns {string[]|null} the tracked-but-ignored paths under the runtime folders (forward slashes);
 *   `null` when git cannot answer.
 */
export function trackedRuntimeFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-ci', '--exclude-standard', '-z', '--', ...RUNTIME_DIRS], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout).split('\0').filter(Boolean);
}
