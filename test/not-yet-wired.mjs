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
// that shape directly (2026-09-20 build plan, B7): "sie verfaellt nach
// 14 Tagen, dann wird der Riegel wieder rot". `isExpired` is that
// clock. It takes `today` as an argument on purpose, so a test can hand
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
    reason: 'the four-state clone-freshness check (fresh/stale/no_git/unknown, see its '
      + 'own docblock) is fully built and tested, but nothing in bin/ or the hooks '
      + 'calls it — unlike indexcache no wiring work is scheduled for it yet, which is '
      + 'exactly why writing that down beats leaving the guard to explain the silence',
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
