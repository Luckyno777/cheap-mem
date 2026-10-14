// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// import-flag-url.test.mjs — `node --import <X>` in a test names a URL, never a bare path.
//
// On Windows a path is `C:\...`, Node reads `c:` as a URL scheme and refuses with
// ERR_UNSUPPORTED_ESM_URL_SCHEME (test/windows-paths.test.mjs holds the same lesson for
// `import()`). cli-speed-cm's first doctor-full test passed a raw path to `--import` and three
// tests would have gone red on the Windows runner only.
//
// The reading: after the separate argument `'--import'` (or inside `--import=` / `--import `) comes
// either a data: / file: URL, a `pathToFileURL(...)`, something ending in `.href`, or a
// name defined in the same file as one of those. Anything else is named. Cheap, textual, and
// proved on both sides below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

const isUrlish = (expr) => /data:|file:|pathToFileURL|\.href\b/.test(expr);

/** Is the file-level name `name` defined (within four lines) as something URL-ish? */
function nameIsUrl(lines, name) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b`);
  const at = lines.findIndex((l) => re.test(l));
  return at >= 0 && isUrlish(lines.slice(at, at + 4).join('\n'));
}

/** The `--import` operands of one source text that are not URLs: [{ line, operand }]. */
export function bareImportOperands(source) {
  const bad = [];
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    // 1. separate argument: '--import', <operand>
    for (const m of text.matchAll(/['"`]--import['"`]\s*,\s*([^,\]\n]+)/g)) {
      const operand = m[1].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(operand) ? !nameIsUrl(lines, operand) : !isUrlish(operand)) {
        bad.push({ line: i + 1, operand });
      }
    }
    // 2. one argument: `--import=<operand>` or `--import <operand>` inside a string / template
    for (const m of text.matchAll(/--import[= ]((?:\$\{[^}]*\}|[^\s'"`$])+)/g)) {
      const operand = m[1];
      const names = [...operand.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((x) => x[1]);
      if (!isUrlish(operand) && !names.some((n) => nameIsUrl(lines, n))) bad.push({ line: i + 1, operand });
    }
  });
  return bad;
}

test('POSITIVE: the reading finds the --import uses that exist', () => {
  const files = fs.readdirSync(HERE).filter((f) => /\.mjs$/.test(f) && f !== SELF);
  const uses = files.filter((f) => fs.readFileSync(path.join(HERE, f), 'utf8').includes('--import'));
  assert.ok(uses.length >= 5, `only ${uses.length} files use --import: the reading sees too little`);
});

test('SABOTAGE: a bare path after --import is named, URLs are not', () => {
  assert.equal(bareImportOperands("spawn(node, ['--import', SPY, MEM]); const SPY = fileURLToPath(new URL('./x.mjs', import.meta.url));").length, 1);
  assert.equal(bareImportOperands("spawn(node, ['--import', path.join(HERE, 'x.mjs'), MEM])").length, 1);
  assert.equal(bareImportOperands('const o = `--import=${file}`;').length, 1);
  assert.equal(bareImportOperands("const SPY = new URL('./x.mjs', import.meta.url).href;\nspawn(node, ['--import', SPY, MEM]);").length, 0);
  assert.equal(bareImportOperands("spawn(node, ['--import', pathToFileURL(file).href, MEM])").length, 0);
  assert.equal(bareImportOperands("const L = `data:text/javascript,${x}`;\nspawn(node, ['--import', L, a]);").length, 0);
  assert.equal(bareImportOperands('const o = `--import=${pathToFileURL(file).href}`;').length, 0);
  assert.equal(bareImportOperands('const U = pathToFileURL(f).href;\nconst o = `--import=${U}?x=1`;').length, 0);
});

test('no test passes a bare path to --import', () => {
  const found = [];
  for (const f of fs.readdirSync(HERE).filter((n) => /\.mjs$/.test(n) && n !== SELF)) {
    for (const b of bareImportOperands(fs.readFileSync(path.join(HERE, f), 'utf8'))) {
      found.push(`test/${f}:${b.line} --import ${b.operand}`);
    }
  }
  assert.deepEqual(found, [], `a path after --import breaks on Windows; use pathToFileURL(...).href:\n${found.join('\n')}`);
});
