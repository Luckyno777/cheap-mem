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

import * as memory from './memory.mjs';
import * as authority from './authority.mjs';
import * as capabilityMod from './capability.mjs';
import { loadIndex, search } from './search.mjs';

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

/** A claim as it leaves the memory. Fields only — no assembled text. */
function toClaim(hit, { retired, bodyChars }) {
  const e = hit.entry;
  const body = bodyOf(e);
  const truncated = body.length > bodyChars;
  const state = retired.get(e.id)?.state ?? 'active';
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
    ts: e.ts ?? null,
    valid_from: e.valid_from ?? null,
    valid_until: e.valid_until ?? null,
    status: state,
    score: hit.score,
  };
}

/**
 * The text of an entry, assembled from its own fields in a fixed order.
 *
 * Note what this is NOT: it does not add framing, headings, or any word
 * the entry did not contain. A memory that decorates its own content is a
 * memory that can be made to say something.
 */
function bodyOf(e) {
  const parts = [e.choice, e.why, e.title, e.text, e.fact].filter(
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
} = {}) {
  const excluded = [];
  const note = (id, why) => excluded.push({ id: id ?? null, why });

  // Fail closed. Not a thrown error: a caller with no capability asking a
  // question should get an empty, explained answer rather than a stack
  // trace it might log somewhere with the query in it.
  if (!(capability instanceof capabilityMod.Capability)) {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'no capability presented' }],
      scopes: [], truncated: false, limits,
    };
  }
  if (!capability.has('read')) {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'capability does not carry read' }],
      scopes: capability.scopes, truncated: false, limits,
    };
  }

  const q = String(query ?? '');
  const qCapped = q.length > limits.queryChars;
  const useQuery = qCapped ? q.slice(0, limits.queryChars) : q;

  const idx = index ?? loadIndex(root);
  const want = Math.min(Math.max(1, Number(top) || 1), limits.maxResults);

  // Over-fetch, because scope, validity and quota all remove candidates
  // after ranking. Bounded by maxResults so this cannot become the DoS it
  // is meant to prevent.
  // `withRetired: true` on purpose. search() would otherwise drop
  // superseded and disputed claims itself, one layer down and without a
  // word — and then this gateway could not say WHY something is missing,
  // which is the half of explainability that matters. Every exclusion is
  // decided here, and every decision is recorded.
  const raw = search(idx, useQuery, {
    top: Math.min(want * 6, limits.maxResults * 6),
    withRetired: true,
  });

  const retired = memory.retiredMap(raw.map((h) => h.entry));
  const claims = [];
  let budget = limits.contextChars;

  for (const hit of raw) {
    const c = toClaim(hit, { retired, bodyChars: limits.bodyChars });

    if (!capability.admits(c.scope)) { note(c.id, `outside capability (${c.scope})`); continue; }
    if (type && c.type && c.type !== type) { note(c.id, `wrong type (${c.type})`); continue; }
    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); continue; }
    if (c.status === 'superseded') { note(c.id, 'superseded'); continue; }
    if (!validAt(c, asOf)) { note(c.id, `not valid at ${asOf}`); continue; }

    if (c.body.length > budget) { note(c.id, 'context budget exhausted'); continue; }
    claims.push(c);
    budget -= c.body.length;
    if (claims.length >= want) break;
  }

  const fair = enforceAuthorShare(claims, limits, note);

  return {
    query: useQuery,
    queryTruncated: qCapped,
    scopes: capability.scopes,
    subject: capability.subject,
    claims: fair,
    excluded,
    truncated: fair.length < raw.length,
    limits,
  };
}

/**
 * No single sub-user author may take more than `perAuthorShare` of the
 * answer.
 *
 * Deliberately NOT a flat "max n per author": a digest agent legitimately
 * writes most of a memory, and a flat cap would make the most useful
 * author the most suppressed. A SHARE bounds domination without punishing
 * productivity, and `user` tier is exempt because the owner cannot poison
 * their own memory in the sense this defends against.
 */
export function enforceAuthorShare(claims, limits = LIMITS, note = () => {}) {
  if (claims.length <= 2) return claims;
  const cap = Math.max(1, Math.floor(claims.length * limits.perAuthorShare));
  const seen = new Map();
  const out = [];
  for (const c of claims) {
    if (c.authority === 'user' || !c.author) { out.push(c); continue; }
    const n = (seen.get(c.author) ?? 0) + 1;
    if (n > cap) { note(c.id, `author share exceeded (${c.author}, cap ${cap})`); continue; }
    seen.set(c.author, n);
    out.push(c);
  }
  return out;
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
