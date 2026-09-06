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
import * as memory from './memory.mjs';
import * as authority from './authority.mjs';
import { deriveState, statusOf } from './state.mjs';
import * as capabilityMod from './capability.mjs';
import { loadIndex, search, isEchoHit } from './search.mjs';

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
    ts: e.ts ?? null,
    valid_from: e.valid_from ?? null,
    valid_until: e.valid_until ?? null,
    status: claimState,
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
  // Vorgabe wie in `mem find`. Ueberschreibbar, damit ein Aufrufer, der
  // reine Relevanzreihenfolge will, sie bekommt — und damit ein Test beide
  // Wege vergleichen kann.
  mmr = true,
  mmrLambda = 0.7,
  // Echos verwerfen: ein Treffer, der im Wesentlichen die Frage selbst ist.
  //
  // isEcho existiert seit dem 2026-09-05, ist getestet und mit einer
  // Messung begruendet (13 von 18 eingespeisten Treffern waren Echos) —
  // und wurde von NICHTS aufgerufen. In `mem find` steckt es hinter
  // `--no-echo`, das niemand setzt; der Abruf-Hook, der die 13/18 gemessen
  // hat, setzt es auch nicht. Die Abwehr gegen das gemessene Problem war
  // toter Code.
  //
  // Vorgabe an, weil der Gateway der automatische Pfad ist: dort kann
  // niemand eingreifen, und ein Block, der einem die eigene Frage
  // zurueckgibt, wird nach dem dritten Mal ueberlesen — und dann ist der
  // ganze Abruf weg.
  dropEcho = true,
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
  const perTier = Math.min(want * 6, limits.maxResults * 6);
  const seenIds = new Set();
  const byTier = [];
  for (const tier of authority.TIERS) {
    const hits = [];
    // MMR an, mit demselben Lambda wie `mem find`.
    //
    // Bis 2026-09-06 stand hier nichts, und `search()` hat `mmr: false` als
    // Vorgabe. `bin/mem find` schaltet es ein — der Gateway nicht. Damit war
    // der AGENTENPFAD (mem retrieve, MCP mem_retrieve) schlechter als der
    // Menschenpfad: reine BM25-Reihenfolge, und zwoelf Fast-Duplikate
    // desselben Themas fuellen die Trefferliste, waehrend die Antwort auf
    // die eigentliche Frage darunter liegt.
    //
    // Gemessen am eval-Korpus: das gesuchte Claim war ohne MMR bei 7 von 18
    // Aufgaben in den top-5, mit MMR bei 9 von 18.
    //
    // Die Neuordnung wirkt auf die AUSWAHL, nicht auf die Ausgabe: unten
    // sortiert `.sort((a, b) => b.score - a.score)` wieder nach Relevanz.
    // MMR entscheidet also, WER angeschaut wird, die Punktzahl in welcher
    // Reihenfolge er erscheint — dieselbe Trennung wie beim Rundlauf ueber
    // die Autoritaetsstufen.
    for (const hit of search(idx, useQuery, {
      top: perTier, withRetired: true, authority: tier,
      mmr, mmrLambda,
    })) {
      const id = hit.entry?.id;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      hits.push(hit);
    }
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
  const raw = [];
  for (let i = 0; byTier.some((h) => i < h.length); i += 1) {
    for (const hits of byTier) if (i < hits.length) raw.push(hits[i]);
  }

  // Derived ONCE per call, from the log, with no query parameter. A
  // function that reads the log itself cannot be handed a subset — which
  // is how the first status bug happened.
  const state = deriveState(root);

  const claims = [];
  const seenBody = new Map();
  let budget = limits.contextChars;

  for (const hit of raw) {
    const c = toClaim(hit, { bodyChars: limits.bodyChars, state });

    if (!capability.admits(c.scope)) { note(c.id, `outside capability (${c.scope})`); continue; }
    if (type && c.type && c.type !== type) { note(c.id, `wrong type (${c.type})`); continue; }
    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); continue; }
    if (c.status === 'superseded') { note(c.id, 'superseded'); continue; }
    if (!validAt(c, asOf)) { note(c.id, `not valid at ${asOf}`); continue; }
    // In der Auswahl, nicht danach: nachtraeglich zu filtern kann nicht
    // zurueckholen, was der Schnitt schon verworfen hat. Derselbe Fehler
    // steckte in der ersten Fassung der Koerper-Entdopplung.
    // NUR Rohfang. Ein getippter Eintrag ist per Konstruktion nicht die
    // Frage des Nutzers — er ist durch den Fasser gegangen oder wurde
    // absichtlich abgelegt. Echos sind ein Lane-1-Artefakt.
    //
    // Ohne diese Einschraenkung faellt ein echter Anspruch: die Frage
    // "zahlung vorkasse entscheidung" gegen die Entscheidung "zahlung nur
    // per vorkasse — meine entscheidung" ergibt drei von vier
    // Inhaltswoertern, also 0,75 ueber der Schwelle 0,7 — und eine
    // Benutzerentscheidung waere unterdrueckt worden. Ein Test hat das
    // gefangen (state.test.mjs, "a tampered cache cannot suppress a
    // genuine claim"), bevor es jemand im Betrieb gemerkt haette.
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
    const h = bodyHash(c.body);
    const first = seenBody.get(h);
    if (first) { note(c.id, `identical body to ${first}`); continue; }

    if (c.body.length > budget) { note(c.id, 'context budget exhausted'); continue; }
    seenBody.set(h, c.id);
    claims.push(c);
    budget -= c.body.length;
    if (claims.length >= want) break;
  }

  // Relevance decides the ORDER of what was selected; the round-robin
  // above decided WHO got looked at.
  const fair = enforceAuthorShare(claims, limits, note)
    .sort((a, b) => b.score - a.score);

  return {
    contested: potentialConflicts(fair),
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
    if (n > cap) { note(c.id, `author share exceeded (${c.author}, cap ${cap})`); continue; }
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
