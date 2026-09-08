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
  cli: [...read('bin/mem').matchAll(/^ {2}([a-z-]+): async/gm)].length,
  mcp: [...read('bin/mem-mcp').matchAll(/name: '(mem_[a-z_]+)'/g)].length,
  modules: fs.readdirSync(path.join(REPO, 'src')).filter((n) => n.endsWith('.mjs')).length,
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
