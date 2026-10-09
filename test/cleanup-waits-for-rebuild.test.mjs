// test/cleanup-waits-for-rebuild.test.mjs - a test that starts the pre-edit hook (or the background
// rebuild) must not remove its temp tree with a bare fs.rmSync.
//
// Why: `mem-before-edit` / `component --hook` leave a detached rebuild child whose cwd is the memory
// root. On Windows that child holds the directory open and rmdir fails with EBUSY after every
// assertion was green (CI runs 37720774312 and 37860352636: cm-be-file-*, cm-p13-*, cm-hooklock-*).
// test/fixture/cleanup.mjs `removeTree` waits for the rebuild lock to go first. This guard fails for a
// test file that mentions a hook/rebuild starter and still calls fs.rmSync(..., { recursive }) on
// code lines, unless the line is preceded by waitForRebuildIdle or carries `// cleanup-ok: <reason>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STARTERS = /mem-before-edit|triggerBackgroundRebuild|'--hook'|component --hook/;

/** The lines of `text` that remove a tree bare although the file starts hooks/rebuilds. */
function bareRemovals(text) {
  if (!STARTERS.test(text)) return [];
  const lines = text.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    // code lines only: a call that starts after a quote is part of a string (a probe's source text)
    if (!/^[^'"`]*\bfs\.rmSync\(/.test(l) || !/recursive/.test(l)) return;
    if (/cleanup-ok:/.test(l) || /cleanup-ok:/.test(lines[i - 1] ?? '')) return;
    if (lines.slice(Math.max(0, i - 3), i).some((p) => /waitForRebuildIdle\(/.test(p))) return;
    out.push(`${i + 1}: ${l.trim()}`);
  });
  return out;
}

test('no test file that starts hooks or the rebuild removes its tree with a bare fs.rmSync', () => {
  const bad = [];
  for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith('.test.mjs') && n !== 'cleanup-waits-for-rebuild.test.mjs')) {
    const r = bareRemovals(fs.readFileSync(path.join(HERE, f), 'utf8'));
    if (r.length) bad.push(`${f}\n  ${r.join('\n  ')}`);
  }
  assert.deepEqual(bad, [], 'use removeTree() from ./fixture/cleanup.mjs (it waits for the background rebuild first)');
});

test('POSITIVE: the guard sees a bare removal, and accepts the helper, a preceding wait and a marked line', () => {
  const hook = "spawnSync('bash', ['bin/mem-before-edit']);\n";
  assert.equal(bareRemovals(`${hook}fs.rmSync(root, { recursive: true, force: true });`).length, 1);
  assert.equal(bareRemovals(`${hook}removeTree(root);`).length, 0);
  assert.equal(bareRemovals(`${hook}waitForRebuildIdle(root);\nfs.rmSync(root, { recursive: true, force: true });`).length, 0);
  assert.equal(bareRemovals(`${hook}// cleanup-ok: no hook ran in this tree\nfs.rmSync(root, { recursive: true });`).length, 0);
  assert.equal(bareRemovals("const probe = 'fs.rmSync(dir, { recursive: true });';\n" + hook).length, 0, 'inside a string');
  assert.equal(bareRemovals('fs.rmSync(root, { recursive: true });').length, 0, 'a file that starts no hook is not this guard\'s business');
});
