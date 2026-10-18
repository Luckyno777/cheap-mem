// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The version of the INDEX RULES: ONE number for everything that decides what ends up in the search index and with which
 * weight, apart from the bytes of the log lines themselves.
 *
 * **What counts as a rule** (anything that changes the documents or the term statistics built from the SAME lines):
 *   - the tokenizer and the language packs: normalisation, stemming, stopword lists, compound splitting and its linking
 *     characters (`src/language.mjs`, `tokenize*` in `src/search.mjs`);
 *   - the field set and the field weights (`src/bodyfields.mjs`, `FIELD_WEIGHTS`), the raw-capture weight and cap;
 *   - which lines are indexed at all: the shape rule (`memory.parseLine`, `src/fieldshape.mjs`), closing lines, retired
 *     entries;
 *   - which drawers are searched: `memory.SEARCH_TYPES` (`NOT_SEARCHED`);
 *   - the per-entry language decision and the expansion-only terms.
 * A change to any of these makes every index built before it WRONG although no log line changed: the file stamps still match,
 * so the cache would be served as it stands.
 *
 * **How it is used.** `src/indexcache.mjs` writes this number into the manifest (`indexRules`) AND compares it on read, from
 * this one constant, so build and read cannot disagree and no caller has to pass it. An index with another number, or with
 * none (built before the field existed), is stale: it is not used, a line on stderr says so, and it is rebuilt once.
 *
 * **Relation to `search.CACHE_VERSION`.** They answer different questions and stay apart. `CACHE_VERSION` is the FORMAT of the
 * files on disk (manifest keys, shard layout, what a document looks like); this number is the RULES that produced the content.
 * A format change that is also a rule change (version 15 and 16 were both) should raise both, but forgetting one can no longer
 * leave a stale index in use: the rules number has its own check below.
 *
 * **How a rule change cannot go unnoticed.** `test/index-rules.test.mjs` computes a fingerprint of the rules' BEHAVIOUR
 * (`test/fixture/index-rules-fingerprint.mjs`: packs, weights, field set, drawer set, and the index built from a fixed set of
 * lines) and compares it with the last entry of `test/fixture/index-rules-history.json`. Change a rule and the test is red until
 * a new entry with the next version is appended there AND this constant equals it. The fingerprint is of behaviour, not of
 * source text, so a refactor that changes nothing does not trip it.
 *
 * History (what changed at which number): 1 = the first numbered version (2026-10-18). Before it the cache carried only
 * `CACHE_VERSION`, so an index built under old rules was reused (reproduced: a cache built at 346dec9^ was served by 346dec9).
 */
export const INDEX_RULES_VERSION = 1;
