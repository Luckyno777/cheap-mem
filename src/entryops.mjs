// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Entry operations — restore and merge, as APPEND-ONLY operations
 * (Bauplan P3; lucky-mem's `eintragsvorgaenge.mjs`, D2).
 *
 * The abort criterion of the sibling's plan holds here too: "the draft
 * deletes and overwrites". Both operations therefore write ONLY new
 * lines, and only through the two writers this house already has —
 * `memory.logEntry` (a plain new line), `memory.correctionEntry`
 * (`replaces_id`, full content, the original stays) and
 * `memory.retireEntry` (a tombstone). No function here opens a log file
 * for writing. `test/entryops.test.mjs` pins that on the bytes: every
 * drawer is a byte-prefix of its earlier self after each action.
 *
 * **Restore is NOT a `replaces_id` correction.** A correction hangs on
 * the chain of the original; a duty chain that had one closed stage
 * would stay closed for ever. The restore is a fresh, standalone line
 * with the copied content and `restored_from: <old id>`. The original
 * and its tombstone stay untouched: "was closed, was taken up again"
 * stays readable.
 *
 * **Merge** is a correction of the FIRST entry (`replaces_id`, same
 * content guard) carrying `merged_from: [all ids]`; every further entry
 * gets an `obsolete` tombstone "merged into <new id>". Same drawer only.
 * Everything is checked up front so no half merge arises that could
 * have been avoided.
 *
 * Git-backed note: nothing here needs a lock or a transaction — the
 * merge driver of the repository unions appended lines, and a restore
 * or merge is only appended lines.
 */
import * as memory from './memory.mjs';

const COPY_SKIP = new Set([
  ...memory.MACHINE_FIELDS, 'restored_from', 'restored_why', 'merged_from', 'merged_why',
]);

function fail(code, text, extra = {}) {
  const e = new Error(text);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/** The content of an entry without machine / closing / chain fields. */
export function contentCopy(e) {
  const out = {};
  for (const [k, v] of Object.entries(e ?? {})) {
    if (k.startsWith('_') || COPY_SKIP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function locate(root, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(id)) {
    throw fail('INVALID_ID', `'${id}' is not a valid entry id.`);
  }
  const loc = memory.findEntryLocation(root, id);
  if (!loc) throw fail('NOT_FOUND', `id '${id}' not found in any drawer.`);
  return loc;
}

function drawer(root, loc) {
  const entries = [...memory.iterLog(root, loc.type, { project: loc.project })];
  return { entries, retired: memory.retiredMap(entries) };
}

function bodyOf(e) {
  for (const k of ['text', 'why', 'title']) if (typeof e[k] === 'string' && e[k].trim()) return e[k].trim();
  const any = Object.entries(e).find(([k, v]) => !k.startsWith('_') && !memory.MACHINE_FIELDS.has(k)
    && typeof v === 'string' && v.trim());
  return any ? any[1].trim() : '';
}

const targetIn = (entries, id) => entries.find((e) => e.id === id && !memory.isClosingLine(e)) ?? null;

/**
 * Restore a closed entry: a NEW content line, `restored_from: <id>`.
 * Refuses what is not closed, what is superseded by a correction (take
 * the newer version), what is already restored and still holds, and an
 * entry with no content of its own.
 */
export function restore(root, id, { why = null } = {}) {
  const loc = locate(root, id);
  const { entries, retired } = drawer(root, loc);
  const old = targetIn(entries, id);
  const r = retired.get(id);
  if (!r) throw fail('STILL_HOLDS', `'${id}' is not closed — there is nothing to restore.`);
  if (r.state === 'superseded') {
    throw fail('SUPERSEDED', `'${id}' is not closed but superseded by '${r.by}' — restore or edit the newer version.`, { by: r.by });
  }
  if (r.state === 'disputed') {
    throw fail('DISPUTED', `'${id}' is a disputed attempt, not a closed entry.`);
  }
  const earlier = entries.find((e) => e.restored_from === id && memory.holds(e, retired));
  if (earlier) {
    throw fail('ALREADY_RESTORED', `'${id}' is already restored as '${earlier.id}'.`, { by: earlier.id });
  }
  const content = contentCopy(old);
  if (!memory.hasContent(content)) {
    throw fail('NO_CONTENT', `'${id}' carries no content of its own — a restore would be empty.`);
  }
  const data = { ...content, restored_from: id };
  if (why) data.restored_why = String(why);
  const line = memory.logEntry(root, loc.type, data, { project: loc.project });
  return { action: 'restore', id, type: loc.type, project: loc.project, created: line.entry.id, was: r.state };
}

/**
 * Merge two or more entries of ONE drawer into a correction of the
 * first; the others get an `obsolete` tombstone.
 */
export function merge(root, ids, { title = null, text = null, why = null } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : String(ids ?? '').split(','))
    .map((s) => String(s).trim()).filter(Boolean))];
  if (list.length < 2) throw fail('TOO_FEW', 'Merge needs at least two different ids.');
  if (list.length > 20) throw fail('TOO_MANY', 'At most 20 entries at once.');
  const locs = list.map((id) => ({ id, ...locate(root, id) }));
  const { type, project } = locs[0];
  const foreign = locs.find((l) => l.type !== type || (l.project ?? null) !== (project ?? null));
  if (foreign) {
    throw fail('DIFFERENT_DRAWERS',
      `'${foreign.id}' lives in ${foreign.type}/${foreign.project ?? 'global'}, '${list[0]}' in ${type}/${project ?? 'global'}. Merging works inside one drawer only.`);
  }
  const { entries, retired } = drawer(root, locs[0]);
  const targets = list.map((id) => {
    const r = retired.get(id);
    if (r) throw fail('NOT_HOLDING', `'${id}' no longer holds (${r.state}${r.by ? ` by ${r.by}` : ''}).`, { by: r.by ?? null });
    return targetIn(entries, id);
  });
  const merged = { ...contentCopy(targets[0]) };
  merged.title = title?.trim() || merged.title || list[0];
  merged.text = text?.trim() || targets.map((e) => {
    return `[${e.id}] ${bodyOf(e)}`;
  }).join('\n\n');
  merged.merged_from = list;
  if (why) merged.merged_why = String(why);
  const corr = memory.correctionEntry(root, type, list[0], merged, { project });
  const created = corr.entry.id;
  const tombstones = [];
  for (const id of list.slice(1)) {
    const t = memory.retireEntry(root, type, id, { state: 'obsolete', why: `merged into ${created}`, project });
    tombstones.push(t.entry.id);
  }
  return { action: 'merge', ids: list, type, project, created, tombstones };
}
