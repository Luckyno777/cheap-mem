// F5 / suggestion list item 8: report unused exports -- as a probe of our
// own, no knip and no eslint plugin (no new dependency).
//
// **Rule.** A name that `src/*.mjs` exports via `export function|const|let|
// class` must occur as a WORD in at least ONE OTHER tracked file (.mjs, .js,
// .sh, extensionless files in bin/ -- tests and bench count). An occurrence
// inside a string counts too (dynamic access `module[name]`): the probe
// prefers saying too little to saying too much.
//
// **What it does NOT say.** An export used only inside its own file is not
// dead code, just an export too many (a surface someone has to maintain).
// And a name match in a foreign file counts as "used" (names are not
// symbols; there is no tsc here).
//
// **Eslint.** The CI step `lint` (`npm run lint`, .github/workflows/ci.yml)
// does run, and `eslint.config.mjs` sets `no-unused-vars: error` -- that
// covers unused variables, imports and parameters INSIDE a file. It cannot
// see an export nobody imports; this probe covers that.
//
// **Old stock with a cap.** Per file, the number of unused exports
// (test/f5-unused-exports.json, state 2026-10-01: 230 in 80 files). No more;
// fewer is good (lower the cap). A new file: cap 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './f5-source.mjs';

const CAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'f5-unused-exports.json'), 'utf8'));
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/** Names a text exports via `export ...`. */
export function exportsOf(text) {
  return [...text.matchAll(EXPORT)].map((m) => m[1]);
}

/** {file: [name]} of the exports that occur in no other file. */
export function unused(texts, sources) {
  const words = new Map();
  for (const [f, t] of texts) words.set(f, new Set(t.match(/[\w$]+/g) ?? []));
  const out = {};
  for (const f of sources) {
    for (const n of exportsOf(texts.get(f))) {
      let used = false;
      for (const [g, w] of words) if (g !== f && w.has(n)) { used = true; break; }
      if (!used) (out[f] ??= []).push(n);
    }
  }
  return out;
}

function load() {
  const all = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter((f) => /\.(mjs|js|sh)$/.test(f) || /^bin\/[^.]+$/.test(f));
  const texts = new Map(all.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
  return { texts, sources: all.filter((f) => /^src\/.*\.mjs$/.test(f)) };
}

test('positive control: an export without a second user is reported, a used one is not', () => {
  const texts = new Map([
    ['src/a.mjs', 'export function used() {}\nexport const orphan = 1;\nexport class Also {}\n'],
    ['src/b.mjs', "import { used } from './a.mjs';\nused();\n"],
    ['test/c.test.mjs', "mod['Also']\n"],
  ]);
  assert.deepEqual(unused(texts, ['src/a.mjs']), { 'src/a.mjs': ['orphan'] });
  assert.deepEqual(exportsOf('export async function f() {}\nexport let x;\nconst y = 1;\n// export const z = 1;'), ['f', 'x']);
});

test('unused exports do not grow (old stock capped per file)', () => {
  const { texts, sources } = load();
  assert.ok(sources.length > 80, `read only ${sources.length} source files -- not measurable`);
  const u = unused(texts, sources);
  const tooMany = []; const tooHigh = [];
  for (const [f, names] of Object.entries(u)) {
    const cap = CAP[f] ?? 0;
    if (names.length > cap) tooMany.push(`${f}: ${names.length} unused exports, cap ${cap}: ${names.join(', ')}`);
  }
  for (const [f, c] of Object.entries(CAP)) if ((u[f]?.length ?? 0) < c) tooHigh.push(`${f}: only ${u[f]?.length ?? 0} left, lower the cap from ${c}`);
  assert.deepEqual(tooMany, [], `export without a second user: drop the export or use it:\n${tooMany.join('\n')}`);
  assert.deepEqual(tooHigh, [], `cap too high:\n${tooHigh.join('\n')}`);
});
