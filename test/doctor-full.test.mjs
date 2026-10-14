// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// doctor-full.test.mjs — `mem doctor` runs the concurrent-append probe only
// with `--full` (and under `--strict`), and says so when it did not.
//
// cli-speed-cm, TB7. The probe starts six writer threads on the memory's
// mount; measured at e98bf2d it takes 167-445 ms per run (9 fresh processes, one of them
// past its own 400 ms limit and therefore UNKNOWN), the slowest single part of a doctor run.
// Leaving it out is only honest if the finding then says "not measured", as the third
// state, and never `ok`: test/no-empty-green.test.mjs holds the same line for empty memories.
//
// Structural, not timed: the probe leaves a trace we can count, its probe directory
// (`.append-atomicity-*` made under the root by `fs.mkdtempSync`).
//
// Red proof: against the fixed base commit e98bf2d `checkAll` has no `full` option and
// `mem doctor` takes no `--full` flag, so the probe runs in every call (count 1, not 0)
// and `--full` is refused as an unknown flag. Positive control: the same calls with the
// probe on DO count it, so a count of 0 is not a patch that never bit.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as doctor from '../src/doctor.mjs';
import * as environment from '../src/environment.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function world(t) {
  const root = tempDir('cm-doctor-full-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { input: '', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}

/** How many append probes started while `fn` ran. */
function probesDuring(fn) {
  const real = fs.mkdtempSync;
  let n = 0;
  fs.mkdtempSync = function patched(prefix, ...rest) {
    if (typeof prefix === 'string' && path.basename(prefix).startsWith('.append-atomicity-')) n += 1;
    return real.call(this, prefix, ...rest);
  };
  try { fn(); } finally { fs.mkdtempSync = real; }
  return n;
}

const atomicity = (result) => result.findings.find((f) => f.name === 'env/append-atomicity');

test('checkAll with full: false does not start the probe, and says it did not measure', (t) => {
  const root = world(t);
  let result;
  const started = probesDuring(() => { result = doctor.checkAll(root, { full: false }); });
  assert.equal(started, 0);
  const f = atomicity(result);
  assert.ok(f, 'the finding is missing from the list: a skipped check must still be reported');
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.match(f.text, /not measured/);
  assert.match(f.text, /mem doctor --full/);
  assert.ok(f.advice, 'the unknown names how to get the real answer');
});

test('checkAll by default and with full: true still measures (control)', (t) => {
  const root = world(t);
  assert.equal(probesDuring(() => doctor.checkAll(root)), 1);
  let result;
  assert.equal(probesDuring(() => { result = doctor.checkAll(root, { full: true }); }), 1);
  assert.doesNotMatch(atomicity(result).text, /not measured/);
});

test('the unknown does not hide a documented-unsafe filesystem: that answer needs no probe', (t) => {
  // `fsTypeOf` is the collaborator the product never passes; here it stands in for `stat`.
  const root = tempDir('cm-doctor-full-fs-', t);
  let c;
  const started = probesDuring(() => { c = environment.checkAppendAtomicity(root, { measure: false, fsTypeOf: () => 'nfs' }); });
  assert.equal(started, 0);
  assert.equal(c.ok, false, 'a name documented as unsafe is a failure with or without the probe');
});

test('mem doctor: no flag = not measured, --full = measured, --strict = measured', (t) => {
  const root = world(t);
  const run = (...flags) => spawnSync(process.execPath, [MEM, '--root', root, 'doctor', ...flags], { encoding: 'utf8' });
  const line = (r) => `${r.stdout}`.split('\n').find((l) => l.includes('env/append-atomicity')) ?? '';
  const plain = run();
  assert.ok(line(plain), `no env/append-atomicity line in:\n${plain.stdout}${plain.stderr}`);
  assert.match(line(plain), /not measured/);
  assert.doesNotMatch(line(plain), /^ok /);
  for (const flag of ['--full', '--strict']) {
    const r = run(flag);
    assert.ok(line(r), `no line with ${flag}`);
    assert.doesNotMatch(line(r), /not measured/, `${flag} must run the probe`);
  }
});

test('mem doctor --help names --full, and an unknown flag is still refused', () => {
  const help = spawnSync(process.execPath, [MEM, 'doctor', '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /\[--full\]/);
  assert.match(help.stdout, /--full\s+also run the concurrent-append probe/);
  const bad = spawnSync(process.execPath, [MEM, 'doctor', '--fulll'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});
