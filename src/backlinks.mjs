// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// backlinks.mjs — who points, by a declared edge, at one id?
//
// ## The occasion (dashboard build plan E1.4)
//
// Until D1b, `dashboard.getEntryFast()` (src/dashboard.mjs, D1) could
// not see an incoming `derived_from` edge declared on an entry in a
// DIFFERENT drawer than the id's own. A complete
// backlink answer needs a pass through EVERY drawer of EVERY project,
// and that full pass is exactly the cost the single-entry route exists
// to avoid paying on every call.
//
// This module keeps an INCREMENTALLY MAINTAINED index on disk instead:
// id -> the entries that point at it by a declared edge. The index is
// not rebuilt on every read — it is rebuilt when the corpus has
// changed since the last build, and reused unchanged otherwise. Same
// pattern `search.loadIndex()` already uses for the search cache
// (generation stamp from size+mtime of every source file, an atomic
// write beside the target then renamed into place, rebuild-from-
// nothing as its own path) — see `src/indexcache.mjs` and
// `test/index-cache.test.mjs`/`test/atomic-cache.test.mjs` for the
// pieces reused here rather than reinvented: a much smaller
// application of it, deliberately. This register holds id -> sources,
// not a search vocabulary, so it stays one JSON file — no sharding, no
// jump index; `src/indexcache.mjs`'s sharded shape exists for a corpus
// that can approach V8's string-length wall (~978k entries measured),
// and a backlink map of `{kind, id}` pairs is nowhere near that for any
// corpus this house has measured.
//
// ## One truth for the edges
//
// Every edge comes from `net.linksOf()` — the SAME function
// `dashboard.mjs`'s `collect()` (the net view) and `getEntryFast()`
// (its own display edges) already read edges through. No second edge
// vocabulary (invariant: one-rule-one-place).
//
// ## Four states, never a silently empty answer
//
// `backlinks(root, id)` never answers with an empty `sources` list
// without saying WHY it might be empty — the same vocabulary choice as
// `dashboard.getEntryFast()`'s own contract (`ok`/`unknown`/`error`/
// `warning`), not invented fresh:
//
//   ok        cache is fresh, `id` was known at the last build (even
//             with 0 sources: a MEASURED zero, not ignorance — see
//             invariant leer-ist-kein-bestehen).
//   warning   cache exists but is STALE (the corpus changed since the
//             last build) or at least one broken line stood in the way
//             during the last build — the sources handed back can
//             undercount.
//   unknown   cache is fresh and saw no corruption, but this id was
//             nowhere in the corpus at the last build.
//   error     no readable cache at all (never built, or not valid
//             JSON) — with nothing built, there is nothing to say.
//
// ## Where this is wired in (D1b)
//
// `dashboard.getEntryFast()` reads `backlinks()` for `backlinks`/
// `contradictedBy` and the derived_from share of `cited`; when this
// answers anything but 'ok' it falls back to the locally visible edges
// and answers 'warning' with the reason from here. `bin/mem-serve`'s
// `/entry.json` branch keeps the register fresh (`update()` before the
// lookup, rebuild only when the corpus changed). Probe:
// test/backlinks-wired.test.mjs.

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as net from './net.mjs';
import { renameWithRetry } from './indexcache.mjs';

/** Where the register lives, relative to the memory root. */
export const BACKLINKS_PATH = path.join('.mem', 'backlinks.json');

/**
 * The format's version. A shape change bumps this and an old register
 * is discarded rather than migrated — same principle as `search.
 * CACHE_VERSION`: the register is derived and always rebuildable, never
 * the one copy of anything.
 */
export const BACKLINKS_VERSION = 1;

/** Every log file, every drawer x project — the full-pass population. */
function sourceFiles(root) {
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let file;
      try { file = memory.logPath(root, type, project); } catch { continue; }
      out.push({ file, type, project });
    }
  }
  return out;
}

/**
 * The generation stamp: size AND mtime of EVERY source file, counted
 * separately (not folded with `Math.max`) — same reasoning as `search.
 * corpusStamp()`: size alone (~10^3) would always lose to millisecond
 * time (~10^12), and a growth within the same millisecond would stay
 * invisible. `statSync` does NOT count as a file open (see probe (c)
 * in the test file) — only `readFileSync`/`openSync` do, and this
 * function calls neither.
 */
export function stamp(root) {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  for (const { file } of sourceFiles(root)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    files += 1;
    bytes += st.size;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return `${files}:${bytes}:${newest}`;
}

/**
 * The full pass: every entry in every drawer of every project, every
 * edge out of `net.linksOf()`. This is both the positive control
 * (probe a) and the register's own build path — one path, never two
 * that could drift apart.
 */
export function fullMap(root) {
  const map = new Map(); // id -> [{kind, id: from}]
  const at = (id) => {
    if (!map.has(id)) map.set(id, []);
    return map.get(id);
  };
  let broken = false;
  for (const { type, project } of sourceFiles(root)) {
    let it;
    try { it = memory.iterLog(root, type, { project }); } catch { continue; }
    for (const e of it) {
      if (e.__broken) { broken = true; continue; }
      if (!e || !e.id) continue;
      at(e.id); // every real id is a known key, even with no incoming edge
      for (const l of net.linksOf(e)) {
        at(l.to).push({ kind: l.kind, id: l.from });
      }
    }
  }
  return { map, broken };
}

/** Build the register (without writing it). */
export function build(root) {
  const { map, broken } = fullMap(root);
  return {
    version: BACKLINKS_VERSION,
    stamp: stamp(root),
    builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    incomplete: broken,
    map: Object.fromEntries(map),
  };
}

/**
 * Write the register to disk: written to a scratch file beside the
 * target, then renamed into place, so a reader never sees a half
 * file — same "write beside it, then rename" shape `search.mjs` and
 * `indexcache.mjs` already use for their own caches. Reuses `indexcache.
 * renameWithRetry` for the rename itself rather than a third copy of
 * its Windows-safe retry loop (see that function's own header for the
 * `EPERM` finding it guards against).
 */
export function write(root, data = null) {
  const built = data || build(root);
  const target = path.join(root, BACKLINKS_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(built), 'utf8');
  renameWithRetry(tmp, target);
  return built;
}

/** Read the register without building it. `null` = absent (or wrong
 * version — a schema this code no longer understands is treated the
 * same as no register at all), `{corrupt:true}` = not valid JSON. */
function read(root) {
  const target = path.join(root, BACKLINKS_PATH);
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); } catch { return null; }
  let data;
  try { data = JSON.parse(raw); } catch { return { corrupt: true }; }
  if (data?.version !== BACKLINKS_VERSION) return null;
  return data;
}

/**
 * Rebuild ONLY if the corpus changed since the last build — the same
 * guarantee `search.loadIndex(root, { fresh: false })` gives (see
 * `test/index-cache.test.mjs`). Unchanged: hands back the existing
 * register untouched, without re-reading the corpus. Changed, missing,
 * or corrupt: rebuilds and writes.
 *
 * A maintenance path (a hook, a CLI command, a scheduled job) — NOT the
 * read path `backlinks()` below, which deliberately never rebuilds
 * itself.
 */
export function update(root) {
  const now = stamp(root);
  const existing = read(root);
  if (existing && !existing.corrupt && existing.stamp === now) return existing;
  return write(root);
}

/** Rebuild from nothing — discards any existing register instead of
 * checking it first (probe d). */
export function rebuild(root) {
  return write(root);
}

/**
 * The one public question: who points, by a declared edge, at `id`?
 * On a hit, reads EXACTLY ONE file (the register itself) and stats
 * every source file for the generation stamp — never the corpus
 * itself (E1.4: no unboundedly growing full-pass on every single-entry
 * lookup). See the header comment above for the four states.
 */
export function backlinks(root, id) {
  const data = read(root);
  if (!data) {
    return {
      state: 'error', id, sources: [], asOf: null,
      reason: 'no backlinks cache present — never built, or not valid JSON '
        + '(run backlinks.update() or backlinks.rebuild())',
    };
  }
  if (data.corrupt) {
    return {
      state: 'error', id, sources: [], asOf: null,
      reason: 'backlinks cache is damaged (not valid JSON) — run backlinks.rebuild()',
    };
  }
  const now = stamp(root);
  if (data.stamp !== now) {
    const known = Object.hasOwn(data.map, id);
    return {
      state: 'warning',
      id,
      sources: known ? data.map[id] : [],
      asOf: data.builtAt,
      reason: `backlinks cache is stale — the corpus changed since ${data.builtAt}; `
        + 'sources from OTHER drawers/projects may be missing or out of date '
        + '(run backlinks.update())',
    };
  }
  if (data.incomplete) {
    const known = Object.hasOwn(data.map, id);
    return {
      state: 'warning',
      id,
      sources: known ? data.map[id] : [],
      asOf: data.builtAt,
      reason: 'at least one line could not be read while building the backlinks cache — '
        + 'sources may undercount',
    };
  }
  if (!Object.hasOwn(data.map, id)) {
    return {
      state: 'unknown', id, sources: [], asOf: data.builtAt,
      reason: `'${id}' was not present in the corpus at the last build (${data.builtAt})`,
    };
  }
  return { state: 'ok', id, sources: data.map[id], asOf: data.builtAt };
}
