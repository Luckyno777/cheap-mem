// The write path for README.md's numbers (B10) — an English rebuild of
// lucky-mem's `betrieb/readme-zahlen.mjs` write path, against
// cheap-mem's own bench/readme-numbers.mjs and README.
//
// **Why this file exists.** `test/readme-zahlen.test.mjs` catches a
// drifted number; it has never fixed one. Every catch since 2026-09-08
// was corrected by the same hand-motion. This is the write path, and —
// same as lucky-mem's own postmortem — it is graded on more than "it
// writes": a claim line can hold several numbers, and fixing them by
// searching for each OLD VALUE as a plain string can match inside the
// digits an earlier fix just wrote. The second test below is that exact
// class, chosen so a naive string-replace is guaranteed to get it wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as numbers from '../bench/readme-numbers.mjs';

/**
 * A minimal tree with exactly the files the counters read — deliberately
 * NOT this repo's own tree: a test that writes the real README changes
 * the very thing it is checking.
 */
function tree({ cli = 2, mcp = 2, modules = 2, tests = 2, line = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-numbers-'));
  fs.mkdirSync(path.join(root, 'src', 'cli', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bench'), { recursive: true });

  // cli: spread across the six fixed group files allTableCommands reads.
  const groups = ['write', 'search', 'capture', 'agents', 'setup', 'admin'];
  for (const [i, g] of groups.entries()) {
    const mine = i === 0 ? cli : 0;
    const body = Array.from({ length: mine }, (_, k) => `  'c${k}': async () => {},`).join('\n');
    fs.writeFileSync(path.join(root, 'src', 'cli', 'commands', `${g}.mjs`),
      `export const COMMANDS = {\n${body}\n};\n`);
  }

  // mcp: `name: 'mem_x'` occurrences in bin/mem-mcp — letters only, the
  // pattern this counts (and the real bin/mem-mcp) never has digits here.
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const mcpBody = Array.from({ length: mcp }, (_, k) => `      name: 'mem_t${letters[k]}',`).join('\n');
  fs.writeFileSync(path.join(root, 'bin', 'mem-mcp'), `const TOOLS = [\n${mcpBody}\n];\n`);

  // modules: files under src/.
  for (let i = 0; i < modules; i += 1) fs.writeFileSync(path.join(root, 'src', `m${i}.mjs`), '// empty\n');

  // tests: `test(` call sites under test/.
  fs.writeFileSync(path.join(root, 'test', 'p.test.mjs'),
    Array.from({ length: tests }, () => "test('x', () => {});\n").join(''));

  // guarantees: bench/mutation.mjs's MUTANTS.
  fs.writeFileSync(path.join(root, 'bench', 'mutation.mjs'), 'export const MUTANTS = [{}, {}];\n');

  fs.writeFileSync(path.join(root, 'README.md'), `# Title\n\n${line}\n`);
  return root;
}

const rm = (r) => fs.rmSync(r, { recursive: true, force: true });
const CLAIM = (cli, mcp, modules, tests) => `As of 2026-01-01: **${cli} CLI commands, ${mcp} MCP tools, ${modules} modules, ${tests}\ntests**`;

test('the write path pulls the exact numbers forward', async () => {
  const root = tree({ cli: 3, mcp: 4, modules: 5, tests: 6, line: CLAIM(1, 1, 1, 1) });
  try {
    const before = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const report = await numbers.updateNumbers({ root, write: true });
    const after = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.notEqual(after, before);
    assert.match(after, /\*\*3 CLI commands, 4 MCP tools, 5 modules, 1\ntests\*\*/, after);
    assert.deepEqual(report.changes.map((c) => c.field).sort(), ['cli', 'mcp', 'modules']);
  } finally { rm(root); }
});

test('THE BUG THAT MUST NOT COME BACK: several numbers in one claim, fixed by position', async () => {
  // Chosen so a plain `text.replace(String(old), String(new))` is
  // guaranteed to fail: fixing "1" -> "28" first plants a "2" in the
  // text, and the next search (for mcp's old value "2") would find that
  // "2" — inside "28" — before the real one.
  const root = tree({ cli: 28, mcp: 15, modules: 6, tests: 2, line: CLAIM(1, 2, 3, 2) });
  try {
    await numbers.updateNumbers({ root, write: true });
    const after = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(after, /\*\*28 CLI commands, 15 MCP tools, 6 modules, 2\ntests\*\*/,
      `a digit of an earlier fix leaked into a later one: ${JSON.stringify(after)}`);
  } finally { rm(root); }
});

test('a dry run does not write, but reports the same changes', async () => {
  const root = tree({ cli: 3, mcp: 4, modules: 5, tests: 6, line: CLAIM(1, 1, 1, 1) });
  try {
    const before = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const report = await numbers.updateNumbers({ root, write: false });
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), before, 'wrote anyway');
    assert.equal(report.wrote, false);
    assert.deepEqual(report.changes.map((c) => c.field).sort(), ['cli', 'mcp', 'modules']);
  } finally { rm(root); }
});

test('a number that already matches is left alone — or every commit would touch the README', async () => {
  const root = tree({ cli: 3, mcp: 4, modules: 5, tests: 6, line: CLAIM(3, 4, 5, 6) });
  try {
    const before = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const report = await numbers.updateNumbers({ root, all: true, write: true });
    assert.deepEqual(report.changes, []);
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), before);
  } finally { rm(root); }
});

test('a MISSING claim is reported, not silently passed over', async () => {
  const root = tree({ cli: 3, mcp: 4, modules: 5, tests: 6, line: 'CLI commands: three, MCP tools: four' });
  try {
    const report = await numbers.updateNumbers({ root, write: true });
    assert.ok(report.missing.length > 0, 'the rewritten line was not reported missing');
    assert.deepEqual(report.changes, []);
  } finally { rm(root); }
});

test('the default (EXACT) selection does not touch tests or lines — those move on every commit', async () => {
  const root = tree({ cli: 3, mcp: 4, modules: 5, tests: 6, line: CLAIM(3, 4, 5, 1) });
  try {
    const report = await numbers.updateNumbers({ root, write: true }); // no `all`
    assert.deepEqual(report.changes, [], 'the default selection touched something');
    const after = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(after, /\ntests\*\*/, 'the stale tests number should still be there, untouched');
  } finally { rm(root); }
});

test('`--all` also pulls the noisy numbers forward', async () => {
  const root = tree({ cli: 3, mcp: 4, modules: 5, tests: 9, line: CLAIM(3, 4, 5, 1) });
  try {
    const report = await numbers.updateNumbers({ root, all: true, write: true });
    assert.ok(report.changes.some((c) => c.field === 'tests'), 'tests was not pulled forward under --all');
    const after = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(after, /9\ntests\*\*/);
  } finally { rm(root); }
});

test('checkNumbers reports mismatches without writing anything', async () => {
  const root = tree({ cli: 3, mcp: 4, modules: 5, tests: 6, line: CLAIM(1, 4, 5, 6) });
  try {
    const before = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const report = await numbers.checkNumbers({ root, only: numbers.EXACT });
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), before);
    assert.deepEqual(report.mismatches.map((m) => m.field), ['cli']);
  } finally { rm(root); }
});

test('POSITIVE: EXACT and ALL are not accidentally empty', () => {
  assert.ok(numbers.EXACT.length >= 3);
  assert.ok(numbers.ALL.length > numbers.EXACT.length);
  assert.ok(!numbers.EXACT.includes('tests'));
  assert.ok(!numbers.EXACT.includes('lines'));
});
