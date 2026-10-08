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

/**
 * A file's path relative to the repo, always spelled with forward
 * slashes.
 *
 * **Measured 2026-09-19 (run 232).** The positive controls in this file
 * and in test/windows-home.test.mjs were red on the windows-latest
 * runner: "src/doctor.mjs is not seen by the probe". path.relative
 * answers "src\\doctor.mjs" there, and every comparison below is
 * written with a slash.
 *
 * A Windows-portability probe that is not itself portable is worse than
 * no probe: it reports a defect that is not there, on the one platform
 * it exists for. The separator is normalised HERE, where rel is born,
 * so no comparison downstream has to remember.
 */
const relOf = (p) => path.relative(REPO, p).split(path.sep).join('/');

/** Every JavaScript file of ours: src/, test/, bench/ and bin/. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.mjs$/.test(e.name)) continue;
      const rel = relOf(p);
      // This file quotes both wrong spellings on purpose, inside string
      // literals, so that the positive control below can prove the
      // patterns fire. Scanning itself would make the guard permanently
      // red for its own evidence.
      if (rel === 'test/windows-paths.test.mjs') continue;
      out.push({ rel, text: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const d of ['src', 'test', 'bench']) walk(path.join(REPO, d));
  for (const n of fs.readdirSync(path.join(REPO, 'bin'))) {
    const p = path.join(REPO, 'bin', n);
    if (!fs.statSync(p).isFile()) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (!/^#!.*\bnode\b/.test(text) && !n.endsWith('.mjs')) continue;
    out.push({ rel: relOf(p), text });
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
    /\bimport\(\s*(path\.(join|resolve)|`|['"]|\$\{\s*JSON\.stringify\(\s*path\.(join|resolve))/.test(line)
    && !/import\(\s*['"`](?:node:|\.{1,2}\/|[a-z@])/.test(line)
    // Already a URL. A cache-busting template literal built on
    // pathToFileURL(...).href is the CORRECT spelling, and three tests
    // use it; a guard that reported those would be switched off.
    && !/pathToFileURL/.test(line));
}

/**
 * A STATIC `import ... from ${...}` inside a child-process source template
 * whose specifier is a raw path or a path-ish constant. CI run 37757849359:
 * test/find-stream.test.mjs wrote
 *   import { x } from ${JSON.stringify(path.join(HERE, '..', 'src', 'x.mjs'))};
 * into `node -e` -- the shape importOfAPath (dynamic import() only) missed.
 * Accepted: pathToFileURL(...) on the line, or a *_URL / URL-named constant.
 */
function templateImportOfAPath(text) {
  return code(text).filter(({ line }) =>
    /\bimport\b[^;]*\bfrom\s+\$\{/.test(line)
    && !/pathToFileURL|\.href|url/i.test(line)
    // constants built with pathToFileURL elsewhere (concurrent-append, atlas-pass-cm)
    && !/\$\{\s*JSON\.stringify\(\s*(MEMORY|mem|pas)\s*\)/.test(line));
}

test('no child-process source template imports from a raw path', () => {
  const offenders = [];
  for (const { rel, text } of sources()) {
    for (const { line, nr } of templateImportOfAPath(text)) offenders.push(`${rel}:${nr}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [],
    'A `from ${...}` specifier inside a spawned `node -e`/runner file is a URL: use pathToFileURL(p).href.');
  assert.equal(templateImportOfAPath("import { a } from ${JSON.stringify(path.join(HERE, 'x.mjs'))};\n").length, 1, 'positive control');
  assert.equal(templateImportOfAPath("import { a } from ${JSON.stringify(pathToFileURL(p).href)};\n").length, 0);
});

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

test('no stored `source` is a raw path.relative (host separator travels into the journal)', () => {
  // CI run 37720774312: the journal line carried "global\\decisions.jsonl:1" on Windows.
  const offenders = [];
  for (const { rel, text } of sources()) {
    if (!rel.startsWith('src/')) continue;
    for (const { line, nr } of code(text)) {
      if (/\bsources?\s*:\s*path\.relative\(/.test(line)) offenders.push(`${rel}:${nr}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'Use memory.asSource(root, p): a stored/printed source path is spelled with "/".');
  assert.ok(/\bsources?\s*:\s*path\.relative\(/.test('  source: path.relative(root, p),'), 'positive control');
});

test('no printed text interpolates a raw path.relative (users paste it into `git add`)', () => {
  // CI run 37757849359: "Written: inbox\\2026-...md" on Windows. Printed
  // relative paths are posix: memory.asSource(root, p).
  const re = /\$\{[^}]*\bpath\.relative\(/;
  const offenders = [];
  for (const { rel, text } of sources()) {
    if (!/^(src|bin)\//.test(rel)) continue;
    for (const { line, nr } of code(text)) {
      if (re.test(line) && !/split\(path\.sep\)|asSource\(|rel-ok:/.test(line)) offenders.push(`${rel}:${nr}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(re.test('out(`Written: ${path.relative(root, p)}`);'), 'positive control');
});

/** A test-side path.relative whose result keeps the host separator. */
function rawRelative(text) {
  return code(text).filter(({ line }) =>
    /\bpath\.relative\(/.test(line)
    && !/\.split\(path\.sep\)|\bposix\(|\brelPosix\(|rel-ok:/.test(line));
}

test('test helpers do not hand out raw path.relative (caps/allowlists/git keys are posix)', () => {
  // CI run 37757849359 (windows): "src\\chain.mjs ... cap 0", `bin\\mem-mcp:1033`.
  // The shared walker joined with the host separator, so every per-file cap
  // keyed 'src/chain.mjs' missed. Use relPosix()/posix() from
  // test/helpers/relpath.mjs, or mark a self-consistent use with `rel-ok: why`.
  const offenders = [];
  for (const { rel, text } of sources()) {
    if (!rel.startsWith('test/') || rel === 'test/helpers/relpath.mjs') continue;
    for (const { line, nr } of rawRelative(text)) offenders.push(`${rel}:${nr}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, []);
  assert.equal(rawRelative('  const rel = path.relative(REPO, f);\n').length, 1, 'positive control');
  assert.equal(rawRelative('  const rel = relPosix(REPO, f);\n').length, 0);
});

test('the shared f5 walker answers forward slashes', async () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'f5-source.mjs'), 'utf8');
  assert.ok(!/path\.join\(rel,/.test(src), 'files() must not join with the host separator');
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
  // The same mistake spelled inside a child-process source template
  // (cold-index-memo, m10, parity-w1, doctor-idless; run 37720774312).
  assert.equal(
    importOfAPath("    import(${JSON.stringify(path.join(CODE, 'src', 'x.mjs'))}).then(f)\n").length, 1,
    'the template-literal shape import(${JSON.stringify(path.join(...))}) is not recognised');
  assert.equal(
    importOfAPath("    import(${JSON.stringify(pathToFileURL(path.join(CODE, 'x.mjs')).href)}).then(f)\n").length, 0,
    'the template-literal shape with pathToFileURL fires');
  assert.equal(
    importOfAPath("    import(${JSON.stringify(path.join(REPO, 'x', `${g}.mjs`))}).then(f)\n").length, 1);
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
