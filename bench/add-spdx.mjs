#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT

/**
 * add-spdx.mjs — idempotent SPDX header injector.
 *
 * Adds SPDX copyright and license headers to all source files in:
 * - bin/
 * - src/
 * - install/
 * - hooks/
 * - bench/ (except bench/readme-numbers.mjs)
 *
 * Headers are placed after a shebang if one exists, using the
 * appropriate comment syntax for the file type:
 * - // for .mjs and .js files
 * - # for .sh and .ps1 files
 *
 * This script is idempotent — running it multiple times produces
 * the same result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

// Directories to process
const DIRS = ['bin', 'src', 'install', 'hooks', 'bench'];

// Files to explicitly skip (from bench)
const SKIP_FILES = new Set(['readme-numbers.mjs']);

// File extensions to process
const EXTENSIONS = ['.mjs', '.js', '.sh', '.ps1'];

/**
 * Determine the comment style for a file based on its extension.
 */
function getCommentStyle(filename) {
  if (filename.endsWith('.mjs') || filename.endsWith('.js')) {
    return '//';
  }
  if (filename.endsWith('.sh') || filename.endsWith('.ps1')) {
    return '#';
  }
  return null;
}

/**
 * Check if a file already has the SPDX headers.
 */
function hasSpdxHeaders(content, commentStyle) {
  const copyright = `${commentStyle} SPDX-FileCopyrightText: 2026 Lucky H.`;
  const license = `${commentStyle} SPDX-License-Identifier: MIT`;
  return content.includes(copyright) && content.includes(license);
}

/**
 * Add SPDX headers to file content.
 * Returns the modified content, or null if no modification needed.
 */
function addSpdxHeaders(content, commentStyle) {
  if (hasSpdxHeaders(content, commentStyle)) {
    return null; // Already has headers
  }

  const lines = content.split('\n');
  let insertIdx = 0;

  // Skip shebang line if present
  if (lines[0]?.startsWith('#!')) {
    insertIdx = 1;
  }

  const spdxLines = [
    `${commentStyle} SPDX-FileCopyrightText: 2026 Lucky H.`,
    `${commentStyle} SPDX-License-Identifier: MIT`,
  ];

  // Insert SPDX headers
  lines.splice(insertIdx, 0, ...spdxLines);

  return lines.join('\n');
}

/**
 * Process a single file.
 */
function processFile(filepath) {
  const filename = path.basename(filepath);

  // Check if file should be skipped
  if (SKIP_FILES.has(filename)) {
    return { processed: false, reason: 'explicitly skipped' };
  }

  const commentStyle = getCommentStyle(filename);
  if (!commentStyle) {
    return { processed: false, reason: 'unknown extension' };
  }

  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const modified = addSpdxHeaders(content, commentStyle);

    if (modified === null) {
      return { processed: false, reason: 'already has headers' };
    }

    fs.writeFileSync(filepath, modified, 'utf8');
    return { processed: true, reason: 'headers added' };
  } catch (err) {
    return { processed: false, reason: `error: ${err.message}` };
  }
}

/**
 * Find all source files in the given directories.
 */
function findSourceFiles(baseDir) {
  const files = [];

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
        if (EXTENSIONS.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  for (const dir of DIRS) {
    walk(path.join(baseDir, dir));
  }

  return files.sort();
}

/**
 * Main entry point.
 */
function main() {
  const files = findSourceFiles(REPO);

  let processed = 0;
  let skipped = 0;
  let modified = 0;

  console.log(`Processing ${files.length} source files...`);

  for (const filepath of files) {
    const result = processFile(filepath);
    const relPath = path.relative(REPO, filepath);

    if (result.processed) {
      modified++;
      processed++;
      console.log(`✓ ${relPath}`);
    } else {
      skipped++;
      // Uncomment for verbose output:
      // console.log(`- ${relPath} (${result.reason})`);
    }
  }

  console.log(
    `\nDone: ${modified} modified, ${skipped} skipped, ${files.length} total`
  );

  if (modified > 0) {
    process.exit(0);
  }
}

main();
