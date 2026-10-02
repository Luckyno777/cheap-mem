// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-fair-cm), step (c): the expansions.
// Gold notes: hand-written per note (expansions-gold.json). Filler notes:
// composed from per-template-part phrases (expansions-filler.json), the
// same rule for every filler note in the corpus.
import fs from 'node:fs';
const GOLD = JSON.parse(fs.readFileSync(new URL('./expansions-gold.json', import.meta.url), 'utf8'));
const PART = JSON.parse(fs.readFileSync(new URL('./expansions-filler.json', import.meta.url), 'utf8'));
export const goldAskedAs = (id) => GOLD[id] ?? null;
/** A filler entry as bench/scale.mjs writes it -> its 10 phrases. */
export function fillerAskedAs(e) {
  const verb = Object.keys(PART.verb).find((x) => e.title.startsWith(`${x} `));
  const noun = Object.keys(PART.noun).find((x) => e.title.includes(x));
  const why = Object.keys(PART.why).find((x) => e.text.startsWith(x));
  return [...PART.topic[e.topic].slice(0, 2), ...PART.verb[verb].slice(0, 2),
    ...PART.noun[noun].slice(0, 3), ...PART.why[why].slice(0, 3)];
}
/** Class key of a filler note: the same verb, noun, topic and reason. */
export function fillerClass(e) {
  return `${e.title.replace(/ \(ref\w+\)$/, '')}|${e.text.split(';')[0]}`;
}
