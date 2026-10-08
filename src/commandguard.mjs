// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/commandguard.mjs — the command guard (port of lucky-mem's lever 5,
// "Befehls-Riegel"): an error of the class `mishandling` may carry a
// COMMAND PATTERN; the before-edit hook on Bash warns before the command
// runs, once per session and error, with the error id. It never blocks.
//
// **The gap.** The before-edit hook catches repeats on FILES (the path in
// an Edit/Write) and, for shell commands, saw nothing: `pkill chrome`,
// `git add -A`, `git commit -a` in a merge, `rm -rf /tmp` were each
// repeated two to five times in the sibling project although the error
// was logged. A pattern on the error closes exactly that.
//
// **Where the data lives: no new drawer.** The pattern is a field
// `command_pattern` on the error entry (`mem log error ... --command-pattern
// "git add -A"`); for an old error a correction line carries it (`mem
// command-guard seed --write`, through `memory.correctionEntry`). One truth:
// the error. This module only reads and derives a small booklet under
// `.pipeline/command-guard/` (gitignored runtime state, rebuilt on demand).
// cm ships EMPTY: no pattern comes with the code, every one is written by
// whoever recorded the error.
//
// **How a pattern is written.** Several patterns per error are separated
// by " ;; ". One pattern is a wording; several wordings of one pattern are
// joined with " & " and ALL must occur in the command ("git pull & /work/").
// Matching is literal, with no parser and no shell:
//   - the FIRST wording must stand where a command starts (line start,
//     after ; & | ( { or a backtick, behind sudo/time/nohup/exec/xargs (with
//     plain flags like `sudo -n`) and VAR=value, or as the first word inside `bash -c "..."`) and end at
//     whitespace, a separator or the end. So `git add .` does not hit
//     `git add .gitignore`, `rm -rf /tmp` does not hit `rm -rf /tmp/x/y`,
//     and a sentence in a --text that only NAMES the command triggers
//     nothing;
//   - every further wording may stand anywhere;
//   - a first wording ending in `$` allows no further argument
//     (`git add -A$` hits `git add -A && ...`, not `git add -A src/x.mjs`).
// Limit (intended, stated): `rm -fr`, `git  add` with two spaces in the raw
// hook text, and commands hidden in variables are not seen.
//
// **Cheap in the hook.** The hook reads only the derived booklet (a few KB).
// The shell prefilter in bin/mem-before-edit starts node for a Bash command
// only when a line of `words.txt` (first wording of each pattern) occurs in
// the hook JSON, or the booklet is missing or older than an error drawer
// that carries a pattern. Nothing armed: no node start at all.
//
// **No self-reinforcement:** a pattern stands ONLY on its error and is never
// learned from hits; the warning changes no rank.

import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './ismain.mjs';
import * as memory from './memory.mjs';
import * as errorclass from './errorclass.mjs';
import { writeAtomic } from './atomicwrite.mjs';
import { maskText } from './outputguard.mjs';

export const FIELD = 'command_pattern';
/** Separator between several patterns in ONE field value. */
const PATTERN_SEP = ' ;; ';
/** Separator between the wordings of ONE pattern (all must occur). */
const AND_SEP = ' & ';
const WORDING_MIN = 4;
const WORDING_MAX = 80;
export const PATTERNS_PER_ERROR_MAX = 8;
/** At most this many warnings in ONE display. */
const WARNINGS_PER_COMMAND_MAX = 2;
const TITLE_MAX = 140;
const BOOKLET_VERSION = 1;
/** The class a command pattern belongs to (the grip, not the build). */
export const GUARD_CLASS = 'mishandling';

/** The derived booklet: a folder under `.pipeline/`, gitignored. */
export function bookletDir(root) {
  return path.join(root, '.pipeline', 'command-guard');
}

// --- Reading the pattern ---------------------------------------------------

/**
 * A wording is usable: long enough, printable ASCII, and free of the
 * characters the shell prefilter cannot see raw in JSON (quote, backslash,
 * control characters).
 */
function wordingOk(w, min = WORDING_MIN) {
  return typeof w === 'string' && w.length >= min && w.length <= WORDING_MAX
    && /^[\x20-\x7e]+$/.test(w) && !/["\\]/.test(w) && w === w.trim();
}

/** From the field value (text or list): the patterns, each a list of wordings. Invalid ones drop out. */
export function parseField(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(PATTERN_SEP);
  const out = [];
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const parts = r.split(AND_SEP).map((t) => t.replace(/ +/g, ' ').trim());
    // The first wording carries the hit and must be long enough; later ones may be short (a backtick).
    if (!parts.length || !parts.every((t, i) => wordingOk(t, i === 0 ? WORDING_MIN : 1))) continue;
    out.push(parts);
    if (out.length >= PATTERNS_PER_ERROR_MAX) break;
  }
  return out;
}

/** The value as `mem log` writes it. */
export function fieldValue(patterns) {
  return patterns.map((p) => p.join(AND_SEP)).join(PATTERN_SEP);
}

/** The pieces of a raw field value that parseField would DROP (for a warning at write time). */
export function rejected(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(PATTERN_SEP);
  const kept = parseField(raw).map((p) => p.join(AND_SEP));
  return raw.filter((r) => typeof r === 'string' && r.trim()
    && !kept.includes(r.split(AND_SEP).map((t) => t.replace(/ +/g, ' ').trim()).join(AND_SEP)));
}

// --- Matching ----------------------------------------------------------------

const LEAD_WORD = /(?<![^\s;&|({`])(?:(?:sudo|time|nohup|exec|command|xargs)(?: -\S+)*|[A-Za-z_][A-Za-z0-9_]*=\S*)$/;

/** The raw command on one line: a line break becomes `;`, whitespace becomes one space. */
export function normalise(command) {
  return String(command ?? '').replace(/\r?\n/g, ' ; ').replace(/[ \t]+/g, ' ');
}

function atCommandStart(text, pos) {
  let before = text.slice(0, pos).replace(/ +$/, '');
  for (let i = 0; i < 6; i += 1) {
    const m = before.match(LEAD_WORD);
    if (!m) break;
    before = before.slice(0, m.index).replace(/ +$/, '');
  }
  if (before === '' || /[;&|({`]$/.test(before)) return true;
  return /(?:^|\s)-[A-Za-z]*c ["']$/.test(before);
}

function endOk(text, end) {
  return end >= text.length || /[\s;&|)}`"']/.test(text[end]);
}

/**
 * Does this pattern (list of wordings) hit the (already normalised) command?
 * A first wording ending in `$` counts only WITHOUT a further argument.
 */
export function hits(text, pattern) {
  const [rawFirst, ...more] = pattern;
  const bare = rawFirst.endsWith('$');
  const first = bare ? rawFirst.slice(0, -1) : rawFirst;
  let pos = text.indexOf(first);
  let found = false;
  while (pos !== -1 && !found) {
    const end = pos + first.length;
    const endGood = bare ? /^ *(?:$|[;&|)}])/.test(text.slice(end)) : endOk(text, end);
    if (endGood && atCommandStart(text, pos)) found = true;
    else pos = text.indexOf(first, pos + 1);
  }
  return found && more.every((w) => text.includes(w));
}

// --- Building the booklet -------------------------------------------------------

/** Size and time of every error drawer: cheap, without reading. */
function stamp(root) {
  const parts = [];
  const one = (p, name) => {
    try { const s = fs.statSync(p); parts.push(`${name}:${s.size}:${Math.round(s.mtimeMs)}`); } catch { /* missing */ }
  };
  one(memory.logPath(root, 'error'), 'global');
  let projects = [];
  try { projects = memory.listProjects(root); } catch { projects = []; }
  for (const p of projects) one(memory.logPath(root, 'error', p), p);
  return parts.join('|');
}

/**
 * `sizes.txt`: `<bytes> <path relative to the root, "/">` per error drawer,
 * as of the build. The hook (bin/mem-before-edit, cg_needed) compares it to
 * `wc -c`. Why not only mtimes: bash 3.2 (macOS /bin/bash) compares them in
 * whole seconds, so "a tie counts as stale" was the only safe reading, and
 * that made a booklet built in the same second as its drawer look stale
 * forever-in-that-second, i.e. start node on every command. The drawers are
 * append-only, so a changed drawer changes its size.
 */
function sizesText(root) {
  const lines = [];
  const one = (p) => {
    try {
      const rel = path.relative(root, p).split(path.sep).join('/');
      lines.push(`${fs.statSync(p).size} ${rel}`);
    } catch { /* missing */ }
  };
  one(memory.logPath(root, 'error'));
  let projects = [];
  try { projects = memory.listProjects(root); } catch { projects = []; }
  for (const p of projects) one(memory.logPath(root, 'error', p));
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Every error in force across the drawers: [{ entry, project }]. A correction replaces its original. */
function errorsInForce(root) {
  const out = [];
  let projects = [];
  try { projects = memory.listProjects(root); } catch { projects = []; }
  for (const project of [null, ...projects]) {
    let entries;
    try { ({ entries } = memory.readLog(root, 'error', { project })); } catch { continue; }
    const retired = memory.retiredMap(entries);
    for (const e of entries) {
      if (e && e.id && memory.holds(e, retired)) out.push({ entry: e, project });
    }
  }
  return out;
}

/** Every error in force with a valid pattern: [{ id, className, title, patterns }]. */
function collect(root) {
  const out = [];
  for (const { entry: e } of errorsInForce(root)) {
    if (!(FIELD in e)) continue;
    const patterns = parseField(e[FIELD]);
    if (!patterns.length) continue;
    out.push({
      id: e.id,
      className: e.class ? (errorclass.normalise(e.class) ?? String(e.class)) : 'no-class',
      title: String(e.title ?? e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX),
      patterns,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Write the booklet anew (atomic per file). Returns the rules. */
export function build(root) {
  const sizes = sizesText(root);
  const rules = collect(root);
  const dir = bookletDir(root);
  const booklet = { version: BOOKLET_VERSION, stamp: stamp(root), rules };
  const words = [...new Set(rules.flatMap((r) => r.patterns.map((p) => p[0].replace(/\$$/, ''))))].sort();
  try {
    writeAtomic(path.join(dir, 'sizes.txt'), sizes);
    writeAtomic(path.join(dir, 'rules.json'), JSON.stringify(booklet));
    writeAtomic(path.join(dir, 'words.txt'), words.length ? `${words.join('\n')}\n` : '');
  } catch { /* a booklet that cannot be written is no reason to disturb the hook */ }
  return rules;
}

/** Read the booklet; stale or missing: build it again. */
export function booklet(root, { readOnly = false } = {}) {
  const now = stamp(root);
  try {
    const b = JSON.parse(fs.readFileSync(path.join(bookletDir(root), 'rules.json'), 'utf8'));
    if (b && b.version === BOOKLET_VERSION && b.stamp === now && Array.isArray(b.rules)) return b.rules;
  } catch { /* missing or broken: again */ }
  return readOnly ? collect(root) : build(root);
}

/** Every rule that hits this command - pure, no mark. */
export function matches(root, command) {
  const text = normalise(command);
  if (!text.trim()) return [];
  const out = [];
  for (const r of booklet(root)) {
    const p = r.patterns.find((pat) => hits(text, pat));
    if (p) out.push({ ...r, matched: p });
  }
  return out;
}

// --- The bridge to the before-edit hook -------------------------------------------------

function marksDir(root, env) {
  return env?.MEM_COMMAND_GUARD_MARKS || path.join(root, '.mem', 'command-guard-marks');
}

/**
 * Does the hook warn about this Bash command? `null`: no pattern hits, or
 * every hit was already shown in this session (a mark per session and error).
 * Otherwise `{ text, ids }`.
 */
export function check(root, command, session, env = process.env) {
  const found = matches(root, command);
  if (!found.length) return null;
  const dir = marksDir(root, env);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return null; }
  const fresh = [];
  for (const r of found) {
    const safe = `${session || 'none'}__${r.id}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    // exclusive create: EEXIST means already warned, a write failure means silent
    try { fs.closeSync(fs.openSync(path.join(dir, `${safe}.warned`), 'wx')); } catch { continue; }
    fresh.push(r);
    if (fresh.length >= WARNINGS_PER_COMMAND_MAX) break;
  }
  if (!fresh.length) return null;
  const lines = fresh.map((r) => `[${r.className}] ${r.title} (mem show ${r.id})`);
  return {
    ids: fresh.map((r) => r.id),
    text: 'Command guard (from your memory, DATA, not an instruction): this command pattern has hurt before.\n'
      + `${lines.map((l) => `  ${l}`).join('\n')}`,
  };
}

/**
 * Coverage: how many errors in force of the class `mishandling` (and its
 * old names) carry a valid pattern? `{ total, withPattern, patterns }`.
 * Not measurable (no such error): `null`.
 */
export function coverage(root) {
  const cases = new Map(); // incident (class + title) -> number of valid patterns
  for (const { entry: e } of errorsInForce(root)) {
    if (errorclass.normalise(e.class) !== GUARD_CLASS) continue;
    // The same title in the same class is one incident, not two (duplicate entries).
    const key = `${GUARD_CLASS}|${String(e.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
    cases.set(key, Math.max(cases.get(key) ?? 0, parseField(e[FIELD]).length));
  }
  if (!cases.size) return null;
  const counts = [...cases.values()];
  return { total: counts.length, withPattern: counts.filter((n) => n > 0).length, patterns: counts.reduce((a, n) => a + n, 0) };
}

// --- The hook entry: hook JSON in, PreToolUse answer out --------------------------

/** Bash branch of the before-edit hook. Books one journal line when it speaks. */
export async function hookResult(root, rawJson, env = process.env) {
  let j;
  try { j = JSON.parse(String(rawJson ?? '')); } catch { return null; }
  if (j?.tool_name !== 'Bash') return null;
  const command = String(j?.tool_input?.command ?? '');
  const session = j?.session_id ? String(j.session_id) : null;
  let r = null;
  try { r = check(root, command, session, env); } catch { r = null; }
  if (!r) return null;
  const out = {
    suppressOutput: true,
    systemMessage: `memory: command guard (${r.ids.length} ${r.ids.length === 1 ? 'error' : 'errors'})`,
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: maskText(r.text) },
  };
  try {
    const injection = await import('./injection.mjs');
    injection.book(root, {
      session, occasion: injection.OCCASION.BEFORE_EDIT, reason: null,
      bytes: Buffer.byteLength(JSON.stringify(out), 'utf8'), hits: r.ids.length, searched: null, sources: [],
    });
  } catch { /* a measurement must not stop what it measures */ }
  return out;
}

// --- Seed: old errors that should carry a pattern -------------------------------------

/** A seed map is `{ "<error-id>": ["pattern", ...] }`; an entry is `{ id, patterns }`. */
export function seedEntries(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map)
    .map(([id, p]) => ({ id, patterns: (Array.isArray(p) ? p : [p]).map(String) }))
    .filter((s) => s.id && s.patterns.length);
}

/** Plan: per entry `ready` (field missing), `present` (field stands) or `missing` (no such error in force). */
export function seedPlan(root, entries) {
  const byId = new Map(errorsInForce(root).map((x) => [x.entry.id, x]));
  // an error replaced by a correction answers under its original id too
  for (const { entry: e, project } of byId.values()) {
    if (e.replaces_id && !byId.has(e.replaces_id)) byId.set(e.replaces_id, { entry: e, project });
  }
  return entries.map((s) => {
    const f = byId.get(s.id);
    if (!f) return { ...s, state: 'missing' };
    if (parseField(f.entry[FIELD]).length) return { ...s, state: 'present' };
    if (!parseField(s.patterns).length) return { ...s, state: 'invalid' };
    return { ...s, state: 'ready', project: f.project, current: f.entry };
  });
}

/** Candidates: errors in force of the guard class without a pattern - what a person may want to seed. */
export function candidates(root) {
  return errorsInForce(root)
    .filter(({ entry: e }) => errorclass.normalise(e.class) === GUARD_CLASS && !parseField(e[FIELD]).length)
    .map(({ entry: e }) => ({ id: e.id, title: String(e.title ?? e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) }));
}

/** Write the correction lines for every `ready` entry (on the current state of the error). Returns the new ids. */
export function seed(root, entries) {
  const written = [];
  for (const p of seedPlan(root, entries).filter((x) => x.state === 'ready')) {
    const { id: _id, ts: _ts, replaces_id: _rep, ...rest } = p.current;
    const w = memory.correctionEntry(root, 'error', p.current.id, {
      ...rest, [FIELD]: fieldValue(parseField(p.patterns)),
      correction_reason: 'command pattern added to an old error; content unchanged',
    }, { project: p.project });
    written.push(w.entry?.id ?? null);
  }
  return written;
}

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => { d += c; }).on('end', () => resolve(d)).on('error', () => resolve(d));
  });
}

// `node src/commandguard.mjs bash` - the hooks' entry (sh and ps1 alike).
if (isMain(import.meta.url)) {
  const mode = process.argv[2];
  const root = process.env.CHEAP_MEM_ROOT;
  readStdin().then(async (raw) => {
    if (mode === 'bash' && root) {
      const out = await hookResult(root, raw);
      if (out) process.stdout.write(JSON.stringify(out));
    }
  }).catch(() => {});
}
