// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/answer-check.test.mjs — the Stop-hook answer check
// (src/answercheck.mjs, bin/mem-stop).
//
// Three guarantees, mirrored from the reasoning in src/answercheck.mjs:
//   1. no pattern on suspicion — every `error_id` must be a real id
//      already logged in THIS memory's own errors.jsonl;
//   2. at most one report per session per pattern, never on
//      `stop_hook_active`;
//   3. under 1 correct report in 5 (measured), a pattern is out.
// Patterns here are built for the test, the same way a real memory
// would build its own `.mem/answer-patterns.json` — never a built-in
// list, and this suite proves that an unlogged error_id is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as ac from '../src/answercheck.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'bin', 'mem-stop');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-anscheck-')); }

function memory() {
  const r = scratch();
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const run = (r, ...a) =>
  spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });

function writePatterns(root, patterns) {
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'answer-patterns.json'), JSON.stringify(patterns));
}

function transcript(dir, lines) {
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('loadPatterns: drops a pattern whose error_id is not logged in this memory (no suspicion)', () => {
  const r = memory();
  try {
    run(r, 'log', 'error', '--class', 'concurrency', '--title', 'a real one', '--text', 'x');
    writePatterns(r, [
      { id: 'ghost', error_id: 'not-a-real-id', pattern: 'anything', reason: 'x' },
    ]);
    const { patterns, rejected } = ac.loadPatterns(r);
    assert.equal(patterns.length, 0);
    assert.match(rejected[0].why, /not logged/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('loadPatterns: a pattern bound to a real logged error is kept', () => {
  const r = memory();
  try {
    const out = run(r, 'log', 'error', '--class', 'concurrency', '--title', 'x', '--text', 'y').stdout;
    const id = /id:\s*(\S+)/.exec(out)[1];
    writePatterns(r, [{ id: 'p1', error_id: id, pattern: 'boom', reason: 'seen before' }]);
    const { patterns, rejected } = ac.loadPatterns(r);
    assert.equal(patterns.length, 1, JSON.stringify(rejected));
    assert.equal(patterns[0].error_id, id);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('loadPatterns: no file at all -> empty, not an error', () => {
  const r = memory();
  try {
    const { patterns, missing } = ac.loadPatterns(r);
    assert.deepEqual(patterns, []);
    assert.equal(missing, true);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('isActive: kill switch fires under 1 correct in 5, unknown below 5 reports stays active', () => {
  const base = { error_id: 'e', regex: /x/ };
  assert.equal(ac.isActive({ ...base, measured: { reports: 10, correct: 1 } }), false, '1/10 < 1/5');
  assert.equal(ac.isActive({ ...base, measured: { reports: 10, correct: 2 } }), true, '2/10 = 1/5 holds');
  assert.equal(ac.isActive({ ...base, measured: { reports: 4, correct: 0 } }), true, 'under 5: unknown, not bad');
  assert.equal(ac.isActive({ ...base, error_id: '' }), false, 'no error_id: never active');
  assert.equal(ac.isActive({ ...base, disabled: true }), false);
  assert.equal(ac.isActive(null), false);
});

test('checkText: matches a pattern, redacts the excerpt, an inactive pattern reports nothing', () => {
  const p = { id: 'p1', error_id: 'e', reason: 'r', regex: /forbidden-thing/i,
    measured: null };
  const hits = ac.checkText('line one\nsaw a Forbidden-Thing here "quoted"\nline three', [p]);
  assert.equal(hits.length, 1);
  assert.ok(!/"/.test(hits[0].excerpt), 'quotes must be redacted out of the excerpt');
  const killed = { ...p, measured: { reports: 10, correct: 0 } };
  assert.deepEqual(ac.checkText('saw a Forbidden-Thing here', [killed]), []);
});

test('lastAssistantMessageFromLines: only assistant text after the last user line, no sidechains', () => {
  const lines = [
    { type: 'user', message: { content: 'q' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'old' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'new 1' }] } },
    { type: 'assistant', message: { content: 'new 2' } },
  ];
  assert.equal(ac.lastAssistantMessageFromLines(lines), 'new 1\nnew 2');
  assert.equal(ac.lastAssistantMessageFromLines([{ type: 'user', message: { content: 'only a question' } }]), null);
});

test('checkStop: a hit blocks with the pattern id and error id, once per session per pattern, never on stop_hook_active', () => {
  const r = memory();
  try {
    const out = run(r, 'log', 'error', '--class', 'concurrency', '--title', 'x', '--text', 'y').stdout;
    const errId = /id:\s*(\S+)/.exec(out)[1];
    writePatterns(r, [{ id: 'p1', error_id: errId, pattern: 'do-the-forbidden-thing', reason: 'that mistake again' }]);
    const t = transcript(r, [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok, will do-the-forbidden-thing now' }] } },
    ]);
    const input = { session_id: 's1', transcript_path: t, stop_hook_active: false };
    assert.equal(ac.checkStop(r, { ...input, stop_hook_active: true }), null, 'already continued once: never again');
    const res = ac.checkStop(r, input);
    assert.equal(res?.decision, 'block');
    assert.match(res.reason, /p1/);
    assert.match(res.reason, new RegExp(errId));
    assert.equal(ac.checkStop(r, input), null, 'same session, same pattern: only once');
    assert.equal(ac.checkStop(r, { ...input, session_id: 's2' })?.decision, 'block', 'a different session reports again');
    assert.equal(ac.checkStop(r, { session_id: 's3', last_assistant_message: 'all clean here' }), null);
    assert.equal(ac.checkStop(r, { ...input, session_id: 's4' }, { env: { MEM_ANSWER_CHECK: '0' } }), null);
    assert.equal(ac.checkStop(r, null), null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('checkStop: no patterns file at all -> silent (the shipped default)', () => {
  const r = memory();
  try {
    assert.equal(ac.checkStop(r, { session_id: 'x', last_assistant_message: 'anything at all' }), null);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('bin/mem-stop: a hit prints exactly one block-JSON on stdout, a clean answer prints nothing', () => {
  const r = memory();
  try {
    const out = run(r, 'log', 'error', '--class', 'concurrency', '--title', 'x', '--text', 'y').stdout;
    const errId = /id:\s*(\S+)/.exec(out)[1];
    writePatterns(r, [{ id: 'p1', error_id: errId, pattern: 'do-the-forbidden-thing', reason: 'x' }]);

    const lauf = (text, session) => {
      const t = transcript(r, [
        { type: 'user', message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      ]);
      return spawnSync('bash', [HOOK], {
        input: JSON.stringify({ session_id: session, transcript_path: t, stop_hook_active: false }),
        encoding: 'utf8',
        env: { ...process.env, CHEAP_MEM_ROOT: r, MEM_STOP_NO_PUSH: '1', MEM_HEADLESS: '', MEM_HOOK_OFF: '', MEM_REFLECT: '' },
      });
    };
    const why = (res) => `status ${res.status}, stderr: ${String(res.stderr).slice(-800)}`;

    const clean = lauf('all fine here', 'k1');
    assert.equal(clean.status, 0, why(clean));
    assert.equal(clean.stdout, '', `positive control that a clean run stays silent — ${why(clean)}`);

    const hit = lauf('going to do-the-forbidden-thing right now', 'k2');
    assert.equal(hit.status, 0, why(hit));
    assert.notEqual(hit.stdout.trim(), '', `hit produced no block-JSON — ${why(hit)}`);
    const j = JSON.parse(hit.stdout);
    assert.equal(j.decision, 'block');
    assert.match(j.reason, /p1/);

    const second = lauf('going to do-the-forbidden-thing right now', 'k2');
    assert.equal(second.stdout, '', `second Stop, same session: must stay silent — ${why(second)}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
