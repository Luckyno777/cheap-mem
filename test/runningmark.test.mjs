// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/runningmark.test.mjs — W1 parity (src/runningmark.mjs): every
// long-running service writes an atomic start marker under
// root/.pipeline/running/<service>.json.
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
import * as runningmark from '../src/runningmark.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_MARK_COMMIT = 'f77439fac293d46dc1d46c73a54e4bb0f38bfecc';

function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function gitc(cwd, ...args) { return git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args); }

function fixtureCodeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runningmark-code-'));
  gitc(dir, 'init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '--quiet', '-m', 'first');
  return dir;
}
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runningmark-root-')); }
const away = (p) => fs.rmSync(p, { recursive: true, force: true });

// ---------------------------------------------------------------------
// Red proof
// ---------------------------------------------------------------------

test('RED PROOF (pinned commit): src/runningmark.mjs did not exist before this build', () => {
  assert.throws(() => execFileSync('git', ['show', `${PRE_MARK_COMMIT}:src/runningmark.mjs`], { cwd: REPO, stdio: 'pipe' }),
    /Command failed/, 'expected src/runningmark.mjs to be absent at the pinned pre-build commit');
});

// ---------------------------------------------------------------------
// commitOf
// ---------------------------------------------------------------------

test('commitOf: a real git checkout resolves to its HEAD commit', () => {
  const code = fixtureCodeRepo();
  try {
    const head = git(code, 'rev-parse', 'HEAD').trim();
    const { commit, reason } = runningmark.commitOf(code);
    assert.equal(commit, head);
    assert.equal(reason, null);
  } finally { away(code); }
});

test('commitOf: a frozen release copy (no .git) falls back to .release-meta.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runningmark-release-'));
  try {
    fs.writeFileSync(path.join(dir, '.release-meta.json'), JSON.stringify({ commit: 'deadbeefcafe' }));
    const { commit, reason } = runningmark.commitOf(dir);
    assert.equal(commit, 'deadbeefcafe');
    assert.equal(reason, null);
  } finally { away(dir); }
});

test('commitOf: neither git nor release meta readable -> commit null, with a reason (never a guess)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runningmark-nothing-'));
  try {
    const { commit, reason } = runningmark.commitOf(dir);
    assert.equal(commit, null);
    assert.ok(reason && reason.length > 0);
  } finally { away(dir); }
});

// ---------------------------------------------------------------------
// writeMarker / readMarker
// ---------------------------------------------------------------------

test('writeMarker: content — service, commit, code_path, start, pid', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    const head = git(code, 'rev-parse', 'HEAD').trim();
    const marker = runningmark.writeMarker(root, { service: 'serve', codePath: code, pid: 4242 });
    assert.equal(marker.service, 'serve');
    assert.equal(marker.commit, head);
    assert.equal(marker.code_path, code);
    assert.equal(marker.pid, 4242);
    assert.ok(marker.start && !Number.isNaN(Date.parse(marker.start)));

    const target = runningmark.markerPath(root, 'serve');
    assert.ok(fs.existsSync(target));
    const onDisk = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(onDisk, marker);
  } finally { away(code); away(root); }
});

test('writeMarker: a non-git, non-release code path still writes a marker, with commit:null and a reason', () => {
  const root = tmpRoot();
  const notCode = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runningmark-plain-'));
  try {
    const marker = runningmark.writeMarker(root, { service: 'mcp-http', codePath: notCode });
    assert.equal(marker.commit, null);
    assert.ok(typeof marker.reason === 'string' && marker.reason.length > 0);
  } finally { away(root); away(notCode); }
});

test('readMarker: round-trips writeMarker, and reads null for a missing/unknown service', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: code });
    const back = runningmark.readMarker(root, 'serve');
    assert.equal(back.service, 'serve');
    assert.equal(runningmark.readMarker(root, 'mcp-http'), null, 'no marker written for this service yet');
    assert.equal(runningmark.readMarker(root, 'nonsense-service'), null);
  } finally { away(code); away(root); }
});

test('writeMarker: atomic — no .tmp- file left behind after a successful write, temp dir stays clean', () => {
  const code = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: code });
    const dir = path.dirname(runningmark.markerPath(root, 'serve'));
    const entries = fs.readdirSync(dir);
    assert.deepEqual(entries, ['serve.json'], 'no leftover temp file after a clean write');
  } finally { away(code); away(root); }
});

test('writeMarker: a second write for the same service overwrites (not append-only — a live marker, not a log)', () => {
  const codeA = fixtureCodeRepo();
  const root = tmpRoot();
  try {
    runningmark.writeMarker(root, { service: 'serve', codePath: codeA, pid: 111 });
    fs.writeFileSync(path.join(codeA, 'b.mjs'), 'export const b = 2;\n');
    gitc(codeA, 'add', '-A');
    gitc(codeA, 'commit', '--quiet', '-m', 'second');
    const newHead = git(codeA, 'rev-parse', 'HEAD').trim();
    runningmark.writeMarker(root, { service: 'serve', codePath: codeA, pid: 222 });
    const back = runningmark.readMarker(root, 'serve');
    assert.equal(back.pid, 222);
    assert.equal(back.commit, newHead);
    const dir = path.dirname(runningmark.markerPath(root, 'serve'));
    assert.deepEqual(fs.readdirSync(dir), ['serve.json']);
  } finally { away(codeA); away(root); }
});
