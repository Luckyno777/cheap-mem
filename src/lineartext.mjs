// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// @ts-check
// lineartext.mjs — small text helpers that cost time LINEAR in the input.
//
// **Why this file exists (2026-10-16).** A pattern that ends in a run and `$` (`/\s+$/`, `/\n*$/`, `/ +$/`) is quadratic on
// text that is mostly one such run: the engine starts a match at every character of the run, scans to the end of the run,
// fails at the `$` (the last character is not part of the run) and starts again one character later. 100,000 blanks, hyphens
// or line breaks plus one `x` took 3.7 to 4.3 s PER pattern; 1 MB takes minutes. Text that reaches these places comes from
// other sessions (inbox mail), from a cloned repository (`.gitattributes`, `.gitignore`) or from a model (job fields).
// `String.prototype.trimEnd` removes exactly the characters `\s` matches, so most places need nothing but that; the helpers
// here cover the rest. Each is checked against the pattern it replaces by test/linear-trim-golden.test.mjs.

/**
 * `text` without its trailing line feeds. Same result as `.replace(/\n*$/, '')`, one pass from the end.
 * @param {string} text
 * @returns {string}
 */
export function trimEndNewlines(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

/**
 * Does any line, with the white space at both ends cut off, match `re`? A line ends at `\n`, `\r`, `\r\n`, U+2028 or U+2029,
 * the way a multiline `^` and `$` see it. Blank lines are not tested.
 *
 * Replaces `/^\s*RULE\s*$/m.test(text)`. That form restarts at EVERY line start and lets `\s*` run over all the blank lines
 * that follow, so a file of nothing but line breaks is quadratic. Here the blanks are cut by `trim` (the same set as `\s`)
 * and `re` is written WITHOUT the outer `^\s*` / `\s*$`, anchored with plain `^` and `$`. One difference, on purpose: the old
 * form let a rule's inner `\s+` run across a line break (`*.jsonl` on one line, `merge=union` on the next read as one rule);
 * a rule is one line.
 * @param {string} text
 * @param {RegExp} re  without the `g` and `y` flags
 * @returns {boolean}
 */
export function anyTrimmedLine(text, re) {
  const s = String(text ?? '');
  let start = 0;
  for (let i = 0; i <= s.length; i += 1) {
    const c = i < s.length ? s.charCodeAt(i) : 10;
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) {
      if (i > start && re.test(s.slice(start, i).trim())) return true;
      start = i + 1;
    }
  }
  return false;
}
