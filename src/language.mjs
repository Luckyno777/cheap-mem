/**
 * language — per-language packs for the tokenizer.
 *
 * lucky-mem, the private ancestor of this tool, was German-only: it
 * transliterated umlauts, stripped German suffixes and split compounds
 * with the linking-s ("Sitzungspost" -> "sitzung" + "post"). None of
 * that helps an English corpus, and an English stemmer would wreck a
 * German one.
 *
 * So the tokenizer asks a pack. A pack is four things:
 *
 *   stopwords   words too common to carry meaning
 *   normalize   fold characters that are the "same letter" here
 *   stem        strip endings that carry no meaning
 *   compounds   whether to attempt compound splitting at all
 *
 * Picked by `language` in `.mem/config.json`. Unknown language: the
 * neutral pack — lowercase, no stemming, nothing clever. That is worse
 * than a real pack but never wrong, which matters more.
 *
 * Adding a language means adding a pack here and a few test cases.
 * No model, no dictionary file, no download.
 */

/**
 * Deliberately short stopword lists. Too many stopwords costs
 * precision on short titles, where every word is load-bearing.
 */
const EN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these',
  'not', 'no', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
  'by', 'as', 'if', 'so', 'than', 'then', 'too', 'very', 'just', 'only',
]);

const DE_STOP = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem',
  'einer', 'eines', 'und', 'oder', 'aber', 'ist', 'sind', 'war', 'waren',
  'wird', 'werden', 'wurde', 'wurden', 'hat', 'haben', 'hatte', 'hatten',
  'sein', 'seine', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'nicht',
  'kein', 'keine', 'mit', 'von', 'zu', 'zum', 'zur', 'auf', 'in', 'im',
  'an', 'am', 'fuer', 'für', 'bei', 'aus', 'nach', 'ueber', 'über', 'als',
  'wie', 'wenn', 'dass', 'da', 'so', 'auch', 'noch', 'nur', 'schon',
]);

/**
 * English suffix stripping. Conservative on purpose: only endings that
 * carry little meaning, and never below four remaining characters.
 *
 * Order matters — longest first, so "running" loses "ning"-worth of
 * ending via 'ing' before 'ng' could ever apply.
 *
 * This is not Porter. Porter is more thorough and more surprising;
 * for a personal corpus of a few thousand entries the extra recall is
 * not worth explaining why "operate" and "operation" sometimes are and
 * sometimes are not the same word.
 */
const EN_SUFFIXES = [
  'ization', 'iveness', 'fulness', 'ousness',
  'ational', 'tional', 'ations', 'ingly', 'edly',
  'ation', 'ement', 'ments', 'ness', 'able', 'ible',
  'ings', 'ment', 'ies', 'ing', 'ers', 'est', 'ies',
  'ed', 'er', 'ly', 's',
];

function enStem(word) {
  if (word.length <= 4) return word;
  // "libraries" -> "library" before the generic 's' rule eats the 'e'.
  if (word.endsWith('ies') && word.length >= 6) return `${word.slice(0, -3)}y`;
  for (const s of EN_SUFFIXES) {
    if (word.length - s.length >= 4 && word.endsWith(s)) {
      const cut = word.slice(0, -s.length);
      // Undo a doubled consonant: "running" -> "runn" -> "run"
      if (/(.)\1$/.test(cut) && !/(ss|ll|ee|oo)$/.test(cut)) return cut.slice(0, -1);
      return cut;
    }
  }
  return word;
}

const DE_SUFFIXES = [
  'ungen', 'lichen', 'ischen', 'heiten', 'keiten',
  'ung', 'lich', 'isch', 'heit', 'keit', 'chen', 'lein',
  'ern', 'end', 'est', 'ete',
  'en', 'er', 'es', 'em', 'st', 'te',
  'e', 'n', 's',
];

function deStem(word) {
  if (word.length <= 4) return word;
  for (const s of DE_SUFFIXES) {
    if (word.length - s.length >= 4 && word.endsWith(s)) return word.slice(0, -s.length);
  }
  return word;
}

/**
 * Fold the characters a reader would consider the same letter.
 *
 * German: umlauts have two spellings that people use interchangeably
 * ("Wächter" / "waechter"), so both must land on one token.
 * English: strip accents from loanwords ("café" / "cafe").
 */
function deNormalize(w) {
  return w
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

function stripAccents(w) {
  return w.normalize('NFD').replace(/\p{M}+/gu, '');
}

export const PACKS = Object.freeze({
  en: {
    name: 'en',
    stopwords: EN_STOP,
    normalize: stripAccents,
    stem: enStem,
    // English is usually thought of as a language without compounds,
    // but technical English is full of closed ones: datastore,
    // codebase, runtime, hostname, filesystem, changelog, rollback.
    // Splitting is additive — the full form is always kept too — and
    // both parts must already occur on their own in the corpus, so a
    // wrong split cannot invent a word that is not there.
    compounds: true,
    linkingChars: [],
  },
  de: {
    name: 'de',
    stopwords: DE_STOP,
    normalize: deNormalize,
    stem: deStem,
    // German glues nouns together without spaces; splitting them is
    // the single biggest recall win in a German corpus.
    compounds: true,
    linkingChars: ['s', 'n', 'es', 'en'],
  },
  // Dutch and the Nordic languages build compounds the same way.
  // Their stemming differs, but no stemming plus compound splitting
  // still beats neither.
  nl: { name: 'nl', stopwords: new Set(), normalize: stripAccents, stem: (w) => w, compounds: true, linkingChars: ['s', 'en'] },
  sv: { name: 'sv', stopwords: new Set(), normalize: stripAccents, stem: (w) => w, compounds: true, linkingChars: ['s'] },
  da: { name: 'da', stopwords: new Set(), normalize: stripAccents, stem: (w) => w, compounds: true, linkingChars: ['s', 'e'] },
  no: { name: 'no', stopwords: new Set(), normalize: stripAccents, stem: (w) => w, compounds: true, linkingChars: ['s', 'e'] },
});

const NEUTRAL = Object.freeze({
  name: 'neutral',
  stopwords: new Set(),
  normalize: stripAccents,
  stem: (w) => w,
  compounds: false,
});

/**
 * Pick a pack. Unknown language falls back to neutral rather than to
 * English — guessing English for a Japanese corpus would stem words
 * that have no such endings and quietly corrupt the index.
 */
export function pack(language) {
  if (!language) return PACKS.en;
  const key = String(language).toLowerCase().split(/[-_]/)[0];
  return PACKS[key] ?? NEUTRAL;
}

export function knownLanguages() {
  return Object.keys(PACKS);
}
