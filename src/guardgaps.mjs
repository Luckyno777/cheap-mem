// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * guardgaps — rank the errors that have NO guard, instead of reading
 * the whole error log by hand (mirror of the sibling's `riegelluecken`,
 * commit a0403a8b).
 *
 * Four quantities, but only THREE are weights. The fourth, "has a
 * guard", is a FILTER: an error WITH a guard is not a gap, however
 * fresh or repeated it is. That is also the abort criterion of this
 * ranking (pinned by test/guardgaps.test.mjs): a guarded error never
 * appears above, or at all among, the unguarded ones.
 *
 * One truth per question, nothing rebuilt:
 *   - "has a guard"     -> `memory.dutyHasEvidence` with a synthetic
 *                          one-error duty, the very check closing a duty
 *                          uses (guard field OR a non-empty test with
 *                          `// error: <id>` and `test(`)
 *   - "is a repeat"     -> `repetition.check` (F0)
 *   - "open duty there" -> `errorcontext.openDutiesFor` (F1)
 *
 * Weights are small whole numbers on purpose: the ORDER matters (which
 * quantity beats which), not a calibrated decimal that pretends a
 * precision the measurement does not have.
 */
import * as memory from './memory.mjs';
import * as errorfile from './errorfile.mjs';
import * as repetition from './repetition.mjs';
import * as errorcontext from './errorcontext.mjs';

/** Highest: same file + same class within 30 days — a guard HERE stops the next repeat. */
export const WEIGHT_REPETITION = 3;
/** Someone already marked the gap as work; pull it forward instead of ranking past it. */
export const WEIGHT_DUTY = 2;
/** Weakest: age only breaks ties, decaying linearly. */
export const WEIGHT_FRESH_MAX = 1;
/** Same horizon as the repetition rule — one number, not two that drift apart. */
const FRESH_WINDOW_DAYS = repetition.FILE_CLASS_WINDOW_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

function asTime(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function allErrors(root) {
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    let it;
    try { it = memory.iterLog(root, 'error', { project }); } catch { continue; }
    for (const e of it) {
      if (!e || e.__broken || memory.isClosingLine(e)) continue;
      out.push(e);
    }
  }
  return out;
}

/** Does THIS one error carry a guard (either evidence route)? `{ ok, why }`. */
export function hasGuard(root, errorId) {
  return memory.dutyHasEvidence(root, { error_ids: [errorId] });
}

function freshScore(entry, ref) {
  const t = asTime(entry?.ts);
  if (t === null) return 0;
  const ageDays = Math.max(0, (ref - t) / DAY_MS);
  return Math.max(0, 1 - ageDays / FRESH_WINDOW_DAYS) * WEIGHT_FRESH_MAX;
}

/**
 * Rank every error. `{ gaps, guarded, total, share }`; `share` is `null`
 * for an empty log — not measurable is not 0 %.
 */
export function rank(root, { now = new Date() } = {}) {
  const ref = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const all = allErrors(root);
  if (!all.length) return { gaps: [], guarded: 0, total: 0, share: null };

  let guarded = 0;
  const gaps = [];
  for (const e of all) {
    if (hasGuard(root, e.id).ok) { guarded += 1; continue; } // a filter, not a weight

    const files = errorfile.files(e);
    const cls = typeof e.class === 'string' && e.class.trim() ? e.class.trim() : null;
    const rep = repetition.check(e, all, { now: ref });
    const duties = errorcontext.openDutiesFor(root, { files, errorIds: [e.id] });

    // Only the file+class rule is a repeat HERE, like the sibling: the
    // class-only counter is not "a guard on this file would have helped".
    const repeated = rep.reasons.includes('file-class-30-days');
    const score = freshScore(e, ref)
      + (repeated ? WEIGHT_REPETITION : 0)
      + (duties.length ? WEIGHT_DUTY : 0);

    const reasons = [];
    if (repeated) reasons.push(`repeated (${rep.hits.length} earlier for the same file and class)`);
    if (duties.length) reasons.push(`open duty: ${duties.map((d) => d.id).join(', ')}`);
    const t = asTime(e.ts);
    const age = t === null ? null : Math.round((ref - t) / DAY_MS);
    if (age !== null) reasons.push(`${age} day${age === 1 ? '' : 's'} old`);
    if (!reasons.length) reasons.push('no guard, otherwise unremarkable');

    gaps.push({ id: e.id, file: files[0] ?? null, class: cls, score, reasons, ts: e.ts ?? null });
  }

  gaps.sort((a, b) => (b.score - a.score) || String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  return { gaps, guarded, total: all.length, share: guarded / all.length };
}

/** The top `n` gaps (`null` = all). */
export function top(root, n = 20, opts = {}) {
  const r = rank(root, opts);
  return { ...r, gaps: n === null ? r.gaps : r.gaps.slice(0, n) };
}
