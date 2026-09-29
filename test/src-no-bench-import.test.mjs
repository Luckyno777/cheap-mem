// test/src-no-bench-import.test.mjs — src/ (and bin/) never import from
// bench/ (agent/parity-to-src, 2026-09-29).
//
// **The bug this guards against.** `bench/` is not in the published npm
// package (see test/package-contents.test.mjs) — it is a dev-only
// benchmark tree. Since W9, `src/doctor.mjs` imported `debtList` from
// `../bench/parity.mjs`, so a real `npm i -g cheap-mem` install crashed
// on `mem doctor` with ERR_MODULE_NOT_FOUND: the file it needed was
// never shipped. `bench/` may import from `src/` (that direction is
// fine and common); `src/` and `bin/` must never import from `bench/`,
// in either a static `import ... from` or a dynamic `import(...)`
// string — a static scan catches both shapes.
//
// RED PROOF (2026-09-29, pinned against a fixed commit, rule 12): at
// 5e4a1df944d0eb32e4b57ee5cb0d6d2e5e825e63 (this branch's start,
// before the parity-to-src move), `src/doctor.mjs` read
// `import { debtList } from '../bench/parity.mjs';` — this probe would
// have failed there:
//   `git -C . show 5e4a1df944d0eb32e4b57ee5cb0d6d2e5e825e63:src/doctor.mjs`
//   contains that exact import line. This test's own logic, run
//   against that text, reports the violation (verified below via the
//   same regex against a literal snippet, since checking out that old
//   tree here would mean the test walks the WRONG doctor.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.mjs') || name === 'mem' || name.startsWith('mem-')) out.push(p);
  }
  return out;
}

// Matches BOTH shapes: `import ... from '../bench/x.mjs'` (any number of
// `../`) and a dynamic `import('../bench/x.mjs')` string — the whole
// point of a static scan is to see the string whether or not it is ever
// executed on this platform.
const BENCH_IMPORT = /(?:from\s*|import\()\s*['"](?:\.\.\/)+bench\//;
// Built-path form (2026-09-29, mirror of lucky-mem's guard): a bench path
// assembled via import()/pathToFileURL()/require()/join()/resolve() is the
// same import — the static pattern above cannot see it. Checked on code
// with comments blanked, so prose about bench/ never counts.
const BENCH_BUILT = /(?:\bimport\s*\(|\bpathToFileURL\s*\(|\brequire\s*\(|\b(?:join|resolve)\s*\()[^;]*?['"`](?:[^'"`\n]*\/)?bench(?:\/[^'"`\n]*)?['"`]|(?:\bimport\s*\(|\bpathToFileURL\s*\(|\b(?:join|resolve)\s*\()[^;]*?['"`][^'"`\n]*\bbench\/[^'"`\n]*['"`]/;

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(\s)\/\/\s.*$/gm, '$1');
}

function violations(root) {
  const found = [];
  for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'bin'))]) {
    const text = fs.readFileSync(file, 'utf8');
    const code = withoutComments(text);
    if (BENCH_IMPORT.test(code) || BENCH_BUILT.test(code)) found.push(path.relative(root, file));
  }
  return found;
}

test('POSITIVE: the scan really walks src/ and bin/ and would catch a bench import', () => {
  const files = [...walk(path.join(REPO, 'src')), ...walk(path.join(REPO, 'bin'))];
  assert.ok(files.length >= 30, `only ${files.length} files walked — the walk is broken`);
  assert.ok(files.some((f) => f.endsWith('doctor.mjs')));
  assert.match("import { debtList } from '../bench/parity.mjs';", BENCH_IMPORT,
    'the pattern itself does not catch the exact line that caused the bug');
  assert.match('const m = await import("../../bench/x.mjs");', BENCH_IMPORT,
    'the pattern does not catch a dynamic import string');
  assert.doesNotMatch("import { siblingClone } from './sibling.mjs';", BENCH_IMPORT,
    'the pattern flags an ordinary sibling import — false positive');
});

test('no file under src/ or bin/ imports from ../bench/', () => {
  const found = violations(REPO);
  assert.deepEqual(found, [],
    `these import from bench/, which ships in no published package: ${found.join(', ')} — `
    + 'move the code bench/ and src/ both need into src/, and have bench/ import FROM src/, never the reverse.');
});

test('POSITIVE: the built-path form is caught; prose, comments and string literals are not', () => {
  assert.match(withoutComments("const m = await import(pathToFileURL(path.join(root, 'bench', 'x.mjs')).href);"), BENCH_BUILT);
  assert.match(withoutComments("const p = path.resolve(here, '../bench/x.mjs'); await import(p);"), BENCH_BUILT);
  assert.doesNotMatch(withoutComments("// see bench/x.mjs via path.join(root, 'bench')"), BENCH_BUILT);
  assert.doesNotMatch(withoutComments("/* import(path.join('bench','x')) */"), BENCH_BUILT);
  assert.doesNotMatch(withoutComments("const note = 'run bench/x.mjs by hand';"), BENCH_BUILT);
});
