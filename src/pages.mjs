/**
 * pages.mjs — E1.3: filter lists server-side, page them by cursor.
 *
 * **Why a module of its own instead of another branch in dashboard.mjs.**
 * `dashboard.collect()` ALWAYS builds every one of its views from the
 * FULL corpus (every drawer, every project) — exactly the violation D1
 * already fixed for a single lookup (see `dashboard.getEntryFast()` and
 * `docs/dashboard-single-entry.md`, "D1"). This file is the sequel for
 * LISTS: a page of `n` entries should cost work that grows with `n` and
 * the number of drawers touched — never with the size of the corpus
 * itself.
 *
 * **The path this function takes.**
 *   - The type/project filters decide WHICH drawers are opened at all
 *     ("over the drawers", never a corpus pass afterward).
 *   - Without a text query: `memory.iterLog()` (already streaming,
 *     constant memory per line — see that function's own header) over
 *     exactly those drawers.
 *   - With a text query (`q`): the EXISTING search path
 *     (`search.loadIndex()` / `search.search()`) — not a second,
 *     hand-rolled text search. The candidates then come straight out of
 *     the search index, without opening the drawers a second time.
 *   - Both paths feed the SAME narrow top-N selection (`consider()`
 *     below): at most `n` entries are ever held at once during the
 *     pass, never the whole hit set or the whole drawer.
 *
 * **Why this does not repeat `test/paging.test.mjs`'s finding.** That
 * file built and then removed a cursor over RANKED search results, for
 * a documented reason: the selection that produces a ranked top-k (the
 * author-share cap, the context budget, MMR) works on the SELECTION,
 * not on the corpus, so a snapshot-bound cursor could not tell "the
 * corpus changed" apart from "the question about it changed" — two
 * pages of the SAME corpus came back with one entry duplicated. This
 * function never does that: without `q` there is no selection to drift
 * (plain drawer order, sorted once, by us); with `q` the search call
 * below asks for `minScore: 0, mmr: false` and a `top` at least as large
 * as the whole index, i.e. the UNRANKED, COMPLETE candidate set — the
 * relevance ORDER `search()` computes is discarded, only its candidate
 * LIST survives, and it is `pages.mjs`'s own stable (ts, id) order that
 * is then applied, exactly as it is without `q`. There is one selection
 * rule, not two that can disagree.
 *
 * **The contract (E1.3):**
 *
 * ```
 * page               { state:'ok',      entries, next, asOf }        -> 200
 * partial            { state:'warning', entries, next, asOf, reason } -> 200
 * unknown filter     { state:'unknown', entries:[], next:null,
 *                       asOf:null, reason }                          -> 400
 * unreadable         { state:'error',   entries:[], next:null,
 *                       asOf:null, reason }                          -> 500
 * ```
 *
 * - `state:'unknown'` means the FILTER itself names something that does
 *   not exist (a type outside `memory.TYPES`, a project outside
 *   `memory.listProjects()`/`'global'`) — no corpus pass, no guessing.
 *   That is NOT the same as zero hits: a valid filter with no matches is
 *   `state:'ok'` with `entries:[]`.
 * - `state:'error'` means the cursor could not be read, or the search
 *   index for `q` could not be built — either way the answer cannot be
 *   trusted. A broken cursor NEVER silently answers page 1 (that would
 *   be a wrong page nobody could tell apart from a right one).
 * - `state:'warning'` carries two independent reasons that do not
 *   exclude each other and sit together in `reason`: (a) at least one
 *   source line could not be read while building this page (the gap is
 *   passed through, never swallowed), (b) the corpus mark carried in the
 *   given cursor no longer matches the current one ("corpus changed",
 *   see below). Either way a page still comes back — never a silent
 *   nothing, and never a page that claims completeness it does not have.
 *
 * **Stable order.** `ts` descending, `id` ascending on a tie. `id` is
 * unique and immutable per entry (`memory.ID_LENGTH`) — the only field
 * that gives an exact, repeatable order when two entries share a
 * timestamp exactly, which is not rare in practice (several lines
 * written within the same second).
 *
 * **The cursor.** Encodes `(ts, id)` of the LAST entry shown on this
 * page, plus a `stamp` — a fingerprint over exactly the drawers this
 * filter touches (path + size + mtime of each file, plus the filter's
 * own type/project/query context) so a filter swapped between two calls
 * is caught too. Modelled on `search.corpusStamp()`'s own reasoning
 * (stat, not content — an append-only log only ever grows) but scoped to
 * the touched drawers plus the filter, rather than the whole corpus:
 * `corpusStamp()` alone cannot tell "the corpus changed" apart from "the
 * caller is asking a different question now", and losing that
 * distinction is the exact class `test/paging.test.mjs` warns about
 * above. If the stamp on the next call disagrees, the answer is
 * `state:'warning'`/"corpus changed" rather than silently turning the
 * page. A pure append between two pages does move the stamp (size and
 * mtime grow) but can only ever surface NEWER entries ahead of the
 * cursor, never move the ones already shown — so the warning here is an
 * honest caution, not proof of a real inconsistency in that one case,
 * and it still fires because this module has no cheap way to tell the
 * two apart without paying for the very read it exists to avoid.
 *
 * **What a page deliberately does not do.** It does not compute graph
 * edges (`net.linksOf()`) per entry — that would be a `link`-drawer scan
 * PER ROW of a page, and it would blow the file-open ceiling immediately
 * (probe (e) below). A caller that needs the edges of one entry calls
 * `/entry.json` (`dashboard.getEntryFast()`) for that one id. A page
 * deliberately hands back only the narrow card fields: `id`, `ts`,
 * `type`, `typeLabel`, `project`, `headline`, `agent`, `basis`, `tags`,
 * `source` (the drawer path, no line number).
 *
 * **The known gap (mirrors lucky-mem's own note for the `q` path).**
 * `buildIndex()` (`src/search.mjs`) drops a document from the index
 * entirely when `fieldsOfEntry()` gives it zero weighted terms — see
 * that function's `addDoc`, `if (doc.weights.size === 0) return;`. An
 * entry with none of the weighted fields (`title`, `topic`, `tags`,
 * `text`, ... — the full list is `FIELD_WEIGHTS` in `search.mjs`) is
 * therefore never a candidate for `search()`, no matter the query — so a
 * page filtered by `q` can miss such an entry even though the very same
 * entry shows up fine on a page with no `q` (which reads the drawers
 * directly and does not care whether an entry has weighted text at all).
 * `withRetired: true` is passed on every `q` call, so a retired entry
 * itself is not the gap here the way it was in lucky-mem's mirror — this
 * is the same CLASS of gap (the search path can only ever see what its
 * own index build chose to index), reached by a different cause. Not
 * covered by a probe here, for the same reason lucky-mem left theirs
 * unprobed: recorded so it is not mistaken for "already checked".
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as memory from './memory.mjs';
import * as viewer from './viewer.mjs';
import * as basis from './basis.mjs';
import * as search from './search.mjs';

/** Page size when `n` is not given. */
export const PAGE_SIZE_DEFAULT = 50;

/** A caller may never ask for more than this per page — the ceiling
 * that keeps the top-N selection's memory and time advantage from being
 * undone by the request itself. */
export const PAGE_SIZE_MAX = 200;

/** Cursor encoding version. Bumping it makes an old cursor `state:
 * 'error'` rather than misread. */
const CURSOR_VERSION = 1;

/** `(ts, id, stamp)` -> an opaque, URL-safe cursor string. */
export function encodeCursor({ ts, id, stamp }) {
  const raw = JSON.stringify({ v: CURSOR_VERSION, ts, id, stamp });
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Cursor string -> `{ ts, id, stamp }`, or `null` for ANY deviation from
 * the expected shape. `null` is the caller's signal to answer
 * `state:'error'` at once — never fall back to page 1.
 */
export function decodeCursor(text) {
  if (typeof text !== 'string' || !text) return null;
  let raw;
  try { raw = Buffer.from(text, 'base64url').toString('utf8'); }
  catch { return null; }
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  if (d.v !== CURSOR_VERSION) return null;
  if (typeof d.ts !== 'string' || !d.ts) return null;
  if (typeof d.id !== 'string' || !d.id) return null;
  if (typeof d.stamp !== 'string' || !d.stamp) return null;
  return { ts: d.ts, id: d.id, stamp: d.stamp };
}

/**
 * The total order: `true` when `a` sits at or before `b`'s position
 * (`ts` descending, `id` ascending on a tie).
 */
function isBefore(a, b) {
  if (a.ts !== b.ts) return a.ts > b.ts;
  return a.id <= b.id;
}

/**
 * `true` when `candidate` sits STRICTLY after `cursor` in the total
 * order — i.e. belongs on a later page. With no cursor (first page)
 * every candidate qualifies.
 */
function afterCursor(candidate, cursor) {
  if (!cursor) return true;
  if (candidate.ts !== cursor.ts) return candidate.ts < cursor.ts;
  return candidate.id > cursor.id;
}

/**
 * A fingerprint over exactly the drawers `types`x`projects` touches,
 * plus the filter context itself, so a filter swap between two pages
 * also reads as "corpus changed" rather than a coincidentally matching
 * cursor. `fs.statSync` only — never a file open, which would count
 * against the ceiling probe (e) below.
 */
function corpusMark(root, types, projects, context) {
  const lines = [];
  let newestMtime = 0;
  for (const type of types) {
    for (const project of projects) {
      let file;
      try { file = memory.logPath(root, type, project); } catch { continue; }
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      lines.push(`${memory.asSource(root, file)}:${st.size}:${st.mtimeMs}`);
      if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
    }
  }
  lines.sort();
  const payload = JSON.stringify({ files: lines, context });
  const stamp = createHash('sha1').update(payload).digest('hex').slice(0, 16);
  return { stamp, asOf: newestMtime ? new Date(newestMtime).toISOString() : null };
}

/** The narrow card fields for ONE row of a page. */
function card(candidate) {
  const e = candidate.entry;
  return {
    id: e.id,
    ts: e.ts,
    type: candidate.type,
    typeLabel: viewer.TYPE_LABEL[candidate.type] || candidate.type,
    project: candidate.project || 'global',
    headline: viewer.headline(e),
    agent: e.agent || null,
    basis: basis.markOf(e),
    tags: Array.isArray(e.tags) ? e.tags : [],
    source: candidate.source,
  };
}

/**
 * A page of entries — the contract lives in this module's header.
 *
 * @param root    memory root.
 * @param type    only this type (a key of `memory.TYPES`) — or
 *                `null`/omitted for every type.
 * @param project `'global'` for the root drawer only, a project name
 *                for exactly that project, `null`/omitted for every
 *                project (global plus each real one).
 * @param q       text query — empty/omitted means no text filter.
 *                Non-empty runs over the existing search path
 *                (`search.mjs`).
 * @param after   a cursor from a previous page, or `null`/omitted for
 *                the first page.
 * @param n       page size, capped at `PAGE_SIZE_MAX`.
 */
export function page(root, {
  type = null, project = null, q = '', after = null, n = PAGE_SIZE_DEFAULT,
} = {}) {
  const size = Math.max(1, Math.min(PAGE_SIZE_MAX, Math.trunc(Number(n)) || PAGE_SIZE_DEFAULT));

  // --- (1) cursor first: broken means `error`, never page 1. ---------
  let cursor = null;
  if (after !== null && after !== undefined && after !== '') {
    cursor = decodeCursor(after);
    if (!cursor) {
      return {
        state: 'error', entries: [], next: null, asOf: null,
        reason: 'The cursor ("after") is not readable or is corrupted — a page could '
          + 'not be built on it reliably.',
      };
    }
  }

  // --- (2) filters checked BEFORE any file is touched. ----------------
  const typeFilter = type ? String(type) : null;
  if (typeFilter && !Object.hasOwn(memory.TYPES, typeFilter)) {
    return {
      state: 'unknown', entries: [], next: null, asOf: null,
      reason: `unknown type '${typeFilter}' — known: ${Object.keys(memory.TYPES).join(', ')}`,
    };
  }
  const projectRaw = project ? String(project) : null;
  if (projectRaw && projectRaw !== 'global' && !memory.listProjects(root).includes(projectRaw)) {
    return {
      state: 'unknown', entries: [], next: null, asOf: null,
      reason: `unknown project '${projectRaw}'`,
    };
  }

  const types = typeFilter ? [typeFilter] : Object.keys(memory.TYPES);
  const projects = projectRaw === null ? [null, ...memory.listProjects(root)]
    : projectRaw === 'global' ? [null] : [projectRaw];

  const qTrim = String(q ?? '').trim();

  // --- (3) corpus mark: stat only, never counted as a file open. ------
  const { stamp, asOf } = corpusMark(root, types, projects, { typeFilter, projectRaw, qTrim });
  const corpusChanged = Boolean(cursor && cursor.stamp !== stamp);

  // --- (4) top-N selection over ONE pass. ------------------------------
  // `top` holds at most `size` candidates, kept in the total order —
  // never the whole hit/drawer set.
  const top = [];
  let seen = 0;
  const consider = (candidate) => {
    if (!candidate.ts || !candidate.id) return;
    if (!afterCursor(candidate, cursor)) return;
    seen += 1;
    let i = 0;
    while (i < top.length && isBefore(top[i], candidate)) i += 1;
    if (i >= size) return; // already worse than the worst kept slot
    top.splice(i, 0, candidate);
    if (top.length > size) top.length = size;
  };

  const brokenDrawers = new Set();

  if (qTrim) {
    // --- Text query: the EXISTING search path, not a second search. --
    let index;
    try { index = search.loadIndex(root); }
    catch (e) {
      return {
        state: 'error', entries: [], next: null, asOf: null,
        reason: `Search index could not be built: ${e?.message || e}`,
      };
    }
    let hits;
    try {
      hits = search.search(index, qTrim, {
        // `top`: large enough to never cut off a valid match before OUR
        // OWN sort runs — `search()`'s relevance order is discarded
        // here, only the candidate LIST survives (see this module's
        // header for why that matters).
        top: Math.max(1, index.N ?? index.documents.length),
        type: typeFilter,
        project: projectRaw === null ? undefined : projectRaw,
        minScore: 0,
        withRetired: true,
        mmr: false,
      });
    } catch (e) {
      return {
        state: 'error', entries: [], next: null, asOf: null,
        reason: `Search failed: ${e?.message || e}`,
      };
    }
    for (const h of hits) {
      const e = h.entry;
      // Raw captures (`h.type === 'raw'`) are not a `memory.TYPES` drawer
      // and carry no `typeLabel` — left out of a page on purpose, same
      // as the no-`q` path never reads `raw/` at all.
      if (!e || h.type === 'raw') continue;
      consider({ ts: e.ts, id: e.id, type: h.type, project: h.project, entry: e, source: h.source });
    }
  } else {
    // --- No text query: plain streaming over the drawers. -------------
    for (const t of types) {
      for (const p of projects) {
        const file = memory.logPath(root, t, p);
        const source = memory.asSource(root, file);
        let it;
        try { it = memory.iterLog(root, t, { project: p }); } catch { continue; }
        for (const e of it) {
          if (e && e.__broken) { brokenDrawers.add(source); continue; }
          if (!e || memory.isClosingLine(e)) continue;
          consider({ ts: e.ts, id: e.id, type: t, project: p, entry: e, source });
        }
      }
    }
  }

  const entries = top.map(card);
  const next = seen > top.length
    ? encodeCursor({ ts: top[top.length - 1].ts, id: top[top.length - 1].id, stamp })
    : null;

  const reasons = [];
  if (corpusChanged) {
    reasons.push('Corpus changed: the corpus (or the filter) changed since the previous '
      + 'page — this page is marked honestly rather than silently continuing on a stale '
      + 'or mismatched snapshot.');
  }
  if (brokenDrawers.size) {
    reasons.push(`${brokenDrawers.size} drawer(s) had at least one unreadable line `
      + `(${[...brokenDrawers].join(', ')}) — the list may be incomplete because of it.`);
  }

  return {
    state: reasons.length ? 'warning' : 'ok',
    entries,
    next,
    asOf,
    ...(reasons.length ? { reason: reasons.join(' ') } : {}),
  };
}
