// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Test helper (not a test), preloaded with `node --import`: counts how many concurrent-append probe
// directories (`.append-atomicity-*`, made by `fs.mkdtempSync` under the memory root) the process
// starts, and writes the count to the file named by PROBE_SPY_LOG when it exits. A subprocess cannot
// be patched from the test, so the patch rides in with the process.
import fs from 'node:fs';
import path from 'node:path';

let started = 0;
const real = fs.mkdtempSync;
fs.mkdtempSync = function patched(prefix, ...rest) {
  if (typeof prefix === 'string' && path.basename(prefix).startsWith('.append-atomicity-')) started += 1;
  return real.call(this, prefix, ...rest);
};
process.on('exit', () => {
  if (process.env.PROBE_SPY_LOG) fs.writeFileSync(process.env.PROBE_SPY_LOG, String(started));
});
