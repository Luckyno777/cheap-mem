// The doctor must be able to report on a memory that is broken.
//
// **The finding (measured 2026-09-20).** `doctor.can-fail` stood at 28 of
// 31: three findings could not be made to fail by any sabotage. For two
// of them the reason was not their own code but one line in the command
// that calls them —
//
//     const root = findRoot(args);
//     requireConfig(root);          // <- die() on a bad config
//     const result = doctor.checkAll(root);
//
// `requireConfig` ends the process. So on exactly the memory the doctor
// exists for — one that is not set up, or whose config is unreadable —
// no finding was ever produced. `checkConfig` had always returned an
// ERROR finding for that case and `checkRoot` one for a missing
// directory; nobody could get to see either.
//
// A check that cannot fail is not a check, and this one failed silently
// one level up from where it looked: the finding's code was correct the
// whole time.
//
// **Why this is a CLI test and not a unit test.** `checkAll()` on a bare
// directory always worked — that is how the cause was found. The defect
// lived only on the path a real invocation takes, so only a real
// invocation can hold it shut. The same shape as the `mem serve`
// incident two days earlier: two in-process tests were green for a whole
// day while the command was dead.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

/** Run `mem doctor` against a root and return its lines and exit code. */
function doctorAt(root) {
  try {
    const out = execFileSync(process.execPath, [MEM, 'doctor'], {
      env: { ...process.env, CHEAP_MEM_ROOT: root },
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    // A non-zero exit is the NORMAL case here — the doctor exits 1 on
    // warnings and 2 on errors. Only a crash would leave no output.
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The level a named finding reported, or null if it never appeared. */
function levelOf(out, name) {
  const m = new RegExp(`^(ok|WARN|FAIL|\\?)\\s+${name}\\s`, 'm').exec(out);
  return m ? m[1] : null;
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-broken-'));
}

// --- the probe can see anything at all ---------------------------------

test('CONTROL: the doctor answers at all, and this test can read it', () => {
  // Without this, every assertion below could be passing over an empty
  // string — the shape of green this house has a name for.
  const root = tmpRoot();
  try {
    execFileSync(process.execPath, [MEM, 'init'], {
      env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: 'ignore',
    });
    const { out } = doctorAt(root);
    assert.ok(out.length > 200, 'the doctor produced almost no output');
    assert.ok(/^\d+ good, /m.test(out) || /good,/.test(out),
      'the doctor produced no summary line — the output format moved');
    assert.equal(levelOf(out, 'config'), 'ok',
      'a freshly initialised memory does not report a good config');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- the guarantee ------------------------------------------------------

test('a memory with no config is REPORTED, not refused', () => {
  const root = tmpRoot();
  try {
    const { out, code } = doctorAt(root);
    assert.equal(levelOf(out, 'config'), 'FAIL',
      'the doctor did not report a failing config on a memory that has none.\n'
      + 'If it produced no output at all, something ahead of checkAll() called '
      + 'die() again — that is the whole reason this file exists.\n'
      + out.slice(0, 400));
    assert.equal(code, 2, 'an error-level finding must exit 2');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a root that does not exist is REPORTED, not refused', () => {
  const root = path.join(os.tmpdir(), `cm-absent-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(root), false, 'the fixture directory exists — pick another name');
  const { out } = doctorAt(root);
  assert.equal(levelOf(out, 'root'), 'FAIL',
    `the doctor did not report a missing root.\n${out.slice(0, 400)}`);
  assert.equal(levelOf(out, 'config'), 'FAIL',
    'a missing root must also mean a missing config');
});

// --- and the other half: nothing else was loosened ----------------------

test('COUNTER-PROBE: a healthy memory still reports healthy', () => {
  // Removing a gate is easy to get wrong in the generous direction. If
  // this ever fails, the change did not make a broken memory reportable
  // — it made a healthy one look broken.
  const root = tmpRoot();
  try {
    execFileSync(process.execPath, [MEM, 'init'], {
      env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: 'ignore',
    });
    const { out } = doctorAt(root);
    assert.equal(levelOf(out, 'root'), 'ok');
    assert.equal(levelOf(out, 'config'), 'ok');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('COUNTER-PROBE: a WRITING command still demands a config', () => {
  // The gate is right everywhere else. Writing into a memory that is not
  // set up would leave a mess that no finding can describe afterwards.
  // Only the doctor — whose job is the broken case — goes without it.
  const root = tmpRoot();
  try {
    let code = 0; let text = '';
    try {
      execFileSync(process.execPath, [MEM, 'log', 'learning', '--title', 'x', '--text', 'y'], {
        env: { ...process.env, CHEAP_MEM_ROOT: root }, encoding: 'utf8',
      });
    } catch (e) { code = e.status; text = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    assert.notEqual(code, 0, '`mem log` wrote into a memory with no config');
    assert.match(text, /No memory config/,
      'the refusal no longer says what is missing');
    assert.equal(fs.existsSync(path.join(root, '.mem')), false,
      'a refused write left something behind');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
