// src/retrieval.mjs — the gateway. Structured claims out, never prose.
//
// Named in the round-two audit as the single change with the largest
// effect, because one change addresses four failure classes at once:
//
//   injection      nothing here emits a directive-shaped string. A caller
//                  who wants prose has to build it, at their own
//                  authority, from fields that are labelled.
//   authority      the tier is present where ranking and conflict
//                  decisions happen, instead of being looked up later or
//                  not at all.
//   scope leakage  the boundary travels WITH the result rather than being
//                  an argument someone forgot.
//   explainability the reasons are already computed; returning them costs
//                  nothing and there is no model involved.
//
// `search()` stays exactly what it was: a ranker over an index. This is
// the layer above it that decides what a caller is allowed to see, and it
// fails closed — no capability, no results.

import crypto from 'node:crypto';
import * as authority from './authority.mjs';
import { deriveState, statusOf } from './state.mjs';
import * as capabilityMod from './capability.mjs';
import { loadIndex, search, isEchoHit, exactHits, corpusGeneration } from './search.mjs';

/**
 * Resource bounds (I13). Defaults, not laws — but never unbounded.
 *
 * An unbounded default is how one oversized claim becomes an oversized
 * context, and how one prolific author becomes the whole answer. Each
 * number below is a policy; having one at all is the point.
 */
export const LIMITS = Object.freeze({
  queryChars: 2000,        // a query longer than this is a paste, not a question
  maxResults: 50,          // hard ceiling regardless of what a caller asks for
  bodyChars: 4000,         // per claim, in the RETURNED record only
  contextChars: 24000,     // total across all returned bodies
  perAuthorShare: 0.5,     // no single sub-user author may exceed this share
});

/**
 * How much of the search space this answer actually covered.
 *
 * **Why an answer needs this at all.** "Nothing found" and "nothing
 * exists" are different sentences, and only one of them is ever
 * provable from a ranked search. Until now the gateway returned
 * `truncated: true|false` — two states for a three-state question, and
 * the missing third is the one that matters: *we could not establish
 * what the search space was.*
 *
 * The rule this encodes, in one line:
 *
 *     found evidence  ≠  complete evidence
 *     no finding      ≠  proof of absence
 *
 * **`known_complete` does NOT mean "X does not exist".** It means: no
 * limit cut this answer, so within THIS memory and THIS query nothing
 * known was withheld. A different query would ask a different question.
 * Anyone turning a complete answer into "there is no such thing" has
 * made a claim the memory never made.
 *
 * Deliberately not a number. A coverage score would invite comparing
 * 0.8 against 0.9, and neither would say WHICH limit bit. `reasons`
 * names them.
 */
export const COVERAGE = Object.freeze({
  COMPLETE: 'known_complete',   // no limit bit; everything matching was returned
  PARTIAL: 'known_partial',     // something was cut, and we know what
  UNKNOWN: 'unknown_coverage',  // the search space could not be established
});

/**
 * Decide the coverage from what actually happened during the retrieval.
 *
 * Order matters: UNKNOWN beats PARTIAL beats COMPLETE. A run that could
 * not establish its search space must never report a mere partial —
 * that would read as "we looked and found some", when we did not look.
 */
export function coverageOf({ reasons = [] } = {}) {
  const unknown = reasons.filter((r) => r.kind === 'unknown');
  if (unknown.length) return { state: COVERAGE.UNKNOWN, reasons };
  if (reasons.length) return { state: COVERAGE.PARTIAL, reasons };
  return { state: COVERAGE.COMPLETE, reasons: [] };
}

/** A claim as it leaves the memory. Fields only — no assembled text. */
function toClaim(hit, { bodyChars, state }) {
  const e = hit.entry;
  const body = bodyOf(e);
  const truncated = body.length > bodyChars;

  // Status comes from the LOG, via deriveState — never from the index.
  //
  // Two bugs, one lesson. The first version recomputed status from the
  // returned HITS, so a retirement whose line did not match the query was
  // invisible. The second read it from `doc.retired` in the index, which
  // is correct over the whole corpus but lives in `.mem/search-index.json`
  // — gitignored, unsigned, outside the merge driver, outside the epoch
  // watermark, invisible to git review. Editing that file changed what the
  // memory considered active, both ways: a disputed poisoning claim served
  // as active, and a genuine user claim suppressed. Measured 2026-09-05.
  //
  // A cache had become the source of truth about MEANING, not speed. So:
  //
  //   the log decides what is TRUE
  //   the index decides only what is FAST TO FIND
  //
  // 174 ms per derivation at 100 000 entries — the same order as the
  // search it accompanies, and three orders of magnitude above the corpus
  // this was built for. Correctness is worth that; the alternative is a
  // security rule guarded by an unsigned local file.
  const claimState = statusOf(state, e.id);
  return {
    id: e.id ?? null,
    type: e.type ?? hit.type ?? null,
    body: truncated ? body.slice(0, bodyChars) : body,
    bodyTruncated: truncated,
    author: authority.authorOf(e),
    authority: authority.tierOf(e),
    scope: capabilityMod.scopeOf({ project: hit.project ?? e.project ?? null }),
    project: hit.project ?? e.project ?? null,
    topic: e.topic ?? null,
    // Which identifiers the query hit literally. Present means: this claim
    // is here not because of a score, but because the query named it by
    // its own identifier. Anyone applying a threshold must exempt it —
    // otherwise the similarity threshold cuts away the certainties.
    ...(hit.exact ? { exact: hit.exact } : {}),
    ts: e.ts ?? null,
    valid_from: e.valid_from ?? null,
    valid_until: e.valid_until ?? null,
    status: claimState,
    score: hit.score,
  };
}

/**
 * Fields that carry an entry's CONTENT, in the order they are read.
 *
 * **The finding (external audit, 2026-09-17).** Six entries, each with
 * its content in the field its own type uses — `learning`, `duty`,
 * `question`, `skill`, `excerpt`, `rule` — were all indexed and all
 * findable. Structured retrieval returned ONE of them, with an empty
 * body, and discarded the other five as duplicates of it: every body
 * was the empty string, so every body was "identical".
 *
 * The cause was this list. It knew `choice`, `why`, `title`, `text` and
 * `fact` and nothing else, while the indexer (`search.FIELD_WEIGHTS`)
 * knew eighteen fields. A type whose content lives anywhere else was
 * searchable and unreadable at the same time — the class
 * `built-but-out-of-reach`, the same one `symbols` had on 2026-09-09.
 *
 * The order of the original five is unchanged, so nothing that worked
 * reads differently; the typed statement fields sit beside `choice`,
 * because that is what they are.
 *
 * `NON_BODY_FIELDS` is the other half, and it is what keeps this list
 * honest: every field the indexer knows is in exactly one of the two,
 * and `test/audit-koerper.test.mjs` fails when a nineteenth appears in
 * neither. A field that is neither read nor deliberately excluded is
 * how this defect happened the first time.
 */
export const BODY_FIELDS = Object.freeze([
  'choice', 'learning', 'duty', 'rule', 'question', 'skill',
  'why', 'title', 'text', 'fact', 'description', 'excerpt', 'rejected',
]);

/**
 * Indexed, on purpose not part of the body: access words, not prose.
 *
 * `tags`, `asked`, `symbols` and `class` are handles somebody attached
 * so the entry can be FOUND; repeating them in the body spends context
 * on words the reader did not ask for. `topic` is carried as its own
 * field on the claim already.
 */
export const NON_BODY_FIELDS = Object.freeze(['topic', 'class', 'tags', 'asked', 'symbols']);

/**
 * The text of an entry, assembled from its own fields in a fixed order.
 *
 * Note what this is NOT: it does not add framing, headings, or any word
 * the entry did not contain. A memory that decorates its own content is a
 * memory that can be made to say something.
 */
function bodyOf(e) {
  const parts = BODY_FIELDS.map((f) => e?.[f]).filter(
    (x) => typeof x === 'string' && x.trim());
  return parts.join(' — ');
}

/** Is a claim valid at `asOf`? Absent bounds mean open-ended. */
export function validAt(claim, asOf) {
  if (!asOf) return true;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return true;
  const from = claim.valid_from ? Date.parse(claim.valid_from) : null;
  const until = claim.valid_until ? Date.parse(claim.valid_until) : null;
  if (Number.isFinite(from) && t < from) return false;
  // `valid_until` is EXCLUSIVE: a claim valid until the 1st does not hold
  // on the 1st. Stated because half of all interval bugs are this choice
  // left unstated.
  if (Number.isFinite(until) && t >= until) return false;
  return true;
}

/**
 * Retrieve claims a capability is entitled to see.
 *
 * Returns a structure. Every exclusion is recorded with a reason, because
 * "why was this NOT returned" is the question no memory system answers and
 * the one an agent developer actually has.
 */
export function retrieve(root, query, capability, {
  top = 10,
  asOf = null,
  type = null,
  withDisputed = false,
  limits = LIMITS,
  index = null,
  // Paging. `cursor` wins over a bare `offset` — it carries the
  // generation, and a page that cannot prove which snapshot it belongs
  // to is not a page.
  cursor = null,
  // Default matches `mem find`. Overridable so a caller that wants pure
  // relevance order gets it — and so a test can compare both paths.
  mmr = true,
  mmrLambda = 0.7,
  // Drop echoes: a hit that is essentially the question itself.
  //
  // isEcho has existed since 2026-09-05, is tested and justified by a
  // measurement (13 of 18 fed-in hits were echoes) — and was called by
  // NOTHING. In `mem find` it sits behind `--no-echo`, which nobody sets;
  // the retrieval hook that measured the 13/18 does not set it either.
  // The defence against the measured problem was dead code.
  //
  // Default on, because the gateway is the automatic path: nobody can
  // intervene there, and a block that hands someone their own question
  // back gets skimmed over after the third time — and then the whole
  // retrieval is gone.
  dropEcho = true,
  rawReserve = true,
} = {}) {
  // **Two reasons to be excluded — and they are not the same.**
  //
  // `eligibility`  This claim is not available to this caller: outside
  //                capability, superseded, wrong type, echo of the
  //                question, duplicate. A second page would not bring it
  //                either.
  // `capacity`     It would be available, there was simply no room: the
  //                context budget was full, or one author's quota was.
  //
  // Why this is kept apart: `hasMore` used to come only from the
  // selection loop breaking early. Measured on the eval corpus (861
  // documents, real task, top=50): `hasMore: false` while 119 claims were
  // missing — **110 of those for budget reasons alone**. A caller reading
  // `hasMore` as "there is nothing more" was misinformed, and that is
  // exactly what the field is named for.
  const excluded = [];
  const note = (id, why, kind = 'eligibility') => excluded.push({ id: id ?? null, why, kind });

  // Fail closed. Not a thrown error: a caller with no capability asking a
  // question should get an empty, explained answer rather than a stack
  // trace it might log somewhere with the query in it.
  if (!(capability instanceof capabilityMod.Capability)) {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'no capability presented' }],
      scopes: [], truncated: false, limits,
      // Not "complete": nothing was searched. An empty answer that
      // reports full coverage is the exact lie this field exists against.
      coverage: coverageOf({ reasons: [{ kind: 'unknown', why: 'no capability presented' }] }),
    };
  }
  if (!capability.has('read')) {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'capability does not carry read' }],
      scopes: capability.scopes, truncated: false, limits,
      coverage: coverageOf({ reasons: [{ kind: 'unknown', why: 'capability does not carry read' }] }),
    };
  }

  const q = String(query ?? '');
  const qCapped = q.length > limits.queryChars;
  const useQuery = qCapped ? q.slice(0, limits.queryChars) : q;

  const idx = index ?? loadIndex(root);
  const want = Math.min(Math.max(1, Number(top) || 1), limits.maxResults);

  // This run's generation. It binds the cursor to a snapshot — see
  // encodeCursor.
  const generation = corpusGeneration(root);
  // A cursor is ACKNOWLEDGED and rejected, rather than ignored. Silently
  // falling back to page 1 would be an answer to a question nobody asked
  // — and it would look like success.
  if (cursor != null && cursor !== '') {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'paging is not offered' }],
      scopes: capability.scopes, truncated: false, limits, generation,
      hasMore: false,
      coverage: coverageOf({ reasons: [{
        kind: 'unknown',
        why: 'paging is not offered — ask again with a larger top (bounded by maxResults)',
      }] }),
    };
  }
  // **The selection size is `want`, and it stays `want`.**
  //
  // How this was arrived at is the point. For page-by-page browsing this
  // was first set to `offset + want + 1` — that delivered one claim on
  // page 2 AND on page 3, because the author quota and the context budget
  // operate on the SELECTION, not the corpus: a different selection size
  // means different survivors, means shifted offsets.
  //
  // Then set to a constant `maxResults + 1` — pages lined up, and FOUR
  // existing probes failed. They were positive controls: "MMR changes
  // nothing here, so the comparison proves nothing." At a selection of
  // 51, everything comes in anyway on a small fixture, so MMR no longer
  // changed the selection. And that is exactly MMR's job here: it
  // decides WHO gets looked at (measured 7/18 -> 9/18 on the eval
  // corpus). The same applies to the flood defence, which came out of a
  // real attack on 2026-09-05.
  //
  // So: a measured defence was traded for a convenience feature, quietly,
  // and only caught because the old probes were positive controls.
  // Reverted. What remains is the honest disclosure `hasMore` — it costs
  // nothing, because it follows from the selection loop breaking early
  // rather than from a larger selection. Anyone who wants to see more
  // asks with a larger `top`; there is no cursor, because in this design
  // one could only be had with a selection that depends on the page.
  const selectWant = want;

  // Over-fetch, because scope, validity and quota all remove candidates
  // after ranking. Bounded by maxResults so this cannot become the DoS it
  // is meant to prevent.
  // Candidates are generated PER AUTHORITY TIER, then merged in tier order.
  //
  // The measured failure this fixes (bench/byzantine.mjs, 2026-09-05): a
  // writer who breaks no rule — own scope, own tier, no supersession,
  // every body distinct — wrote 20 000 plausible claims about one subject.
  // A single `user`-tier claim stating the truth was NOT RETURNED AT ALL.
  // It never entered the candidate set: sixty higher-scoring near-variants
  // filled it first, and no policy applied afterwards can recover a claim
  // that was never a candidate. The author-share cap could only halve an
  // answer that was already entirely the attacker's.
  //
  // Per-tier candidates give REPRESENTATION, not precedence: a `user`
  // claim that matches at all reaches the answer regardless of how much
  // lower-tier noise exists, and within the answer relevance still orders.
  // Precedence would be the other error — it would bury a genuine agent
  // finding under a stale user note. Tier decides only where claims
  // CONFLICT; here it decides only who gets looked at.
  //
  // `withRetired: true` on purpose. search() would otherwise drop
  // superseded and disputed claims itself, one layer down and without a
  // word — and then this gateway could not say WHY something is missing.
  const perTier = Math.min(selectWant * 6, limits.maxResults * 6);
  const seenIds = new Set();
  const byTier = [];
  // Every limit that actually bit, collected as it happens rather than
  // guessed at the end. A reason nobody recorded cannot be reported.
  const coverageReasons = [];
  if (qCapped) {
    // The whole question was not even asked. Nothing about the search
    // space follows from an answer to a truncated query.
    coverageReasons.push({ kind: 'unknown', why: `query truncated at ${limits.queryChars} chars` });
  }
  // Tiers whose candidate pool came back FULL. More may have matched
  // than were ever looked at, and no policy applied afterwards can
  // recover a claim that was never a candidate.
  const tiersAtCap = [];
  for (const tier of authority.TIERS) {
    const hits = [];
    // MMR on, with the same lambda as `mem find`.
    //
    // Until 2026-09-06 nothing stood here, and `search()` defaults to
    // `mmr: false`. `bin/mem find` turns it on — the gateway did not. That
    // made the AGENT PATH (mem retrieve, MCP mem_retrieve) worse than the
    // human path: pure BM25 order, with a dozen near-duplicates of the
    // same topic filling the hit list while the answer to the actual
    // question sat below them.
    //
    // Measured on the eval corpus: the sought claim was in the top-5
    // without MMR for 7 of 18 tasks, and with MMR for 9 of 18.
    //
    // The reordering acts on the SELECTION, not the output: below,
    // `.sort((a, b) => b.score - a.score)` sorts by relevance again. So
    // MMR decides WHO gets looked at, the score decides in what order it
    // appears — the same separation as the round-robin over authority
    // tiers.
    for (const hit of search(idx, useQuery, {
      top: perTier, withRetired: true, authority: tier,
      mmr, mmrLambda,
    })) {
      const id = hit.entry?.id;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      hits.push(hit);
    }
    if (hits.length === perTier) tiersAtCap.push(tier);
    if (hits.length) byTier.push(hits);
  }

  // Interleave the tiers round-robin, THEN order the answer by score.
  //
  // Two wrong versions preceded this, and both are worth naming because
  // they are the two ways to get it wrong:
  //
  //   consuming tier by tier      -> PRECEDENCE. A less relevant user
  //                                  claim came out ahead of a more
  //                                  relevant agent one.
  //   flattening and sorting      -> no representation at all. The high
  //                                  scores of a flood fill every slot
  //                                  before a quieter tier is reached, so
  //                                  the truth is out again.
  //
  // Round-robin gives each tier a slot in turn — representation — while
  // the final sort keeps relevance in charge of the ORDER. Bounded: at
  // most one pass per tier per slot.
  const ranked = [];
  for (let i = 0; byTier.some((h) => i < h.length); i += 1) {
    for (const hits of byTier) if (i < hits.length) ranked.push(hits[i]);
  }

  // The exact-match lane, right up front.
  //
  // If the question names `7318` and exactly one entry contains `7318`,
  // that is not similarity, it is certainty — and certainty does not
  // belong behind a score. Measured on task class I (paths, ticket
  // numbers, service names, versions): the ranking was already correct,
  // five of six at rank 1, but EVERY score was below the retrieval
  // threshold of 5.0 (0.95 to 2.44). It was not the order that blocked
  // this class, it was the threshold.
  //
  // This lane is self-limiting: an identifier only counts when it appears
  // in at most `want` documents — few enough that they all fit in the
  // answer anyway. No free parameter.
  //
  // Duplicates fall out further below: the selection loop does not know
  // `seenIds`, but body dedup catches it, and an entry that comes through
  // both lanes is the same body.
  // Same bounds as the ranked lane two dozen lines up: `withRetired:
  // true`, because here the capability check and the status check further
  // down decide, not the search. This lane previously took NO bounds at
  // all — which went unnoticed as long as the ranked lane happened to have
  // the same setting. Now it is stated explicitly, and a divergence would
  // show in the diff.
  const exactMatches = exactHits(idx, useQuery, want, { withRetired: true });
  const exactIds = new Set(exactMatches.map((h) => h.entry?.id).filter(Boolean));
  const raw = rawReserve
    ? [...exactMatches,
       ...ranked.filter((h) => h.type !== 'raw' && !exactIds.has(h.entry?.id)),
       ...ranked.filter((h) => h.type === 'raw' && !exactIds.has(h.entry?.id))]
    : [...exactMatches, ...ranked.filter((h) => !exactIds.has(h.entry?.id))];

  // Raw capture is not an authority tier, it is the reserve lane.
  //
  // It lands in tier 'unknown' and thereby got the same per-round slot in
  // the round-robin as 'user'. With five slots that means: a single
  // capture displaces one curated claim. And the capture wins the race
  // almost every time — it is long, run-together, and contains many
  // question words. Measured on C3: a capture scoring 30.31 pushes the
  // answer scoring 18.77 out of the top-5, even though it belongs to a
  // DIFFERENT question and the echo filter therefore rightly leaves it
  // alone.
  //
  // This inverts the whole design. Raw capture is by definition not yet a
  // claim: the digester has not run over it yet. Placing an unprocessed
  // conversation transcript ahead of a reviewed decision turns lane 1 into
  // the main lane and makes the digester redundant.
  //
  // So: all curated content first, then the capture. Not "capture out
  // entirely" — on a fresh memory the digester has never run over, capture
  // is the only material there is, and then the slots are free anyway.
  //
  // The price, named openly and NOT measured here: if a fact lives only
  // in a capture and the curated content already supplies five mediocre
  // hits, the capture no longer gets through. The eval corpus cannot show
  // this, because everything in it is already curated gold.


  // Derived ONCE per call, from the log, with no query parameter. A
  // function that reads the log itself cannot be handed a subset — which
  // is how the first status bug happened.
  const state = deriveState(root);

  const claims = [];
  const seenBody = new Map();
  // Did selection stop BECAUSE the page was full — while unexamined
  // candidates still remained? That is the honest basis for `hasMore`,
  // and it costs no larger selection.
  let stoppedEarly = false;
  let budget = limits.contextChars;

  for (const hit of raw) {
    const c = toClaim(hit, { bodyChars: limits.bodyChars, state });

    if (!capability.admits(c.scope)) { note(c.id, `outside capability (${c.scope})`); continue; }
    if (type && c.type && c.type !== type) { note(c.id, `wrong type (${c.type})`); continue; }
    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); continue; }
    if (c.status === 'superseded') { note(c.id, 'superseded'); continue; }
    if (!validAt(c, asOf)) { note(c.id, `not valid at ${asOf}`); continue; }
    // During selection, not after: filtering afterwards cannot recover
    // what the cutoff already discarded. The same bug lived in the first
    // version of body dedup.
    // Raw capture ONLY. A typed entry is by construction not the user's
    // question — it has gone through the digester or was filed
    // deliberately. Echoes are a lane-1 artifact.
    //
    // Without this restriction a genuine claim gets dropped: the question
    // "payment prepayment decision" against the decision "payment only by
    // prepayment — my decision" scores three of four content words, i.e.
    // 0.75, above the 0.7 threshold — and a user decision would have been
    // suppressed. A test caught this (state.test.mjs, "a tampered cache
    // cannot suppress a genuine claim") before anyone would have noticed
    // it in production.
    if (dropEcho && isEchoHit(useQuery, hit)) {
      note(c.id, 'echo of the question — answers nothing');
      continue;
    }

    // Deduplicate DURING selection, not after.
    //
    // Doing it afterwards was a real defect in the first version of this
    // function, found by attacking it: twenty identical claims under
    // twenty author names filled all ten slots, dedup then removed nine,
    // and the answer was a single flood claim with every genuine entry
    // gone. Filtering after a cutoff cannot restore what the cutoff
    // already discarded.
    // **An empty body is not a body.** When `bodyOf` did not know a
    // type's content field, every such entry hashed to the same empty
    // string and all but the first were dropped as duplicates — the
    // exclusion even SAID "identical body", which was true and useless.
    // Two entries are the same claim when they say the same thing, not
    // when neither of them says anything. An entry with no readable
    // content is a finding of its own and travels as one.
    if (!c.body) {
      note(c.id, 'no readable content in any known field — entry or projection is wrong');
      continue;
    }
    const h = bodyHash(c.body);
    const first = seenBody.get(h);
    if (first) { note(c.id, `identical body to ${first}`); continue; }

    if (c.body.length > budget) { note(c.id, 'context budget exhausted', 'capacity'); continue; }
    seenBody.set(h, c.id);
    claims.push(c);
    budget -= c.body.length;
    if (claims.length >= selectWant) { stoppedEarly = true; break; }
  }

  // Relevance decides the ORDER of what was selected; the round-robin
  // above decided WHO got looked at.
  const fair = enforceAuthorShare(claims, limits, note)
    // By score, ties broken by id.
    //
    // **What the second key does NOT do**, though an earlier version of
    // this comment claimed it: it does not rescue the order from being
    // undefined. `Array.prototype.sort` has been stable since ES2019, so
    // ties already keep their insertion order — and sabotage showed this
    // immediately: removing the key did not fail a single probe.
    //
    // What it does do: it makes the order independent of WHICH lane a
    // claim came in through. Insertion order comes from the round-robin
    // over authority tiers and the exact lane before it; inserting or
    // reordering a lane there would otherwise silently shift every page
    // boundary. Measured: for six decisions on the same topic, all six
    // carry practically the same score — ties are the normal case here,
    // not the exception.
    //
    // So: not a bulwark against chaos, but the guarantee that the order is
    // a FUNCTION of (score, id). The probe below checks exactly that.
    .sort((a, b) => (b.score - a.score) || String(a.id ?? '').localeCompare(String(b.id ?? '')));

  // Cut out the page. `fair` carries up to one claim more than the page
  // holds — that extra one is the evidence for `hasMore`. `hasMore` comes
  // from the selection loop breaking early, not from a larger selection:
  // the loop stopped at `want`, and unexamined candidates still remained
  // before it. That costs nothing and asserts nothing about their number.
  const page = fair;
  // Two paths to "there is more", and both are needed:
  //   1. The selection loop stopped at `want` and unexamined candidates
  //      still remained.
  //   2. Claims fell out for reasons of SPACE (budget, quota). They were
  //      available; just not here.
  // Without (2), retrieval on the eval corpus reported `false` while 110
  // retrievable claims were missing.
  const outOfSpace = excluded.some((x) => x.kind === 'capacity');
  const hasMore = (stoppedEarly && fair.length >= want) || outOfSpace;

  if (tiersAtCap.length) {
    coverageReasons.push({
      kind: 'partial',
      why: `candidate pool full at ${perTier} for tier(s): ${tiersAtCap.join(', ')}`,
    });
  }
  if (fair.length < raw.length) {
    coverageReasons.push({
      kind: 'partial',
      why: `${raw.length - fair.length} candidate(s) removed after ranking`,
    });
  }
  if (hasMore) {
    coverageReasons.push({ kind: 'partial', why: 'more claims match than fit on this page' });
  }
  if (fair.length > limits.maxResults) {
    // The hard ceiling has been reached. How many more would fit beyond
    // it, this run does not know — and must therefore not imply either.
    coverageReasons.push({
      kind: 'partial',
      why: `the hard ceiling of ${limits.maxResults} results bounds this answer`,
    });
  }
  if (excluded.length) {
    // Report separately. "119 excluded" is a number nobody can read
    // whether a second page would help from.
    const outOfSpaceCount = excluded.filter((x) => x.kind === 'capacity').length;
    const notEligibleCount = excluded.length - outOfSpaceCount;
    if (notEligibleCount) {
      coverageReasons.push({
        kind: 'partial',
        why: `${notEligibleCount} claim(s) not eligible for this caller`,
      });
    }
    if (outOfSpaceCount) {
      coverageReasons.push({
        kind: 'partial',
        why: `${outOfSpaceCount} claim(s) left out for space, not eligibility`,
      });
    }
  }
  if (page.some((c) => c.bodyTruncated)) {
    coverageReasons.push({ kind: 'partial', why: 'at least one body was cut to bodyChars' });
  }

  return {
    contested: potentialConflicts(page),
    query: useQuery,
    queryTruncated: qCapped,
    scopes: capability.scopes,
    subject: capability.subject,
    claims: page,
    excluded,
    truncated: fair.length < raw.length,
    // The corpus's generation. It tells a caller whether two answers came
    // from the same state — without that turning into a page cursor,
    // which this design cannot carry.
    generation,
    hasMore,
    // Kept alongside `truncated`, not instead of it: `truncated` answers
    // "was this answer cut", `coverage` answers "what may I conclude
    // from what is missing". Two different questions, and the second one
    // had no field.
    coverage: coverageOf({ reasons: coverageReasons }),
    limits,
  };
}

/**
 * Collapse claims whose bodies are identical after normalisation.
 *
 * The author-share cap below bounds a NAMED flooder. It does nothing
 * against an actor who rotates author names — tested after writing it:
 * twenty claims under twenty names all survived. Rotating names needs the
 * same write access as one name, so the cap alone was worth little.
 *
 * Content is the thing an attacker cannot vary and still rank: flooding
 * works by repeating what matches the query. So identical bodies collapse
 * to the first (highest-ranked) one, whatever they are signed with.
 *
 * Normalisation is deliberately conservative — Unicode NFC, CRLF to LF,
 * runs of whitespace to one, and nothing else. No case folding, no
 * punctuation stripping: aggressive normalisation makes DIFFERENT content
 * collide, and a memory that silently merges two different claims is worse
 * than one that shows a duplicate. Near-duplicates are left alone; they
 * are a `possible_duplicate` relation to surface, not a merge to perform.
 */
export function canonicalBody(text) {
  return String(text ?? '').normalize('NFC').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

export function bodyHash(text) {
  return crypto.createHash('sha256').update(canonicalBody(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * No single sub-user author may take more than `perAuthorShare` of the
 * CANDIDATES considered. Not of the answer — and the difference matters.
 *
 * The filtering shrinks its own denominator: 9 flood claims plus 1 genuine
 * one give cap 5, so 5 are dropped and the answer is 6, of which 5 are the
 * flood. A promised ceiling of 50% delivers 83%. Measured, not reasoned:
 * bench/byzantine.mjs, 2026-09-05.
 *
 * Computing the share against the answer instead was tried and reverted.
 * It works by iterating to a fixed point, and it is correct — but the
 * corpus it shrinks is not only the flood. A normal memory is one user
 * claim and a productive digest agent, which has the same authorship shape
 * as a flood, so the same fixed point cuts a real answer to two claims.
 * Authorship cannot distinguish a flood from a useful writer; only content
 * can, and near-duplicate detection was rejected for having no calibratable
 * threshold. So the bound stays where it is honest.
 *
 * What a flood is actually caught by: `potentialConflicts` flags it as
 * contested, the genuine `user` claim is exempt from the cap and stays in
 * the answer, and the caller is told both. Bounded domination is NOT among
 * the guarantees; a caller that needs it must lower `perAuthorShare`
 * itself and accept the shorter answers.
 *
 * Deliberately NOT a flat "max n per author": a digest agent legitimately
 * writes most of a memory, and a flat cap would make the most useful
 * author the most suppressed. `user` tier is exempt because the owner
 * cannot poison their own memory in the sense this defends against.
 */
export function enforceAuthorShare(claims, limits = LIMITS, note = () => {}) {
  if (claims.length <= 2) return claims;
  const cap = Math.max(1, Math.floor(claims.length * limits.perAuthorShare));
  const seen = new Map();
  const out = [];
  for (const c of claims) {
    if (c.authority === 'user' || !c.author) { out.push(c); continue; }
    const n = (seen.get(c.author) ?? 0) + 1;
    if (n > cap) { note(c.id, `author share exceeded (${c.author}, cap ${cap})`, 'capacity'); continue; }
    seen.set(c.author, n);
    out.push(c);
  }
  return out;
}

/**
 * Claims in one answer that MAY contradict each other.
 *
 * Deliberately the weakest possible detector, and deliberately named
 * "potential". What is decidable without a world model:
 *
 *   same topic + same scope + overlapping validity + different authors
 *
 * That is a structural coincidence, not a semantic judgement. It cannot
 * tell that "runs in Frankfurt" and "runs in Berlin" conflict; it can tell
 * that two different people made claims about the same thing at the same
 * time, which is when a reader should look.
 *
 * Why it exists: the Byzantine benchmark returns an answer whose context
 * is mostly false and, until now, said nothing about it. A memory that
 * cannot decide which claim is true can still refuse to present a
 * contested subject as settled. That refusal is cheap, deterministic, and
 * needs no model.
 *
 * What it deliberately does NOT do: pick a winner. Tier decides only where
 * a conflict is ESTABLISHED — an explicit supersession — not where one is
 * merely suspected. Guessing here would be worse than saying nothing,
 * because a wrong resolution is invisible and a flag is not.
 */
export function potentialConflicts(claims) {
  const groups = new Map();
  for (const c of claims) {
    if (!c.topic) continue;
    const key = `${c.scope}\u0000${c.topic}`;
    const g = groups.get(key) ?? [];
    g.push(c);
    groups.set(key, g);
  }
  const out = [];
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    const authors = new Set(g.map((c) => c.author ?? '(none)'));
    if (authors.size < 2) continue;
    // Overlapping validity: absent bounds are open, so absent overlaps all.
    const overlapping = g.filter((a) => g.some((b) => a !== b && intervalsOverlap(a, b)));
    if (overlapping.length < 2) continue;
    const [scope, topic] = key.split('\u0000');
    out.push({
      scope, topic,
      authors: [...authors].sort(),
      ids: overlapping.map((c) => c.id).sort(),
    });
  }
  return out;
}

function intervalsOverlap(a, b) {
  const af = a.valid_from ? Date.parse(a.valid_from) : -Infinity;
  const au = a.valid_until ? Date.parse(a.valid_until) : Infinity;
  const bf = b.valid_from ? Date.parse(b.valid_from) : -Infinity;
  const bu = b.valid_until ? Date.parse(b.valid_until) : Infinity;
  const f = (x, d) => (Number.isFinite(x) ? x : d);
  return f(af, -Infinity) < f(bu, Infinity) && f(bf, -Infinity) < f(au, Infinity);
}

/**
 * Why a NAMED claim did not come back.
 *
 * The valuable half of explainability and the one nothing else offers.
 * Needs the exhaustive scan, which is why the scan stays: it is the test
 * oracle anyway, so this costs a scan on an explicit debug call and
 * nothing on the hot path. No model involved.
 */
export function explainMissing(root, query, capability, id, opts = {}) {
  const r = retrieve(root, query, capability, { ...opts, top: LIMITS.maxResults });
  const hit = r.claims.find((c) => c.id === id);
  if (hit) return { id, returned: true, rank: r.claims.indexOf(hit) + 1, score: hit.score };
  const why = r.excluded.find((e) => e.id === id);
  if (why) return { id, returned: false, reason: why.why };
  return { id, returned: false, reason: 'no term of the query matches this claim' };
}
