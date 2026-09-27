#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The countable numbers in README.md — count them, compare them, pull
 * them forward.
 *
 * **Why this exists (B10, 2026-09-26).** cheap-mem already had a bolt on
 * these numbers, `test/readme-zahlen.test.mjs` — it works, and it goes
 * red the moment a number drifts. What it does not have is a write path:
 * every drift it catches gets fixed by hand, the same hand-motion each
 * time. lucky-mem hit exactly this (`betrieb/readme-zahlen.mjs`'s own
 * header: caught the same session five times in one day, always the
 * same fix). This is cheap-mem's own copy of that idea, in English, for
 * cheap-mem's own README.
 *
 * **One truth, not two.** The counters and the claim patterns live HERE;
 * `test/readme-zahlen.test.mjs` keeps its own inline counters for the
 * numbers it checks, and that is deliberate — a probe that imports the
 * thing it is grading tests the import, not the number. What matters is
 * that both sides count the SAME way (readdir + a fixed pattern), so
 * they cannot silently drift apart in what "a module" or "a CLI command"
 * means. This file adds only what a bolt cannot do for itself: writing
 * the fix back.
 *
 * **What is pulled forward by default, and what needs `--all`.**
 * `cli`, `mcp`, `modules` and `guarantees` are exact counts of things
 * that change only when a command, a tool, a module or a mutant is
 * added — a real event worth a README line. `tests` and `lines` move
 * with nearly every commit; pulling them forward by default would turn
 * every ordinary commit into a README diff that answers no question.
 * They are counted and compared (see `checkNumbers`) but only WRITTEN
 * with `--all`, same reasoning as lucky-mem's `eintraege`.
 *
 * **Replace by POSITION, not by value.** A claim line can hold several
 * numbers next to each other ("62 CLI commands, 28 MCP tools, 73
 * modules, 1837 tests"). Fixing the first by `text.replace(String(old),
 * String(new))` and then searching for the second's old value can match
 * INSIDE the digits the first replacement just wrote — lucky-mem's own
 * postmortem: `1 -> 289` left a `2` sitting in the text, and the next
 * search for that `2` found it there first. The fix is a regex with the
 * `d` (indices) flag and replacing from the rightmost match backward, so
 * an earlier replacement never moves a later one's position. The
 * counter-probe for exactly this class lives in
 * `test/readme-numbers-writer.test.mjs`.
 *
 * **More than one file (M14, 2026-09-27).** `docs/CAPABILITIES.md` has
 * its own "N tests" claim ("17 benchmarks, an eval harness with a
 * frozen reference run, 2033 tests") — a SECOND place stating the same
 * `tests` count as README's claim, checked by
 * `test/doku-zahlen.test.mjs`'s static count, but this file used to
 * write only `README.md`. The gap was not theoretical: on 2026-09-27
 * README already said 2041 while CAPABILITIES.md still said 2033,
 * eight commits of drift that `--write` never touched because it never
 * looked at that file. Each `CLAIMS` entry now names its own `file`
 * (default `README.md`), and both `checkNumbers`/`updateNumbers` walk
 * every file that has at least one claim — still ONE truth (the same
 * `buildCounters()`), just read into more than one document.
 *
 * Usage:
 *   node bench/readme-numbers.mjs                 # report only
 *   node bench/readme-numbers.mjs --write          # pull forward
 *   node bench/readme-numbers.mjs --write --all    # tests and lines too
 *   node bench/readme-numbers.mjs --only cli,mcp
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as clihelp from '../src/clihelp.mjs';

export const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function lineCount(root, dir, filter = () => true) {
  let n = 0;
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (!filter(name)) continue;
    const p = path.join(root, dir, name);
    if (!fs.statSync(p).isFile()) continue;
    n += fs.readFileSync(p, 'utf8').split('\n').length;
  }
  return n;
}

/**
 * The counters. `guarantees` loads `bench/mutation.mjs` ONLY when asked
 * for — a module-level import would pull in every mutant's file-patching
 * machinery even for a run that only wants `modules`.
 */
export function buildCounters(root = DEFAULT_ROOT) {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  return {
    cli: () => clihelp.allTableCommands(read).length,
    mcp: () => new Set([...read('bin/mem-mcp').matchAll(/name: '(mem_[a-z_]+)'/g)]
      .map((m) => m[1])).size,
    modules: () => fs.readdirSync(path.join(root, 'src')).filter((n) => n.endsWith('.mjs')).length,
    // Cannot be had exactly without running the suite, and a test that
    // starts the suite contains itself — so this counts `test(` call
    // sites, close enough (0.3 % apart, measured 2026-09-19 in
    // test/readme-zahlen.test.mjs's own header) for a tolerance, never
    // written without `--all`.
    tests: () => fs.readdirSync(path.join(root, 'test'))
      .filter((n) => n.endsWith('.test.mjs'))
      .reduce((n, f) => n + (fs.readFileSync(path.join(root, 'test', f), 'utf8')
        .match(/^\s*test\(/gm) ?? []).length, 0),
    lines: () => lineCount(root, 'bin') + lineCount(root, 'src', (n) => n.endsWith('.mjs')),
    // An ESM specifier is a URL, not a filesystem path — on Windows a bare
    // path.join(...) reads the drive letter as a scheme and Node refuses
    // with ERR_UNSUPPORTED_ESM_URL_SCHEME (test/windows-paths.test.mjs).
    guarantees: async () => (await import(pathToFileURL(path.join(root, 'bench', 'mutation.mjs')).href)).MUTANTS.length,
  };
}

// What the docs say -> how it is counted. Each entry's `fields` names
// the capture groups left-to-right; a field left out of `only` is simply
// skipped, its group untouched. `file` is relative to `root` and
// defaults to `README.md` — see the file header for why more than one
// document can carry the same field.
export const CLAIMS = [
  {
    pattern: /As of [\d-]+: \*\*(\d+) CLI commands, (\d+) MCP tools, (\d+) modules, ([\d,]+)\s*\ntests\*\*/,
    fields: ['cli', 'mcp', 'modules', 'tests'],
  },
  {
    pattern: /about ([\d,]+) lines in `bin\/` and `src\/`,/,
    fields: ['lines'],
  },
  {
    pattern: /one of (\d+) guarantees was broken on purpose/,
    fields: ['guarantees'],
  },
  {
    // docs/CAPABILITIES.md's own "N tests" claim (0. Inventory). The
    // benchmark count ahead of it is not one of buildCounters()'s
    // fields and is left uncaptured on purpose — this file has nothing
    // to compare it against and no business rewriting it.
    file: 'docs/CAPABILITIES.md',
    pattern: /\d+ benchmarks, an eval harness with a frozen reference run, ([\d,]+) tests\b/,
    fields: ['tests'],
  },
];

/** The exact, low-noise selection: safe to write on every run. */
export const EXACT = ['cli', 'mcp', 'modules', 'guarantees'];

/** Everything, including the numbers that move on nearly every commit. */
export const ALL = [...EXACT, 'tests', 'lines'];

const stripCommas = (s) => Number(String(s).replace(/,/g, ''));

/**
 * Groups claims by the file they belong to, preserving each file's
 * first-seen order and each claim's order within it — so processing
 * one file at a time changes nothing about the order claims used to be
 * checked in when there was only ever `README.md`.
 */
function byFile(claims) {
  const groups = new Map();
  for (const claim of claims) {
    const file = claim.file ?? 'README.md';
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(claim);
  }
  return groups;
}

/**
 * Compares the docs against the code. Never writes; `updateNumbers`
 * below does that and calls this for its report. A `file` a claim
 * names but that does not exist under `root` is skipped rather than
 * reported missing — a caller running this against a partial tree
 * (a test fixture, say) is not claiming that tree has every document.
 */
export async function checkNumbers({ root = DEFAULT_ROOT, only = ALL, claims = CLAIMS } = {}) {
  const counters = buildCounters(root);
  const missing = [];
  const mismatches = [];
  for (const [file, fileClaims] of byFile(claims)) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const claim of fileClaims) {
      const m = claim.pattern.exec(text);
      if (!m) { missing.push(`${file}: ${claim.pattern}`); continue; }
      for (let i = 0; i < claim.fields.length; i += 1) {
        const field = claim.fields[i];
        if (!only.includes(field)) continue;
        const claimed = stripCommas(m[i + 1]);
        const real = await counters[field]();
        if (claimed !== real) mismatches.push({ file, field, claimed, real });
      }
    }
  }
  return { missing, mismatches };
}

/**
 * Pulls the numbers forward, in every file a claim names. Returns what
 * it changed (or would change, dry-run) — always, even without
 * `--write`, so a caller can report without writing. Same skip rule as
 * `checkNumbers` for a file that does not exist under `root`.
 */
export async function updateNumbers({
  root = DEFAULT_ROOT, only = null, all = false, write = false, claims = CLAIMS,
} = {}) {
  const counters = buildCounters(root);
  const allowed = only ?? (all ? ALL : EXACT);
  const missing = [];
  const changes = [];

  for (const [file, fileClaims] of byFile(claims)) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    let text = fs.readFileSync(filePath, 'utf8');
    let touched = false;

    for (const claim of fileClaims) {
      // The 'd' flag reports each group's [start, end) in the source text,
      // so a later replacement never has to re-find where an earlier one
      // was — see the file header for the bug this closes.
      const withIndices = new RegExp(claim.pattern.source, `${claim.pattern.flags.replace(/d/g, '')}d`);
      const m = withIndices.exec(text);
      if (!m) { missing.push(`${file}: ${claim.pattern}`); continue; }
      const pending = [];
      for (let i = 0; i < claim.fields.length; i += 1) {
        const field = claim.fields[i];
        if (!allowed.includes(field)) continue;
        const span = m.indices?.[i + 1];
        if (!span) continue;
        const claimed = m[i + 1];
        const real = String(await counters[field]());
        if (claimed === real) continue;
        pending.push({ field, from: claimed, to: real, span });
      }
      // Rightmost first: replacing a later span never shifts an earlier
      // one's [start, end), because it lies entirely after it.
      for (const p of [...pending].sort((a, b) => b.span[0] - a.span[0])) {
        text = text.slice(0, p.span[0]) + p.to + text.slice(p.span[1]);
      }
      if (pending.length) touched = true;
      changes.push(...pending.map(({ field, from, to }) => ({ file, field, from, to })));
    }

    if (write && touched) fs.writeFileSync(filePath, text, 'utf8');
  }

  const wrote = write && changes.length > 0;
  return { changes, missing, wrote };
}

const isMain = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootFlag = process.argv.indexOf('--root');
  const onlyFlag = process.argv.indexOf('--only');
  const report = await updateNumbers({
    root: rootFlag < 0 ? DEFAULT_ROOT : process.argv[rootFlag + 1],
    only: onlyFlag < 0 ? null : process.argv[onlyFlag + 1].split(','),
    all: process.argv.includes('--all'),
    write: process.argv.includes('--write'),
  });
  for (const f of report.missing) {
    process.stderr.write(`readme-numbers: claim not found in README: ${f}\n`);
  }
  for (const c of report.changes) {
    process.stdout.write(`${c.field}: ${c.from} -> ${c.to}\n`);
  }
  if (!report.changes.length) process.stdout.write('README numbers already match\n');
  else if (!report.wrote) process.stdout.write('(dry run — pass --write to pull forward)\n');
  // Fail-closed only on a missing claim: a line that no longer exists
  // cannot be pulled forward either, and that has to be noticed.
  if (report.missing.length) process.exitCode = 2;
}
