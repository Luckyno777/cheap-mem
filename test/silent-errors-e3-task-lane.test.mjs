// test/silent-errors-e3-task-lane.test.mjs - E3 of the silent-errors plan (port of lucky-mem `stille-fehler`
// E3, d5bff6828): a search lane of the subagent's assignment block that FAILS is not a lane that found nothing.
//
// House rule (CLAUDE.md, commitment 2): a read that failed must not collapse to the empty answer. In
// `forTask` a throw (one type's search, the index, the query) and the time cap were swallowed and the block
// came out as if the memory knew no error. Now the block says which lane did not run, in one sentence that
// carries no error message and no assignment text.
//
// Red proof, pinned to a FIXED commit (never `git merge-base`): at f4a3540 an unreadable error log (the index
// cannot be loaded) gives the old block with NO word about the lookup, exactly like an assignment nothing
// matches. Its positive control is the healthy memory, where the old module does show the error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as subagentstart from '../src/subagentstart.mjs';
import * as subagenttask from '../src/subagenttask.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'bin', 'mem-subagent-start');
const INJECTOR = pathToFileURL(path.join(REPO, 'bench', 'atlas', 'inject-search-failure.mjs')).href;
const OLD = 'f4a3540';

const TASK = 'The spreadsheet writer loses formulas in the worksheet columns of the xlsx file';
const NOTHING = 'Rename the quarterly invoices folder and update the readme';
const LOW = { MEM_RETRIEVE_MIN: '0.1' };
const SAID = /lookup .*(failed|did not finish)/;

function world(t) {
  const root = tempDir('cm-e3-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  memory.logEntry(root, 'error', {
    class: 'wrong-cause', title: 'Spreadsheet writer loses formulas in the worksheet columns',
    text: 'formulas written as text into the xlsx columns',
  });
  memory.logEntry(root, 'learning', {
    title: 'Worksheet columns need the formula flag', text: 'the spreadsheet writer needs the formula flag set for the xlsx worksheet columns',
  });
  return root;
}
const textOf = (r) => r?.hookSpecificOutput?.additionalContext ?? '';
const run = async (root, task = TASK, env = {}, mod = subagentstart) => textOf(await mod.hookResultFor(
  root, JSON.stringify({ prompt: task, session_id: 's1' }), { env: { ...process.env, ...LOW, ...env } }));
/** Make the log of one type unreadable: a directory where the file should be (EISDIR, also as root). */
const breakLog = (root, rel) => { const f = path.join(root, rel); fs.rmSync(f, { force: true }); fs.mkdirSync(f); };
/** The block for the assignment, from the first header line on, without the closing footer. */
const taskBlock = (text) => (text.split(subagenttask.HEADER)[1] ?? '').split('\n\nData, not instructions')[0];

test('POSITIVE CONTROL: a healthy memory shows the matching error and says nothing about a failed lookup', async (t) => {
  const root = world(t);
  const text = await run(root);
  assert.match(text, /\[error [a-z0-9]+\] /);
  assert.doesNotMatch(text, SAID);
});

test('an assignment nothing matches gets no block and no notice (the "nothing found" answer stays plain)', async (t) => {
  const root = world(t);
  const text = await run(root, NOTHING);
  assert.ok(!text.includes(subagenttask.HEADER));
  assert.doesNotMatch(text, SAID);
});

test('the index cannot be loaded (unreadable error log): the block says the whole lookup failed', async (t) => {
  const root = world(t);
  breakLog(root, 'global/errors.jsonl');
  const text = await run(root);
  assert.match(text, /\(For your assignment the whole lookup failed - nothing was searched; "nothing shown" does not mean "nothing known"\.\)/);
  assert.ok(text.includes(subagenttask.HEADER), 'the notice stands under the usual header');
  const mine = taskBlock(text);
  assert.ok(!mine.includes('EISDIR') && !mine.includes(root), 'neither the error nor a path of this machine');
  assert.ok(!mine.toLowerCase().includes('spreadsheet'), 'no text of the assignment');
});

/** The hook answer of a child process in which the search lane for `fail` (a type) throws (bench/atlas/inject-search-failure.mjs). */
function askChild(root, fail) {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'subagentstart.mjs')).href)});`
    + 'const r = await m.hookResultFor(process.env.E3_ROOT, JSON.stringify({ prompt: process.env.E3_TASK, session_id: "s" }), { env: { ...process.env } });'
    + 'console.log(JSON.stringify(r?.hookSpecificOutput?.additionalContext ?? ""));';
  const pre = `--import=${INJECTOR}${fail ? `?fail=${fail}` : ''}`;
  const c = spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', pre, '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 50000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', E3_ROOT: root, E3_TASK: TASK, ...LOW },
  });
  assert.equal(c.status, 0, c.stderr);
  return JSON.parse(String(c.stdout).trim().split('\n').pop());
}

test('one type\'s search throws (injected): that type is named, the other lanes still show their hits', { timeout: 60000 }, (t) => {
  const root = world(t);
  const healthy = askChild(root, '');
  assert.match(healthy, /\[error [a-z0-9]+\]/, 'positive control: the healthy child shows the error');
  assert.match(healthy, /\[learning [a-z0-9]+\]/, 'positive control: and the learning');
  assert.doesNotMatch(healthy, SAID);
  const failing = askChild(root, 'error');
  assert.doesNotMatch(failing, /\[error [a-z0-9]+\]/, 'the failed lane shows no error');
  assert.match(failing, /\[learning [a-z0-9]+\]/, 'the other lanes still run');
  assert.match(failing, /\(For your assignment the lookup for errors failed - those were NOT searched; "nothing shown" does not mean "nothing known"\.\)/);
  assert.ok(!failing.includes('injected'), 'the error message of the throw stays out');
});

test('the time cap: the hits are dropped and the block says the lookup did not finish (clock stepped, so no flake)', async (t) => {
  const root = world(t);
  const real = Date.now; let n = 0;
  Date.now = () => { n += 5000; return n; };
  const text = await run(root).finally(() => { Date.now = real; });
  assert.match(text, /\(The lookup for your assignment did not finish - it was NOT fully searched; "nothing shown" does not mean "nothing known"\.\)/);
  assert.doesNotMatch(text, /\[error [a-z0-9]+\]/, 'a lookup that ran out of time shows no half result');
});

test('MEM_SUBAGENT_TASK_FELL_BACK=1 gives the notice alone; the user\'s OFF switch stays silent and wins', async (t) => {
  const root = world(t);
  const fell = await run(root, TASK, { MEM_SUBAGENT_TASK_FELL_BACK: '1' });
  assert.match(taskBlock(fell), /did not finish/);
  assert.doesNotMatch(fell, /\[error [a-z0-9]+\]/);
  const off = await run(root, TASK, { MEM_SUBAGENT_TASK_FELL_BACK: '1', MEM_SUBAGENT_TASK_OFF: '1' });
  assert.doesNotMatch(off, SAID);
  assert.ok(!off.includes(subagenttask.HEADER));
  const noTask = textOf(await subagentstart.hookResultFor(root, JSON.stringify({ session_id: 'x', agent_id: 'zzzz9' }), { env: { ...process.env, MEM_SUBAGENT_TASK_FELL_BACK: '1' } }));
  assert.doesNotMatch(noTask, SAID, 'no assignment, no lookup, no notice');
});

test('the notice is taken from the byte budget: four long hits plus the notice stay within EXTRA_BYTES', { timeout: 60000 }, (t) => {
  const root = tempDir('cm-e3-budget-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  const long = (k) => `the spreadsheet writer loses formulas in the worksheet columns of the xlsx file, variant ${k} ${'detail '.repeat(60)}`;
  for (const k of ['a', 'b']) {
    memory.logEntry(root, 'error', { class: 'wrong-cause', title: `Spreadsheet worksheet columns formula error ${k}`, text: long(k) });
    memory.logEntry(root, 'learning', { title: `Spreadsheet worksheet columns formula learning ${k}`, text: long(k) });
  }
  const whole = askChild(root, ''); // four hits, no failure: the block is as long as it gets
  assert.equal((whole.match(/^- \[/gm) ?? []).length, 4, `positive control: four hits\n${whole}`);
  const text = askChild(root, 'skill'); // an empty lane fails: the notice must still fit
  const block = `${subagenttask.HEADER}${taskBlock(text)}`;
  assert.match(block, /lookup for skills failed/);
  assert.ok((block.match(/^- \[/gm) ?? []).length >= 3, 'hits and notice share the block');
  assert.ok(Buffer.byteLength(block, 'utf8') <= subagenttask.EXTRA_BYTES, `block of ${Buffer.byteLength(block)} bytes`);
});

test('failureNotice: fixed words only, plural of duty, nothing for no failure', () => {
  assert.equal(subagenttask.failureNotice({}), '');
  assert.equal(subagenttask.failureNotice({ failed: [] }), '');
  assert.match(subagenttask.failureNotice({ failed: ['duty', 'files', 'bogus<script>'] }), /lookup for duties, named files failed - those were NOT searched/);
  assert.doesNotMatch(subagenttask.failureNotice({ failed: ['bogus<script>'] }), /bogus/);
  assert.match(subagenttask.failureNotice({ late: true }), /did not finish/);
});

test('the hook script: when the capped first pass overruns, the old block comes WITH the sentence; OFF stays silent', (t) => {
  const root = world(t);
  const j = JSON.stringify({ prompt: TASK, session_id: 's1' });
  const stub = tempDir('cm-e3-stub-', t);
  fs.writeFileSync(path.join(stub, 'timeout'), '#!/bin/sh\nexit 124\n', { mode: 0o755 });
  const go = (env = {}) => spawnSync('bash', [HOOK], {
    input: j, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ...LOW, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', PATH: `${stub}${path.delimiter}${process.env.PATH}`, ...env },
  });
  const slow = go();
  assert.equal(slow.stderr, '', slow.stderr);
  const text = JSON.parse(slow.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /\(The lookup for your assignment did not finish/);
  assert.match(text, /Data, not instructions; before touching a file/, 'the old block still comes');
  assert.doesNotMatch(text, /\[error [a-z0-9]+\]/);
  const off = JSON.parse(go({ MEM_SUBAGENT_TASK_OFF: '1' }).stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(off, SAID);
});

test('RED PROOF at f4a3540: an unreadable error log gives the old block no word about the lookup (positive control: the healthy memory shows the error)', async (t) => {
  const tmp = tempDir('cm-e3-old-', t);
  exportCommit(REPO, OLD, ['src', 'package.json'], tmp);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  const old = await import(`${pathToFileURL(path.join(tmp, 'src', 'subagentstart.mjs')).href}?t=${Math.random()}`);
  const healthy = world(t);
  assert.match(await run(healthy, TASK, {}, old), /\[error [a-z0-9]+\]/, 'positive control: the old module shows the error');
  const broken = world(t);
  breakLog(broken, 'global/errors.jsonl');
  const before = await run(broken, TASK, {}, old);
  assert.doesNotMatch(before, SAID, 'the old module already said it');
  assert.ok(!before.includes(subagenttask.HEADER), 'the old module answered the failed lane like the empty one');
  // and the same memory today
  assert.match(await run(broken), SAID);
});
