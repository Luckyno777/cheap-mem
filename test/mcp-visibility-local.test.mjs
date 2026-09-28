// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/mcp-visibility-local.test.mjs — the MCP visibility journal is
// machine-local and git-ignored.
//
// Ported reasoning from the sibling house (lucky-mem, dash-fix3,
// 2026-09-28): a versioned log under this exact shape left real lines
// in the repo after a full test run against the working tree. This
// house's `.pipeline/` is already the gitignored, per-clone runtime
// state directory (see .gitignore) — src/mcpvisibility.mjs puts its
// log there for the same reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mcpvisibility from '../src/mcpvisibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = (rel) => {
  try { execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT }); return true; }
  catch { return false; }
};

test('the visibility journal sits in a git-ignored path', () => {
  assert.equal(ignored(mcpvisibility.LOG), true, `${mcpvisibility.LOG} is not ignored`);
});

test('POSITIVE CONTROL: the probe correctly reports a versioned path as NOT ignored', () => {
  assert.equal(ignored('src/mcpvisibility.mjs'), false);
});
