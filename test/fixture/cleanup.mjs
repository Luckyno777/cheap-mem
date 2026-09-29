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

export function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    process.once('exit', () => {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* see above */ }
    });
  }
}
