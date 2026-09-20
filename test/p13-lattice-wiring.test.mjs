// P13 wiring probe: does the capability plumbing actually reach the
// FOUR lanes this build point wires (CLI `mem find` ranked, CLI `mem
// find --literal`, MCP `mem_find`, `mem component`), and what does it
// change once it does?
//
// **Split from test/scope-lattice-redteam.test.mjs on purpose.** That
// file is the committed measurement of the pre-P13 hole, and it asks a
// different question: door by door, does something FOREIGN come back.
// This file asks whether the lines this commit added are what makes a
// lane lattice-aware, and answers it the only way that counts — by
// putting the old lines back and watching the global entries vanish.
//
// The split is not a fixture accident. That file's fixture has since
// grown a `global` tier too (it had none when this file was written,
// which is why its counts did not move over the first three lanes), and
// its positive controls are now two-sided. It still never sabotages a
// source line; the two files state one assertion each, not the same
// assertion twice.
//
// **Method, every lane.** Positive control: the caller's own project
// still comes back, a foreign project still does not, and (P13's
// change) `global` now comes back too. Sabotage: with the exact lines
// this build point added replaced by a literal alternate value — never
// `if (false && ...)`, which this repo's ESLint rejects — the global
// entries vanish again (RED), and restoring the file exactly brings
// them back (GREEN). The file is read into memory, patched, run, and
// restored from that same in-memory copy inside a `finally`, so a
// crash mid-test cannot leave a sabotaged file on disk for the next
// agent sharing this clone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM_BIN = path.join(REPO, 'bin', 'mem');
const MCP_BIN = path.join(REPO, 'bin', 'mem-mcp');
const CLI_SEARCH_FILE = path.join(REPO, 'src', 'cli', 'commands', 'search.mjs');
const MCP_FILE = path.join(REPO, 'bin', 'mem-mcp');
const CLI_SETUP_FILE = path.join(REPO, 'src', 'cli', 'commands', 'setup.mjs');

const RUN = Date.now().toString(36);
const TOKEN = `zzzlattice${RUN}`;

function runMem(root, args) {
  const r = spawnSync('node', [MEM_BIN, ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if ((r.status !== 0 && !args.includes('--json')) && (r.error || r.signal)) {
    throw new Error(`mem ${args.join(' ')} failed: ${r.error?.message ?? r.signal}\n${r.stderr}`);
  }
  return r;
}

function memJson(root, args) {
  const r = runMem(root, [...args, '--json']);
  try { return JSON.parse(r.stdout); }
  catch (e) {
    throw new Error(`mem ${args.join(' ')} --json did not print JSON: ${e.message}\nstdout: ${r.stdout}`);
  }
}

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
  return readReplies(r, 'mcpBridge').slice(1);
}

function mcpText(reply) { return reply?.result?.content?.[0]?.text ?? ''; }

/**
 * A small corpus with all three tiers a project capability has to tell
 * apart: shared `global` context, the caller's OWN project (`alpha`),
 * and a FOREIGN project (`beta`) that must never leak in. 3 global + 8
 * alpha + 8 beta entries, all carrying the same search token so one
 * query surfaces all 19 candidates and the only question left is which
 * ones a scoped lane lets through.
 */
function buildLatticeCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p13-lattice-'));
  runMem(root, ['init']);
  for (let i = 0; i < 3; i += 1) {
    runMem(root, ['log', 'decision', '--topic', `shared/setup-${i}`,
      '--title', `${TOKEN} shared setup note ${i}`, '--choice', `shared-${i}`,
      '--why', 'context every project inherits']);
  }
  for (let i = 0; i < 8; i += 1) {
    runMem(root, ['log', 'decision', '--project', 'alpha', '--topic', `alpha/step-${i}`,
      '--title', `${TOKEN} alpha-only step ${i}`, '--choice', `alpha-${i}`, '--why', 'alpha reasons only']);
  }
  for (let i = 0; i < 8; i += 1) {
    runMem(root, ['log', 'decision', '--project', 'beta', '--topic', `beta/step-${i}`,
      '--title', `${TOKEN} beta-only step ${i}`, '--choice', `beta-${i}`, '--why', 'beta reasons only']);
  }
  return root;
}

function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

/**
 * Patch a file's SOURCE on disk for the duration of `fn`, then restore
 * it byte-for-byte from the copy read before patching — even if `fn`
 * throws. `transform` must actually change the content, or the
 * sabotage is a no-op and the test would prove nothing.
 */
function withSabotage(filePath, transform, fn) {
  const original = fs.readFileSync(filePath, 'utf8');
  const sabotaged = transform(original);
  assert.notEqual(sabotaged, original,
    `sabotage transform for ${filePath} did not change anything — nothing was tested`);
  fs.writeFileSync(filePath, sabotaged);
  try {
    return fn();
  } finally {
    fs.writeFileSync(filePath, original);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original,
      `${filePath} was not restored exactly after sabotage`);
  }
}

// =========================================================================
// LANE: CLI `mem find` (ranked lane merged with the exact lane) — wired
// in src/cli/commands/search.mjs to mint capability.grantProject(project)
// and hand it to search.search()/search.exactHits() as `capability`.
// =========================================================================

test('P13 CLI-find: --project alpha now also returns global, never beta', () => {
  const root = buildLatticeCorpus();
  try {
    const r = memJson(root, ['find', TOKEN, '--project', 'alpha', '--top', '50']);
    const text = JSON.stringify(r.hits);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(text.includes(`shared setup note ${i}`), `global entry ${i} missing from an alpha-scoped find`);
    }
    for (let i = 0; i < 8; i += 1) {
      assert.ok(text.includes(`alpha-only step ${i}`), `alpha lost its own entry ${i} — abort criterion broken`);
    }
    assert.ok(!text.includes('beta-only'), 'CLI find leaked a beta entry into an alpha-scoped query');
  } finally { cleanup(root); }
});

test('P13 CLI-find SABOTAGE: removing the capability wiring drops global inheritance (RED), restoring brings it back (GREEN), reports both counts', () => {
  const root = buildLatticeCorpus();
  try {
    const before = memJson(root, ['find', TOKEN, '--project', 'alpha', '--top', '50']);
    const beforeGlobal = before.hits.filter((h) => JSON.stringify(h).includes('shared setup note')).length;
    assert.equal(beforeGlobal, 3, `sanity: wired lane should surface all 3 global entries, got ${beforeGlobal}`);

    const after = withSabotage(
      CLI_SEARCH_FILE,
      (src) => src.replaceAll('capability: findCapability,', 'capability: null,'),
      () => memJson(root, ['find', TOKEN, '--project', 'alpha', '--top', '50']),
    );
    const afterGlobal = after.hits.filter((h) => JSON.stringify(h).includes('shared setup note')).length;
    const afterAlpha = after.hits.filter((h) => JSON.stringify(h).includes('alpha-only step')).length;
    assert.equal(afterGlobal, 0,
      `SABOTAGE DID NOT FLIP RED: global entries still reached an alpha-scoped find with capability wiring removed (got ${afterGlobal})`);
    assert.ok(afterAlpha > 0, 'sabotage broke more than the wiring — alpha lost its own entries too, probe is not isolating the right line');

    const restored = memJson(root, ['find', TOKEN, '--project', 'alpha', '--top', '50']);
    const restoredGlobal = restored.hits.filter((h) => JSON.stringify(h).includes('shared setup note')).length;
    assert.equal(restoredGlobal, 3, `GREEN after restore: expected all 3 global entries back, got ${restoredGlobal}`);

    // The measured numbers this build point's brief asked for.
    console.log(`[P13 measurement] CLI find --project alpha: global hits before sabotage=${beforeGlobal}, `
      + `during sabotage (RED)=${afterGlobal}, after restore (GREEN)=${restoredGlobal}`);
  } finally { cleanup(root); }
});

// =========================================================================
// LANE: MCP `mem_find`, ranked branch — wired in bin/mem-mcp the same
// way as the CLI lane above.
// =========================================================================

test('P13 MCP-mem_find(ranked): project argument now also returns global, never a foreign project', () => {
  const root = buildLatticeCorpus();
  try {
    const [r] = mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', top: 50 }]]);
    const text = mcpText(r);
    assert.ok(text.includes('shared setup note'), 'MCP mem_find (ranked) lost global inheritance');
    assert.ok(text.includes('alpha-only step'), 'MCP mem_find (ranked) lost its own project — abort criterion broken');
    assert.ok(!text.includes('beta-only'), 'MCP mem_find (ranked) leaked a beta entry into an alpha-scoped query');
  } finally { cleanup(root); }
});

test('P13 MCP-mem_find(ranked) SABOTAGE: removing the capability wiring drops global inheritance (RED), restore brings it back (GREEN)', () => {
  const root = buildLatticeCorpus();
  try {
    const [before] = mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', top: 50 }]]);
    assert.ok(mcpText(before).includes('shared setup note'), 'sanity: wired lane should see global entries');

    const [afterReply] = withSabotage(
      MCP_FILE,
      (src) => src.replaceAll('capability: findCapability,', 'capability: null,'),
      () => mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', top: 50 }]]),
    );
    const afterText = mcpText(afterReply);
    assert.ok(!afterText.includes('shared setup note'),
      `SABOTAGE DID NOT FLIP RED: global entries still reached MCP mem_find with capability wiring removed: ${afterText.slice(0, 200)}`);
    assert.ok(afterText.includes('alpha-only step'), 'sabotage broke more than the wiring — alpha lost its own entries too');

    const [restored] = mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', top: 50 }]]);
    assert.ok(mcpText(restored).includes('shared setup note'), 'GREEN after restore: global entries should be back');
  } finally { cleanup(root); }
});

// =========================================================================
// LANE: MCP `mem_find`, literal branch — routes through memory.find(),
// which as of issue #136 REQUIRES a Capability. This branch mints one
// from `project` the same way `mem_retrieve`/`mem_explain`/the ranked
// branch below already do (`grantProject(project)` — which also admits
// `global`, the lattice root every capability with read inherits — or
// `grantAll()` with no project).
//
// **Why the sabotage is a LEAK probe now, not a "global vanishes" one.**
// Before issue #136, "does a project capability also see global" was
// decided independently in each of these four lanes, by hand, and the
// probe that mattered was: revert this lane's own copy of that rule and
// watch global disappear from an alpha-scoped query. Now that rule lives
// in exactly one place — `Capability#admits`, consulted by
// `memory.find` itself — so reverting it here cannot make global vanish
// any more; it isn't decided here. What CAN still go wrong here is
// simpler and, for this specific call site, more serious: forgetting to
// mint a project-scoped capability at all, and handing `memory.find` the
// everything-capability regardless of what the caller asked for. That
// sabotage is checked directly: a foreign project (`beta`) leaks into an
// alpha-scoped query.
// =========================================================================

test('P13 MCP-mem_find(literal): project argument now also returns global, never a foreign project', () => {
  const root = buildLatticeCorpus();
  try {
    const [r] = mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', literal: true, top: 50 }]]);
    const text = mcpText(r);
    assert.ok(text.includes('shared setup note'), 'MCP mem_find (literal) lost global inheritance');
    assert.ok(text.includes('alpha-only step'), 'MCP mem_find (literal) lost its own project — abort criterion broken');
    assert.ok(!text.includes('beta-only'), 'MCP mem_find (literal) leaked a beta entry into an alpha-scoped query');
  } finally { cleanup(root); }
});

test('P13 MCP-mem_find(literal) SABOTAGE: minting grantAll regardless of project leaks a foreign project (RED), restore brings the boundary back (GREEN)', () => {
  const root = buildLatticeCorpus();
  try {
    const [before] = mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', literal: true, top: 50 }]]);
    assert.ok(!mcpText(before).includes('beta-only'), 'sanity: wired lane should not leak beta');

    const [afterReply] = withSabotage(
      MCP_FILE,
      (src) => src.replace(
        "const literalCapability = project\n          ? capability.grantProject(project, { subject: 'mcp' })\n          : capability.grantAll('mcp');",
        "const literalCapability = capability.grantAll('mcp');",
      ),
      () => mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', literal: true, top: 50 }]]),
    );
    const afterText = mcpText(afterReply);
    assert.ok(afterText.includes('beta-only'),
      `SABOTAGE DID NOT FLIP RED: beta still did not leak into MCP mem_find(literal) with the capability wiring removed: ${afterText.slice(0, 200)}`);
    assert.ok(afterText.includes('alpha-only step'), 'sabotage broke more than the wiring — alpha lost its own entries too');

    const [restored] = mcpBridge(root, [['mem_find', { query: TOKEN, project: 'alpha', literal: true, top: 50 }]]);
    assert.ok(!mcpText(restored).includes('beta-only'), 'GREEN after restore: beta should no longer leak');
  } finally { cleanup(root); }
});

// =========================================================================
// LANE: CLI `mem component` — routes through component.find() ->
// memory.find(), which as of issue #136 requires a Capability, minted in
// src/cli/commands/setup.mjs the same way `mem retrieve` already does.
// See the MCP-literal lane above for why the sabotage here is a LEAK
// probe (a foreign project reaching an alpha-scoped query) rather than a
// "global vanishes" one: global inheritance is decided once now, in
// `Capability#admits`, not re-derived per lane.
// =========================================================================

test('P13 CLI-component: --project alpha now also returns global, never beta', () => {
  const root = buildLatticeCorpus();
  const componentPath = `src/${TOKEN}-component.mjs`;
  try {
    runMem(root, ['log', 'error', '--topic', 'shared/component',
      '--class', 'redteam-probe', '--title', `${TOKEN} shared note about ${componentPath}`,
      '--text', `mentions ${componentPath}`]);
    runMem(root, ['log', 'error', '--project', 'alpha', '--class', 'redteam-probe',
      '--title', `${TOKEN} alpha note about ${componentPath}`, '--text', `alpha touches ${componentPath}`]);
    runMem(root, ['log', 'error', '--project', 'beta', '--class', 'redteam-probe',
      '--title', `${TOKEN} beta note about ${componentPath}`, '--text', `beta touches ${componentPath}`]);

    const r = memJson(root, ['component', componentPath, '--project', 'alpha']);
    const text = JSON.stringify(r);
    assert.ok(text.includes('shared note'), 'mem component lost global inheritance for --project alpha');
    assert.ok(text.includes('alpha note'), 'mem component lost its own project — abort criterion broken');
    assert.ok(!text.includes('beta note'), 'mem component leaked a beta entry into an alpha-scoped query');
  } finally { cleanup(root); }
});

test('P13 CLI-component SABOTAGE: minting grantAll regardless of --project leaks a foreign project (RED), restore brings the boundary back (GREEN)', () => {
  const root = buildLatticeCorpus();
  const componentPath = `src/${TOKEN}-sabotage-component.mjs`;
  try {
    runMem(root, ['log', 'error', '--topic', 'shared/component',
      '--class', 'redteam-probe', '--title', `${TOKEN} shared note about ${componentPath}`,
      '--text', `mentions ${componentPath}`]);
    runMem(root, ['log', 'error', '--project', 'alpha', '--class', 'redteam-probe',
      '--title', `${TOKEN} alpha note about ${componentPath}`, '--text', `alpha touches ${componentPath}`]);
    runMem(root, ['log', 'error', '--project', 'beta', '--class', 'redteam-probe',
      '--title', `${TOKEN} beta note about ${componentPath}`, '--text', `beta touches ${componentPath}`]);

    const before = memJson(root, ['component', componentPath, '--project', 'alpha']);
    assert.ok(!JSON.stringify(before).includes('beta note'), 'sanity: wired lane should not leak beta');

    const after = withSabotage(
      CLI_SETUP_FILE,
      (src) => src.replace(
        "const cap = args.project\n      ? capability.grantProject(String(args.project), { subject: 'cli' })\n      : capability.grantAll('cli');",
        "const cap = capability.grantAll('cli');",
      ),
      () => memJson(root, ['component', componentPath, '--project', 'alpha']),
    );
    const afterText = JSON.stringify(after);
    assert.ok(afterText.includes('beta note'),
      `SABOTAGE DID NOT FLIP RED: beta still did not leak into mem component with the capability wiring removed: ${afterText.slice(0, 300)}`);
    assert.ok(afterText.includes('alpha note'), 'sabotage broke more than the wiring — alpha lost its own entry too');

    const restored = memJson(root, ['component', componentPath, '--project', 'alpha']);
    assert.ok(!JSON.stringify(restored).includes('beta note'), 'GREEN after restore: beta should no longer leak');
  } finally { cleanup(root); }
});

// =========================================================================
// LANE: CLI `mem find --literal` — the fourth lane, and the one the P13
// build point first MISSED.
//
// **Measured 2026-09-20, after the other three lanes were wired and
// before this one was.** The literal branch of `src/cli/commands/
// search.mjs` still carried the old single-drawer selection, while
// `bin/mem-mcp`'s literal branch had been given the new one. The same
// question therefore had two answers:
//
//   mem find <q> --literal --project beta     -> 2 rows, beta only
//   mem_find {q, project:"beta", literal:true} -> 4 rows, global + beta
//
// Neither door leaked, so every leak probe in
// `test/scope-lattice-redteam.test.mjs` stayed green through it. That was
// the `two-truths` class this parameter (issue #136) exists to end: this
// lane, like the other three, now mints a Capability via
// `capability.grantProject`/`grantAll` and hands it to `memory.find`,
// which is the only place left that decides what a scope admits. See the
// MCP-literal lane above for why the sabotage below checks for a LEAK
// (a foreign project reaching an alpha-scoped query) instead of "global
// vanishes" — that second failure mode is no longer reachable from this
// call site at all, since it is not decided here any more.
// =========================================================================

test('P13 CLI-find(--literal): --project alpha now also returns global, never beta', () => {
  const root = buildLatticeCorpus();
  try {
    const r = memJson(root, ['find', TOKEN, '--literal', '--project', 'alpha', '--top', '50']);
    const text = JSON.stringify(r.hits);
    assert.ok(text.includes('shared setup note'), 'CLI find --literal lost global inheritance');
    assert.ok(text.includes('alpha-only step'), 'CLI find --literal lost its own project — abort criterion broken');
    assert.ok(!text.includes('beta-only'), 'CLI find --literal leaked a beta entry into an alpha-scoped query');

    // `--project global` keeps its narrower meaning, same as the other
    // drawer-selecting lanes. Without this, "reads global too" and
    // "ignores --project" are indistinguishable.
    const onlyGlobal = memJson(root, ['find', TOKEN, '--literal', '--project', 'global', '--top', '50']);
    const globalText = JSON.stringify(onlyGlobal.hits);
    assert.ok(globalText.includes('shared setup note'), '`--project global` lost the global drawer itself');
    assert.ok(!globalText.includes('alpha-only') && !globalText.includes('beta-only'),
      '`--project global` is the global drawer ALONE, but a project drawer came with it');
  } finally { cleanup(root); }
});

test('P13 CLI-find(--literal) SABOTAGE: minting grantAll regardless of --project leaks a foreign project (RED), restore brings the boundary back (GREEN)', () => {
  const root = buildLatticeCorpus();
  try {
    const before = memJson(root, ['find', TOKEN, '--literal', '--project', 'alpha', '--top', '50']);
    assert.ok(!JSON.stringify(before.hits).includes('beta-only'),
      'sanity: wired lane should not leak beta');

    const after = withSabotage(
      CLI_SEARCH_FILE,
      (src) => src.replace(
        "      const literalCapability = args.project\n        ? capability.grantProject(String(args.project), { subject: 'cli' })\n        : capability.grantAll('cli');",
        "      const literalCapability = capability.grantAll('cli');",
      ),
      () => memJson(root, ['find', TOKEN, '--literal', '--project', 'alpha', '--top', '50']),
    );
    const afterText = JSON.stringify(after.hits);
    assert.ok(afterText.includes('beta-only'),
      `SABOTAGE DID NOT FLIP RED: beta still did not leak into the CLI literal lane with the capability wiring removed: ${afterText.slice(0, 300)}`);
    assert.ok(afterText.includes('alpha-only step'),
      'sabotage broke more than the wiring — alpha lost its own entries too');

    const restored = memJson(root, ['find', TOKEN, '--literal', '--project', 'alpha', '--top', '50']);
    assert.ok(!JSON.stringify(restored.hits).includes('beta-only'),
      'GREEN after restore: beta should no longer leak');
  } finally { cleanup(root); }
});
