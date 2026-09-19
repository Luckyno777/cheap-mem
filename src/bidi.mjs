/**
 * bidi — the Trojan Source bidi-override characters (CVE-2021-42574),
 * caught at DISPLAY time.
 *
 * **Why display, not write.** A marker nobody sees does not help. The
 * nine characters here do their damage by changing how a TERMINAL or an
 * EDITOR reorders the glyphs it renders — the bytes on disk are
 * completely unremarkable UTF-8, so a write-time check can only ever
 * refuse or flag a write, never undo what a reorder already did to the
 * reader's eyes. The place the deception actually WORKS is wherever
 * this text next gets rendered — a terminal, an HTML page, or the
 * context handed to an agent — so that is where it has to be stopped.
 * Every one of those render paths is a different piece of code
 * (`mem find`, `mem browse`, the retrieval hook's `additionalContext`,
 * the SessionStart context dump), which is why this lives as one small
 * shared module rather than four copies of the same nine-character
 * class.
 *
 * **A CLOSED list of exactly nine codepoints — not "all Bidi
 * characters".** Unicode's Bidi_Class covers hundreds of codepoints,
 * starting with every Arabic and Hebrew letter: those are how real
 * right-to-left text is represented, and the algorithm reorders them
 * automatically without needing any of the nine controls below. A
 * filter built from the general Bidi_Class property would flag Arabic
 * and Hebrew prose itself as an attack — the exact false positive this
 * module is proven NOT to produce (see test/bidi.test.mjs). What
 * CVE-2021-42574 actually abuses is a much smaller, specific set: the
 * five EXPLICIT EMBEDDING/OVERRIDE controls (U+202A-U+202E) and the
 * four EXPLICIT ISOLATE controls (U+2066-U+2069) — the only codepoints
 * that can make a renderer show bytes in an order that does not match
 * the order they appear in the file. Ordinary bidi text needs none of
 * them; a source file legitimately needs none of them either.
 */

const RANGE = '\\u202A-\\u202E\\u2066-\\u2069';

/** The exact nine codepoints this module knows about — and no others. */
export const CODEPOINTS = Object.freeze([
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

const NAMES = Object.freeze({
  0x202A: 'LRE', 0x202B: 'RLE', 0x202C: 'PDF', 0x202D: 'LRO', 0x202E: 'RLO',
  0x2066: 'LRI', 0x2067: 'RLI', 0x2068: 'FSI', 0x2069: 'PDI',
});

// A fresh RegExp per call rather than one shared global-flagged instance:
// a shared `/g` regex carries `lastIndex` between calls, and a caller
// that mixes `has()` and `count()` on the same text (or two calls that
// race) would silently pick up wherever the last call left off. That
// class of bug is invisible in a straight-line test and real the moment
// two callers share the module — not worth the tiny cost of a new
// RegExp for something that runs once per displayed line, not per byte
// of a corpus.
function pattern(flags = '') {
  return new RegExp(`[${RANGE}]`, flags);
}

/** Does this text contain any of the nine bidi-override codepoints? */
export function has(text) {
  if (typeof text !== 'string' || !text) return false;
  return pattern().test(text);
}

/** How many occurrences — for a doctor-style count, not just yes/no. */
export function count(text) {
  if (typeof text !== 'string' || !text) return 0;
  const m = text.match(pattern('g'));
  return m ? m.length : 0;
}

/**
 * Replace every occurrence with a plain-ASCII marker that names the
 * character it stood for.
 *
 * The marker is `[U+202E]` — square brackets, digits, letters, nothing
 * else. It is deliberately NOT the character's short name alone
 * (`[RLO]` reads like normal text and a reviewer skims past it) and
 * deliberately NOT the raw character re-encoded some other way (that
 * would just move the attack, not neutralise it). A codepoint in
 * brackets is unambiguous, greppable, and — because every byte in it is
 * plain ASCII with a neutral Bidi_Class — cannot itself trigger any
 * reordering in the terminal it is about to be printed to.
 */
export function visible(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(pattern('g'), (ch) => {
    const cp = ch.codePointAt(0);
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    return `[U+${hex}${NAMES[cp] ? `:${NAMES[cp]}` : ''}]`;
  });
}
