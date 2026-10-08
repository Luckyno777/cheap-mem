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
      // 37720774312: cm-be-file-*, cm-component-table-*). Wait for its lock to go, bounded.
      try {
        const ct = await import(new URL('../src/component-table.mjs', import.meta.url).href);
        ct.waitForRebuildIdle(dir);
      } catch { /* no table module, no lock: nothing to wait for */ }
      // Windows: a just-exited child can still hold the directory for a moment (EBUSY/EPERM on rmdir).
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
  }
  return dir;
}
