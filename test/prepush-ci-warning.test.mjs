// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// The pre-push CI warning (hooks/pre-push + src/prepush.mjs).
//
// What is held here: the hook NEVER blocks (exit 0 in every state), and
// it never reports "green" unless `gh` positively said every run for the
// exact commit passed. "Could not ask" (no gh, offline, not GitHub) is
// `unknown`, and "asked, nothing there" is `none` — two findings, not one.
//
// `gh` is replaced by a small fake on PATH / by path: no network, no real
// repository is asked.
//
// Red proof: on 1d8f6c5 (the base this was built on) neither
// src/prepush.mjs nor hooks/pre-push exists, and `mem hooks install
// --pre-push` is refused as an unknown flag — every probe here is red.
//
// Rule under test: nothing rather than wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTree } from './fixture/cleanup.mjs';
import * as prepush from '../src/prepush.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'hooks', 'pre-push');
const MEM = path.join(REPO, 'bin', 'mem');
const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);
const URL_GH = 'https://github.com/example/project.git';

const made = [];
process.once('exit', () => { for (const d of made) removeTree(d); });
function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/** A git repo whose origin/HEAD points at `main`. */
function repo() {
  const d = tempDir('cm-prepush-');
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', URL_GH]);
  execFileSync('git', ['-C', d, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return d;
}

/**
 * A fake `gh`; returns its directory, the program list for `prepush` (`gh`) and a call log.
 * Two forms of the same fake: `gh.js` (run as `node gh.js ...`, which every platform can execute --
 * Windows cannot run an extension-less script as a program) for the direct calls, and the bash
 * script `gh` for the hook tests, which find it on PATH (those tests do not run on Windows).
 */
function fakeGh({ stdout = '[]', code = 0, stderr = '' } = {}) {
  const dir = tempDir('cm-fakegh-');
  const js = path.join(dir, 'gh.js');
  fs.writeFileSync(path.join(dir, 'answer.json'), stdout);
  fs.writeFileSync(js, `const fs = require('node:fs'); const path = require('node:path');\n`
    + `fs.appendFileSync(path.join(__dirname, 'calls.txt'), process.argv.slice(2).join(' ') + '\\n');\n`
    + `process.stdout.write(fs.readFileSync(path.join(__dirname, 'answer.json'), 'utf8'));\n`
    + `${stderr ? `process.stderr.write(${JSON.stringify(`${stderr}\n`)});\n` : ''}process.exit(${code});\n`);
  const file = path.join(dir, 'gh');
  fs.writeFileSync(file, `#!/usr/bin/env bash\necho "$@" >> "${dir}/calls.txt"\n`
    + `cat "${dir}/answer.json"\n${stderr ? `echo ${JSON.stringify(stderr)} >&2\n` : ''}exit ${code}\n`);
  fs.chmodSync(file, 0o755);
  return { dir, gh: [process.execPath, js], calls: () => (fs.existsSync(path.join(dir, 'calls.txt')) ? fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8') : '') };
}

const runs = (...list) => JSON.stringify(list.map(([status, conclusion]) => ({ status, conclusion, workflowName: 'CI', url: 'https://example.invalid/run' })));
const toMain = `refs/heads/main ${SHA} refs/heads/main ${'b'.repeat(40)}\n`;

test('verdict: every state from the run list, green only when all finished and passed', () => {
  assert.equal(prepush.verdictFromRuns([]), 'none');
  assert.equal(prepush.verdictFromRuns(null), 'unknown');
  assert.equal(prepush.verdictFromRuns([{ status: 'completed', conclusion: 'success' }]), 'green');
  assert.equal(prepush.verdictFromRuns([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]), 'red');
  assert.equal(prepush.verdictFromRuns([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }]), 'pending');
  // An unknown conclusion is not a pass.
  assert.equal(prepush.verdictFromRuns([{ status: 'completed', conclusion: 'something-new' }]), 'pending');
  for (const s of ['green', 'red', 'pending', 'none', 'unknown']) assert.ok(prepush.STATES.includes(s));
});

test('POSITIVE: a green answer from gh is reported green, and gh was asked for the exact commit', () => {
  const r = repo();
  const g = fakeGh({ stdout: runs(['completed', 'success'], ['completed', 'skipped']) });
  const c = prepush.checkPush(r, { remote: 'origin', url: URL_GH, input: toMain, gh: g.gh });
  assert.equal(c.results.length, 1);
  assert.equal(c.results[0].state, 'green');
  assert.match(g.calls(), new RegExp(`--commit ${SHA}`));
  assert.match(g.calls(), /--repo example\/project/);
  assert.ok(!c.lines.join('\n').includes('warning'), 'a green push should not warn');
});

test('red, pending and none each warn — and say the push goes ahead', () => {
  const r = repo();
  for (const [answer, state, words] of [
    [runs(['completed', 'failure']), 'red', /CI FAILED/],
    [runs(['in_progress', null]), 'pending', /still running/],
    ['[]', 'none', /no CI run for this exact commit/],
  ]) {
    const g = fakeGh({ stdout: answer });
    const c = prepush.checkPush(r, { remote: 'origin', url: URL_GH, input: toMain, gh: g.gh });
    assert.equal(c.results[0].state, state);
    const text = c.lines.join('\n');
    assert.match(text, words);
    assert.match(text, /warning, not a block/);
  }
});

test('could not ask is unknown, never green and never none: gh missing, gh failing, not JSON, not GitHub', () => {
  const r = repo();
  const missing = prepush.checkPush(r, { remote: 'origin', url: URL_GH, input: toMain, gh: path.join(tempDir('cm-nogh-'), 'gh') });
  assert.equal(missing.results[0].state, 'unknown');
  assert.match(missing.lines[0], /gh is not installed/);
  const failing = prepush.checkPush(r, { remote: 'origin', url: URL_GH, input: toMain,
    gh: fakeGh({ stdout: '', code: 4, stderr: 'error connecting to api.github.com' }).gh });
  assert.equal(failing.results[0].state, 'unknown');
  assert.match(failing.lines[0], /gh failed/);
  const garbage = prepush.checkPush(r, { remote: 'origin', url: URL_GH, input: toMain, gh: fakeGh({ stdout: 'not json' }).gh });
  assert.equal(garbage.results[0].state, 'unknown');
  const g = fakeGh({ stdout: runs(['completed', 'success']) });
  const elsewhere = prepush.checkPush(r, { remote: 'origin', url: '/srv/git/memory.git', input: toMain, gh: g.gh });
  assert.equal(elsewhere.results[0].state, 'unknown');
  assert.match(elsewhere.lines[0], /not on GitHub/);
  assert.equal(g.calls(), '', 'gh must not be asked about a non-GitHub remote');
});

test('only the default branch is checked; feature branches, tags and deletions are not', () => {
  const r = repo();
  const g = fakeGh({ stdout: '[]' });
  const input = [
    `refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`,
    `refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}`,
    `(delete) ${ZERO} refs/heads/main ${SHA}`,
  ].join('\n');
  const c = prepush.checkPush(r, { remote: 'origin', url: URL_GH, input, gh: g.gh });
  assert.deepEqual(c.results, []);
  assert.equal(g.calls(), '');
  // Positive control: the same probe on a push to main does ask.
  const c2 = prepush.checkPush(r, { remote: 'origin', url: URL_GH, input: toMain, gh: g.gh });
  assert.equal(c2.results.length, 1);
});

test('the default branch is read from <remote>/HEAD, not assumed', () => {
  const r = repo();
  execFileSync('git', ['-C', r, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  assert.deepEqual(prepush.defaultBranches(r, 'origin'), ['trunk']);
  assert.deepEqual(prepush.defaultBranches(r, 'nowhere'), ['main', 'master']);
});

test('githubRepo reads https and ssh remotes, and nothing else', () => {
  assert.equal(prepush.githubRepo('https://github.com/o/r.git'), 'o/r');
  assert.equal(prepush.githubRepo('git@github.com:o/r.git'), 'o/r');
  assert.equal(prepush.githubRepo('https://github.com/o/r'), 'o/r');
  assert.equal(prepush.githubRepo('/srv/git/r.git'), null);
  assert.equal(prepush.githubRepo('https://gitlab.com/o/r.git'), null);
});

function runHook(cwd, input, { pathDirs = [], pkg = null } = {}) {
  const env = { ...process.env, PATH: [...pathDirs, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) };
  if (pkg) env.CHEAP_MEM_PKG = pkg; else delete env.CHEAP_MEM_PKG;
  return spawnSync('bash', [HOOK, 'origin', URL_GH], { cwd, input, env, encoding: 'utf8' });
}

test('the hook script: warns on stderr and exits 0 for red; exits 0 and stays quiet-green for green', { skip: process.platform === 'win32' }, () => {
  const r = repo();
  const red = runHook(r, toMain, { pathDirs: [fakeGh({ stdout: runs(['completed', 'failure']) }).dir] });
  assert.equal(red.status, 0, 'the hook blocked a push');
  assert.match(red.stderr, /CI FAILED/);
  const green = runHook(r, toMain, { pathDirs: [fakeGh({ stdout: runs(['completed', 'success']) }).dir] });
  assert.equal(green.status, 0);
  assert.match(green.stderr, /CI is green/);
});

test('the hook script fails open but loudly: no gh -> unknown; a broken check -> unknown, exit 0 both', { skip: process.platform === 'win32' }, () => {
  const r = repo();
  const noGh = runHook(r, toMain, { pathDirs: [tempDir('cm-empty-path-')] });
  assert.equal(noGh.status, 0);
  assert.match(noGh.stderr, /CI status unknown/);
  assert.doesNotMatch(noGh.stderr, /green/);
  const broken = runHook(r, toMain, { pkg: tempDir('cm-no-pkg-') });
  assert.equal(broken.status, 0);
  assert.match(broken.stderr, /CI status unknown — the check did not finish/);
});

test('mem hooks install --pre-push arms it (opt-in); without the flag there is no pre-push', { skip: process.platform === 'win32' }, () => {
  const env = { ...process.env };
  delete env.CHEAP_MEM_ROOT;
  const mk = () => {
    const root = tempDir('cm-prepush-mem-');
    const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { env, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    execFileSync('git', ['init', '-q', root]); // the hook lives in a git repository; init does not make one
    return root;
  };
  const hooksDir = (root) => execFileSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();

  const plain = mk();
  const a = spawnSync(process.execPath, [MEM, 'hooks', 'install', '--root', plain], { env, encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.ok(fs.existsSync(path.join(hooksDir(plain), 'pre-commit')), 'positive control: the install wrote its pre-commit');
  assert.ok(!fs.existsSync(path.join(hooksDir(plain), 'pre-push')), 'pre-push armed without being asked');

  const opted = mk();
  const b = spawnSync(process.execPath, [MEM, 'hooks', 'install', '--pre-push', '--root', opted], { env, encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr + b.stdout);
  const shim = path.join(hooksDir(opted), 'pre-push');
  assert.ok(fs.existsSync(shim), 'pre-push not written');
  assert.match(fs.readFileSync(shim, 'utf8'), /hooks\/pre-push/);
  assert.match(b.stdout, /warning only/);
});
