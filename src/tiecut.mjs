// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * tiecut — the cut at `top` with a guard for a tie. A port of the sibling
 * house's tie cut (decision 11p8eskakvf5).
 *
 * **The finding.** The recall hook asks `mem find --top N` and shows what
 * comes back. When the first hit that did NOT make the cut scores almost
 * exactly like the last one that did (a tenth of a point apart), the order
 * of two near-equal hits decided by accident which of them went out. Now
 * the first remaining hit whose score is at most `spread` (relative, 1 %)
 * below the last shown one comes along. Cap: ONE hit more, however many
 * others lie inside the spread. As in lucky-mem a remaining hit that scores
 * ABOVE the last shown one (MMR had moved it back) qualifies too.
 *
 * **Ships OFF in cheap-mem.** Measured on the gold set (3000 notes) 7 of 10
 * extra hits lay above the score of rank 3, none was a wanted entry, and the
 * only gold loss was an older version of the same decision (see below).
 *
 * **Where it acts.** Only on the recall hook's own call (`mem find
 * --recall`, which `bin/mem-retrieve`, its PowerShell twin and the warm
 * recall server pass). An explicit `mem find --top 5` by a person or a
 * script keeps meaning five: the count is its contract, and the tests and
 * tools that read it count on that. The score bar of the hook
 * (`MEM_RETRIEVE_MIN`) applies to the extra hit like to every other, and
 * the answer gate (search lever h3) decides on the hard cut alone.
 *
 * ONE place for the rule, so that the cut has no second copy.
 */

/**
 * Default: OFF (0). The rule is built and measured, and ships switched off:
 * on cheap-mem's gold set it gained nothing and cost one gold case (see
 * docs/recall-levers-2026-10-10.md, `node bench/recall-levers.mjs`).
 * `MEM_RETRIEVE_TIE=0.01` is the 1 % of lucky-mem.
 */
export const TIE_DEFAULT = 0;

/** The spread lucky-mem ships with (1 %); what `MEM_RETRIEVE_TIE=0.01` asks for. */
export const TIE_SPREAD_LM = 0.01;

// Upper bound for the spread: 0.5 = 50 %. Someone who sets `MEM_RETRIEVE_TIE=1`
// meaning "1 %" means 0.01 and would take EVERY remaining hit with 1 (= 100 %);
// outside 0 < x <= 0.5 (also NaN, negative) the safe fallback holds: the hard cut.
const SPREAD_MAX = 0.5;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
// The id of a hit: raw from search() (`entry.id`) or already flattened (`id`).
const idOf = (h) => h?.entry?.id ?? h?.id ?? null;

/** The spread the environment asks for: unset or empty = {@link TIE_DEFAULT}, else the number (checked by the cut). */
export function tieSpread(env = process.env) {
  const raw = env?.MEM_RETRIEVE_TIE;
  return (raw === undefined || raw === null || raw === '') ? TIE_DEFAULT : Number(raw);
}

/**
 * Cuts `ordered` (already in its final order) to `top` and takes at most ONE
 * more hit: the FIRST one from rank top+1 on (in that order, after MMR and
 * the exact lane) with `(score_top - score) / score_top <= spread`. It is
 * appended. The order is not sorted by score: rank top+1 can lie outside
 * and a later one inside.
 *
 * With a `spread` outside 0 < x <= 0.5, a `score_top` that is not positive
 * or missing, the plain cut holds. A hit without a numeric score never
 * qualifies, and a hit whose id is already among those shown is skipped
 * (the same entry must not stand twice). Always returns a new array.
 */
export function cutWithTie(ordered, top, spread = TIE_SPREAD_LM) {
  const base = ordered.slice(0, top);
  if (!(finite(spread) && spread > 0 && spread <= SPREAD_MAX) || top < 1 || ordered.length <= top) return base;
  const last = ordered[top - 1]?.score;
  if (!finite(last) || last <= 0) return base;
  const shown = new Set(base.map(idOf).filter((id) => id != null));
  for (let i = top; i < ordered.length; i += 1) {
    const score = ordered[i]?.score;
    if (!finite(score) || shown.has(idOf(ordered[i]))) continue;
    if ((last - score) / last <= spread) return [...base, ordered[i]];
  }
  return base;
}
