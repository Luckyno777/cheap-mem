// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Opt-in type check (decision 2026-10-01).
//
// The type check runs in CI ONLY, through `npx` with an exactly pinned
// TypeScript version. package.json gets no entry (no devDependency, no
// lockfile entry), so "no dependencies for the tool itself" stays true.
// Only files carrying `// @ts-check` are checked; tsconfig.json must
// cover them, otherwise the marker is a claim with no effect.
//
// This probe checks four things: the config exists and is opt-in, the
// version appears exactly once and exactly in the workflow, package.json
// knows no typescript, and every @ts-check file is in the config's
// `include`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Does a path match an include pattern of the form `a/**\/*.ext` or `a/*.ext`? */
function matches(pattern, file) {
  const rest = pattern.replace(/^\.\//, '');
  const m = /^(.*?)\/(\*\*\/)?\*(\.[A-Za-z0-9.]+)$/.exec(rest);
  if (!m) return rest === file;
  const [, dir, deep, ext] = m;
  if (!file.startsWith(`${dir}/`) || !file.endsWith(ext)) return false;
  return deep ? true : !file.slice(dir.length + 1).includes('/');
}

function tsconfig() {
  return JSON.parse(read('tsconfig.json'));
}

function tsCheckFiles() {
  const all = execFileSync('git', ['ls-files', '*.mjs', '*.js', '*.cjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean);
  return all.filter((f) => {
    let head;
    try { head = read(f).split('\n').slice(0, 6); } catch { return false; }
    return head.some((l) => /^\/\/\s*@ts-check\s*$/.test(l));
  });
}

test('POSITIVE: matches() tells covered from uncovered', () => {
  assert.equal(matches('src/**/*.mjs', 'src/a.mjs'), true);
  assert.equal(matches('src/**/*.mjs', 'src/x/y.mjs'), true);
  assert.equal(matches('src/**/*.mjs', 'test/a.mjs'), false);
  assert.equal(matches('src/*.mjs', 'src/x/y.mjs'), false);
  assert.equal(matches('src/**/*.mjs', 'src/a.js'), false);
});

test('tsconfig.json exists and is opt-in (checkJs off, noEmit, strict off)', () => {
  const co = tsconfig().compilerOptions;
  assert.equal(co.allowJs, true);
  assert.equal(co.checkJs, false, 'checkJs must be off: only // @ts-check files are checked');
  assert.equal(co.noEmit, true);
  assert.notEqual(co.strict, true);
  assert.deepEqual(co.types, [], 'without @types/node: types must be empty, or tsc looks for a package that is not there');
});

test('the TypeScript version appears exactly once, exactly pinned, in the workflow', () => {
  const ci = read('.github/workflows/ci.yml');
  const hits = ci.match(/typescript@\S+/g) ?? [];
  assert.equal(hits.length, 1, `typescript@ appears ${hits.length}x in the workflow: ${hits.join(' ')}`);
  assert.match(hits[0], /^typescript@\d+\.\d+\.\d+$/, 'version not exactly pinned (no ^, ~, latest)');
  assert.match(ci, /npx --yes -p typescript@\d+\.\d+\.\d+ tsc -p tsconfig\.json/);
});

test('package.json carries no typescript: no dependency of any kind, lockfile clean', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(Object.keys(pkg[field] ?? {}).some((n) => /typescript/i.test(n)), false, `${field} names typescript`);
  }
  assert.doesNotMatch(JSON.stringify(pkg.scripts ?? {}), /\btsc\b/, 'tsc belongs in CI, not in the scripts');
  if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) {
    assert.doesNotMatch(read('package-lock.json'), /"node_modules\/typescript"/, 'typescript is in the lockfile');
  }
});

test('every file with // @ts-check is covered by tsconfig.json', () => {
  const files = tsCheckFiles();
  assert.ok(files.length >= 3, `only ${files.length} @ts-check files found: the search is broken or the opt-in is empty`);
  const include = tsconfig().include ?? [];
  const loose = files.filter((f) => !include.some((p) => matches(p, f)));
  assert.deepEqual(loose, [], `@ts-check without coverage (tsc never sees them): ${loose.join(', ')}`);
});
