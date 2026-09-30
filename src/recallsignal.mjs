// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * recallsignal — does a SHORT prompt carry a search signal? (Z1c)
 *
 * **The finding (external brief 2026-09-30, reproduced).** The recall hook
 * ended before search and journal for anything under 12 characters. A
 * prompt naming exactly one unambiguous term of 11 characters produced
 * zero bytes and no journal line: the unique word was in the memory, and
 * the question was not even booked as a miss.
 *
 * **What is kept.** The 12-character bar stays for ordinary short words.
 * The sibling house re-measured it on 2026-09-18 over 402 real messages:
 * 1.7 percent are shorter than twelve characters, and lowering the bar
 * for everything bought one good hit at the price of two noise hits
 * ("go on", "that fits" have content words that clear the score bar).
 * Rarity of a word alone did not separate meaning from noise there
 * either, so the exception below is NARROW.
 *
 * **What is new.** A short prompt is searched when it names something
 * that identifies by its shape, not by its meaning:
 *
 *   - an entry ID (or a long-enough prefix of one),
 *   - a file name,
 *   - an error code,
 *   - a word that stands in at most `RARE_DF` documents of the whole index
 *     (the same size the search already calls "rare").
 *
 * Pure confirmations ("yes", "ok", "go on", "fits") are never searched,
 * whatever else is true; they are booked as `no-signal`. Deterministic,
 * no model. The score bar of the hook still applies afterwards: this
 * decides only whether a search is worth running.
 */

/** The bar for ordinary prompts, in characters. */
export const MIN_CHARS = 12;

/** Whole-prompt confirmations. Lower-case, punctuation stripped. */
export const CONFIRMATION_WORDS = Object.freeze(new Set([
  'yes', 'yep', 'yeah', 'yup', 'no', 'nope', 'ok', 'okay', 'k', 'kk', 'sure', 'fine', 'good',
  'great', 'nice', 'right', 'correct', 'exactly', 'agreed', 'thanks', 'thx', 'thank', 'you',
  'please', 'go', 'on', 'ahead', 'continue', 'proceed', 'next', 'done', 'do', 'it', 'lgtm',
  'that', 'this', 'works', 'fits', 'is', 'so', 'all', 'of', 'the', 'and', 'then', 'now', 'again',
  'more', 'stop', 'wait', 'hmm', 'ah', 'oh', 'cool', 'perfect', 'alright',
]));

const ID_PREFIX = /(?<![A-Za-z0-9])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,11}(?![A-Za-z0-9])/;
const FILE_NAME = /(?:^|[\s/\\("'`])[\w.-]*[\w-]\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonl|md|sh|ps1|py|ya?ml|toml|txt|css|html|lock|log|env)(?![\w])/i;
const ERROR_CODE = /(?<![A-Za-z0-9_])(?:E[A-Z]{3,}[A-Z0-9_]*|ERR_[A-Z0-9_]+|[A-Z]{2,6}-?\d{3,5}|(?:exit|code)\s*\d+)(?![A-Za-z0-9_])/;

function words(t) {
  return String(t).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/** True when every word of the prompt is a confirmation word (and there is one). */
export function isConfirmation(prompt) {
  const w = words(prompt);
  return w.length > 0 && w.every((x) => CONFIRMATION_WORDS.has(x));
}

/** `id`, `file`, `error-code` or `null`: a shape that names one thing. */
export function shapeSignal(prompt) {
  const t = String(prompt);
  if (ERROR_CODE.test(t)) return 'error-code';
  if (FILE_NAME.test(t)) return 'file';
  if (ID_PREFIX.test(t)) return 'id';
  return null;
}

/**
 * Words of the prompt that stand in 1..rareDf documents of the index.
 * `tokenizeGroups` yields the typed word's own form first; a word the
 * index has never seen (df 0) is NOT rare, it is unknown — and unknown
 * is not a reason to search.
 */
export function rareWords(prompt, docFreq, { tokenizeGroups, rareDf }) {
  const out = [];
  for (const g of tokenizeGroups(String(prompt))) {
    const t = g[0];
    if (!t || t.length < 3 || CONFIRMATION_WORDS.has(t)) continue;
    const n = docFreq.get(t) ?? 0;
    if (n > 0 && n <= rareDf) out.push(t);
  }
  return out;
}

/**
 * The decision. `index` is only needed for the rare-word case and is
 * loaded lazily through `loadIndex()`, so shape and confirmation
 * verdicts cost nothing.
 *
 * Returns `{ search: boolean, why: string }`; `why` is `long`,
 * `confirmation`, `empty`, `id`, `file`, `error-code`, `rare-word`,
 * `no-signal` or `not-measurable` (rare-word check wanted, index not
 * readable: not measurable is not "no").
 */
export async function judge(prompt, { loadIndex = null, minChars = MIN_CHARS } = {}) {
  const t = String(prompt ?? '');
  if (t.trim().length === 0) return { search: false, why: 'empty' };
  if (t.length >= minChars) return { search: true, why: 'long' };
  if (isConfirmation(t)) return { search: false, why: 'confirmation' };
  const shape = shapeSignal(t);
  if (shape) return { search: true, why: shape };
  if (!loadIndex) return { search: false, why: 'no-signal' };
  try {
    const { tokenizeGroups, RARE_DF } = await import('./search.mjs');
    const index = await loadIndex();
    if (!index || !index.docFreq) return { search: false, why: 'not-measurable' };
    const rare = rareWords(t, index.docFreq, { tokenizeGroups, rareDf: RARE_DF });
    return rare.length ? { search: true, why: 'rare-word' } : { search: false, why: 'no-signal' };
  } catch {
    return { search: false, why: 'not-measurable' };
  }
}
