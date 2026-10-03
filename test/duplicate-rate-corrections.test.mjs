// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/duplicate-rate.mjs: a correction line (replaces_id) and its original
// are history, not a duplicate; only the current version is counted
// (port of lucky-mem c7d1666d).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = path.join(REPO, 'bench', 'duplicate-rate.mjs');
const TEXT = 'The importer read the whole file at once and ran out of memory while parsing the archive';

function run(root, lines) {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, 'global', 'errors.jsonl'), lines.map((z) => JSON.stringify(z)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [BENCH, '--root', root], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', r.stderr);
  return r.stdout;
}

test('duplicate-rate: a correction and its original are not a pair', (t) => {
  const root = tempDir('cm-duprate-', t);
  const orig = { id: 'orig0001', ts: '2026-10-01T00:00:00Z', title: 'Import', text: TEXT };
  const corr = { id: 'corr0001', ts: '2026-10-02T00:00:00Z', title: 'Import', text: TEXT, replaces_id: 'orig0001' };
  const out = run(root, [orig, corr]);
  assert.match(out, /Nothing to measure|Suspicious pairs:\s+0\b/, out);
});

test('duplicate-rate: positive control, the same two lines without replaces_id are one pair', (t) => {
  const root = tempDir('cm-duprate-', t);
  const out = run(root, [
    { id: 'a0000001', ts: '2026-10-01T00:00:00Z', title: 'Import', text: TEXT },
    { id: 'b0000001', ts: '2026-10-02T00:00:00Z', title: 'Import', text: TEXT },
  ]);
  assert.match(out, /Suspicious pairs:\s+1\b/, out);
});
