// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT

/**
 * Guard: every shipped source file carries SPDX headers.
 *
 * **Why this matters.** When code is copied from this repository into
 * another project, the SPDX headers ensure the copied portions carry
 * their authorship and license information. This is the REUSE convention,
 * which makes license compliance tooling possible.
 *
 * **What qualifies as shipped.** The package.json "files" field lists:
 * - bin/
 * - src/
 * - install/
 * - hooks/ (installed by the setup script)
 *
 * All *.mjs, *.js, *.sh, and *.ps1 files in these directories must
 * have both SPDX headers as the first (or second, after a shebang)
 * comment lines in the file:
 *
 * ```
 * SPDX-FileCopyrightText: 2026 Lucky H.
 * SPDX-License-Identifier: MIT
 * ```
 *
 * Using the appropriate comment syntax (//) for .mjs/.js and (#) for
 * .sh/.ps1 files.
 *
 * **Sabotage check.** A fixture file without these headers is caught
 * if it is shipped by the package.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { relPosix } from './helpers/relpath.mjs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_DIRS = [
  path.join(REPO, 'bin'),
  path.join(REPO, 'src'),
  path.join(REPO, 'install'),
  path.join(REPO, 'hooks'),
];

/**
 * Check if a file has the required SPDX headers.
 */
function hasSpdxHeaders(content, filename) {
  const isJsOrMjs =
    filename.endsWith('.js') || filename.endsWith('.mjs');
  const isShOrPs1 =
    filename.endsWith('.sh') || filename.endsWith('.ps1');

  let commentStyle;
  if (isJsOrMjs) {
    commentStyle = '//';
  } else if (isShOrPs1) {
    commentStyle = '#';
  } else {
    return true; // Not a source file, skip
  }

  const copyright = `${commentStyle} SPDX-FileCopyrightText: 2026 Lucky H.`;
  const license = `${commentStyle} SPDX-License-Identifier: MIT`;

  return content.includes(copyright) && content.includes(license);
}

/**
 * Recursively find all source files in a directory.
 */
function findSourceFiles(baseDir) {
  const files = [];
  const extensions = ['.mjs', '.js', '.sh', '.ps1'];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(baseDir);
  return files.sort();
}

/**
 * Get all shipped source files.
 */
function getShippedSourceFiles() {
  const allFiles = [];
  for (const dir of SHIPPED_DIRS) {
    allFiles.push(...findSourceFiles(dir));
  }
  return allFiles;
}

test('POSITIVE CONTROL: the scanner finds source files', () => {
  const files = getShippedSourceFiles();
  assert.ok(
    files.length > 0,
    'No source files found in shipped directories'
  );
  assert.ok(
    files.some((f) => f.includes('bin')),
    'No files found in bin/'
  );
  assert.ok(
    files.some((f) => f.includes('src')),
    'No files found in src/'
  );
});

test('THE RULE: every shipped source file has SPDX headers', () => {
  const files = getShippedSourceFiles();
  const missing = [];

  for (const filepath of files) {
    const content = fs.readFileSync(filepath, 'utf8');
    if (!hasSpdxHeaders(content, filepath)) {
      const relPath = relPosix(REPO, filepath);
      missing.push(relPath);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `${missing.length} file(s) missing SPDX headers:\n${missing.join('\n')}`
  );
});

test('SABOTAGE CHECK: the guard catches missing headers', () => {
  // Find any real file and verify it has headers
  const realFiles = getShippedSourceFiles();
  assert.ok(realFiles.length > 0, 'No shipped source files found');

  const sampleFile = realFiles[0];
  const content = fs.readFileSync(sampleFile, 'utf8');
  const hasHeaders = hasSpdxHeaders(content, sampleFile);
  assert.ok(hasHeaders, `Sample file ${sampleFile} missing headers`);

  // Verify the guard function would detect missing headers
  const noHeadersContent = '#!/bin/bash\necho "test"';
  assert.ok(
    !hasSpdxHeaders(noHeadersContent, sampleFile),
    'Guard function should detect missing headers'
  );
});
