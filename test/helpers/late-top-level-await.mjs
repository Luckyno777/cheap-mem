// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/helpers/late-top-level-await.mjs - find a top-level `await` that sits AFTER the first
// test()/describe() of a test file. Used by test/no-top-level-await-after-test.test.mjs.
//
// Why it matters: when a top-level await throws (a browser or server that fails to start under
// load), the whole file fails with the anonymous "test failed" and no named probe says what broke.
// The start belongs in before()/after() (a named red probe with the error text) or in a lazy factory.
//
// A real parse (acorn, a dev dependency of eslint), not a regex: comments, strings, template text
// and the bodies of functions are not top level, so they never count.
import { createRequire } from 'node:module';

const TEST_NAMES = new Set(['test', 'describe', 'it', 'suite']);

/** Names under which `node:test` is imported in this program (default, test, describe, it, suite). */
function testNames(program) {
  const names = new Set(TEST_NAMES);
  for (const n of program.body) {
    if (n.type !== 'ImportDeclaration' || !/^(node:)?test$/.test(String(n.source.value))) continue;
    for (const s of n.specifiers) {
      if (s.type === 'ImportDefaultSpecifier') names.add(s.local.name);
      else if (s.type === 'ImportSpecifier' && TEST_NAMES.has(s.imported.name ?? s.imported.value)) names.add(s.local.name);
    }
  }
  return names;
}

function isFunction(node) {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

/** Walk `node` without entering functions; call `visit` on each node. */
function walkTop(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  if (isFunction(node)) return;           // a function body is not the module's top level
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walkTop(c, visit));
    else if (v && typeof v.type === 'string') walkTop(v, visit);
  }
}

/** Root identifier of a callee: `test`, `test.skip`, `describe.only`, `test.skip.foo` all give the first name. */
function calleeRoot(callee) {
  let c = callee;
  while (c && c.type === 'MemberExpression') c = c.object;
  return c && c.type === 'Identifier' ? c.name : null;
}

/**
 * The top-level awaits (`await x`, `for await`) that come after the first top-level
 * test()/describe() call of `source`. Returns [{ line, text }]; [] for a clean file.
 * Throws on a syntax error (the caller names the file).
 */
export function findLateTopLevelAwait(source, acorn) {
  const program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  const names = testNames(program);
  const lines = source.split('\n');
  let firstTestEnd = -1;
  for (const stmt of program.body) {
    let isTest = false;
    walkTop(stmt, (n) => {
      if (n.type === 'CallExpression' && names.has(calleeRoot(n.callee))) isTest = true;
    });
    if (isTest) { firstTestEnd = stmt.end; break; }
  }
  if (firstTestEnd < 0) return [];        // no test at top level: nothing "after" it
  const found = [];
  for (const stmt of program.body) {
    walkTop(stmt, (n) => {
      const late = n.start >= firstTestEnd;
      if (late && (n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await))) {
        found.push({ line: n.loc.start.line, text: (lines[n.loc.start.line - 1] ?? '').trim() });
      }
    });
  }
  return found;
}

/** Load acorn from the project's dev dependencies (eslint brings it). */
export function loadAcorn() {
  return createRequire(import.meta.url)('acorn');
}
