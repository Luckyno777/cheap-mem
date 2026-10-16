// test/question-unreadable-cm.test.mjs - a question drawer that cannot be read is "unknown", never "no questions"
// (dashboard-tempo-cm review, 2026-10-16; design commitment 2: missing / empty / broken).
//
// Finding (review of 764e829): `question.all()` skipped a drawer it could not read (`catch { continue; }`). With
// `global/questions.jsonl` a folder (EISDIR; on Windows also a file a virus scanner holds) the live part `questions`
// returned no error and open 0 / waiting 0: after a confirm on the dashboard every question vanished silently as a
// FRESH state, while the full build of the same store said "Log ... not readable".
//
// Measure:          what every reader of the questions says with a real broken drawer (a folder in place of the file -
//                   the same way on Windows: reading a directory is EISDIR there too).
// Starting value:   one open and one waiting question, readable (positive control); a store with no question drawer
//                   at all reads as "none" (missing is not broken).
// Expected change:  question.all throws memory.ReadError naming the drawer; the live part names it in its errors and
//                   keeps the stored lists; the dashboard's per-project counts are null, its tile and the board tile
//                   "not measurable"; `mem questions` and `mem questions confirm` exit 1 with the message, nothing written.
// Red proof: the old question.mjs of 764e829 (git show) returns [] for the same store - silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as question from '../src/question.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';
import * as dashboardLive from '../src/dashboard-live.mjs';
import * as board from '../src/board.mjs';
import { oldModuleCopy } from './helpers/old-source-copy.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const OLD = '764e829fbd73e326ef789606eabc5f9a24b12d7d';
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-qunread-'));
  made.push(root);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'qunread', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  memory.logEntry(root, 'learning', { title: 'Some learning', text: 'Body' });
  const q = memory.logEntry(root, 'question', { question: 'Which port?', title: 'Which port?', authority: 'user', agent: 'owner' }).entry;
  const open = memory.logEntry(root, 'question', { question: 'Who owns it?', title: 'Who owns it?', authority: 'user', agent: 'owner' }).entry;
  const a = memory.logEntry(root, 'decision', { title: 'Port 8080', choice: '8080', why: 'default', agent: 'session' }).entry;
  memory.logEntry(root, 'link', { from: a.id, to: q.id, kind: 'resolves', authority: 'agent', agent: 'session' });
  return { root, q, open, a };
}

/** The drawer becomes a folder: a real unreadable drawer (EISDIR on POSIX and on Windows). */
function breakDrawer(root, project = null) {
  const file = memory.logPath(root, 'question', project);
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file, { recursive: true });
  return file;
}

function cli(root, args) {
  const env = { ...process.env, CHEAP_MEM_ROOT: root };
  delete env.MEM_HEADLESS;
  return spawnSync(process.execPath, [MEM, ...args, '--root', root], { encoding: 'utf8', input: '', timeout: 60000, env });
}

test('positive controls: readable -> one open, one waiting; no question drawer at all -> none (missing is not broken)', () => {
  const w = world();
  assert.deepEqual(question.open(w.root).map((x) => x.id), [w.open.id]);
  assert.deepEqual(question.waiting(w.root).map((x) => x.id), [w.q.id]);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-qunread-empty-'));
  made.push(empty);
  fs.mkdirSync(path.join(empty, '.mem'));
  fs.writeFileSync(path.join(empty, '.mem', 'config.json'), '{}');
  assert.deepEqual(question.all(empty), []);
});

test('question.all / open / waiting throw a named ReadError for an unreadable drawer, global and per project', () => {
  const w = world();
  const file = breakDrawer(w.root);
  for (const read of [question.all, question.open, question.waiting]) {
    assert.throws(() => read(w.root), (e) => e instanceof memory.ReadError && e.path === file && /not readable/.test(e.message));
  }
  const w2 = world();
  breakDrawer(w2.root, 'garden'); // creates projects/garden with its question drawer as a folder; global stays readable
  assert.throws(() => question.all(w2.root), memory.ReadError, 'a broken project drawer too');
  assert.throws(() => question.all(w2.root, { project: 'garden' }), memory.ReadError);
});

test('live part questions: a broken drawer is named in errors and the stored lists stay (never laid on as empty)', () => {
  const w = world();
  const built = dashboardData.collectDashboard(w.root, { env: {} });
  assert.deepEqual(built.waitingQuestions.map((x) => x.id), [w.q.id], 'positive control: the build sees the waiting question');
  breakDrawer(w.root);
  const r = dashboardLive.compute(w.root, built, ['questions'], {});
  assert.match(r.errors.questions || '', /not readable/);
  assert.deepEqual(r.data.waitingQuestions, built.waitingQuestions, 'the stored waiting list stays');
  assert.deepEqual(r.data.openQuestions, built.openQuestions, 'the stored open list stays');
  const lists = dashboardData.questionLists(w.root);
  assert.equal(lists.reasons.length, 2, 'both lists name the reason');
});

test('the dashboard build and the board tile say it: the build throws the ReadError, the tile is not measurable', () => {
  const w = world();
  breakDrawer(w.root);
  assert.throws(() => dashboard.collect(w.root, { env: {} }), memory.ReadError, 'the full build names the drawer (it did before)');
  const tile = board.tileQuestions(w.root);
  assert.equal(tile.state, 'unknown');
  assert.match(tile.line, /not measurable.*not readable/);
});

test('mem questions and mem questions confirm exit 1 with the message; nothing is written', () => {
  const w = world();
  breakDrawer(w.root);
  const list = cli(w.root, ['questions']);
  assert.equal(list.status, 1, list.stdout + list.stderr);
  assert.match(list.stderr, /not readable/);
  assert.match(list.stderr, /unknown, not none/);
  assert.doesNotMatch(list.stdout, /No open questions/);
  assert.doesNotMatch(list.stderr, /\n\s+at /, 'a message, no stack');
  const links = memory.readLog(w.root, 'link').entries.length;
  const c = cli(w.root, ['questions', 'confirm', w.q.id, '--authority', 'user']);
  assert.equal(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stderr, /not readable.*Nothing was written/);
  assert.equal(memory.readLog(w.root, 'link').entries.length, links, 'no line appended');
});

test(`RED on ${OLD.slice(0, 7)}: the old question.all returns [] for the broken drawer - silently`, async (t) => {
  let source;
  try {
    source = execFileSync('git', ['-C', REPO, 'show', `${OLD}:src/question.mjs`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip(`commit ${OLD} not reachable (shallow clone?) - red proof unknown, not green`);
    return;
  }
  const copy = oldModuleCopy(path.join(REPO, 'src'), 'question.mjs', source);
  made.push(copy.dir);
  const old = await import(pathToFileURL(copy.file).href);
  const w = world();
  assert.equal(old.waiting(w.root).length, 1, 'positive control: the old reader sees the waiting question');
  breakDrawer(w.root);
  assert.deepEqual(old.all(w.root), [], 'old: no error, no question - the broken drawer reads as "none"');
});
