// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * findcore — the ranked search of `mem find`, as ONE function for every door that asks the question
 * (abruf-budget, step 5 of the recall trunk). Port of lucky-mem's `finde`-Bahn of the search plan.
 *
 * **The finding before it.** `mem find` (CLI) and `mem_find` (MCP) each carried their own copy of "ask the
 * index": the CLI fetched three times as wide, put the EXACT lane (a named identifier) in front, dropped the
 * echo of the question (a raw capture that is the user's own sentence), re-ranked by MMR and applied the
 * retired/as-of gates; the MCP tool searched once with `top`, pinned the query to the memory's configured
 * language (the third divergence of `test/paths-agree.test.mjs`: score 10.879 against 1.808 for the same entry)
 * and had none of the other four. The same question gave different hits at the two doors.
 *
 * **Now.** The code between "fetch" and "gate" is this function; the CLI and the MCP tool call it and only
 * differ in what they hand in (the CLI's flags, the tool's arguments) and in how they print. What stays with the
 * callers: opening the index, the `word*` operator, the time router and the literal lane (CLI), the journal
 * lines, and the printing.
 *
 * Pure of output: it prints nothing and reads only the index it is given.
 */

import * as search from './search.mjs';
import * as retrieval from './retrieval.mjs';
import * as levers from './searchlevers.mjs';
import * as questionsplit from './questionsplit.mjs';
import * as requestframe from './requestframe.mjs';
import * as tiecut from './tiecut.mjs';
import * as variants from './variants.mjs';

/**
 * @param {object} o
 *   index, query (the words to rank, after any wildcard resolution), askedAs (the question as typed, for the
 *   echo filter), wanted (how many hits), type, project, capability, categoryTopics, since, noRaw, onlyRaw,
 *   withRetired, asOf, withEcho, mmr (false = pure BM25 order), mmrLambda, extraTerms, variants (list of
 *   rewordings), recall (the hook's flavour: request frame off, tie guard), weak (show a withheld answer), env
 * @returns {{ hits: object[], listed: object[], base: object[], withheld: number, gated: boolean }}
 */
export function rankedFind(o) {
  const { index, query, askedAs, wanted, asOf = null, since = null, categoryTopics = null, env = process.env } = o;
  const findCapability = o.capability ?? null;
  const withRetiredFlag = Boolean(o.withRetired);
  // `--as-of` needs superseded candidates to survive to `heldThen` below — `retrieval.blocksRecall` is what keeps the
  // OTHER retired states (done/discarded/obsolete/disputed) hidden even though the gate just opened for them too.
  const withRetiredForFetch = withRetiredFlag || Boolean(asOf);
  // **H1 (Block H, ported from lucky-mem): split the question.** Only
  // with the lever on (`mem search-levers`). Core words are searched,
  // common words ride along as damped by-catch that does not count in
  // coverage. `null` (no core word, no identifier) keeps the question as
  // it was. The exact lane and the echo filter below still see the
  // question as typed.
  let rankedQuery = query;
  let extraTerms = o.extraTerms ?? null;
  // **The request frame (port of lucky-mem's Bitt-Rahmen), recall hook only.**
  // "explain relativity" asks about relativity: "explain" is the form of the
  // request, not its subject (src/requestframe.mjs). Only the RANKED query
  // loses it; the exact lane, the echo filter and the time router below keep
  // the question as typed. A question that would be left without a content
  // word keeps the frame (better a vague search than none).
  if (o.recall && requestframe.requestFrameOn(env)) {
    const bare = requestframe.dropRequestFrame(rankedQuery);
    if (bare !== rankedQuery && search.contentWords(bare).length) rankedQuery = bare;
  }
  if (levers.active('h1', env)) {
    const built = questionsplit.buildQuery(rankedQuery, index);
    if (built) {
      rankedQuery = built.query;
      if (built.extraTerms) {
        extraTerms = new Map(extraTerms ?? []);
        for (const [t, w] of built.extraTerms) if ((extraTerms.get(t) ?? 0) < w) extraTerms.set(t, w);
      }
    }
  }
  // Caller-supplied rewordings (src/variants.mjs): each searched with
  // the same options, merged by rank fusion. Without them this is the
  // plain `search.search` call it always was.
  const variantList = Array.isArray(o.variants) ? o.variants : [];
  const searchFind = variantList.length
    ? (idx, q, opt) => variants.searchWithVariants(idx, q, variantList, opt)
    : search.search;
  const hits0 = searchFind(index, rankedQuery, {
    // Fetch wider, so enough remains after filtering.
    top: o.withEcho ? wanted : wanted * 3,
    type: o.type ?? null,
    project: o.project ?? null,
    capability: findCapability,
    topics: categoryTopics,
    since,
    noRaw: Boolean(o.noRaw),
    onlyRaw: Boolean(o.onlyRaw),
    withRetired: withRetiredForFetch,
    extraTerms,
    // h3's answer gate reads how much of the question each hit carries.
    withCoverage: levers.active('h3', env),
    // Deliberately NOT `language: cfg.language`. `cfg.language` is the
    // memory's configured DEFAULT (src/config.mjs, 'en' unless set), not
    // a per-query "the user asked for one language" signal — `find` has
    // no `--lang` flag to produce that signal in the first place, and it
    // is not in `find`'s checkFlags whitelist. Passing the config default
    // here pins `search()`'s QUERY tokenization to one stemmer pack (see
    // `search()`'s own `language` parameter: `const queryPacks = language
    // ? [pack(language)] : DETECTABLE_PACKS`), which defeats the
    // multi-pack detection that `retrieval.retrieve()` — the gateway —
    // always gets, because it never passes `language` to `search()` at
    // all.
    //
    // Measured 2026-09-20 on one index, one query, one entry:
    //   without `language`      score 10.879, rank 1
    //   with `language: 'en'`   score  1.808, rank last of 17
    // The second number matched the CLI's real output exactly. That was
    // the THIRD divergence between `mem find` and `retrieve()` — the
    // class test/paths-agree.test.mjs exists to catch, and did.
    //
    // The three `language: cfg.language` uses elsewhere in this file feed
    // `loadIndex(...)` and are unrelated: they pick the fallback lexicon
    // pack while BUILDING the index, not the query-side tokenization.
    // MMR on by default: keep the top-k from filling with near-duplicates.
    // --no-mmr restores pure BM25 order.
    mmr: o.mmr !== false,
    mmrLambda: Number.isFinite(o.mmrLambda) ? o.mmrLambda : 0.7,
  });
  // Drop the echo: the retrieval hook runs on every message and the stop
  // hook files every message as a raw capture, so the best hit for a
  // similar question is the user's own sentence from before. Measured on
  // 2026-09-05: 13 of 18 injected hits.
  // The decision of WHAT counts as an echo lives in search.isEchoHit —
  // the same call as in the gateway. Until 2026-09-06 there was a
  // separate version here that called `raw.excerpt`; that function
  // never existed, and every search that hit a raw capture crashed.
  // Nobody noticed, because it only sat behind `--no-echo` and nobody
  // set `--no-echo`. Exactly the class test/paths-agree.test.mjs
  // guards against.
  // Default: filter. Until 2026-09-06 this sat behind `--no-echo`, and
  // NOBODY set it — not even the retrieval hook, which is what
  // measured the 13 of 18. A defence that has to be switched on and
  // that nobody switches on is not a defence. `--with-echo` restores
  // the old behaviour.
  // Raw capture only: a typed entry is not the user's own question.
  // Without this restriction a short decision filed in the user's own
  // words gets dropped — measured on "payment only by prepayment"
  // against the question "payment prepayment decision".
  const filtered = o.withEcho
    ? hits0
    : hits0.filter((h) => !search.isEchoHit(askedAs, h));
  // The exact lane, as in the gateway. If the question names an
  // identifier that appears in at most `wanted` entries, that entry
  // goes to the front — independent of score. This is exactly why the
  // rule lives in `search.exactHits` and not here: `mem find` and
  // `retrieve()` have already diverged twice (see
  // test/paths-agree.test.mjs).
  // With the same bounds as the ranked search above. Until 2026-09-17
  // this lane took none — and because `mem find` merges it in FRONT,
  // --project, --type and --with-retired were not merely weakened but
  // overridden. The retrieval hook runs over exactly this path.
  const exactMatches = search.exactHits(index, query, wanted, {
    type: o.type ?? null,
    project: o.project ?? null,
    capability: findCapability,
    topics: categoryTopics,
    since,
    noRaw: Boolean(o.noRaw),
    onlyRaw: Boolean(o.onlyRaw),
    withRetired: withRetiredForFetch,
  });
  const exactIds = new Set(exactMatches.map((h) => h.entry?.id).filter(Boolean));
  // **BEFORE the cut, and on BOTH lanes.**
  //
  // Filtering after `.slice(0, wanted)` cannot bring back what the cut
  // already threw away — the same mistake was in the first version of
  // the body de-duplication in retrieval.mjs.
  //
  // And the exact lane needs it just as much: it is merged in FRONT,
  // so a filter on the ranked lane alone would not merely be weakened,
  // it would be overruled. That is exactly what happened here on
  // 2026-09-17 for --project/--type (see the comment above); repeating
  // it one line further down would be absurd.
  const heldThen = (h) => !retrieval.blocksRecall(h.retired, withRetiredFlag)
    && (!asOf || retrieval.validAt({ ...(h.entry ?? h), retired: h.retired ?? null }, asOf));
  const ordered = [...exactMatches.filter(heldThen),
    ...filtered.filter((h) => !exactIds.has(h.entry?.id)).filter(heldThen)];
  const base = ordered.slice(0, wanted);
  // **The cut with a guard for a tie (port of lucky-mem's Antwortschranke),
  // recall hook only** (src/tiecut.mjs): the first hit behind the cut that
  // scores within 1 % of the last one shown comes along, at most one. The
  // answer gate below decides on the hard cut `base` alone, so the extra hit
  // never turns a withheld answer into a shown one.
  const listed = o.recall ? tiecut.cutWithTie(ordered, wanted, tiecut.tieSpread(env)) : base;
  // **H3 (Block H, ported from lucky-mem): threshold by score gap, for
  // the answer as a whole.** A list in which no hit is exact, strong, or
  // clearly ahead of the second is a flat field of near-equal scores —
  // "how tall is mount kilimanjaro" answered with two "How we deploy"
  // notes because both carry "how". It is withheld, and said so; a list
  // in which ONE hit passes is shown unchanged, weaker hits included.
  // The rule and its calibration: `src/searchlevers.mjs` (occasion
  // `find`). `--weak` shows the list anyway.
  const gated = !o.weak && levers.active('h3', env)
    && !levers.answerHolds(base, { occasion: 'find', bar: levers.findBar(index.statsN ?? index.N) });
  const withheld = gated ? base.length : 0;
  for (const h of listed) delete h.covered;   // the gate's input, not part of the answer
  const hits = gated ? [] : listed;
  return { hits, listed, base, withheld, gated };
}
