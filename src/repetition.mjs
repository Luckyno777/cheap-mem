/**
 * repetition — the ONE place that answers "is this error a repeat?"
 *
 * Ported from lucky-mem/src/wiederholung.mjs (F0/F1,
 * BAUPLAN-mem-admin_02.md Block F): the doctor finding `repetition` and
 * the write-time hint/auto-duty path (`errorcontext.mjs`) ask the exact
 * SAME question — same file AND same class within the last 30 days, or
 * the same class at least three times within the last 7 days. Two
 * versions of that rule at two call sites drift apart (the same lesson
 * the duty to post-liegt/briefkasten in lucky-mem's `global/pflichten.jsonl`
 * id `kk035pdorf60` already paid for) — so it lives here exactly once,
 * and both callers import it.
 *
 * Which file an error concerns is answered by `src/errorfile.mjs`; this
 * module only says WHEN two errors count as "the same repetition".
 */

import * as errorfile from './errorfile.mjs';

/** Window for "same file + same class". */
export const FILE_CLASS_WINDOW_DAYS = 30;
/** From how many occurrences of the same class (the new error counted) on. */
export const CLASS_THRESHOLD = 3;
/** Window for the class threshold. */
export const CLASS_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function asTime(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * Check one error `e` against a list of OTHER errors `all` — the pool
 * `e` itself may come from (it is filtered out by its own `id`, so a
 * call with the whole corpus never counts an error against itself).
 *
 * Returns `{ is, reasons, hits, files, classCount }`.
 *   - `reasons` is a subset of `['file-class-30-days', 'class-3x-7-days']`
 *     — empty means no repetition.
 *   - `hits` are the earlier entries that carry the first reason
 *     (evidence for the file+class rule).
 *   - `files` is `errorfile.files(e)` — `[]` means no determinable
 *     file, so only the class rule can fire.
 *   - `classCount` is how many occurrences of the same class fall in
 *     the last `CLASS_WINDOW_DAYS`, `e` itself counted — the same
 *     count `mem log` already shows ("this is number N").
 */
export function check(e, all, { now = Date.now() } = {}) {
  const ownTime = asTime(e?.ts);
  const asOf = ownTime ?? now;
  const files = errorfile.files(e);
  const className = typeof e?.class === 'string' && e.class.trim() ? e.class.trim() : null;
  const reasons = [];
  const hits = [];

  if (files.length && className) {
    const cutoff = asOf - FILE_CLASS_WINDOW_DAYS * DAY_MS;
    for (const x of all) {
      if (!x || x === e || (e?.id && x.id === e.id)) continue;
      if (x.class !== className) continue;
      const xt = asTime(x.ts);
      // Only EARLIER errors count as history — one written the same
      // second is not a lead-up.
      if (xt === null || xt >= asOf || xt < cutoff) continue;
      const xf = errorfile.files(x);
      if (!xf.some((f) => files.includes(f))) continue;
      hits.push(x);
    }
    if (hits.length) reasons.push('file-class-30-days');
  }

  let classCount = 0;
  if (className) {
    const cutoff7 = asOf - CLASS_WINDOW_DAYS * DAY_MS;
    const earlier = all.filter((x) => {
      if (!x || x === e || (e?.id && x.id === e.id)) return false;
      if (x.class !== className) return false;
      const xt = asTime(x.ts);
      return xt !== null && xt < asOf && xt >= cutoff7;
    }).length;
    classCount = earlier + 1; // e itself counts — "the Nth time" means N-1 earlier plus this one.
    if (classCount >= CLASS_THRESHOLD) reasons.push('class-3x-7-days');
  }

  return {
    is: reasons.length > 0,
    reasons,
    hits,
    files,
    classCount,
  };
}
