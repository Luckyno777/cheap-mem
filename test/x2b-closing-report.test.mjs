// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/x2b-closing-report.test.mjs — X2b: the task-end occasion.
//
// The Stop hook reports the open duties that concern the session: report
// only (never block), short and capped, once per session per duty, and no
// second count. Red proof against the fixed start commit
// 201a087f2d2f634f9b061f4681bd1f78f27408be: there the Stop hook stayed
// silent about duties; the positive control is the new hook on the same
// input.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as today from '../src/today.mjs';
import * as cr from '../src/closingreport.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const STOP = path.join(REPO, 'bin', 'mem-stop');
const OLD = '201a087f2d2f634f9b061f4681bd1f78f27408be';
const START = new Date('2026-09-30T08:00:00Z');
const BEFORE = new Date('2026-09-30T07:00:00Z');
const AFTER = new Date('2026-09-30T09:00:00Z');

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };

function build() {
  const root = temp('cm-x2b-cr-');
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  return root;
}
function transcript(root, start = START, text = 'Done.') {
  const p = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(p, [
    { type: 'user', timestamp: start.toISOString(), message: { content: 'go' } },
    { type: 'assistant', timestamp: new Date(start.getTime() + 1000).toISOString(), message: { content: [{ type: 'text', text }] } },
  ].map((z) => JSON.stringify(z)).join('\n') + '\n');
  return p;
}
function sow(root) {
  memory.logEntry(root, 'duty', { title: 'old duty from an earlier session', who: 'user' }, { now: BEFORE });
  memory.logEntry(root, 'duty', { title: 'review the PR', who: 'user' }, { now: AFTER });
  memory.logEntry(root, 'duty', { title: 'restart the VM', who: 'somebody-else' }, { now: AFTER });
}

test('only the open duties of THIS session, addressed to the human: one report, systemMessage, no block', () => {
  const root = build();
  sow(root);
  const r = cr.stopReport(root, { session_id: 's1', transcript_path: transcript(root) });
  assert.deepEqual(Object.keys(r), ['systemMessage'], 'report only, never block');
  assert.match(r.systemMessage, /Open duties from this session \(1\)/);
  assert.match(r.systemMessage, /review the PR/);
  assert.doesNotMatch(r.systemMessage, /old duty/, 'a duty from before the session does not concern it');
  assert.doesNotMatch(r.systemMessage, /restart the VM/, 'not addressed to the human: not in the day count either');
});

test('no second count: the report is a subset of today().counts.decisions', () => {
  const root = build();
  sow(root);
  const ids = new Set(today.decisionsForHuman(root).list.map((x) => x.id));
  const mine = cr.dutiesOfSession(root, START.getTime());
  assert.ok(mine.list.length > 0);
  for (const x of mine.list) assert.ok(ids.has(x.id), `${x.id} is not in the day's count`);
  assert.ok(mine.list.length < ids.size, 'the filter cuts something (the old duty)');
});

test('once per session per duty; a new duty is reported later; another session reports again', () => {
  const root = build();
  sow(root);
  const input = { session_id: 's1', transcript_path: transcript(root) };
  assert.ok(cr.stopReport(root, input));
  assert.equal(cr.stopReport(root, input), null, 'the same end of turn again: silent');
  memory.logEntry(root, 'duty', { title: 'second new duty', who: 'user' }, { now: new Date(AFTER.getTime() + 60000) });
  const r = cr.stopReport(root, input);
  assert.match(r.systemMessage, /\(1\).*second new duty/s);
  assert.doesNotMatch(r.systemMessage, /review the PR/, 'what was reported is not reported again');
  assert.ok(cr.stopReport(root, { ...input, session_id: 's2' }));
});

test('cap: at most 3 names, 3 lines, 400 characters', () => {
  const root = build();
  for (let i = 0; i < 8; i += 1) {
    memory.logEntry(root, 'duty', { title: `duty number ${i} ${'very long '.repeat(30)}`, who: 'user' },
      { now: new Date(AFTER.getTime() + i * 1000) });
  }
  const r = cr.stopReport(root, { session_id: 's1', transcript_path: transcript(root) });
  assert.match(r.systemMessage, /\(8\)/);
  assert.match(r.systemMessage, /\(\+5 more\)/);
  assert.ok(r.systemMessage.split('\n').length <= cr.MAX_LINES);
  assert.ok(r.systemMessage.length <= cr.MAX_CHARS, `${r.systemMessage.length} characters`);
});

test('better nothing than something false: no duty, no session start, no input, switched off', () => {
  const root = build();
  assert.equal(cr.stopReport(root, { session_id: 's', transcript_path: transcript(root) }), null);
  sow(root);
  assert.equal(cr.stopReport(root, { session_id: 's', transcript_path: path.join(root, 'absent.jsonl') }), null);
  assert.equal(cr.stopReport(root, { session_id: 's' }), null);
  assert.equal(cr.stopReport(root, null), null);
  assert.equal(cr.stopReport(root, { session_id: 's', transcript_path: transcript(root) }, { env: { MEM_CLOSING_REPORT: '0' } }), null);
  assert.ok(cr.stopReport(root, { session_id: 's', transcript_path: transcript(root) }), 'positive control: without the switch it reports');
});

// --- the real hook ----------------------------------------------------------------

function stop(script, root, input) {
  return spawnSync('bash', [script], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_STOP_ROOTS: root, MEM_STOP_NO_PUSH: '1', MEM_HOOK_OFF: '', MEM_CAPTURE_OFF: '', MEM_HEADLESS: '', MEM_REFLECT: '' },
  });
}

test('bin/mem-stop: reports the duty as a systemMessage (no block), a second stop is silent', () => {
  const root = build();
  sow(root);
  const input = { session_id: 'h1', transcript_path: transcript(root), stop_hook_active: false };
  const r = stop(STOP, root, input);
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const j = JSON.parse(r.stdout);
  assert.equal(j.decision, undefined);
  assert.match(j.systemMessage, /review the PR/);
  assert.equal(stop(STOP, root, input).stdout, '', 'the second stop of the same session is silent');
});

test('bin/mem-stop: an answer correction wins and the report is not used up', () => {
  const root = build();
  sow(root);
  const errId = 'errcheck1';
  fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'),
    JSON.stringify({ id: errId, ts: '2026-09-01T00:00:00Z', class: 'x', title: 't', text: 'x' }) + '\n');
  fs.writeFileSync(path.join(root, '.mem', 'answer-patterns.json'), JSON.stringify([{
    id: 'p1', error_id: errId, reason: 'no thanks', pattern: 'FORBIDDEN-PHRASE',
  }]));
  const bad = stop(STOP, root, { session_id: 'h2', transcript_path: transcript(root, START, 'this says FORBIDDEN-PHRASE'), stop_hook_active: false });
  const first = bad.stdout ? JSON.parse(bad.stdout) : null;
  assert.equal(first?.decision, 'block', `precondition: the answer check must block here: ${bad.stdout} ${bad.stderr.slice(-300)}`);
  assert.equal(first.systemMessage, undefined, 'one output, not two');
  const after = stop(STOP, root, { session_id: 'h2', transcript_path: transcript(root), stop_hook_active: true });
  assert.match(JSON.parse(after.stdout).systemMessage, /review the PR/);
});

test('RED at 201a087f: the old Stop hook stayed silent about the open duty', () => {
  const dir = temp('cm-x2b-oldstop-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'mem-stop'),
    execFileSync('git', ['show', `${OLD}:bin/mem-stop`], { cwd: REPO, encoding: 'utf8' }));
  fs.symlinkSync(path.join(REPO, 'bin', 'mem-capture'), path.join(dir, 'bin', 'mem-capture'));
  fs.symlinkSync(path.join(REPO, 'bin', '_portable.sh'), path.join(dir, 'bin', '_portable.sh'));
  fs.symlinkSync(path.join(REPO, 'src'), path.join(dir, 'src'));
  const root = build();
  sow(root);
  const input = { session_id: 'red', transcript_path: transcript(root), stop_hook_active: false };
  const old = stop(path.join(dir, 'bin', 'mem-stop'), root, input);
  assert.equal(old.status, 0);
  assert.equal(old.stdout, '', 'the old stop hook reported (then this red proof proves nothing)');
  const now = stop(STOP, root, { ...input, session_id: 'red2' });
  assert.match(now.stdout, /review the PR/, 'positive control: the new hook reports on the same input');
});
