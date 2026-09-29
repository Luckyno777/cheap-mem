// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/doctor-running-code.test.mjs — W1/V9 parity: doctor.mjs's
// 'running-code' finding, and that it shares ONE code-path function
// (src/release.mjs: isCodePath/changedPaths) with the release rail's
// own proof gate (src/release.mjs: checkProof) — never two separate
// rules for "is this code" that can drift apart (the lm lesson behind
// V9: two truths -> a false alarm).
//
// Red proof pinned to this worktree's starting commit (agent-rahmen.md
// rule 12): f77439fac293d46dc1d46c73a54e4bb0f38bfecc, never `git
// merge-base`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as doctor from '../src/doctor.mjs';
import * as runningmark from '../src/runningmark.mjs';
import * as release from '../src/release.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_MARK_COMMIT = 'f77439fac293d46dc1d46c73a54e4bb0f38bfecc';

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function gitc(cwd, ...args) { return git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args); }

function fixtureCodeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runcode-code-'));
  gitc(dir, 'init', '--quiet', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'docs\n');
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '--quiet', '-m', 'first');
  return dir;
}
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runcode-root-')); }
const away = (p) => fs.rmSync(p, { recursive: true, force: true });
function commitAll(dir, msg) { gitc(dir, 'add', '-A'); gitc(dir, 'commit', '--quiet', '-m', msg); return git(dir, 'rev-parse', 'HEAD').trim(); }

// ---------------------------------------------------------------------
// Red proof
// ---------------------------------------------------------------------

test('RED PROOF (pinned commit): doctor.mjs had no checkRunningCode before this build', () => {
  const old = execFileSync('git', ['show', `${PRE_MARK_COMMIT}:src/doctor.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.doesNotMatch(old, /checkRunningCode/);
});

// ---------------------------------------------------------------------
// checkRunningCodeFor: missing marker / dead pid / unknown commit
// ---------------------------------------------------------------------

test('missing marker -> UNKNOWN, not GOOD and not WARN', () => {
  const root = tmpRoot();
  try {
    const r = doctor.checkRunningCodeFor(root, 'serve');
    assert.equal(r.level, doctor.LEVEL.UNKNOWN);
  } finally { away(root); }
});

test('dead pid -> WARN (stale marker)', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    // A pid that is astronomically unlikely to exist on this machine.
    runningmark.writeMarker(root, { service: 'serve', codePath: code, pid: 999999 });
    const r = doctor.checkRunningCodeFor(root, 'serve');
    assert.equal(r.level, doctor.LEVEL.WARN);
    assert.match(r.text, /not running|stale/);
  } finally { away(code); away(root); }
});

test('marker with commit:null -> UNKNOWN, names the reason', () => {
  const root = tmpRoot();
  const notCode = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runcode-plain-'));
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: notCode, pid: process.pid });
    const r = doctor.checkRunningCodeFor(root, 'serve');
    assert.equal(r.level, doctor.LEVEL.UNKNOWN);
  } finally { away(root); away(notCode); }
});

// ---------------------------------------------------------------------
// GOOD / WARN by content — and the shared code-path function
// ---------------------------------------------------------------------

test('GOOD: no commit changed since the marker was written', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: code, pid: process.pid });
    const r = doctor.checkRunningCodeFor(root, 'serve');
    assert.equal(r.level, doctor.LEVEL.GOOD);
    assert.match(r.text, /runs the code it started with/);
  } finally { away(code); away(root); }
});

test('GOOD: a DATA-only commit since start never warns', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: code, pid: process.pid });
    fs.writeFileSync(path.join(code, 'README.md'), 'docs, changed\n');
    commitAll(code, 'docs only');
    const r = doctor.checkRunningCodeFor(root, 'serve');
    assert.equal(r.level, doctor.LEVEL.GOOD);
    assert.match(r.text, /none are code paths/);
  } finally { away(code); away(root); }
});

test('WARN: a real CODE commit since start -> "runs old code"', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: code, pid: process.pid });
    fs.writeFileSync(path.join(code, 'src', 'a.mjs'), 'export const a = 2;\n');
    commitAll(code, 'code change');
    const r = doctor.checkRunningCodeFor(root, 'serve');
    assert.equal(r.level, doctor.LEVEL.WARN);
    assert.match(r.text, /runs old code/);
  } finally { away(code); away(root); }
});

test('checkRunningCode: combines every tracked service, worst level wins (WARN beats UNKNOWN and GOOD)', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: code, pid: process.pid }); // GOOD
    // 'mcp-http' has no marker -> UNKNOWN for that one, but 'serve' will
    // be made to WARN below, which must win the combined verdict.
    fs.writeFileSync(path.join(code, 'src', 'a.mjs'), 'export const a = 3;\n');
    commitAll(code, 'code change');
    const f = doctor.checkRunningCode(root);
    assert.equal(f.name, 'running-code');
    assert.equal(f.level, doctor.LEVEL.WARN);
    assert.ok(f.advice, 'a non-good finding must carry advice');
  } finally { away(code); away(root); }
});

// ---------------------------------------------------------------------
// V9: ONE code-path function, not two
// ---------------------------------------------------------------------

test('V9: doctor.checkRunningCodeFor and release.checkProof both go through release.isCodePath/changedPaths', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'doctor.mjs'), 'utf8');
  assert.match(src, /release\.isCodePath/, 'checkRunningCodeFor must call release.isCodePath, not its own copy');
  assert.match(src, /release\.changedPaths/, 'checkRunningCodeFor must call release.changedPaths, not its own copy');
  // doctor.mjs defines no second "is this code" rule of its own.
  assert.doesNotMatch(src, /CODE_PATTERNS\s*=/, 'doctor.mjs must not carry a second code-path pattern list');
});

test('V9 behaviourally: the SAME commit range judged identically by release.isCodePath and by checkRunningCodeFor', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    const startCommit = git(code, 'rev-parse', 'HEAD').trim();
    runningmark.writeMarker(root, { service: 'serve', codePath: code, pid: process.pid });
    fs.writeFileSync(path.join(code, 'src', 'a.mjs'), 'export const a = 4;\n');
    const endCommit = commitAll(code, 'code change');

    const changed = release.changedPaths(code, startCommit, endCommit);
    const codeChanges = changed.filter((p) => release.isCodePath(p));
    assert.ok(codeChanges.length > 0, 'fixture setup: expected a real code-path change');

    const r = doctor.checkRunningCodeFor(root, 'serve');
    assert.equal(r.level, doctor.LEVEL.WARN, 'doctor must warn exactly when release.isCodePath saw a code change');
  } finally { away(code); away(root); }
});
