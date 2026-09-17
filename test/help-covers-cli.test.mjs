// Does the CLI's own help describe the CLI it has?
//
// **The finding (2026-09-17).** The no-argument help in `bin/mem` is a
// hand-written block of `out(...)` lines; the dispatch table is a
// separate object; nothing tied them together. Measured that day: of 60
// commands, **29 appeared nowhere in the help** — `retrieve`, `epoch`,
// `guard`, `teach`, `gauges`, `shrink`, `net`, `paths` among them.
// Nearly half the tool was invisible unless you read the source.
//
// Two truths, one of them unenforced. A feature nobody can find is
// worth what a feature that does not exist is worth.
//
// **Why the parser is cross-checked before it is trusted.** The command
// list is read out of the source. A parser that quietly matched nothing
// would report a perfectly documented CLI — the greenest possible way
// to fail. So probes A and B drive the REAL binary: names the parser
// found must exist, and names it did not find must not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as clihelp from '../src/clihelp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'mem');

const source = fs.readFileSync(BIN, 'utf8');
const table = clihelp.tableCommands(source);
const helpText = spawnSync('node', [BIN], { encoding: 'utf8' }).stdout;
const help = clihelp.helpCommands(helpText);

const run = (...argv) => spawnSync('node', [BIN, ...argv], { encoding: 'utf8' });

test('positive control: the reading found a CLI at all', () => {
  assert.ok(table.length >= 40, `only ${table.length} commands parsed — the parser is broken`);
  assert.ok(helpText.length > 500, 'the help printed almost nothing');
  for (const core of ['find', 'log', 'doctor', 'duties', 'context']) {
    assert.ok(table.includes(core), `${core} missing from the parsed table`);
  }
});

test('A: every command the parser found really exists in the running CLI', () => {
  // A sample rather than all 60: each name costs a process start. The
  // sample is fixed and spans the sections, so a regression in one
  // corner of the table cannot hide behind a lucky draw.
  for (const name of ['retrieve', 'epoch', 'guard', 'teach', 'paths', 'duties', 'doctor']) {
    assert.ok(table.includes(name), `${name} was not parsed out of the table`);
    const r = run(name, '--help');
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Unknown command/,
      `the parser claims '${name}' exists, the CLI disagrees`);
  }
});

test('B: a name the parser did NOT find is rejected by the running CLI', () => {
  for (const nonsense of ['retreive', 'gauge', 'definitely-not-a-command']) {
    assert.ok(!table.includes(nonsense), `unexpected: '${nonsense}' is in the table`);
    const r = run(nonsense);
    assert.match(`${r.stdout}${r.stderr}`, /Unknown command/,
      `'${nonsense}' is not in the table but the CLI accepted it — the parser missed a key`);
  }
});

test('C: no PHANTOM — the help never names a command that does not exist', () => {
  const { phantom } = clihelp.compare({ table, help });
  assert.deepEqual(phantom, [],
    'the help sends people down a road that is not there: ' + phantom.join(', '));
});

test('D: no INVISIBLE command — everything the CLI can do, the help says', () => {
  const { invisible } = clihelp.compare({ table, help });
  assert.deepEqual(invisible, [],
    `${invisible.length} command(s) exist but are mentioned nowhere in the help: `
    + invisible.join(', '));
});

test('E: the usage column ends where the prose begins', () => {
  // The line that produced a phantom called `with` while this was being
  // built. Kept as a probe because the mistake is easy to make again.
  const names = clihelp.helpCommands('  agent new|show <name>       agents/<name>/ with prompt');
  assert.deepEqual(names, ['agent']);
});

test('F: alternatives inside the usage column DO count', () => {
  const names = clihelp.helpCommands('  raw migrate [--remove] / raw export --into <dir>');
  assert.ok(names.includes('raw'), 'the leading command was lost');
});

test('G: a QUOTED key in the table is a command like any other', () => {
  // The regression this file exists to prevent. Until 2026-09-17 four
  // separate copies of the reading used /^ {2}([a-z-]+): async/ — no
  // quotes allowed — so `'find-embed'`, `'find-hybrid'`, `'raw-capture'`
  // and `'topic-merge'` were invisible to every count and every
  // completeness check in the house. All four were in fact missing from
  // docs/CAPABILITIES.md 7.1, and the guard built to catch exactly that
  // reported the reference complete.
  const sample = [
    'const COMMANDS = {',
    '  plain: async () => {},',
    "  'with-dash': async () => {},",
    '};',
  ].join('\n');
  assert.deepEqual(clihelp.tableCommands(sample), ['plain', 'with-dash']);
});

test('H: the four commands that were invisible are in the reading now', () => {
  for (const quoted of ['find-embed', 'find-hybrid', 'raw-capture', 'topic-merge']) {
    assert.ok(table.includes(quoted), `${quoted} dropped out of the reading again`);
  }
});
