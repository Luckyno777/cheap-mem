// test/release.test.mjs — the release rail (Bauplan P1, src/release.mjs):
// a frozen, verified copy for a service install, gated on a matching
// checked.jsonl row. Red-proof pinned to a fixed commit (rule 12 in the
// agent frame) — never `git merge-base`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as release from '../src/release.mjs';
import * as checkrecord from '../src/checkrecord.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_RELEASE_RAIL_COMMIT = '3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d';

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function gitc(cwd, ...args) { return git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args); }

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-release-src-'));
  gitc(root, 'init', '--quiet', '-b', 'main');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cheap-mem-fixture' }));
  fs.writeFileSync(path.join(root, 'bin', 'mem-watch'), '#!/bin/sh\necho watching\n');
  fs.writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  gitc(root, 'add', '-A');
  gitc(root, 'commit', '--quiet', '-m', 'first');
  return root;
}
const away = (root) => fs.rmSync(root, { recursive: true, force: true });

/** Green-record the current HEAD tree, exactly what `mem-check-record` does after a real green run. */
function recordGreen(root, env = {}) {
  const r = checkrecord.recordCheck(root, { passed: 1, failed: 0, env });
  assert.equal(r.written, true, 'fixture setup: expected recordCheck to write');
  return r;
}

// ---------------------------------------------------------------------
// Red proof
// ---------------------------------------------------------------------

test('RED PROOF (pinned commit): src/release.mjs did not exist before cm-release', () => {
  assert.throws(() => execFileSync('git', ['show', `${PRE_RELEASE_RAIL_COMMIT}:src/release.mjs`], { cwd: REPO, stdio: 'pipe' }),
    /Command failed/, 'expected src/release.mjs to be absent at the pinned pre-cm-release commit');
});

test('RED PROOF (pinned commit): the dashboard read "no release rail" / "no recorded test-run receipt" before cm-release', () => {
  const old = execFileSync('git', ['show', `${PRE_RELEASE_RAIL_COMMIT}:src/dashboard-data.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.match(old, /there is no release rail that records a stamped release/);
  assert.match(old, /there is no recorded test-run receipt/);
});

// ---------------------------------------------------------------------
// isCodePath / CODE_PATTERNS
// ---------------------------------------------------------------------

test('isCodePath: src/, bin/, test/, hooks/, assets/ are code wholesale', () => {
  for (const p of ['src/a.mjs', 'bin/mem', 'test/a.test.mjs', 'hooks/pre-commit', 'assets/x.js']) {
    assert.equal(release.isCodePath(p), true, p);
  }
});

test('isCodePath: checked.jsonl and docs are NOT code (an "innocent" ledger append must not invalidate a proof)', () => {
  for (const p of ['checked.jsonl', 'docs/x.md', 'README.md', 'CHANGELOG.md']) {
    assert.equal(release.isCodePath(p), false, p);
  }
});

test('isCodePath: only executable extensions under install/ count', () => {
  assert.equal(release.isCodePath('install/linux.sh'), true);
  assert.equal(release.isCodePath('install/install-linux.md'), false);
});

// ---------------------------------------------------------------------
// checkProof — the gate createRelease enforces
// ---------------------------------------------------------------------

test('checkProof: no ledger at all -> invalid, reason no-ledger', () => {
  const root = fixtureRepo();
  try {
    const commit = git(root, 'rev-parse', 'HEAD').trim();
    const r = release.checkProof(root, commit);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'no-ledger');
  } finally { away(root); }
});

test('checkProof: exact tree match after a green record and a commit -> valid', () => {
  const root = fixtureRepo();
  try {
    recordGreen(root);
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '--quiet', '-m', 'record checked.jsonl');
    const commit = git(root, 'rev-parse', 'HEAD').trim();
    const r = release.checkProof(root, commit);
    assert.equal(r.valid, true);
    assert.equal(r.row.tree, release.resolveTree(root, r.row.commit));
  } finally { away(root); }
});

test('checkProof: an innocent (non-code) change after the proof still validates', () => {
  const root = fixtureRepo();
  try {
    recordGreen(root);
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '--quiet', '-m', 'record checked.jsonl');
    fs.writeFileSync(path.join(root, 'README.md'), 'changed docs only\n');
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '--quiet', '-m', 'docs only');
    const commit = git(root, 'rev-parse', 'HEAD').trim();
    const r = release.checkProof(root, commit);
    assert.equal(r.valid, true, 'a docs-only change after the proof must still be accepted');
  } finally { away(root); }
});

test('POSITIVE CONTROL: checkProof rejects a real code change after the proof', () => {
  const root = fixtureRepo();
  try {
    recordGreen(root);
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '--quiet', '-m', 'record checked.jsonl');
    fs.writeFileSync(path.join(root, 'src', 'a.mjs'), 'export const a = 2; // changed\n');
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '--quiet', '-m', 'real code change');
    const commit = git(root, 'rev-parse', 'HEAD').trim();
    const r = release.checkProof(root, commit);
    assert.equal(r.valid, false, 'a real src/ change after the proof must invalidate it');
    assert.equal(r.reason, 'no-matching-record');
  } finally { away(root); }
});

test('POSITIVE CONTROL: a row with failed !== 0 is never treated as proof', () => {
  const root = fixtureRepo();
  try {
    // A tampered/foreign line — never produced by recordCheck() itself
    // (which refuses failed !== 0, see checkrecord.test.mjs), written by
    // hand here to prove checkProof() ALSO refuses to trust one, not
    // only that the writer never makes one.
    const commitBefore = git(root, 'rev-parse', 'HEAD').trim();
    const tree = checkrecord.treeHash(root);
    fs.writeFileSync(checkrecord.recordPath(root), `${JSON.stringify({
      tree, commit: commitBefore, tests: 2, passed: 1, failed: 1, ts: new Date().toISOString(), machine: 'x', house: 'cheap-mem-fixture',
    })}\n`);
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '--quiet', '-m', 'tampered ledger line');
    const commit = git(root, 'rev-parse', 'HEAD').trim();
    const r = release.checkProof(root, commit);
    assert.equal(r.valid, false, 'a failed !== 0 row must never validate a release');
    assert.equal(r.reason, 'no-matching-record');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// createRelease / codePath / rollback — the end-to-end rail
// ---------------------------------------------------------------------

function releasedFixture() {
  const root = fixtureRepo();
  recordGreen(root);
  gitc(root, 'add', '-A');
  gitc(root, 'commit', '--quiet', '-m', 'record checked.jsonl');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-release-base-'));
  fs.rmdirSync(base); // createRelease must create it itself
  return { root, base };
}

test('createRelease: refuses an unproven ref without --allow-unproven', () => {
  const root = fixtureRepo(); // no checked.jsonl row at all
  const base = `${root}-release`;
  try {
    const r = release.createRelease(root, { ref: 'HEAD', fetch: false, env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.created, false);
    assert.equal(r.reason, 'no-proof');
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

test('createRelease: with a valid proof, creates a frozen copy and switches "current"', () => {
  const { root, base } = releasedFixture();
  try {
    const r = release.createRelease(root, { ref: 'HEAD', fetch: false, env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.created, true);
    assert.equal(r.proven, true);
    assert.ok(fs.existsSync(path.join(base, 'current', 'bin', 'mem-watch')));
    assert.ok(fs.existsSync(path.join(base, 'current', '.release-meta.json')));
    // the frozen copy is a plain directory — no .git inside (git archive, not a worktree)
    assert.equal(fs.existsSync(path.join(base, r.kurzhash, '.git')), false);
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

test('createRelease: --allow-unproven forces it through with a marked-forced meta file', () => {
  const root = fixtureRepo();
  const base = `${root}-release`;
  try {
    const r = release.createRelease(root, { ref: 'HEAD', fetch: false, allowUnproven: true, env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.created, true);
    assert.equal(r.proven, false);
    const meta = JSON.parse(fs.readFileSync(path.join(base, 'current', '.release-meta.json'), 'utf8'));
    assert.equal(meta.proofKind, 'forced');
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

test('codePath: falls back to the source root when no release exists yet ("unknown — no release" territory)', () => {
  const root = fixtureRepo();
  const base = `${root}-release`;
  try {
    const r = release.codePath(root, { env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.fromRelease, false);
    assert.equal(r.path, root);
    assert.match(r.reason, /no usable release/);
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

test('codePath: points at the frozen copy once one exists', () => {
  const { root, base } = releasedFixture();
  try {
    release.createRelease(root, { ref: 'HEAD', fetch: false, env: { CHEAP_MEM_RELEASE_BASE: base } });
    const r = release.codePath(root, { env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.fromRelease, true);
    assert.equal(fs.realpathSync(r.path), fs.realpathSync(path.join(base, 'current')));
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

test('rollback: with only one release ever made, refuses (no prior state)', () => {
  const { root, base } = releasedFixture();
  try {
    release.createRelease(root, { ref: 'HEAD', fetch: false, env: { CHEAP_MEM_RELEASE_BASE: base } });
    const r = release.rollback(root, { env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.rolledBack, false);
    assert.equal(r.reason, 'no-prior-state');
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

test('rollback: after two releases, returns "current" to the first one', () => {
  const { root, base } = releasedFixture();
  try {
    const first = release.createRelease(root, { ref: 'HEAD', fetch: false, env: { CHEAP_MEM_RELEASE_BASE: base } });
    fs.writeFileSync(path.join(root, 'README.md'), 'second state\n');
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '--quiet', '-m', 'innocent change');
    const second = release.createRelease(root, { ref: 'HEAD', fetch: false, env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.notEqual(first.kurzhash, second.kurzhash);

    const r = release.rollback(root, { env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.rolledBack, true);
    assert.equal(r.kurzhash, first.kurzhash);
    assert.equal(fs.realpathSync(path.join(base, 'current')), fs.realpathSync(path.join(base, first.kurzhash)));
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------
// currentState — what the dashboard reads
// ---------------------------------------------------------------------

test('currentState: fresh install -> readable:false, "unknown — no release yet"', () => {
  const root = fixtureRepo();
  const base = `${root}-release`;
  try {
    const r = release.currentState(root, { env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.readable, false);
    assert.equal(r.reason, 'unknown — no release yet');
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});

test('currentState: after a release, reads the meta of "current"', () => {
  const { root, base } = releasedFixture();
  try {
    const created = release.createRelease(root, { ref: 'HEAD', fetch: false, env: { CHEAP_MEM_RELEASE_BASE: base } });
    const r = release.currentState(root, { env: { CHEAP_MEM_RELEASE_BASE: base } });
    assert.equal(r.readable, true);
    assert.equal(r.kurzhash, created.kurzhash);
    assert.equal(r.proven, true);
  } finally { away(root); fs.rmSync(base, { recursive: true, force: true }); }
});
