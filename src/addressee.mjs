// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * addressee — to whom is an entry addressed? (H11, card-rule-doctor-cm)
 *
 * A LEAF: it imports nothing and does no I/O. It stands alone because the write rule (`cardrule`, called from the write core
 * `memory.logCheckedEntry`), the day part `today.decisionsForHuman`, the question reader and the doctor all ask the same thing,
 * and a ring between them (doctor -> today -> doctor, memory -> rule -> memory) would be the price of putting it in any one of them.
 *
 * **One normalisation.** `who` is read TRIMMED, everywhere. A duty written with `--who " alice "` is the human's duty for the rule,
 * for `mem today` and for the doctor alike; before, the day part compared the raw text and would have missed it while a rule
 * that trims would have caught it. Only a text counts as a name: a number, a list or an object addresses nobody.
 *
 * **No names.** Who the human IS comes from `.mem/config.json` (`config.humanParticipant`), never from this file (design
 * commitment 3). This file only reads the field.
 */

// invariant: eine-regel-eine-stelle

/** The fields that name the addressee of a duty, in the order they count (the first one that is present wins). */
const DUTY_FIELDS = Object.freeze(['who', 'owner', 'to']);

/** A name, trimmed; '' for anything that is not a text (or only blanks). */
export function nameOf(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The addressee of a duty: the first of `who`, `owner`, `to` that is set (not null / undefined), trimmed; '' when none is a
 * usable name. A blank `who` does not fall through to `owner`: it is a field that is there and says nothing (same precedence as
 * `p.who ?? p.owner ?? p.to` before).
 */
export function ofDuty(p) {
  if (!p || typeof p !== 'object') return '';
  for (const f of DUTY_FIELDS) {
    if (p[f] !== undefined && p[f] !== null) return nameOf(p[f]);
  }
  return '';
}

/** The addressee of a question: its `who`, trimmed ('' when there is none). */
export function ofQuestion(q) {
  return q && typeof q === 'object' ? nameOf(q.who) : '';
}

/** The addressee of an entry of the given type (`duty` | `question`); '' for any other type. */
export function of(type, entry) {
  if (type === 'duty') return ofDuty(entry);
  if (type === 'question') return ofQuestion(entry);
  return '';
}
