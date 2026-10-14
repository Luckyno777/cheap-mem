// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Runtime files of `.pipeline/` that a memory has ALREADY committed.
 *
 * A `.gitignore` rule does not untrack: a memory that committed `.pipeline/injections.jsonl` before the
 * rule existed keeps tracking it - the tree turns dirty at every hook write, the recall hook's pull stops, and
 * two clones meet in add/add conflicts. `git check-ignore --no-index` says "ignored" all the same (it ignores the
 * index on purpose), so the doctor's answer "git ignores all paths" was false good for exactly these memories.
 * This asks git for what is tracked AND ignored under `.pipeline/`.
 */

import { spawnSync } from 'node:child_process';

/** The one command that repairs it (it removes the files from the index, not from the disk). */
export const UNTRACK_COMMAND = 'git rm --cached -r .pipeline';

/**
 * @returns {string[]|null} the tracked-but-ignored paths under `.pipeline/`; `null` when git cannot answer.
 */
export function trackedRuntimeFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-ci', '--exclude-standard', '-z', '--', '.pipeline'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout).split('\0').filter(Boolean);
}
