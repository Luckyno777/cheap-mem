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
 * Two ways, and no third:
 *   - the same author corrects their own claim, or
 *   - a strictly higher tier overrules a lower one.
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
  if (ct === tt) {
    return {
      ok: false,
      reason: `same tier (${ct}) but different authors (${ca ?? 'none'} vs ${ta ?? 'none'})`,
    };
  }
  return { ok: false, reason: `${ct} does not outrank ${tt}` };
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
