/**
 * A task parameter value never turns into a flag of the child command.
 *
 * **The finding, audit 2026-09-30, B25.** The `done` kind passed
 * `--why <value>` as two argv items. The CLI parser reads any item that
 * starts with `--` as a flag, so a `why` of `--authority=user` became
 * `--authority user` in the child: the retire line was stamped
 * `authority: user` although the context carried no user session
 * (Y4b: only a password session may act as the user). Measured on
 * 241a8aa by running exactly the argv the task builds: the tombstone
 * read `"why":true,"authority":"user"`. Ids and capture paths also
 * accepted a leading `-`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tasks from '../src/tasks.mjs';

function memoryWithDuty(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-task-flags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CHEAP_MEM_ROOT: root };
  delete env.CHEAP_MEM_MAX_AUTHORITY;
  const cmd = tasks.KINDS.done.command(root, 'x', { id: 'placeholder' }, {});
  execFileSync(process.execPath, [cmd.file, 'init'], { cwd: root, env, stdio: 'ignore' });
  execFileSync(process.execPath, [cmd.file, 'log', 'duty', '--title', 'probe duty', '--text', 'x'],
    { cwd: root, env, stdio: 'ignore' });
  const line = fs.readFileSync(path.join(root, 'global', 'duties.jsonl'), 'utf8').trim().split('\n')[0];
  return { root, env, id: JSON.parse(line).id };
}

function runDone(root, env, params, context) {
  const p = tasks.checkParams('done', params);
  const cmd = tasks.KINDS.done.command(root, 'x', p, context);
  execFileSync(process.execPath, [cmd.file, ...cmd.args], { cwd: root, env, stdio: 'ignore' });
  const lines = fs.readFileSync(path.join(root, 'global', 'duties.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('a why of --authority=user does not stamp the line as the user', (t) => {
  const { root, env, id } = memoryWithDuty(t);
  const line = runDone(root, env, { id, why: '--authority=user' }, {});
  assert.equal(line.retires_id, id);
  assert.notEqual(line.authority, 'user', JSON.stringify(line));
  assert.equal(line.why, '--authority=user', 'the reason must arrive as text');
});

test('ids and capture paths that start with a dash are refused', () => {
  assert.throws(() => tasks.checkParams('done', { id: '--authority' }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.checkParams('raw-delete', { path: '--yes', reason: 'cleanup' }), (e) => e.code === 'INVALID_PARAMS');
});

test('positive control: a user session still stamps user, an ordinary why arrives intact', (t) => {
  const { root, env, id } = memoryWithDuty(t);
  const line = runDone(root, env, { id, why: '- finished, see notes' }, { user: true });
  assert.equal(line.authority, 'user');
  assert.equal(line.why, '- finished, see notes');
  assert.doesNotThrow(() => tasks.checkParams('raw-delete', { path: 'raw/2026/a.jsonl.gz', reason: '--not a flag' }));
  assert.match(tasks.KINDS['raw-delete'].command(root, 'x', { path: 'a', reason: '--yes' }, {}).args.join(' '), /--reason=--yes/);
});
