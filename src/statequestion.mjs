// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * statequestion — freshness for questions that ask "what holds NOW".
 *
 * **The idea.** `mem find` already gives every document a mild recency
 * bonus (see `search.mjs`), and `freshness.mjs` resolves explicit
 * `timeline` facts by validity interval. Neither covers the ordinary
 * case: a question that asks about the STATE of something ("is X still
 * true", "what is the current status of Y") retrieves several entries
 * that share a `topic` — an old one and a newer one that supersedes it
 * in substance, without a formal `replaces_id` or `valid_until` ever
 * having been written. Ranked by relevance alone, the stale entry can
 * still outscore the fresh one on term match and sit above it.
 *
 * The fix asked for is narrow on purpose: only when the QUESTION itself
 * carries a state signal word (English by default — "current", "still",
 * "latest", ...) does search dampen the OLDER entries of a shared
 * `topic` among the hits, leaving the newest one at full strength. A
 * question with no such word is not touched at all: coordination and
 * coverage still decide who wins.
 *
 * **Language.** cheap-mem's users ask in whatever language they write
 * in (see `langbridge.mjs`), so the signal list is not baked into code:
 * it is a JSON file, English by default, and a deployment names its own
 * with `CHEAP_MEM_STATE_SIGNAL_WORDS` or `stateSignalWords` in
 * `.mem/config.json` — the same two knobs `userhabits.mjs` already uses
 * for its own pattern file, so a house that overrides one convention
 * already knows the other.
 *
 * **What "older" means here.** Only entries whose `ts` parses to a real
 * instant are compared at all. An entry with no readable timestamp is
 * left exactly as it was scored — never counted as the newest of its
 * topic, and never dampened as older than one. Guessing an age for it
 * would be inventing a signal that was never measured.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfgmod from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The shipped English defaults. */
export const DEFAULT_WORDS_FILE = path.join(HERE, 'state-signal-words.default.json');

/** How much an older same-topic hit is scaled by, once triggered. */
export const DAMPEN_FACTOR = 0.35;

/**
 * Where the signal-word file for this root is — env wins, then
 * `.mem/config.json`'s `stateSignalWords`, else `null` (the shipped
 * defaults). `null` is a real return value, not "not found" — mirrors
 * `userhabits.resolvePatternsPath`.
 */
export function resolveWordsPath(root, { env = process.env } = {}) {
  if (env.CHEAP_MEM_STATE_SIGNAL_WORDS) return path.resolve(env.CHEAP_MEM_STATE_SIGNAL_WORDS);
  if (root) {
    try {
      const cfg = cfgmod.readConfig(root);
      if (typeof cfg.stateSignalWords === 'string' && cfg.stateSignalWords.trim()) {
        return path.resolve(root, cfg.stateSignalWords);
      }
    } catch { /* no config yet — fall through to the shipped defaults */ }
  }
  return null;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Load, validate, and compile a signal-word file into a matcher.
 *
 * Never silently falls back on a broken CUSTOM file: a misconfigured
 * override should fail loudly, not quietly serve the defaults while
 * looking like it worked (same rule as `userhabits.loadPatterns`).
 *
 * Returns `{ words, test(query) }` — `words` for inspection/tests,
 * `test` a cheap `RegExp.test` closure. An empty or missing word list
 * is a real, working matcher that simply never fires.
 */
export function loadWords(wordsPath = null) {
  const file = wordsPath ?? DEFAULT_WORDS_FILE;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`statequestion: cannot read '${file}': ${e.message}`); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error(`statequestion: '${file}' is not valid JSON: ${e.message}`); }
  if (!data || !Array.isArray(data.words)) {
    throw new Error(`statequestion: '${file}' must be an object with a 'words' array`);
  }
  const words = [...new Set(data.words
    .filter((w) => typeof w === 'string' && w.trim())
    .map((w) => w.trim().toLowerCase()))];
  const pattern = words.length
    ? new RegExp(`\\b(?:${words.map(escapeRegExp).join('|')})\\b`, 'i')
    : null;
  return { words, test: (q) => Boolean(pattern && pattern.test(String(q ?? ''))) };
}

/** Does this question carry a state signal word? */
export function isStateQuestion(query, matcher) {
  return Boolean(matcher && matcher.test(query));
}

/**
 * Dampen older same-topic hits, in place, when the question asks about
 * the current state of something. Pure over its input beyond that
 * mutation — no clock, no disk, no randomness.
 *
 * `hits` is whatever `search()` already scored: each needs `.score` and
 * `.entry` with optional `.topic` / `.ts`. Hits without a `topic`, or
 * alone in their topic among these hits, are untouched — there is
 * nothing to compare them against. Within a topic group, the entry with
 * the LATEST readable `ts` is the anchor and keeps its score; every
 * other entry in the group whose `ts` also reads is scaled by `factor`.
 * An entry with no readable `ts` never enters the comparison at all —
 * not as the anchor, not as "older".
 */
export function applyTopicFreshness(hits, { factor = DAMPEN_FACTOR } = {}) {
  const groups = new Map();
  for (const h of hits) {
    const topic = typeof h.entry?.topic === 'string' ? h.entry.topic.trim() : '';
    if (!topic) continue;
    const t = Date.parse(h.entry?.ts ?? '');
    if (!Number.isFinite(t)) continue; // never treated as older or younger
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push({ h, t });
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue; // nothing of the same topic to compare against
    const newestT = Math.max(...members.map((m) => m.t));
    for (const m of members) {
      if (m.t < newestT) m.h.score *= factor;
      // ties at the newest timestamp all keep full strength — the same
      // "do not guess an order the data does not carry" rule as
      // `freshness.mjs`'s conflict handling.
    }
  }
  return hits;
}
