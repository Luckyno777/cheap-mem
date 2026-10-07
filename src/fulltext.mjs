// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// fulltext.mjs — the full-text search behind the search field of the
// knowledge view (2026-09-29).
//
// **The finding.** The dashboard ships only an excerpt per entry (the
// title + the FIRST non-empty content field, cut to 220 characters). The
// search field filtered only in that: a word that sits only in `why`, in
// `rationale`, in a later field or after character 220 found nothing
// (measured on the sibling's real store: ~19 % of the hits were missing
// against the old view, which searched EVERY field). Shipping the full
// text would have doubled the dashboard answer.
//
// **What happens here.** The server searches. `fulltextIds(root, q)`
// returns the ids of every entry whose WHOLE content (each string field,
// each tag, recursively in objects and arrays) contains the query as a
// substring — case-insensitive, like the local filter. No model, no
// ranking.
//
// **Freshness.** The index (id -> search text) is kept per store state,
// under the same key as the dashboard cache (`generationStamp`,
// src/dashboard-cache.mjs) — no second freshness logic.
//
// **F23 (2026-10-07): nothing here blocks the event loop any more.**
// Measured on the old state (synthetic, Node 24, in the sibling house): with
// 100k entries a cold build plus search held a timer back by ~140 ms, and a
// frequent substring returned every id in ONE answer (1.4 MB). Now:
//  1. Pages. `page()` returns at most `limit` ids (default 200, cap 1000)
//     and a cursor `<generation>.<position>`; the answer says `more:true/false`
//     (exact: the pass searches up to the (limit+1)-th hit). The cursor holds
//     only for the generation that issued it; afterwards `expired:true` and
//     the caller asks again from the start.
//  2. Time slices. The build (row by row from `dashboard.readRowsLazy`) and the search
//     hand the event loop back every ~SLICE_MS (`setImmediate`).
//  3. ONE shared rebuild (`build`) per key change, in slices. A request waits
//     for it (the loop stays free). The old index is NOT served meanwhile:
//     it would still show an entry that the new generation removed or made
//     unreadable (crypto-shred). `fresh` is therefore always true. Chosen
//     over a worker
//     thread: a worker must either ship the index back (a structured clone,
//     itself a block) or hold the search there too, and the probes inject
//     `readAll`/`key` (not transferable). Slices need none of that, and the
//     semantics stay the same `includes` search over the same text.
//
// Semantics are unchanged: literal substring search (lower-cased) over the
// full text of every entry, in order of creation; only the delivery is paged.
//
// **Not measurable is not null.** `answer()` returns `{ measurable:false,
// reason }` on a failure, never an empty list; an empty query means
// `ids:null` (no filter), not `[]` (nothing found).
//
// invariant: not-measurable-is-not-null

import * as dashboard from './dashboard.mjs';
import * as cache from './dashboard-cache.mjs';

/** The route path (bin/mem-serve). */
export const PATH = '/api/fulltext';

/** Longest query that is searched; more is cut off. */
export const QUERY_MAX = 200;

const DEPTH_MAX = 12;

/** Every string value (not numbers) of an entry, recursively, into `out`. */
function collect(value, out, depth = 0) {
  if (typeof value === 'string') { if (value) out.push(value); return; }
  if (depth >= DEPTH_MAX || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) collect(v, out, depth + 1); return; }
  for (const v of Object.values(value)) collect(v, out, depth + 1);
}

/** The search text of ONE entry: everything, lower-cased. */
export function searchText(entry) {
  const parts = [];
  collect(entry, parts);
  return parts.join('\n').toLowerCase();
}

/** The index from the rows of `dashboard.readRowsLazy`: id -> search text (same id: merged). */
export function buildIndex(rows) {
  const index = new Map();
  for (const row of rows) take(index, row);
  return index;
}

function take(index, row) {
  const e = row?.entry;
  if (!e || typeof e.id !== 'string' || !e.id) return;
  const t = searchText(e);
  index.set(e.id, index.has(e.id) ? `${index.get(e.id)}\n${t}` : t);
}

const STORE = new Map(); // root -> { key, gen, ids, texts, build }

/** Page size: default and cap (a request's `limit` is clamped to these). */
export const LIMIT_DEFAULT = 200;
export const LIMIT_MAX = 1000;
/** How long a pass may compute at a stretch before the event loop gets its turn. */
const SLICE_MS = 5;
const CHECK_EVERY = 64; // rows between two clock reads

const yieldLoop = () => new Promise((ok) => setImmediate(ok));
let generations = 0;

/** The query as it is searched: cut, lower-cased; `null` when empty. */
export function normalize(query) {
  const q = String(query ?? '').slice(0, QUERY_MAX).trim().toLowerCase();
  return q === '' ? null : q;
}

/** `limit` from the request: an integer in 1..LIMIT_MAX, else the default. */
function clampLimit(limit) {
  const n = Number.parseInt(limit, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, LIMIT_MAX) : LIMIT_DEFAULT;
}

/** Builds in slices from a (possibly lazy) sequence of rows; the same id is merged. */
async function buildIndexSliced(rows) {
  const index = new Map();
  let t0 = performance.now(), n = 0;
  for (const row of rows) {
    take(index, row);
    if (++n % CHECK_EVERY === 0 && performance.now() - t0 > SLICE_MS) { await yieldLoop(); t0 = performance.now(); }
  }
  return { ids: [...index.keys()], texts: [...index.values()] };
}

/** Start the rebuild for `key` (or return the running one). */
function startBuild(root, state, key, readAll) {
  if (state.build && state.build.key === key) return state.build.promise;
  const build = { key };
  build.promise = (async () => {
    try {
      await yieldLoop(); // compute only after the triggering request has been answered
      const { ids, texts } = await buildIndexSliced(readAll(root));
      // Only the newest rebuild may swap (if a newer key came meanwhile, this one lapses).
      if (state.build === build) { state.key = key; state.gen = `g${++generations}`; state.ids = ids; state.texts = texts; }
    } finally {
      if (state.build === build) state.build = null;
    }
  })();
  state.build = build;
  return build.promise;
}

/**
 * The index for the CURRENT key. Never an old one: an old index would still
 * show an entry that a newer generation removed or made unreadable (a
 * destroyed key, a shredded body) — a leak of exactly what was just
 * destroyed. A generation change therefore waits for the rebuild (one shared
 * build, in slices: the event loop stays free, only this request waits).
 * The key is read again per round, so a build that lapsed for a newer key
 * is followed instead of restarted with a stale key.
 */
async function getState(root, keyOf, readAll) {
  let state = STORE.get(root);
  if (!state) { state = { key: null, gen: null, ids: null, texts: null, build: null }; STORE.set(root, state); }
  for (;;) {
    const key = keyOf();
    if (state.ids && state.key === key) return { state, fresh: true };
    await startBuild(root, state, key, readAll); // throws on a read failure
  }
}

/** The pass over the index from `from`: up to the (limit+1)-th hit, in slices. */
async function pass(state, q, from, limit, aborted) {
  const { ids: all, texts } = state;
  const n = all.length, ids = [];
  let t0 = performance.now();
  for (let pos = from; pos < n; pos++) {
    if (texts[pos].includes(q)) {
      if (ids.length === limit) return { ids, more: true, cursor: pos };
      ids.push(all[pos]);
    }
    if ((pos + 1) % CHECK_EVERY === 0 && performance.now() - t0 > SLICE_MS) {
      await yieldLoop();
      if (aborted?.()) throw new Error('aborted');
      t0 = performance.now();
    }
  }
  return { ids, more: false, cursor: null };
}

/**
 * One page of hits: `{ ids, more, cursor, generation, fresh }`, or
 * `{ expired:true }` (the cursor belongs to another generation / is
 * unreadable), or `null` for an empty query. Throws when the store is
 * unreadable (the caller turns that into `measurable:false`).
 */
export async function page(root, query, {
  limit = LIMIT_DEFAULT,
  cursor = null,
  key = () => cache.generationStamp(root),
  readAll = (r) => dashboard.readRowsLazy(r),
  aborted = null,
} = {}) {
  const q = normalize(query);
  if (q === null) return null;
  const { state, fresh } = await getState(root, key, readAll);
  let from = 0;
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    const m = /^(g\d+)\.(\d+)$/.exec(String(cursor));
    if (!m || m[1] !== state.gen || Number(m[2]) > state.ids.length) return { expired: true, generation: state.gen, fresh };
    from = Number(m[2]);
  }
  const r = await pass(state, q, from, clampLimit(limit), aborted);
  return { ids: r.ids, more: r.more, cursor: r.more ? `${state.gen}.${r.cursor}` : null, generation: state.gen, fresh };
}

/** The route's answer. A failure is `measurable:false` with a reason, never `ids:[]`. */
export async function answer(root, query, options = {}) {
  try {
    const p = await page(root, query, options);
    if (p === null) return { ids: null, measurable: true };
    if (p.expired) return { ...p, ids: [], more: false, cursor: null, measurable: true };
    return { ...p, measurable: true };
  } catch (e) {
    return { measurable: false, reason: `full text not readable: ${e?.message || e}` };
  }
}

/** For probes only: waits until a running rebuild of this root is done (errors are swallowed). */
export async function waitForBuild(root) {
  const b = STORE.get(root)?.build;
  if (b) await b.promise.catch(() => {});
}

/** For probes only: forget the index. */
export function forget() { STORE.clear(); }
