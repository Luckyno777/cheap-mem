// Numbers in prose have no guard — so they rot, and get quoted anyway.
//
// **The finding (2026-09-08, external review).** Two provably wrong
// numbers in one README: "~500 lines of JS" against a real ~18,900
// (factor 32), and "all 17 MCP tools" against a real 26. Neither was a
// lie anyone told on purpose; both were true once and nobody re-counted.
//
// For this project specifically that is the most expensive kind of
// error it can make. cheap-mem argues for itself with honest
// self-description — "three states, never two", "measured, not
// guessed". A grossly wrong self-report refutes exactly that argument
// the moment someone counts.
//
// Correcting the numbers alone would only reset a clock that drifts
// again. This test re-derives them from the code and fails when the
// README no longer matches, which is what "has a guard" means.
//
// **Why a tolerance, and why it is not a loophole.** Line counts move
// with every commit; an exact match would fail on the next one and get
// switched off within a week. The margin is wide enough to survive
// ordinary work and far too narrow to survive a factor of 32. Counts of
// COUNTABLE things (tools, commands, modules) have no tolerance at all
// — those are facts, not estimates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as clihelp from '../src/clihelp.mjs';
import { MUTANTS } from '../bench/mutation.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const README = read('README.md');

function lineCount(dir, filter = () => true) {
  let n = 0;
  for (const name of fs.readdirSync(path.join(REPO, dir))) {
    if (!filter(name)) continue;
    const p = path.join(REPO, dir, name);
    if (!fs.statSync(p).isFile()) continue;
    n += fs.readFileSync(p, 'utf8').split('\n').length;
  }
  return n;
}

const counted = {
  // **The number a stray proposal document found (2026-09-19).** A
  // proposal written in another session quoted 71 mutants; the README
  // said 48. Checked rather than assumed, because the two could have
  // been different units: bench/mutation.mjs states in its own header
  // that "Each mutant below disables one guarantee" — one to one, so 48
  // was simply 23 short. The bench can be imported without running
  // (that is why MUTANTS is exported), so this counts instead of
  // guessing.
  //
  // Worth noting where it came from: the stale number had survived
  // every probe in this file, because no probe asked about it.
  mutanten: () => MUTANTS.length,
  cli: clihelp.allTableCommands(read).length,
  mcp: [...read('bin/mem-mcp').matchAll(/name: '(mem_[a-z_]+)'/g)].length,
  modules: fs.readdirSync(path.join(REPO, 'src')).filter((n) => n.endsWith('.mjs')).length,
  // The test count cannot be had exactly without running the suite, and a
  // test that starts the suite is a test that contains itself. So: the
  // `test(` call sites, which on 2026-09-19 were 1247 against 1251 really
  // run — 0.3 % apart, because a few probes loop. Near enough for a band,
  // far enough from an invented number.
  tests: fs.readdirSync(path.join(REPO, 'test'))
    .filter((n) => n.endsWith('.test.mjs'))
    .reduce((n, f) => n + (fs.readFileSync(path.join(REPO, 'test', f), 'utf8')
      .match(/^\s*test\(/gm) || []).length, 0),
};

/** The one line in the README that carries the counts. */
function claimLine() {
  const m = README.match(/As of [\d-]+: \*\*(.+?)\*\*/s);
  assert.ok(m, 'the README no longer has an "As of <date>: **…**" line with the counts');
  return m[1].replace(/\s+/g, ' ');
}

test('POSITIVE: the probes actually count something', () => {
  // A guard whose probes return zero passes forever and guards nothing.
  assert.ok(counted.cli >= 30, `only ${counted.cli} CLI commands found — the probe is broken`);
  assert.ok(counted.mcp >= 15, `only ${counted.mcp} MCP tools found — the probe is broken`);
  assert.ok(counted.modules >= 25, `only ${counted.modules} modules found — the probe is broken`);
  assert.ok(counted.tests >= 500, `only ${counted.tests} test( calls found — the probe is broken`);
});

test('the README states the CLI, MCP and module counts, and they are right', () => {
  const claim = claimLine();
  for (const [was, zahl] of [
    ['CLI commands', counted.cli],
    ['MCP tools', counted.mcp],
    ['modules', counted.modules],
  ]) {
    // No tolerance: these are countable things, not estimates.
    assert.match(claim, new RegExp(`\\b${zahl} ${was}\\b`),
      `README says "${claim}" — but the code has ${zahl} ${was}`);
  }
});

test('the README states the test count, and it is close to the real one', () => {
  // **This guard did not exist until 2026-09-19, and the README said it
  // did.** The old text read: "The test count is counted from `test/` and
  // allowed 2 %. It used to be allowed 15 %, and that is how this line sat
  // at 1166 while the suite had grown past 1230." Every word of that was
  // about a check that was nowhere in this repo — grep found no counter of
  // test files at all. A sentence describing a guarantee is not the
  // guarantee; that is the exact class this project built mutation testing
  // to catch, and it walked into the README anyway.
  //
  // The 2 % the old prose promised is now actually enforced.
  const claim = claimLine();
  const m = claim.match(/([\d,]+) tests/);
  assert.ok(m, `the numbers line no longer states a test count: "${claim}"`);
  const behauptet = Number(m[1].replace(/,/g, ''));
  const ab = Math.abs(behauptet - counted.tests) / counted.tests;
  assert.ok(ab <= 0.02,
    `README says ${behauptet} tests, ${counted.tests} test( calls are in test/ `
    + `(${(ab * 100).toFixed(1)} % apart). Run \`npm test\` and put the real number in.`);
});

test('the line-count claim is within a factor that a rewrite cannot hide in', () => {
  const real = lineCount('bin') + lineCount('src', (n) => n.endsWith('.mjs'));
  const m = README.match(/about ([\d,]+) lines/);
  assert.ok(m, 'the README no longer states a line count at all');
  const behauptet = Number(m[1].replace(/,/g, ''));

  // Generous on purpose — see the note at the top. The old claim was
  // 500 against ~18,900; anything that survives this check is honest
  // in the way that matters.
  const faktor = Math.max(real, behauptet) / Math.min(real, behauptet);
  assert.ok(faktor < 1.5,
    `README claims about ${behauptet} lines, the code has ${real} (factor ${faktor.toFixed(1)})`);
});

test('the old claim would fail this test', () => {
  // The point of a guard is that it catches the thing that happened.
  // If the historical error would still pass, the guard is decoration.
  const real = lineCount('bin') + lineCount('src', (n) => n.endsWith('.mjs'));
  assert.ok(real / 500 > 1.5,
    'the "~500 lines" claim would pass — then this test guards nothing');
});

test('the historical measurement is dated, so it cannot be read as current', () => {
  // "0 of 17 MCP tools" was a true measurement of a past day. Undated,
  // it reads as a statement about now — and that is how it ended up in
  // an external review as a second wrong number.
  const i = README.indexOf('0 of the tools');
  assert.ok(i > 0, 'the historical measurement is gone or reworded');
  const umfeld = README.slice(Math.max(0, i - 400), i + 200);
  assert.match(umfeld, /September 2026|2026-09/,
    'the historical measurement carries no date — it will be read as current');
});

// --- The command list, and there being exactly one of it --------------
//
// **The finding (2026-09-08).** The README carried TWO `## Commands`
// sections. The lower one was older and had drifted: it called
// `mem find` a "substring search across logs", which stopped being true
// when ranking landed. Whoever scrolled to the bottom read the stale
// one, and nothing said which was current.
//
// Two lists of the same surface in one document is the two-truths class.
// It is not enough to have merged them once — the merge has to stay
// merged, so the guard is here.

const CMD_BLOCK = () => {
  const m = README.match(/## Commands\n+```\n([\s\S]*?)```/);
  assert.ok(m, 'the README has no command block at all');
  return m[1];
};

test('the README has exactly one command list', () => {
  const n = (README.match(/^## Commands$/gm) ?? []).length;
  assert.equal(n, 1, `${n} "## Commands" sections — one of them is going stale`);
});

test('every command the README names actually exists', () => {
  // A README naming a command that does not exist is worse than one
  // that omits a command: the reader runs it and gets an error that
  // reads like their mistake.
  const named = new Set([...CMD_BLOCK().matchAll(/^mem ([a-z-]+)/gm)].map((m) => m[1]));
  const real = new Set(clihelp.allTableCommands(read));
  // These three are documented spellings of `mem embed` / `mem find`
  // subcommands rather than top-level commands of their own.
  for (const alias of ['find-embed', 'find-hybrid']) named.delete(alias);
  const invented = [...named].filter((n) => !real.has(n));
  assert.deepEqual(invented, [],
    `the README names commands that do not exist: ${invented.join(', ')}`);
});

test('the commands worth finding are in the list', () => {
  // Not every command — the block is a tour, not the reference (that is
  // docs/CAPABILITIES.md 7.1, which IS exhaustive and guarded). But a
  // capability nobody can discover from the entry text is, for most
  // readers, a capability that does not exist.
  const block = CMD_BLOCK();
  for (const c of ['mem init', 'mem log', 'mem find', 'mem doctor', 'mem board',
    'mem status', 'mem classes', 'mem context', 'mem viewer']) {
    assert.ok(block.includes(c), `${c} is not in the README's command list`);
  }
});

test('POSITIVE: the mutation bench really defines mutants', () => {
  // A probe against an empty array passes forever.
  assert.ok(MUTANTS.length >= 30, `only ${MUTANTS.length} mutants — the probe is broken`);
});

test('the README states the number of guarantees, and it matches the bench', () => {
  // No tolerance: this is a countable thing. It sat at 48 while the bench
  // had grown to 71 — the same drift as the command and tool counts, in
  // the one table that tells a reader what the adversarial suite proves.
  const m = README.match(/one of (\d+) guarantees was broken on purpose/);
  assert.ok(m, 'the README no longer names the number of guarantees');
  assert.equal(Number(m[1]), MUTANTS.length,
    `README says ${m[1]} guarantees, bench/mutation.mjs defines ${MUTANTS.length}`);
});
