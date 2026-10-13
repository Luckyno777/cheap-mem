// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/helpers/mask-cut-scan.mjs - find the places that CUT text without masking it first.
// Used by test/mask-before-cut-ratchet.test.mjs (see the header there for the why).
//
// A real parse (acorn, a dev dependency of eslint), not a line regex. A cut is `x.slice(a, b)`, `x.substring(..)`,
// `x.substr(..)` or a tail cut `x.slice(-n)`. It is GUARDED when one of these holds:
//   1. the receiver expression itself calls a mask (`maskText(s).replace(..).slice(0, n)`),
//   2. the receiver is a variable that is DECLARED or ASSIGNED, in the same function, from an expression that calls a
//      mask (`const t = maskText(x).trim(); ... t.slice(0, n)`; one such assignment is enough),
//   3. the receiver is plainly not entry text: a date or hash (`ts`, `id`, `hash`, `commit` ...), or an ARRAY cut
//      (`list.slice(0, 8).map(..)`, `for (const x of list.slice(0, n))`, a spread),
//   4. a comment `mask-ok: <reason>` stands on the line of the cut or in the four lines above it.
// Per FUNCTION, not per line: the mask may stand many lines above the cut, but it must be what the cut cuts. A mask
// call elsewhere in the same big function does not excuse the cut (the stderr tail of tasks.mjs lives in a function
// that masks its stdout).
import { loadAcorn } from './late-top-level-await.mjs';

const CUT_METHODS = new Set(['slice', 'substring', 'substr']);
const MASK_FNS = new Set(['maskText', 'cutMasked', 'windowMasked', 'maskEntry', 'maskOutput', 'sanitizeForDisplay', 'redactExcerpt',
  'redactEntry', 'redactObject', 'redact', 'redactText', 'redactLine', 'clean']);
const BENIGN = /\b(?:ts|id|ids|hash|sha|sha1|sha256|commit|day|date|iso|tags|files|lines|sources|patterns|claims|hits|rows|items|list|top|names|parts|words|tokens|stems|projects|entries|keys|args|rest|argv|tree|stamp|session|key|candidates|kept|sorted|scored|eligible|present|themesSorted|ordered|history|orphans|newest|themes|edges|shown|recent|pairCount|toISOString|digest|last|word)\b/;
const ARRAY_METHODS = new Set(['map', 'join', 'filter', 'forEach', 'reduce', 'some', 'every', 'flatMap', 'find', 'sort', 'entries', 'concat', 'includes', 'length']);

function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, node, visit));
    else if (v && typeof v.type === 'string') walk(v, node, visit);
  }
}
const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

/** Does the subtree call one of the mask functions (by plain name or as a member, `outputguard.maskText`)? */
function callsMask(node) {
  let hit = false;
  walk(node, null, (n) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && c.property.type === 'Identifier' ? c.property.name : null);
    if (name && MASK_FNS.has(name)) hit = true;
  });
  return hit;
}

/** Cuts in `source`: [{ node, call, parents }] with the chain of enclosing nodes. */
function findCuts(program) {
  const found = [];
  const stack = [];
  const visit = (n, parent) => {
    while (stack.length && stack[stack.length - 1].n !== parent) stack.pop();
    stack.push({ n });
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return;
    const m = n.callee.property.name;
    if (!CUT_METHODS.has(m)) return;
    const a = n.arguments;
    const firstNeg = a[0] && ((a[0].type === 'UnaryExpression' && a[0].operator === '-') || (a[0].type === 'Literal' && typeof a[0].value === 'number' && a[0].value < 0));
    if (!(a.length >= 2 || (a.length === 1 && firstNeg))) return;
    found.push({ call: n, chain: stack.map((s) => s.n).slice(0, -1).reverse() });
  };
  walk(program, null, visit);
  return found;
}

const ARRAYISH_PARENT = (call, parent) => (parent
  && ((parent.type === 'MemberExpression' && parent.object === call && ARRAY_METHODS.has(parent.property.name))
    || (parent.type === 'ForOfStatement' && parent.right === call)
    || parent.type === 'SpreadElement'));

/** Names assigned or declared inside `fn` from an expression that calls a mask. */
function maskedNames(fn) {
  const names = new Set();
  walk(fn, null, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && callsMask(n.init)) names.add(n.id.name);
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && callsMask(n.right)) names.add(n.left.name);
  });
  return names;
}

/** Is the receiver the result of an array method (`.sort(..)`, `.filter(..)` ...)? Strings have none of those. */
function arrayChain(recv) {
  let n = recv;
  while (n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression') {
    if (['sort', 'filter', 'map', 'flatMap', 'concat', 'reverse', 'entries', 'values'].includes(n.callee.property.name)) return true;
    n = n.callee.object;
  }
  return false;
}

/** Lines of `source` that cut text without a mask or an exception; `{ line, text }`. */
export function unguardedCuts(source, { rule = 1 } = {}) {
  if (rule === 2) return inlineCuts(source);
  const acorn = loadAcorn();
  const program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  const lines = source.split('\n');
  const found = [];
  for (const { call, chain } of findCuts(program)) {
    const line = call.loc.start.line;
    const text = lines[line - 1].trim().slice(0, 140);
    const nearby = lines.slice(Math.max(0, line - 5), line).join('\n');
    if (/mask-ok:/.test(nearby)) continue;
    const recv = call.callee.object;
    const recvText = source.slice(recv.start, recv.end);
    if (callsMask(recv)) continue;                                   // 1. the receiver masks itself
    if (BENIGN.test(recvText)) continue;                             // 3. a date, a hash, a list
    if (ARRAYISH_PARENT(call, chain[0])) continue;                   // 3. an array cut
    if (recv.type === 'ArrayExpression') continue;
    if (arrayChain(recv)) continue;                                  // `x.filter(..).sort(..).slice(0, n)`
    const fn = chain.find(isFn) ?? program;
    if (recv.type === 'Identifier' && maskedNames(fn).has(recv.name)) continue;   // 2. a variable made from a mask
    // a receiver that is a chain of string methods on such a variable: `t.trim().slice(0, n)`
    let base = recv;
    while (base.type === 'CallExpression' && base.callee.type === 'MemberExpression') base = base.callee.object;
    if (base.type === 'Identifier' && maskedNames(fn).has(base.name)) continue;
    found.push({ line, text });
  }
  return found;
}

// Rule 2: an entry field cut inline, anywhere (a line regex: cheap, and it needs no parse of files outside the list).
const CUT_LINE = /\.(?:slice\(\s*(?:0\s*,|-\s*\d)|substring\(\s*0\s*,)/;
const INLINE = /\b(?:e|e0|entry|h|x|q|m|c|p|l|r|it|d|a|o|res|msg)\.(?:title|text|body|why|question|subject|reason|choice|learning|rule|fact|value|remedy|note)\b[^;\n]*\.(?:slice\(\s*(?:0\s*,|-\s*\d)|substring\(\s*0\s*,)/;
const GUARD_LINE = /\b(?:maskText|cutMasked|windowMasked|maskEntry|maskOutput|sanitizeForDisplay|redact)\b|mask-ok:/;
function inlineCuts(source) {
  const lines = source.split('\n');
  const found = [];
  lines.forEach((l, i) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(l)) return;
    const code = l.replace(/\/\/.*$/, (m) => (m.includes('mask-ok:') ? m : ''));
    if (!CUT_LINE.test(code) || !INLINE.test(code)) return;
    const near = [lines[i - 2] ?? '', lines[i - 1] ?? '', l].join('\n');
    const block = [lines[i - 4] ?? '', lines[i - 3] ?? '', near].join('\n');
    if (GUARD_LINE.test(near) || /mask-ok:/.test(block)) return;
    found.push({ line: i + 1, text: l.trim().slice(0, 140) });
  });
  return found;
}
