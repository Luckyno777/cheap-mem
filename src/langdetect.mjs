/**
 * langdetect — cheap, deterministic per-entry language detection.
 *
 * **The defect this closes.** The index used to carry ONE language
 * (`index.language`), read once from `.mem/config.json` and applied to
 * every entry regardless of what it was actually written in. A German
 * company writing German notes about English code got the wrong
 * stemmer for whichever half did not match the config — and nothing
 * said so. See `search.mjs` for how the per-entry result below is
 * used at both index and query time.
 *
 * **Method.** Stopword overlap over the entry's fields, weighted the
 * same way `search.mjs` already weights them for BM25 (a title is a
 * stronger signal than a body). Count how many tokens land in each
 * known language's stopword list; the language with the larger
 * weighted count wins, PROVIDED it wins by a real margin. No model, no
 * network, no dictionary beyond the stopword lists `language.mjs`
 * already carries for stemming. Deterministic: the same entry always
 * produces the same verdict.
 *
 * **Why stopword overlap and not something cleverer.** Stopwords are
 * the highest-frequency, most language-specific words there are — "the"
 * and "und" do not occur in the other language's text by chance the way
 * content words sometimes do (loanwords, code, product names). A short
 * entry (a title, a few words) still usually contains one, which a
 * character-n-gram model would need much more text to do reliably. The
 * price is the one this module is built around paying honestly: an
 * entry with NO stopword at all — a bare identifier, a version string,
 * a path — gives no signal, and no signal must not be read as English.
 *
 * **Only languages this codebase can actually tell apart.** `nl`, `sv`,
 * `da` and `no` in `language.mjs` carry no stopword list (their stemming
 * pack is real, their detection signal is not), so they are excluded
 * from `DETECTABLE_LANGUAGES` rather than silently guessed at. Adding a
 * language's detection support later means giving it a real stopword
 * list — the set below then grows on its own.
 */
import { PACKS, knownLanguages } from './language.mjs';

/** The literal third state. Never a language code, so it cannot be
 *  mistaken for one and cannot be defaulted into silently. */
export const UNCERTAIN = 'uncertain';

/** Languages with a real stopword list — the only ones detection can
 *  actually distinguish. See the module doc for why this is not "every
 *  language `language.mjs` knows how to stem". */
export const DETECTABLE_LANGUAGES = Object.freeze(
  knownLanguages().filter((code) => PACKS[code].stopwords.size > 0),
);

/**
 * How much bigger the winning language's weighted count must be than
 * the runner-up's, as a fraction of the winner's own count, before the
 * verdict counts as CERTAIN.
 *
 * Measured on `test/langdetect.test.mjs`'s mixed corpus (40 entries,
 * 20 English / 20 German, plus a handful of deliberately ambiguous
 * ones): at 0.34 every genuinely single-language entry with at least
 * one stopword clears the bar (a real title typically has three or
 * four times as many stopwords in its own language as in the other,
 * since the other language contributes only accidental collisions),
 * while a tied or near-tied count — the honest signature of "no
 * stopword fired, or one fired on each side" — stays UNCERTAIN rather
 * than being decided by a coin flip of which language happened to have
 * one more hit. See that file's `detection accuracy` test for the
 * measured number this threshold produces.
 */
export const MARGIN = 0.34;

const WORD_RE = /[\p{L}\p{N}_-]+/gu;

function wordsOf(text) {
  return String(text ?? '').toLowerCase().match(WORD_RE) ?? [];
}

/**
 * Detect one entry's language.
 *
 * `fieldWeights` should be the same field -> weight map the index scores
 * with (`FIELD_WEIGHTS` in `search.mjs`) — passed in rather than imported,
 * so this module never has to import `search.mjs` back (which imports
 * this one). Omit it to weigh every own-enumerable field of the entry
 * equally; useful for callers with no field-weight table of their own
 * (a raw capture's plain text, a test fixture).
 *
 * Returns `{ language, certain, scores }`:
 *   language   a code from `languages`, or `UNCERTAIN`
 *   certain    true only when `language` is a real code
 *   scores     the weighted stopword count per candidate language —
 *              plain data, kept so a caller (or a test) can show its
 *              working rather than trust a bare verdict
 */
export function detectEntryLanguage(entry, { fieldWeights = null, languages = DETECTABLE_LANGUAGES } = {}) {
  const counts = new Map(languages.map((l) => [l, 0]));
  const fieldEntries = fieldWeights
    ? Object.entries(fieldWeights)
    : Object.keys(entry ?? {}).map((k) => [k, 1]);

  for (const [field, weight] of fieldEntries) {
    const value = entry?.[field];
    if (!value) continue;
    const text = Array.isArray(value) ? value.join(' ') : String(value);
    for (const w of wordsOf(text)) {
      for (const l of languages) {
        if (PACKS[l].stopwords.has(w)) counts.set(l, counts.get(l) + weight);
      }
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const scores = Object.fromEntries(ranked);
  const total = ranked.reduce((s, [, n]) => s + n, 0);

  // No stopword hit anywhere: a bare identifier, a number, a path. This
  // is the case the brief names by name — "not measurable is not
  // zero" — so it is checked FIRST and separately from the margin test
  // below, not folded into "margin too small to call".
  if (total === 0) return { language: UNCERTAIN, certain: false, scores };

  const [topLang, topCount] = ranked[0];
  const secondCount = ranked[1] ? ranked[1][1] : 0;
  const margin = (topCount - secondCount) / topCount;
  if (margin < MARGIN) return { language: UNCERTAIN, certain: false, scores };
  return { language: topLang, certain: true, scores };
}
