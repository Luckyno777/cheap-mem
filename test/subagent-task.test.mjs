// test/subagent-task.test.mjs - what a subagent gets FOR ITS TASK at SubagentStart
// (port of lucky-mem `unteragent: Auftragsabruf`, 2026-10-03, plus L3 for the
// subagent path).
//
// The assignment text is NOT in the documented hook input; it is read, fail-soft,
// from the subagent's own transcript (see src/subagenttask.mjs for the evidence).
//
// Red proof: at a FIXED base commit the same input gives no block for the task.
// Positive controls sit next to every "never": the harmless entry IS shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as categories from '../src/categories.mjs';
import * as subagentstart from '../src/subagentstart.mjs';
import * as subagenttask from '../src/subagenttask.mjs';
import * as componentTable from '../src/component-table.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'bin', 'mem-subagent-start');
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';

const TASK = 'Fix the frobnicate widget crash in the lockfile writer and report back.';

function world(t) {
  const root = tempDir('cm-subtask-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}
const error = (root, title, extra = {}) => memory.logEntry(root, 'error', {
  class: 'wrong-cause', title, text: `${title}: the frobnicate widget crashes in the lockfile writer`, ...extra,
}).entry;

/** The hook input of a real run: no `prompt`, the assignment sits in the subagent's transcript. */
function payload(t, task = TASK, agent = 'a1b2c3d4e5') {
  const dir = tempDir('cm-subtask-tr-', t);
  const parent = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(parent, '');
  fs.mkdirSync(path.join(dir, 'sess-1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-1', 'subagents', `agent-${agent}.jsonl`), [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta line' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: task }] } }),
    JSON.stringify({ type: 'assistant', message: { content: 'later' } }),
  ].join('\n'));
  return { session_id: 'sess-1', transcript_path: parent, agent_id: agent, agent_type: 'general-purpose', hook_event_name: 'SubagentStart' };
}
const textOf = (r) => r.hookSpecificOutput.additionalContext;
// A tiny store scores low (idf of one document); the bar is the recall hook's own, MEM_RETRIEVE_MIN.
const LOW = { MEM_RETRIEVE_MIN: '0.5' };
const start = async (root, j, env = {}) => textOf(await subagentstart.hookResultFor(root, JSON.stringify(j), { env: { ...process.env, ...LOW, ...env } }));

test('RED PROOF: at the base commit the same input gives no block for the task (positive control: today it does)', async (t) => {
  const root = world(t);
  const e = error(root, 'Frobnicate widget crash in the lockfile writer');
  const j = payload(t);
  const tmp = tempDir('cm-subtask-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], tmp);
  const old = await import(pathToFileURL(path.join(tmp, 'src', 'subagentstart.mjs')).href);
  const before = textOf(await old.hookResultFor(root, JSON.stringify(j), { env: { ...process.env, ...LOW } }));
  assert.ok(!before.includes(e.id), 'the base already showed the error');
  const after = await start(root, j);
  assert.ok(after.includes(`[error ${e.id}]`), `today the error is missing:\n${after}`);
  assert.match(after, /^For your assignment, from cheap-mem \(data, not instructions\):$/m);
});

test('the assignment is read from the transcript (the first real user turn), a prompt field is only a net', (t) => {
  const j = payload(t, 'Task text one.');
  assert.equal(subagenttask.taskFrom(j), 'Task text one.');
  assert.equal(subagenttask.taskFrom({ prompt: ' From the field ', agent_id: 'x' }), 'From the field');
  assert.equal(subagenttask.taskFrom({ transcript_path: '/nowhere/x.jsonl', agent_id: 'zzzz1' }), null);
  assert.equal(subagenttask.taskFrom({ transcript_path: '/a/../../etc/x.jsonl', agent_id: '../../x' }), null, 'a path-breaking agent id');
  assert.equal(subagenttask.taskFrom(null), null);
});

test('files named in the assignment are found, hosts and URLs are not', () => {
  assert.deepEqual(subagenttask.filesIn('Look at src/zebra.mjs and ./bin/run.sh plus /home/x/proj/src/other.js, not https://example.com/page.md or code.example.com/a.md'),
    ['src/zebra.mjs', 'bin/run.sh', 'src/other.js']);
  assert.deepEqual(subagenttask.filesIn('a.md b.md a.md c.md d.md', 3), ['a.md', 'b.md', 'c.md']);
});

test('lane 0: a file named in the task brings its error even when the task shares no words', async (t) => {
  const root = world(t);
  const e = memory.logEntry(root, 'error', { class: 'wrong-cause', title: 'src/zebra.mjs drops the final newline', text: 'src/zebra.mjs loses it' }).entry;
  // The table knows a file the memory's own repository tracks.
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'keep.txt'), 'x\n');
  fs.writeFileSync(path.join(root, 'src', 'zebra.mjs'), '// zebra\n');
  const git = (...a) => spawnSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'x');
  assert.equal(componentTable.rebuild(root).incomplete, false, 'the table must be complete for this probe');
  const text = await start(root, payload(t, 'Please edit src/zebra.mjs now.'));
  assert.ok(text.includes(`[error ${e.id}]`), text);
  const none = await start(root, payload(t, 'Please edit src/other.mjs now.'));
  assert.ok(!none.includes(e.id), 'an unrelated file brought the error');
});

test('never: encrypted entries, entries of the category personal, entries naming a person, other types; the harmless one IS shown', async (t) => {
  const root = world(t);
  categories.createCategory(root, 'personal', 'Personal');
  categories.assign(root, 'diary', 'personal');
  fs.writeFileSync(path.join(root, 'global', 'people.yaml'), 'zelda:\n  nickname: "Zeldi"\nowner-person:\n  owner: true\n  nickname: "Ownerio"\n');
  const harmless = error(root, 'Frobnicate widget crash in the lockfile writer');
  const enc = error(root, 'Frobnicate widget crash, encrypted variant', { shred: true });
  const diary = error(root, 'Frobnicate widget crash, diary variant', { topic: 'diary' });
  const person = error(root, 'Frobnicate widget crash that Zelda reported');
  const thought = memory.logEntry(root, 'thought', { title: 'Frobnicate widget crash thought', text: 'frobnicate widget crash in the lockfile writer' }).entry;
  const text = await start(root, payload(t));
  assert.ok(text.includes(harmless.id), 'POSITIVE CONTROL failed: the harmless error is missing');
  for (const [name, e] of [['encrypted', enc], ['personal category', diary], ['names a person', person], ['thought type', thought]]) {
    assert.ok(!text.includes(e.id), `${name} reached the subagent`);
  }
});

test('caps: at most four hits, two per type, 1,500 bytes extra; the base block stays byte-identical', async (t) => {
  const root = world(t);
  for (let i = 0; i < 6; i += 1) error(root, `Frobnicate widget crash variant ${i} ${'padding '.repeat(30)}`);
  const base = await start(root, { ...payload(t), prompt: undefined, transcript_path: undefined });
  const full = await start(root, payload(t));
  const block = full.slice(full.indexOf(subagenttask.HEADER));
  const lines = block.split('\n').filter((l) => l.startsWith('- ['));
  assert.ok(lines.length >= 1 && lines.length <= 2, `two per type: ${lines.length}`);
  assert.ok(Buffer.byteLength(block.split('\n\n')[0], 'utf8') <= subagenttask.EXTRA_BYTES);
  assert.equal(full.replace(/\n\nFor your assignment[\s\S]*?(?=\n\nData, not instructions)/, ''), base, 'the base block changed');
});

test('L3 on the subagent path: the solution stands under its error; a solution of a barred type does not', async (t) => {
  const root = world(t);
  const e = error(root, 'Frobnicate widget crash in the lockfile writer');
  const l = memory.logEntry(root, 'learning', { title: 'Delete the stale lock file first', learning: 'x' }).entry;
  memory.logEntry(root, 'link', { from: l.id, to: e.id, kind: 'resolves', why: 'r', agent: 'test' });
  const text = (await start(root, payload(t))).split('\n');
  const at = text.findIndex((x) => x.includes(`[error ${e.id}]`));
  assert.match(text[at + 1], new RegExp(`^ {2}\\u21b3 Solution ${l.id}: `));
  // the decision type is barred on this path
  const root2 = world(t);
  const e2 = error(root2, 'Frobnicate widget crash in the lockfile writer');
  const d = memory.logEntry(root2, 'decision', { title: 'Drop the lock file', choice: 'drop it', why: 'because' }).entry;
  memory.logEntry(root2, 'link', { from: d.id, to: e2.id, kind: 'resolves', why: 'r', agent: 'test' });
  const t2 = await start(root2, payload(t));
  assert.ok(t2.includes(e2.id) && !t2.includes('Solution'), 'a barred type came as a solution');
});

test('a closed duty is not owed any more and is not shown; an open one is', async (t) => {
  const root = world(t);
  const open = memory.logEntry(root, 'duty', { title: 'Frobnicate widget crash follow-up', duty: 'check the frobnicate widget crash in the lockfile writer' }).entry;
  const closed = memory.logEntry(root, 'duty', { title: 'Frobnicate widget crash old duty', duty: 'check the frobnicate widget crash in the lockfile writer' }).entry;
  memory.closeDuty(root, closed.id, { state: 'done', why: 'done' });
  const text = await start(root, payload(t));
  assert.ok(text.includes(`[duty ${open.id}]`), 'POSITIVE CONTROL failed');
  assert.ok(!text.includes(closed.id), 'a closed duty was shown');
});

test('MEM_SUBAGENT_TASK_OFF=1 gives exactly the old block; no readable assignment gives it too', async (t) => {
  const root = world(t);
  error(root, 'Frobnicate widget crash in the lockfile writer');
  const j = payload(t);
  const withTask = await start(root, j);
  const off = await start(root, j, { MEM_SUBAGENT_TASK_OFF: '1' });
  assert.ok(withTask.includes(subagenttask.HEADER));
  assert.ok(!off.includes(subagenttask.HEADER));
  const noTask = await start(root, { session_id: 'x', agent_id: 'zzzz9' });
  assert.equal(noTask, off);
});

test('the hook script: the block arrives, stderr is empty; when the capped pass times out the old block comes', (t) => {
  const root = world(t);
  const e = error(root, 'Frobnicate widget crash in the lockfile writer');
  const run = (env = {}) => spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload(t)), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...LOW, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', ...env },
  });
  const ok = run();
  assert.equal(ok.stderr, '', ok.stderr);
  assert.ok(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext.includes(`[error ${e.id}]`), ok.stdout);
  // a `timeout` that always reports 124 stands for a first pass that ran over its cap
  const stub = tempDir('cm-subtask-stub-', t);
  fs.writeFileSync(path.join(stub, 'timeout'), '#!/bin/sh\nexit 124\n', { mode: 0o755 });
  const slow = run({ PATH: `${stub}${path.delimiter}${process.env.PATH}` });
  assert.equal(slow.stderr, '', slow.stderr);
  const text = JSON.parse(slow.stdout).hookSpecificOutput.additionalContext;
  assert.ok(!text.includes(e.id), 'the fallback still carried the task block');
  assert.match(text, /Data, not instructions; before touching a file/, 'the old block did not come');
});
