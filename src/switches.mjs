// src/switches.mjs — ONE place that knows which switch names are taken.
//
// **The finding (2026-09-17, sibling memory, found by making it).**
// Typed `--projekt` instead of `--project` on a `log` command. Nothing
// was reported. The unknown switch became a FIELD on the entry, and,
// because no project was named, the entry was filed GLOBALLY instead of
// in the project. Two silent errors from one keystroke. It was found
// only because the success message prints the path and somebody read it.
//
// The open field vocabulary stays — it is deliberate and useful: a `log`
// command accepts any `--name value` as a field, which is what makes
// the store fit a domain it has never seen. What is refused is only the
// NARROW MISS of a reserved name, because that is never what anybody
// meant.
//
// Why this is its own module, and not a few functions inside `bin/mem`:
// a probe that recomputes the threshold itself passes when the rule
// changes underneath it. So the rule lives here, once, and the probe
// imports THIS.

/** The switches the CLI keeps for itself — they never become fields. */
export const RESERVED_SWITCHES = Object.freeze(['project', 'root']);

/** Edit distance, capped: anything beyond 2 is of no interest here. */
export function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How far a switch may sit from a reserved name without counting as a
 * typo of it.
 *
 * **Length-dependent, and measured rather than picked.** Over the 235
 * distinct `--switch` names this repo's own code, tests and docs
 * actually use:
 *
 *   `project` (7 chars), distance <= 2 -> 0 real names caught
 *   `project` (7 chars), distance <= 3 -> 2 (`prose`, `subject`)
 *   `root`    (4 chars), distance <= 1 -> 0 real names caught
 *   `root`    (4 chars), distance <= 2 -> 6 (`font`, `host`, `out`,
 *                                            `port`, `role`, `tool`)
 *
 * So one flat number is wrong in both directions: 2 everywhere would
 * make `mem log --port 8080` impossible, and 1 everywhere would let the
 * transposition `--porject` (distance 2) through, which is the typo a
 * fast typist actually makes. Length is what separates the two cases,
 * because a short name has far more neighbours.
 *
 * `test/reserved-typo.test.mjs` re-measures exactly this against the
 * real corpus, so a reserved switch added later that sits too close to
 * a real field name turns that probe red instead of silently eating
 * somebody's field.
 */
export function nearMissThreshold(name) { return name.length >= 6 ? 2 : 1; }

/** The reserved name `k` narrowly misses — or null when it misses none. */
export function nearReserved(k) {
  for (const r of RESERVED_SWITCHES) {
    const d = editDistance(k, r);
    if (d > 0 && d <= nearMissThreshold(r)) return r;
  }
  return null;
}

/** What to tell somebody who typed `k` when they meant `r`. */
export function typoMessage(command, k, r) {
  return [
    `${command}: '--${k}' looks like a typo for '--${r}'.`,
    `'--${r}' is reserved and never becomes a field; '--${k}' WOULD become`,
    'one, and the entry would be filed in the wrong place. So: stop here.',
    `Meant '--${r}'? Then write that. Really want a field called '${k}'?`,
    'Then its name sits too close to a reserved one — pick another.',
  ].join('\n');
}
