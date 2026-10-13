// NEVER-AGAIN ratchet: a red ratchet IS the finding (a regression of a fixed failure class); a second run must not rehabilitate it.
// Failure record 3rmr30wgcgjn.
// Ratchet: no test and no bench starts an endless-loop child without the helper test/fixture/loadchild.mjs.
//
// Finding (2026-10-13, lucky-mem): four `node -e 'let x = 0; while (true) { x += Math.sqrt(x + 1); }'` children of a
// load probe ran for 9.5 days (PPID 1, 2.7 GB each), because only the test's `finally` cleaned up. The helper gives
// the child a hard maximum lifetime and a parent leash.
//
// What the ratchet reports (every .mjs/.cjs/.js under test/ and bench/, except the helper and this ratchet):
//   (1) LITERALS: a string or template literal (source text for another program: `node -e`, a module file that
//       gets written) that contains an unbounded loop. Every finding counts, also one with `break` -- the child is
//       foreign code the ratchet does not evaluate. False alarm? Then the exemption (below) with the reason why
//       the child ends safely.
//   (2) CODE: a bare endless loop in the file's own code (child module files, fixtures) whose body contains none of
//       `break`, `return`, `throw`, `yield`, or an `exit`/`kill`.
// Unbounded means: `while (true|1|2...|!0|!![])`, `for (;;)`, `for (...; true|1; ...)` -- comments inside the
// parentheses do not count. "True by construction" is recognised by form: true, Infinity, a non-zero number, !0,
// !![], !false, !!1, !!true, `1 === 1`, `true === true`; numbers in any form (0x1, 0b1, 0o7, 1.0, 1e3, .5). Polling loops of the probe itself (with return/break/deadline) stay untouched.
//
// Exemption only with a reason: `loadchild-ok: <reason>` in a COMMENT (the marker inside the literal itself does not
// count), on the finding's own line or in the block of stand-alone comment lines directly above it; it covers its own
// statement only (a comment trailing another statement, a blank line or code in between ends its reach). An empty
// reason does not count. The reason names what ends the child safely (heap cap plus deadline, ...).
//
// LIMITS (honest): the ratchet reads source text, it runs nothing. It does NOT see: assembled loops
// (`'wh' + 'ile (true)'`, strings from variables or files, eval), loops in other languages or shell
// (`while true`, `yes >/dev/null`, pipelines without `timeout` in test/*.sh), endlessness without a loop word
// (recursion, `setInterval` with heavy work, workers), `for (init-with-parenthesis; 1;)`, other always-true
// conditions (`x === x`, `!''`, `[] ? 1 : 0`, `1_0`), and loops whose condition only stays true at run time
// (`while (!done)` without an end). Nor does it look outside test/ and bench/.
// In the CODE part (2) the exit search is textual and over-generous: a `break` of an INNER loop or a `return` of a
// NESTED function inside the body counts as an exit of the endless loop, so `while (true) { for (const a of b) { break; } }`
// and `while (true) { const f = () => { return 1; }; }` are NOT reported (documented, not solved: telling the
// loops apart needs a parser). The same goes for an `exit`/`kill` call that sits in a branch never taken.
// Whoever needs load takes the helper -- the ratchet catches the careless raw build, not the intent.
//
// Red proof: the old state of test/atlas-foreign-load.test.mjs (fixed commit acff04e) is reported; plus positive
// controls on sample texts (see below), among them regex literals with quotes, which must not shift the
// assignment of the literals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BEFORE = 'acff04e'; // fixed commit: the state BEFORE the helper (never merge-base)
const K = '(?:\\s|/\\*[\\s\\S]*?\\*/)*'; // whitespace and comments
// A condition that is true by construction (not evaluated, only recognised by form).
const NUMBER = '(?:0[xX]0*[1-9a-fA-F][0-9a-fA-F]*|0[bB]0*1[01]*|0[oO]0*[1-7][0-7]*|[1-9]\\d*(?:\\.\\d*)?(?:[eE][+-]?\\d+)?|0?\\.\\d*[1-9]\\d*|0\\.0*[1-9]\\d*)';
const TRUE_COND = `(?:true|Infinity|${NUMBER}|!0|!!\\[\\]|!false|!!(?:1|true)|1\\s*===?\\s*1|true\\s*===?\\s*true)`;
const WHILE = new RegExp(`\\bwhile${K}\\(${K}${TRUE_COND}${K}\\)`);
const FOR = new RegExp(`\\bfor${K}\\((?:[^;)]|/\\*[\\s\\S]*?\\*/)*;${K}(?:${TRUE_COND})?${K};`);
const EXEMPT = /loadchild-ok:\s*\S/;
const EXITS = /\b(?:break|return|throw|yield)\b|\.exit\(|process\.abort|\.kill\(/;
// The helper builds the child's source text itself; this ratchet names the patterns as text.
const OWN = new Set(['fixture/loadchild.mjs', 'loadchild-ratchet.test.mjs']);

const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'delete', 'throw', 'new', 'yield', 'await']);

const hasLoop = (t) => WHILE.test(t) || FOR.test(t);

/**
 * Splits JS source into literals (line number + content; template expressions `${}` count as code), the comments
 * (line range, text, whether the comment stands alone on its line) and `code`: the source with comments blanked and
 * literals emptied, line count unchanged. Regex literals are recognised
 * (otherwise a `/'/` would shift the assignment of every following literal).
 */
export function splitSource(text) {
  const n = text.length;
  let i = 0;
  let line = 1;
  let code = '';
  let prev = ''; // last token: a word or a single character
  const literals = [];
  const comments = []; // { from, to, text, standalone }: standalone = no code before it on its first line
  const regexAllowed = () => prev === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || REGEX_AFTER.has(prev);
  const stringLit = (q) => {
    const begin = line;
    let content = '';
    i += 1;
    while (i < n && text[i] !== '\n') {
      if (text[i] === '\\') { content += text.slice(i, i + 2); if (text[i + 1] === '\n') { line += 1; code += '\n'; } i += 2; continue; }
      if (text[i] === q) { i += 1; break; }
      content += text[i]; i += 1;
    }
    literals.push({ line: begin, content });
    code += q + q;
  };
  const regex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < n && text[j] !== '\n') {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '[') inClass = true;
      else if (text[j] === ']') inClass = false;
      else if (text[j] === '/' && !inClass) { j += 1; while (/[a-z]/i.test(text[j] ?? '')) j += 1; i = j; code += '/r/'; return true; }
      j += 1;
    }
    return false; // not a regex literal (end of line reached): treat as a division sign
  };
  const template = () => {
    const begin = line;
    let content = '';
    i += 1;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { content += text.slice(i, i + 2); if (text[i + 1] === '\n') line += 1; i += 2; continue; }
      if (c === '`') { i += 1; break; }
      if (c === '$' && text[i + 1] === '{') { i += 2; code += '${'; walk(true); code += '}'; i += 1; continue; }
      if (c === '\n') { line += 1; code += '\n'; }
      content += c; i += 1;
    }
    literals.push({ line: begin, content });
    code += '``';
  };
  const walk = (inExpr) => {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '\n') { line += 1; code += '\n'; i += 1; continue; }
      if (c === '/' && text[i + 1] === '/') {
        const standalone = code.slice(code.lastIndexOf('\n') + 1).trim() === '';
        const from = i;
        while (i < n && text[i] !== '\n') { code += ' '; i += 1; }
        comments.push({ from: line, to: line, text: text.slice(from, i), standalone });
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const standalone = code.slice(code.lastIndexOf('\n') + 1).trim() === '';
        const from = i;
        const first = line;
        code += '  '; i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') { line += 1; code += '\n'; } else code += ' '; i += 1; }
        code += '  '; i += 2;
        comments.push({ from: first, to: line, text: text.slice(from, i), standalone });
        continue;
      }
      if (c === "'" || c === '"') { stringLit(c); prev = '"'; continue; }
      if (c === '`') { template(); prev = '"'; continue; }
      if (c === '/' && regexAllowed() && regex()) { prev = '"'; continue; }
      if (inExpr) {
        if (c === '{') depth += 1;
        else if (c === '}') { if (depth === 0) return; depth -= 1; }
      }
      if (/[\w$]/.test(c)) prev = /[\w$]/.test(text[i - 1] ?? '') && /[\w$]$/.test(prev) ? prev + c : c;
      else if (!/\s/.test(c)) prev = c;
      code += c; i += 1;
    }
  };
  walk(false);
  return { literals, code, comments };
}

/** Body of the loop that starts in `code` at `end` (index behind the loop head); for `for`, first up to the closing parenthesis. */
function body(code, end, isFor) {
  let i = end;
  if (isFor) {
    let depth = 1;
    while (i < code.length && depth > 0) { if (code[i] === '(') depth += 1; else if (code[i] === ')') depth -= 1; i += 1; }
  }
  while (/\s/.test(code[i] ?? '')) i += 1;
  if (code[i] === '{') {
    let depth = 0;
    const from = i;
    for (; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') { depth -= 1; if (depth === 0) return code.slice(from, i + 1); }
    }
    return code.slice(from);
  }
  const until = code.indexOf(';', i);
  return code.slice(i, until < 0 ? code.length : until + 1);
}

/** Body of a do block whose `}` stands right before `pos` (do { ... } while (...)), else null. */
function doBody(code, pos) {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (code[i] !== '}') return null;
  let depth = 0;
  for (let j = i; j >= 0; j -= 1) {
    if (code[j] === '}') depth += 1;
    else if (code[j] === '{') { depth -= 1; if (depth === 0) return /\bdo\s*$/.test(code.slice(0, j)) ? code.slice(j, i + 1) : null; }
  }
  return null;
}

/**
 * Findings ("line: text") in `text`: endless loops in literals (1) and bare endless loops in code (2),
 * without a reasoned exemption.
 */
export function unleashedLoadChildren(text) {
  const lines = text.split('\n');
  const { literals, code, comments } = splitSource(text);
  const found = [];
  // An exemption is a COMMENT (the marker inside a literal does not count) that covers its own statement only:
  // either on the finding's own line, or in a block of stand-alone comment lines directly above it. A comment
  // trailing some other statement, a blank line, or code in between ends the reach.
  const marked = (c) => EXEMPT.test(c.text);
  const standaloneAt = new Map(); // line -> comment text of stand-alone comment lines
  for (const c of comments) if (c.standalone) for (let k = c.from; k <= c.to; k += 1) standaloneAt.set(k, `${standaloneAt.get(k) ?? ''} ${c.text}`);
  const exempt = (z) => {
    if (comments.some((c) => c.from <= z && z <= c.to && marked(c))) return true;
    for (let k = z - 1; standaloneAt.has(k); k -= 1) if (EXEMPT.test(standaloneAt.get(k))) return true;
    return false;
  };
  const report = (z) => {
    if (exempt(z)) return;
    found.push(`${z}: ${(lines[z - 1] ?? '').trim().slice(0, 140)}`);
  };
  for (const l of literals) if (hasLoop(l.content)) report(l.line);
  for (const [re, isFor] of [[new RegExp(WHILE.source, 'g'), false], [new RegExp(FOR.source, 'g'), true]]) {
    for (const m of code.matchAll(re)) {
      const end = m.index + m[0].length;
      let r = body(code, end, isFor);
      if (!isFor && /^\s*;/.test(code.slice(end))) r = doBody(code, m.index) ?? r; // do { ... } while (true);
      if (EXITS.test(r)) continue;
      report(code.slice(0, m.index).split('\n').length);
    }
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

test('real tree: nothing in test/ or bench/ starts an endless-loop child without the helper', () => {
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

const count = (t) => unleashedLoadChildren(t).length;

test('positive control literals: one line, multi-line template, embedding, while (1), comments inside the parentheses', () => {
  assert.equal(count("spawn(process.execPath, ['-e', 'let x = 0; while (true) { x += 1; }']);\n"), 1, 'one line');
  assert.equal(count("const k = `\nlet x = 0;\nfor (;;) { x += 1; }\n`;\n"), 1, 'multi-line template');
  assert.equal(count('fs.writeFileSync(f, "while (1) {}\\n");\n'), 1, 'while (1) in module text');
  assert.equal(count("const a = 'x'; const k = `${a}\nwhile(!0){}`;\n"), 1, 'template with an embedding');
  for (const k of ['while (2) {}', 'while (!![]) {}', 'while (/* ) */ true) {}', 'while (true /* x */) {}',
    'while (!false) {}', 'while (1 === 1) {}', 'while (!!1) {}', 'while (Infinity) {}', 'do {} while (!false);',
    'for (;;) {}', 'for (/* ) */;;) {}', 'for (;true;) {}', 'for (;1;) {}', 'for (;!false;) {}', 'for (let i = 0;; i++) {}',
    'for (let i = 0; 1; i += 1) {}', 'for (let i = 0;; i += 1) {}', 'do {} while (true);',
    'while (0x1) {}', 'while (0b1) {}', 'while (0o7) {}', 'while (1.0) {}', 'while (1e3) {}', 'while (.5) {}', 'while (0.5) {}', 'for (;0x1;) {}']) {
    assert.equal(count(`run('${k}');\n`), 1, `not recognised: ${k}`);
  }
  for (const k of ['for (let i = 0; i < 3; i += 1) {}', 'while (n > 0) {}', 'while (x) {}', 'for (const a of b) {}', 'while (0) {}', 'while (0x0) {}', 'while (0.0) {}', 'while (0e3) {}', 'while (0b0) {}']) {
    assert.equal(count(`run('${k}');\n`), 0, `false alarm: ${k}`);
  }
});

test('positive control assignment: regex literals with quotes do not shift the literals (no slip-through)', () => {
  const after = (before) => `${before}\nconst k = 'while (true) {}';\n`;
  for (const before of ["const r = /'/;", 'const r = /"/.test(a);', "if (/[']/.test(s)) f();", "const r = /\\//; const t = /'x/g;", "x = a / b; y = c / 'd'.length;"]) {
    const f = unleashedLoadChildren(after(before));
    assert.equal(f.length, 1, `slip-through after: ${before} -> ${JSON.stringify(f)}`);
    assert.match(f[0], /^2: /, `wrong line after: ${before} -> ${f[0]}`);
  }
  // Regex detection must bite in both directions (with `if (false)` instead of the regex branch, all three go red):
  assert.equal(count("const r = /`/;\n// loadchild-ok: x\nrun('for(;;){}');\n"), 0, 'regex with a backtick, then an exempted literal');
  assert.equal(count("const r = /`/;\nfor(;;){ if (a) break; }\n"), 0, 'regex with a backtick, then a loop with an exit');
  assert.equal(count("const r = /'/.test(a) && b('while (true) { break; }');\n"), 1, 'regex with a quote, then a literal on the same line');
  // the case that slipped through before: a regex with a backtick opened a template up to the end of the file
  assert.equal(count("const r = /`/;\nrun('for (;;) {}');\n"), 1, 'regex with a backtick');
});

test('positive control comments, probe code, exemption, and the false-alarm case', () => {
  assert.equal(count('// "while (true)" in a comment\n/* \'for (;;)\' */\nconst x = 1;\n'), 0, 'comment');
  assert.equal(count("async function f() {\n  for (;;) {\n    if (await ok()) return;\n  }\n}\nwhile (true) { if (x) break; }\n"), 0, 'loops in probe code with an exit');
  assert.equal(count("// loadchild-ok: heap cap 100 MiB and the phase deadline of 30 s end it\nrun('for(;;) a.push(1)');\n"), 0, 'reasoned exemption before');
  assert.equal(count("run('for(;;) a.push(1)'); // loadchild-ok:\n"), 1, 'an empty reason does not count');
  assert.equal(count("run('for(;;) a.push(1)');\n"), 1, 'no exemption');
  // The exemption is a comment, and it covers its own statement only.
  assert.equal(count("run('for(;;) a.push(1) // loadchild-ok: written inside the literal');\n"), 1, 'the marker inside the literal does not count');
  assert.equal(count("run('for(;;) a.push(1)'); // loadchild-ok: trailing comment on the finding's own line\n"), 0, 'trailing comment on the own line');
  assert.equal(count("other(); // loadchild-ok: this belongs to the other statement\nrun('for(;;) a.push(1)');\n"), 1, 'a comment trailing another statement does not reach');
  assert.equal(count("// loadchild-ok: ends after 5 s\n\nrun('for(;;) a.push(1)');\n"), 1, 'a blank line ends the reach');
  assert.equal(count("// loadchild-ok: ends after 5 s\nother();\nrun('for(;;) a.push(1)');\n"), 1, 'code in between ends the reach');
  assert.equal(count("// loadchild-ok: ends after 5 s because\n// the heap cap hits first\nrun('for(;;) a.push(1)');\n"), 0, 'a multi-line reason block above');
  assert.equal(count("/* loadchild-ok: ends after 5 s */\nrun('for(;;) a.push(1)');\n"), 0, 'a block comment above');
  assert.equal(count("// loadchild-ok: ends after 5 s\nrun('for(;;) a.push(1)'); run('while (true) {}');\n"), 0, 'one line, one reason');
  // False alarm: a child that ends itself is reported all the same (the ratchet does not evaluate foreign code) ...
  const safe = "run('for (;;) { if (Date.now() > end) process.exit(0); }');\n";
  assert.equal(count(safe), 1, 'false-alarm case: a literal with its own exit is reported');
  // ... and with a reasoned exemption there is peace.
  assert.equal(count(`// loadchild-ok: ends by itself after 5 s (Date.now() deadline in the child)\n${safe}`), 0, 'false alarm with exemption');
});

test('documented limit: a break of an inner loop or a return of a nested function counts as an exit (not reported)', () => {
  assert.equal(count('while (true) { for (const a of b) { break; } }\n'), 0);
  assert.equal(count('while (true) { const f = () => { return 1; }; }\n'), 0);
});

test('positive control code: a bare endless loop in code (child module file) is reported, one with an exit is not', () => {
  assert.equal(count('let x = 0;\nwhile (true) { x += 1; }\n'), 1, 'while (true) without an exit');
  assert.equal(count('for (;;) work();\n'), 1, 'for (;;) without braces');
  assert.equal(count('do { x += 1; } while (true);\n'), 1, 'do-while without an exit');
  assert.equal(count('do { if (a) break; } while (true);\n'), 0, 'do-while with break');
  assert.equal(count('while (true) {\n  if (x) { process.exit(0); }\n}\n'), 0, 'process.exit in the body');
  assert.equal(count('while (true) {\n  const x = await next();\n  if (!x) return;\n}\n'), 0, 'return in the body');
  assert.equal(count('while (true) { x += 1; } // loadchild-ok: the driver ends the child with SIGKILL\n'), 0, 'exemption at the end of the line');
  assert.equal(count("const s = 'while (true) { x }';\nfor (let i = 0; i < 2; i += 1) {}\n"), 1, 'only the literal, not the counting loop');
});
