// test/helpers/old-source-copy.mjs - put ONE old source file where a red proof
// can import or run it, without writing into the repository's own bin/ or src/.
//
// **Why.** The red proofs used to drop the old file next to the live ones
// (`bin/.x-old-mem-serve.mjs`, `src/.x-old-search.mjs`) so its relative
// imports resolved. `node --test` runs the test FILES in parallel, and other
// files copy `bin/` and `src/` (`fs.cpSync`) or spawn from them: a file that
// exists in the live tree for a moment makes such a copy die with
// `ENOENT ... '<copy>/src'` (measured: 147 of 300 copies while one file
// flickered in the source directory; CI run of 152ade6, ubuntu, node 22).
// Both helpers keep the old file in a throwaway directory and reach the live
// tree through links and absolute imports, read-only.
//
// The caller removes `dir` in a `finally`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A throwaway package holding `source` as `bin/<name>` (a `.mjs` loses its
 * shebang line, as it is imported or run through node). `src`, `shared`,
 * `assets` and `node_modules` are links to the live ones; `siblings` are
 * live `bin/` files copied beside it (a shell script needs `_portable.sh`).
 * Returns `{ script, dir }`.
 */
export function oldBinCopy(repo, name, source, siblings = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-old-bin-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const script = path.join(dir, 'bin', name);
  fs.writeFileSync(script, name.endsWith('.mjs') ? source.replace(/^#!.*\n/, '') : source, { mode: 0o755 });
  for (const s of siblings) fs.copyFileSync(path.join(repo, 'bin', s), path.join(dir, 'bin', s));
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(dir, 'package.json'));
  for (const link of ['src', 'shared', 'assets', 'node_modules']) {
    if (fs.existsSync(path.join(repo, link))) fs.symlinkSync(path.join(repo, link), path.join(dir, link), 'junction');
  }
  return { script, dir };
}

/**
 * `source` (an old module that lived in `liveDir`) written to a throwaway
 * directory as `name`, its relative imports (`./x.mjs`, `../../y.mjs`)
 * rewritten to the live files (file URLs). Returns `{ file, dir }`.
 */
export function oldModuleCopy(liveDir, name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-old-module-'));
  const text = source.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (_m, lead, q, rel) => `${lead}${q}${pathToFileURL(path.resolve(liveDir, rel)).href}${q}`);
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return { file, dir };
}
