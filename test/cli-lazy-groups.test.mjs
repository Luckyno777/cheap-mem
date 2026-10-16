// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// cli-lazy-groups.test.mjs — a CLI start loads the group of ITS command, no other.
//
// cli-speed-cm, TB4. Measured at e98bf2d: `mem version` compiled all six
// group modules (87 handlers) and spent about half its wall time there.
// `bin/mem` now asks `src/cli/command-index.mjs` which group holds the
// command and imports that one.
//
// Structural, not timed (a stopwatch wobbles under load): the number of
// group modules a start imports, read from a module hook.
//
// Red proof: against the fixed base commit e98bf2d every start below loads
// all six groups (`groups.length === 6`), so each count assertion is red
// there; the helper takes the binary as an argument, which is how that was
// run (see the commit message). Positive control: the trace is not empty,
// and the command's OWN group is in it — a hook that logged nothing would
// otherwise read as "loaded nothing".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { traceRun, GROUPS } from './module-trace.mjs';
import { maskText } from '../src/outputguard.mjs';
import { GROUP_COMMANDS } from '../src/cli/command-index.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'mem');

/** Index against the live tables, both directions. Returns the disagreements. */
export function compareIndex(index, tables) {
  const problems = [];
  for (const g of Object.keys(tables)) {
    const have = new Set(Object.keys(tables[g]));
    const listed = new Set(index[g] ?? []);
    for (const n of have) if (!listed.has(n)) problems.push(`'${n}' is defined in ${g}.mjs but missing from GROUP_COMMANDS.${g} (src/cli/command-index.mjs): \`mem ${n}\` would answer "Unknown command"`);
    for (const n of listed) if (!have.has(n)) problems.push(`'${n}' is listed under ${g} in src/cli/command-index.mjs but ${g}.mjs does not define it`);
  }
  for (const g of Object.keys(index)) if (!(g in tables)) problems.push(`index group '${g}' has no module`);
  return problems;
}

async function liveTables() {
  const t = {};
  for (const g of GROUPS) {
    t[g] = (await import(pathToFileURL(path.join(REPO, 'src/cli/commands', `${g}.mjs`)).href)).COMMANDS;
  }
  return t;
}

test('the command index equals the six COMMANDS tables, both directions', async () => {
  const tables = await liveTables();
  // POSITIVE control: tables read, and the index is not empty.
  assert.ok(Object.values(tables).every((x) => Object.keys(x).length >= 3));
  assert.ok(Object.values(GROUP_COMMANDS).flat().length >= 80);
  assert.deepEqual(compareIndex(GROUP_COMMANDS, tables), []);
});

test('SABOTAGE: the comparison sees a missing and a phantom name', async () => {
  const tables = await liveTables();
  const one = Object.keys(tables.write)[0];
  const cut = { ...GROUP_COMMANDS, write: GROUP_COMMANDS.write.filter((n) => n !== one) };
  assert.equal(compareIndex(cut, tables).length, 1);
  assert.match(compareIndex(cut, tables)[0], /missing from GROUP_COMMANDS\.write/);
  const extra = { ...GROUP_COMMANDS, search: [...GROUP_COMMANDS.search, 'phantom-cmd'] };
  assert.match(compareIndex(extra, tables).join('\n'), /'phantom-cmd' is listed under search/);
});

test('a start loads the group of its command and no other (structural)', (t) => {
  const logDir = tempDir('cm-lazy-log-', t);
  const root = tempDir('cm-lazy-root-', t);
  assert.equal(spawnSync(process.execPath, [BIN, 'init', '--root', root], { input: '' }).status, 0);
  // One command per group; the group is read from the index, not retyped here.
  const sample = { write: 'log', search: 'find', capture: 'raw', agents: 'inbox', setup: 'version', admin: 'doctor' };
  for (const [group, cmd] of Object.entries(sample)) {
    assert.ok(GROUP_COMMANDS[group].includes(cmd), `${cmd} is not in ${group} any more: pick another sample`);
    const r = traceRun(BIN, [cmd, '--help'], { root, logDir });
    assert.ok(r.loaded && r.loaded.length > 10, `the module hook logged nothing for 'mem ${cmd}' (control)`);
    assert.deepEqual(r.groups, [group], `'mem ${cmd}' must import exactly the ${group} group, it imported: ${r.groups.join(', ') || 'none'}`);
  }
});

test('help, no arguments and an unknown command load no group at all', (t) => {
  const logDir = tempDir('cm-lazy-log-', t);
  for (const args of [[], ['--help'], ['-h'], ['help'], ['definitely-not-a-command'], ['__proto__'], ['constructor']]) {
    const r = traceRun(BIN, args, { logDir });
    assert.ok(r.loaded && r.loaded.length > 3, `no trace for [${args}] (control)`);
    assert.deepEqual(r.groups, [], `mem ${args.join(' ')}: loaded groups ${r.groups.join(', ')}`);
  }
  // The unknown-command path still answers, with the same words.
  const bad = traceRun(BIN, ['definitely-not-a-command'], { logDir });
  assert.match(`${bad.stdout}${bad.stderr}`, /Unknown command: 'definitely-not-a-command'\. Run 'mem' with no args for help\./);
  assert.notEqual(bad.status, 0);
});

test('a group that does not load is answered as `mem <cmd>: ...` with exit 1, cause visible, no raw stack', (t) => {
  // A throwaway copy of the program, so a real group file can be broken without touching this tree.
  const copy = tempDir('cm-lazy-broken-', t);
  fs.cpSync(path.join(REPO, 'src'), path.join(copy, 'src'), { recursive: true });
  fs.mkdirSync(path.join(copy, 'bin'));
  fs.copyFileSync(BIN, path.join(copy, 'bin', 'mem'));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(copy, 'package.json'));
  const bin = path.join(copy, 'bin', 'mem');
  const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8', input: '' });
  const capture = path.join(copy, 'src', 'cli', 'commands', 'capture.mjs');
  const pristine = fs.readFileSync(capture, 'utf8');

  // Control: the copy runs, in the broken group's command and another group's.
  assert.equal(run('raw', '--help').status, 0, 'control: the untouched copy must run');

  // 1. a file the group imports is gone
  fs.writeFileSync(capture, `import './does-not-exist.mjs';\n${pristine}`);
  let r = run('raw', '--help');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^mem raw: the 'capture' command group did not load: /);
  assert.match(r.stderr, /does-not-exist\.mjs/, 'the cause names the file');
  assert.doesNotMatch(r.stderr, /\n\s+at |node:internal/, 'no raw stack');

  // 2. a syntax error: the file:line is the first thing the engine names
  fs.writeFileSync(capture, `${pristine}\nexport const = ;\n`);
  r = run('raw', '--help');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^mem raw: the 'capture' command group did not load: /);
  assert.match(r.stderr, /capture\.mjs:\d+/, 'the cause names file and line');
  assert.doesNotMatch(r.stderr, /\n\s+at |node:internal/, 'no raw stack');

  // Another group is not hurt by it: that is the point of loading one group per start.
  assert.equal(run('version').status, 0);
});

test('what a failed group load quotes is masked, stripped of control and bidi characters, and cut', (t) => {
  const copy = tempDir('cm-lazy-mask-', t);
  fs.cpSync(path.join(REPO, 'src'), path.join(copy, 'src'), { recursive: true });
  fs.mkdirSync(path.join(copy, 'bin'));
  fs.copyFileSync(BIN, path.join(copy, 'bin', 'mem'));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(copy, 'package.json'));
  const bin = path.join(copy, 'bin', 'mem');
  const capture = path.join(copy, 'src', 'cli', 'commands', 'capture.mjs');
  const pristine = fs.readFileSync(capture, 'utf8');
  // Built at run time, so this file never holds a token-shaped string: an AWS key id and an
  // OpenAI-style key, each as the guard's own patterns know them.
  const aws = `AKIA${'Q7ZX2'.repeat(4).slice(0, 16)}`;
  const sk = `sk-${'aB3dE6gH9'.repeat(4)}`;
  const bidi = '\u202e';
  const long = 'x'.repeat(600);
  // a key split by a zero-width space: the guard must see it whole, so stripping comes before masking
  const joined = `sk-${'Zq4Wx8Rt'.repeat(4)}`;
  const split = `${joined.slice(0, 12)}\u200b${joined.slice(12)}`;
  // control: the guard does know both shapes
  assert.notEqual(maskText(aws), aws, 'control: the guard must know the AWS shape');
  assert.notEqual(maskText(sk), sk, 'control: the guard must know the key shape');
  assert.notEqual(maskText(joined), joined, 'control: the guard must know the joined key');
  // the secrets are in the quoted line of code AND in an identifier the engine names in its message
  fs.writeFileSync(capture, `${pristine}\nexport const ${sk} = "${split}" + "${aws}" ${bidi} ${long} = ;\n`);
  const r = spawnSync(process.execPath, [bin, 'raw', '--help'], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^mem raw: the 'capture' command group did not load: /);
  assert.match(r.stderr, /capture\.mjs:\d+/, 'file:line stays visible');
  assert.ok(!r.stderr.includes(aws) && !r.stderr.includes(sk), 'a token must not reach stderr');
  assert.ok(!r.stderr.includes(joined), 'a key split by a zero-width character must not be joined back in the clear');
  assert.ok(!r.stderr.includes(bidi), 'a bidi override must not reach stderr');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.stderr), 'no control character');
  assert.ok(r.stderr.split('\n').every((l) => l.length <= 400), 'quoted lines are cut');
  assert.ok(r.stderr.split('\n').length <= 6, 'at most the message line and three quoted lines');
});
