// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// A time cap that works without perl - and never fails silently.
//
// bin/mem-stop used to carry its own copy of the cap: GNU `timeout`, else
// `gtimeout`, else NO cap, without a word. On a box with neither (a minimal
// container, a Windows Git Bash without perl) the push and the pull ran
// without a limit and nothing said so. The shared bin/_portable.sh already
// had a perl watchdog; mem-stop did not use it, and below perl there was
// nothing. Now: timeout, gtimeout, perl, a Node watchdog, and when even that
// is missing the hook SAYS there is no cap (mem_cap_kind=none).
//
// Probe: a stand-in PATH made of symlinks to just the tools the hook needs -
// no timeout, no gtimeout, no perl. Cap expiry is observed by the exit code
// 124 and by a bystander process of the test that must still be alive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTABLE = path.join(REPO, 'bin', '_portable.sh').split(path.sep).join('/');
const STOP = path.join(REPO, 'bin', 'mem-stop').split(path.sep).join('/');
const which = (n) => spawnSync('bash', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();

const POSIX_ONLY = process.platform === 'win32'
  ? 'POSIX-only fixture (a PATH of symlinks to MSYS tools cannot be spawned from node); on Windows Git Bash ships GNU timeout, so the fallbacks are not reached there. UNVERIFIED on a real runner.'
  : false;

function standIn(tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nocap-'));
  for (const n of tools) {
    const p = which(n);
    if (p) fs.symlinkSync(p, path.join(dir, n));
  }
  return dir;
}
const WITH_NODE = ['bash', 'sleep', 'sh', 'dirname', 'cat', 'node', 'date'];
const WITHOUT_NODE = ['bash', 'sleep', 'sh', 'dirname', 'cat', 'date'];

const run = (dir, body, extra = {}) => spawnSync(path.join(dir, 'bash'), ['-c', `. "${PORTABLE}"; ${body}`], {
  encoding: 'utf8', timeout: 30000, env: { PATH: dir }, ...extra,
});

test('POSITIVE: the stand-in PATH really has no timeout, gtimeout or perl', { skip: POSIX_ONLY }, () => {
  const dir = standIn(WITH_NODE);
  try {
    const r = run(dir, 'command -v timeout; command -v gtimeout; command -v perl; echo "kind=$mem_cap_kind"');
    assert.equal(r.stdout.trim(), 'kind=node', r.stdout + r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without timeout, gtimeout and perl: capped ends a hang with 124 via the node watchdog', { skip: POSIX_ONLY }, () => {
  const dir = standIn(WITH_NODE);
  const bystander = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    const t0 = Date.now();
    const hung = run(dir, 'capped 1.5 sleep 20; echo "rc=$?"');
    assert.match(hung.stdout, /rc=124/, hung.stdout + hung.stderr);
    assert.ok(Date.now() - t0 < 15000, 'the cap ended it early');
    // Its own child only: the test's own process is untouched.
    assert.doesNotThrow(() => process.kill(bystander.pid, 0), 'the watchdog killed a process it did not start');
    assert.match(run(dir, 'capped 5 bash -c "exit 3"; echo "rc=$?"').stdout, /rc=3/);
    assert.match(run(dir, 'capped 5 bash -c "echo hi"; echo "rc=$?"').stdout, /hi\nrc=0/);
    assert.match(run(dir, 'capped 5 nonexistent-cmd-xyz; echo "rc=$?"').stdout, /rc=127/);
    // stdin reaches the command (the hook pipes its JSON through the cap).
    assert.match(run(dir, 'printf abc | capped 5 cat; echo "rc=$?"').stdout, /abcrc=0/);
    // died of a signal: 128 + n, like GNU timeout
    assert.match(run(dir, 'capped 5 bash -c "kill -TERM \\$\\$"; echo "rc=$?"').stdout, /rc=143/);
  } finally {
    bystander.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without any cap tool: capped says so, runs the command anyway, kind is none', { skip: POSIX_ONLY }, () => {
  const dir = standIn(WITHOUT_NODE);
  try {
    const r = run(dir, 'echo "kind=$mem_cap_kind"; capped 5 bash -c "echo hi"; echo "rc=$?"');
    assert.match(r.stdout, /kind=none/, r.stdout + r.stderr);
    assert.match(r.stdout, /hi\nrc=0/);
    assert.match(r.stderr, /NO time cap available/, 'a missing cap must be said, not swallowed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function memoryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stopmem-'));
  fs.mkdirSync(path.join(root, '.mem'));
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{}\n');
  return root;
}
const stop = (dir, root) => spawnSync(path.join(dir, 'bash'), [STOP], {
  encoding: 'utf8', timeout: 60000, input: '{"cwd":"x"}',
  env: { PATH: dir, CHEAP_MEM_ROOT: root, HOME: root, MEM_STOP_NO_PUSH: '1' },
});

test('mem-stop names the way its cap works when it is not GNU timeout', { skip: POSIX_ONLY }, () => {
  const dir = standIn(WITH_NODE);
  const root = memoryRoot();
  try {
    const r = stop(dir, root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /time cap via node watchdog/, r.stderr);
    assert.doesNotMatch(r.stdout, /no time cap/, 'a working cap is not reported to the session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mem-stop with no cap at all: stderr AND a systemMessage, still exit 0', { skip: POSIX_ONLY }, () => {
  const dir = standIn(WITHOUT_NODE);
  const root = memoryRoot();
  try {
    const r = stop(dir, root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /NO time cap available/);
    const msg = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.match(msg.systemMessage, /no time cap available/);
    assert.equal(msg.decision, undefined, 'a notice never blocks');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mem-stop reaches the cap through the shared file, not a copy of its own', () => {
  const text = fs.readFileSync(path.join(REPO, 'bin', 'mem-stop'), 'utf8');
  assert.match(text, /^\s*\. "\$HERE\/_portable\.sh"/m, 'mem-stop does not source bin/_portable.sh');
  assert.doesNotMatch(text, /^\s*CAP=\(/m, 'mem-stop carries its own cap array again');
  // POSITIVE: the matcher sees the old shape.
  assert.match('else CAP=(); fi', /CAP=\(/);
});
