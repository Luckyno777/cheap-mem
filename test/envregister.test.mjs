// test/envregister.test.mjs — every environment variable cheap-mem reads is registered.
//
// Port of lucky-mem's n20 riegel. Measure: environment variables read in
// src/, bin/, install/ and hooks/ that have no row in src/envregister.mjs
// (and rows nothing reads). Expected: 0 and 0 on the real tree, and a
// planted, unregistered read of every spelling turns the check red.
//
// Red proof: before this module, `MEM_EXPAND` (src/expand.mjs, read through
// `env[ENV]`) could be written down nowhere, and a new `process.env.X`
// went unnoticed. The sabotage tests below run the same scan on a
// fixture tree that carries one unregistered read per spelling; the
// positive control carries only registered names and stays green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as reg from '../src/envregister.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-envreg-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('positive control: registered names in every spelling are found and the check stays green', () => {
  const dir = fixture({
    'src/a.mjs': "export const f = (env = process.env) => env.MEM_HOOK_OFF === '1' || process.env.CHEAP_MEM_ROOT;\n",
    'src/b.mjs': "export const ENV = 'MEM_EXPAND';\nexport const g = (env) => env[ENV];\nconst h = env['MEM_TZ'];\n",
    'bin/c': '#!/usr/bin/env bash\n[ "${MEM_CAPTURE_OFF:-}" = "1" ] && exit 0\necho "$CHEAP_MEM_CODE"\n',
    'bin/d.ps1': "if ($env:MEM_RETRIEVE_OFF -eq '1') { exit 0 }\n",
    'install/e.sh': '[ -n "${CLAUDE_HOME:-}" ]\n',
  });
  const names = reg.scanReads(dir).map((r) => r.name).sort();
  assert.deepEqual(names, ['CHEAP_MEM_CODE', 'CHEAP_MEM_ROOT', 'CLAUDE_HOME', 'MEM_CAPTURE_OFF', 'MEM_EXPAND',
    'MEM_HOOK_OFF', 'MEM_RETRIEVE_OFF', 'MEM_TZ']);
  const small = reg.REGISTER.filter((s) => names.includes(s.name));
  const r = reg.checkComplete(dir, { register: small });
  assert.equal(r.ok, true, JSON.stringify(r.unregistered));
});

for (const [what, rel, text, name] of [
  ['process.env', 'src/x.mjs', 'export const x = process.env.MEM_SABOTAGE_A;\n', 'MEM_SABOTAGE_A'],
  ['env parameter', 'src/x.mjs', 'export const x = (env) => env.CHEAP_MEM_SABOTAGE_B;\n', 'CHEAP_MEM_SABOTAGE_B'],
  ['env[\'NAME\']', 'src/x.mjs', "export const x = (env) => env['MEM_SABOTAGE_C'];\n", 'MEM_SABOTAGE_C'],
  ['constant used as env[ENV]', 'src/x.mjs', "export const ENV = 'MEM_SABOTAGE_D';\nexport const x = (env) => env[ENV];\n", 'MEM_SABOTAGE_D'],
  ['a name that is not MEM_ prefixed', 'src/x.mjs', 'export const x = process.env.SOME_NEW_API_KEY;\n', 'SOME_NEW_API_KEY'],
  ['shell ${NAME:-}', 'bin/x', '#!/usr/bin/env bash\necho "${MEM_SABOTAGE_E:-}"\n', 'MEM_SABOTAGE_E'],
  ['shell $NAME', 'install/x.sh', 'echo $CHEAP_MEM_SABOTAGE_F\n', 'CHEAP_MEM_SABOTAGE_F'],
  ['PowerShell $env:NAME', 'bin/x.ps1', "if ($env:MEM_SABOTAGE_G) { exit 0 }\n", 'MEM_SABOTAGE_G'],
  ['a git hook', 'hooks/x', '#!/bin/sh\necho "${MEM_SABOTAGE_H}"\n', 'MEM_SABOTAGE_H'],
]) {
  test(`red proof: an unregistered read (${what}) fails the check`, () => {
    const r = reg.checkComplete(fixture({ [rel]: text }), { register: reg.REGISTER });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unregistered.map((u) => u.name), [name]);
    assert.equal(r.unregistered[0].places[0].split(':')[0], rel);
  });
}

test('a standard variable and a comment are not reads', () => {
  const dir = fixture({
    'src/a.mjs': [
      'const h = process.env.HOME ?? process.env.TMPDIR ?? process.env.PATH;',
      '// process.env.MEM_IN_A_COMMENT',
      ' * env.MEM_IN_A_DOC_BLOCK',
      'const x = 1; // env.MEM_TRAILING_COMMENT',
    ].join('\n'),
    'bin/b': '#!/usr/bin/env bash\n# ${MEM_COMMENTED_OUT}\necho "$HOME"\n',
  });
  assert.deepEqual(reg.scanReads(dir), []);
});

test('a row nothing reads is reported as unread', () => {
  const dir = fixture({ 'src/a.mjs': 'export const x = process.env.MEM_HOOK_OFF;\n' });
  const r = reg.checkComplete(dir, { register: [...reg.REGISTER.filter((s) => s.name === 'MEM_HOOK_OFF'), reg.REGISTER.find((s) => s.name === 'MEM_TZ')] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unread, ['MEM_TZ']);
});

test('the real tree: every read is registered and every row is read', () => {
  const r = reg.checkComplete(ROOT);
  assert.ok(r.reads.length > 500, `the scan found only ${r.reads.length} reads — it is not looking`);
  assert.deepEqual(r.unregistered, [], 'environment variables read but not in src/envregister.mjs: '
    + r.unregistered.map((u) => `${u.name} (${u.places[0]})`).join(', '));
  assert.deepEqual(r.unread, [], `rows nothing reads any more: ${r.unread.join(', ')}`);
});

test('MEM_EXPAND — the variable that had no place — is registered as a switch', () => {
  const row = reg.REGISTER.find((s) => s.name === 'MEM_EXPAND');
  assert.ok(row);
  assert.equal(row.kind, reg.KINDS.SWITCH);
});

test('register hygiene: unique names, a known kind, a default and a meaning in every row, no standard variable', () => {
  const names = reg.REGISTER.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'a name appears twice');
  const kinds = new Set(Object.values(reg.KINDS));
  for (const s of reg.REGISTER) {
    assert.ok(kinds.has(s.kind), `${s.name}: unknown kind ${s.kind}`);
    assert.ok(s.default && s.meaning, `${s.name}: default and meaning are required`);
    assert.ok(!reg.STANDARD.includes(s.name), `${s.name} is a standard variable`);
  }
});

test('docs/environment-variables.md carries the generated table, byte for byte', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'environment-variables.md'), 'utf8');
  const block = reg.tableIn(doc);
  assert.ok(block, 'the doc has no table markers');
  assert.equal(block, reg.renderTable(),
    'the table is out of date — paste the output of `node bin/mem envvars --markdown` between the markers');
});

test('red proof for the doc check: a register row the doc lacks is detected', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'environment-variables.md'), 'utf8');
  const bigger = [...reg.REGISTER, { name: 'MEM_NOT_IN_THE_DOC', kind: reg.KINDS.SWITCH, default: 'off', meaning: 'x' }];
  assert.notEqual(reg.tableIn(doc), reg.renderTable(bigger));
  assert.ok(reg.renderTable(bigger).includes('MEM_NOT_IN_THE_DOC'));
});

test('every non-internal row is named in the doc, and a secret never shows its value', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'environment-variables.md'), 'utf8');
  for (const s of reg.REGISTER) assert.ok(doc.includes(`\`${s.name}\``), `${s.name} is not in the doc`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'mem'), 'envvars', '--json'], {
    encoding: 'utf8', env: { ...process.env, CHEAP_MEM_SERVE_TOKEN: 'sekret-value-123', MEM_HOOK_OFF: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(!r.stdout.includes('sekret-value-123'), 'a secret was printed');
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.find((x) => x.name === 'CHEAP_MEM_SERVE_TOKEN').current, 'set');
  assert.equal(rows.find((x) => x.name === 'MEM_HOOK_OFF').current, '1');
});
