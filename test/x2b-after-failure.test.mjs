// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/x2b-after-failure.test.mjs — X2b: the after-error occasion has a
// hook (PostToolUseFailure, matcher Bash|Edit|Write).
//
// Before this, only `mem-catch-fail` (PostToolUse, Bash) existed, and it
// catches the OPPOSITE case: a failure the exit code hid. A command that
// really exited nonzero got no recall at all. Red proof against the fixed
// start commit 201a087f2d2f634f9b061f4681bd1f78f27408be (never a
// merge-base): there the installer has no PostToolUseFailure entry, and
// the old catch-fail hook stays silent on a real failure. The positive
// control shows the same input DOES fire the new hook.
//
// The installer is only ever run with HOME and CLAUDE_HOME pointing into a
// temp dir, never the real ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';
import * as af from '../src/afterfailure.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'bin', 'mem-after-failure');
const OLD = '201a087f2d2f634f9b061f4681bd1f78f27408be';

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };

function build() {
  const root = temp('cm-x2b-af-');
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  execFileSync('node', [MEM, '--root', root, 'log', 'error',
    '--title', 'lockfile race - two runs overwrote it',
    '--text', 'the sperrdatei-rennen probe failed because two test runs overwrote the same lock file at once',
    '--class', 'race'], { stdio: 'ignore' });
  execFileSync('node', [MEM, '--root', root, 'log', 'decision',
    '--topic', 'lockfile race handling', '--choice', 'serialize the two test runs on one lock file',
    '--why', 'two runs overwrote the same lock file'], { stdio: 'ignore' });
  return root;
}

const failure = ({ session = 's1', tool = 'Bash', command = 'npm test', error = 'Exit code 1\nnot ok 2 - lockfile race: two runs overwrote the lock file', extra = {} } = {}) => JSON.stringify({
  session_id: session, hook_event_name: 'PostToolUseFailure', tool_name: tool,
  tool_input: { command }, error, ...extra,
});

function run(json, root, env = {}, script = HOOK) {
  return spawnSync('bash', [script], {
    input: json, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_AFTER_FAILURE_OFF: '', MEM_HOOK_OFF: '', ...env },
  });
}
const journal = (root) => injection.read(root).lines;

test('THE CASE: a command that really failed gets the known error back, and one journal line', () => {
  const root = build();
  const r = run(failure(), root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout, 'a real failure stayed silent');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(out.hookSpecificOutput.additionalContext, /lockfile race/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /serialize the two test runs/,
    'only the error and learning lanes answer a failure, not a decision');
  const lines = journal(root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].occasion, 'after-error');
  assert.equal(lines[0].reason, null, 'reason null = delivered');
  assert.ok(lines[0].hits >= 1 && lines[0].bytes > 0);
  assert.equal(lines[0].session, 's1');
});

test('an Edit or Write that failed is covered too (no command word, the error text is the question)', () => {
  const root = build();
  const r = run(failure({ tool: 'Edit', error: 'lockfile race: two runs overwrote the lock file' }), root);
  assert.ok(r.stdout, 'an Edit failure stayed silent');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /lockfile race/);
});

test('the nothing is booked too: an unrelated failure is silent AND has a reason in the journal', () => {
  const root = build();
  const r = run(failure({ command: 'zzzq', error: 'qqqxx wwwvv unrelated gibberish that no entry contains' }), root);
  assert.equal(r.stdout, '');
  const lines = journal(root);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].occasion, 'after-error');
  assert.ok(['empty', 'too-weak'].includes(lines[0].reason), `reason ${lines[0].reason}`);
});

test('interrupted is not failed, and a failure without text is the outage: each its own reason, no search', () => {
  const root = build();
  const a = run(failure({ error: '', extra: { is_interrupt: true } }), root);
  assert.equal(a.stdout, '');
  const b = run(failure({ session: 's2', error: '' }), root);
  assert.equal(b.stdout, '');
  assert.deepEqual(journal(root).map((l) => l.reason), ['interrupt', 'no-input']);
});

test('LATCH: the same failure in the same session shows once; a failure that found nothing does not use the claim up', () => {
  const root = build();
  assert.ok(run(failure(), root).stdout, 'precondition: the first call fires');
  assert.equal(run(failure(), root).stdout, '', 'the same failure fired twice in one session');
  assert.equal(journal(root).at(-1).reason, 'already-shown');
  // nothing found -> claim handed back -> once an entry exists, the retry sees it
  const fresh = temp('cm-x2b-af-');
  execFileSync('node', [MEM, '--root', fresh, 'init'], { stdio: 'ignore' });
  assert.equal(run(failure(), fresh).stdout, '');
  execFileSync('node', [MEM, '--root', fresh, 'log', 'error', '--title', 'lockfile race',
    '--text', 'two runs overwrote the same lock file', '--class', 'race'], { stdio: 'ignore' });
  assert.ok(run(failure(), fresh).stdout, 'a failure with no hit counted as handled');
});

test('switches: MEM_AFTER_FAILURE_OFF and MEM_HOOK_OFF are silent and book nothing', () => {
  const root = build();
  assert.equal(run(failure(), root, { MEM_AFTER_FAILURE_OFF: '1' }).stdout, '');
  assert.equal(run(failure(), root, { MEM_HOOK_OFF: '1' }).stdout, '');
  assert.equal(journal(root).length, 0);
  assert.ok(run(failure(), root).stdout, 'positive control: without the switches the same input fires');
});

test('the module: parse reads the documented field first, and picks only the two lanes', () => {
  assert.equal(af.parseHook(failure()).kind, 'failure');
  assert.equal(af.parseHook(failure()).query.split(' ')[0], 'npm', 'the first word of a Bash command leads the question');
  assert.equal(af.parseHook('{"tool_name":"Write","error":"disk full"}').query, 'disk full');
  assert.equal(af.parseHook('not json'), null);
  const hits = JSON.stringify({ hits: [
    { source: 'global/decisions.jsonl', line: 1, score: 9, entry: { title: 'a decision' } },
    { source: 'global/errors.jsonl', line: 2, score: 9, entry: { title: 'an error' } },
    { source: 'global/learnings.jsonl', line: 3, score: 1, entry: { title: 'too weak' } },
  ] });
  const p = af.pick(hits);
  assert.equal(p.lines.length, 1);
  assert.match(p.lines[0], /an error/);
  assert.equal(p.seen, 2, 'seen counts the two lanes only');
});

// --- the installer (HOME in a temp dir, never the real ~/.claude) ------------

function install() {
  const tmp = temp('cm-x2b-inst-');
  const root = path.join(tmp, 'memory');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  execFileSync('bash', [path.join(REPO, 'install', 'claude-code.sh')], {
    env: { ...process.env, HOME: home, CLAUDE_HOME: path.join(home, '.claude'), CHEAP_MEM_ROOT: root },
    stdio: 'ignore',
  });
  return { tmp, root, home, hooks: path.join(home, '.claude', 'hooks'),
    cfg: JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')) };
}

test('the installer registers PostToolUseFailure with the matcher, once, and the hook file is there', () => {
  const i = install();
  const entries = i.cfg.hooks.PostToolUseFailure ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, 'Bash|Edit|Write');
  assert.match(entries[0].hooks[0].command, /cheap-mem-after-failure\.sh/);
  assert.ok(fs.existsSync(path.join(i.hooks, 'cheap-mem-after-failure.sh')));
  // a re-install does not leave a second entry behind
  execFileSync('bash', [path.join(REPO, 'install', 'claude-code.sh')], {
    env: { ...process.env, HOME: i.home, CLAUDE_HOME: path.join(i.home, '.claude'), CHEAP_MEM_ROOT: i.root },
    stdio: 'ignore',
  });
  const again = JSON.parse(fs.readFileSync(path.join(i.home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(again.hooks.PostToolUseFailure.length, 1);
  // and PostToolUse (the catch-fail hook) is still its own, separate entry
  assert.ok(again.hooks.PostToolUse.some((e) => JSON.stringify(e).includes('cheap-mem-catch-fail.sh')));
});

test('the INSTALLED hook (a copy in the hooks dir) works end to end', () => {
  const i = install();
  // the memory carries no tool: the installed copy must find the code
  // through CHEAP_MEM_CODE, and its journal line lands in the memory
  execFileSync('node', [MEM, '--root', i.root, 'log', 'error', '--title', 'lockfile race',
    '--text', 'two runs overwrote the same lock file at once', '--class', 'race'], { stdio: 'ignore' });
  const r = run(failure(), i.root, { HOME: i.home }, path.join(i.hooks, 'cheap-mem-after-failure.sh'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout, `the installed copy stayed silent: ${r.stderr}`);
  assert.equal(journal(i.root).at(-1).occasion, 'after-error');
});

// --- red proof against the fixed start commit --------------------------------

test('RED at 201a087f: the old installer had no PostToolUseFailure hook, the old contract said partial', () => {
  const oldInstaller = execFileSync('git', ['show', `${OLD}:install/claude-code.sh`], { cwd: REPO, encoding: 'utf8' });
  const code = oldInstaller.split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
  assert.doesNotMatch(code, /upsertHook\('PostToolUseFailure'/);
  const oldContract = execFileSync('git', ['show', `${OLD}:src/integrationcontract.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.match(oldContract, /AFTER_ERROR\]: \{\s*status: STATUS\.PARTIAL/);
  // positive control: the same reader sees the registration in today's installer
  const now = fs.readFileSync(path.join(REPO, 'install', 'claude-code.sh'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
  assert.match(now, /upsertHook\('PostToolUseFailure', 'after-failure', 'Bash\|Edit\|Write'\)/);
});

test('RED at 201a087f: the old catch-fail hook stays silent on a real failure, the new hook does not', () => {
  const dir = temp('cm-x2b-old-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'mem-catch-fail'),
    execFileSync('git', ['show', `${OLD}:bin/mem-catch-fail`], { cwd: REPO, encoding: 'utf8' }));
  fs.symlinkSync(path.join(REPO, 'bin', '_portable.sh'), path.join(dir, 'bin', '_portable.sh'));
  fs.symlinkSync(MEM, path.join(dir, 'bin', 'mem'));
  fs.symlinkSync(path.join(REPO, 'src'), path.join(dir, 'src'));
  const root = build();
  const real = failure();
  const old = run(real, root, {}, path.join(dir, 'bin', 'mem-catch-fail'));
  assert.equal(old.status, 0, old.stderr);
  assert.equal(old.stdout, '', 'the old hook fired on a PostToolUseFailure input');
  assert.ok(run(real, root).stdout, 'positive control: the new hook fires on the same input');
});

test('the INSTALLED catch-fail hook delivers now (red at 201a087f: the installed copy could not source _portable.sh)', () => {
  const swallowed = JSON.stringify({
    session_id: 'sw', tool_name: 'Bash', tool_input: { command: 'npm test | tail' },
    tool_response: { stdout: 'not ok 2 - lockfile race two runs overwrote the lock file\n# fail 1', stderr: '' },
  });
  // The old installed copy, rebuilt the way the old installer built it:
  // the script text itself, with the memory root prepended, in a hooks dir.
  const root = build();
  fs.symlinkSync(path.join(REPO, 'bin'), path.join(root, 'bin'));
  fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'));
  const hooks = temp('cm-x2b-oldhooks-');
  const oldBody = execFileSync('git', ['show', `${OLD}:bin/mem-catch-fail`], { cwd: REPO, encoding: 'utf8' })
    .split('\n').slice(1).join('\n');
  fs.writeFileSync(path.join(hooks, 'cheap-mem-catch-fail.sh'),
    `#!/usr/bin/env bash\nexport CHEAP_MEM_ROOT='${root}'\n${oldBody}`);
  const old = run(swallowed, root, {}, path.join(hooks, 'cheap-mem-catch-fail.sh'));
  assert.equal(old.stdout, '', 'the old installed copy delivered (then this red proof proves nothing)');
  // today's installer
  const i = install();
  execFileSync('node', [MEM, '--root', i.root, 'log', 'error', '--title', 'lockfile race',
    '--text', 'two runs overwrote the same lock file at once', '--class', 'concurrency'], { stdio: 'ignore' });
  const now = run(swallowed, i.root, { HOME: i.home }, path.join(i.hooks, 'cheap-mem-catch-fail.sh'));
  assert.ok(now.stdout, `the installed catch-fail hook is still mute: ${now.stderr}`);
  assert.equal(JSON.parse(now.stdout).hookSpecificOutput.hookEventName, 'PostToolUse');
});
