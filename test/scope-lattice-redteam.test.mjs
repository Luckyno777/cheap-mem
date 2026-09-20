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
//
// **The other half of the same question (added 2026-09-20).** For most
// of this file's life its fixture held exactly two projects and no
// `global` entries, and that made its POSITIVE CONTROLS half-blind. A
// lane can fail scoping in TWO directions, and only one of them leaks:
//
//   - too WIDE — a foreign project comes back. Every RED test above.
//   - too NARROW — the caller's own project comes back and the shared
//     `global` drawer does not. Nothing leaks, so a leak probe calls it
//     green; but `global` is the lattice ROOT that every scope inherits
//     (`capability.mjs`'s `admits()`: "global facts are inherited by
//     every scope; a project session that could not see them would be
//     dumber than a global one for no security benefit"). A lane that
//     drops it is not secure, it is broken — the same verdict this
//     file's own method note already reaches for a lane whose positive
//     control fails.
//
// With no `global` entry in the fixture, a bare string comparison
// (`doc.project === 'beta'`) and a real lattice check are INDIS-
// TINGUISHABLE here: there is nothing inherited to miss. So the fixture
// gained a `global` tier, and each lane that HAS a scoping mechanism is
// now positive-controlled on both sides.
//
// **What this file does NOT own.** Whether the P13 wiring commit is what
// makes a given lane lattice-aware is measured in
// `test/p13-lattice-wiring.test.mjs`, by sabotaging the exact lines that
// commit added. This file asks only the door-by-door question: does the
// scoping mechanism this lane offers give a usable answer? Two files,
// two questions, no second spelling of the same assertion.
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
// The lattice ROOT's marker. Deliberately in neither project's drawer:
// a lane that answers a beta-scoped question must reach this and must
// not reach ALPHA_SECRET, and no leak probe can tell those apart.
const GLOBAL_SHARED = `zzzglobalinheritedfact${RUN}`;
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

/**
 * Three tiers, one marker entry each: the lattice ROOT (`global`, filed
 * under no project), a FOREIGN project (`alpha`) and the caller's OWN
 * project (`beta`) — plus a component name mentioned from all three.
 *
 * All three are needed to tell a correctly scoped lane from a merely
 * silent one: alpha out AND global in is the pair of answers a bare
 * string comparison cannot produce.
 */
function buildScopedMemory() {
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
  // The lattice ROOT: no --project at all, which is how `mem log` files
  // a global entry. Both types, so the component lane has a global hit
  // to inherit too.
  runMem(root, ['log', 'decision', '--topic', 'shared/setup',
    '--title', `shared decision ${GLOBAL_SHARED}`, '--choice', GLOBAL_SHARED,
    '--why', 'context every project inherits']);
  runMem(root, ['log', 'error', '--class', 'redteam-probe',
    '--title', `${GLOBAL_SHARED} note about ${COMPONENT_QUERY}`,
    '--text', `shared gotcha in ${COMPONENT_QUERY}`]);
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
  const root = buildScopedMemory();
  try {
    const r = memJson(root, ['find', ALPHA_SECRET, '--top', '5']);
    const text = JSON.stringify(r);
    assert.ok(text.includes(ALPHA_SECRET),
      'expected today\'s real hole to reproduce: alpha leaked through an unscoped `mem find`');
  } finally { cleanup(root); }
});

test('LANE CLI-find(ranked): POSITIVE CONTROL — explicit --project still finds its own', () => {
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
  try {
    const foreign = memJson(root, ['retrieve', ALPHA_SECRET, '--project', 'beta', '--top', '5']);
    assert.equal(foreign.claims.length, 0, 'a beta-scoped capability reached an alpha claim');
  } finally { cleanup(root); }
});

test('LANE CLI-retrieve: POSITIVE CONTROL — beta still finds its own', () => {
  const root = buildScopedMemory();
  try {
    const own = memJson(root, ['retrieve', BETA_OWN, '--project', 'beta', '--top', '5']);
    assert.ok(own.claims.length > 0, 'the probe blocks everything — worthless without this passing');
    assert.ok(own.claims.some((c) => c.body.includes(BETA_OWN)));
  } finally { cleanup(root); }
});

test('LANE CLI-explain: GREEN — explains alpha as excluded by capability, not returned', () => {
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
  try {
    const [r] = mcpBridge(root, [['mem_find', { query: ALPHA_SECRET, top: 5 }]]);
    assert.ok(mcpText(r).includes(ALPHA_SECRET), 'mem_find leaked alpha with no project argument');
  } finally { cleanup(root); }
});

test('LANE MCP-mem_find: POSITIVE CONTROL — an explicit project argument does filter', () => {
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
  try {
    const [r] = mcpBridge(root, [['mem_retrieve', { query: ALPHA_SECRET, project: 'beta', top: 5 }]]);
    // Same caveat as mem_find above: "No claims for '<query>' ..." echoes
    // the query text, so the absence of a real claim is what matters.
    assert.ok(mcpText(r).startsWith(`No claims for '${ALPHA_SECRET}'`),
      `mem_retrieve leaked alpha to a beta-scoped capability: ${mcpText(r)}`);
  } finally { cleanup(root); }
});

test('LANE MCP-mem_retrieve: POSITIVE CONTROL — beta still finds its own', () => {
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
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
  const root = buildScopedMemory();
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

// =========================================================================
// LATTICE — the other direction. Every test above asks "does something
// foreign come back". These ask "does something INHERITED fail to come
// back", which no leak probe can see and which, on a lane meant to be
// usable, is just as much a defect.
//
// Only lanes that HAVE a scoping mechanism appear here. The viewer and
// the two hooks have none (see their sections above), so there is no
// narrowing to be wrong about and nothing to assert.
// =========================================================================

test('LATTICE CLI-find(ranked): a --project scope reaches global, never the foreign project', () => {
  const root = buildScopedMemory();
  try {
    const inherited = memJson(root, ['find', GLOBAL_SHARED, '--project', 'beta', '--top', '5']);
    assert.ok(inherited.hits.length > 0,
      'a beta-scoped ranked search could not reach the lattice root — global facts (the person, '
      + 'the timezone, the setup) are inherited by every scope, so this lane is too NARROW to be usable');
    assert.ok(inherited.hits.every((h) => String(h.source).startsWith('global/')),
      `something other than the global drawer answered a global-only query: ${JSON.stringify(inherited.hits.map((h) => h.source))}`);

    // Both sides in one fixture: inheriting global must not have widened
    // the lane into alpha. Without this the assertion above is satisfied
    // by a lane with no scoping at all.
    const foreign = memJson(root, ['find', ALPHA_SECRET, '--project', 'beta', '--top', '5']);
    assert.equal(foreign.hits.length, 0,
      'the lane reaches global AND alpha — that is not inheritance, that is no scope');
  } finally { cleanup(root); }
});

test('LATTICE CLI-find(--literal) and MCP mem_find(literal): the same question, the same answer at both doors', () => {
  const root = buildScopedMemory();
  try {
    // **This probe caught a real bug the day it was written.** Measured
    // 2026-09-20, before `src/cli/commands/search.mjs`'s literal branch
    // was wired: `mem find <q> --literal --project beta` returned the
    // two beta rows and nothing else, while the SAME question asked
    // through the bridge (`mem_find`, literal:true, project:"beta")
    // returned global AND beta — four rows. One lane, two answers,
    // decided by which door the caller came through. `two-truths`, and
    // invisible to every leak probe in this file, because neither door
    // leaked.
    const cli = memJson(root, ['find', COMPONENT_QUERY, '--literal', '--project', 'beta', '--top', '20']);
    const cliDrawers = cli.hits.map((h) => String(h.source).split('/')[0]).sort();

    const [reply] = mcpBridge(root, [['mem_find', {
      query: COMPONENT_QUERY, project: 'beta', literal: true, top: 20,
    }]]);
    const mcpDrawers = mcpText(reply).split('\n')
      .map((line) => /^(global|projects)\//.exec(line.trim())?.[1])
      .filter(Boolean)
      .sort();

    assert.deepEqual(cliDrawers, mcpDrawers,
      `the literal lane answers differently depending on the door: CLI saw ${JSON.stringify(cliDrawers)}, `
      + `MCP saw ${JSON.stringify(mcpDrawers)}`);

    // POSITIVE CONTROL. `deepEqual` on two empty arrays would pass while
    // proving nothing, so state what the shared answer has to contain:
    // the lattice root (inherited) and beta (own), and never alpha.
    assert.ok(cliDrawers.includes('global'), 'both doors agree — on an answer that misses the lattice root');
    assert.ok(cliDrawers.includes('projects'), 'both doors agree — on an answer that misses beta\'s own row');
    assert.ok(!JSON.stringify(cli.hits).includes(ALPHA_SECRET), 'the literal lane reached alpha while scoped to beta');
    assert.ok(!mcpText(reply).includes(ALPHA_SECRET), 'the MCP literal lane reached alpha while scoped to beta');
  } finally { cleanup(root); }
});

test('LATTICE CLI-component: --project reaches global, never the foreign project', () => {
  const root = buildScopedMemory();
  try {
    const scoped = memJson(root, ['component', COMPONENT_QUERY, '--project', 'beta']);
    const text = JSON.stringify(scoped);
    assert.ok(text.includes(GLOBAL_SHARED),
      'a beta-scoped `mem component` missed the shared gotcha filed globally — exactly the note the '
      + 'pre-edit hook exists to surface');
    assert.ok(text.includes(BETA_OWN), 'beta lost its own hit');
    assert.ok(!text.includes(ALPHA_SECRET), 'reaching global also reached alpha — that is no scope');

    // `--project global` keeps its narrower, literal meaning: the global
    // drawer ONLY. Without this, "reads global too" and "ignores
    // --project" look the same from outside.
    const onlyGlobal = memJson(root, ['component', COMPONENT_QUERY, '--project', 'global']);
    const globalText = JSON.stringify(onlyGlobal);
    assert.ok(globalText.includes(GLOBAL_SHARED), '`--project global` lost the global drawer itself');
    assert.ok(!globalText.includes(BETA_OWN) && !globalText.includes(ALPHA_SECRET),
      '`--project global` is supposed to mean the global drawer alone, but a project drawer came with it');
  } finally { cleanup(root); }
});

test('LATTICE CLI-retrieve: global is eligible for a project capability, and says so when it is not', () => {
  const root = buildScopedMemory();
  try {
    const r = memJson(root, ['retrieve', GLOBAL_SHARED, '--project', 'beta', '--top', '5']);
    assert.ok(r.claims.length > 0,
      'a beta-only capability could not reach the lattice root through the ONE lane that mints a real '
      + 'Capability — `admits()` promises exactly this');
    assert.ok(r.claims.every((c) => c.scope === 'global'),
      `a global-only query returned something else: ${JSON.stringify(r.claims.map((c) => c.scope))}`);
    assert.ok(!JSON.stringify(r.excluded ?? []).includes('outside capability (global)'),
      'the capability lane excluded a global claim as out of scope');
  } finally { cleanup(root); }
});

test('LATTICE SABOTAGE: removing the global clause from admits() flips the inheriting lanes red', () => {
  const root = buildScopedMemory();
  try {
    const cap = capability.grantProject('beta', { subject: 'redteam' });

    const before = retrieval.retrieve(root, GLOBAL_SHARED, cap, { top: 10 });
    assert.ok(before.claims.length > 0, 'sanity check failed: global should be admitted before sabotage');

    // Narrow the sabotage to the ONE clause under test — global
    // inheritance — instead of disabling admits() wholesale (that is the
    // sabotage the leak probe above already runs, and it would flip this
    // red for the wrong reason). Here `admits` keeps answering every
    // other scope exactly as before.
    const original = capability.Capability.prototype.admits;
    capability.Capability.prototype.admits = function noInheritance(scope) {
      const id = capability.scopeOf(typeof scope === 'string' ? { project: null } : scope);
      if (String(scope) === 'global' || id?.id === 'global') return false;
      return original.call(this, scope);
    };
    try {
      const after = retrieval.retrieve(root, GLOBAL_SHARED, cap, { top: 10 });
      assert.equal(after.claims.length, 0,
        'SABOTAGE DID NOT FLIP ANYTHING RED: with global inheritance removed from admits(), a '
        + 'beta-only capability should no longer reach a global claim. If this passes, the lattice '
        + 'assertions above are satisfied by something other than the lattice.');
      assert.ok(JSON.stringify(after.excluded ?? []).includes('outside capability'),
        'the global claims vanished without the capability being the stated reason — this sabotage '
        + 'is measuring some other exclusion');
    } finally {
      capability.Capability.prototype.admits = original;
    }

    const restored = retrieval.retrieve(root, GLOBAL_SHARED, cap, { top: 10 });
    assert.ok(restored.claims.length > 0, 'admits() was not fully restored after the sabotage block');
  } finally { cleanup(root); }
});
