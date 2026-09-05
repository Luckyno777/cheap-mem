// The guarantees cheap-mem does not provide itself. Round two of the
// 2026-09-05 audit found these were the failure class behind the others:
// invisible when present, silent when absent, verified by nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  checkMergeDriver, checkPreCommitHook, checkClock,
  checkEnvironment, environmentOk, LAYER,
} from '../src/environment.mjs';

// The git-layer checks are about repository CONFIGURATION, so a fixture
// that is not a repository tests nothing about them — it exercises the
// not-applicable branch instead. Every fixture here is a real repository.
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-env-'));
  execFileSync('git', ['-C', d, 'init', '-q'], { stdio: 'ignore' });
  return d;
}
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });

test('a missing .gitattributes fails, and the advice says what it costs', () => {
  const root = tmp();
  const c = checkMergeDriver(root);
  assert.equal(c.ok, false);
  assert.equal(c.layer, LAYER.GIT);
  assert.match(c.fix, /merge=union/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a .gitattributes without the rule is not mistaken for one with it', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.md text\n');
  assert.equal(checkMergeDriver(root).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a file that MENTIONS jsonl without declaring the driver still fails', () => {
  // The check must match the whole rule, not the word. A substring test
  // would pass on any of these, and mutation testing found exactly that
  // gap: narrowing the regex to /jsonl/ left every test green.
  for (const text of [
    '*.jsonl text\n',
    '*.jsonl diff=json\n',
    '# TODO: add *.jsonl merge=union one day\n',
    'merge=union\n',
    '*.jsonl merge=ours\n',
    'notes.jsonl -text\n',
  ]) {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.gitattributes'), text);
    assert.equal(checkMergeDriver(root).ok, false,
      `accepted ${JSON.stringify(text)} as the merge driver`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the rule is recognised with surrounding comments and blank lines', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.gitattributes'), '# note\n\n*.jsonl merge=union\n\n# more\n');
  assert.equal(checkMergeDriver(root).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unset core.hooksPath fails rather than being assumed fine', () => {
  const root = tmp();
  git(root, 'init', '-q');
  const c = checkPreCommitHook(root);
  assert.equal(c.ok, false);
  assert.match(c.detail, /not set/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a hooksPath pointing at a directory with no pre-commit fails', () => {
  const root = tmp();
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'hooks'));
  git(root, 'config', 'core.hooksPath', 'hooks');
  assert.equal(checkPreCommitHook(root).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a hook without the executable bit still counts — it is invoked as bash <path>', () => {
  const root = tmp();
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  git(root, 'config', 'core.hooksPath', 'hooks');
  assert.equal(checkPreCommitHook(root).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clock check with nothing to compare against is unknown, not ok', () => {
  const c = checkClock(tmp(), { newestTs: null });
  assert.equal(c.ok, null);
});

test('an entry far in the future is a clock finding', () => {
  const c = checkClock(tmp(), { newestTs: '2099-01-01T00:00:00Z' });
  assert.equal(c.ok, false);
  assert.match(c.detail, /future/);
});

test('a few minutes of skew is tolerated', () => {
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  assert.equal(checkClock(tmp(), { newestTs: soon }).ok, true);
});

test('strict treats an unverifiable guarantee as a failure, normal does not', () => {
  const checks = [{ name: 'x', layer: LAYER.OS, ok: null, detail: 'unknown', fix: null }];
  assert.equal(environmentOk(checks, { strict: false }), true);
  assert.equal(environmentOk(checks, { strict: true }), false);
});

test('every check names the layer responsible', () => {
  const root = tmp();
  for (const c of checkEnvironment(root, { newestTs: new Date().toISOString() })) {
    assert.ok(Object.values(LAYER).includes(c.layer), `${c.name} has no layer`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('mem init writes the merge driver — a fresh memory must not ship without it', () => {
  const root = tmp();
  execFileSync('node', [path.join(process.cwd(), 'bin', 'mem'), 'init'],
    { cwd: root, stdio: 'ignore' });
  assert.equal(checkMergeDriver(root).ok, true,
    'init left the memory without the guarantee its own design depends on');
  fs.rmSync(root, { recursive: true, force: true });
});

test('init does not clobber an existing .gitattributes', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.png binary\n');
  execFileSync('node', [path.join(process.cwd(), 'bin', 'mem'), 'init'],
    { cwd: root, stdio: 'ignore' });
  const text = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(text, /\*\.png binary/);
  assert.match(text, /\*\.jsonl merge=union/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('init is idempotent — running it twice does not duplicate the rule', () => {
  const root = tmp();
  const mem = path.join(process.cwd(), 'bin', 'mem');
  execFileSync('node', [mem, 'init'], { cwd: root, stdio: 'ignore' });
  execFileSync('node', [mem, 'init', '--force'], { cwd: root, stdio: 'ignore' });
  const hits = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')
    .split('\n').filter((l) => /^\s*\*\.jsonl\s+merge=union\s*$/.test(l));
  assert.equal(hits.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('outside a git repository the git-layer checks are unknown, not failed', () => {
  // A freshly initialised memory that is not versioned yet is a CORRECT
  // state. Reporting it as an error made `mem doctor` exit 2 and held CI
  // red on all three platforms for three runs, unread.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nogit-'));
  for (const c of [checkMergeDriver(root), checkPreCommitHook(root)]) {
    assert.equal(c.ok, null, `${c.name} must be unknown outside a repository`);
    assert.equal(c.layer, LAYER.GIT);
    assert.match(c.detail, /not a git repository/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
