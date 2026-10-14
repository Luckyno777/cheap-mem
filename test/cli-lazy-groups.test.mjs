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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { traceRun, GROUPS } from './module-trace.mjs';
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
