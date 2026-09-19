// A path is not a URL, and a URL is not a path.
//
// **The measurement (2026-09-19).** Triaging a Windows bug report, the
// windows-latest CI job on the branch tip (run 230) was red with four
// failures — while ubuntu and macos were green. Both causes were this
// one confusion, in two shapes:
//
//   test/calculations.test.mjs  path.resolve(new URL('..', import.meta.url).pathname)
//       On Windows the pathname is "/D:/a/cheap-mem/cheap-mem/", with a
//       leading slash. path.resolve then glues the current drive in
//       front: "D:\D:\a\…". The test reported the catalogue missing
//       about a file that was there.
//
//   test/cli-groups.test.mjs    await import(path.join(REPO, …, 'write.mjs'))
//       An ESM specifier is a URL. Node reads the drive letter of
//       "D:\a\…" as a scheme: ERR_UNSUPPORTED_ESM_URL_SCHEME,
//       "Received protocol 'd:'".
//
// **Why this file exists and not just the two repairs.** Both lessons
// were ALREADY in this repository when they were broken again:
// test/init.test.mjs carries the pathname lesson in its own comment,
// and test/concurrent-append.test.mjs carries the import-URL lesson in
// its own comment, both written after earlier Windows runs. A lesson in
// a comment protects the file it sits in. Nothing carried it to the
// next file, so the same two mistakes were written again, and the CI
// job that would have said so was red and unread.
//
// So the rule is a SHAPE the probe finds for itself, not a list of the
// two files repaired today. Same construction as
// test/portability.test.mjs, which finds its own shell scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every JavaScript file of ours: src/, test/, bench/ and bin/. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.mjs$/.test(e.name)) continue;
      const rel = path.relative(REPO, p);
      // This file quotes both wrong spellings on purpose, inside string
      // literals, so that the positive control below can prove the
      // patterns fire. Scanning itself would make the guard permanently
      // red for its own evidence.
      if (rel === path.join('test', 'windows-paths.test.mjs')) continue;
      out.push({ rel, text: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const d of ['src', 'test', 'bench']) walk(path.join(REPO, d));
  for (const n of fs.readdirSync(path.join(REPO, 'bin'))) {
    const p = path.join(REPO, 'bin', n);
    if (!fs.statSync(p).isFile()) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (!/^#!.*\bnode\b/.test(text) && !n.endsWith('.mjs')) continue;
    out.push({ rel: path.relative(REPO, p), text });
  }
  return out;
}

/**
 * Code lines, with two exclusions.
 *
 * Comments, because prose about a bug is not the bug. And any line
 * carrying `windows-path-ok:` — a deliberate exemption that has to name
 * its reason on the line itself, so it stays readable instead of
 * disappearing into a list somewhere else. There is exactly one today:
 * a test that PROVES a drive-letter specifier is rejected, and which
 * therefore has to contain one.
 */
const code = (text) => text.split('\n')
  .map((line, i) => ({ line, nr: i + 1 }))
  .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .filter(({ line }) => !/windows-path-ok:/.test(line));

/**
 * `new URL(…).pathname` fed to something that expects a filesystem path.
 *
 * Deliberately not every `.pathname`: bin/mem-serve routes HTTP requests
 * on `url.pathname`, which is a URL path and exactly right there. What
 * is wrong is a `.pathname` taken off a `new URL(...)` built from
 * `import.meta.url` or a `file:` URL — those are meant to become paths
 * and must go through fileURLToPath.
 */
function pathnameAsPath(text) {
  return code(text).filter(({ line }) =>
    /new URL\([^)]*\)\s*\.pathname/.test(line)
    || /\bimport\.meta\.url[^;]*\)\s*\.pathname/.test(line));
}

/** A dynamic `import()` handed a path instead of a URL. */
function importOfAPath(text) {
  return code(text).filter(({ line }) =>
    /\bimport\(\s*(path\.(join|resolve)|`|['"])/.test(line)
    && !/import\(\s*['"`](?:node:|\.{1,2}\/|[a-z@])/.test(line)
    // Already a URL. A cache-busting template literal built on
    // pathToFileURL(...).href is the CORRECT spelling, and three tests
    // use it; a guard that reported those would be switched off.
    && !/pathToFileURL/.test(line));
}

test('no file turns a URL pathname into a filesystem path', () => {
  const offenders = [];
  for (const { rel, text } of sources()) {
    for (const { line, nr } of pathnameAsPath(text)) offenders.push(`${rel}:${nr}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [],
    'On Windows a file URL pathname is "/D:/a/…" — with a leading slash — and '
    + 'path.resolve glues the current drive in front of it: "D:\\D:\\a\\…". '
    + 'Use fileURLToPath().');
});

test('no dynamic import is handed a filesystem path', () => {
  const offenders = [];
  for (const { rel, text } of sources()) {
    for (const { line, nr } of importOfAPath(text)) offenders.push(`${rel}:${nr}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [],
    'An ESM specifier is a URL. On Windows Node reads the drive letter of '
    + '"D:\\a\\…" as a scheme and refuses with ERR_UNSUPPORTED_ESM_URL_SCHEME. '
    + 'Use pathToFileURL(p).href.');
});

test('POSITIVE CONTROL: the probe reads a real tree and both patterns fire', () => {
  // Two guards that walk an empty tree pass forever, and two patterns
  // that match nothing pass forever. Both halves are checked here,
  // because either one alone is a check that checks nothing.
  const files = sources();
  assert.ok(files.length >= 150, `only ${files.length} files found — the walker broke`);
  for (const expected of ['test/calculations.test.mjs', 'test/cli-groups.test.mjs']) {
    assert.ok(files.some((f) => f.rel === expected), `${expected} is not seen by the probe`);
  }

  // The exact two lines this file exists for.
  assert.equal(
    pathnameAsPath("  const root = path.resolve(new URL('..', import.meta.url).pathname);\n").length, 1,
    'the pathname pattern does not recognise the line it was written for');
  assert.equal(
    importOfAPath("    const m = await import(path.join(REPO, 'x', `${g}.mjs`));\n").length, 1,
    'the import pattern does not recognise the line it was written for');

  // And the shapes that are CORRECT must not fire — a bolt that reports
  // innocents gets switched off.
  assert.equal(pathnameAsPath("    if (url.pathname === '/health') {\n").length, 0,
    'the pattern catches an HTTP route, which is a URL path and right as it is');
  assert.equal(importOfAPath("  const m = await import('node:fs');\n").length, 0,
    'the pattern catches a bare node: specifier');
  assert.equal(importOfAPath("  const m = await import('../src/memory.mjs');\n").length, 0,
    'the pattern catches an ordinary relative specifier');
  assert.equal(importOfAPath("  const m = await import(pathToFileURL(p).href);\n").length, 0,
    'the pattern catches the correct spelling');
});
