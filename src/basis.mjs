/**
 * On what basis does this statement stand?
 *
 * Four kinds of sentence sit side by side in the memory and they all
 * look alike:
 *
 *   "timezone is Europe/Berlin"        — a person said so
 *   "index loads in 299 ms"            — a run measured it
 *   "the hook does not pull on a       — concluded from two
 *    dirty tree"                         other entries
 *   "the second host is the cause"     — guessed, never checked
 *
 * Whoever cannot see the difference treats a guess like a measurement.
 * That has happened here: a session post went out naming a prime
 * suspect that had been INFERRED from a facts file and never measured
 * — and the recipients chased the wrong lead.
 *
 * ## A mark, not a number
 *
 * The obvious design would be a confidence: 0.9 for measured, 0.5 for
 * guessed. That deliberately does not exist here. `0.82` does not say
 * WHY anything should be believed, and two numbers of different origin
 * invite being averaged. A mark does not: `guessed` and `measured`
 * have no mean.
 *
 * ## The one rule that carries it
 *
 * **An inferred mark never overwrites a stated one.** If a statement
 * someone uttered is later touched by an inference, `stated` stays.
 * Otherwise every guess launders itself into a fact over time — it is
 * enough to keep processing it.
 *
 * The ranking is therefore NOT "the stronger the better" but "whoever
 * has it first-hand keeps the floor": stated and measured stand above
 * inferred and guessed, and among themselves they do not replace each
 * other.
 */

/** The four bases. Closed list. */
export const BASIS = Object.freeze({
  /** A person or agent said it. */
  STATED: 'stated',
  /** A run measured it; the number is right there. */
  MEASURED: 'measured',
  /** Concluded from other entries; their ids are right there. */
  INFERRED: 'inferred',
  /** Guessed. What would be missing to know stands with it. */
  GUESSED: 'guessed',
});

const ALL = new Set(Object.values(BASIS));

/** First-hand — these two are not overwritten. */
const FIRST_HAND = new Set([BASIS.STATED, BASIS.MEASURED]);

/**
 * The mark of an entry, if it carries one.
 *
 * If it carries none, NONE is invented. `null` means "not given" — not
 * `stated`. A default would be the most convenient way to flatten the
 * whole distinction again: every old entry would retroactively carry a
 * mark nobody checked.
 */
export function markOf(entry) {
  const b = entry?.basis;
  if (typeof b === 'string' && ALL.has(b)) return b;
  return null;
}

/**
 * May `next` replace the mark `prev`?
 *
 * Without a previous mark: yes. First-hand: only by first-hand, and
 * even then only when it is the same one (a measurement does not
 * refute a statement, it stands beside it — that is what
 * `contradicts` links are for).
 */
export function mayReplace(prev, next) {
  if (!ALL.has(next)) return false;
  if (prev == null) return true;
  if (!FIRST_HAND.has(prev)) return true;
  return prev === next;
}

/**
 * Set a mark without overwriting an existing first-hand one. Returns
 * the entry — changed or unchanged.
 */
export function set(entry, next, extra = {}) {
  const prev = markOf(entry);
  if (!mayReplace(prev, next)) return entry;
  return { ...entry, basis: next, ...extra };
}

/**
 * What MUST stand next to the mark for it to be worth anything.
 *
 * A mark without evidence is a number by other means. So: `inferred`
 * demands the ids it was concluded from; `measured` demands that there
 * is a number in the entry at all; `guessed` demands the sentence
 * saying what is missing.
 *
 * Returns the list of defects — empty means fine.
 */
export function defects(entry) {
  const b = markOf(entry);
  if (b == null) return [];
  const out = [];
  if (b === BASIS.INFERRED) {
    const q = entry?.provenance?.derived_from ?? entry?.provenance?.inferred_from;
    if (!Array.isArray(q) || q.length === 0) {
      out.push('inferred without provenance.derived_from — concluded from WHAT?');
    }
  }
  if (b === BASIS.MEASURED) {
    if (!/\d/.test(JSON.stringify(entry ?? {}))) out.push('measured, but no number in the entry');
  }
  if (b === BASIS.GUESSED) {
    const w = entry?.what_is_missing ?? entry?.open;
    if (typeof w !== 'string' || !w.trim()) {
      out.push('guessed without what_is_missing — what would it take to know?');
    }
  }
  return out;
}

/** The mark for a reader, in front of the text. */
export function asMark(entry) {
  const b = markOf(entry);
  if (b == null) return '';
  if (b === BASIS.STATED) return '[stated]';
  if (b === BASIS.MEASURED) return '[measured]';
  if (b === BASIS.INFERRED) return '[inferred]';
  return '[GUESSED]';
}

/** A count over a body of entries, with the defects. */
export function overview(entries = []) {
  const count = { stated: 0, measured: 0, inferred: 0, guessed: 0, without: 0 };
  const defectList = [];
  for (const e of entries) {
    const b = markOf(e);
    if (b == null) count.without += 1; else count[b] += 1;
    for (const d of defects(e)) defectList.push({ id: e?.id ?? null, defect: d });
  }
  return { count, defects: defectList };
}
