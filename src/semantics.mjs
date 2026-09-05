// src/semantics.mjs — which rules produced this state.
//
// The question (§5 of the final audit): if the conflict or authority rules
// change in two years, can the SAME log yield a DIFFERENT state? Yes —
// that is what changing them means. The requirement is not that it never
// happens; it is that the same log plus the same semantic version always
// yields the same state, and that a mismatch is visible rather than
// silent.
//
// So this is a single number, bumped by hand when a rule that changes
// DERIVED STATE changes. Not a migration engine: nothing is rewritten,
// because nothing can be — the log is append-only and old entries were
// correct under the rules of their day.
//
// **What counts as a bump.** Anything that alters what `replay(log)`
// produces: the supersession rule, the authority order, conflict
// resolution, how validity intervals are compared, what counts as
// retired. NOT: ranking weights, index internals, output formatting,
// performance. Those change what is FOUND or how it LOOKS, not what is
// TRUE.

/**
 * 1 — the rules as of 2026-09-05.
 *
 * - supersession: same author, or strictly higher authority tier
 * - authority order: user > system > agent > external > inferred > unknown
 * - a refused supersession makes the ATTEMPT disputed, never the target
 * - validity: valid_from inclusive, valid_until exclusive, absent = open
 * - retired: retires_id / closes_id / an AUTHORISED replaces_id
 */
export const SEMANTIC_VERSION = 1;

export const CHANGELOG = Object.freeze({
  1: 'authority-gated supersession; disputed attempts; exclusive valid_until',
});

/**
 * Is a state that was derived under `theirs` comparable to one derived now?
 *
 * Deliberately not "can we migrate": there is nothing to migrate. The
 * answer is whether two derived states may be compared at all, which is
 * what a cache, a watermark, or a second machine actually needs to know.
 */
export function comparable(theirs) {
  return Number(theirs) === SEMANTIC_VERSION;
}

export function describe(theirs) {
  if (comparable(theirs)) return `semantics v${SEMANTIC_VERSION}`;
  return `semantics v${theirs ?? '?'} vs v${SEMANTIC_VERSION} — derived state is NOT comparable`;
}
