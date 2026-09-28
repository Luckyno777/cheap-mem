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
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  return dir;
}
