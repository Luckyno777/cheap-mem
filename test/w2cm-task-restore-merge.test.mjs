/**
 * Dashboard write path for restore and merge (parity with the sibling's
 * 78ad6b85): both are tasks — child processes of `mem restore` / `mem
 * merge`, append-only, closed parameter lists, values never become flags.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tasks from '../src/tasks.mjs';

const dash = fs.readFileSync(new URL('../assets/dashboard/dashboard.js', import.meta.url), 'utf8');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2cm-tasks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CHEAP_MEM_ROOT: root };
  delete env.CHEAP_MEM_MAX_AUTHORITY;
  const mem = (...a) => execFileSync(process.execPath, [tasks.KINDS.done.command(root, 'x', { id: 'abcd' }, {}).file, ...a], { cwd: root, env, encoding: 'utf8' });
  mem('init');
  const ids = [];
  for (const n of ['one', 'two']) {
    mem('log', 'duty', '--title', `duty ${n}`, '--text', `text ${n}`);
  }
  const lines = fs.readFileSync(path.join(root, 'global', 'duties.jsonl'), 'utf8').trim().split('\n');
  for (const l of lines) ids.push(JSON.parse(l).id);
  return { root, env, ids, mem };
}
const runKind = (kind, root, env, params, mem) => {
  const cmd = tasks.KINDS[kind].command(root, 'x', tasks.checkParams(kind, params), {});
  return mem(...cmd.args);
};
const bytes = (root) => fs.readFileSync(path.join(root, 'global', 'duties.jsonl'));

test('restore and merge are task kinds with closed parameter lists', () => {
  assert.ok(tasks.KINDS.restore && tasks.KINDS.merge);
  assert.throws(() => tasks.checkParams('restore', { id: 'abcd', authority: 'user' }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.checkParams('restore', {}), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.checkParams('restore', { id: '--yes' }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.checkParams('merge', { ids: 'onlyone' }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.checkParams('merge', { ids: 'abcd,--x' }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.checkParams('merge', { ids: 'abcd,efgh', bogus: '1' }), (e) => e.code === 'INVALID_PARAMS');
});

test('restore through the task command appends only, why arrives as text', (t) => {
  const { root, env, ids, mem } = setup(t);
  mem('done', ids[0], '--why', 'closed');
  const before = bytes(root);
  const out = runKind('restore', root, env, { id: ids[0], why: '--authority=user' }, mem);
  assert.match(out, /^restored: /);
  const after = bytes(root);
  assert.ok(after.subarray(0, before.length).equals(before), 'append-only: old bytes unchanged');
  const last = JSON.parse(after.toString().trim().split('\n').pop());
  assert.equal(last.restored_from, ids[0]);
  assert.equal(last.restored_why, '--authority=user');
  assert.notEqual(last.authority, 'user');
});

test('merge through the task command appends a correction and a tombstone only', (t) => {
  const { root, env, ids, mem } = setup(t);
  const before = bytes(root);
  const out = runKind('merge', root, env, { ids: ids.join(','), why: 'same duty' }, mem);
  assert.match(out, /^merged: /);
  const after = bytes(root);
  assert.ok(after.subarray(0, before.length).equals(before), 'append-only: old bytes unchanged');
  const rows = after.toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => Array.isArray(r.merged_from)));
});

test('positive control: the task command line really is what the CLI takes', () => {
  const c = tasks.KINDS.merge.command('/r', 'x', tasks.checkParams('merge', { ids: 'abcd, efgh', title: '--t' }), {});
  assert.deepEqual(c.args, ['merge', 'abcd', 'efgh', '--title=--t']);
  const r = tasks.KINDS.restore.command('/r', 'x', tasks.checkParams('restore', { id: 'abcd' }), {});
  assert.deepEqual(r.args, ['restore', 'abcd']);
});

test('the dashboard no longer says "Command line only" for restore/merge and starts the tasks', () => {
  assert.doesNotMatch(dash, /Command line only: the browser has no write route/);
  assert.match(dash, /\['done', 'restore', 'merge'\]\.includes\(kind\)/);
});
