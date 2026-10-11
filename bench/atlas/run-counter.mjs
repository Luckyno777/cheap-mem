// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/run-counter.mjs — a preload that counts how long an unbroken
// run of characters a pattern scan was HANDED.
//
// **Why a counter and not a clock.** Two of the patterns that scan every
// entry's text (`name` and `path` in src/entity.mjs, and the file-name
// pattern in src/netderive.mjs) are quadratic in the length of one run of
// characters without whitespace. How long a 60,000-character title takes to
// scan depends on who else is running; the longest run the pattern was
// given does not. The bridge phase (bench/atlas/phase-bridge.mjs) leads with
// this number: the code is fine as long as no pattern ever sees a run longer
// than the bound (`MAX_RUN` in src/entity.mjs).
//
// Use it as `node --import=<this file's URL>?out=<file> bin/mem find ...`.
// The output file travels in the URL's query string for the reason
// bench/atlas/io-counter.mjs gives: a measuring tool does not add an
// environment variable.
//
// It wraps `RegExp.prototype[Symbol.matchAll]`, `[Symbol.match]` and
// `[Symbol.replace]` (so `str.matchAll(re)`, `str.match(re)` and
// `str.replace(re, ...)` are seen), and only looks at subjects longer than
// `WATCH_FROM` characters. At exit it appends ONE JSON line:
//
//   { pid, scans, longestRun, bySource: { "<regex source>": longestRun } }
//
// `bySource` keeps the forty sources that were handed the longest runs. What
// it does NOT see (named, because a counter that claims more than it sees
// is an empty green): scans through `RegExp.prototype.exec` or `.test`
// called directly, and scans that run in a child process which did not load
// this preload. The probe test calls the raw pattern on a known run and
// checks the counter reports it.
import fs from 'node:fs';

const OUT = new URL(import.meta.url).searchParams.get('out');
/** Subjects up to this long cannot hold a run beyond any bound the phase asks about; they are not looked at. */
export const WATCH_FROM = 512;

if (OUT) install(OUT);

function longestRunOf(s) {
  let best = 0; let cur = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x2028 || c === 0x2029 || c === 0xfeff) cur = 0;
    else { cur += 1; if (cur > best) best = cur; }
  }
  return best;
}

function install(out) {
  const state = { scans: 0, longestRun: 0, bySource: new Map() };
  const see = (re, subject) => {
    const s = typeof subject === 'string' ? subject : String(subject);
    if (s.length <= WATCH_FROM) return;
    const run = longestRunOf(s);
    state.scans += 1;
    if (run > state.longestRun) state.longestRun = run;
    const src = String(re.source);
    if ((state.bySource.get(src) ?? 0) < run) state.bySource.set(src, run);
  };
  for (const sym of [Symbol.matchAll, Symbol.match, Symbol.replace]) {
    const original = RegExp.prototype[sym];
    Object.defineProperty(RegExp.prototype, sym, {
      configurable: true,
      writable: true,
      value: function counted(subject, ...rest) {
        see(this, subject);
        return original.call(this, subject, ...rest);
      },
    });
  }
  process.on('exit', () => {
    const top = [...state.bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    const row = { pid: process.pid, scans: state.scans, longestRun: state.longestRun, bySource: Object.fromEntries(top) };
    try { fs.appendFileSync(out, `${JSON.stringify(row)}\n`); } catch { /* the run's own result is not ours to break */ }
  });
}
