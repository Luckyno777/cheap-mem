// test/checkrecord.test.mjs — the tracked, append-only proof ledger
// (Bauplan P1, src/checkrecord.mjs). Red-proof pinned to a fixed commit
// (see the header test below) — never `git merge-base`, which moves
// after this branch merges and would go red for the wrong reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as checkrecord from '../src/checkrecord.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Pinned at the start of this agent's work (cm-release) — see rule 12 in
// the agent frame: a red-proof read through `git show <hash>:<path>`
// must pin a FIXED commit, never a moving `merge-base`, or the probe
// goes red again for an unrelated reason after this branch merges.
const PRE_RELEASE_RAIL_COMMIT = '3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d';

/** Only ever run against a THROWAWAY temp repo, never against REPO itself. */
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function gitc(cwd, ...args) { return git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args); }

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-checkrecord-'));
  gitc(root, 'init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cheap-mem-fixture' }));
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  gitc(root, 'add', '-A');
  gitc(root, 'commit', '--quiet', '-m', 'first');
  return root;
}
const away = (root) => fs.rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------------
// Red proof: the ledger did not exist before this branch
// ---------------------------------------------------------------------

test('RED PROOF (pinned commit): src/checkrecord.mjs did not exist before cm-release', () => {
  assert.throws(() => execFileSync('git', ['show', `${PRE_RELEASE_RAIL_COMMIT}:src/checkrecord.mjs`], { cwd: REPO, stdio: 'pipe' }),
    /Command failed/, 'expected src/checkrecord.mjs to be absent at the pinned pre-cm-release commit');
});

test('RED PROOF (pinned commit): the dashboard read "not available" for release/checkRecord before cm-release', () => {
  const old = execFileSync('git', ['show', `${PRE_RELEASE_RAIL_COMMIT}:src/dashboard-data.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.match(old, /release: \{ readable: false, reason: 'not available in cheap-mem/);
  assert.match(old, /checkRecord: \{ readable: false, reason: 'not available in cheap-mem/);
});

// ---------------------------------------------------------------------
// treeHash / isTreeClean
// ---------------------------------------------------------------------

test('treeHash: matches HEAD^{tree} on a clean checkout', () => {
  const root = fixtureRepo();
  try {
    assert.equal(checkrecord.isTreeClean(root), true);
    const want = git(root, 'rev-parse', 'HEAD^{tree}').trim();
    assert.equal(checkrecord.treeHash(root), want);
  } finally { away(root); }
});

test('treeHash: falls back to write-tree on a dirty checkout (positive control: the two differ)', () => {
  const root = fixtureRepo();
  try {
    const cleanTree = checkrecord.treeHash(root);
    fs.writeFileSync(path.join(root, 'README.md'), 'changed\n');
    gitc(root, 'add', '-A');
    assert.equal(checkrecord.isTreeClean(root), false);
    const dirtyTree = checkrecord.treeHash(root);
    assert.notEqual(dirtyTree, cleanTree, 'positive control failed: dirty tree must differ from the clean one');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// recordCheck: the append-only writer
// ---------------------------------------------------------------------

test('recordCheck: writes a row for a green, full run', () => {
  const root = fixtureRepo();
  try {
    const r = checkrecord.recordCheck(root, { passed: 42, failed: 0, full: true, now: new Date('2026-09-28T00:00:00Z') });
    assert.equal(r.written, true);
    assert.equal(r.row.tests, 42);
    assert.equal(r.row.failed, 0);
    assert.equal(r.row.house, 'cheap-mem-fixture');
    const rows = checkrecord.readRecords(checkrecord.recordPath(root));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tree, checkrecord.treeHash(root));
  } finally { away(root); }
});

test('POSITIVE CONTROL: recordCheck refuses a red run (failed !== 0) — nothing is written', () => {
  const root = fixtureRepo();
  try {
    const r = checkrecord.recordCheck(root, { passed: 40, failed: 2, full: true });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'red');
    assert.deepEqual(checkrecord.readRecords(checkrecord.recordPath(root)), []);
  } finally { away(root); }
});

test('POSITIVE CONTROL: recordCheck refuses a partial run (full: false) even if green', () => {
  const root = fixtureRepo();
  try {
    const r = checkrecord.recordCheck(root, { passed: 5, failed: 0, full: false });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'partial');
  } finally { away(root); }
});

test('recordCheck: idempotent — the same tree is never appended twice', () => {
  const root = fixtureRepo();
  try {
    const first = checkrecord.recordCheck(root, { passed: 10, failed: 0 });
    assert.equal(first.written, true);
    const second = checkrecord.recordCheck(root, { passed: 10, failed: 0 });
    assert.equal(second.written, false);
    assert.equal(second.reason, 'already-recorded');
    assert.equal(checkrecord.readRecords(checkrecord.recordPath(root)).length, 1);
  } finally { away(root); }
});

test('readRecords: a broken line is skipped, not thrown', () => {
  const root = fixtureRepo();
  try {
    const target = checkrecord.recordPath(root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ tree: 'a', commit: 'a', tests: 1, passed: 1, failed: 0 })}\nnot json\n`);
    const rows = checkrecord.readRecords(target);
    assert.equal(rows.length, 1);
  } finally { away(root); }
});

test('readRecords: a missing file reads as no rows, never a throw', () => {
  const root = fixtureRepo();
  try {
    assert.deepEqual(checkrecord.readRecords(checkrecord.recordPath(root)), []);
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// machineName / houseName
// ---------------------------------------------------------------------

test('machineName: CLAUDE_CODE_REMOTE reads as "cloud"', () => {
  assert.equal(checkrecord.machineName({ CLAUDE_CODE_REMOTE: '1' }), 'cloud');
});

test('machineName: an explicit override wins over everything', () => {
  assert.equal(checkrecord.machineName({ CHEAP_MEM_CHECK_MACHINE: 'my-box', CLAUDE_CODE_REMOTE: '1' }), 'my-box');
});

test('houseName: reads package.json name', () => {
  const root = fixtureRepo();
  try { assert.equal(checkrecord.houseName(root), 'cheap-mem-fixture'); } finally { away(root); }
});

// ---------------------------------------------------------------------
// fromTapOutput
// ---------------------------------------------------------------------

test('fromTapOutput: reads # pass / # fail from a node:test TAP trailer', () => {
  const tap = 'TAP version 13\n# tests 12\n# pass 12\n# fail 0\n';
  assert.deepEqual(checkrecord.fromTapOutput(tap), { passed: 12, failed: 0 });
});

test('POSITIVE CONTROL: fromTapOutput returns null fields (not 0) when there is no summary at all', () => {
  assert.deepEqual(checkrecord.fromTapOutput('a crash before any test ran\n'), { passed: null, failed: null });
});
