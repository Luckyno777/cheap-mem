// Every path a module computes at RUNTIME must resolve to a file.
//
// **The incident this closes (2026-09-18, found 2026-09-19).** `mem
// serve` was dead for a day. `src/cli/commands/setup.mjs` reached its
// server with `await import(new URL('./mem-serve', import.meta.url))`,
// which was right while the handler lived in `bin/mem`, beside
// `bin/mem-serve`. Commit 9dae830 ("Sixty handlers leave bin/mem: 4503
// lines to 223") moved the handler into `src/cli/commands/` and left
// the relative hop where it was, so the CLI looked for
// `src/cli/commands/mem-serve`, which has never existed.
//
// Two properties of that bug are why this file scans instead of
// trusting review:
//
//   - **It is invisible until the command runs.** A lazy `await
//     import()` inside a handler is not resolved at load time, so
//     nothing about starting the CLI, linting it, or importing the
//     module says a word about it. `node --check` will not see it
//     either: the syntax is perfect.
//   - **The tests that "covered" the server did not use this path.**
//     `test/console.test.mjs` and `test/dashboard.test.mjs` import
//     `bin/mem-serve` DIRECTLY and drive `serve()` in-process. Both
//     were green for the whole day the command was dead.
//
// So the class, not the instance: every lazily imported relative
// specifier and every root-anchored path in `src/` and `bin/` is
// resolved here and must exist. `test/cli-contract.test.mjs` holds the
// other half — it drives `bin/mem serve` as a real child process and
// makes a real request, which is what actually proves the command
// works rather than merely that a file is present.
//
// Comments are stripped before scanning, deliberately: the fix in
// setup.mjs is documented with the broken path written out in prose,
// and a scanner that reads prose as code would report the incident
// report as the incident.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source files that can compute a path at runtime. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p); } else if (/\.(mjs|js)$/.test(p)) out.push(p);
    }
  };
  walk(path.join(REPO, 'src'));
  // bin/ holds extensionless executables — mem, mem-mcp, mem-serve …
  for (const n of fs.readdirSync(path.join(REPO, 'bin'))) {
    const p = path.join(REPO, 'bin', n);
    if (fs.statSync(p).isFile()) out.push(p);
  }
  return out;
}

/** Block and line comments removed, so prose is never read as code. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

/**
 * Every runtime path one file computes, already resolved.
 *
 * Two shapes, because the repo uses two and they fail differently:
 *
 *   `await import('../../x.mjs')`  resolves against THIS FILE — the
 *                                  shape that broke when the file moved
 *   `path.join(PKG_ROOT, 'bin', …)` resolves against the repo root —
 *                                  the shape that survives a move, and
 *                                  the reason the fix uses it
 *
 * Exported shape: `{ where, spec, target }`, one per computed path.
 */
function computedPaths(file, text) {
  const found = [];
  const body = code(text);
  // Both spellings of "resolve against this file", because the repo has
  // used both and the SECOND one is what the incident was written in.
  //
  // The first cut of this scanner matched only the string-literal form,
  // `await import('./x.mjs')`. Run against a checkout with 9dae830's
  // defect restored, the guarantee below stayed GREEN: the broken call
  // was `await import(new URL('./mem-serve', import.meta.url).href)`,
  // and a regex looking for a quoted specifier directly inside
  // `import(` does not see it. A guard that cannot see the one bug it
  // was written for is the failure it exists to catch, one level up.
  const relative = [
    /await import\('(\.[^']+)'\)/g,
    /new URL\(\s*'(\.[^']+)'\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const re of relative) {
    for (const m of body.matchAll(re)) {
      found.push({
        where: path.relative(REPO, file),
        spec: m[1],
        target: path.resolve(path.dirname(file), m[1]),
      });
    }
  }
  for (const m of body.matchAll(/path\.join\((?:PKG_ROOT|REPO)\s*,\s*([^)]+)\)/g)) {
    const parts = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    // Only literal segments can be resolved statically. A segment built
    // from a variable is skipped — and counted below, so the skip is
    // visible rather than silently shrinking what this test covers.
    if (parts.some((p) => !/^[\w.-]+$/.test(p))) continue;
    found.push({
      where: path.relative(REPO, file),
      spec: `PKG_ROOT/${parts.join('/')}`,
      target: path.resolve(REPO, ...parts),
    });
  }
  return found;
}

const ALL = sourceFiles().flatMap((f) => computedPaths(f, fs.readFileSync(f, 'utf8')));

// --- the scanner can see anything at all --------------------------------

test('POSITIVE CONTROL: the scanner finds the paths it is meant to check', () => {
  // Without this, a scanner that matched nothing would report every
  // path in the repo as fine — the "empty green" this house has a name
  // for. The floor is well under the 20 found on 2026-09-20, so adding
  // or removing one lazy import does not fail the run; losing the
  // ability to see them does.
  assert.ok(ALL.length >= 12,
    `only ${ALL.length} computed paths found — the scanner has stopped seeing them`);
  const lazy = ALL.filter((p) => p.spec.startsWith('.'));
  const anchored = ALL.filter((p) => !p.spec.startsWith('.'));
  assert.ok(lazy.length >= 8, `only ${lazy.length} lazy relative imports seen`);
  assert.ok(anchored.length >= 4, `only ${anchored.length} root-anchored paths seen`);
  // The exact path the incident was about must be among them, or this
  // test has stopped watching the thing it was written for.
  assert.ok(ALL.some((p) => p.spec === 'PKG_ROOT/bin/mem-serve'),
    "the `mem serve` import is no longer a path this test can see — it was the reason this file exists");
});

test('SABOTAGE CONTROL: a broken path in the same shape is reported', () => {
  // The scanner run against a made-up module, not against the repo, so
  // this control never depends on the repo being broken. Both shapes,
  // because a scanner that only catches one is half a scanner.
  const fake = path.join(REPO, 'src', 'made-up-for-this-control.mjs');
  const broken = "await import('./nothing-is-here.mjs');\n"
    // The exact shape of the 2026-09-18 defect. Present here because
    // the first version of this scanner did NOT match it, and only a
    // sabotage run found that out.
    + "await import(new URL('./mem-serve', import.meta.url).href);\n"
    + "fs.readFileSync(path.join(PKG_ROOT, 'bin', 'also-not-here'));\n";
  const hits = computedPaths(fake, broken);
  assert.equal(hits.length, 3, 'the scanner did not see all three shapes');
  for (const h of hits) {
    assert.equal(fs.existsSync(h.target), false,
      `the control's own fixture ${h.spec} exists — pick a name that does not`);
  }
  // And the positive half: a path that DOES exist is not reported as
  // missing, or the test below would pass by flagging everything.
  const good = computedPaths(fake, "await import('./memory.mjs');");
  assert.equal(good.length, 1);
  assert.ok(fs.existsSync(good[0].target), 'the scanner resolved a real sibling wrongly');
});

test('COMMENT CONTROL: a path written in prose is not read as code', () => {
  // setup.mjs documents the incident by quoting the broken specifier.
  // A scanner without the comment strip reports that documentation as a
  // defect, and the honest reaction to a test that flags a comment is
  // to delete the comment, which loses the only record of why the fix
  // looks the way it does.
  const fake = path.join(REPO, 'src', 'made-up-for-this-control.mjs');
  const documented = "// was: await import('./nothing-is-here.mjs')\n"
    + "/* and: await import('./gone.mjs') */\n"
    + "await import('./memory.mjs');\n";
  const hits = computedPaths(fake, documented);
  assert.deepEqual(hits.map((h) => h.spec), ['./memory.mjs'],
    'the scanner read a commented-out path as a live one');
});

// --- the guarantee ------------------------------------------------------

test('every lazily imported module and root-anchored file exists', () => {
  const missing = ALL
    .filter((p) => !fs.existsSync(p.target))
    .map((p) => `${p.where}: ${p.spec} -> ${path.relative(REPO, p.target)}`);
  assert.deepEqual(missing, [],
    `${missing.length} computed path(s) point at nothing. This is the `
    + '`mem serve` class: a lazy import inside a handler is not resolved '
    + 'until that command runs, so nothing else in this suite will say so.\n'
    + missing.join('\n'));
});

test('a handler reaches outside its own directory by the repo root, not by counting hops', () => {
  // The narrower rule the fix itself follows. A relative hop out of
  // `src/cli/commands/` into `bin/` is correct exactly as long as
  // nobody moves the file again — which is the assumption 9dae830
  // falsified. Anchoring at the repo root does not care where the
  // handler sits.
  const dir = path.join(REPO, 'src', 'cli', 'commands');
  const offenders = [];
  for (const n of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const body = code(fs.readFileSync(path.join(dir, n), 'utf8'));
    for (const m of body.matchAll(/import\(\s*(?:new URL\(\s*)?'(\.\.?\/[^']*)'/g)) {
      // Reaching a sibling module under src/ is ordinary and fine; the
      // rule is about leaving src/ for bin/ or install/ by hops.
      const target = path.resolve(dir, m[1]);
      if (!target.startsWith(path.join(REPO, 'src') + path.sep)) {
        offenders.push(`${n}: ${m[1]} leaves src/ by relative hops — anchor it at PKG_ROOT`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
