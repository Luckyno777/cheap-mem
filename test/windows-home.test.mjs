// The home directory is `os.homedir()`, never `process.env.HOME`.
//
// **The finding (2026-09-19).** Triaging a Windows bug report from a
// user who pulled the latest onto a Windows machine, two places in this
// codebase resolved a home directory straight out of `$HOME`:
//
//   src/cli/githook.mjs   path.join(process.env.HOME ?? '/tmp', …)
//   src/doctor.mjs        path.join(process.env.HOME ?? '', '.claude', …)
//
// On Windows HOME is normally unset — the home directory lives in
// USERPROFILE — so both fallbacks fired. The first wrote the pre-commit
// hook into `C:\tmp\`, a directory that usually does not exist. The
// second produced the RELATIVE path `.claude\settings.json`, resolved
// against whatever directory the doctor happened to be run in, so the
// stop-hook check looked at the wrong file and reported "no Stop hook
// found" on a machine that had one.
//
// Neither is visible on Linux or macOS, where HOME is always set. CI
// runs `npm test` on windows-latest and was green through both, because
// nothing in the suite asked the question.
//
// The rule is a SHAPE, not a list of the two files repaired today: a
// list goes stale the moment someone writes the third one. Same
// construction as test/portability.test.mjs, which finds its own
// scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as doctor from '../src/doctor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Forward slashes, on every platform. See the note on relOf in
// test/windows-paths.test.mjs: path.relative answers "src\\doctor.mjs"
// on Windows, and the positive control below compares against
// "src/doctor.mjs". Measured red on the windows-latest runner
// (run 232, 2026-09-19).
const relOf = (p) => path.relative(REPO, p).split(path.sep).join('/');

/** Every JavaScript module that ships — src/ and bin/, recursively. */
function shippedSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.mjs$/.test(e.name)) continue;
      out.push({ rel: relOf(p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(REPO, 'src'));
  for (const n of fs.readdirSync(path.join(REPO, 'bin'))) {
    const p = path.join(REPO, 'bin', n);
    if (!fs.statSync(p).isFile()) continue;
    const text = fs.readFileSync(p, 'utf8');
    // The shell and PowerShell hooks have their own portability rules
    // (test/portability.test.mjs, test/hook-windows-root.test.mjs).
    if (!/^#!.*\bnode\b/.test(text) && !n.endsWith('.mjs')) continue;
    out.push({ rel: relOf(p), text });
  }
  return out;
}

/**
 * A line that READS the home directory out of the environment.
 *
 * Deliberately not every mention of HOME: `CLAUDE_HOME` is a different
 * variable with its own meaning, and a probe that matched it would be
 * red on code that is correct. What matters is `process.env.HOME` used
 * as a path.
 */
function homeFromEnv(text) {
  return text.split('\n')
    .map((line, i) => ({ line, nr: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line))
    .filter(({ line }) => /process\.env\.HOME\b/.test(line));
}

test('no shipped module resolves a home directory through process.env.HOME', () => {
  const offenders = [];
  for (const { rel, text } of shippedSources()) {
    for (const { line, nr } of homeFromEnv(text)) offenders.push(`${rel}:${nr}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [],
    'These read $HOME directly. On Windows HOME is normally unset, so the '
    + 'fallback fires and the path is either wrong (C:\\tmp) or relative '
    + '(resolved against the current directory). Use os.homedir(), which '
    + 'reads $HOME on POSIX and USERPROFILE on Windows.');
});

test('POSITIVE CONTROL: the probe really reads these files', () => {
  // Without this the guard above passes by walking an empty tree, which
  // is how a vacuous check looks from the outside.
  const files = shippedSources();
  assert.ok(files.length >= 40, `only ${files.length} shipped modules found — the walker broke`);
  for (const expected of ['src/doctor.mjs', 'src/cli/githook.mjs']) {
    assert.ok(files.some((f) => f.rel === expected), `${expected} is not seen by the probe`);
  }
  // And the pattern must actually fire on the shape it is meant to catch.
  assert.equal(homeFromEnv("  const t = path.join(process.env.HOME ?? '', 'x');\n").length, 1,
    'the pattern does not recognise the very line this file exists for');
  assert.equal(homeFromEnv("  const t = process.env.CLAUDE_HOME;\n").length, 0,
    'the pattern catches CLAUDE_HOME, which is a different variable');
});

test('the stop-hook check follows the home directory, not the current one', () => {
  // The behavioural half: point the home directory at a tree that holds
  // a wired-up settings.json, and the finding has to come back GOOD
  // whatever the current directory contains.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hroot-'));
  // BOTH variables, because os.homedir() reads USERPROFILE on Windows
  // and $HOME on POSIX. Setting only HOME made this test red on the
  // windows-latest runner (run 232, 2026-09-19) against a doctor that
  // was correct: it went on reading the runner's real profile, found no
  // Stop hook there and answered UNKNOWN. The comment above this test
  // used to claim the single spelling was enough on both. It was not.
  const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const restore = () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bin/mem-capture' }] }] },
    }));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // The probe is only worth anything if the planted home is the one
    // os.homedir() answers with. On a platform where neither variable
    // steers it, this says so instead of measuring the wrong directory.
    assert.equal(os.homedir(), home,
      'os.homedir() does not follow HOME/USERPROFILE on this platform');
    const f = doctor.checkStopHook(root);
    assert.equal(f.level, doctor.LEVEL.GOOD, JSON.stringify(f));
    assert.match(f.text, /mem-capture/);
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('with HOME unset — the Windows condition — the home directory is still found', () => {
  // This is the closest a Linux machine gets to the real failure, and
  // it is close enough to be a measurement rather than a reading.
  //
  // On Windows `process.env.HOME` is undefined. Deleting it here puts
  // this process in exactly that state: `process.env.HOME ?? ''` then
  // yields the relative `.claude/settings.json`, while `os.homedir()`
  // falls back to the passwd entry and still answers with a real
  // absolute directory. So the two spellings disagree here for the same
  // reason they disagree on Windows.
  const before = process.env.HOME;
  try {
    delete process.env.HOME;
    const home = os.homedir();
    assert.ok(path.isAbsolute(home),
      `os.homedir() answered ${JSON.stringify(home)} with HOME unset`);
    // And the spelling that was there until today does NOT.
    assert.equal(path.isAbsolute(path.join(process.env.HOME ?? '', '.claude')), false,
      'process.env.HOME is set after all — this probe is not testing what it claims');
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
  }
});

test('POSITIVE CONTROL: with nothing wired up the finding is not GOOD', () => {
  // A check that says GOOD whatever it is shown is not a check. This is
  // the counter-case to the test above — same code path, empty home.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-empty-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hroot-empty-'));
  const before = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.notEqual(doctor.checkStopHook(root).level, doctor.LEVEL.GOOD);
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
