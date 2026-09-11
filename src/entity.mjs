// entity.mjs — machine-shaped identifiers, exact rather than similar.
//
// THE FINDING behind it (2026-09-06). A new class of task asks about
// paths, case numbers, service names and versions. Measured on the eval
// corpus:
//
//   I1  gold rank 1..5   score 1.35
//   I2  gold rank 1      score 0.95
//   I3  gold rank 1      score 1.23
//   I4  gold rank 1      score 2.44
//   I5  gold rank 1      score 1.12
//   I6  gold rank 1      score 1.75
//
// So the ranking is RIGHT — five of six at rank one. And still nothing
// arrives, because every score sits below the retrieval threshold of
// 5.0. What blocks this class is not the order, it is the threshold.
//
// The cause is structural: BM25 rewards many matching words. A question
// about a path has exactly ONE matching word, and the entry is short. A
// threshold calibrated on prose cuts away precisely the most precise
// hits.
//
// THE ANSWER IS NOT MORE SCORE, IT IS A DIFFERENT KIND OF STATEMENT. If
// the question contains `7318` and exactly one entry contains `7318`,
// that is not similarity, it is certainty. Thresholds are for
// similarity. An exact hit goes past them.
//
// What this is NOT: no boost (a boost can bury a better answer), no
// filter (a filter can throw everything away), no further weight in a
// sum (the next knob nobody can calibrate). It is a lane of its own —
// the same shape the gateway already uses for authority tiers and for
// raw captures.

/**
 * The patterns. Deliberately narrow: each recognises a form a HUMAN
 * does not type by accident, and which identifies as a string.
 *
 * What is DELIBERATELY absent: capitalisation. In German every noun is
 * capitalised, which makes it worthless as a proper-noun heuristic and
 * would flood the index with half the prose.
 */
export const PATTERNS = Object.freeze([
  // Paths: at least one slash, no space, with an extension or directory
  // depth. `src/redaktion/kanarienvogel.mjs`
  { name: 'path', re: /\b[\w.-]+(?:\/[\w.-]+)+\b/g },
  // Versions in the x.y.z shape — `3.7.2`
  { name: 'version', re: /\b\d+\.\d+\.\d+\b/g },
  // Hyphenated names with at least two parts — `kolibri-taktgeber`.
  // Two letters per part, so "e-mail" and hyphenation stay out.
  { name: 'name', re: /\b[a-z]{2,}[a-z0-9]*(?:-[a-z0-9]{2,}[a-z0-9]*)+\b/gi },
  // Four- to eight-digit numbers — case numbers, tickets, ports. Below
  // four digits too much everyday number comes with it ("30 Tage").
  { name: 'number', re: /\b\d{4,8}\b/g },
  // UPPER_WITH_UNDERSCORE — environment variables
  { name: 'environment', re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
  // Qualified names: `AuthService.refreshToken`, `store.put`,
  // `README.md`. Dot-separated, no spaces.
  //
  // **The finding (2026-09-09).** An entry was always allowed to carry
  // a `symbols` field, and `entityText` reads every string field. Still
  // `mem find "TokenStore.write"` found nothing: none of the five
  // patterns recognises a dot-separated name. The exact lane — the lane
  // for exactly this kind of question — was simply blind to code
  // symbols. Measured, not assumed: `identifiers()` returned an empty
  // set on the text containing the symbol.
  //
  // **Why it still stays narrow.** Every segment at least TWO
  // characters: that throws out the common abbreviations which look
  // like a qualified name in German — `z.B.`, `u.a.`, `d.h.`, `e.g.`,
  // `i.e.` all have single-letter segments. No pure digit runs: `3.7.2`
  // belongs to `version`, `1.5` is a number.
  //
  // And above it the `slots` bound still applies: an identifier
  // occurring in more documents than the answer has slots does not
  // count. A `README.md` that appears everywhere identifies nothing and
  // drops out by itself. By construction the rule cannot produce more
  // candidates than are needed.
  { name: 'qualified', re: /\b(?![\d.]+\b)\w{2,}(?:\.\w{2,})+\b/g },
]);

/** Every machine-shaped identifier in a text, lower-cased. */
export function identifiers(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) out.add(m[0].toLowerCase());
  }
  return out;
}

/**
 * The index: identifier -> set of document numbers.
 *
 * Raw captures count here. Unlike with idf they distort nothing: an
 * exact hit is an exact hit wherever it stands, and a path in a capture
 * is just as much a location as one in an entry.
 */
export function buildIndex(documents, textOf) {
  const map = new Map();
  documents.forEach((doc, i) => {
    for (const b of identifiers(textOf(doc))) {
      let s = map.get(b);
      if (!s) { s = new Set(); map.set(b, s); }
      s.add(i);
    }
  });
  return map;
}

/**
 * Which documents does the question hit exactly?
 *
 * The bound has NO free parameter: an identifier counts only if it
 * occurs in at most `slots` documents — that is, in so few that they all
 * fit into the answer anyway. Occurring more often it is no longer an
 * identifier but furniture (`src/index.mjs` in a JS project), and
 * identifies nothing.
 *
 * That makes the rule self-limiting: by construction it cannot produce
 * more candidates than the answer has slots.
 */
export function hits(map, question, slots) {
  const out = new Map();   // docIndex -> which identifiers
  if (!map || !map.size) return out;
  for (const b of identifiers(question)) {
    const s = map.get(b);
    if (!s || s.size === 0 || s.size > slots) continue;
    for (const i of s) {
      let l = out.get(i);
      if (!l) { l = []; out.set(i, l); }
      l.push(b);
    }
  }
  return out;
}

/** For the cache: Map<string, Set<number>> <-> a JSON-able shape. */
export function pack(map) {
  return [...map].map(([b, s]) => [b, [...s]]);
}

export function unpack(raw) {
  return new Map((raw ?? []).map(([b, l]) => [b, new Set(l)]));
}
