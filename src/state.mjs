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

/**
 * P11 · `deriveState` used to read every log file, `JSON.parse` every
 * line and push the result into ONE array (`all`) before handing it to
 * `memory.retiredMap` — measured at 2026-09-20 ago as ~6.4 GB at
 * 5,000,000 entries (bauplan figure, 1.33 KB/entry). The array was the
 * cost: this function's actual OUTPUT is a small map of retirement
 * records, not a copy of the memory.
 *
 * `memory.retiredMapFromFiles` computes the exact same map — same
 * algorithm, same `applyRetirement` step, see its own comment in
 * `memory.mjs` — from the SAME files, without ever holding "every
 * entry" in one array. The rule this module exists to make structural
 * (see the header above) does not move: it is still given every log
 * file, still decides retirement from the whole log, never a subset.
 * What changes is only how many entries are resident in memory AT ONCE
 * while it does that.
 *
 * `deriveStateMaterialized` below is the OLD implementation, kept only
 * as the equivalence oracle `test/p11-equivalence.test.mjs` checks this
 * function against — not because any caller should still use it.
 */
export function deriveState(root) {
  const files = integrity.logFiles(root).map((f) => f.abs);
  // The authorisation rule lives in exactly one place and is given the
  // WHOLE log, which is the property the first status bug violated.
  return memory.retiredMapFromFiles(files);
}

/**
 * The pre-P11 implementation, byte-for-byte. Exists ONLY so
 * `test/p11-equivalence.test.mjs` has an independent oracle to check
 * `deriveState` against — never call this from production code; it is
 * exactly the "reads the whole memory into one array" cost `deriveState`
 * was rewritten to avoid.
 */
export function deriveStateMaterialized(root) {
  const all = [];
  for (const f of integrity.logFiles(root)) {
    let raw;
    try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { all.push(JSON.parse(line)); } catch { /* integrity reports these */ }
    }
  }
  return memory.retiredMap(all);
}

/** The status of one claim. Absent from the map means active. */
export function statusOf(state, id) {
  return state.get(id)?.state ?? 'active';
}
