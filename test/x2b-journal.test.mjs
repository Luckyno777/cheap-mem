// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/x2b-journal.test.mjs — X2b: the before-change and session-start
// occasions write their journal line.
//
// The journal vocabulary had `before-edit` (and a latency budget for it)
// and NO writer; the session start printed straight into the context and
// left no trace. Red proof against the fixed start commit
// 201a087f2d2f634f9b061f4681bd1f78f27408be: the old hooks, run on the same
// input, leave no `.pipeline/injections.jsonl`. The positive control is the
// new hook on that very input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';
import * as latency from '../src/latencybudget.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BEFORE = path.join(REPO, 'bin', 'mem-before-edit');
const START = path.join(REPO, 'install', 'hooks', 'session-start.sh');
const OLD = '201a087f2d2f634f9b061f4681bd1f78f27408be';

const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };

function memory() {
  const root = temp('cm-x2b-j-');
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  execFileSync('node', [MEM, '--root', root, 'log', 'error', '--title', 'install/claude-code.sh does not quote the bash path',
    '--text', 'On Windows bash sits in Program Files; without quotes the hook breaks.', '--class', 'unquoted-path'], { stdio: 'ignore' });
  return root;
}
const edit = (file, session = 's1') => JSON.stringify({ session_id: session, tool_name: 'Edit', tool_input: { file_path: file } });
function runBefore(json, root, script = BEFORE, env = {}) {
  return spawnSync('bash', [script], {
    input: json, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '', ...env },
  });
}
const lines = (root) => injection.read(root).lines;

test('before-edit: a shown block books one line (occasion before-edit, reason null, hits, session, duration)', () => {
  const root = memory();
  const r = runBefore(edit('/home/x/cheap-mem/install/claude-code.sh'), root);
  assert.ok(r.stdout, `the hook was silent: ${r.stderr}`);
  const l = lines(root);
  assert.equal(l.length, 1);
  assert.equal(l[0].occasion, 'before-edit');
  assert.equal(l[0].reason, null);
  assert.ok(l[0].hits >= 1 && l[0].bytes > 0);
  assert.equal(l[0].session, 's1');
  assert.ok(Number.isFinite(l[0].duration_ms), 'the hook time is measured, not left null');
  assert.deepEqual(l[0].sources, [], 'no sources: this hook works on rendered text');
});

test('before-edit: the nothing is booked too (empty), and the second look at a file books already-shown', () => {
  const root = memory();
  assert.equal(runBefore(edit('/x/src/nothing-here.mjs'), root).stdout, '');
  runBefore(edit('/home/x/cheap-mem/install/claude-code.sh'), root);
  runBefore(edit('/home/x/cheap-mem/install/claude-code.sh'), root);
  assert.deepEqual(lines(root).map((l) => l.reason), ['empty', null, 'already-shown']);
  assert.ok(lines(root).every((l) => l.occasion === 'before-edit'));
});

test('before-edit: switched off or no readable path books nothing (the hook did not run)', () => {
  const root = memory();
  runBefore(edit('/home/x/cheap-mem/install/claude-code.sh'), root, BEFORE, { MEM_BEFORE_EDIT_OFF: '1' });
  runBefore('{"session_id":"s","tool_name":"Edit","tool_input":{}}', root);
  assert.equal(lines(root).length, 0);
});

test('vocabulary: the two new occasions and reasons are in the closed lists, and after-error has a budget', () => {
  const l = injection.buildLine({ occasion: 'session-start' });
  assert.equal(l.occasion, 'session-start');
  assert.equal(injection.buildLine({ occasion: 'after-error', reason: 'interrupt' }).reason, 'interrupt');
  assert.equal(injection.buildLine({ occasion: 'after-error', reason: 'no-input' }).reason, 'no-input');
  assert.equal(injection.buildLine({ occasion: 'typo' }).occasion, 'unknown', 'a typo must still become unknown');
  assert.equal(latency.BUDGET_MS['after-error'], 2500);
});

test('RED at 201a087f: the old before-edit hook wrote no journal line on the same input', () => {
  const dir = temp('cm-x2b-oldbe-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'mem-before-edit'),
    execFileSync('git', ['show', `${OLD}:bin/mem-before-edit`], { cwd: REPO, encoding: 'utf8' }));
  fs.symlinkSync(path.join(REPO, 'bin', '_portable.sh'), path.join(dir, 'bin', '_portable.sh'));
  fs.symlinkSync(MEM, path.join(dir, 'bin', 'mem'));
  fs.symlinkSync(path.join(REPO, 'src'), path.join(dir, 'src'));
  const root = memory();
  const old = runBefore(edit('/home/x/cheap-mem/install/claude-code.sh'), root, path.join(dir, 'bin', 'mem-before-edit'));
  assert.ok(old.stdout, 'the old hook must still show its block (else this proves nothing)');
  assert.equal(fs.existsSync(path.join(root, '.pipeline', 'injections.jsonl')), false, 'the old hook booked a line');
  // positive control: the new hook on the same input
  runBefore(edit('/home/x/cheap-mem/install/claude-code.sh', 's2'), root);
  assert.equal(lines(root).length, 1);
});

// --- session start ------------------------------------------------------------

/** A memory with a stub `bin/mem` (as test/today-session-start.test.mjs does): the hook's own behaviour, not a grep. */
function stage() {
  const root = temp('cm-x2b-ss-');
  spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'mem'), 'process.exit(0);\n');
  return root;
}
const startRun = (script, root, input, env = {}) => spawnSync('bash', [script], {
  input, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_CODE: REPO, MEM_HOOK_OFF: '', ...env },
});

test('session-start: one line per start, occasion session-start, reason null, the session id from the hook JSON', () => {
  const root = stage();
  const r = startRun(START, root, JSON.stringify({ session_id: 'abc', source: 'startup' }));
  assert.match(r.stdout, /cheap-mem attached/, r.stderr);
  const l = lines(root);
  assert.equal(l.length, 1);
  assert.equal(l[0].occasion, 'session-start');
  assert.equal(l[0].reason, null);
  assert.equal(l[0].session, 'abc');
  assert.equal(l[0].bytes, null, 'bytes are not counted for the start block: not measured is not 0');
  assert.ok(Number.isFinite(l[0].duration_ms));
});

test('session-start: without hook JSON the line still books (session null); switched off books nothing', () => {
  const root = stage();
  startRun(START, root, '');
  assert.equal(lines(root).length, 1);
  assert.equal(lines(root)[0].session, null);
  const off = stage();
  startRun(START, off, '{}', { MEM_HOOK_OFF: '1' });
  assert.equal(lines(off).length, 0);
});

test('RED at 201a087f: the old start hook left no journal line', () => {
  const dir = temp('cm-x2b-oldss-');
  const old = path.join(dir, 'session-start.sh');
  fs.writeFileSync(old, execFileSync('git', ['show', `${OLD}:install/hooks/session-start.sh`], { cwd: REPO, encoding: 'utf8' }));
  const root = stage();
  const r = startRun(old, root, JSON.stringify({ session_id: 'abc' }));
  assert.match(r.stdout, /cheap-mem attached/, 'the old hook must still run (else this proves nothing)');
  assert.equal(fs.existsSync(path.join(root, '.pipeline', 'injections.jsonl')), false);
  // positive control: the new hook, same memory
  startRun(START, root, JSON.stringify({ session_id: 'abc' }));
  assert.equal(lines(root).length, 1);
});
