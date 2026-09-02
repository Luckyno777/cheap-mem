// hybrid.mjs — BM25 and semantic recall, fused.
//
// `mem find` (BM25) is the default: free, offline, sub-millisecond, and it
// already handles synonyms and compound words. It has exactly one blind
// spot — a true paraphrase with no shared word, where "things we learned
// the hard way" should reach a "learning" entry that shares no term with
// the query. Embeddings cover that case but cost a call and a network hop.
//
// Hybrid is the escalation that keeps the default cheap: run BM25, and —
// only when embeddings are actually configured — run the semantic search
// too and FUSE the two rankings. One entry surfaced by either ranker
// survives. When embeddings are not set up, hybrid is exactly BM25, at
// exactly BM25's cost. No silent dependency.
//
// Fusion is Reciprocal Rank Fusion (RRF): each ranker contributes
// 1/(k + rank) to an item's score. It needs no score normalisation across
// the two very different scales (BM25 magnitude vs. cosine similarity),
// which is what makes it robust — the ranks are all that matter.

import fs from 'node:fs';
import path from 'node:path';
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
 * cost, no error surfaced to the caller.
 */
export async function hybridSearch(index, query, {
  top = 10,
  candidateN = 20,
  semantic = null,
  searchOpts = {},
} = {}) {
  const bm = search(index, query, { top: candidateN, minScore: 0, ...searchOpts });

  let sem = null;
  if (semantic) {
    try { sem = await semantic(query, candidateN); }
    catch { sem = null; }
  }
  if (!sem || sem.length === 0) {
    // Pure BM25 path — shape the return to match fuse() so callers are uniform.
    return bm.slice(0, top).map((h) => ({ key: bmKey(h), hit: h, found_by: ['bm25'], score: 0 }));
  }
  return fuse(bm, sem, { top });
}

/**
 * Build the real semantic ranker for a memory root, or return null when
 * embeddings are not configured / no vectors are stored. Loads the embed
 * modules lazily so that a memory without embeddings never pays for them.
 */
export async function makeSemantic(root) {
  let embedmod, store, cfg, dim;
  try {
    embedmod = await import('./embed/index.mjs');
    // Only when the user deliberately ran `mem embed setup` — which writes
    // embed.json — do we attempt semantic recall. readConfig() otherwise
    // falls back to a default provider, which would make every hybrid query
    // fire a doomed network call (and mislabel the result as "semantic").
    if (!fs.existsSync(path.join(root, embedmod.CONFIG_PATH))) return null;
    cfg = embedmod.readConfig(root);
    dim = embedmod.dimensions(cfg.provider, cfg.model);
    store = await import('./embed/store.mjs');
  } catch {
    return null;
  }
  return async (query, n) => {
    const vector = await embedmod.embed(root, query, { cfg });
    const db = await store.open(root, dim);
    try {
      return store.search(db, vector, { top: n });
    } finally {
      try { db.close(); } catch { /* fine */ }
    }
  };
}
