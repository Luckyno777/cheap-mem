#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Parity counter (mem-admin_02 L5) — thin CLI.
 *
 * **Moved to `src/parity.mjs` (agent/parity-to-src, 2026-09-29).** The
 * core (cutoff, trailer shape, classification, W9 debt) now lives
 * there, because `src/doctor.mjs` needs `debtList` for `mem doctor` and
 * `src/` must never import from `bench/` — `bench/` ships in no
 * published package (`test/package-contents.test.mjs`), and importing
 * it from `src/` crashed an installed `mem doctor` with
 * `ERR_MODULE_NOT_FOUND`. This file is now only the command line:
 * argument handling, printing, and re-exporting the same names so
 * nothing that already imports `bench/parity.mjs` (tests included) has
 * to change.
 *
 * Usage:
 *   node bench/parity.mjs                  # count from the cutoff
 *   node bench/parity.mjs --cutoff <hash>   # a different cutoff (tests)
 *   node bench/parity.mjs --debt            # W9 parity debt list
 */
export {
  DEFAULT_ROOT,
  CUTOFF,
  EXEMPT,
  TRAILER_PATTERN,
  ADDENDUM_PATTERN,
  addenda,
  cutoffMeasurable,
  commitsSince,
  TOUCHES_CODE,
  needsLine,
  hasLine,
  coveredByMerge,
  resolveValue,
  evaluate,
  openItems,
  DONE_PATTERN,
  readDoneLines,
  W9_BASELINE,
  debtList,
} from '../src/parity.mjs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT, CUTOFF, evaluate, debtList, W9_BASELINE } from '../src/parity.mjs';

function debtMain(cutoff) {
  const r = debtList(DEFAULT_ROOT, cutoff);
  if (!r.measurable) {
    console.log(`Parity debt: ${r.reason}`);
    return;
  }
  if (!r.items.length) {
    console.log('Parity debt: 0 open items');
    return;
  }
  const newCount = r.items.filter((it) => !it.legacy).length;
  const legacyCount = r.items.length - newCount;
  console.log(`Parity debt: ${r.items.length} open items (${newCount} new, `
    + `${legacyCount} legacy before ${W9_BASELINE.slice(0, 10)}; oldest first)`);
  for (const it of r.items) {
    console.log(`  ${it.cm_hash.slice(0, 12)} (${it.ageDays}d${it.legacy ? ', legacy' : ''}) ${it.subject}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--cutoff');
  const cutoff = i === -1 ? CUTOFF : argv[i + 1];
  if (argv.includes('--debt')) {
    debtMain(cutoff);
    return;
  }
  const r = evaluate(DEFAULT_ROOT, cutoff);
  if (!r.measurable) {
    console.log(`Parity: not measurable (${r.reason})`);
    return;
  }
  console.log(`Parity since ${cutoff.slice(0, 12)}: ${r.codeCommits} code commits (src/ or bin/)`);
  console.log(`  yes:  ${r.counts.yes}`);
  console.log(`  no:   ${r.counts.no}`);
  console.log(`  open: ${r.counts.open}`);
  console.log(`  missing the line: ${r.violations.length}`);
  for (const v of r.violations) console.log(`    ${v.hash} ${v.subject}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
