// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/modelcost-cli.test.mjs — `mem modelcost` reads the cost journal
// src/modelcost.mjs writes (see test/modelcost-digest-wiring.test.mjs
// for the writer side). Added so test/no-log-without-reader.test.mjs's
// house rule holds: an appending log module needs a reader reachable
// from bin/.
//
// Red proof pinned to this worktree's starting commit
// (ddca89d5430b7c2866a93788edd6fe14822af337, never `git merge-base`):
// `mem modelcost` does not exist there at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { oldModuleCopy } from './helpers/old-source-copy.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as modelcost from '../src/modelcost.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';
const MEM = path.join(REPO, 'bin', 'mem');

function memoryRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-modelcost-cli-'));
  const init = spawnSync(process.execPath, [MEM, '--root', r, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return r;
}
const cli = (root, ...args) => spawnSync(process.execPath, [MEM, '--root', root, ...args], { encoding: 'utf8', timeout: 15000 });

test('RED on the old commit: admin.mjs\'s COMMANDS table has no `modelcost` at all', async () => {
  // bin/mem's own dispatcher is unchanged — it just merges whichever
  // COMMANDS the six group modules export — so the pin belongs on the
  // module that actually changed, imported from beside its own
  // relative imports (`../../today.mjs` etc. must still resolve).
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:src/cli/commands/admin.mjs`], { cwd: REPO, encoding: 'utf8' });
  const copy = oldModuleCopy(path.join(REPO, 'src', 'cli', 'commands'), 'admin.mjs', old);
  const tmp = copy.file;
  try {
    const mod = await import(`${pathToFileURL(tmp).href}?t=${Math.random()}`);
    assert.ok(!('modelcost' in mod.COMMANDS), '`modelcost` must not exist on the old commit');
  } finally { fs.rmSync(copy.dir, { recursive: true, force: true }); }
});

test('GREEN: an empty journal says "not measured yet", never a dash or 0', () => {
  const root = memoryRoot();
  try {
    const r = cli(root, 'modelcost');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Not measured yet/);
    assert.match(r.stdout, /model-cost\.jsonl/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('GREEN: real rows are summed per caller, tokens and cost both shown', () => {
  const root = memoryRoot();
  try {
    modelcost.record(root, { who: 'digest', usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.002 });
    modelcost.record(root, { who: 'digest', usage: { input_tokens: 50, output_tokens: 10 }, costUsd: 0.001 });
    const r = cli(root, 'modelcost');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /digest: 2 run\(s\), 150 in \/ 30 out tokens, \$0\.0030/);

    const j = cli(root, 'modelcost', '--json');
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].who, 'digest');
    assert.equal(parsed[0].runs, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('GREEN: a row with usage but no cost field reads "cost not reported", never $0', () => {
  const root = memoryRoot();
  try {
    modelcost.record(root, { who: 'digest', usage: { input_tokens: 10, output_tokens: 5 } });
    const r = cli(root, 'modelcost');
    assert.match(r.stdout, /cost not reported by this CLI/);
    assert.doesNotMatch(r.stdout, /\$0\.0000/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
