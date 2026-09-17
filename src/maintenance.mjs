/**
 * maintenance — merging what is provably the same, without editing history.
 *
 * **Where this comes from.** An outside proposal wanted duplicates
 * ranked or hidden by a telemetry score — how often an entry was
 * "used". That breaks the proposal's own invariant (identical data plus
 * identical parameters must produce an identical prompt): a per-machine
 * use-count is not identical across two machines, and a committed one
 * means every READ is a WRITE. Telemetry plays no part here. What
 * survives without it: two entries can be PROVABLY the same by their
 * CONTENT, and merging those is safe regardless of who has read either
 * one or how often.
 *
 * **Merge, not delete.** Append-only holds. "Merged" means: the loser
 * gets a tombstone line (`memory.retireEntry`, state `obsolete`) in the
 * SAME log, naming the survivor and the hash that proved the match.
 * Nothing already written is edited or removed.
 *
 * **One definition of "duplicate", not two.** `src/retrieval.mjs`
 * already collapses claims whose bodies are identical after
 * normalisation (`bodyHash`) — that is exactly what an exact-duplicate
 * check means in this codebase, applied at READ time against flooding.
 * Reusing it here means "duplicate" is one rule, checked at write time
 * (merge) and at read time (collapse), instead of two rules that could
 * drift apart. For a file `source` entry there is a MORE precise hash
 * already on hand: `store.put()` content-addresses the file itself, so
 * two source entries pointing at byte-identical files share that hash
 * even if their (capped, redacted) excerpts happen to differ. Both are
 * existing hashes in this repo; this file invents neither.
 */

import * as memory from './memory.mjs';
import * as authority from './authority.mjs';
import * as retrieval from './retrieval.mjs';
import { TYPE as SOURCE_TYPE } from './source.mjs';

/**
 * An entry's text, in the same fixed field order the indexer and
 * retrieval already read content from (`retrieval.KOERPER_FELDER`).
 * Not re-implemented independently: a second field list here is exactly
 * the defect `KOERPER_FELDER`'s own comment describes — a field added
 * to one list and not the other silently drops out of whichever list
 * missed it.
 */
function bodyOf(e) {
  const parts = retrieval.KOERPER_FELDER.map((f) => e?.[f]).filter(
    (x) => typeof x === 'string' && x.trim());
  return parts.join(' — ');
}

/**
 * The content hash for one entry, or null if it has no content to
 * compare (a pure tombstone never reaches here — callers filter with
 * `memory.holds` first — but an entry of a type with no KOERPER field
 * at all, e.g. a bare `link`, legitimately can).
 */
export function contentHashOf(type, entry) {
  if (type === SOURCE_TYPE && entry?.kind === 'file'
    && typeof entry.hash === 'string' && entry.hash) {
    return entry.hash;
  }
  const body = bodyOf(entry);
  return body ? retrieval.bodyHash(body) : null;
}

/**
 * Which entry in a duplicate group stays active.
 *
 * Highest authority tier wins. A tie is the COMMON case here — the
 * ordinary duplicate is the same author logging the same fact twice —
 * so the tie-break is the OLDEST entry (`ts` ascending): it is the one
 * that was actually there first. `id` (string-sorted) is the final,
 * arbitrary but deterministic break for the case both other fields
 * tie too, so the choice never depends on file scan order.
 */
export function pickSurvivor(entries) {
  return [...entries].sort((a, b) => {
    const ra = authority.rank(authority.tierOf(a));
    const rb = authority.rank(authority.tierOf(b));
    if (ra !== rb) return ra - rb;
    const ta = a.ts ?? '';
    const tb = b.ts ?? '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ia = String(a.id ?? '');
    const ib = String(b.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  })[0];
}

/**
 * Group the ACTIVE entries of one type/project by content hash, and
 * keep only groups of two or more — a group of one is not a duplicate.
 *
 * Retired entries are excluded before grouping. That is what makes a
 * second run a no-op: once a loser carries a tombstone, `memory.holds`
 * drops it here, so its group never reaches size 2 again and nothing
 * is retired twice.
 */
export function findGroups(root, type, { project = null } = {}) {
  let entries;
  try { ({ entries } = memory.readLog(root, type, { project })); }
  catch { return new Map(); }
  const retired = memory.retiredMap(entries);
  const groups = new Map();
  for (const e of entries) {
    if (!e.id || !memory.holds(e, retired)) continue;
    const h = contentHashOf(type, e);
    if (!h) continue;
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(e);
  }
  for (const [h, list] of groups) if (list.length < 2) groups.delete(h);
  return groups;
}

/**
 * Merge exact duplicates.
 *
 * `project`:
 *   - `undefined` (default) — every project plus the global log.
 *   - `null` — the global log only.
 *   - a name — that one project only.
 *
 * `dryRun: true` computes the same report without writing anything —
 * the plan, not the merge.
 *
 * Returns one row per RETIRED entry: `{ type, project, hash, survivor,
 * retired }`. An empty array means no exact duplicates were found.
 */
export function dedupe(root, { project = undefined, type = null, dryRun = false } = {}) {
  const types = type ? [type] : Object.keys(memory.TYPES);
  const scopes = project === undefined ? [null, ...memory.listProjects(root)] : [project];
  const report = [];
  for (const p of scopes) {
    for (const t of types) {
      const groups = findGroups(root, t, { project: p });
      for (const [hash, list] of groups) {
        const survivor = pickSurvivor(list);
        for (const loser of list) {
          if (loser.id === survivor.id) continue;
          if (!dryRun) {
            memory.retireEntry(root, t, loser.id, {
              state: 'obsolete',
              why: `duplicate content of ${survivor.id} (hash ${hash.slice(0, 16)}) `
                + '— merged by mem maintenance dedupe',
              project: p,
            });
          }
          report.push({ type: t, project: p, hash, survivor: survivor.id, retired: loser.id });
        }
      }
    }
  }
  return report;
}
