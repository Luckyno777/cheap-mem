// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/no-top-level-await-after-test.test.mjs - no test file has a top-level `await` after its
// first test()/describe().
//
// Why: an expensive start on the module's top level (a browser, a server) between the tests runs
// when the file is LOADED. If it throws under load, the whole file fails with the anonymous
// "test failed" - no probe names what broke, and the independent tests of the file go red with
// it (lucky-mem, CI 2026-10-09, test/volltext.test.mjs). The start belongs in a named probe, in
// before()/after(), or behind a lazy factory (`lazyBrowser()` in test/fixture/browser.mjs).
//
// Red proof: the fixed commit cb49135d (cheap-mem main before this change) has eight such files;
// the guard is red on its test/ tree and green on the current one. Sabotage and positive control
// run on dummy sources and on dummy files in a temp directory.
//
// Exceptions: only in KNOWN_LATE_AWAIT, each with a reason, and the list only SHRINKS: an entry
// whose file no longer has the pattern (or no longer exists) makes the guard red until it is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findLateTopLevelAwait, loadAcorn } from './helpers/late-top-level-await.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { relPosix } from './helpers/relpath.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// A FIXED commit, never merge-base: the stand before the rebuild of the eight files.
const OLD_STAND = 'cb49135d7a292dadc7d389aa751f62e92fec30be';

/**
 * Files allowed to keep a late top-level await: { 'test/x.test.mjs': 'why' }. Empty on purpose,
 * and it only shrinks - never add a line here, move the start into a probe or a lazy factory.
 */
const KNOWN_LATE_AWAIT = {};

/** Every *.test.mjs under `dir`, relative to `base`, with "/" separators. */
function testFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : testFiles(full, base);
    return e.name.endsWith('.test.mjs') ? [relPosix(base, full)] : [];
  });
}

/** { file: [{line, text}] } for the files under `dir` that have a late top-level await. */
function lateAwaits(dir) {
  const acorn = loadAcorn();
  const out = {};
  for (const f of testFiles(dir)) {
    const hits = findLateTopLevelAwait(fs.readFileSync(path.join(dir, f), 'utf8'), acorn);
    if (hits.length) out[f] = hits;
  }
  return out;
}

const fmt = (found) => Object.entries(found).map(([f, h]) => `${f}: line ${h.map((x) => x.line).join(', ')}`).join('\n');

test('the real test files have no top-level await after the first test (exceptions only with a reason, list only shrinks)', () => {
  const found = lateAwaits(HERE);
  const prefixed = Object.fromEntries(Object.entries(found).map(([f, h]) => [`test/${f}`, h]));
  const unexplained = Object.keys(prefixed).filter((f) => !(f in KNOWN_LATE_AWAIT));
  assert.deepEqual(unexplained, [],
    `top-level await after the first test() - move the start into a named probe, before()/after() or lazyBrowser():\n${fmt(prefixed)}`);
  for (const [f, why] of Object.entries(KNOWN_LATE_AWAIT)) {
    assert.ok(why && why.length > 10, `${f}: an exception needs a reason`);
    assert.ok(fs.existsSync(path.join(REPO, f)), `${f}: listed but gone - remove the line (the list only shrinks)`);
    assert.ok(f in prefixed, `${f}: listed but clean now - remove the line (the list only shrinks)`);
  }
});

test('SABOTAGE: a dummy with a top-level await after the first test is caught (every shape)', () => {
  const acorn = loadAcorn();
  const shapes = {
    'await after test()': "import test from 'node:test';\ntest('a', () => {});\nconst x = await start();\n",
    'await after describe()': "import { describe, it } from 'node:test';\ndescribe('s', () => { it('a', () => {}); });\nawait start();\n",
    'for await': "import test from 'node:test';\ntest('a', () => {});\nfor await (const c of stream()) { void c; }\n",
    'destructured start': "import test from 'node:test';\ntest('a', () => {});\nconst { browser, reason } = await startBrowser();\ntest('b', { skip: reason }, () => {});\n",
    'aliased import': "import t from 'node:test';\nt('a', () => {});\nawait start();\n",
    'test.skip first': "import test from 'node:test';\ntest.skip('a', () => {});\nawait start();\n",
    'await inside an if after the test': "import test from 'node:test';\ntest('a', () => {});\nif (process.env.X) { await start(); }\n",
    'await in a call argument': "import test from 'node:test';\ntest('a', () => {});\nuse(await start());\n",
  };
  for (const [name, src] of Object.entries(shapes)) {
    assert.equal(findLateTopLevelAwait(src, acorn).length, 1, `not caught: ${name}`);
  }
  // and through the directory scan, on a real file on disk
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tla-sabotage-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.test.mjs'), shapes['await after test()']);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'bad2.test.mjs'), shapes['for await']);
    assert.deepEqual(Object.keys(lateAwaits(dir)).sort(), ['bad.test.mjs', 'sub/bad2.test.mjs']);
  } finally { removeTree(dir); }
});

test('POSITIVE CONTROL: clean dummies are green - await before the first test, inside tests, in strings/comments/templates', () => {
  const acorn = loadAcorn();
  const clean = {
    'await BEFORE the first test': "import test from 'node:test';\nconst { a } = await load();\ntest('a', () => { void a; });\n",
    'await inside an async test body': "import test from 'node:test';\ntest('a', async () => { await start(); });\n",
    'await inside an expression-bodied async arrow': "import test from 'node:test';\ntest('a', async () => await start());\n",
    'await inside a helper function': "import test from 'node:test';\ntest('a', () => {});\nasync function helper() { return await start(); }\nexport { helper };\n",
    'await inside before()/after()': "import test, { before, after } from 'node:test';\ntest('a', () => {});\nbefore(async () => { await start(); });\nafter(async () => { await stop(); });\n",
    'the word in a comment': "import test from 'node:test';\ntest('a', () => {});\n// const x = await start();\n/* await start(); */\n",
    'the word in strings and templates': "import test from 'node:test';\ntest('a', () => {});\nconst s = 'await start()';\nconst t = `\nawait ${s}\n`;\nexport { t };\n",
    'no test at all': "const x = await start();\nexport { x };\n",
    'for await inside a function': "import test from 'node:test';\ntest('a', () => {});\nasync function f() { for await (const c of s()) { void c; } }\nexport { f };\n",
  };
  for (const [name, src] of Object.entries(clean)) {
    assert.deepEqual(findLateTopLevelAwait(src, acorn), [], `false alarm: ${name}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tla-clean-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.test.mjs'), clean['await inside before()/after()']);
    assert.deepEqual(lateAwaits(dir), {});
  } finally { removeTree(dir); }
});

test(`RED on the fixed old stand ${OLD_STAND.slice(0, 8)}: its test/ tree has the eight files, the current tree has none`, (t) => {
  try { execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${OLD_STAND}^{commit}`], { stdio: 'ignore' }); } catch {
    t.skip(`commit ${OLD_STAND} not reachable (shallow clone) - red proof unknown, not green`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tla-old-'));
  try {
    exportCommit(REPO, OLD_STAND, ['test'], dir);
    const old = Object.keys(lateAwaits(path.join(dir, 'test'))).sort();
    assert.deepEqual(old, [
      'board-parity-atlas-cm.test.mjs', 'core-name.test.mjs', 'entries-page.test.mjs', 'fulltext.test.mjs',
      'gold-verdict.test.mjs', 'palette-fulltext.test.mjs', 'render-load.test.mjs', 'x3b-status-display.test.mjs',
    ], 'RED: the old stand is caught in exactly these files');
    // the very same scan on the current tree
    assert.deepEqual(lateAwaits(HERE), {}, 'GREEN: the current tree is clean');
  } finally { removeTree(dir); }
});
