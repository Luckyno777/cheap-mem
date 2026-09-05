// src/state.mjs — the derived state, and nothing else derives it.
//
// The failure that made this module necessary (2026-09-05, post-closure
// round): status lived in `.mem/search-index.json`. Editing that file —
// gitignored, unsigned, outside the merge driver, outside the epoch
// watermark, invisible to git review — changed what the memory considered
// active, in both directions: a disputed poisoning claim served as active,
// and a genuine user claim suppressed.
//
// A cache had become the source of truth about meaning. Not about speed —
// about meaning.
//
// The rule this module exists to make structural:
//
//   THE LOG DECIDES WHAT IS TRUE.
//   THE INDEX DECIDES ONLY WHAT IS FAST TO FIND.
//
// Two design choices follow, and both are load-bearing:
//
// **It takes a ROOT, never a list of entries.** The first status bug was a
// caller passing a subset — the retrieval hits — so the retirement of a
// claim whose replacement did not match the query was invisible. A
// function that reads the log itself cannot be handed a subset. The bug
// class is removed by the signature, not by remembering.
//
// **It never takes a query.** `state(log)` has no query parameter, so
// relevance cannot reach semantics even by accident.
//
// **It is the obvious implementation, and that was measured, not assumed.**
// The first version was clever: retirement lines are rare, so pick them out
// with a substring test and parse only them and the entries they point at.
// Measured on 2026-09-05:
//
//     entries    clever      obvious
//       1 000      8 ms         2 ms
//      10 000    331 ms        10 ms
//     100 000  37 180 ms       127 ms
//
// The clever path was 300x SLOWER — its second pass tested every line
// against every wanted id, which is quadratic. It was deleted. 127 ms at
// 100 000 entries is the same order as the search it accompanies, and the
// real corpus this was built for is three orders of magnitude smaller.
//
// The general lesson is worth more than the milliseconds: an optimisation
// nobody timed is a complication, and here it would have been a
// complication guarding a security-relevant rule.

import fs from 'node:fs';
import * as memory from './memory.mjs';
import * as integrity from './integrity.mjs';

export function deriveState(root) {
  const all = [];
  for (const f of integrity.logFiles(root)) {
    let raw;
    try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { all.push(JSON.parse(line)); } catch { /* integrity reports these */ }
    }
  }
  // The authorisation rule lives in exactly one place and is given the
  // WHOLE log, which is the property the first status bug violated.
  return memory.retiredMap(all);
}

/** The status of one claim. Absent from the map means active. */
export function statusOf(state, id) {
  return state.get(id)?.state ?? 'active';
}
