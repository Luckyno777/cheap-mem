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
// src/dashboard-cache.mjs) — no second freshness logic. While the store
// is unchanged a request costs only the substring pass; otherwise the
// index is rebuilt once (a single pass over the drawers).
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

/** The index from the rows of `readPass`: id -> search text (same id: merged). */
export function buildIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const e = row?.entry;
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    const t = searchText(e);
    index.set(e.id, index.has(e.id) ? `${index.get(e.id)}\n${t}` : t);
  }
  return index;
}

const STORE = new Map(); // root -> { key, index }

/** The query as it is searched: cut, lower-cased; `null` when empty. */
export function normalize(query) {
  const q = String(query ?? '').slice(0, QUERY_MAX).trim().toLowerCase();
  return q === '' ? null : q;
}

/**
 * The ids of every entry whose full text contains `query`. `null` for an
 * empty query. Throws when the store is unreadable (the caller turns that
 * into `measurable:false`).
 */
export function fulltextIds(root, query, {
  key = () => cache.generationStamp(root),
  readAll = (r) => dashboard.readPass(r).rows,
} = {}) {
  const q = normalize(query);
  if (q === null) return null;
  const k = key();
  let state = STORE.get(root);
  if (!state || state.key !== k) {
    state = { key: k, index: buildIndex(readAll(root)) };
    STORE.set(root, state);
  }
  const ids = [];
  for (const [id, text] of state.index) if (text.includes(q)) ids.push(id);
  return ids;
}

/** The route's answer. A failure is `measurable:false` with a reason, never `ids:[]`. */
export function answer(root, query, options = {}) {
  try {
    return { ids: fulltextIds(root, query, options), measurable: true };
  } catch (e) {
    return { measurable: false, reason: `full text not readable: ${e?.message || e}` };
  }
}

/** For probes only: forget the index. */
export function forget() { STORE.clear(); }
