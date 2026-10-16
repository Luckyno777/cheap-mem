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

/** git reads an attribute name as letters, digits, `-`, `_` and `.`, and not with a `-` in front. */
const ATTRIBUTE_NAME = /^[A-Za-z0-9_.][-A-Za-z0-9_.]*$/;
/** The blanks git's own reader knows in a `.gitattributes` line: space, tab, carriage return (a line ends at `\n` only). */
const GIT_BLANKS = /[ \t\r]+/;

/** `text` without the blanks of GIT_BLANKS at both ends: a loop, not a pattern with `$`. */
function trimBlanks(text) {
  const blank = (i) => { const c = text.charCodeAt(i); return c === 32 || c === 9 || c === 13; };
  let a = 0;
  let b = text.length;
  while (a < b && blank(a)) a += 1;
  while (b > a && blank(b - 1)) b -= 1;
  return text.slice(a, b);
}

/**
 * The attributes a `.gitattributes` text gives to ONE pattern, read the way git reads them. A line ends at `\n`; its words are
 * cut at blanks (space, tab, `\r`); a blank line and a line that starts with `#` say nothing; a leading byte order mark is
 * skipped. A line whose first word is `pattern` names its attributes as a SET of words, and for every attribute the LAST word
 * wins: `name` is `set`, `-name` is `unset`, `!name` takes the attribute back to unspecified (it leaves the map), `name=value`
 * is the value. One word that is no attribute name (`# comment` after the rule, `foo!`) makes git ignore the WHOLE line, and so
 * it does here. The words are those `git check-attr` reports (`set`, `unset`, the value), for a file that holds this pattern only.
 *
 * Replaces `/^\s*\*\.jsonl\s+merge=union\s*$/m` and `/^\s*\*\.jsonl\s+(?:\S+\s+)*eol=lf(?:\s|$)/m`. The first restarts at every
 * line start and lets `\s*` run over the blank lines behind it, quadratic on a file of line breaks; both read `merge=union`
 * and `eol=lf` on ONE line as only one of the two (`*.jsonl merge=union eol=lf`, which git knows as both) and ignored a later
 * line that takes the value back. A rule is one line, and a word is a word.
 * @param {string} text
 * @param {string} pattern
 * @returns {Map<string, string>}
 */
export function attributesOf(text, pattern) {
  const out = new Map();
  const s = String(text ?? '');
  let start = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start <= s.length) {
    let end = s.indexOf('\n', start);
    if (end === -1) end = s.length;
    const line = trimBlanks(s.slice(start, end));
    start = end + 1;
    if (line === '' || line[0] === '#') continue;
    const words = line.split(GIT_BLANKS);
    if (words[0] !== pattern) continue;
    const steps = [];
    let valid = true;
    for (const w of words.slice(1)) {
      const lead = w[0] === '-' || w[0] === '!' ? w[0] : '';
      const body = w.slice(lead.length);
      const eq = lead === '' ? body.indexOf('=') : -1;
      const name = eq === -1 ? body : body.slice(0, eq);
      if (!ATTRIBUTE_NAME.test(name)) { valid = false; break; }
      steps.push(lead === '-' ? [name, 'unset'] : lead === '!' ? [name, null] : [name, eq === -1 ? 'set' : body.slice(eq + 1)]);
    }
    if (!valid) continue;
    for (const [name, value] of steps) {
      if (value === null) out.delete(name); else out.set(name, value);
    }
  }
  return out;
}

const isPathChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 46 || c === 47 || c === 92 || c === 45;

/**
 * Every `<file>.jsonl:<line>` place in a text: the same strings as `text.matchAll(/[A-Za-z0-9_./\\-]+\.jsonl:\d+/g)`, in one pass.
 * The pattern's run of path characters starts again at every character of a long run and walks to its end each time; but a colon
 * is no path character, so a run can end in `.jsonl` + colon + digits only once, and the match is that run (cut at the end of the
 * match before it) with the digits. 600 characters of path are a path here, not a cut (the bound `boundRuns` puts on the run).
 * @param {string} text
 * @returns {string[]}
 */
export function jsonlPlaces(text) {
  const s = String(text ?? '');
  const out = [];
  let lastEnd = 0;
  for (let at = s.indexOf(':'); at !== -1; at = s.indexOf(':', at + 1)) {
    if (at < 6 || !s.startsWith('.jsonl', at - 6)) continue;
    let end = at + 1;
    while (end < s.length && s.charCodeAt(end) >= 48 && s.charCodeAt(end) <= 57) end += 1;
    if (end === at + 1) continue;
    let from = at - 6;
    while (from > lastEnd && isPathChar(s.charCodeAt(from - 1))) from -= 1;
    if (from === at - 6) continue;                         // nothing in front of `.jsonl`: the run needs a character
    out.push(s.slice(from, end));
    lastEnd = end;
    at = end - 1;                                          // go on behind the digits
  }
  return out;
}
