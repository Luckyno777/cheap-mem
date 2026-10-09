#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The countable numbers in README.md — count them, compare them, pull
 * them forward.
 *
 * **Why this exists (B10, 2026-09-26).** cheap-mem already had a bolt on
 * these numbers, `test/readme-numbers.test.mjs` — it works, and it goes
 * red the moment a number drifts. What it does not have is a write path:
 * every drift it catches gets fixed by hand, the same hand-motion each
 * time. lucky-mem hit exactly this (`betrieb/readme-zahlen.mjs`'s own
 * header: caught the same session five times in one day, always the
 * same fix). This is cheap-mem's own copy of that idea, in English, for
 * cheap-mem's own README.
 *
 * **One truth, not two.** The counters and the claim patterns live HERE;
 * `test/readme-numbers.test.mjs` keeps its own inline counters for the
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
 * `test/doc-numbers.test.mjs`'s static count, but this file used to
 * write only `README.md`. The gap was not theoretical: on 2026-09-27
 * README already said 2041 while CAPABILITIES.md still said 2033,
 * eight commits of drift that `--write` never touched because it never
 * looked at that file. Each `CLAIMS` entry now names its own `file`
 * (default `README.md`), and both `checkNumbers`/`updateNumbers` walk
 * every file that has at least one claim — still ONE truth (the same
 * `buildCounters()`), just read into more than one document.
 *
 * **One list of places, not two (O7, 2026-09-30).** M14 taught the
 * writer a second FILE, but the guards check more places than the
 * writer's `CLAIMS` knew: `test/doc-numbers.test.mjs` sweeps every
 * living document for "<n> MCP tools/CLI commands/commands/tools/
 * modules/tests/lines", and `test/tool-count-doc.test.mjs` sweeps every
 * document for "<n|word> tools". On 2026-09-30 docs/mcp-setup.md (twice)
 * and docs/CAPABILITIES.md section 7.2 ("N tools") were red after a merge and
 * `--write --all` fixed none of them — by hand again. The sweep (which
 * documents, which pattern, which exemption marker, which band) now
 * lives HERE, exported; both guards import it, and `updateNumbers`
 * fixes every place the sweep checks that the guard would fail. The
 * counters the guards grade with stay their own (a probe that imports
 * the number it grades tests the import); the PLACES are one list.
 * `CLAIMS` keep owning their exact spans — the sweep never touches a
 * number inside a `CLAIMS` match, so nothing is written twice.
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

/** Files below `dir` (recursive) that pass `filter`. */
function countFiles(dir, filter) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name), filter);
    else if (e.isFile() && filter(e.name)) n += 1;
  }
  return n;
}

function lineCount(root, dir, filter = () => true) {
  let n = 0;
  // Recursive (F4, 2026-09-30), like `modules`: the subdirectories of src/ are code too.
  for (const name of fs.readdirSync(path.join(root, dir), { recursive: true })) {
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
    // Recursive (F4, 2026-09-30): `src/cli/commands/`, `src/embed/` and
    // the other subdirectories hold modules too; a flat `readdir` said
    // 122 while 136 existed. The guards count the same way.
    modules: () => countFiles(path.join(root, 'src'), (n) => n.endsWith('.mjs')),
    // The entry types — `memory.TYPES`, one drawer each. "ten", "nine",
    // "13" in the prose all went stale while the map grew to 15.
    types: async () => Object.keys((await import(pathToFileURL(path.join(root, 'src', 'memory.mjs')).href)).TYPES).length,
    // The hook scripts `install/claude-code.sh` installs: one file per
    // hook in `install/hooks/`.
    hooks: () => fs.readdirSync(path.join(root, 'install', 'hooks')).filter((n) => n.endsWith('.sh')).length,
    // The phases `bench/atlas.mjs` runs: one `[id, './atlas/phase-…']` row each.
    atlasPhases: () => [...read('bench/atlas.mjs').matchAll(/^\s*\['[a-z]+', '\.\/atlas\/phase-[a-z]+\.mjs'/gm)].length,
    // Cannot be had exactly without running the suite, and a test that
    // starts the suite contains itself — so this counts `test(` call
    // sites, close enough (0.3 % apart, measured 2026-09-19 in
    // test/readme-numbers.test.mjs's own header) for a tolerance, never
    // written without `--all`.
    tests: () => fs.readdirSync(path.join(root, 'test'))
      .filter((n) => n.endsWith('.test.mjs'))
      .reduce((n, f) => n + (fs.readFileSync(path.join(root, 'test', f), 'utf8')
        .match(/^\s*test\(/gm) ?? []).length, 0),
    lines: () => lineCount(root, 'bin') + lineCount(root, 'src', (n) => n.endsWith('.mjs')),
    // `bin/mem` alone — CLAUDE.md's "about N lines" (the sweep's
    // `lines:cli`, see `linesTarget`).
    linesCli: () => fs.readFileSync(path.join(root, 'bin', 'mem'), 'utf8').split('\n').length,
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
  // F4 (2026-09-30): the counts the 2026-09-30 audit found stale in a
  // dozen places ("ten types", "five hooks", "seven phases", "sixty
  // handlers"). One list of places; each states its number as DIGITS so
  // the writer can pull it forward. A prose mention that names no
  // number needs no entry here.
  { file: 'README.md', pattern: /every command executed as a process, (\d+) phases/, fields: ['atlasPhases'] },
  { file: 'docs/scale.md', pattern: /every command executed as a process, (\d+) phases/, fields: ['atlasPhases'] },
  { file: 'README.md', pattern: /append an entry \((\d+) types\)/, fields: ['types'] },
  { file: 'README.md', pattern: /It drops (\d+) hooks into/, fields: ['hooks'] },
  { file: 'docs/CAPABILITIES.md', pattern: /`link` is one of the (\d+) entry\s+types/, fields: ['types'] },
  { file: 'docs/CAPABILITIES.md', pattern: /\*\*Automation\*\* \| (\d+) Claude Code hooks/, fields: ['hooks'] },
  { file: 'docs/CAPABILITIES.md', pattern: /(\d+) Claude Code hooks, installed by/, fields: ['hooks'] },
  { file: 'docs/CAPABILITIES.md', pattern: /\| (\d+) entry types, typed links/, fields: ['types'] },
  { file: 'docs/architecture.md', pattern: /### The (\d+) drawers/, fields: ['types'] },
  { file: 'docs/dashboard-single-entry.md', pattern: /Never all (\d+) types/, fields: ['types'] },
  { file: 'docs/mcp-setup.md', pattern: /drops (\d+) hooks under/, fields: ['hooks'] },
  { file: 'docs/security-model.md', pattern: /\*\*(\d+) mutants, (\d+) caught\.\*\*/, fields: ['guarantees', 'guarantees'] },
  { file: 'CLAUDE.md', pattern: /the (\d+) handlers, in six groups/, fields: ['cli'] },
];

/** The exact, low-noise selection: safe to write on every run. */
export const EXACT = ['cli', 'mcp', 'modules', 'guarantees', 'types', 'hooks', 'atlasPhases'];

/** Everything, including the numbers that move on nearly every commit. */
export const ALL = [...EXACT, 'tests', 'lines', 'linesCli'];

// ---------------------------------------------------------------------
// The sweep — the places the guards check (O7). Everything below is
// imported by test/doc-numbers.test.mjs and test/tool-count-doc.test.mjs;
// a change here changes what they check AND what this file writes.

/**
 * Which documents are living, and which are records. A file is an
 * ARCHIVE if its name carries a date, or it is the changelog: a dated
 * record states what was true that day and is never rewritten.
 * (test/doc-archive.mjs re-exports this — one rule for every guard.)
 */
export function isArchive(rel) {
  return rel === 'CHANGELOG.md' || /-\d{4}-\d{2}-\d{2}/.test(rel);
}

/** Stored and printed relative paths always use "/" (path.join / path.relative give "\\" on Windows). */
export const slashed = (rel, sep = path.sep) => rel.split(sep).join('/');

/** Living documents: `*.md` at the root and under `docs/`, archives out. */
export function livingDocs(root = DEFAULT_ROOT) {
  const out = [];
  for (const rel of fs.readdirSync(root).filter((n) => n.endsWith('.md'))) out.push(rel);
  const d = path.join(root, 'docs');
  if (fs.existsSync(d)) for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.md'))) out.push(`docs/${n}`);
  return out.filter((r) => !isArchive(r));
}

/** Every `*.md` below root (no .git, no node_modules), archives included. */
export function allDocs(root = DEFAULT_ROOT) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(slashed(path.relative(root, p)));
    }
  };
  walk(root);
  return out;
}

/** `28 MCP tools`, `904 tests`, `about 18,900 lines`, `54 commands`. */
export const SWEEP_PATTERN = /\b([\d][\d,]*)\s+(MCP tools|CLI commands|commands|tools|modules|tests|lines)\b/g;

/** `tools` alone means MCP tools; `commands` alone means CLI commands. */
export const SYNONYMS = Object.freeze({ tools: 'MCP tools', commands: 'CLI commands' });

/**
 * An exemption NAMES the number it exempts:
 * `<!-- number-historical: 500 lines (reason) -->` exempts `500 lines` and
 * nothing else (see test/doc-numbers.test.mjs for why it never guesses).
 * The German spelling of the marker from before 2026-10-01 is still read,
 * so a document marked back then keeps its exemption.
 */
export function markedExemptions(text) {
  const out = new Set();
  for (const m of text.matchAll(/<!--\s*(?:number-historical|zahl-historisch):\s*([\d][\d,]*)\s+([A-Za-z ]+?)\s*(?:\(|-->)/gi)) {
    out.add(`${m[1].replace(/,/g, '')} ${m[2].trim()}`);
  }
  return out;
}

/**
 * `lines` also means other things ("480 lines per hour"). Only a claim
 * that names the code is about the code: `lines:cli` (bin/mem alone),
 * `lines:all` (bin/ + src/), or null (a rate, a budget — skipped).
 */
export function linesTarget(text, index) {
  const around = text.slice(Math.max(0, index - 200), index + 200);
  if (/\bbin\/mem\b(?!-)/.test(around) && !/\bsrc\//.test(around)) return 'lines:cli';
  if (/\bbin\/|\bsrc\/|codebase|of JS\b/.test(around)) return 'lines:all';
  return null;
}

/**
 * The allowed drift per approximate kind — ONE source for the guard
 * (test/doc-numbers.test.mjs, which explains each number) and for the
 * writer's decision whether a sweep place needs rewriting at all.
 */
export const TOLERANCE = Object.freeze({ tests: 1.02, 'lines:all': 1.15, 'lines:cli': 1.15 });
export const DEFAULT_BAND = 1.15;
export const bandFor = (kind) => TOLERANCE[kind] ?? DEFAULT_BAND;

/** The sweep's kind -> the writer's counter field. */
export const KIND_FIELD = Object.freeze({
  'MCP tools': 'mcp', 'CLI commands': 'cli', modules: 'modules',
  tests: 'tests', 'lines:all': 'lines', 'lines:cli': 'linesCli',
});
/** Counted exactly (no band); the rest carry a tolerance. */
export const EXACT_KINDS = Object.freeze(['MCP tools', 'CLI commands', 'modules']);

/**
 * The claims one document text makes, as the guard sorts them:
 * `checked` (graded against the code), `dated` (exempted by a marker),
 * `notCode` (a `lines` figure about something else). Each claim carries
 * `index`/`start`/`end` of its NUMBER so a writer can replace exactly it.
 */
export function sweepText(rel, text) {
  const checked = []; const dated = []; const notCode = [];
  const exempt = markedExemptions(text);
  for (const m of text.matchAll(SWEEP_PATTERN)) {
    const number = Number(m[1].replace(/,/g, ''));
    const word = m[2];
    const claim = {
      rel, number, raw: m[1], word, index: m.index, start: m.index, end: m.index + m[1].length,
      line: text.slice(0, m.index).split('\n').length,
    };
    if (exempt.has(`${number} ${word}`)) { dated.push({ ...claim, kind: word }); continue; }
    if (word === 'lines') {
      const target = linesTarget(text, m.index);
      if (!target) { notCode.push({ ...claim, kind: word }); continue; }
      checked.push({ ...claim, kind: target });
      continue;
    }
    checked.push({ ...claim, kind: SYNONYMS[word] ?? word });
  }
  return { checked, dated, notCode };
}

/** The sweep over every living document (what doc-numbers checks). */
export function sweepClaims(root = DEFAULT_ROOT) {
  const checked = []; const dated = []; const notCode = [];
  for (const rel of livingDocs(root)) {
    const r = sweepText(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    checked.push(...r.checked); dated.push(...r.dated); notCode.push(...r.notCode);
  }
  return { checked, dated, notCode };
}

/** Does the guard fail this claim against `real`? */
export function sweepFails(kind, claimed, real) {
  if (EXACT_KINDS.includes(kind)) return claimed !== real;
  return Math.max(real, claimed) / Math.min(real, claimed) > bandFor(kind);
}

// "<n> tools" as a numeral or a number word (test/tool-count-doc.test.mjs).
// Only as far as the docs actually count; more words would invite
// routing around it.
export const TOOL_WORDS = Object.freeze(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen']);
export const TOOL_CLAIM = new RegExp(`\\b(\\d{1,2}|${TOOL_WORDS.join('|')})\\s+tools\\b`, 'gi');

/** The value a "<n|word> tools" claim states. */
export const toolClaimValue = (raw) => (/^\d+$/.test(raw) ? Number(raw) : TOOL_WORDS.indexOf(raw.toLowerCase()));

/** The tool-count claims of one text, with the span of the number. */
export function toolClaimsIn(rel, text) {
  return [...text.matchAll(TOOL_CLAIM)].map((m) => ({
    rel, raw: m[1], said: toolClaimValue(m[1]), start: m.index, end: m.index + m[1].length,
  }));
}

/** Every "<n|word> tools" claim in every non-archive document. */
export function toolCountClaims(root = DEFAULT_ROOT) {
  const out = [];
  for (const rel of allDocs(root)) {
    if (isArchive(rel)) continue;
    out.push(...toolClaimsIn(rel, fs.readFileSync(path.join(root, rel), 'utf8')));
  }
  return out;
}

/** Keep the claim's own shape: thousands separators, a number word. */
function formatLike(raw, real) {
  if (/^\d[\d,]*$/.test(raw)) return raw.includes(',') ? real.toLocaleString('en-US') : String(real);
  const word = real < TOOL_WORDS.length ? TOOL_WORDS[real] : String(real);
  return /^[A-Z]/.test(raw) ? word[0].toUpperCase() + word.slice(1) : word;
}

/** Every file a sweep or a CLAIMS entry can write — for coverage probes. */
export function coveredFiles(root = DEFAULT_ROOT, claims = CLAIMS) {
  return new Set([
    ...claims.map((c) => c.file ?? 'README.md'),
    ...livingDocs(root),
    ...allDocs(root).filter((r) => !isArchive(r)),
  ]);
}

/**
 * The sweep's verdict on one text, minus the spans `CLAIMS` own.
 * Returns the places the GUARD would fail, each with the writer field,
 * the stated value and the real one.
 */
async function sweepFailures(rel, text, counters, allowed, owned, living) {
  const out = [];
  const cache = new Map();
  const real = async (field) => {
    if (!cache.has(field)) cache.set(field, await counters[field]());
    return cache.get(field);
  };
  const inOwned = (c) => owned.some(([a, b]) => c.start >= a && c.end <= b);
  if (living) {
    for (const c of sweepText(rel, text).checked) {
      const field = KIND_FIELD[c.kind];
      if (!field || !allowed.includes(field) || inOwned(c)) continue;
      const r = await real(field);
      if (sweepFails(c.kind, c.number, r)) out.push({ ...c, field, real: r });
    }
  }
  return out;
}

async function toolFailures(rel, text, counters, allowed, owned) {
  if (!allowed.includes('mcp') || isArchive(rel)) return [];
  const n = await counters.mcp();
  return toolClaimsIn(rel, text)
    .filter((c) => !owned.some(([a, b]) => c.start >= a && c.end <= b))
    .filter((c) => c.said !== n)
    .map((c) => ({ ...c, field: 'mcp', kind: 'tools', number: c.said, real: n }));
}

/** [start, end) of every CLAIMS match in `text` — the spans CLAIMS own. */
function ownedSpans(text, fileClaims) {
  const spans = [];
  for (const claim of fileClaims) {
    const m = new RegExp(claim.pattern.source, claim.pattern.flags.replace(/g/g, '')).exec(text);
    if (m) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

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
 * The files one run looks at, in a stable order: every file a `CLAIMS`
 * entry names (in their first-seen order), then every other document the
 * sweep checks. `living` marks the ones doc-numbers' sweep covers.
 */
function filesToVisit(root, claims) {
  const groups = byFile(claims);
  const living = new Set(fs.existsSync(root) ? livingDocs(root) : []);
  const tools = fs.existsSync(root) ? allDocs(root).filter((r) => !isArchive(r)) : [];
  const order = [...groups.keys()];
  for (const f of [...living, ...tools]) if (!order.includes(f)) order.push(f);
  return order.map((file) => ({ file, claims: groups.get(file) ?? [], living: living.has(file) }));
}

/**
 * Compares the docs against the code. Never writes; `updateNumbers`
 * below does that and calls this for its report. A `file` a claim
 * names but that does not exist under `root` is skipped rather than
 * reported missing — a caller running this against a partial tree
 * (a test fixture, say) is not claiming that tree has every document.
 * Besides the `CLAIMS`, every place the guards' sweep checks is
 * compared (O7) — with the guards' own rule: exact kinds must match,
 * approximate ones must stay inside their band.
 */
export async function checkNumbers({ root = DEFAULT_ROOT, only = ALL, claims = CLAIMS } = {}) {
  const counters = buildCounters(root);
  const missing = [];
  const mismatches = [];
  for (const { file, claims: fileClaims, living } of filesToVisit(root, claims)) {
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
    const owned = ownedSpans(text, fileClaims);
    const found = [
      ...await sweepFailures(file, text, counters, only, owned, living),
      ...await toolFailures(file, text, counters, only, owned),
    ];
    for (const f of found) mismatches.push({ file, field: f.field, claimed: f.number, real: f.real, line: text.slice(0, f.start).split('\n').length });
  }
  return { missing, mismatches };
}

/** Replace spans rightmost first, so an earlier span never moves. */
function applySpans(text, pending) {
  let out = text;
  for (const p of [...pending].sort((x, y) => y.span[0] - x.span[0])) {
    out = out.slice(0, p.span[0]) + p.to + out.slice(p.span[1]);
  }
  return out;
}

/**
 * Pulls the numbers forward, in every file a claim names and at every
 * place the guards' sweep checks (O7). Returns what it changed (or
 * would change, dry-run) — always, even without `--write`, so a caller
 * can report without writing. Same skip rule as `checkNumbers` for a
 * file that does not exist under `root`.
 *
 * A sweep place is rewritten only where the GUARD would fail it: an
 * exact kind that differs, an approximate kind outside its band. A
 * "about 180 lines" that is still inside its band stays as written —
 * rewriting it on every run would be the churn `--all` exists to keep
 * out of ordinary commits.
 */
export async function updateNumbers({
  root = DEFAULT_ROOT, only = null, all = false, write = false, claims = CLAIMS,
} = {}) {
  const counters = buildCounters(root);
  const allowed = only ?? (all ? ALL : EXACT);
  const missing = [];
  const changes = [];

  for (const { file, claims: fileClaims, living } of filesToVisit(root, claims)) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    const original = fs.readFileSync(filePath, 'utf8');
    let text = original;

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
      text = applySpans(text, pending);
      changes.push(...pending.map(({ field, from, to }) => ({ file, field, from, to })));
    }

    // The sweep places (doc-numbers), then the tool-count places — the
    // second scan runs on the text the first already fixed, so a "33
    // tools" both guards see is written once.
    for (const pass of ['sweep', 'tools']) {
      const owned = ownedSpans(text, fileClaims);
      const found = pass === 'sweep'
        ? await sweepFailures(file, text, counters, allowed, owned, living)
        : await toolFailures(file, text, counters, allowed, owned);
      const pending = found.map((f) => ({
        field: f.field, from: f.raw, to: formatLike(f.raw, f.real), span: [f.start, f.end],
      })).filter((p) => p.from !== p.to);
      text = applySpans(text, pending);
      changes.push(...pending.map(({ field, from, to }) => ({ file, field, from, to })));
    }

    if (write && text !== original) fs.writeFileSync(filePath, text, 'utf8');
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
    process.stdout.write(`${c.file}: ${c.field}: ${c.from} -> ${c.to}\n`);
  }
  if (!report.changes.length) process.stdout.write('README numbers already match\n');
  else if (!report.wrote) process.stdout.write('(dry run — pass --write to pull forward)\n');
  // Fail-closed only on a missing claim: a line that no longer exists
  // cannot be pulled forward either, and that has to be noticed.
  if (report.missing.length) process.exitCode = 2;
}
