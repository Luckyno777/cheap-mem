// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/port-wf-cm-workflow-cli.test.mjs — `mem workflow` / `mem snippet`
// and the two doctor findings, ported from lucky-mem's wf-bc C1 (1b12f12b)
// and C2 (3941ac8d).
//
// C1: `mem log workflow` could never set `triggers`/`path_patterns`/
// `tool_patterns` (a comma list arrives as one string and
// `workflow.check()` rightly refuses it), so the fields that make a
// workflow findable had no way in from the keyboard. `mem workflow new`
// takes them as lists and runs the same authority check; `check` writes
// nothing; `list`/`show` cover visible workflows. `mem snippet new` runs
// the same redaction gate as `mem log snippet`.
//
// C2: `workflow-without-trigger` (warn, never error) and
// `snippet-without-redaction` (error: a real data-protection finding).
//
// Red on the base commit 2bf94e4: `mem workflow`/`mem snippet` are
// unknown commands and neither finding exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as doctor from '../src/doctor.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-wfcli-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', timeout: 30000 });
  return root;
}
const done = (root) => fs.rmSync(root, { recursive: true, force: true });
const run = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a], { encoding: 'utf8', timeout: 30000 });
const lines = (root, type) => {
  try { return fs.readFileSync(memory.logPath(root, type), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

const GOOD = ['--title', 'Release the package', '--steps', 'bump the version; run the suite, all green; publish',
  '--issued-by', 'owner', '--triggers', 'release,publish package', '--tool-patterns', 'npm publish',
  '--path-patterns', 'bin/mem-release'];

// --- C1 ----------------------------------------------------------------------

test('mem workflow: an unknown subcommand aborts (exit != 0)', () => {
  const root = world();
  try { assert.notEqual(run(root, 'workflow', 'frobnicate').status, 0); } finally { done(root); }
});

test('mem workflow --help: help, exit 0, writes nothing', () => {
  const root = world();
  try {
    const r = run(root, 'workflow', '--help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /mem workflow new/);
    assert.equal(lines(root, 'workflow'), 0);
  } finally { done(root); }
});

test('mem workflow check: valid fields -> OK, writes NOTHING', () => {
  const root = world();
  try {
    const r = run(root, 'workflow', 'check', ...GOOD);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
    assert.equal(lines(root, 'workflow'), 0);
  } finally { done(root); }
});

test('mem workflow check / new: a non-human issuer is refused; new writes nothing', () => {
  const root = world();
  try {
    const bad = ['--title', 'x', '--steps', 'a', '--issued-by', 'claude'];
    const c = run(root, 'workflow', 'check', ...bad);
    assert.equal(c.status, 1);
    assert.match(c.stdout, /Not accepted/);
    const n = run(root, 'workflow', 'new', ...bad);
    assert.equal(n.status, 1);
    assert.equal(lines(root, 'workflow'), 0);
  } finally { done(root); }
});

test('mem workflow new: valid fields are written WITH their lists, then visible via list/show', () => {
  const root = world();
  try {
    const r = run(root, 'workflow', 'new', ...GOOD);
    assert.equal(r.status, 0, r.stderr);
    const id = /id: (\S+)/.exec(r.stdout)[1];
    const e = memory.getEntry(root, id);
    assert.deepEqual(e.triggers, ['release', 'publish package']);
    assert.deepEqual(e.tool_patterns, ['npm publish']);
    assert.deepEqual(e.path_patterns, ['bin/mem-release']);
    assert.deepEqual(e.steps, ['bump the version', 'run the suite, all green', 'publish']);
    assert.match(run(root, 'workflow', 'list').stdout, new RegExp(id));
    const show = run(root, 'workflow', 'show', id).stdout;
    assert.match(show, /2\. run the suite, all green/);
    assert.match(show, /triggers: release, publish package/);
  } finally { done(root); }
});

test('mem workflow list: a non-human or draft workflow is not listed (positive control: a human one is)', () => {
  const root = world();
  try {
    memory.logEntry(root, 'workflow', { title: 'Agent made', steps: ['a'], issued_by: 'claude' });
    memory.logEntry(root, 'workflow', { title: 'Draft made', steps: ['a'], issued_by: 'owner', status: 'draft' });
    memory.logEntry(root, 'workflow', { title: 'Human made', steps: ['a'], issued_by: 'owner' });
    const out = run(root, 'workflow', 'list').stdout;
    assert.match(out, /Human made/);
    assert.doesNotMatch(out, /Agent made|Draft made/);
  } finally { done(root); }
});

test('mem workflow show: an unknown id aborts', () => {
  const root = world();
  try { assert.notEqual(run(root, 'workflow', 'show', 'nosuchid0000').status, 0); } finally { done(root); }
});

test('mem snippet new: a mail WITH a real credential aborts, nothing written', () => {
  const root = world();
  try {
    const secret = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const r = run(root, 'snippet', 'new', '--title', 'Leaky', '--kind', 'mail', '--body', `Use token ${secret} to log in`);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(lines(root, 'snippet'), 0);
  } finally { done(root); }
});

test('mem snippet new: a mail with placeholders is written, then visible via list/show', () => {
  const root = world();
  try {
    const r = run(root, 'snippet', 'new', '--title', 'Welcome', '--kind', 'mail', '--body', 'Hello {{NAME}}, welcome.');
    assert.equal(r.status, 0, r.stderr);
    const id = /id: (\S+)/.exec(r.stdout)[1];
    assert.match(run(root, 'snippet', 'list').stdout, new RegExp(id));
    assert.match(run(root, 'snippet', 'show', id).stdout, /placeholders: \{\{NAME\}\}/);
  } finally { done(root); }
});

// --- C2 ----------------------------------------------------------------------

test('workflow-without-trigger: no workflow -> unknown (not measurable)', () => {
  const root = world();
  try { assert.equal(doctor.checkWorkflowWithoutTrigger(root).level, doctor.LEVEL.UNKNOWN); } finally { done(root); }
});

test('workflow-without-trigger: a workflow with none of the three -> warn; POSITIVE CONTROL: with triggers -> good', () => {
  const root = world();
  try {
    const w = memory.logEntry(root, 'workflow', { title: 'Unreachable', steps: ['a'], issued_by: 'owner' }).entry;
    const f = doctor.checkWorkflowWithoutTrigger(root);
    assert.equal(f.level, doctor.LEVEL.WARN);
    assert.match(f.text, new RegExp(w.id));
    const root2 = world();
    try {
      memory.logEntry(root2, 'workflow', { title: 'Reachable', steps: ['a'], issued_by: 'owner', triggers: ['release'] });
      assert.equal(doctor.checkWorkflowWithoutTrigger(root2).level, doctor.LEVEL.GOOD);
    } finally { done(root2); }
  } finally { done(root); }
});

test('workflow-without-trigger: a path or tool pattern alone is enough', () => {
  const root = world();
  try {
    memory.logEntry(root, 'workflow', { title: 'P', steps: ['a'], issued_by: 'owner', path_patterns: ['src/x.mjs'] });
    memory.logEntry(root, 'workflow', { title: 'T', steps: ['a'], issued_by: 'owner', tool_patterns: ['npm test'] });
    assert.equal(doctor.checkWorkflowWithoutTrigger(root).level, doctor.LEVEL.GOOD);
  } finally { done(root); }
});

test('snippet-without-redaction: no snippets -> unknown', () => {
  const root = world();
  try { assert.equal(doctor.checkSnippetWithoutRedaction(root).level, doctor.LEVEL.UNKNOWN); } finally { done(root); }
});

test('snippet-without-redaction: a code snippet is not bound by the duty -> good', () => {
  const root = world();
  try {
    const secret = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    fs.appendFileSync(memory.logPath(root, 'snippet'),
      `${JSON.stringify({ id: 'code00000001', ts: '2026-10-01T00:00:00Z', title: 'c', kind: 'code', body: `const t = '${secret}'` })}\n`);
    assert.equal(doctor.checkSnippetWithoutRedaction(root).level, doctor.LEVEL.GOOD);
  } finally { done(root); }
});

test('snippet-without-redaction: a legacy mail snippet with a real credential -> error; POSITIVE CONTROL: placeholders -> good', () => {
  const root = world();
  try {
    const secret = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    // Written around the gate on purpose: a legacy line, as an import would leave it.
    fs.appendFileSync(memory.logPath(root, 'snippet'),
      `${JSON.stringify({ id: 'leak00000001', ts: '2026-10-01T00:00:00Z', title: 'm', kind: 'mail', body: `token ${secret}` })}\n`);
    const f = doctor.checkSnippetWithoutRedaction(root);
    assert.equal(f.level, doctor.LEVEL.ERROR);
    assert.match(f.text, /leak00000001/);
    const root2 = world();
    try {
      run(root2, 'snippet', 'new', '--title', 'ok', '--kind', 'mail', '--body', 'Hello {{NAME}}');
      assert.equal(doctor.checkSnippetWithoutRedaction(root2).level, doctor.LEVEL.GOOD);
    } finally { done(root2); }
  } finally { done(root); }
});
