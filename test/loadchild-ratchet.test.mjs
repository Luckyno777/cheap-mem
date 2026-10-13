// NEVER-AGAIN ratchet: a red ratchet IS the finding (a regression of a fixed failure class); a second run must not rehabilitate it.
// Failure record 3rmr30wgcgjn.
// Ratchet: no test and no bench starts an endless-loop child without the helper test/fixture/loadchild.mjs.
//
// Finding (2026-10-13, lucky-mem): four `node -e 'let x = 0; while (true) { x += Math.sqrt(x + 1); }'` children of a
// load probe ran for 9.5 days (PPID 1, 2.7 GB each), because only the test's `finally` cleaned up. The helper gives
// the child a hard maximum lifetime and a parent leash.
//
// What counts as a "load child": a STRING or template literal in test/ or bench/ (source text for another process:
// `node -e`, a module file that gets written) that contains an unbounded loop: `while (true)`, `while (1)`,
// `while (!0)`, `for (;;)`. Loops in the probe's own code (polling loops with return/break/deadline) are not
// literals and stay untouched.
//
// An exemption only with a reason: `loadchild-ok: <reason>` on the literal's line or on one of the two lines
// before it; an empty reason does not count. A reason says what safely ends the child (heap cap plus time cap,
// its own deadline, ...).
//
// Red proof: the old state of test/atlas-foreign-load.test.mjs (fixed commit acff04e) is reported; plus positive
// controls on sample texts (one-line literal, multi-line template, comment, exemption).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BEFORE = 'acff04e'; // fixed commit: the state BEFORE the helper (never merge-base)
const LOOP = /while\s*\(\s*(true|1|!0)\s*\)|for\s*\(\s*;\s*;\s*\)/;
const EXEMPT = /loadchild-ok:\s*\S/;
// The helper builds the child's source text itself; this ratchet names the patterns as text.
const OWN = new Set(['fixture/loadchild.mjs', 'loadchild-ratchet.test.mjs']);

/**
 * Line numbers (1-based) of the literals in `text` that contain an unbounded loop and carry no exemption.
 * A small character reader: comments are skipped, ' " ` and ${ } are honoured.
 */
export function unleashedLoadChildren(text) {
  const lines = text.split('\n');
  const found = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  const literal = (quote) => {
    const start = line;
    let content = '';
    i += 1;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { content += text.slice(i, i + 2); if (text[i + 1] === '\n') line += 1; i += 2; continue; }
      if (c === '\n') { line += 1; if (quote !== '`') break; }
      if (c === quote) { i += 1; break; }
      if (quote === '`' && c === '$' && text[i + 1] === '{') { // embedded expression: skip to the matching brace
        let depth = 0;
        while (i < n) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } } else if (text[i] === '\n') line += 1;
          i += 1;
        }
        continue;
      }
      content += c; i += 1;
    }
    if (LOOP.test(content)) {
      const exempt = [start, start - 1, start - 2].some((l) => EXEMPT.test(lines[l - 1] ?? ''));
      if (!exempt) found.push(`${start}: ${(lines[start - 1] ?? '').trim().slice(0, 140)}`);
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line += 1; i += 1; } else if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line += 1; i += 1; }
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') literal(c);
    else i += 1;
  }
  return found;
}

function sourceFiles(root, sub) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(root, sub));
  return out;
}

test('real tree: no literal in test/ or bench/ starts an endless-loop child without the helper', () => {
  const bad = [];
  for (const sub of ['test', 'bench']) {
    for (const f of sourceFiles(ROOT, sub)) {
      const rel = path.relative(path.join(ROOT, sub), f).split(path.sep).join('/');
      if (sub === 'test' && OWN.has(rel)) continue;
      const r = unleashedLoadChildren(fs.readFileSync(f, 'utf8'));
      if (r.length) bad.push(`${sub}/${rel}\n  ${r.join('\n  ')}`);
    }
  }
  assert.deepEqual(bad, [],
    'load children come from test/fixture/loadchild.mjs (startLoadChildren / loadChildSource: maximum lifetime + parent leash); '
    + 'or `loadchild-ok: <reason>` on the line or before it');
});

test('red proof: the old state of test/atlas-foreign-load.test.mjs is reported (the ratchet bites)', (t) => {
  let old;
  try {
    old = execFileSync('git', ['show', `${BEFORE}:test/atlas-foreign-load.test.mjs`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { t.skip(`commit ${BEFORE} not in this clone (shallow?)`); return; }
  const r = unleashedLoadChildren(old);
  assert.equal(r.length, 1, `expected exactly the raw while(true) eater, found: ${JSON.stringify(r)}`);
  assert.match(r[0], /Math\.sqrt/);
});

test('positive controls on sample texts: literals are reported; comments, probe code and a reasoned exemption are not', () => {
  const raw = "spawn(process.execPath, ['-e', 'let x = 0; while (true) { x += 1; }']);\n";
  assert.equal(unleashedLoadChildren(raw).length, 1, 'one-line literal');
  assert.equal(unleashedLoadChildren("const k = `\nlet x = 0;\nfor (;;) { x += 1; }\n`;\n").length, 1, 'multi-line template');
  assert.equal(unleashedLoadChildren('fs.writeFileSync(f, "while (1) {}\\n");\n').length, 1, 'while (1) in module text');
  assert.equal(unleashedLoadChildren("const a = 'x'; const k = `${a}\nwhile(!0){}`;\n").length, 1, 'template with an embedded expression');
  assert.equal(unleashedLoadChildren('// "while (true)" in a comment\n/* \'for (;;)\' */\nconst x = 1;\n').length, 0, 'comment');
  assert.equal(unleashedLoadChildren('async function f() {\n  for (;;) {\n    if (await ok()) return;\n  }\n}\nwhile (true) { if (x) break; }\n').length, 0, 'loops in probe code');
  assert.equal(unleashedLoadChildren("// loadchild-ok: heap cap 100 MiB and the phase deadline of 30 s end it\nrun('for(;;) a.push(1)');\n").length, 0, 'reasoned exemption before');
  assert.equal(unleashedLoadChildren("run('for(;;) a.push(1)'); // loadchild-ok:\n").length, 1, 'an empty reason does not count');
  assert.equal(unleashedLoadChildren("run('for(;;) a.push(1)');\n").length, 1, 'no exemption');
});
