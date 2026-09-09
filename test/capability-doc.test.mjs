// docs/CAPABILITIES.md — complete, and demonstrably so.
//
// **The finding that triggered the file (2026-09-08).** Three AI
// reviews of cheap-mem drew wrong conclusions from skimmed readings,
// always in the same shape: a capability that IS built was reported as
// missing. Measured against the README of the day:
//
//   MCP tools       0 of 17 named
//   edge kinds      2 of 4   (contradicts and resolves were missing)
//   src modules    19 of 28
//
// Anyone reading only the README — and models do — could not possibly
// know that an edge system and temporal validity exist. "No
// relationship system" was a correct observation about the ENTRY TEXT
// and a wrong one about the system.
//
// So this guard does not check whether the file is GOOD — no test can —
// but whether it is COMPLETE. A reference that silently rots does more
// damage than none: it looks like one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const DOC = read('docs/CAPABILITIES.md');

const cliCommands = () => [...read('bin/mem').matchAll(/^ {2}([a-z-]+): async/gm)].map((m) => m[1]);
const mcpTools = () => [...read('bin/mem-mcp').matchAll(/name: '(mem_[a-z_]+)'/g)].map((m) => m[1]);
const types = () => [...read('src/memory.mjs').matchAll(/^ {2}([a-z]+): '[a-z]+\.jsonl'/gm)].map((m) => m[1]);
const edges = () => [...read('src/memory.mjs').matchAll(/^ {2}([a-z]+): 'the source/gm)].map((m) => m[1]);
const modules = () => fs.readdirSync(path.join(REPO, 'src'))
  .filter((n) => n.endsWith('.mjs')).map((n) => n.replace('.mjs', ''));

/** The probe itself has to find something, or the guard proves nothing. */
test('POSITIVE: the probes really do read the surface', () => {
  assert.ok(cliCommands().length >= 30, `only ${cliCommands().length} CLI commands found`);
  assert.ok(mcpTools().length >= 15, `only ${mcpTools().length} MCP tools found`);
  // Fixed numbers, not lower bounds: a lower bound would have let the
  // growth from 10 to 12 (question, procedure on 2026-09-08) through
  // silently, and this test exists to force somebody to touch the
  // reference when the surface changes.
  assert.equal(types().length, 13);
  assert.equal(edges().length, 4);
  assert.ok(modules().length >= 25);
});

// **The guard no longer checks substrings.**
//
// Until 2026-09-08 "is in there" meant `DOC.includes(name)`. Three
// newly built commands — `board`, `classes`, `bridge` — passed that
// without the reference naming them: "board" sits inside "dashboard",
// "bridge" in the prose about the MCP bridge, "classes" in "error
// classes". A guard that stays green while exactly the gap it was
// built against opens up — the class this house calls
// `guard-checks-the-wrong-thing`, inside the guard itself.
//
// Now each KIND gets its own, narrower question:
//   CLI        — is the name in the command block of 7.1? (the same
//                source the reverse check below reads — both
//                directions against the same text)
//   src module — is `<name>.mjs` there? A file name is unambiguous.
//   rest       — a substring is enough: `mem_*` names and edge kinds
//                are already unmistakable.
const cliBlock = () => {
  const m = DOC.match(/### 7\.1 CLI[^\n]*\n+```\n([\s\S]*?)```/);
  assert.ok(m, 'the CLI block in 7.1 cannot be found');
  return new Set(m[1].split(/\s+/).filter(Boolean));
};

for (const [what, probe, inDoc] of [
  ['CLI command', cliCommands, (n) => cliBlock().has(n)],
  ['MCP tool', mcpTools, (n) => DOC.includes(n)],
  ['entry type', types, (n) => DOC.includes(n)],
  ['edge kind', edges, (n) => DOC.includes(n)],
  ['src module', modules, (n) => DOC.includes(`${n}.mjs`)],
]) {
  test(`every ${what} is in CAPABILITIES.md`, () => {
    const missing = probe().filter((x) => !inDoc(x));
    assert.deepEqual(missing, [],
      `${what}s missing from the reference: ${missing.join(', ')} — `
      + 'a reviewer reading only this file will hold them to be absent');
  });
}

/**
 * NEGATIVE CONTROL for the guard itself.
 *
 * The probe has to report something that is NOT in the reference.
 * Without this check the tightening above would be unproven — exactly
 * like the substring version, which would have stayed green for years.
 */
test('POSITIVE: the guard reports a command the reference does not name', () => {
  const block = cliBlock();
  assert.equal(block.has('doesnotexist'), false);
  assert.equal(DOC.includes('doesnotexist.mjs'), false);
  // And the weakening it used to have now shows up:
  assert.ok(DOC.includes('board'), 'precondition: the word does occur in the text');
  assert.ok(block.has('board'), 'but it really is in the command block too');
});

/**
 * The inventory line and the heading of 7.1 are TWO statements about
 * one number. On 2026-09-08 they said 44 and 45.
 */
test('the number of commands is right in exactly one place', () => {
  const inv = DOC.match(/\| \*\*Surfaces\*\* \| (\d+) CLI commands/);
  assert.ok(inv, 'the inventory line names no command count');
  assert.equal(Number(inv[1]), cliCommands().length,
    `the inventory says ${inv[1]}, the code has ${cliCommands().length}`);
});

test('the inventory table comes BEFORE the explanations', () => {
  // A skimming reader gets only the first screens. Put completeness at
  // the bottom and it is not there for them.
  const inventory = DOC.indexOf('## 0. Inventory');
  const first = DOC.indexOf('## 1. The data model');
  assert.ok(inventory > 0 && inventory < first, 'the inventory is not right at the top');
  assert.ok(inventory < 2000, `the inventory starts only at character ${inventory}`);
});

test('the most common wrong verdicts are refuted explicitly', () => {
  // The actual purpose. Anyone about to write "no relationship system"
  // should find that answered in the document instead of inferring it.
  for (const spot of [
    /No relationship system/i,
    /No temporal modelling/i,
    /No importance or salience/i,
    /Missing feature X/i,
  ]) assert.match(DOC, spot, `the wrong verdict ${spot} is not addressed`);
});

test('every check the document names can actually be run', () => {
  // A "here is how you verify it" section pointing at files that do not
  // exist is worse than none: it creates trust without redeeming it.
  const named = [...DOC.matchAll(/node (bench|eval)\/([a-z-]+\.mjs)/g)]
    .map((m) => `${m[1]}/${m[2]}`);
  assert.ok(named.length >= 5, 'barely any verification commands named');
  for (const g of new Set(named)) {
    assert.ok(fs.existsSync(path.join(REPO, g)), `${g} is named but does not exist`);
  }
});

test('the README leads to the reference, and does so early', () => {
  // The entry point is still the README. If it does not point at the
  // reference, the reference changes nothing about the problem it
  // solves.
  const readme = read('README.md');
  const at = readme.indexOf('CAPABILITIES.md');
  assert.ok(at > 0, 'the README does not link to docs/CAPABILITIES.md');
  assert.ok(at < 3000, `the link is only at character ${at} — too far down`);
});

// --- And the other direction -----------------------------------------
//
// The guard above checks that every EXISTING capability is in the
// reference. The reverse was missing, and it went wrong immediately
// during the port on 2026-09-08: the reference named a command
// `broadcast` that did not exist yet. A reference claiming TOO MUCH is
// just as misleading as one naming too little — only harder to notice,
// because nothing is absent.
test('THE REVERSE: the reference names no command that does not exist', () => {
  const doc = read('docs/CAPABILITIES.md');
  // Only the code block in 7.1 — prose names commands in examples, and
  // an example is not a claim about the surface.
  const block = doc.match(/### 7\.1 CLI[^\n]*\n+```\n([\s\S]*?)```/);
  assert.ok(block, 'the CLI block in 7.1 cannot be found');
  const named = block[1].split(/\s+/).filter(Boolean);
  const real = new Set(cliCommands());
  const invented = named.filter((n) => !real.has(n));
  assert.deepEqual(invented, [],
    `the reference names commands that do not exist: ${invented.join(', ')}`);
});

test('and the number in the heading is right', () => {
  const doc = read('docs/CAPABILITIES.md');
  const m = doc.match(/### 7\.1 CLI — (\d+) commands/);
  assert.ok(m, 'the number in the heading of 7.1 is missing');
  assert.equal(Number(m[1]), cliCommands().length,
    `the heading says ${m[1]}, the code has ${cliCommands().length}`);
});
