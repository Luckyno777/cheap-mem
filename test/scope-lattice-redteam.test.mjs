// The scope lattice red-team probe (build point P13).
//
// **The question.** `src/capability.mjs` says about itself: "a different
// process can construct a permissive capability, and nothing here
// prevents that — it is not a sandbox." That is right for one person.
// For a company, "team A may not see project B" has to hold at every
// door into the memory, not just the one door (`retrieval.retrieve`)
// that happens to take a Capability object. This file turns the plan's
// own `unknown (never checked at every entry point)` into a number.
//
// **Method, every lane.** Two projects, `alpha` (foreign) and `beta`
// (the caller's own), each carrying one entry with a marker string
// unique to it. For each lane:
//   - RED-TEAM: call the lane the way its real caller in this codebase
//     actually calls it for an agent that should see only `beta` —
//     which, for every lane that has no Capability parameter at all,
//     means calling it with no project restriction, because that is
//     the only way these lanes are ever actually invoked (see
//     bin/mem-retrieve and bin/mem-before-edit, neither of which passes
//     `--project`). Does `alpha`'s marker come back anyway?
//   - POSITIVE CONTROL: the same lane, asked point-blank for `beta`'s
//     own marker, through whatever scoping mechanism the lane DOES
//     offer. If this fails too, the lane is not "secure", it is broken,
//     and the red-team result above is worthless.
//
// **Four states, not two.** A lane that has no scoping mechanism AT ALL
// (the viewer) is reported as such, not folded into "fail" — there is
// no guarantee to falsify because none is claimed.
//
// **Sabotage.** `Capability.prototype.admits` is the one condition every
// enforced lane relies on. Disabling it (in-process, reverted in a
// `finally`) must flip an enforced lane red, or this file is not
// measuring what it claims to.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as retrieval from '../src/retrieval.mjs';
import * as capability from '../src/capability.mjs';
import * as viewerModule from '../src/viewer.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM_BIN = path.join(REPO, 'bin', 'mem');
const MCP_BIN = path.join(REPO, 'bin', 'mem-mcp');
const HOOK_RETRIEVE = path.join(REPO, 'bin', 'mem-retrieve');
const HOOK_BEFORE_EDIT = path.join(REPO, 'bin', 'mem-before-edit');

// Rare, unique-per-run strings so no other fixture can accidentally
// satisfy a "did alpha leak" check.
const RUN = Date.now().toString(36);
const ALPHA_SECRET = `zzzalphaforeignsecret${RUN}`;
const BETA_OWN = `zzzbetaownsecret${RUN}`;
const COMPONENT_NAME = `zzzsharedcomponent${RUN}.mjs`;
const COMPONENT_QUERY = `src/${COMPONENT_NAME}`;

function runMem(root, args) {
  const r = spawnSync('node', [MEM_BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0 && !args.includes('--json')) {
    // mem exits non-zero for e.g. "nothing found" in some commands; only
    // surface truly broken invocations (a spawn error, a crash).
    if (r.error || r.signal) {
      throw new Error(`mem ${args.join(' ')} failed: ${r.error?.message ?? r.signal}\n${r.stderr}`);
    }
  }
  return r;
}

function memJson(root, args) {
  const r = runMem(root, [...args, '--json']);
  try { return JSON.parse(r.stdout); }
  catch (e) {
    throw new Error(`mem ${args.join(' ')} --json did not print JSON: ${e.message}\n`
      + `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
}

/** Two projects, one marker entry each, plus a shared component name. */
function buildTwoProjectMemory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p13-'));
  runMem(root, ['init']);
  runMem(root, ['log', 'decision', '--project', 'alpha', '--topic', 'alpha/secret',
    '--title', `alpha-only decision ${ALPHA_SECRET}`, '--choice', ALPHA_SECRET, '--why', 'alpha reasons only']);
  runMem(root, ['log', 'decision', '--project', 'beta', '--topic', 'beta/own',
    '--title', `beta-only decision ${BETA_OWN}`, '--choice', BETA_OWN, '--why', 'beta reasons only']);
  // Same component name mentioned in both projects' ERROR logs (the
  // type mem-before-edit's warning filter looks at), for the
  // component/hook lanes.
  runMem(root, ['log', 'error', '--project', 'alpha', '--class', 'redteam-probe',
    '--title', `${ALPHA_SECRET} bug in ${COMPONENT_QUERY}`, '--text', `broke near ${COMPONENT_QUERY}`]);
  runMem(root, ['log', 'error', '--project', 'beta', '--class', 'redteam-probe',
    '--title', `${BETA_OWN} note about ${COMPONENT_QUERY}`, '--text', `also touches ${COMPONENT_QUERY}`]);
  return root;
}

function idOf(logResult) {
  const m = /^\s*id:\s*(\S+)/m.exec(logResult.stdout);
  assert.ok(m, `no id printed by: ${logResult.stdout}`);
  return m[1];
}

function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

// --- MCP bridge helper (same shape as test/bridge-reach.test.mjs) -------

function readReplies(r, what) {
  const lines = String(r.stdout ?? '').split('\n').filter((z) => z.trim());
  if (!lines.length) {
    throw new Error(`${what}: no reply. status=${r.status} stderr=${String(r.stderr ?? '').slice(0, 1000)}`);
  }
  return lines.map((z) => JSON.parse(z));
}

function mcpBridge(root, calls) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  for (const [name, args] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }));
  }
  const r = spawnSync('node', [MCP_BIN], {
    input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  return readReplies(r, 'mcpBridge').slice(1); // drop the initialize reply
}

function mcpText(reply) { return reply?.result?.content?.[0]?.text ?? ''; }

// =========================================================================
// LANE 1/2 — CLI `mem find` (ranked, then literal): no Capability object
// exists on this path at all — `project` is a bare string the caller may
// or may not pass. Called the way the retrieval hook actually calls it:
// with no --project.
// =========================================================================

test('LANE CLI-find(ranked): RED — no scope enforced without --project', () => {
  const root = buildTwoProjectMemory();
  try {
    const r = memJson(root, ['find', ALPHA_SECRET, '--top', '5']);
    const text = JSON.stringify(r);
    assert.ok(text.includes(ALPHA_SECRET),
      'expected today\'s real hole to reproduce: alpha leaked through an unscoped `mem find`');
  } finally { cleanup(root); }
});

test('LANE CLI-find(ranked): POSITIVE CONTROL — explicit --project still finds its own', () => {
  const root = buildTwoProjectMemory();
  try {
    const own = memJson(root, ['find', BETA_OWN, '--project', 'beta', '--top', '5']);
    assert.ok(JSON.stringify(own.hits).includes(BETA_OWN), 'beta could not even find its own marker');
    // `own.query` legitimately echoes the query string, so the check below
    // is on the HITS array, never on the envelope as a whole — the
    // envelope always contains the asked-for marker regardless of scope.
    const foreign = memJson(root, ['find', ALPHA_SECRET, '--project', 'beta', '--top', '5']);
    assert.equal(foreign.hits.length, 0,
      'the ONE mechanism this lane offers (--project) does not even filter when actually asked');
  } finally { cleanup(root); }
});

test('LANE CLI-find(--literal): RED — same hole in the literal lane', () => {
  const root = buildTwoProjectMemory();
  try {
    const r = memJson(root, ['find', ALPHA_SECRET, '--literal', '--top', '5']);
    assert.ok(JSON.stringify(r).includes(ALPHA_SECRET), 'literal lane also leaks alpha without --project');
  } finally { cleanup(root); }
});

// =========================================================================
// LANE 3 — CLI `mem component`: repaired in this pass (src/cli/commands/
// setup.mjs) to accept --project, mirroring `find`. Still unscoped by
// DEFAULT, because that is exactly how bin/mem-before-edit calls it —
// the hook passes no project at all, so the new flag does not close the
// hook's hole, only stops `component` from being the one command that
// could not be scoped even when a caller wanted to.
// =========================================================================

test('LANE CLI-component: RED by default (matches how the hook calls it), fixed when scoped', () => {
  const root = buildTwoProjectMemory();
  try {
    const unscoped = memJson(root, ['component', COMPONENT_QUERY]);
    assert.ok(JSON.stringify(unscoped).includes(ALPHA_SECRET),
      'default (no --project) still mixes every project — this is the path the pre-edit hook actually uses');

    // POSITIVE CONTROL + repair check: --project now exists and works.
    const scoped = memJson(root, ['component', COMPONENT_QUERY, '--project', 'beta']);
    assert.ok(JSON.stringify(scoped).includes(BETA_OWN), 'beta, scoped to itself, lost its own hit');
    assert.ok(!JSON.stringify(scoped).includes(ALPHA_SECRET),
      'REPAIR DID NOT HOLD: --project beta on `mem component` still let alpha through');
  } finally { cleanup(root); }
});

// =========================================================================
// LANE 4/5 — CLI `mem retrieve` / `mem explain`: the one pair of CLI
// commands that mint and consult an actual Capability object
// (src/retrieval.mjs). --project narrows it; omitting --project asks for
// the everything-capability on purpose (this is a single-tenant CLI with
// no register — "no scope named" legitimately means "give me what I, the
// operator of this memory, may see", not "no capability"). The red-team
// question here is the honest one: presenting ONLY a beta capability,
// can alpha still be reached?
// =========================================================================

test('LANE CLI-retrieve: GREEN — a beta-only capability cannot reach alpha', () => {
  const root = buildTwoProjectMemory();
  try {
    const foreign = memJson(root, ['retrieve', ALPHA_SECRET, '--project', 'beta', '--top', '5']);
    assert.equal(foreign.claims.length, 0, 'a beta-scoped capability reached an alpha claim');
  } finally { cleanup(root); }
});

test('LANE CLI-retrieve: POSITIVE CONTROL — beta still finds its own', () => {
  const root = buildTwoProjectMemory();
  try {
    const own = memJson(root, ['retrieve', BETA_OWN, '--project', 'beta', '--top', '5']);
    assert.ok(own.claims.length > 0, 'the probe blocks everything — worthless without this passing');
    assert.ok(own.claims.some((c) => c.body.includes(BETA_OWN)));
  } finally { cleanup(root); }
});

test('LANE CLI-explain: GREEN — explains alpha as excluded by capability, not returned', () => {
  const root = buildTwoProjectMemory();
  try {
    const logResult = runMem(root, ['log', 'decision', '--project', 'alpha', '--topic', 'alpha/explain',
      '--title', `explain target ${ALPHA_SECRET}`, '--choice', ALPHA_SECRET]);
    const id = idOf(logResult);
    const r = memJson(root, ['explain', ALPHA_SECRET, id, '--project', 'beta']);
    assert.equal(r.returned, false, 'alpha entry was returned to a beta-only capability');
    assert.match(r.reason ?? '', /capabilit|scope|outside/i,
      `exclusion reason does not name the scope boundary: ${r.reason}`);
  } finally { cleanup(root); }
});

// =========================================================================
// LANE 6/7 — MCP `mem_find` / `mem_retrieve`: the bridge a connected agent
// actually uses. Same split as the CLI: `mem_find` takes a bare project
// string nobody is required to pass; `mem_retrieve` mints a real
// Capability.
// =========================================================================

test('LANE MCP-mem_find: RED — no scope enforced without a project argument', () => {
  const root = buildTwoProjectMemory();
  try {
    const [r] = mcpBridge(root, [['mem_find', { query: ALPHA_SECRET, top: 5 }]]);
    assert.ok(mcpText(r).includes(ALPHA_SECRET), 'mem_find leaked alpha with no project argument');
  } finally { cleanup(root); }
});

test('LANE MCP-mem_find: POSITIVE CONTROL — an explicit project argument does filter', () => {
  const root = buildTwoProjectMemory();
  try {
    const [own, foreign] = mcpBridge(root, [
      ['mem_find', { query: BETA_OWN, project: 'beta', top: 5 }],
      ['mem_find', { query: ALPHA_SECRET, project: 'beta', top: 5 }],
    ]);
    // `mem_find`'s own "No hits for '<q>'" message echoes the query text,
    // so a plain substring check on the reply would flag a CORRECTLY
    // empty answer as a leak. The "No hits" prefix is the actual signal.
    assert.ok(mcpText(own).includes(BETA_OWN), 'beta could not find its own marker via mem_find');
    assert.ok(!mcpText(own).startsWith('No hits for'), 'beta got an empty answer for its own marker');
    assert.ok(mcpText(foreign).startsWith('No hits for'),
      `mem_find leaked alpha even WITH project:"beta" set: ${mcpText(foreign)}`);
  } finally { cleanup(root); }
});

test('LANE MCP-mem_retrieve: GREEN — a beta-only capability cannot reach alpha', () => {
  const root = buildTwoProjectMemory();
  try {
    const [r] = mcpBridge(root, [['mem_retrieve', { query: ALPHA_SECRET, project: 'beta', top: 5 }]]);
    // Same caveat as mem_find above: "No claims for '<query>' ..." echoes
    // the query text, so the absence of a real claim is what matters.
    assert.ok(mcpText(r).startsWith(`No claims for '${ALPHA_SECRET}'`),
      `mem_retrieve leaked alpha to a beta-scoped capability: ${mcpText(r)}`);
  } finally { cleanup(root); }
});

test('LANE MCP-mem_retrieve: POSITIVE CONTROL — beta still finds its own', () => {
  const root = buildTwoProjectMemory();
  try {
    const [r] = mcpBridge(root, [['mem_retrieve', { query: BETA_OWN, project: 'beta', top: 5 }]]);
    assert.ok(mcpText(r).includes(BETA_OWN), 'the probe blocks everything — worthless without this passing');
  } finally { cleanup(root); }
});

// =========================================================================
// LANE 8 — the viewer: no Capability parameter exists ANYWHERE in
// src/viewer.mjs. `collect()` always reads memory.find(root, '',
// {withRetired:true}) — every project, unconditionally, by design (one
// static file with everything embedded, for one person to browse
// offline). There is no scoping mechanism to positive-control here: no
// guarantee is claimed, so none can be falsified. Reported as its own
// state, not folded into pass/fail.
// =========================================================================

test('LANE viewer: NOT-SCOPED-BY-DESIGN — collect() has no capability parameter at all', () => {
  const root = buildTwoProjectMemory();
  try {
    const rows = viewerModule.collect(root);
    const text = JSON.stringify(rows);
    assert.ok(text.includes(ALPHA_SECRET) && text.includes(BETA_OWN),
      'sanity: collect() should see both projects, confirming there is no filter to bypass — '
      + 'if this ever fails, someone added scoping and this test (and the report) is stale');
  } finally { cleanup(root); }
});

// =========================================================================
// LANE 9/10 — the hooks, invoked exactly as Claude Code invokes them
// (real subprocess, real stdin JSON, no --project anywhere because
// neither hook has a project concept to pass).
// =========================================================================

test('LANE hook mem-retrieve (UserPromptSubmit): RED — leaks alpha into the injected context', () => {
  const root = buildTwoProjectMemory();
  try {
    const prompt = `tell me everything you know about ${ALPHA_SECRET} right now please`;
    const r = spawnSync('bash', [HOOK_RETRIEVE], {
      input: JSON.stringify({ prompt, session_id: 'redteam-p13' }),
      encoding: 'utf8', timeout: 20000,
      env: {
        ...process.env, CHEAP_MEM_ROOT: root,
        MEM_RETRIEVE_NO_PULL: '1', MEM_HEADLESS: '1', MEM_RETRIEVE_MIN: '0',
      },
    });
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes(ALPHA_SECRET),
      'expected today\'s real hole: the retrieval hook has no notion of scope and injects across every project');
  } finally { cleanup(root); }
});

test('LANE hook mem-before-edit (PreToolUse): RED — leaks alpha into the pre-edit context', () => {
  const root = buildTwoProjectMemory();
  try {
    const filePath = `/wherever/on/disk/${COMPONENT_QUERY}`;
    const r = spawnSync('bash', [HOOK_BEFORE_EDIT], {
      input: JSON.stringify({ tool_input: { file_path: filePath }, session_id: 'redteam-p13' }),
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, CHEAP_MEM_ROOT: root },
    });
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes(ALPHA_SECRET),
      'expected today\'s real hole: `mem component` (which this hook calls, unscoped) has no project concept for the hook to use');
  } finally { cleanup(root); }
});

// =========================================================================
// SABOTAGE — the one mandatory negative case. Disabling the single
// condition every ENFORCED lane relies on (`Capability.prototype.admits`)
// must flip a currently-green probe red, in-process (a subprocess would
// not see the monkey-patch, so this checks retrieval.retrieve() directly
// — the same function every enforced lane above calls).
// =========================================================================

test('SABOTAGE: disabling Capability.admits flips the one enforced lane red', () => {
  const root = buildTwoProjectMemory();
  try {
    const cap = capability.grantProject('beta', { subject: 'redteam' });

    const before = retrieval.retrieve(root, ALPHA_SECRET, cap, { top: 10 });
    assert.equal(before.claims.length, 0, 'sanity check failed: alpha should be excluded before sabotage');

    const original = capability.Capability.prototype.admits;
    capability.Capability.prototype.admits = function alwaysAdmit() { return true; };
    try {
      const after = retrieval.retrieve(root, ALPHA_SECRET, cap, { top: 10 });
      assert.ok(after.claims.length > 0,
        'SABOTAGE DID NOT FLIP ANYTHING RED: disabling admits() should have let a beta-only '
        + 'capability see alpha. If this assertion fails, this whole file is measuring something '
        + 'other than scope enforcement, per the brief\'s own warning.');
    } finally {
      capability.Capability.prototype.admits = original;
    }

    // Restored: the same query is excluded again.
    const restored = retrieval.retrieve(root, ALPHA_SECRET, cap, { top: 10 });
    assert.equal(restored.claims.length, 0, 'admits() was not fully restored after the sabotage block');
  } finally { cleanup(root); }
});
