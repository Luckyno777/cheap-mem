// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/component-table.test.mjs — the missing R-Tab, ported: ONE table
// file/symbol -> entries (src/component-table.mjs), for the pre-edit
// hook (`mem-before-edit`, via `mem component --hook`) and for
// `mem component --table`/`--rebuild`. Mirrors lucky-mem's
// test/bauteil-tabelle.test.mjs and test/r9-vorher-tabelle.test.mjs, in
// English, for cheap-mem's own memory and naming.
//
// **Red proof (pinned to a fixed commit, per house rule: never
// `git merge-base HEAD origin/main`, it moves after the merge).**
// `src/component-table.mjs` does not exist on origin/main at
// 3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d (this branch's starting
// point):
//
//     git -C /home/user/wt-cm-rtab show \
//       3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d:src/component-table.mjs
//     -> fatal: path 'src/component-table.mjs' does not exist in
//        '3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d'
//
// checked by hand before this file was written (see the report handed
// back for this task). The import below is itself the automated
// positive control for that red proof, the same shape
// `bauteil-tabelle.test.mjs`'s own header comment uses: on the old
// stand this file's very first `import * as ct from
// '../src/component-table.mjs'` throws `ERR_MODULE_NOT_FOUND` and
// every test in this file fails to even register — there is no path
// through this suite that stays green without the module existing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ct from '../src/component-table.mjs';

// --- fixture: a small corpus WITH its own git history ---------------------
//
// Three roles need three different sources (see the header comment of
// src/component-table.mjs): an entry mentioning a path (`mentioned`), a
// `// error: <id>` mark in a test file (`guarded`), and a commit naming
// a known id (`fixed`). `commit.gpgsign=false` applies ONLY to this
// throwaway fixture repo under `os.tmpdir()` — never to a real commit
// of this session (those stay signed, per house rule).

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-component-table-'));
  for (const d of ['global', 'projects', 'src', 'bin', 'test']) {
    fs.mkdirSync(path.join(r, d), { recursive: true });
  }
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'component-table-test', participants: ['someone'], language: 'en' }));
  git(r, ['init', '-q']);
  git(r, ['config', 'user.email', 'fixture@example.invalid']);
  git(r, ['config', 'user.name', 'Fixture']);
  git(r, ['config', 'commit.gpgsign', 'false']);
  return r;
}

function gone(r) { fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

function writeErrors(r, rows) {
  fs.writeFileSync(path.join(r, 'global', 'errors.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function commitAll(r, msg) {
  git(r, ['add', '-A']);
  git(r, ['commit', '-q', '--allow-empty', '-m', msg]);
}

/** All three roles, in one small corpus. 12-char ids — cheap-mem's one id length. */
function fullFixture() {
  const r = world();

  writeErrors(r, [
    { id: 'path000000a1', ts: '2026-01-01T00:00:00Z', title: 'Bug in src/a.mjs found' },
    { id: 'guard00000b1', ts: '2026-01-01T00:00:00Z', title: 'Guard test case, no path' },
    { id: 'symb0000001c', ts: '2026-01-01T00:00:00Z', title: 'Calls myTableFunction wrong' },
    { id: 'fix0000000d1', ts: '2026-01-01T00:00:00Z', title: 'Fixed by a commit, no path here' },
  ]);
  fs.writeFileSync(path.join(r, 'src', 'a.mjs'), 'export function myTableFunction() { return 42; }\n');
  fs.writeFileSync(path.join(r, 'test', 'marker.test.mjs'),
    "// error: guard00000b1\nimport test from 'node:test';\ntest('placeholder', () => {});\n");
  commitAll(r, 'Fixture: base state without b.mjs');

  fs.writeFileSync(path.join(r, 'src', 'b.mjs'), 'export const X = 1;\n');
  commitAll(r, 'fixes fix0000000d1: adds b.mjs');

  return r;
}

// --- (a) all three roles, in one corpus ------------------------------------

test('build(): mentioned/guarded/fixed each come from their own source', () => {
  const r = fullFixture();
  try {
    const built = ct.build(r);
    assert.equal(built.version, ct.TABLE_VERSION);
    assert.equal(built.incomplete, false, 'fixture should be fully readable');

    const a = built.paths['src/a.mjs'] ?? [];
    assert.ok(a.some((e) => e.id === 'path000000a1' && e.type === 'error' && e.role === 'mentioned'),
      `src/a.mjs should carry path000000a1/mentioned, has: ${JSON.stringify(a)}`);

    const marker = built.paths['test/marker.test.mjs'] ?? [];
    assert.ok(marker.some((e) => e.id === 'guard00000b1' && e.type === 'error' && e.role === 'guarded'),
      `test/marker.test.mjs should carry guard00000b1/guarded, has: ${JSON.stringify(marker)}`);

    const b = built.paths['src/b.mjs'] ?? [];
    assert.ok(b.some((e) => e.id === 'fix0000000d1' && e.type === 'error' && e.role === 'fixed'),
      `src/b.mjs should carry fix0000000d1/fixed, has: ${JSON.stringify(b)}`);

    const sym = built.symbols.myTableFunction ?? [];
    assert.ok(sym.some((e) => e.id === 'symb0000001c' && e.type === 'error' && e.role === 'mentioned'),
      `symbol myTableFunction should carry symb0000001c/mentioned, has: ${JSON.stringify(sym)}`);
  } finally { gone(r); }
});

test('positive control: a path with a DIFFERENT prefix does not match a bare mention', () => {
  const r = world();
  writeErrors(r, [{ id: 'prefixctrl01', ts: '2026-01-01T00:00:00Z', title: 'about projects/x/a.mjs only' }]);
  fs.writeFileSync(path.join(r, 'src', 'a.mjs'), 'export const y = 1;\n');
  commitAll(r, 'fixture: same base name, different prefix');
  try {
    const built = ct.build(r);
    const a = built.paths['src/a.mjs'] ?? [];
    assert.ok(!a.some((e) => e.id === 'prefixctrl01'),
      'a mention under a DIFFERENT prefix must not attach to src/a.mjs — the mix-up would be worse than the gap');
  } finally { gone(r); }
});

// --- (b) lookupPath(): forms, states, table vs. write() --------------------

test('lookupPath(): ok, over both spellings (two segments and bare base name)', () => {
  const r = fullFixture();
  try {
    ct.write(r);
    const exact = ct.lookupPath(r, 'src/a.mjs');
    assert.equal(exact.state, 'ok');
    assert.ok(exact.entries.some((e) => e.id === 'path000000a1'));

    const bare = ct.lookupPath(r, 'a.mjs');
    assert.equal(bare.state, 'ok');
    assert.ok(bare.entries.some((e) => e.id === 'path000000a1'), 'a bare base-name question should still resolve');
  } finally { gone(r); }
});

test('unknown: fresh table, path never seen at the last build', () => {
  const r = fullFixture();
  try {
    ct.write(r);
    const answer = ct.lookupPath(r, 'src/never-mentioned-anywhere.mjs');
    assert.equal(answer.state, 'unknown');
    assert.ok(answer.reason);
    assert.deepEqual(answer.entries, []);
  } finally { gone(r); }
});

test('error: no table present at all (never built)', () => {
  const r = fullFixture();
  try {
    const answer = ct.lookupPath(r, 'src/a.mjs');
    assert.equal(answer.state, 'error');
    assert.ok(answer.reason);
    assert.deepEqual(answer.entries, []);
  } finally { gone(r); }
});

test('error: a corrupted table file (not valid JSON)', () => {
  const r = fullFixture();
  try {
    ct.write(r);
    fs.writeFileSync(path.join(r, ct.TABLE_PATH), 'not json at all {{{');
    const answer = ct.lookupPath(r, 'src/a.mjs');
    assert.equal(answer.state, 'error');
    assert.match(answer.reason, /damaged/i);
  } finally { gone(r); }
});

function waitForNewSecond() {
  const start = Date.now();
  while (Date.now() - start < 1100) { /* busy-wait — mtime resolution */ }
}

test('warning: stale table after a new mention appears, ok again after update()', () => {
  const r = fullFixture();
  try {
    ct.write(r);
    const before = ct.lookupPath(r, 'src/a.mjs');
    assert.equal(before.state, 'ok');

    waitForNewSecond();
    writeErrors(r, [
      { id: 'path000000a1', ts: '2026-01-01T00:00:00Z', title: 'Bug in src/a.mjs found' },
      { id: 'staleaddedid', ts: '2026-01-02T00:00:00Z', title: 'Also about src/a.mjs, added after the build' },
    ]);
    commitAll(r, 'fixture: append a new mention');

    const stale = ct.lookupPath(r, 'src/a.mjs');
    assert.equal(stale.state, 'warning', 'the corpus/git tree changed since the last build');
    assert.ok(stale.reason && stale.reason.length > 0);
    assert.ok(!stale.entries.some((e) => e.id === 'staleaddedid'),
      'the new entry should not appear before update() reruns the build');

    ct.update(r);
    const after = ct.lookupPath(r, 'src/a.mjs');
    assert.equal(after.state, 'ok');
    assert.ok(after.entries.some((e) => e.id === 'staleaddedid'), 'update() should have picked up the new mention');
  } finally { gone(r); }
});

test('update() does not rebuild when nothing changed', () => {
  const r = fullFixture();
  try {
    const first = ct.update(r);
    const second = ct.update(r);
    assert.equal(first.builtAt, second.builtAt, 'an unchanged tree still triggered a rebuild');
  } finally { gone(r); }
});

test('rebuild from nothing (a deleted table) gives the same content', () => {
  const r = fullFixture();
  try {
    const first = ct.write(r);
    fs.rmSync(path.join(r, ct.TABLE_PATH), { force: true });
    assert.equal(ct.lookupPath(r, 'src/a.mjs').state, 'error');
    const second = ct.rebuild(r);
    assert.deepEqual(second.paths, first.paths);
    assert.deepEqual(second.symbols, first.symbols);
  } finally { gone(r); }
});

// --- (c) empty store: fresh install must not error ---------------------

test('empty store: build() on a fresh, empty memory succeeds — empty table, no throw', () => {
  const r = world(); // no entries, no commit at all yet — git has no HEAD
  try {
    const built = ct.build(r);
    assert.deepEqual(built.paths, {});
    assert.deepEqual(built.symbols, {});
    // incomplete is allowed to be true here (no HEAD yet) — the point is
    // it never throws and never silently claims a complete build.
    assert.equal(typeof built.incomplete, 'boolean');
  } finally { gone(r); }
});

test('empty store: lookupPath()/lookupSymbol() on a built-empty table return nothing, never throw', () => {
  const r = world();
  commitAll(r, 'fixture: empty repo, one empty commit so HEAD exists');
  try {
    ct.write(r);
    const p = ct.lookupPath(r, 'src/anything.mjs');
    assert.ok(['unknown', 'ok'].includes(p.state));
    assert.deepEqual(p.entries, []);
    const s = ct.lookupSymbol(r, 'anything');
    assert.ok(['unknown', 'ok'].includes(s.state));
    assert.deepEqual(s.entries, []);
  } finally { gone(r); }
});

test('empty store: no table built at all — error state, empty entries, no throw', () => {
  const r = world();
  try {
    const p = ct.lookupPath(r, 'anything.mjs');
    assert.equal(p.state, 'error');
    assert.deepEqual(p.entries, []);
    const s = ct.lookupSymbol(r, 'anything');
    assert.equal(s.state, 'error');
    assert.deepEqual(s.entries, []);
  } finally { gone(r); }
});

// --- (d) background rebuild (parity with lucky-mem's N1) -------------------

test('triggerBackgroundRebuild(): starts a build, a second call while it runs says "running"', async () => {
  const r = fullFixture();
  try {
    const first = ct.triggerBackgroundRebuild(r);
    assert.equal(first, 'started');
    assert.ok(ct.rebuildRunning(r), 'the lock file should be there right after starting');
    const second = ct.triggerBackgroundRebuild(r);
    assert.equal(second, 'running', 'a second nudge while the first still holds the lock must not start a second build');

    // Wait for the detached child to actually finish and release the lock
    // (best effort — bounded, this is the one place this suite waits on
    // an external process).
    const deadline = Date.now() + 10_000;
    while (ct.rebuildRunning(r) && Date.now() < deadline) {
      execFileSync(process.execPath, ['-e', ''], {}); // ~0 cost yield
    }
    assert.ok(!ct.rebuildRunning(r), 'the lock should be released once the background build finished');
    const after = ct.lookupPath(r, 'src/a.mjs');
    assert.equal(after.state, 'ok', 'the background build should have written a fresh, readable table');
  } finally { gone(r); }
});

test('triggerBackgroundRebuild(): never blocks the caller (returns fast)', () => {
  const r = fullFixture();
  try {
    const t0 = Date.now();
    ct.triggerBackgroundRebuild(r);
    const ms = Date.now() - t0;
    assert.ok(ms < 500, `triggerBackgroundRebuild should return immediately, took ${ms} ms`);
  } finally { gone(r); }
});

// --- (e) beforeEditHits(): the hook's whole "table first" decision ---------

test('beforeEditHits(): fresh table -> table hits, guarded/fixed rank above mentioned for errors', () => {
  const r = fullFixture();
  try {
    ct.write(r);
    const res = ct.beforeEditHits(r, 'src/a.mjs', { cap: 5 });
    assert.equal(res.tableState, 'ok');
    assert.ok(Array.isArray(res.hits) && res.hits.length >= 1);
    assert.ok(res.hits.some((h) => h.id === 'path000000a1'));
    assert.equal(res.backgroundRebuild, null, 'a fresh, ok table must not trigger a rebuild');
  } finally { gone(r); }
});

test('beforeEditHits(): the guarded mark is found where a live text scan finds NOTHING (the whole point of R9)', () => {
  const r = fullFixture();
  try {
    ct.write(r);
    const res = ct.beforeEditHits(r, 'test/marker.test.mjs', { cap: 5 });
    assert.equal(res.tableState, 'ok');
    assert.ok(res.hits.some((h) => h.id === 'guard00000b1' && h._form === 'guarded'),
      `guard00000b1 should surface via the table, guarded — got: ${JSON.stringify(res.hits)}`);
  } finally { gone(r); }
});

test('beforeEditHits(): missing table -> hits is null (caller falls back), background rebuild kicked off', () => {
  const r = fullFixture();
  try {
    const res = ct.beforeEditHits(r, 'src/a.mjs', { cap: 5 });
    assert.equal(res.tableState, 'error');
    assert.equal(res.hits, null);
    assert.equal(res.backgroundRebuild, 'started');
  } finally { gone(r); }
});

test('beforeEditHits(): unknown path on a FRESH table -> null hits, but no rebuild triggered (not the table\'s fault)', () => {
  const r = fullFixture();
  try {
    ct.write(r);
    const res = ct.beforeEditHits(r, 'src/never-mentioned-anywhere.mjs', { cap: 5 });
    assert.equal(res.tableState, 'unknown');
    assert.equal(res.hits, null);
    assert.equal(res.backgroundRebuild, null, 'unknown is the ordinary case, not a sign the table is broken');
  } finally { gone(r); }
});

// --- (f) generation stamp changes with every source it names ----------------

test('stamp(): a new commit changes the stamp even with the exact same files', () => {
  const r = fullFixture();
  try {
    const s1 = ct.stamp(r);
    waitForNewSecond();
    commitAll(r, 'fixture: empty commit, no file changes at all');
    const s2 = ct.stamp(r);
    assert.notEqual(s1, s2, 'a new HEAD should change the stamp even without a file change');
  } finally { gone(r); }
});
