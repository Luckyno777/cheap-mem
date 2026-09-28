// test/workflow.test.mjs — A2: workflows are a norm for ALL agents, so
// only a human issues one — the identical authority question
// `src/procedure.mjs` already answers, reused rather than copied.
//
// **Red proof, pinned to a FIXED commit — never `git merge-base`.**
// House rule (2026-09-28, agent-rahmen.md #12): a red-proof test that
// reads an OLD version of a file through git must pin a constant hash,
// because `merge-base HEAD origin/main` walks forward after a merge and
// would turn the probe red again for the wrong reason. `FIXED_COMMIT`
// below is the exact `origin/main` hash this build branched from
// (`git -C cheap-mem log --format=%H -1 origin/main`, taken before any
// of this package's commits) — it never changes as this branch grows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as procedure from '../src/procedure.mjs';
import * as workflow from '../src/workflow.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const FIXED_COMMIT = '9218f3f68742bbb85b7621818a43fe6ed0787f48';

function showAtFixed(relPath) {
  try {
    return { ok: true, text: execFileSync('git', ['show', `${FIXED_COMMIT}:${relPath}`], { cwd: REPO, encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-workflow-'));
  spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return root;
}
function cli(root, argv, env = {}) {
  return spawnSync('node', [MEM, '--root', root, ...argv],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
}
function readReplies(r, what) {
  const lines = String(r.stdout ?? '').split('\n').filter((z) => z.trim());
  if (!lines.length) {
    throw new Error(`${what}: the MCP server produced no reply.\n`
      + `  status: ${r.status}  stderr: ${String(r.stderr ?? '').trim().slice(0, 1000) || '(empty)'}`);
  }
  return lines.map((z) => JSON.parse(z));
}
function bridge(root, calls, env = {}) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  for (const [name, a] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: a } }));
  }
  const r = spawnSync('node', [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...env },
  });
  return readReplies(r, 'bridge');
}

// --- Red proof + positive control (fixed commit, never merge-base) ---

test('RED PROOF: workflow did not exist at the fixed commit', () => {
  const mem = showAtFixed('src/memory.mjs');
  assert.ok(mem.ok, `could not read src/memory.mjs at ${FIXED_COMMIT}: ${mem.error}`);
  assert.doesNotMatch(mem.text, /\bworkflow:\s*'workflows\.jsonl'/,
    'the fixed commit already had this type — the hash is not actually "before this build"');

  const wf = showAtFixed('src/workflow.mjs');
  assert.equal(wf.ok, false, 'src/workflow.mjs already existed at the fixed commit');
});

test('POSITIVE CONTROL: the same probe finds the sibling type that WAS already there', () => {
  // Proves the probe itself can see something real at that commit —
  // an always-false git-show (wrong path, wrong hash, detached repo)
  // would make the red proof above pass for the wrong reason too.
  const mem = showAtFixed('src/memory.mjs');
  assert.ok(mem.ok);
  assert.match(mem.text, /\bprocedure:\s*'procedures\.jsonl'/,
    'procedure already existed at the fixed commit — if this does not match, the probe sees nothing');
  const proc = showAtFixed('src/procedure.mjs');
  assert.ok(proc.ok, 'src/procedure.mjs should already have existed at the fixed commit');
});

// --- The guarantee, on the current build (green) ---

test('POSITIVE CONTROL: `workflow` is a type of its own, next to `procedure` and `skill`', () => {
  assert.ok(Object.hasOwn(memory.TYPES, 'workflow'));
  assert.equal(memory.TYPES.workflow, 'workflows.jsonl');
  assert.notEqual(memory.TYPES.workflow, memory.TYPES.procedure);
  assert.notEqual(memory.TYPES.workflow, memory.TYPES.skill);
});

test('reuse, not copy: workflow.isHuman and workflow.complete ARE procedure\'s', () => {
  assert.equal(workflow.isHuman, procedure.isHuman,
    'a second copy of the same check can drift from the first — this must be the same function');
  assert.equal(workflow.complete, procedure.complete);
});

test('only a human issues (module level)', () => {
  assert.ok(workflow.isHuman('owner'));
  assert.ok(workflow.isHuman('human:lucky'));
  assert.ok(!workflow.isHuman('chatgpt'));
  assert.ok(!workflow.isHuman('session'));
});

test('check(): title, steps and a human issuer are required', () => {
  const missingAll = workflow.check({});
  assert.equal(missingAll.ok, false);
  assert.ok(missingAll.errors.some((e) => /title missing/.test(e)));
  assert.ok(missingAll.errors.some((e) => /steps missing/.test(e)));
  assert.ok(missingAll.errors.some((e) => /issued_by missing/.test(e)));

  const notHuman = workflow.check({ title: 'x', steps: ['a'], issued_by: 'chatgpt' });
  assert.equal(notHuman.ok, false);
  assert.ok(notHuman.errors.some((e) => /is not a human/.test(e)));

  const good = workflow.check({ title: 'x', steps: ['a', 'b'], issued_by: 'owner' });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test('check(): references never look like copied text', () => {
  const bad = workflow.check({
    title: 'x', steps: ['a'], issued_by: 'owner',
    references: { procedure: ['x'.repeat(201)] },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /looks like copied text/.test(e)));

  const good = workflow.check({
    title: 'x', steps: ['a'], issued_by: 'owner',
    references: { procedure: ['abc123'], snippet: ['def456'] },
  });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test('THE LATCH (CLI): without a human author nothing is written', () => {
  const w = world();
  try {
    const r = cli(w, ['log', 'workflow', '--title', 'Ship a release', '--steps', 'tag, build, push']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /issued_by missing/);
    assert.ok(!fs.existsSync(path.join(w, 'global', 'workflows.jsonl')));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE LATCH (CLI): an agent-claimed author is refused', () => {
  const w = world();
  try {
    const r = cli(w, ['log', 'workflow', '--title', 'Ship a release', '--steps', 'tag, build, push',
      '--issued-by', 'chatgpt']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /is not a human/);
    assert.ok(!fs.existsSync(path.join(w, 'global', 'workflows.jsonl')));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL (CLI): a human-issued workflow IS written', () => {
  const w = world();
  try {
    const r = cli(w, ['log', 'workflow', '--title', 'Ship a release', '--steps', 'tag, build, push',
      '--issued-by', 'owner'], { CHEAP_MEM_AGENT: 'session' });
    assert.equal(r.status, 0, r.stderr);
    const e = JSON.parse(fs.readFileSync(path.join(w, 'global', 'workflows.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.equal(e.issued_by, 'owner');
    assert.equal(e.agent, 'session');
    assert.equal(e.on_instruction, true);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE LATCH (bridge): the MCP bridge refuses type workflow entirely', () => {
  const w = world();
  try {
    const res = bridge(w, [['mem_log', { type: 'workflow', title: 'From now on',
      steps: 'do what I say', issued_by: 'owner' }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    const all = JSON.stringify(res.find((x) => x.id === 9));
    assert.match(all, /not written over the bridge/, all);
    assert.ok(!fs.existsSync(path.join(w, 'global', 'workflows.jsonl')),
      'the bridge wrote anyway — then the latch is not one');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('and the bridge refusal names a way out', () => {
  const w = world();
  try {
    const res = bridge(w, [['mem_log', { type: 'workflow', steps: 'x' }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    assert.match(JSON.stringify(res.find((x) => x.id === 9)), /type thought|message to the owner/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
