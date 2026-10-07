// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * run-tests.mjs - run every test/*.test.mjs, on every OS and Node version.
 *
 * Usage: node bench/run-tests.mjs [extra node --test flags]
 * Exit code: the exit code of `node --test`.
 *
 * Why this exists. A bare `node --test` runs EVERY .mjs under test/,
 * fixtures and child-process helpers included (test/fixture/*.mjs,
 * test/search-slim-child.mjs): files that are not tests, need arguments
 * and exit non-zero without them, so the suite went red on all six CI
 * cells for files nobody meant to run on their own. The glob form
 * `node --test test/*.test.mjs` is right on Linux and macOS, but
 * PowerShell/cmd do not expand globs and Node 20 does not either. This
 * script expands the list itself and hands node explicit files, so the
 * same command works everywhere. Nothing is skipped: every *.test.mjs in
 * test/ is passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'test');
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join('test', f));

if (files.length === 0) {
  console.error('run-tests: no test/*.test.mjs found - refusing to pass with nothing run');
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (r.error) {
  console.error(`run-tests: could not start node --test: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
