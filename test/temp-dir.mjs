/**
 * Temporary directory helper for test cleanup.
 *
 * Provides tempDir() for creating temp directories with automatic cleanup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a temporary directory with automatic cleanup.
 *
 * @param {string} prefix - Prefix for the temp directory name (e.g., 'cm-test-')
 * @param {object} t - Test context object that provides .after() hook
 * @returns {string} The path to the created temporary directory
 */
export function tempDir(prefix, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t && typeof t.after === 'function') {
    t.after(async () => {
      // `mem component --hook` (mem-before-edit) and triggerBackgroundRebuild() leave a detached
      // child whose cwd is this directory. On Windows rmdir then fails with EBUSY/ENOTEMPTY (CI run
      // 37720774312: cm-be-file-*, cm-component-table-*). removeTree waits for that rebuild AND for the
      // detached time-track build, then retries, and if the tree is still held it tries again when the
      // process exits instead of throwing (test/fixture/cleanup.mjs). A throw here was a red test over a
      // cleanup (CI run 1074, windows node 22: EBUSY after every assertion of before-edit-golden was green)
      // - and node:test runs no later `after` hook once one throws, so whatever the test registered after
      // its tempDir (stopping a service it started) was skipped as well.
      let removeTree = null;
      try { ({ removeTree } = await import(new URL('./fixture/cleanup.mjs', import.meta.url).href)); } catch { /* below */ }
      if (removeTree) { removeTree(dir); return; }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
  }
  return dir;
}
