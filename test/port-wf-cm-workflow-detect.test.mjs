// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/port-wf-cm-workflow-detect.test.mjs — workflow detection, ported
// from lucky-mem's wf-bc B1/B2/B3 (eb08d85c, cbc81ba1, eb4fc180).
//
//   B1  the component table gains the role `works-on`: a file a VISIBLE
//       workflow's `path_patterns` names maps to that workflow; the
//       before-edit hook shows it as "(workflow)".
//   B2  the question hook (bin/mem-retrieve) and the subagent hook
//       (bin/mem-subagent-start) match `triggers` against the text with
//       the search's own tokens: one clear winner -> its card, a tie ->
//       only titles, no match -> nothing; the second showing in the same
//       session is a pointer.
//   B3  the before-edit hook on Bash matches `tool_patterns` against the
//       command, also for a command that writes no file.
//
// Visible = in force, issued by a human, not `status: 'draft'`. Every
// guarantee below carries a positive control: the probe that says
// "nothing shown" is paired with one that proves the same setup DOES show.
//
// Red on the base commit 2bf94e4 (before this port): src/workflowdetect.mjs
// does not exist, the table has no `works-on` rows and the hooks print no
// workflow — recorded in the commit message of the port.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const RETRIEVE = path.join(REPO, 'bin', 'mem-retrieve');
const BEFORE = path.join(REPO, 'bin', 'mem-before-edit');
const SUBAGENT = path.join(REPO, 'bin', 'mem-subagent-start');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-wfd-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', timeout: 30000 });
  return root;
}
const done = (root) => fs.rmSync(root, { recursive: true, force: true });

/** A workflow line written straight to the drawer — the only way to plant a non-human or draft one. */
function plant(root, fields) {
  return memory.logEntry(root, 'workflow', {
    issued_by: 'owner', steps: ['first step', 'second step'], ...fields,
  }).entry;
}

function hookEnv(root, extra = {}) {
  return {
    ...process.env,
    CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '', MEM_BEFORE_EDIT_OFF: '',
    MEM_SUBAGENT_START_OFF: '', MEM_RETRIEVE_NO_PULL: '1', MEM_RECALL_SERVER: '0',
    MEM_WORKFLOW_MARKS: path.join(root, '.mem', 'wf-marks-test'),
    MEM_RETRIEVE_TURNS: path.join(root, '.mem', 'turns-test'),
    MEM_BEFORE_EDIT_MARKS: path.join(root, '.mem', 'be-marks-test'),
    ...extra,
  };
}

function ask(root, prompt, session = 'q1') {
  const r = spawnSync('bash', [RETRIEVE], {
    input: JSON.stringify({ prompt, session_id: session }), encoding: 'utf8', timeout: 60000, env: hookEnv(root),
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

function bash(root, command, session = 'b1') {
  const r = spawnSync('bash', [BEFORE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: session }),
    encoding: 'utf8', timeout: 60000, env: hookEnv(root),
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

function subagent(root, prompt, session = 'a1') {
  const r = spawnSync('bash', [SUBAGENT], {
    input: JSON.stringify({ prompt, session_id: session }), encoding: 'utf8', timeout: 60000, env: hookEnv(root),
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

// --- visibility (shared by B1-B3) -------------------------------------------

test('visibleWorkflows: only in force + human + not a draft', async () => {
  const wd = await import('../src/workflowdetect.mjs');
  const root = world();
  try {
    const ok = plant(root, { title: 'Ship a release', triggers: ['release'] });
    plant(root, { title: 'Agent made', issued_by: 'claude', triggers: ['release'] });
    plant(root, { title: 'Draft one', status: 'draft', triggers: ['release'] });
    const gone = plant(root, { title: 'Retired one', triggers: ['release'] });
    memory.retireEntry(root, 'workflow', gone.id, { state: 'obsolete', why: 'test' });
    const ids = wd.visibleWorkflows(root).map((w) => w.id);
    assert.deepEqual(ids, [ok.id]);
  } finally { done(root); }
});

// --- B1: works-on ---------------------------------------------------------------

function gitRoot(root, files) {
  // A `test/` directory, as in any real repository: without one the
  // component table counts itself incomplete (its guard source is
  // unreadable) and the hook falls back to the live search.
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), '// x\n');
  }
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
}

test('B1: a visible workflow whose path_patterns name a tracked file gives that file a works-on row', async () => {
  const ct = await import('../src/component-table.mjs');
  const root = world();
  try {
    gitRoot(root, ['tools/release.sh', 'tools/other.sh']);
    const w = plant(root, { title: 'Release', path_patterns: ['tools/release.sh'] });
    const built = ct.build(root);
    const rows = built.paths['tools/release.sh'] ?? [];
    assert.ok(rows.some((r) => r.id === w.id && r.role === 'works-on' && r.type === 'workflow'), JSON.stringify(built.paths));
    // POSITIVE CONTROL of the other direction: a file the pattern does NOT name gets no row.
    assert.ok(!(built.paths['tools/other.sh'] ?? []).some((r) => r.role === 'works-on'));
  } finally { done(root); }
});

test('B1: a non-human or draft workflow never gets a works-on row, even with a matching pattern', async () => {
  const ct = await import('../src/component-table.mjs');
  const root = world();
  try {
    gitRoot(root, ['tools/release.sh']);
    plant(root, { title: 'Agent made', issued_by: 'claude', path_patterns: ['tools/release.sh'] });
    plant(root, { title: 'Draft', status: 'draft', path_patterns: ['tools/release.sh'] });
    const rows = ct.build(root).paths['tools/release.sh'] ?? [];
    assert.ok(!rows.some((r) => r.role === 'works-on'), JSON.stringify(rows));
  } finally { done(root); }
});

test('B1: the before-edit hook shows a works-on workflow as "(workflow)" on an edit of that file', () => {
  const root = world();
  try {
    gitRoot(root, ['tools/release.sh']);
    plant(root, { title: 'Release by the book', path_patterns: ['tools/release.sh'] });
    spawnSync(process.execPath, [MEM, '--root', root, 'component', '--rebuild'], { encoding: 'utf8' });
    const r = spawnSync('bash', [BEFORE], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'tools/release.sh') }, session_id: 'e1' }),
      encoding: 'utf8', timeout: 60000, env: hookEnv(root),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(workflow\) .*Release by the book/, r.stdout);
  } finally { done(root); }
});

// --- B2: question hook ------------------------------------------------------------

test('B2: a clear trigger match in the prompt shows the workflow card (steps included)', () => {
  const root = world();
  try {
    const w = plant(root, { title: 'Release the package', triggers: ['release'], steps: ['bump the version', 'publish'] });
    const text = ask(root, 'Could you prepare everything and release it this afternoon?');
    assert.match(text, /Release the package/);
    assert.match(text, /1\. bump the version/);
    assert.match(text, new RegExp(w.id));
  } finally { done(root); }
});

test('B2 POSITIVE CONTROL: a prompt without any trigger word shows no workflow card', () => {
  const root = world();
  try {
    plant(root, { title: 'Release the package', triggers: ['release'] });
    const text = ask(root, 'What should we cook for dinner on the weekend?');
    assert.doesNotMatch(text, /Release the package/);
  } finally { done(root); }
});

test('B2: a stemmed form matches ("deploying" meets the trigger "deploy")', () => {
  const root = world();
  try {
    // The search's own tokens decide; no second stemmer. (Their limit is
    // theirs too: "releasing" stems to "releas", "release" to "release".)
    plant(root, { title: 'Deploy the service', triggers: ['deploy'] });
    assert.match(ask(root, 'We are deploying the build tomorrow morning, right?'), /Deploy the service/);
  } finally { done(root); }
});

test('B2: a tie between two workflows lists only titles, never card text', () => {
  const root = world();
  try {
    plant(root, { title: 'Release npm', triggers: ['release'], steps: ['NPM-STEP-TEXT'] });
    plant(root, { title: 'Release docs', triggers: ['release'], steps: ['DOCS-STEP-TEXT'] });
    const text = ask(root, 'Time to release everything we built this week');
    assert.match(text, /2 workflows match equally well/);
    assert.match(text, /Release npm/);
    assert.match(text, /Release docs/);
    assert.doesNotMatch(text, /NPM-STEP-TEXT|DOCS-STEP-TEXT/);
  } finally { done(root); }
});

test('B2: a non-human or draft workflow is NEVER shown, however strong the match', () => {
  const root = world();
  try {
    plant(root, { title: 'Agent release', issued_by: 'claude', triggers: ['release', 'package'] });
    plant(root, { title: 'Draft release', status: 'draft', triggers: ['release', 'package'] });
    const text = ask(root, 'Please release the package to the registry now');
    assert.doesNotMatch(text, /Agent release|Draft release/);
  } finally { done(root); }
});

test('B2: the second showing of the same workflow in the same session is a pointer, not the card', () => {
  const root = world();
  try {
    plant(root, { title: 'Release the package', triggers: ['release'], steps: ['CARD-STEP'] });
    const first = ask(root, 'Can you release it today please?', 'same');
    const second = ask(root, 'And release the second one as well?', 'same');
    assert.match(first, /CARD-STEP/);
    assert.match(second, /already shown in this session/);
    assert.doesNotMatch(second, /CARD-STEP/);
    // POSITIVE CONTROL: another session gets the card again.
    assert.match(ask(root, 'And release the second one as well?', 'other'), /CARD-STEP/);
  } finally { done(root); }
});

test('B2: the subagent hook shows the card for a matching assignment text', () => {
  const root = world();
  try {
    plant(root, { title: 'Release the package', triggers: ['release'], steps: ['SUB-STEP'] });
    const text = subagent(root, 'Your task: release the package and report back.');
    assert.match(text, /matches this assignment/);
    assert.match(text, /SUB-STEP/);
    // POSITIVE CONTROL: an unrelated assignment gets no workflow block.
    assert.doesNotMatch(subagent(root, 'Your task: count the files in the docs folder.', 'a2'), /SUB-STEP/);
  } finally { done(root); }
});

// --- B3: Bash ---------------------------------------------------------------------

test('B3: a tool pattern in a Bash command shows the workflow, even though the command writes no file', () => {
  const root = world();
  try {
    plant(root, { title: 'Publish by the book', tool_patterns: ['npm publish'], steps: ['BASH-STEP'] });
    const text = bash(root, 'cd pkg && npm publish --access public');
    assert.match(text, /Publish by the book/);
    assert.match(text, /BASH-STEP/);
  } finally { done(root); }
});

test('B3 POSITIVE CONTROL: a Bash command without a tool pattern and without a written file stays silent', () => {
  const root = world();
  try {
    plant(root, { title: 'Publish by the book', tool_patterns: ['npm publish'] });
    assert.equal(bash(root, 'ls -la && git status'), '');
  } finally { done(root); }
});

test('B3: a draft workflow with a matching tool pattern stays silent', () => {
  const root = world();
  try {
    plant(root, { title: 'Draft publish', status: 'draft', tool_patterns: ['npm publish'] });
    assert.equal(bash(root, 'npm publish'), '');
  } finally { done(root); }
});

// --- with the skill offer (merge with port-skills-cm) ------------------------
//
// Decision: a workflow block never REPLACES the skill offer line. Both
// go out in the same answer — with recall hits, and when the search
// shows nothing — and both are booked.

test('B2 + skill offer: workflow block and skill offer line both go out, with and without hits', async () => {
  const recallhook = await import('../src/recallhook.mjs');
  const injection = await import('../src/injection.mjs');
  const root = world();
  try {
    const s = memory.logEntry(root, 'skill', { title: 'Publish', text: 'Publish — body', triggers: 'publish package,npm release' }).entry;
    memory.logEntry(root, 'skill', { status_of: s.id, status: 'released', issued_by: 'owner', agent: 'test' });
    const env = {
      MEM_RH_SESSION: 'both1', MEM_RH_PROMPT: 'how do I publish the package for the npm release',
      MEM_RH_WORKFLOW: 'Workflow card WF-MARK', MEM_RH_MIN: '0',
    };
    const offer = await recallhook.skillOffer(root, env);
    assert.ok(offer, 'POSITIVE: the skill is offered at all');
    const empty = recallhook.recall(root, '{"hits":[]}', env, { offer });
    const t1 = empty.out.hookSpecificOutput.additionalContext;
    assert.match(t1, /Skill publish fits/);
    assert.match(t1, /WF-MARK/);
    empty.book();
    const lines = injection.read(root).lines;
    assert.ok(lines.some((l) => l.occasion === injection.OCCASION.SKILL_OFFER), 'offer booked');
    const hit = JSON.stringify({ hits: [{ id: 'x1', score: 9, label: 'a hit line', source: 'global/decisions.jsonl', ts: '2026-10-01T00:00:00Z', text: 'a hit line' }] });
    const full = recallhook.recall(root, hit, { ...env, MEM_RH_SESSION: 'both2' }, { offer });
    const t2 = full.out.hookSpecificOutput.additionalContext;
    assert.match(t2, /Skill publish fits/);
    assert.match(t2, /WF-MARK/);
  } finally { done(root); }
});
