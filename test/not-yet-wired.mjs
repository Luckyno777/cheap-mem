// test/not-yet-wired.mjs — the declared exceptions to "every src/ module
// is reachable from a CLI entry point" (see test/no-log-without-reader.test.mjs,
// section "REACHABLE OR DECLARED").
//
// **Why a manifest and not a comment in the module itself.** A comment
// inside `indexcache.mjs` saying "not wired yet" is invisible to the
// guard — it would have to re-derive the rule from prose. This file is
// DATA the guard reads, the same shape `doctor.OK_OVER_ZERO` already
// uses for the sibling question "when is zero an honest pass". Two
// declarations, both checked by test/no-log-without-reader.test.mjs:
//
//   - the module named still exists in src/ (a stale key is worse than
//     none — it looks like a considered decision and covers nothing)
//   - the module named is STILL actually unreachable (once someone
//     wires it in, the declaration is a lie sitting next to the truth,
//     and the guard catches that immediately — it does not wait for
//     the clock below)
//
// **Why a date, not just a reason.** A justification that never expires
// is not a decision, it is a permanent excuse — this house measured
// that shape directly (2026-09-20 build plan, B7): the justification
// expires after 14 days, and then the guard goes red again. `isExpired`
// is that clock. It takes `today` as an argument on purpose, so a test can hand
// it a fixed date instead of depending on when the suite happens to
// run.
//
// **What a reason has to do.** Mirrors doctor.mjs's OK_OVER_ZERO: it
// has to ARGUE, not label. "not wired yet" is a label. "another agent
// is wiring it under B8, declared here so this guard does not fight
// that work mid-merge" is an argument someone could push back on.

/** How long a declaration excuses a module before the guard goes red again. */
export const TTL_DAYS = 14;

/**
 * key: the module's file name without `.mjs` (matches `src/<key>.mjs`).
 * since: ISO date (YYYY-MM-DD) the declaration was written.
 * reason: why it is not wired yet, and what would resolve it — an
 *   argument, checked for length and shape by the guard itself.
 */
export const NOT_YET_WIRED = Object.freeze({
  // indexcache was declared here at 2026-09-20T~13:11Z, while a sibling
  // agent's B8 wiring was in flight. It landed mid-session (search.mjs
  // now calls `indexcache.writeIndexCache`), and the "already reachable"
  // check in test/no-log-without-reader.test.mjs caught the now-stale
  // declaration immediately, as designed — see this file's own comment
  // on why TRUTH expiry does not wait for the 14-day clock. Removed
  // rather than left dated-but-wrong.
  provenance: {
    since: '2026-09-20',
    reason: 'checked whether `mem doctor` already has a home for this and found two — '
      + "'behind' (checkBehind, HEAD..origin/branch) and 'git' (dirty tree) — so a naive "
      + 'wire-in would be a two-truths risk on those two fields. The genuinely new part, '
      + 'STATE.STALE at age_minutes > LIMIT_MINUTES, is age-only: it does NOT look at '
      + '`behind`, so a fully-synced, clean clone (behind=0, not dirty) whose last commit '
      + 'simply predates a quiet stretch — nobody logged anything for 90+ minutes, which '
      + 'is normal, not broken — reads as STALE. That is exactly this task\'s own abort '
      + 'condition: a barrier that reports the innocent gets shut off. Wiring it into '
      + '`mem doctor`\'s default findings would fire on a healthy-but-idle memory root, '
      + "not only a broken one. It is not a missing caller, it is a missing gate — the "
      + 'check needs "age > limit AND (behind > 0 OR behind is unknown)" before a caller '
      + 'can trust it, and adding that gate is a change to provenance.mjs\'s own tested '
      + 'contract (test/provenance.test.mjs asserts pure age-based STALE), out of scope '
      + 'for a wiring pass. Declared rather than forced in.',
  },
});

/**
 * True once a declaration is older than TTL_DAYS. `today` defaults to
 * the real clock and takes an override only so a test can prove the
 * boundary without waiting two weeks or faking Date globally.
 */
export function isExpired(entry, today = new Date()) {
  const since = new Date(`${entry.since}T00:00:00Z`);
  const ageMs = today.getTime() - since.getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return ageDays > TTL_DAYS;
}
