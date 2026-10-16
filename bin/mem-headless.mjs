#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * mem-headless.mjs - how an unattended job starts `claude -p` (the one starter, for sh and ps1).
 *
 *   node bin/mem-headless.mjs plan --cmd "<configured command>" --root <memory> [--no-add-dir]
 *       prints  isolated=0|1, cwd=<neutral dir>, arg=<flag or value> (one per line); exit 2 = do not start
 *   node bin/mem-headless.mjs old-claude <file>
 *       exit 0 + message when <file> shows a claude that does not know --setting-sources
 *
 * The digest, the mail handler and the reflector (bin/mem-digest, bin/mem-handle-post,
 * bin/mem-reflect and their .ps1 twins) call this instead of each building flags. Why, and what it
 * does and does not cover: src/headless.mjs and docs/security-model.md.
 */
import { main, isMain } from '../src/headless.mjs';

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
