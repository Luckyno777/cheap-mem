// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/authority.mjs — who is entitled to overrule whom.
//
// The measured hole (2026-09-05): `replaces_id` was applied with no check
// at all. Any writer could retire any other writer's entry, and the
// original then stopped being returned. In a single-user memory that is a
// non-issue; in the multi-agent system this is built for it is the
// poisoning primitive — one line, and a decision is gone.
//
// **Why tiers and not a confidence number.** A float nobody can calibrate
// becomes a number everybody rounds to "probably fine", and two 0.7s from
// different pipelines are not comparable. Tiers are comparable because
// they are defined by WHO asserted, which is checkable, rather than by HOW
// SURE someone was, which is not.
//
// **Where the guarantee ends.** `author` and `authority` are fields in a
// file. Anyone who can write the repository can write both. This raises
// the cost of poisoning from ONE LINE to REPOSITORY WRITE ACCESS. That is
// a real gain and it is not cryptography; nothing here should ever be
// described as making forgery impossible. Signed commits would close it
// and are deliberately out of scope until someone has the threat model
// that needs them.

/** Ordered from most to least entitled. The index IS the rank. */
export const TIERS = Object.freeze([
  'user',       // the person, stated directly
  'system',     // configuration, policy, a measured fact
  'agent',      // an agent's own conclusion
  'external',   // a document, a web page, tool output
  'inferred',   // a model's inference over other claims
  'unknown',    // provenance missing — the default, and deliberately last
]);

export const DEFAULT_TIER = 'unknown';

/**
 * Y4b (2026-09-30): the tier the WRITE path stamps on a new line that
 * names none. `DEFAULT_TIER` stays `unknown` for READING — an old line
 * without the field is still of unknown provenance — but a line written
 * by this code now is written by an agent, which is true without
 * inventing anything. Before this, every new session line carried no
 * `authority`, read as `unknown` (the lowest tier) and was therefore
 * open to the digest (`inferred`) closing or retiring it.
 *
 * Never `user`: that tier is only ever set explicitly (`--authority
 * user`, or the dashboard behind a password session). Under
 * CHEAP_MEM_MAX_AUTHORITY the ceiling wins (`writeTierDefault`).
 */
export const WRITE_DEFAULT_TIER = 'agent';

/** Rank of a tier: lower is more entitled. Unrecognised names rank last. */
export function rank(tier) {
  const i = TIERS.indexOf(String(tier ?? '').toLowerCase());
  return i === -1 ? TIERS.length : i;
}

/** The tier of an entry, defaulting rather than throwing. */
export function tierOf(entry) {
  const t = String(entry?.authority ?? '').toLowerCase();
  return TIERS.includes(t) ? t : DEFAULT_TIER;
}

/** The author of an entry, from either the explicit field or the stamp. */
export function authorOf(entry) {
  return entry?.author ?? entry?.agent ?? entry?.origin?.agent ?? null;
}

/** Is `a` strictly more entitled than `b`? */
export function outranks(a, b) {
  return rank(a) < rank(b);
}

/**
 * May `claim` supersede `target`?
 *
 * Two ways, plus one reading of "same author":
 *   - the same author corrects their own claim, or
 *   - a strictly higher tier overrules a lower one;
 *   - two `user`-tier lines count as the same author (one person, the
 *     writer is only the scribe) — as in lucky-mem rang.darfAendern.
 *
 * **Legacy data passes.** An entry written before this rule has neither
 * field, so both authors are null and both tiers are `unknown`: same
 * author, same tier, allowed. That is deliberate — a rule that
 * retroactively invalidates every correction ever made would be a
 * migration disguised as a security fix.
 *
 * Returns `{ ok, reason }` rather than a boolean, because the reason is
 * what `mem explain` has to be able to print.
 */
export function maySupersede(claim, target) {
  const ca = authorOf(claim);
  const ta = authorOf(target);
  const ct = tierOf(claim);
  const tt = tierOf(target);

  if (ca !== null && ta !== null && ca === ta) {
    return { ok: true, reason: `same author (${ca})` };
  }
  if (ca === null && ta === null) {
    return { ok: true, reason: 'neither claim names an author (pre-authority data)' };
  }
  if (outranks(ct, tt)) {
    return { ok: true, reason: `${ct} outranks ${tt}` };
  }
  // Paket (2026-09-30), aligned with lucky-mem Y4c (rang.darfAendern):
  // `user` is ONE person. Two user-tier lines with different writers
  // (session A recorded the rule, session B the correction) have the same
  // author — the writer is only the scribe. Without this, every correction
  // of a user rule by a different session was refused. Agent-vs-agent and
  // every lower tier stay strict (test/paket-user-supersede.test.mjs).
  if (ct === 'user' && tt === 'user') {
    return { ok: true, reason: 'both user (one person, different scribes)' };
  }
  if (ct === tt) {
    return {
      ok: false,
      reason: `same tier (${ct}) but different authors (${ca ?? 'none'} vs ${ta ?? 'none'})`,
    };
  }
  return { ok: false, reason: `${ct} does not outrank ${tt}` };
}

// ---------------------------------------------------------------------
// ONE rule for every factual state change (Y4, 2026-09-30).
//
// The measured hole (ChatGPT brief 2026-09-30, point 4): only `replaces_id`
// went through `maySupersede`. `retires_id` and `closes_id` were applied
// unchecked, so an entry with authority=inferred, agent=digest could put a
// `user`-tier target to rest (state=obsolete) with ONE line. Same poisoning
// primitive as 2026-09-05, one field over.
//
// The three fields are now ONE question — `mayChangeState(claim, target,
// field)` — asked at replay (memory.applyRetirement, and the duty fold in
// memory.openDuties), so a line that arrives by import or merge is judged
// exactly like one written here. Write-time checks are only an early
// warning; the log is append-only, the verdict is derived on read.
//
// THE DELIBERATE DIFFERENCES (each one is a decision, not an accident):
//
//   replaces_id  strict: `maySupersede` unchanged. A correction puts NEW
//                content in place of the old claim, so "same tier,
//                different author" is refused (two agents overwriting each
//                other's claims is the poisoning case).
//   retires_id   lateral-tolerant: a tombstone puts NOTHING in the place
//   closes_id    of the old claim, and everyday housekeeping is lateral —
//                any session closes an auto-duty, any human discards
//                another's stale thought. So a claim may close a target
//                of the SAME tier; it may not close one that strictly
//                OUTRANKS it. This is exactly the reported case (inferred
//                vs user) and it keeps legacy data (unknown vs unknown,
//                different agents) working without a migration.
//   debtor       an entry that names an owner/debtor (a duty: `owner`,
//                `who`) may always be closed by that owner, whatever tier
//                the owner writes at. A duty is somebody's job; the person
//                it is assigned to must be able to say it is done.
//                It is deliberately NOT extended to replaces_id.
//   unknown tier stays LAST. An unstamped claim (no `authority`) is not
//                given the benefit of the doubt: the digest may omit the
//                field, and "absent" must not read as "trusted". It can
//                still close unstamped targets (lateral) and its own.
//   missing      a target that is not in the view is UNRESOLVED — neither
//   target       authorised nor refused. Nothing is visible to hide for
//                it in that view, the map records it as `unresolved` and
//                `mem doctor` (orphans) reports the dangling pointer.
//
// Refused means what it already meant for replaces_id: the target stays
// ACTIVE and the claim is marked `disputed` — never silently dropped,
// never silently honoured.

/** The three fields that change the state of another entry. */
export const STATE_FIELDS = Object.freeze(['replaces_id', 'retires_id', 'closes_id']);

/** Normalise a person/agent name for the debtor comparison. */
function partyKey(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/^@/, '').replace(/^human:/, '');
  return s || null;
}

/** Who owes this entry, if it names anyone (`owner`, else `who`). */
export function debtorOf(entry) {
  return partyKey(entry?.owner ?? entry?.who);
}

/**
 * May `claim` change the state of `target` through `field`?
 *
 * Returns `{ ok, status, reason }`, `status` one of
 * `allowed` | `refused` | `unresolved`. `ok` is true ONLY for `allowed`:
 * an unresolved target is not an authorisation.
 */
export function mayChangeState(claim, target, field) {
  if (!STATE_FIELDS.includes(field)) {
    return { ok: false, status: 'refused', reason: `unknown state field '${field}'` };
  }
  if (!target) {
    return {
      ok: false, status: 'unresolved',
      reason: `${field} target not in this view — unresolved (mem doctor lists dangling pointers)`,
    };
  }
  if (field === 'replaces_id') {
    const v = maySupersede(claim, target);
    return { ok: v.ok, status: v.ok ? 'allowed' : 'refused', reason: v.reason };
  }
  const ca = authorOf(claim);
  const ta = authorOf(target);
  const ct = tierOf(claim);
  const tt = tierOf(target);
  if (ca !== null && ca === ta) {
    return { ok: true, status: 'allowed', reason: `same author (${ca})` };
  }
  const debtor = debtorOf(target);
  if (debtor !== null && partyKey(ca) === debtor) {
    return { ok: true, status: 'allowed', reason: `${ca} is the owner of the target` };
  }
  if (!outranks(tt, ct)) {
    return { ok: true, status: 'allowed', reason: ct === tt ? `same tier (${ct})` : `${ct} outranks ${tt}` };
  }
  return { ok: false, status: 'refused', reason: `${ct} may not ${field.replace('_id', '').replace(/s$/, '')} a ${tt} claim` };
}

/**
 * The highest tier a writer is permitted to assert.
 *
 * The gap this closes (found 2026-09-05, in the final verification round):
 * the digest is the ONE place a model writes claims into the log, and it
 * had no ceiling at all. `authority` was whatever the model emitted. That
 * composes badly with the injection threat — text in a captured transcript
 * can steer what the digest writes — so a sentence in someone else's
 * document could mint a `user`-tier claim and overrule everything.
 *
 * A model's output is an inference over other claims. That is exactly what
 * the `inferred` tier means, and it is where the ceiling belongs.
 *
 * Enforced on the WRITE path rather than by asking the digest nicely: an
 * instruction in a prompt is a request, and the thing being constrained
 * here is precisely a process that may have been told otherwise.
 */
export const CEILING_ENV = 'CHEAP_MEM_MAX_AUTHORITY';

export function ceilingFromEnv(env = process.env) {
  const raw = String(env[CEILING_ENV] ?? '').toLowerCase().trim();
  return TIERS.includes(raw) ? raw : null;
}

/**
 * Y4b: the tier `memory.logEntry` stamps when the caller names none —
 * `WRITE_DEFAULT_TIER`, lowered to the process ceiling when one is set.
 * ONE place, so the early warnings judge with the same tier the write
 * path will actually write.
 */
export function writeTierDefault(env = process.env) {
  return clampTier(WRITE_DEFAULT_TIER, ceilingFromEnv(env)).tier;
}

/**
 * Lower `tier` to `ceiling` when it claims more. Never raises.
 *
 * Returns `{ tier, clamped, from }` so the caller can record that a
 * demotion happened — a silent one would hide exactly the event worth
 * seeing.
 */
export function clampTier(tier, ceiling) {
  const t = TIERS.includes(String(tier ?? '').toLowerCase()) ? String(tier).toLowerCase() : DEFAULT_TIER;
  if (!ceiling || !TIERS.includes(ceiling)) return { tier: t, clamped: false, from: t };
  if (rank(t) < rank(ceiling)) return { tier: ceiling, clamped: true, from: t };
  return { tier: t, clamped: false, from: t };
}
