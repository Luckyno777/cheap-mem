// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Removing a test's temp directory. A hook or background builder a test
// spawned may still be writing into it for a moment — under a full suite
// long enough for a plain rmSync to throw ENOTEMPTY after every assertion
// was already green (test/multiagent-batch3.test.mjs, 2026-09-29). A
// cleanup failure is not a finding about what the test checks: retry,
// and if that still fails, try again when the process exits instead of
// turning the run red. Same rule as lucky-mem's test/fixture/tempwurzel.mjs.
import fs from 'node:fs';
import { waitForRebuildIdle } from '../../src/component-table.mjs';
import { waitForBuildIdle } from '../../src/timetrack.mjs';

/**
 * Remove a test's temp tree. FIRST wait (event-based: the rebuild lock file goes away, then a
 * short grace for the process to exit) for the detached background rebuild that `mem-before-edit`
 * / `component --hook` starts with this tree as its cwd: on Windows that child holds the directory
 * open and rmdir fails with EBUSY (CI run 37860352636: cm-p13-*, cm-hooklock-*). The retries below
 * stay as a belt, not a substitute. test/cleanup-waits-for-rebuild.test.mjs keeps tests that start
 * hooks from calling a bare fs.rmSync on their tree.
 */
export function removeTree(dir) {
  waitForRebuildIdle(dir);
  waitForBuildIdle(dir); // the detached time-track build of a window question (src/timetrack.mjs)
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    process.once('exit', () => {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* see above */ }
    });
  }
}
