#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// append-only check of the pre-commit hook (AU11). The rule, the file list and the
// approval variable live in src/appendonly.mjs; this is only the hook's shell
// around them. Run from inside the memory (the hook's working directory).
//
// Output: one line per finding on stdout, exit 1. Nothing found: silent, exit 0.
// With CHEAP_MEM_JSONL_APPROVAL set (non-blank): findings go to stderr, exit 0.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { stagedViolations, APPROVAL_ENV } = await import(pathToFileURL(path.join(here, '..', 'src', 'appendonly.mjs')).href);

const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const found = stagedViolations(top);
if (found.length === 0) process.exit(0);

const text = found.map((f) => {
  if (f.kind === 'deleted') return `${f.rel}: file deleted (HEAD had ${f.committedLines} lines)`;
  if (f.kind === 'changed') return `${f.rel}: a committed line was changed or removed (first difference at line ${f.line}, HEAD has ${f.committedLines} lines)`;
  return `${f.rel}: cannot be checked (git did not hand over a version)`;
});

const approval = (process.env[APPROVAL_ENV] ?? '').trim();
if (approval) {
  process.stderr.write(`pre-commit: append-only deliberately broken, approval: ${approval.slice(0, 200)}\n`);
  for (const t of text) process.stderr.write(`  ${t}\n`);
  process.exit(0);
}
process.stdout.write(`${text.join('\n')}\n`);
process.exit(1);
