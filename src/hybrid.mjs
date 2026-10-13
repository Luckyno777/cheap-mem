// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// hybrid.mjs — BM25 and semantic recall, fused.
//
// `mem find` (BM25) is the default: free, offline, sub-millisecond, and it
// already handles synonyms and compound words. It has exactly one blind
// spot — a true paraphrase with no shared word, where "things we learned
// the hard way" should reach a "learning" entry that shares no term with
// the query. Embeddings cover that case but cost a call and a network hop.
//
// Hybrid is the escalation that keeps the default cheap: run BM25, and —
// only when a LOCAL embedding model is configured — run the semantic
// search too and FUSE the two rankings. One entry surfaced by either
// ranker survives. When embeddings are not set up, hybrid is exactly
// BM25, at exactly BM25's cost. No silent dependency.
//
// Since 2026-10-13 no embedding provider is external (owner decision:
// no entry text goes to a vendor). A memory still configured for one gets
// the state `rejected` from `semanticPlan`, and every caller must SAY so
// when it falls back to lexical search; the fallback is never silent.
//
// Fusion is Reciprocal Rank Fusion (RRF): each ranker contributes
// 1/(k + rank) to an item's score. It needs no score normalisation across
// the two very different scales (BM25 magnitude vs. cosine similarity),
// which is what makes it robust — the ranks are all that matter.

import { search } from './search.mjs';

export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion over several ranked lists of keys.
 *
 * @param {string[][]} keyLists  each inner array is keys in rank order
 * @returns {Map<string, number>} key -> fused score (higher is better)
 */
export function rrf(keyLists, { k = RRF_K } = {}) {
  const scores = new Map();
  for (const list of keyLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const key = list[rank];
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return scores;
}

const bmKey = (h) => `${h.source}:${h.line}`;
const semKey = (h) => `${h.source_file ?? h.source}:${h.line_number ?? h.line}`;

/**
 * Fuse a BM25 hit list and a semantic hit list into one ranking.
 *
 * Pure: takes the two already-ranked lists and returns fused hits. The
 * returned objects keep the richer BM25 hit (it carries the parsed entry)
 * when a key appears in both; a semantic-only key is returned with its
 * own fields and `found_by: ['semantic']`.
 */
export function fuse(bmHits, semHits, { k = RRF_K, top = 10 } = {}) {
  const scores = rrf([bmHits.map(bmKey), semHits.map(semKey)], { k });

  const byKey = new Map();
  for (const h of bmHits) {
    const key = bmKey(h);
    byKey.set(key, { key, hit: h, found_by: ['bm25'] });
  }
  for (const h of semHits) {
    const key = semKey(h);
    const prior = byKey.get(key);
    if (prior) prior.found_by.push('semantic');
    else byKey.set(key, { key, hit: h, found_by: ['semantic'] });
  }

  return [...byKey.values()]
    .map((e) => ({ ...e, score: scores.get(e.key) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/**
 * Hybrid search over a built index.
 *
 * `semantic` is an async (query, n) => hit[] | null. Inject the real one
 * with makeSemantic(root); tests inject a mock. When it is null, returns
 * empty, or throws, hybrid degrades to plain BM25 — same result, same
 * cost. A throw is not swallowed unseen: it goes to `onSemanticError`,
 * so the caller can put it in the label instead of claiming "no hits".
 */
export async function hybridSearch(index, query, {
  top = 10,
  candidateN = 20,
  semantic = null,
  searchOpts = {},
  onSemanticError = null,
} = {}) {
  const bm = search(index, query, { top: candidateN, minScore: 0, ...searchOpts });

  let sem = null;
  if (semantic) {
    try { sem = await semantic(query, candidateN); }
    catch (e) {
      sem = null;
      if (onSemanticError) onSemanticError(e);
    }
  }
  if (!sem || sem.length === 0) {
    // Pure BM25 path — shape the return to match fuse() so callers are uniform.
    return bm.slice(0, top).map((h) => ({ key: bmKey(h), hit: h, found_by: ['bm25'], score: 0 }));
  }
  return fuse(bm, sem, { top });
}

/**
 * The semantic side of a search, and the honest reason when there is none.
 *
 *   { state: 'local', rank }           rank(query, n) -> hits, on this machine
 *   { state: 'not-configured'|'rejected'|'broken', rank: null, message }
 *
 * Loads the embed modules lazily so that a memory without embeddings
 * never pays for them. `message` is what to show the person; the caller
 * decides where (stdout label, stderr line, JSON field).
 */
export async function semanticPlan(root, opts = {}) {
  const embedmod = await import('./embed/index.mjs');
  const st = await embedmod.embedState(root, opts);
  if (st.state !== 'local') return { ...st, rank: null };
  let dim;
  try { dim = embedmod.dimensions(st.provider, st.model); }
  catch (e) { return { ...st, state: 'broken', reason: 'dimension', rank: null, message: `${e.message}; using lexical search` }; }
  const rank = async (query, n) => {
    const store = await import('./embed/store.mjs');
    const vector = await embedmod.embed(root, query, { cfg: st.cfg });
    const db = await store.open(root, dim);
    try {
      return store.search(db, vector, { top: n, provider: st.provider, model: st.model });
    } finally {
      try { db.close(); } catch { /* fine */ }
    }
  };
  return { ...st, rank };
}

/**
 * The ranker alone, or null when there is no local one. Kept for callers
 * that only want the function; anything that reports a mode should use
 * `semanticPlan` so it can say WHY there is none.
 */
export async function makeSemantic(root) {
  return (await semanticPlan(root)).rank;
}
