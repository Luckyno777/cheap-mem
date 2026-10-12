// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/question-text.test.mjs — src/questiontext.mjs (Lucky gjwsnbisurbs, 2026-10-12): the
// wording of recall questions is kept LOCALLY, redacted, for 30 days, never in git. The
// recall journal keeps `question_bytes` and nothing else (invariant nie-fragetext-im-journal,
// test/injection-no-question-text.test.mjs). Port of lucky-mem's `fragetext-lokal`.
//
// Red proof: on the base commit (no src/questiontext.mjs, `injection.book` without the
// hand-over) this file fails at its first import; with the module but without the wiring
// the probes that run a hook, `mem find`, the doctor or read the hook sources fail one by one
// (counted in the agent report).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';
import * as memory from '../src/memory.mjs';
import * as qt from '../src/questiontext.mjs';
import * as envregister from '../src/envregister.mjs';
import * as recallhook from '../src/recallhook.mjs';
import { relPosix } from './helpers/relpath.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const HOOK = path.join(CODE, 'bin', 'mem-retrieve');
const DAY = 86_400_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const roots = [];
/** A memory root made by `mem init` (so it has the real .gitignore), with entries to hit. */
function build({ git = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-qt-'));
  roots.push(root);
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  if (!git) fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  for (let i = 0; i < 30; i += 1) {
    memory.logEntry(root, 'decision', { topic: `filler ${i}`, choice: `other content ${i}`, why: 'no relation' }, { project: null });
  }
  memory.logEntry(root, 'learning', {
    title: 'hummingbeat hummingbeat measurement', learning: 'the hummingbeat was measured and stays',
  }, { project: null });
  return root;
}
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** A bare root: only a folder. `repo`: a git repo with (or without) the ignore line. */
function bare({ repo = false, ignore = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-qt-b-'));
  roots.push(root);
  if (repo) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    if (ignore) fs.writeFileSync(path.join(root, '.gitignore'), '.mem/local/\n');
  }
  return root;
}

const jl = (extra = {}) => injection.buildLine({ ts: '2026-10-12T10:00:00Z', session: 's1', questionBytes: 20, ...extra });

function ask(root, prompt, session, extraEnv = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ prompt, session_id: session }), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_NO_PULL: '1',
      MEM_RETRIEVE_TURNS: path.join(root, '.mem', 'turns'), MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '', MEM_RECALL_SERVER: '0',
      CHEAP_MEM_QUESTION_TEXT: '', ...extraEnv },
  });
  return { out: r.stdout, lines: injection.read(root).lines.filter((l) => l.session === session) };
}

// --- THE CASE: a real hook run -------------------------------------------------------------

test('THE CASE: the hook keeps the question locally, tied to its journal line; the journal has no wording', () => {
  const root = build();
  const question = 'what was the hummingbeat measurement about, quuxlevarn?';
  const { out, lines } = ask(root, question, 'qt-1');
  assert.ok(out.includes('hummingbeat'), `the hook delivered nothing - the fixture is no good: ${out.slice(0, 120)}`);
  assert.equal(lines.length, 1);
  const l = qt.read(root);
  assert.equal(l.state, 'ok', JSON.stringify(l));
  assert.equal(l.lines.length, 1);
  assert.equal(l.lines[0].question, question);
  // The tie: the key computed from the journal line finds the question.
  assert.equal(l.lines[0].key, qt.key(lines[0]));
  assert.equal(qt.questionFor(root, lines[0])?.question, question);
  assert.equal(l.lines[0].question_bytes, Buffer.byteLength(question));
  // The journal: bytes yes, wording no (positive control: the word is in the question).
  assert.ok(question.includes('quuxlevarn'));
  const journal = fs.readFileSync(path.join(root, injection.JOURNAL_FILE), 'utf8');
  assert.ok(!journal.includes('quuxlevarn') && !journal.includes('hummingbeat measurement about'), 'the wording stands in the journal');
  assert.equal(lines[0].question_bytes, Buffer.byteLength(question));
  // Place and rights.
  const file = qt.fileForDay(root, dayOf(Date.now()));
  assert.ok(file.includes(path.join('.mem', 'local', 'question-text')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'file open to group/others');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'folder open to group/others');
  }
});

test('a short prompt without signal is booked no-signal and its text is tied to that line', () => {
  const root = build();
  const { lines } = ask(root, 'ok', 'qt-2');
  assert.equal(lines[0]?.reason, 'no-signal');
  const k = qt.questionFor(root, lines[0]);
  assert.equal(k?.question, 'ok');
});

test('a machine turn leaves no question behind', () => {
  const root = build();
  const { lines } = ask(root, '[Subagent hand-back] report: hummingbeat measured, all green.', 'qt-3');
  assert.equal(lines[0]?.reason, 'machine');
  assert.equal(qt.read(root).state, 'missing');
});

test('the workflow-only exit keeps the question too (PROMPT handed over, capped)', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.match(src, /MEM_RH_WORKFLOW="\$WF_TEXT" MEM_RH_PROMPT="\$\{PROMPT:0:8000\}"/);
  assert.match(src, /MEM_J_Q="\$\{PROMPT:0:8000\}"/);
  assert.match(src, /questionText: process\.env\.MEM_J_Q/);
  const ps = fs.readFileSync(path.join(CODE, 'bin', 'mem-retrieve.ps1'), 'utf8');
  assert.match(ps, /\$env:MEM_RH_PROMPT = \$Prompt\.Substring\(0, \[Math\]::Min\(8000, \$Prompt\.Length\)\)\s*\n\s*& node \$RecallJs workflow-only/);
});

test('`mem find --journal-session` keeps the question locally, not in the journal', () => {
  const root = build();
  execFileSync('node', [MEM, '--root', root, 'find', 'quuxlevarn hummingbeat', '--json', '--top', '3',
    '--journal-session', 'S1', '--journal-min', '0.5'], { stdio: 'pipe' });
  const l = qt.read(root);
  assert.equal(l.lines.length, 1, JSON.stringify(l));
  assert.equal(l.lines[0].question, 'quuxlevarn hummingbeat');
  assert.ok(!fs.readFileSync(path.join(root, injection.JOURNAL_FILE), 'utf8').includes('quuxlevarn'));
});

test('every journal writer that has the wording hands it over (sources), none puts it in the line', () => {
  for (const [rel, needle] of [
    ['src/cli/commands/search.mjs', 'questionText: String(query)'],
    ['bin/mem-mcp', 'questionText: String(q)'],
    ['src/recallhook.mjs', 'questionText: env.MEM_RH_PROMPT'],
    ['src/recallhook.mjs', 'questionText: prompt'],
  ]) assert.ok(fs.readFileSync(path.join(CODE, rel), 'utf8').includes(needle), `${rel}: ${needle}`);
  const l = injection.buildLine({ questionText: 'quuxlevarn', hits: 1 });
  assert.ok(!JSON.stringify(l).includes('quuxlevarn'));
  assert.equal('questionText' in l, false);
});

// --- Redaction -----------------------------------------------------------------------------

test('redaction: a recognised secret is blacked out and never stored raw (dummy)', () => {
  const root = bare();
  const dummy = `ghp_${'K'.repeat(36)}`; // built at run time: it stands in no source file
  assert.equal(qt.keep(root, jl(), `why does the push fail with ${dummy} in the header`, { env: {} }), true);
  const raw = fs.readFileSync(qt.fileForDay(root, dayOf(Date.now())), 'utf8');
  assert.ok(!raw.includes(dummy) && !raw.includes('K'.repeat(20)), 'the secret stands raw in the file');
  assert.match(raw, /\[REDACTED:github-token\]/);
  const line = qt.read(root).lines[0];
  assert.ok(line.redacted >= 1);
  assert.ok(line.question.startsWith('why does the push fail with'));
  assert.equal(qt.prepare('where is the tunnel', { env: {} }).redacted, 0, 'a harmless text stays as it is');
});

test('redaction against the environment, and the hand-over variables do not eat the question', () => {
  const value = 'Zebra7Quark9Eclipse3';
  const env = { MY_ODD_THING: value };
  assert.match(qt.prepare(`the value is ${value} ok`, { env }).question, /\[REDACTED:env:MY_ODD_THING\]/);
  // MEM_RH_PROMPT holds the very question; matched as a "secret" it would replace all of it.
  const q = 'what was that tunnel thing again, zibberwock?';
  const handed = qt.prepare(q, { env: { MEM_RH_PROMPT: q, MEM_J_Q: q, MEM_RH_WORKFLOW: q } });
  assert.equal(handed.question, q);
  assert.equal(handed.redacted, 0);
});

test('a pasted wall of text is cut, and marked as cut', () => {
  const root = bare();
  qt.keep(root, jl(), 'word '.repeat(5000), { env: {} });
  const l = qt.read(root).lines[0];
  assert.equal(l.question.length, qt.QUESTION_MAX_CHARS);
  assert.equal(l.truncated, true);
});

// --- Shelf life (fake clock) -----------------------------------------------------------------

test('shelf life 30 days: the first write of a day sweeps older day files, younger ones stay', () => {
  const root = bare();
  const now = Date.parse('2026-12-01T09:00:00Z');
  fs.mkdirSync(qt.dir(root), { recursive: true });
  const old = dayOf(now - 31 * DAY);
  const edge = dayOf(now - 30 * DAY);
  const young = dayOf(now - 29 * DAY);
  for (const n of [`${old}.jsonl`, `${edge}.jsonl`, `${young}.jsonl`, 'note.txt']) fs.writeFileSync(path.join(qt.dir(root), n), '{}\n');
  assert.equal(qt.keep(root, jl(), 'a question today', { env: {}, now }), true);
  const left = fs.readdirSync(qt.dir(root)).sort();
  assert.ok(!left.includes(`${old}.jsonl`), `31 days old must go: ${left}`);
  assert.ok(left.includes(`${edge}.jsonl`) && left.includes(`${young}.jsonl`), `30 days stays: ${left}`);
  assert.ok(left.includes('note.txt'), 'foreign files are left alone');
  assert.ok(left.includes(`${dayOf(now)}.jsonl`));
});

test('shelf life: at most once per day (cheap) - the second write of a day does not read the folder', () => {
  const root = bare();
  const now = Date.parse('2026-12-01T09:00:00Z');
  qt.keep(root, jl(), 'first question today', { env: {}, now });
  const old = path.join(qt.dir(root), `${dayOf(now - 40 * DAY)}.jsonl`);
  fs.writeFileSync(old, '{}\n');
  qt.keep(root, jl({ ts: '2026-12-01T09:00:05Z' }), 'second question today', { env: {}, now: now + 5000 });
  assert.ok(fs.existsSync(old), 'the sweep ran twice on one day');
  qt.keep(root, jl({ ts: '2026-12-02T09:00:00Z' }), 'a question the next day', { env: {}, now: now + DAY });
  assert.ok(!fs.existsSync(old), 'the sweep did not run the next day');
});

test('read never returns a line past the shelf life, even if the sweep has not run', () => {
  const root = bare();
  const now = Date.parse('2026-12-01T09:00:00Z');
  fs.mkdirSync(qt.dir(root), { recursive: true });
  const row = (ts) => `${JSON.stringify({ v: 1, ts, key: 'abc', question: 'x' })}\n`;
  fs.writeFileSync(path.join(qt.dir(root), `${dayOf(now - 35 * DAY)}.jsonl`), row('2026-10-27T00:00:00Z'));
  fs.writeFileSync(path.join(qt.dir(root), `${dayOf(now - 2 * DAY)}.jsonl`), row('2026-11-29T00:00:00Z'));
  const r = qt.read(root, { now });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].ts, '2026-11-29T00:00:00Z');
});

// --- Switch ------------------------------------------------------------------------------------

test('switch: CHEAP_MEM_QUESTION_TEXT=off keeps nothing (direct and through the hook); default is on', () => {
  for (const off of ['off', '0', 'no', 'false']) assert.equal(qt.isOn({ CHEAP_MEM_QUESTION_TEXT: off }), false, off);
  assert.equal(qt.isOn({}), true);
  assert.equal(qt.isOn({ CHEAP_MEM_QUESTION_TEXT: 'on' }), true);
  const root = bare();
  assert.equal(qt.keep(root, jl(), 'a question', { env: { CHEAP_MEM_QUESTION_TEXT: 'off' } }), false);
  assert.equal(qt.read(root).state, 'missing');
  const hooked = build();
  const { out, lines } = ask(hooked, 'what was the hummingbeat measurement about?', 'qt-off', { CHEAP_MEM_QUESTION_TEXT: 'off' });
  assert.ok(out.includes('hummingbeat'), 'the recall itself still works');
  assert.equal(lines.length, 1, 'the journal itself still runs');
  assert.equal(qt.read(hooked).state, 'missing', 'kept in spite of off');
  const reg = envregister.REGISTER.find((r) => r.name === 'CHEAP_MEM_QUESTION_TEXT');
  assert.ok(reg && reg.kind === 'switch' && /^on/.test(reg.default));
});

// --- Failures never break the hook -----------------------------------------------------------------

test('a failure to keep: no throw, the journal line is still booked, the failure is counted by class only', () => {
  const root = bare();
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'local'), 'in the way'); // `.mem/local` is a FILE: mkdir fails
  const booked = injection.book(root, {
    session: 'qt-f', occasion: injection.OCCASION.QUESTION, reason: null, bytes: 10, hits: 1,
    questionBytes: 30, questionText: 'what is the tunnel doing, zibberwock?',
  });
  assert.equal(booked, true, 'the journal write must not depend on keeping the question');
  assert.equal(injection.read(root).lines.length, 1);
  const f = qt.failureCount(root);
  assert.ok(f.count >= 1, JSON.stringify(f));
  const raw = fs.readFileSync(path.join(root, qt.ERRORS_REL), 'utf8');
  assert.ok(!raw.includes('zibberwock') && !raw.includes('tunnel'), 'the counter carries question text');
  // Direct calls never throw.
  assert.equal(qt.keep(root, jl(), 'another', { env: {} }), false);
  assert.equal(qt.keep(null, null, 'x', { env: {} }), false);
  assert.equal(qt.keep(root, jl(), 42, { env: {} }), false);
});

test('a place inside a repository that git does NOT ignore: nothing written, counted; with the ignore line it is written', () => {
  const open = bare({ repo: true, ignore: false });
  assert.equal(qt.keep(open, jl(), 'a question', { env: {} }), false);
  assert.equal(qt.read(open).state, 'missing');
  assert.equal(qt.failureCount(open).kinds['not-ignored'], 1);
  const shut = bare({ repo: true, ignore: true });
  assert.equal(qt.keep(shut, jl(), 'a question', { env: {} }), true);
  const st = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: shut, encoding: 'utf8' });
  assert.ok(!st.includes('question-text'), st);
});

// --- Reading: three states ---------------------------------------------------------------------------

test('reading: missing / empty / broken / ok stay four different answers', () => {
  const root = bare();
  assert.equal(qt.questionsSince(root, '2026-01-01').state, 'missing');
  fs.mkdirSync(qt.dir(root), { recursive: true });
  const file = qt.fileForDay(root, dayOf(Date.now()));
  fs.writeFileSync(file, '');
  assert.equal(qt.read(root).state, 'empty');
  fs.writeFileSync(file, 'not json at all\n');
  const b = qt.read(root);
  assert.equal(b.state, 'broken');
  assert.equal(b.broken, 1);
  assert.deepEqual(b.lines, []);
  qt.keep(root, jl(), 'a whole question', { env: {} });
  const mixed = qt.read(root);
  assert.equal(mixed.state, 'broken', 'a broken line must not vanish quietly');
  assert.equal(mixed.lines.length, 1, 'the whole line still comes');
  fs.writeFileSync(file, `${JSON.stringify(mixed.lines[0])}\n`);
  assert.equal(qt.read(root).state, 'ok');
  assert.equal(qt.questionsSince(root, new Date(Date.now() + 2 * DAY).toISOString()).lines.length, 0, 'since cuts by day');
  assert.equal(qt.questionsSince(root, dayOf(Date.now())).lines.length, 1);
});

// --- Guard: never in git -------------------------------------------------------------------------------

test('GUARD: the place is ignored by git in this repo (own rule), a neighbour path is not', () => {
  const rel = path.join(qt.DIR_REL, '2026-10-12.jsonl');
  const v = execFileSync('git', ['check-ignore', '-v', '--no-index', rel], { cwd: CODE, encoding: 'utf8' });
  assert.match(v, /\.gitignore:\d+:\/\.mem\/\t/, v);
  assert.throws(() => execFileSync('git', ['check-ignore', '-q', '--no-index', 'question-text/2026-10-12.jsonl'], { cwd: CODE, stdio: 'ignore' }),
    'control: a path outside .mem/ must NOT be ignored');
  assert.equal(execFileSync('git', ['ls-files', '--', '.mem'], { cwd: CODE, encoding: 'utf8' }).trim(), '', 'something under .mem/ is tracked');
});

test('GUARD: a memory made by `mem init` ignores .mem/local/ (so the place is covered there too)', () => {
  const root = build();
  execFileSync('git', ['init', '-q'], { cwd: root }); // `mem init` writes .gitignore, the repository is the user's
  const rel = path.join(qt.DIR_REL, '2026-10-12.jsonl');
  execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: root });
  assert.throws(() => execFileSync('git', ['check-ignore', '-q', '--no-index', 'global/question-text.jsonl'], { cwd: root, stdio: 'ignore' }));
});

test('GUARD: after a real run the wording stands nowhere but under .mem/local/ (whole root searched)', () => {
  const root = build();
  const word = 'quarkkeulchen';
  ask(root, `what was the hummingbeat measurement about, ${word}?`, 'qt-g');
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p, 'utf8').includes(word)) hits.push(relPosix(root, p));
    }
  }(root));
  assert.ok(hits.length >= 1, 'positive control: it must stand under .mem/local/');
  assert.ok(hits.every((p) => p.startsWith('.mem/local/')), `outside .mem/local/: ${hits}`);
});

// --- Doctor ---------------------------------------------------------------------------------------------

test('doctor: assess (behind the finding question-text) states the situations honestly and never names question text', () => {
  const root = bare({ repo: true, ignore: true });
  const now = Date.now();
  const check = (env = {}) => qt.assess(root, { env, now });
  assert.equal(check().level, 'unknown', 'on, nothing yet: unknown, not good');
  assert.ok(fs.readFileSync(path.join(CODE, 'src', 'doctor.mjs'), 'utf8').includes("guarded('checkQuestionText'"), 'the finding is wired into the doctor run');
  assert.equal(check({ CHEAP_MEM_QUESTION_TEXT: 'off' }).level, 'unknown');
  assert.match(check({ CHEAP_MEM_QUESTION_TEXT: 'off' }).text, /off/);
  qt.keep(root, jl({ ts: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') }), 'secret zibberwock question', { env: {}, now });
  const good = check();
  assert.equal(good.level, 'good', good.text);
  assert.ok(!good.text.includes('zibberwock') && !(good.advice ?? '').includes('zibberwock'));
  fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, qt.ERRORS_REL), `${JSON.stringify({ ts: new Date(now).toISOString(), kind: 'ENOSPC' })}\n`);
  const warn = check();
  assert.equal(warn.level, 'warn');
  assert.match(warn.text, /ENOSPC/);
  assert.ok(warn.advice && !/bug in doctor/.test(warn.advice));
  const openRepo = bare({ repo: true, ignore: false });
  const err = qt.assess(openRepo, { env: {}, now });
  assert.equal(err.level, 'error');
  assert.ok(err.advice && !/bug in doctor/.test(err.advice));
});

// --- Follow-ups (reviewer 2026-10-12) ---------------------------------------------------------------------

/** A fake `git`: logs every call and answers per sub-command as ordered. */
function fakeGit({ ignore = 0, revParse = 0, sleep = 0 } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-qt-git-'));
  roots.push(d);
  const log = path.join(d, 'calls.log');
  const bin = path.join(d, 'git');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `echo "$1" >> '${log}'`,
    sleep ? `sleep ${sleep}` : '',
    'case "$1" in',
    `  check-ignore) exit ${ignore} ;;`,
    `  rev-parse) [ ${revParse} -eq 0 ] && echo true; exit ${revParse} ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

test('git answers unclear (exit 128 but inside a work tree): nothing written, counted as git-unclear', () => {
  const root = bare();
  const g = fakeGit({ ignore: 128, revParse: 0 });
  assert.equal(qt.keep(root, jl(), 'a question', { env: {}, gitBin: g.bin }), false);
  assert.equal(qt.read(root).state, 'missing');
  assert.equal(qt.failureCount(root).kinds['git-unclear'], 1);
  // Control: rev-parse agrees "no repository" and no repo remnant lies there -> harmless, written.
  const other = bare();
  assert.equal(qt.keep(other, jl(), 'a question', { env: {}, gitBin: fakeGit({ ignore: 128, revParse: 128 }).bin }), true);
});

test('no git at all: written without a repo remnant, git-unclear with one; the hook\'s own .git/mem-* marks are no remnant', () => {
  assert.equal(qt.keep(bare(), jl(), 'a question', { env: {}, gitBin: '/not/there/git' }), true);
  const rem = bare();
  fs.mkdirSync(path.join(rem, '.git'));
  fs.writeFileSync(path.join(rem, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(qt.keep(rem, jl(), 'a question', { env: {}, gitBin: '/not/there/git' }), false);
  assert.equal(qt.failureCount(rem).kinds['git-unclear'], 1);
  const marks = bare();
  fs.mkdirSync(path.join(marks, '.git', 'mem-abruf-zuege'), { recursive: true });
  assert.equal(qt.keep(marks, jl(), 'a question', { env: {}, gitBin: '/not/there/git' }), true);
});

test('a broken .git (real git): nothing written, git-unclear', () => {
  const root = bare();
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'not a ref\n');
  assert.equal(qt.keep(root, jl(), 'a question', { env: {} }), false);
  assert.equal(qt.read(root).state, 'missing');
  assert.equal(qt.failureCount(root).kinds['git-unclear'], 1);
});

test('a hanging git is cut off at the limit (2000 ms) and counted as git-unclear', () => {
  assert.equal(qt.GIT_TIMEOUT_MS, 2000);
  const root = bare();
  const g = fakeGit({ ignore: 0, sleep: 20 });
  // Had the limit not held, this line would hang for 20 s on the wrong git.
  assert.equal(qt.keep(root, jl(), 'a question', { env: {}, gitBin: g.bin, gitTimeoutMs: 300 }), false);
  assert.equal(qt.failureCount(root).kinds['git-unclear'], 1);
});

test('not ignored: the check is not repeated on every recall - one mark per day, then no git call until the day changes', () => {
  const root = bare();
  const g = fakeGit({ ignore: 1 });
  const now = Date.parse('2026-12-01T09:00:00Z');
  const keep = (extra) => qt.keep(root, jl(), 'a question', { env: {}, gitBin: g.bin, ...extra });
  assert.equal(keep({ now }), false);
  assert.equal(g.calls().length, 1, g.calls().join());
  assert.equal(keep({ now: now + 60_000 }), false);
  assert.equal(keep({ now: now + 3_600_000 }), false);
  assert.equal(g.calls().length, 1, `more git calls on the same day: ${g.calls().join()}`);
  assert.equal(qt.failureCount(root, { now }).kinds['not-ignored'], 1, 'counted once, not per recall');
  assert.ok(fs.existsSync(path.join(root, qt.PLACE_MARK_REL)));
  execFileSync('git', ['check-ignore', '-q', '--no-index', qt.PLACE_MARK_REL], { cwd: CODE }); // the mark itself never lands in git
  assert.equal(keep({ now: now + DAY }), false);
  assert.equal(g.calls().length, 2, 'the next day it asks again');
  const fixed = fakeGit({ ignore: 0 });
  assert.equal(qt.keep(root, jl(), 'a question', { env: {}, gitBin: fixed.bin, now: now + 2 * DAY }), true);
});

test('the skill offer is booked WITHOUT the question (no second line for the same prompt)', () => {
  const root = bare();
  const q = 'which skill fits the tunnel work, zibberwock?';
  const env = { MEM_RH_SESSION: 'qt-sk', MEM_RH_PROMPT: q, MEM_RH_QB: String(Buffer.byteLength(q)), MEM_RH_TURNS: path.join(root, 'turns') };
  const r = recallhook.recall(root, JSON.stringify({ hits: [] }), env, { offer: { line: 'Skills: tunnel-fix', ids: ['sk1'] } });
  r.book();
  const j = injection.read(root).lines.filter((l) => l.session === 'qt-sk');
  assert.deepEqual(j.map((l) => l.occasion).sort(), ['question', 'skill-offer'], JSON.stringify(j));
  const kept = qt.read(root).lines;
  assert.equal(kept.length, 1, `a second line for the offer: ${JSON.stringify(kept.map((k) => k.key))}`);
  assert.equal(kept[0].key, qt.key(j.find((l) => l.occasion === 'question')));
});

const hit = (entry) => ({ score: 9, source: 'global/decisions.jsonl', line: 1, entry: { id: 'e1', ts: '2026-09-01T10:00:00Z', title: 't', choice: 'c', why: 'w', ...entry } });

test('encrypted entries (the counterpart of lucky-mem\'s sensitive filter): mostly encrypted hits keep no question, only a count', () => {
  const root = bare();
  const q = 'what did I decide about the vault, zibberwock?';
  assert.equal(qt.keep(root, jl(), q, { env: {}, hits: [hit({ body_enc: { v: 1 } }), hit({ body_enc: { v: 1 } }), hit({})] }), false);
  assert.equal(qt.read(root).state, 'missing');
  const f = qt.failureCount(root);
  assert.equal(f.count, 0, 'not a failure');
  assert.equal(f.skipped, 1);
  assert.equal(qt.status(root, { env: {} }).skipped, 1);
  // Controls: one of three is not "mostly"; no hits at all neither.
  assert.equal(qt.keep(root, jl(), q, { env: {}, hits: [hit({ body_enc: { v: 1 } }), hit({}), hit({})] }), true);
  assert.equal(qt.keep(root, jl({ ts: '2026-10-12T10:00:05Z' }), q, { env: {}, hits: [] }), true);
  const a = qt.assess(root, { env: {}, now: Date.now() });
  assert.match(a.text, /1 not kept because the hits were encrypted/);
  assert.ok(!a.text.includes('zibberwock'));
});

test('encrypted hits through the recall hook booking: journal line yes, question no', () => {
  const root = bare();
  const q = 'what did I decide about the vault, zibberwock?';
  const env = { MEM_RH_SESSION: 'qt-enc', MEM_RH_PROMPT: q, MEM_RH_QB: String(Buffer.byteLength(q)), MEM_RH_TURNS: path.join(root, 'turns') };
  const enc = recallhook.recall(root, JSON.stringify({ hits: [hit({ body_enc: { v: 1 } })] }), env);
  enc.book();
  assert.equal(injection.read(root).lines.filter((l) => l.session === 'qt-enc').length, 1);
  assert.equal(qt.read(root).state, 'missing');
  assert.equal(qt.failureCount(root).skipped, 1);
  const env2 = { ...env, MEM_RH_SESSION: 'qt-clear', MEM_RH_TURNS: path.join(root, 'turns2') };
  recallhook.recall(root, JSON.stringify({ hits: [hit({})] }), env2).book();
  assert.equal(qt.read(root).lines.length, 1, 'control: a clear hit keeps the question');
});

test('doctor: git-unclear is a warning with advice; place mark named', () => {
  const root = bare();
  qt.keep(root, jl(), 'a question', { env: {}, gitBin: fakeGit({ ignore: 128, revParse: 0 }).bin });
  const a = qt.assess(root, { env: {}, now: Date.now(), gitBin: fakeGit({ ignore: 128, revParse: 0 }).bin });
  assert.equal(a.level, 'warn');
  assert.match(a.text, /git does not answer/);
  assert.ok(a.advice);
});
