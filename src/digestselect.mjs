// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * digestselect — which pending captures one digest run gets.
 *
 * **Before (bin/mem-digest, until 2026-10-01): smallest first, nothing
 * else.** That keeps one huge capture from blocking everything behind
 * it, and it has the mirror-image hole: while small captures keep
 * arriving, a mid-sized OLD one is never the smallest and is never
 * chosen. A backlog that never drains its oldest end is starvation, and
 * nothing reports it — the run "did work" every time.
 *
 * **Now: an age reserve, then smallest first.** Part of the budget
 * (`reservePct`, default 25 %) goes to the OLDEST captures first, oldest
 * to newest, as long as they fit into the reserve; the oldest one that
 * fits into the whole budget is always taken, even when it is larger
 * than the reserve. The rest of the budget is filled smallest first,
 * exactly as before. So every capture that fits a run at all is chosen
 * after at most as many runs as there are older captures ahead of it —
 * a bound, where there was none.
 *
 * What stays as it was, on purpose:
 *   - a capture with no known size counts as LARGE (never zero: a silent
 *     stat error must not eat the cap) and is never taken by the reserve;
 *   - a capture larger than the whole budget is not forced in: a run
 *     that cannot finish it would pick it again next tick, forever.
 *     That is the case smallest-first was built against.
 *
 * The age is read from the capture's own name
 * (`raw/YYYY/MM/<ISO time>--<session>.jsonl.gz`, src/raw.mjs
 * capturePath). A name without a readable time has no age — it is not
 * "old", it is unknown, and only the smallest-first pass can take it.
 */

/** Share of the budget that goes to the oldest captures first. */
export const AGE_RESERVE_PCT = 25;

const STAMP = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;

/** Milliseconds since the epoch from a capture path, or `null`. */
function captureTime(p) {
  const base = String(p ?? '').split(/[\\/]/).pop() ?? '';
  const m = STAMP.exec(base);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : null;
}

/**
 * Choose the captures for one run.
 *
 * `pending` is the output of `mem raw pending --json` (`open`,
 * `rawSizes`). Returns `{ chosen, sum, total, reserved }` — `reserved`
 * names the captures the age reserve took, so the log can say why an
 * old capture was picked.
 */
export function selectCaptures(pending, { max, reservePct = AGE_RESERVE_PCT } = {}) {
  const open = Array.isArray(pending?.open) ? pending.open : [];
  const sizes = pending?.rawSizes ?? {};
  const cap = Number(max);
  const pct = Math.min(100, Math.max(0, Number.isFinite(Number(reservePct)) ? Number(reservePct) : AGE_RESERVE_PCT));
  const items = open.map((f, i) => {
    const g = sizes[f];
    return { f, s: typeof g === 'number' ? g : Infinity, t: captureTime(f), i };
  });

  const chosen = [];
  const taken = new Set();
  const reserved = [];
  let sum = 0;

  // 1. The age reserve: oldest first.
  const reserve = cap * (pct / 100);
  if (pct > 0) {
    const byAge = items.filter((x) => x.t !== null && Number.isFinite(x.s))
      .sort((a, b) => (a.t - b.t) || (a.i - b.i));
    for (const x of byAge) {
      const first = reserved.length === 0;
      if (first ? x.s > cap : sum + x.s > reserve) {
        if (first) continue; // too large for any run: not forced in
        break;
      }
      chosen.push(x.f); taken.add(x.f); reserved.push(x.f); sum += x.s;
      if (sum >= reserve) break;
    }
  }

  // 2. The rest of the budget: smallest first, as before.
  const bySize = items.filter((x) => !taken.has(x.f)).sort((a, b) => (a.s - b.s) || (a.i - b.i));
  for (const { f, s } of bySize) {
    if (sum >= cap) break;
    if (chosen.length && sum + s > cap) break;
    chosen.push(f); sum += s;
  }
  return { chosen, sum, total: open.length, reserved };
}
