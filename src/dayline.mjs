// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * dayline.mjs — the one line of the day, and how it is shortened.
 *
 * Two surfaces say the same thing in one line: the session-start line (`today.line`) and the briefing (`appointment-today`:
 * subject and first line of the text). Both build their parts here and fit them here, so a part never has two spellings.
 *
 * **A part falls away whole, never in the middle of a word.** The old line cut at the limit with an ellipsis, and the cut could
 * stand inside a number or a word ("3 decisions op…"). Now every part has a rank (1 = the one to keep longest); when the line is
 * too long the part with the highest rank goes first, and so on, until the rest fits. What is left is complete text.
 *
 * **Quiet is nothing.** No part, no line (`null`). A part that could not be measured says so ("not measurable"), it is not left
 * out and it is never a 0: three states, never two.
 */

/** The ranks, in one place: the lower the number, the longer the part stays when the line is shortened. */
export const RANK = Object.freeze({
  overdue: 1, dueToday: 2, decisions: 3, operations: 4, projects: 5, verify: 6, gold: 7,
});

const plural = (n, one, many) => (n === 1 ? one : many);

/** `n deadline(s) overdue`, or `deadlines not measurable` when the count is `null`. `''` when there is nothing to say. */
export function overdueText(n) {
  if (n === null || n === undefined) return 'deadlines not measurable';
  return n > 0 ? `${n} ${plural(n, 'deadline', 'deadlines')} overdue` : '';
}

/** `n due today` (nothing when 0; `null` is said by {@link overdueText}, once). */
export function dueTodayText(n) {
  return typeof n === 'number' && n > 0 ? `${n} due today` : '';
}

/** `n project(s) awaiting confirmation`. The wording of the session-start line since the project rule; the briefing says the same. */
export function projectsText(n) {
  return typeof n === 'number' && n > 0 ? `${n} ${plural(n, 'project', 'projects')} awaiting confirmation` : '';
}

/**
 * Put the parts into one line.
 *
 * `parts` is a list of `{ text, rank }` in the order they are shown; empty texts are ignored. Returns `null` when there is no
 * part. If even the part of the best rank does not fit in `max` it is replaced by `fallback` (a short pointer), never cut.
 */
export function fit(parts, { max, prefix = 'Today: ', sep = ' · ', fallback = 'more than fits here, see mem today' } = {}) {
  const kept = (parts ?? []).filter((p) => p && typeof p.text === 'string' && p.text);
  if (!kept.length) return null;
  const build = (list) => `${prefix}${list.map((p) => p.text).join(sep)}`;
  let list = kept.slice();
  while (list.length && build(list).length > max) {
    // The part with the highest rank goes first; of two equal ranks, the one shown later.
    let worst = 0;
    for (let i = 1; i < list.length; i += 1) if (list[i].rank >= list[worst].rank) worst = i;
    list = list.filter((_, i) => i !== worst);
  }
  if (!list.length) {
    const f = `${prefix}${fallback}`;
    return f.length <= max ? f : null;
  }
  return build(list);
}
