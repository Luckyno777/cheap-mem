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

// --- the same through the real CLI --------------------------------------------------------------

const SPY = fileURLToPath(new URL('./probe-spy.mjs', import.meta.url));

/** Run `mem --root <root> doctor <flags>`; also say how many probe directories the process started. */
function cli(t, root, flags, env = {}) {
  const log = path.join(tempDir('cm-doctor-full-spy-', t), 'count.txt');
  const r = spawnSync(process.execPath, ['--import', SPY, MEM, '--root', root, 'doctor', ...flags], {
    encoding: 'utf8', env: { ...process.env, PROBE_SPY_LOG: log, ...env },
  });
  const probes = fs.existsSync(log) ? Number(fs.readFileSync(log, 'utf8')) : null;
  return { ...r, probes };
}
const lineOf = (r) => `${r.stdout}`.split('\n').find((l) => l.includes('env/append-atomicity')) ?? '';

test('CLI: the probe starts once for --full and --strict, never for the plain run, --quiet or --alarm', (t) => {
  const root = world(t);
  const counts = {};
  for (const flags of [[], ['--quiet'], ['--alarm'], ['--full'], ['--strict']]) {
    const r = cli(t, root, flags);
    assert.notEqual(r.probes, null, `the spy wrote nothing for [${flags}] (control: the preload must run)`);
    counts[flags.join(' ') || '(plain)'] = r.probes;
  }
  assert.deepEqual(counts, { '(plain)': 0, '--quiet': 0, '--alarm': 0, '--full': 1, '--strict': 1 });
});

test('CLI: --quiet shows the "not measured" line, and the summary does not count it as good', (t) => {
  const root = world(t);
  const quiet = cli(t, root, ['--quiet']);
  assert.match(lineOf(quiet), /^\?\s+env\/append-atomicity .*not measured/, `quiet must keep an unknown:\n${quiet.stdout}`);
  // Same run, all findings: the "good" in the summary is the number of lines that start with `ok`.
  const plain = cli(t, root, []);
  const okLines = plain.stdout.split('\n').filter((l) => /^ok\s/.test(l)).length;
  const summary = plain.stdout.match(/(\d+) good, (\d+) warnings, (\d+) errors, (\d+) unchecked/);
  assert.ok(summary, `no summary line in:\n${plain.stdout}`);
  assert.equal(Number(summary[1]), okLines);
  assert.ok(!/^ok\s+env\/append-atomicity/m.test(plain.stdout));
  // With --full the same finding is measured and reads ok.
  const full = cli(t, root, ['--full']);
  assert.match(lineOf(full), /^ok\s+env\/append-atomicity .*measured/);
});

test('CLI: --alarm (the session-start banner) neither measures nor prints the unknown', (t) => {
  const root = world(t);
  const r = cli(t, root, ['--alarm']);
  assert.equal(r.probes, 0);
  assert.equal(lineOf(r), '', 'alarm lists only what is down; an unmeasured probe is not down');
});

// The CLI has no `fsTypeOf` hook; the only door to a filesystem name is the `stat` binary, so the
// case is driven with a fake `stat` ahead on PATH (as test/environment.test.mjs does). A fake
// executable script cannot be found through PATH on Windows (CreateProcess runs .exe only, ';'-separated),
// so there this one case is skipped; the same classification is covered through `fsTypeOf` in the test above.
test('CLI: a documented-unsafe filesystem is an error without --full, and --alarm shows it', { skip: process.platform === 'win32' && 'a fake stat script cannot be found through PATH on Windows' }, (t) => {
  const root = world(t);
  const bin = tempDir('cm-doctor-full-stat-', t);
  fs.writeFileSync(path.join(bin, 'stat'), '#!/bin/sh\nprintf \'%s\' nfs\n', { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const plain = cli(t, root, [], env);
  assert.equal(plain.probes, 0, 'a name documented as unsafe needs no probe');
  assert.match(lineOf(plain), /^FAIL\s+env\/append-atomicity .*filesystem is nfs/);
  assert.doesNotMatch(lineOf(plain), /^ok\s/);
  assert.notEqual(plain.status, 0, 'an error finding is a non-zero exit');
  const alarm = cli(t, root, ['--alarm'], env);
  assert.equal(alarm.probes, 0);
  assert.match(alarm.stdout, /^FAIL\s+env\/append-atomicity .*filesystem is nfs/m, 'the banner sees the filesystem-name list');
  assert.notEqual(alarm.status, 0);
});
