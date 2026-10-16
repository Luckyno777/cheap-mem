// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// `npm test` is `node --test` with no file list, and node's default patterns take EVERY .mjs under test/ - helpers,
// fixtures and child scripts too, not only *.test.mjs. The local chain runs the *.test.mjs list, so a helper that exits
// non-zero when run with no arguments stayed green there and turned CI red on all six test jobs (run 1060:
// test/helpers/linear-probes.mjs, `no such probe: undefined`, exit 2). This runs the rest of what CI runs, the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TEST_DIR);
// A `node --test` started from inside a test inherits NODE_TEST_CONTEXT and then reports to the outer runner instead of
// through its own exit code - green on a red file. Without it, the inner run is the one `npm test` starts.
const OWN_RUN = (() => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; })();

/** Every .mjs under test/ that is not a *.test.mjs, as "/"-separated paths relative to the repository root. */
function plainFiles(dir = TEST_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...plainFiles(full));
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

test('every non-test .mjs under test/ stays green when node --test runs it the way npm test does', () => {
  const files = plainFiles();
  assert.ok(files.includes('test/helpers/linear-probes.mjs'), 'the search is blind: the helper of run 1060 is not found');
  assert.ok(files.length >= 20, `the search is blind: only ${files.length} files`);
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, env: OWN_RUN, encoding: 'utf8', timeout: 300_000 });
  const red = (r.stdout ?? '').split('\n').filter((line) => /^not ok \d+ - /.test(line));
  assert.equal(r.status, 0, `node --test is red on files CI runs and the chain does not:\n${red.join('\n')}`);
});

test('positive control: a helper that exits non-zero with no arguments is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-plain-probe-'));
  try {
    const file = path.join(dir, 'bad-helper.mjs');
    fs.writeFileSync(file, "if (!process.argv[2]) { console.error('no such probe'); process.exit(2); }\n");
    const r = spawnSync(process.execPath, ['--test', file], { cwd: ROOT, env: OWN_RUN, encoding: 'utf8', timeout: 60_000 });
    assert.notEqual(r.status, 0, 'node --test did not report the failing helper');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
