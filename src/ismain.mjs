// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Was this module started as the program (`node file.mjs`), as opposed to
 * imported?
 *
 * `process.argv[1]` is the path as TYPED (made absolute, symlinks kept);
 * `import.meta.url` is the REAL path. The old test
 * `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` is therefore
 * false whenever any directory above the file is a symlink - and on macOS
 * that is every temp dir: `/var/folders/...` is `/private/var/folders/...`.
 * The program then did nothing, silently, exit 0: the recall hook printed
 * not one byte on macOS CI. Both sides are resolved to real paths here.
 *
 * @param {string} metaUrl  the caller's `import.meta.url`
 * @param {string|undefined} [argv1]  defaults to `process.argv[1]`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return real(path.resolve(argv1)) === real(fileURLToPath(metaUrl));
}
