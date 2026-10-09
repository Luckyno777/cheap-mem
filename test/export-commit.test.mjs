// test/export-commit.test.mjs - the helper the red proofs use to put a FIXED old
// commit on disk without `tar` (see test/helpers/export-commit.mjs for why).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'b2b5db1b1af138a53ee426b4fce2fdf597b34b6d';

test('every file of a directory and a single file comes out byte for byte as git stores it', (t) => {
  const dest = tempDir('cm-export-', t);
  const names = exportCommit(REPO, BASE, ['src/config.mjs', 'shared', 'package.json'], dest);
  assert.ok(names.includes('package.json') && names.includes('src/config.mjs'), names.join(' '));
  assert.ok(names.some((n) => n.startsWith('shared/')), 'the directory is walked');
  assert.deepEqual(names, [...names].sort());
  for (const n of names) {
    const want = execFileSync('git', ['show', `${BASE}:${n}`], { cwd: REPO, maxBuffer: 1 << 28 });
    const got = fs.readFileSync(path.join(dest, ...n.split('/')));
    assert.ok(want.equals(got), `${n} differs`);
  }
  assert.ok(!fs.existsSync(path.join(dest, 'bin')), 'nothing that was not asked for');
});

test('a binary file survives (no text decoding on the way)', (t) => {
  const dest = tempDir('cm-export-bin-', t);
  const bins = execFileSync('git', ['ls-tree', '-r', '--name-only', BASE], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter((n) => /\.(png|ico|gif|jpg|woff2?)$/.test(n));
  if (bins.length === 0) { t.diagnostic('NOTICE: no binary file in the tree at BASE, nothing to compare'); return; }
  exportCommit(REPO, BASE, [bins[0]], dest);
  const want = execFileSync('git', ['show', `${BASE}:${bins[0]}`], { cwd: REPO, maxBuffer: 1 << 28 });
  assert.ok(want.equals(fs.readFileSync(path.join(dest, ...bins[0].split('/')))));
});

test('a missing commit or a path that matches nothing throws, never writes silently nothing', (t) => {
  const dest = tempDir('cm-export-miss-', t);
  assert.throws(() => exportCommit(REPO, '0'.repeat(40), ['src'], dest));
  assert.throws(() => exportCommit(REPO, BASE, ['no-such-dir-xyz'], dest), /no files/);
});
