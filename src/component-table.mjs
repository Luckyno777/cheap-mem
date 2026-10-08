// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// component-table.mjs — the missing R-Tab: ONE table file/symbol ->
// entries, so `mem-before-edit` (the pre-edit hook) can look a path up
// instead of scanning the whole corpus on every edit.
//
// **Parity build for lucky-mem's `src/bauteil-tabelle.mjs`.** Ported so
// both houses answer "what does the memory already know about this
// file" the same way: the hook asks a cached table first, falls back to
// the live literal search (`component.find`, unchanged) only when the
// table is missing/stale/broken, and never rebuilds itself inline (a
// full build is too slow for a hook's time budget — see the background
// rebuild section below).
//
// **Why a second file and not just `component.mjs` extended.**
// `component.mjs`'s `find()` is a LIVE text scan: it reads the whole
// corpus on EVERY call and answers exactly one question, right now. This
// file is the opposite: an OFFLINE-built, on-disk register
// (`.mem/component-table.json`) mapping every path and symbol at once, so
// a reader does not pay the full-corpus cost per lookup. Two lifecycles
// (build vs. query), so two files — but ONE normalisation: the path
// compatibility check (`component.compatible()`/`component.prefix()`) is
// imported here, not written a second time.
//
// **Four roles for the path map** (repo path -> entries):
//
//   mentioned  the entry's text names the path (literally, over both
//              spellings) — source: every entry from `memory.iterLog()`
//              across every drawer x project, skipping closing lines
//              (same exception `memory.find()`/`component.find()` use).
//   guarded    a test file under `test/*.test.mjs` carries the mark
//              `// error: <id>` AND contains `test(` (not an empty
//              scaffold, `probescaffold.isEmpty()`) — the SAME check F4
//              (`probescaffold.guardShare()`) uses, applied to every
//              mark in a file at once instead of a single id. The path
//              is the TEST FILE (it is the guard), not the file under
//              test.
//   works-on   a workflow in force, issued by a human and not a draft,
//              names the file in its `path_patterns` (src/workflowdetect.mjs
//              decides the match, through `component.compatible()` — no
//              second path logic). Parity with lucky-mem's `wirkt-auf`
//              (wf-bc B1). The table row's type is `workflow`.
//   fixed      a commit whose message (subject+body) names a known
//              entry id changed a file (`git log`, read-only) — the
//              fixing commit is the evidence (parity with lucky-mem's
//              R12). Candidate ids are checked against the real id
//              population (`memory.ID_LENGTH` = 12 base36 characters —
//              cheap-mem has only the one length, unlike lucky-mem's
//              7-or-12, so no extra filtering pass is needed there).
//
// **Symbol map** (exported function name -> entries, role `mentioned`
// only): a plain text parser (no real JS grammar, no model) collects
// `export function`/`export async function`/`export function*` and
// `export const NAME = (...) =>` names from `src/*.mjs` and `bin/*`
// (flat, no subfolders). An entry counts when its text contains the
// symbol as a WHOLE WORD (tokenisation + set intersection, not one
// regex per symbol per entry).
//
// **Generation stamp.** `stamp()` chains three parts: the memory stamp
// from `backlinks.stamp()` (the same size+mtime sum over every log file
// — ONE truth, not recomputed — `backlinks.mjs` is this house's port of
// lucky-mem's `rueckverweise.mjs`, the module `bauteil-tabelle.mjs`
// itself reuses this stamp from), size+mtime over `test/*.test.mjs` and
// `src/*.mjs`+`bin/*` (the guard/symbol sources), and `git rev-parse
// HEAD` plus the count+length of `git ls-files` (a new commit OR a
// new/deleted file makes the fixed- or path-view stale). If any of the
// three parts changes, the table is stale — the same four-state
// vocabulary as `backlinks.mjs` (ok/warning/unknown/error), here for
// `lookupPath()`/`lookupSymbol()`.
//
// **Stays honestly blind:** the same blind spot as `probescaffold`'s own
// guard check — a test that creates a FIXTURE string containing
// `// error: <id>` (e.g. this file's own fixtures) looks like a real
// guard to the naive text scan. Harmless as long as the id is not by
// chance a real one (then `state: 'unknown'`, not a silent false hit) —
// not a new problem, just the same old rule applied consistently.
//
// A merge commit gives no file list from `git log --name-only` by
// default when its diff against ALL parents is empty — its `fixed`
// edges are then missing. Not chased further here — same stance as
// `bauteil-tabelle.mjs`'s own header comment on this point.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from './memory.mjs';
import * as component from './component.mjs';
import * as probescaffold from './probescaffold.mjs';
import { stamp as memoryStamp } from './backlinks.mjs';
import { lockAgeS, tryLock, releaseLock, takeOverIfStale } from './filelock.mjs';
import { writeAtomic } from './atomicwrite.mjs';
import * as workflowdetect from './workflowdetect.mjs';

/** Where the table lives, relative to the memory root. */
export const TABLE_PATH = path.join('.mem', 'component-table.json');

/**
 * The format's version. A shape change bumps this and an old table is
 * discarded rather than migrated — same principle as `backlinks.
 * BACKLINKS_VERSION`.
 */
export const TABLE_VERSION = 1;

// --- 0. small tools ----------------------------------------------------

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null; // not a git repo, or the command failed — never throw, just "unavailable"
  }
}

/** Canonicalise a repo-relative path: backslash -> slash, no `./`, no leading slash. */
export function canonical(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function statSum(files) {
  let n = 0;
  let bytes = 0;
  let newest = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    n += 1;
    bytes += st.size;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return `${n}:${bytes}:${newest}`;
}

/** Every file source that feeds the guard/symbol half of the table. */
function codeAndTestFiles(root) {
  const out = [];
  const take = (dir, ext) => {
    let ents;
    try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isFile() && (!ext || e.name.endsWith(ext))) out.push(path.join(root, dir, e.name));
    }
  };
  take('src', '.mjs');
  take('bin', null);
  take('test', '.test.mjs');
  return out;
}

/** Every git-tracked path (repo-relative, POSIX) — `null` when git is unavailable. */
function trackedPaths(root) {
  const raw = git(root, ['ls-files']);
  if (raw === null) return null;
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

// --- 1. generation stamp -------------------------------------------------

/**
 * Three parts, chained (see header comment): memory (reused from
 * `backlinks.stamp()`), code+test files (guard/symbol sources), the
 * git-tracked path list (count+total length — a new/deleted file shows
 * up here) and the current commit (`HEAD`).
 */
export function stamp(root) {
  const mem = memoryStamp(root);
  const code = statSum(codeAndTestFiles(root));
  const tracked = trackedPaths(root);
  const pathPart = tracked === null ? 'no-git' : `${tracked.length}:${tracked.reduce((a, p) => a + p.length, 0)}`;
  const head = git(root, ['rev-parse', 'HEAD']);
  const headPart = head === null ? 'no-git' : head.trim();
  return `${mem}|${code}|${pathPart}|${headPart}`;
}

// --- 2. symbol list (plain text parser, no model) -------------------------

const EXPORT_PATTERNS = [
  /\bexport\s+function\s*\*?\s*(\w+)/g,
  /\bexport\s+async\s+function\s*\*?\s*(\w+)/g,
  /\bexport\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
];

function symbolsInFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const names = new Set();
  for (const pattern of EXPORT_PATTERNS) {
    for (const m of text.matchAll(pattern)) names.add(m[1]);
  }
  return [...names];
}

/**
 * Symbol name -> defining file (the FIRST one found, if several modules
 * export the same name — a hint is enough for a lookup table, not a
 * full cross-reference graph).
 */
export function symbolList(root) {
  const map = new Map();
  const take = (dir, ext) => {
    let ents;
    try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isFile()) continue;
      if (ext && !e.name.endsWith(ext)) continue;
      const full = path.join(root, dir, e.name);
      for (const name of symbolsInFile(full)) {
        if (!map.has(name)) map.set(name, path.relative(root, full));
      }
    }
  };
  take('src', '.mjs');
  take('bin', null);
  return map;
}

// --- 3. commit -> id -> files ("fixed") -----------------------------------

/** `memory.ID_LENGTH` base36 characters — the one id shape this house has. */
const ID_CANDIDATE = new RegExp(`\\b[0-9a-z]{${memory.ID_LENGTH}}\\b`, 'g');

/**
 * For every commit whose message (subject+body) names at least one
 * KNOWN entry id: which files did it change? Two `git log` calls
 * (messages kept separate from file lists, joined over a separator
 * rather than a line heuristic — a commit body can itself contain
 * newlines).
 *
 * Returns `null` when `git log` is unavailable (no git repo). Otherwise
 * a list `{ id, files }` (one row per commit hit, `files` can be empty —
 * see the header comment "stays honestly blind").
 */
export function commitHits(root, knownIds) {
  const SEP = '\u0001';
  const END = '\u0002';
  const messages = git(root, ['log', `--pretty=format:%H${SEP}%s${SEP}%b${END}`]);
  if (messages === null) return null;
  const fileLists = git(root, ['log', '--name-only', '--pretty=format:@@%H']);
  if (fileLists === null) return null;

  const filesByHash = new Map();
  for (const block of fileLists.split(/^@@/m)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const hash = lines[0].trim();
    if (!hash) continue;
    filesByHash.set(hash, lines.slice(1).map((l) => l.trim()).filter(Boolean));
  }

  const out = [];
  for (const entry of messages.split(END)) {
    const parts = entry.split(SEP);
    if (parts.length < 2) continue;
    const hash = parts[0].replace(/^\n/, '').trim();
    if (!hash) continue;
    const text = parts.slice(1).join(SEP);
    const candidates = new Set(text.match(ID_CANDIDATE) || []);
    const hits = [...candidates].filter((c) => knownIds.has(c));
    if (!hits.length) continue;
    const files = filesByHash.get(hash) || [];
    for (const id of hits) out.push({ id, files });
  }
  return out;
}

// --- 4. build ---------------------------------------------------------------

/**
 * Every entry across every drawer of every project (`memory.iterLog()`),
 * skipping closing lines and broken lines — type + searchable text
 * (`JSON.stringify`, the same way `component.find()`'s `compatible()`
 * call already does for the live search).
 *
 * Deliberately `memory.iterLog()` directly, not `component.find()`/
 * `memory.find()`: those need a `Capability` now (issue #136) meant for
 * a caller answering one bounded question, not a full-corpus build that
 * by its nature has to see everything to be honest about what it does
 * NOT know either.
 */
function idInfoMap(root) {
  const map = new Map(); // id -> { type, text }
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let it;
      try { it = memory.iterLog(root, type, { project }); } catch { continue; }
      for (const e of it) {
        if (!e || e.__broken || !e.id || memory.isClosingLine(e)) continue;
        map.set(e.id, { type, text: JSON.stringify(e) });
      }
    }
  }
  return map;
}

/** Build the full table (without writing it). */
export function build(root) {
  const idInfo = idInfoMap(root);
  let incomplete = false;

  const paths = new Map(); // canonical path -> [{id, type, role}]
  const symbols = new Map(); // symbol name -> [{id, type, role}]

  const addPath = (rawPath, id, type, role) => {
    const k = canonical(rawPath);
    if (!paths.has(k)) paths.set(k, []);
    const list = paths.get(k);
    if (!list.some((e) => e.id === id && e.role === role)) list.push({ id, type, role });
  };
  const addSymbol = (name, id, type, role) => {
    if (!symbols.has(name)) symbols.set(name, []);
    const list = symbols.get(name);
    if (!list.some((e) => e.id === id && e.role === role)) list.push({ id, type, role });
  };

  // 1. Path mentions — the same compatibility check `component.find()`
  //    uses, here for EVERY known path instead of a single asked one.
  //    Pre-filter by `text.includes(base)` (cheap), `compatible()` only
  //    for actual hits.
  const files = trackedPaths(root);
  if (files === null) incomplete = true;
  const byBase = new Map();
  for (const f of files ?? []) {
    const base = path.basename(f);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(f);
  }
  for (const [id, { type, text }] of idInfo) {
    for (const [base, candidates] of byBase) {
      if (!text.includes(base)) continue;
      for (const cand of candidates) {
        if (component.compatible(text, base, component.prefix(cand))) {
          addPath(cand, id, type, 'mentioned');
        }
      }
    }
  }

  // 2. Symbol mentions — tokenisation instead of one regex per symbol.
  const symbolMap = symbolList(root);
  for (const [id, { type, text }] of idInfo) {
    const words = new Set(text.match(/[A-Za-z_]\w*/g) || []);
    for (const w of words) {
      if (symbolMap.has(w)) addSymbol(w, id, type, 'mentioned');
    }
  }

  // 3. Guard marks in tests — the same check `probescaffold.guardShare()`
  //    uses, applied to every mark of a file at once.
  let testFiles = [];
  try { testFiles = fs.readdirSync(path.join(root, 'test')); } catch { incomplete = true; testFiles = []; }
  for (const f of testFiles) {
    if (!f.endsWith('.test.mjs')) continue;
    const full = path.join(root, 'test', f);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!/\btest\(/.test(text)) continue;
    if (probescaffold.isEmpty(text)) continue;
    for (const m of text.matchAll(/\/\/\s*error:\s*(\S+)/g)) {
      const id = m[1];
      const info = idInfo.get(id);
      addPath(path.join('test', f), id, info ? info.type : 'unknown', 'guarded');
    }
  }

  // 4. Commits -> files ("fixed").
  const knownIds = new Set(idInfo.keys());
  const commits = commitHits(root, knownIds);
  if (commits === null) {
    incomplete = true;
  } else {
    for (const { id, files: changed } of commits) {
      const info = idInfo.get(id);
      for (const f of changed) {
        if (!fs.existsSync(path.join(root, f))) continue; // only what still exists in the tree
        addPath(f, id, info ? info.type : 'unknown', 'fixed');
      }
    }
  }

  // 5. Workflow path patterns -> files ("works-on"). Only VISIBLE
  //    workflows (in force, issued by a human, not a draft —
  //    `workflowdetect.visibleWorkflows()`), only those that keep a
  //    `path_patterns` list at all. Roles 1-4 are untouched: this is one
  //    extra pass over the same tracked-file list as step 1.
  for (const w of workflowdetect.visibleWorkflows(root)) {
    const patterns = workflowdetect.listOf(w.path_patterns);
    if (!patterns.length) continue;
    for (const f of files ?? []) {
      if (patterns.some((m) => workflowdetect.pathPatternMatches(f, m))) {
        addPath(f, w.id, 'workflow', workflowdetect.WORKS_ON);
      }
    }
  }

  return {
    version: TABLE_VERSION,
    stamp: stamp(root),
    builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    incomplete,
    paths: Object.fromEntries(paths),
    symbols: Object.fromEntries(symbols),
  };
}

/**
 * Write the table to disk: written beside the target then renamed into
 * place, so a reader never sees a half file — through `writeAtomic()`
 * (src/atomicwrite.mjs), the one way to write a state file.
 */
export function write(root, data = null) {
  const built = data || build(root);
  const target = path.join(root, TABLE_PATH);
  writeAtomic(target, JSON.stringify(built));
  return built;
}

/** Read the table without building it. `null` = absent, `{corrupt:true}` = not valid JSON. */
function read(root) {
  const target = path.join(root, TABLE_PATH);
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); } catch { return null; }
  let data;
  try { data = JSON.parse(raw); } catch { return { corrupt: true }; }
  if (data?.version !== TABLE_VERSION) return null;
  return data;
}

/**
 * Rebuild ONLY if the corpus has changed since the last build (same
 * guarantee as `backlinks.update()`). A maintenance path (CLI, a
 * scheduled job) — NOT the read path (`lookupPath()`/`lookupSymbol()`
 * below), which never rebuilds itself.
 */
export function update(root) {
  const now = stamp(root);
  const existing = read(root);
  if (existing && !existing.corrupt && existing.stamp === now) return existing;
  return write(root);
}

/** Rebuild from nothing — discards any existing table rather than checking it. */
export function rebuild(root) {
  return write(root);
}

// --- 5. read access -----------------------------------------------------

/** The shared frame for the four states — see the header comment for their meaning. */
function stateFrame(root) {
  const data = read(root);
  if (!data) {
    return {
      state: 'error', data: null,
      reason: 'no component table present — never built, or not valid JSON '
        + '(run componentTable.update() or rebuild())',
    };
  }
  if (data.corrupt) {
    return {
      state: 'error', data: null,
      reason: 'component table is damaged (not valid JSON) — run rebuild()',
    };
  }
  const now = stamp(root);
  if (data.stamp !== now) {
    return {
      state: 'warning', data,
      reason: `component table is stale — the corpus changed since ${data.builtAt} `
        + '(run update())',
    };
  }
  if (data.incomplete) {
    return {
      state: 'warning', data,
      reason: 'at least one source could not be fully read during the last build '
        + '(no git, or a read failed) — entries may undercount',
    };
  }
  return { state: 'ok', data, reason: null };
}

/**
 * Every entry about ONE path — any spelling, like `component.find()`.
 * Resolves the canonical table row(s) first (an exact two-segment suffix
 * match OR a base name with a `compatible()` check against the asked
 * prefix), then hands back the union of their entries. Four states like
 * `backlinks()`.
 */
export function lookupPath(root, p) {
  const frame = stateFrame(root);
  if (frame.state === 'error') return { state: 'error', path: p, entries: [], asOf: null, reason: frame.reason };
  const { data } = frame;
  const forms = component.forms(p);
  const [two, base] = forms.length === 2 ? forms : [null, forms[0]];
  const askedPrefix = component.prefix(p);
  const keys = Object.keys(data.paths);
  const hits = new Set();
  if (two) {
    for (const k of keys) if (k === two || k.endsWith(`/${two}`)) hits.add(k);
  }
  if (base) {
    // A bare question (no prefix): matches EVERY candidate with this
    // base name — the broadest yield, deliberately more generous than
    // the live match (see `component.mjs`'s header comment). For a
    // lookup table, "shown too much, marked `_form: 'base'`" is the
    // right side of the error to be on — a SILENT gap would be worse.
    // With a prefix: only candidates with the SAME prefix (same
    // standard as `component.compatible()`).
    for (const k of keys) {
      if (path.basename(k) !== base) continue;
      if (!askedPrefix || component.prefix(k) === askedPrefix) hits.add(k);
    }
  }
  const entries = [];
  const seen = new Set();
  for (const k of hits) {
    for (const e of data.paths[k]) {
      const key = `${k}:${e.id}:${e.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...e, path: k });
    }
  }
  if (frame.state === 'warning') {
    return { state: 'warning', path: p, entries, asOf: data.builtAt, reason: frame.reason };
  }
  if (!hits.size) {
    return {
      state: 'unknown', path: p, entries: [], asOf: data.builtAt,
      reason: `'${p}' was under no known path at the last build (${data.builtAt})`,
    };
  }
  return { state: 'ok', path: p, entries, asOf: data.builtAt, reason: null };
}

/** Every entry about ONE symbol — exact name, no aliases (a function name is not one). */
export function lookupSymbol(root, name) {
  const frame = stateFrame(root);
  if (frame.state === 'error') return { state: 'error', symbol: name, entries: [], asOf: null, reason: frame.reason };
  const { data } = frame;
  const entries = data.symbols[name] ?? [];
  if (frame.state === 'warning') {
    return { state: 'warning', symbol: name, entries, asOf: data.builtAt, reason: frame.reason };
  }
  if (!Object.hasOwn(data.symbols, name)) {
    return {
      state: 'unknown', symbol: name, entries: [], asOf: data.builtAt,
      reason: `'${name}' was not a known exported symbol at the last build (${data.builtAt})`,
    };
  }
  return { state: 'ok', symbol: name, entries, asOf: data.builtAt, reason: null };
}

// --- 5b. hook helper: table first, ranked and hydrated ----------------------
//
// **Parity with lucky-mem's `hook.mjs` R9 (`r9TabellenTreffer()`/
// `r9HoleMitTyp()`).** `mem-before-edit` (the pre-edit hook) cannot run
// the JS ranking/hydration itself — it is a POSIX shell script that
// shells out to the CLI — so that policy lives here instead, behind one
// function the CLI's `component --hook` flag calls. Same two rules as
// the lucky-mem original:
//
//   1. `guarded`/`fixed` outrank `mentioned` — but ONLY for `type:
//      'error'` (Bauplan R9, point 1: "guarded/fixed for errors >
//      mentioned" — for every other type the role is neither stronger
//      nor weaker evidence).
//   2. Ranking runs on the CHEAP id map BEFORE any entry is hydrated
//      (`findFullEntry()` re-scans a whole drawer per id) — hydrating
//      every table row for a heavily-mentioned file first, THEN
//      ranking, was measured slower than the live search it replaces on
//      the lucky-mem original; capping candidates before hydration is
//      what keeps this at or under that cost.

const HOOK_ROLE_RANK = Object.freeze({ guarded: 2, fixed: 2, mentioned: 1 });

/**
 * The same full entry `memory.find()`/`component.find()` would hand
 * back, but addressed by (id, type) instead of found by a text scan —
 * the table already knows the type, so only ONE drawer needs a look,
 * not all of `memory.TYPES`. `_source` gets the same relative log path
 * `component.find()` uses (via `memory.asSource`), so a caller cannot
 * tell a table-sourced hit from a live one by shape.
 */
function findFullEntry(root, id, type) {
  let projects;
  try { projects = memory.listProjects(root); } catch { projects = []; }
  for (const project of [null, ...projects]) {
    let it;
    try { it = memory.iterLog(root, type, { project }); } catch { continue; }
    let line = 0;
    for (const e of it) {
      line += 1;
      if (e && !e.__broken && e.id === id && !memory.isClosingLine(e)) {
        return { ...e, _source: memory.asSource(root, memory.logPath(root, type, project)), _line: line };
      }
    }
  }
  return null;
}

/**
 * The pre-edit hook's whole "table first" decision in one call:
 *
 *   - table fresh (`state: 'ok'`): rank+hydrate its rows (see above),
 *     `hits` is the ranked, hydrated list (candidates capped at
 *     `cap * 3` — the caller applies its own final `--top`).
 *   - table stale/missing (`'warning'`/`'error'`): `hits` is `null` —
 *     the CALLER falls back to `component.find()` unchanged — AND a
 *     background rebuild is kicked off (never awaited here).
 *   - table fresh but this path unknown to it (`'unknown'`): `hits` is
 *     also `null` (same live fallback), but NO rebuild is triggered —
 *     a fresh table simply not knowing one path is the ordinary case,
 *     not a sign the table itself is the problem.
 *
 * Read-only and non-blocking by construction: `lookupPath()` reads at
 * most the table file, `triggerBackgroundRebuild()` never waits on its
 * child, and hydration touches only the (capped) candidates that
 * survive ranking — never the whole corpus.
 */
export function beforeEditHits(root, queryPath, { cap = 3 } = {}) {
  const looked = lookupPath(root, queryPath);
  let backgroundRebuild = null;
  if (looked.state === 'warning' || looked.state === 'error') {
    try { backgroundRebuild = triggerBackgroundRebuild(root); } catch { backgroundRebuild = null; }
  }
  if (looked.state !== 'ok') {
    return { hits: null, tableState: looked.state, reason: looked.reason, backgroundRebuild };
  }
  const best = new Map(); // id -> { type, rank, role }
  for (const row of looked.entries) {
    if (!row || !row.id || !row.type || !row.role) continue;
    const rank = (row.type === 'error' ? HOOK_ROLE_RANK[row.role] : null) ?? 1;
    const have = best.get(row.id);
    // At equal rank the `works-on` row wins: a workflow both MENTIONS a
    // file and names it in `path_patterns` — the role carries that the
    // workflow is visible and claims the file (the hook shows only that).
    if (have && (have.rank > rank || (have.rank === rank && row.role !== workflowdetect.WORKS_ON))) continue;
    best.set(row.id, { type: row.type, rank, role: row.role });
  }
  const candidates = [...best.entries()].sort((a, b) => b[1].rank - a[1].rank).slice(0, cap * 3);
  const hits = [];
  for (const [id, { type, rank, role }] of candidates) {
    const full = findFullEntry(root, id, type);
    if (full) hits.push({ ...full, _rank: rank, _form: role });
  }
  hits.sort((a, b) => (b._rank - a._rank) || String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  return { hits, tableState: 'ok', reason: null, backgroundRebuild };
}

// --- 6. background rebuild --------------------------------------------------
//
// **The finding this answers.** `lookupPath()`/`lookupSymbol()`
// deliberately never build themselves — a build measures ~1.4 s on
// lucky-mem's reference corpus (`mem bauteil --neu`), far past any
// budget a PreToolUse hook may spend on one tool call. Without a
// separate nudge, a table that goes stale mid-session (or is simply
// missing in a fresh worktree/clone) stays stale forever, and the
// pre-edit hook runs in permanent fallback without anyone rebuilding it.
//
// **The answer: the same nudge, from wherever notices a stale/missing
// table** — not just at session start. This is the one shared
// mechanism for that: `mem-before-edit` calls it when `lookupPath()`
// answers `warning`/`error`; any other maintenance path (a CLI command,
// a scheduled job) can call it too instead of keeping a second copy of
// the same lock logic.
//
// **Never builds in the caller.** Like `neubau.mjs`'s search-index
// equivalent and this table's lucky-mem original: this function checks/
// sets a small lock file, then spawns a `detached`+`unref`'d child that
// does the real build — and returns immediately.
//
// **The lock: a file holding PID+time as its content**, not an atomic
// `mkdir` directory — so a session that looks can see WHOSE build is
// running. `fs.writeFileSync(..., { flag: 'wx' })` creates the file
// only if it does not exist yet — atomic, same race protection as an
// atomic `mkdir`, just with readable content instead of an empty
// directory.

/** Where the lock file for a running background rebuild lives. */
export const REBUILD_LOCK_PATH = path.join('.mem', 'component-table-rebuild.lock');

/** Where the background rebuild's `stdout`/`stderr` go. */
export const REBUILD_LOG_PATH = path.join('.mem', 'component-table-rebuild.log');

/**
 * How long a lock file is honoured before it counts as dead.
 *
 * The build itself measures ~1.4 s on lucky-mem's reference corpus (600
 * paths/291 symbols). 300 s (5 minutes) is generous — protects not the
 * build itself but against a child that dies without cleaning up
 * (e.g. `kill -9`), which would otherwise lock the table forever. A
 * rebuild retried too early is expensive; one retried too late only
 * costs a few more fallbacks, which this feature already covers anyway.
 */
export const REBUILD_LOCK_MAX_AGE_S = 300;

// lockAgeS / tryLock / releaseLock live in src/filelock.mjs — the one
// place for the O_EXCL + age logic (shared with the keyring and drawer locks).

/** Is a background rebuild running (going by the lock file)? Never throws. */
export function rebuildRunning(root) {
  return lockAgeS(path.join(root, REBUILD_LOCK_PATH)) <= REBUILD_LOCK_MAX_AGE_S;
}

/**
 * Block (bounded) until no background rebuild holds the lock any more.
 * For tests and maintenance that must remove or move the tree: the
 * detached child runs with the repository as its cwd and writes into
 * `.mem/`, and on Windows an `rmdir` under it fails with ENOTEMPTY/EBUSY
 * (CI run 37720774312). Returns true once idle, false on timeout. A short
 * grace after the lock is gone lets the child process actually exit.
 * Never throws; production paths never call it.
 */
export function waitForRebuildIdle(root, timeoutMs = 15000, graceMs = 150) {
  const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
  const deadline = Date.now() + timeoutMs;
  while (rebuildRunning(root)) {
    if (Date.now() >= deadline) return false;
    nap(25);
  }
  nap(graceMs);
  return true;
}

/**
 * Kick off a background rebuild if none is running — the one shared
 * function `mem-before-edit` (the pre-edit hook, on `warning`/`error`)
 * and any maintenance path use. Never builds itself (see above), never
 * waits on the child — a pure fire-and-forget nudge.
 *
 * Three outcomes, so the caller can tell "fallback, rebuild kicked off"
 * from "fallback, a rebuild is already running":
 *
 *   'started'    this call got the lock and started a child process
 *                that calls `update()`.
 *   'running'    a DIFFERENT, still-fresh lock file was already there —
 *                no second build, the concurrency guard held.
 *   'error'      the lock could not be created/read (e.g. `.mem` not
 *                creatable) or `spawn()` threw. Best effort: no build,
 *                but no hanging lock either (released right away).
 */
export function triggerBackgroundRebuild(root, env = process.env) {
  const lockPath = path.join(root, REBUILD_LOCK_PATH);

  if (!tryLock(lockPath)) {
    // Expired (a child died without cleaning up): take it over BY AGE
    // only (renamed away and re-checked, never blindly deleted), then
    // try once more.
    if (!takeOverIfStale(lockPath, REBUILD_LOCK_MAX_AGE_S)) return 'running';
    if (!tryLock(lockPath)) return 'running'; // someone else was faster
  }

  let logFd = null;
  try {
    const logPath = path.join(root, REBUILD_LOG_PATH);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logFd = fs.openSync(logPath, 'a');
  } catch { logFd = null; } // no log is no reason to drop the nudge

  try {
    const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
    // A separate child process, not an in-process call: `update()` can
    // take up to ~1.4 s (a full build), and this caller (the hook) must
    // not wait on that. `require` is available here on purpose: `node
    // -e '...'` runs as CommonJS without `--input-type=module` (same
    // shape as this house's other detached-child spawns), and a dynamic
    // `import()` still works inside it.
    const script = `import(${JSON.stringify(moduleUrl)}).then((t) => {
      try { t.update(process.env.CHEAP_MEM_ROOT); }
      catch (e) { try { console.error(String((e && e.stack) || e)); } catch {} }
      finally {
        try { require('node:fs').rmSync(process.env.CM_REBUILD_LOCK, { force: true }); } catch {}
      }
    }).catch((e) => { try { console.error(String((e && e.stack) || e)); } catch {} });`;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: root,
      env: { ...env, CHEAP_MEM_ROOT: root, CM_REBUILD_LOCK: lockPath },
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    });
    child.unref();
    return 'started';
  } catch {
    releaseLock(lockPath);
    return 'error';
  } finally {
    if (logFd != null) { try { fs.closeSync(logFd); } catch { /* fine */ } }
  }
}
