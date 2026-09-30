// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/subagent-start.test.mjs — the SubagentStart hook (procedure.mjs's
// `forSubagentStart`, src/subagentstart.mjs, bin/mem-subagent-start).
//
// A subagent gets neither SessionStart nor UserPromptSubmit (its own
// thread — src/gauges.mjs), so left alone it starts knowing nothing this
// memory holds. This hook is what shows it, before its first task:
//   1. any procedure a human tagged `subagent-start` — never invented
//      here, only a human can issue one (procedure.mjs);
//   2. a context recap, spent on whatever budget the procedures block
//      left, capped in total (subagentstart.CAP_CHARS).
//
// Retired procedures are excluded the same way `mem procedures` excludes
// them (one reading of "in force"), and the whole block is silent about
// nothing: a memory with no tagged procedure says so in one sentence
// instead of just omitting the section.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as procedure from '../src/procedure.mjs';
import * as subagentstart from '../src/subagentstart.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'bin', 'mem-subagent-start');

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-subagent-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
const run = (r, ...a) =>
  spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });

const RULE = ['log', 'procedure',
  '--title', 'Own worktree, own branch',
  '--rule', 'Every agent assignment gets its own worktree and branch; never the main tree.',
  '--issued-by', 'owner', '--tags', 'subagent-start',
  // E4: a new rule starts as proposed, which a subagent is never shown;
  // these tests are about released rules, so say so explicitly.
  '--start-as', 'released'];

test('THE CASE: a procedure tagged subagent-start is offered, an untagged one is not', () => {
  const r = memory();
  try {
    run(r, ...RULE);
    run(r, 'log', 'procedure', '--title', 'Unrelated rule',
      '--rule', 'Name releases YYYY-MM-DD.', '--issued-by', 'owner');
    const hits = procedure.forSubagentStart(r);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].title, 'Own worktree, own branch');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('COUNTER-PROBE: no tagged procedure at all means an empty list, not everything', () => {
  const r = memory();
  try {
    run(r, 'log', 'procedure', '--title', 'x', '--rule', 'y', '--issued-by', 'owner');
    assert.deepEqual(procedure.forSubagentStart(r), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a retired subagent-start procedure is not offered', () => {
  const r = memory();
  try {
    run(r, ...RULE);
    const line = JSON.parse(
      fs.readFileSync(path.join(r, 'global', 'procedures.jsonl'), 'utf8').trim());
    run(r, 'done', line.id, '--why', 'superseded');
    assert.equal(procedure.forSubagentStart(r).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a correction (replaces_id) shows only the new text, never both', () => {
  // The exact defect a streaming reader fell into on the sibling side:
  // a correction superseded the original, but a reader that only ever
  // sees one line at a time never learns `replaces_id` names an id it
  // already passed, and shows both. `forSubagentStart` reads with
  // `readLog` (materialised) + `retiredMap`, the same pair `forClass`
  // and `forKeywords` already use, so this cannot recur here.
  const r = memory();
  try {
    run(r, ...RULE);
    const line = JSON.parse(
      fs.readFileSync(path.join(r, 'global', 'procedures.jsonl'), 'utf8').trim());
    run(r, 'correction', 'procedure', line.id, '--title', 'Own worktree, own branch (corrected)',
      '--rule', 'Every agent assignment gets its own worktree AND its own tree ownership boundary.',
      '--issued_by', 'owner', '--tags', 'subagent-start');
    const hits = procedure.forSubagentStart(r);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].title, /corrected/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('several tagged procedures come back oldest first', () => {
  const r = memory();
  try {
    run(r, 'log', 'procedure', '--title', 'First', '--rule', 'a',
      '--issued-by', 'owner', '--tags', 'subagent-start', '--start-as', 'released');
    run(r, 'log', 'procedure', '--title', 'Second', '--rule', 'b',
      '--issued-by', 'owner', '--tags', 'subagent-start', '--start-as', 'released');
    const hits = procedure.forSubagentStart(r);
    assert.deepEqual(hits.map((e) => e.title), ['First', 'Second']);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('buildContext: with a tagged procedure, its marking and rule text are in the block', () => {
  const r = memory();
  try {
    run(r, ...RULE);
    const text = subagentstart.buildContext(r);
    assert.match(text, /Procedure, issued by owner on \d{4}-\d{2}-\d{2}/);
    assert.match(text, /Own worktree, own branch/);
    assert.match(text, /Every agent assignment gets its own worktree/);
    assert.match(text, /mem component <path>/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('buildContext: without any tagged procedure, says so honestly instead of nothing', () => {
  const r = memory();
  try {
    const text = subagentstart.buildContext(r);
    assert.match(text, /no procedure tagged 'subagent-start'/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('buildContext: never exceeds its own cap, even with a very large procedures block', () => {
  const r = memory();
  try {
    run(r, 'log', 'procedure', '--title', 'Huge',
      '--rule', 'x'.repeat(subagentstart.CAP_CHARS * 2), '--issued-by', 'owner',
      '--tags', 'subagent-start', '--start-as', 'released');
    const text = subagentstart.buildContext(r);
    assert.ok(text.length <= subagentstart.CAP_CHARS * 2 + 500,
      // The procedures block itself is never cut (a human's rule is not
      // the part that gives way) — so with a rule this oversized the
      // total is allowed to exceed CAP_CHARS. What must hold is that the
      // hint is still appended and the recap contributed nothing.
      `block: ${text.length} chars`);
    assert.match(text, /mem component <path>/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('hookResult: shaped for Claude Code, hookEventName SubagentStart', () => {
  const r = memory();
  try {
    run(r, ...RULE);
    const res = subagentstart.hookResult(r);
    assert.equal(res.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.match(res.hookSpecificOutput.additionalContext, /Own worktree, own branch/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('bin/mem-subagent-start: prints the hook JSON on stdout, exits 0', () => {
  const r = memory();
  try {
    run(r, ...RULE);
    const res = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ session_id: 'sub1' }),
      encoding: 'utf8',
      env: { ...process.env, CHEAP_MEM_ROOT: r },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const j = JSON.parse(res.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.match(j.hookSpecificOutput.additionalContext, /Own worktree, own branch/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('bin/mem-subagent-start: no memory found -> silent, exit 0 (never blocks a subagent start)', () => {
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 'sub2' }),
    encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: path.join(os.tmpdir(), 'no-such-cm-memory-xyz') },
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(res.stdout, '');
});

test('MEM_HOOK_OFF=1 silences the hook entirely', () => {
  const r = memory();
  try {
    run(r, ...RULE);
    const res = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ session_id: 'sub3' }),
      encoding: 'utf8',
      env: { ...process.env, CHEAP_MEM_ROOT: r, MEM_HOOK_OFF: '1' },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout, '');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
