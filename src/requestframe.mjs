// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * requestframe — the form of a request is not the subject of a question.
 * Ported from lucky-mem (`src/suche.mjs#ohneBittRahmen`, finding zcq542jvmifj).
 *
 * **The finding (lucky-mem).** Asked "explain the theory of relativity", the
 * word "explain" carried the search (its stem stood in 20 entries) and
 * brought up entries about an "explainer page"; the model then built an
 * HTML page, four times out of four. "explain" says nothing about the
 * SUBJECT of the question: it is the form of the request, like "please" or
 * "make".
 *
 * **The rule, general and by position.** A request verb is not a subject
 * word when it OPENS the question (an imperative, after at most a few
 * courtesy words: "please", "can you", "kannst du mir"), or when the
 * question opens with "kannst du / can you" and the verb follows as an
 * infinitive ("kannst du mir X erklaeren"). In the middle of a sentence it
 * stays a subject word: "how does the doc explain X", "mem show", "what
 * does the rule say" keep searching with the verb. Only the QUERY changes,
 * never the index.
 *
 * Behind "can you" only the ONE verb that closes the frame falls: the first
 * infinitive that is not a noun. It counts as a noun when it was written
 * with a capital, stands right behind an article, or behind "das" and is not
 * the last word. Nouns stay.
 *
 * Switch: `MEM_RETRIEVE_REQUEST_FRAME=0` is the old way. The rule acts where
 * a spoken question becomes a query: the recall hook's `mem find --recall`
 * and `contentWords()` / `retrievalQuery()` (so also `mem find
 * --content-words` and the sub-agent start's query for its assignment).
 *
 * **Known limit.** An English command name at the start of a question
 * ("show mem", "help text of the CLI") loses its first word because it reads
 * as a request verb; the other words carry the search on.
 *
 * The verbs are DATA in both languages the memory is written in.
 */

/** Request verbs in the imperative (du-form with and without -e), German and English. */
const VERBS = new Set([
  'erklaer', 'erklaere', 'uebersetz', 'uebersetze', 'zeig', 'zeige',
  'sag', 'sage', 'gib', 'nenn', 'nenne', 'schreib', 'schreibe',
  'mach', 'mache', 'hilf', 'beschreib', 'beschreibe', 'erzaehl', 'erzaehle',
  'explain', 'translate', 'show', 'tell', 'give', 'write', 'describe', 'help',
]);
/** The same verbs as an infinitive, only behind a "can you" opening. */
const INFINITIVES = new Set([
  'erklaeren', 'uebersetzen', 'zeigen', 'sagen', 'geben', 'nennen',
  'schreiben', 'machen', 'helfen', 'beschreiben', 'erzaehlen',
]);
/** Courtesy words before the verb ("please explain", "kannst du mir mal erklaeren"). */
const LEAD = new Set([
  'bitte', 'mal', 'kurz', 'doch', 'einmal', 'nochmal', 'mir', 'uns',
  'please', 'just', 'me', 'us',
]);
/** "can you ...", "could you ...": the modal word AND the one addressed; the infinitive may stand further back. */
const MODAL = new Set([
  'kannst', 'koenntest', 'wuerdest', 'willst', 'koennt', 'koennen', 'koennten', 'wuerden',
  'can', 'could', 'would', 'will',
]);
const ADDRESSEE = new Set(['du', 'ihr', 'sie', 'you']);
/** Articles and contractions: an infinitive right behind one is a noun. */
const ARTICLES = new Set([
  'der', 'den', 'dem', 'des', 'ein',
  'die', 'im', 'am',
  'eine', 'mein', 'dein',
  'einen', 'sein',
  'einem', 'unser',
  'zum', 'euer',
  'einer', 'ihr',
  'vom', 'jedes',
  'eines',
  'zur',
  'beim',
  'dieses',
]);

/** Switch: `MEM_RETRIEVE_REQUEST_FRAME=0` switches the rule off (the old way). */
export function requestFrameOn(env = process.env) {
  return String(env?.MEM_RETRIEVE_REQUEST_FRAME ?? '') !== '0';
}

/**
 * Indexes of the words that make up the request frame at the start of
 * `words` (lower case, transliterated). `capital[i]` says the word was
 * written with a capital (same length as `words`, else empty).
 */
function frameIndexes(words, capital) {
  let i = 0;
  let modal = false;
  while (i < words.length) {
    if (MODAL.has(words[i]) && ADDRESSEE.has(words[i + 1])) { modal = true; i += 2; continue; }
    if (LEAD.has(words[i])) { i += 1; continue; }
    break;
  }
  if (i < words.length && VERBS.has(words[i])) return Array.from({ length: i + 1 }, (_, k) => k);
  if (modal) {
    const withCase = capital.length === words.length;
    for (let j = i; j < words.length; j += 1) {
      if (!INFINITIVES.has(words[j])) continue;
      const before = j > i ? words[j - 1] : undefined;
      const noun = (withCase && capital[j])
        || ARTICLES.has(before)
        || (before === 'das' && j < words.length - 1);
      if (noun) continue;
      return [...Array.from({ length: i }, (_, k) => k), j];
    }
  }
  return [];
}

const WORD = /[A-Za-z0-9ÄÖÜäöüß]+/g;
const plain = (w) => w.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

/**
 * `text` without its request frame, or `text` itself when it has none. The
 * frame words are cut out where they stand, everything else (punctuation
 * included) stays; runs of white space are folded. Never throws.
 */
export function dropRequestFrame(text) {
  const s = String(text ?? '');
  const spans = [...s.matchAll(WORD)];
  if (!spans.length) return s;
  const words = spans.map((m) => plain(m[0]));
  const capital = spans.map((m) => /^[A-ZÄÖÜ]/.test(m[0]));
  const cut = frameIndexes(words, capital);
  if (!cut.length) return s;
  let out = '';
  let from = 0;
  for (const k of cut) {
    out += s.slice(from, spans[k].index);
    from = spans[k].index + spans[k][0].length;
  }
  out += s.slice(from);
  return out.replace(/\s+/g, ' ').trim();
}
