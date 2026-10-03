// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * recallattach — two attachments to lines the recall hooks show (port of
 * lucky-mem's `abrufanhang`, L3 + L4, 2026-10-03).
 *
 * **L3: the solution under its error.** A fix for an error is a `resolves`
 * link (`src/errorfixes.mjs`: a commit trailer `Fixes: <id>`, a closed duty,
 * a learning that names it). It used to show up only when something was
 * WRITTEN (`mem log error` prints a note), never together with the error
 * itself: the recall showed the error line, the way out stayed on the shelf.
 * When an automatic path shows an error for which a solution exists, one
 * short line stands directly below it:
 *
 *     ↳ Solution <id>: <shortened core>
 *
 * At most ONE per error: the newest valid `resolves` link whose source is an
 * entry in force (not superseded, discarded or disputed; `done` and
 * `obsolete` still count: a fix closes) or a commit proof (`commit:<hash>`,
 * the core taken from the link's `why`). A replaced solution never shows;
 * then the next older link counts.
 *
 * **L4: the experience account under a skill offer.** The offer named only
 * the skill (`skillregistry.offer`); its account (`experience.account`, what
 * went wrong in its declared scope and what was learned) never appeared.
 * Now an offer brings the TWO most important account entries, one line each:
 * open or repeated errors first (open AND repeated before only open before
 * only repeated, newest first), then the newest learnings, otherwise
 * nothing. At most {@link ACCOUNT_BYTES_MAX} bytes extra. A skill without a
 * declared scope has no account, and then the store is not even read (the
 * normal case costs nothing).
 *
 * **For both.** Data, not instruction (the header of the showing says so,
 * the lines are plain data). Encrypted entries (`body_enc`) and entries of
 * the category `personal` never; on the subagent path the same type
 * exclusions as `subagenttask.mjs`. The core goes through the output guard
 * before it is cut; the hook answer passes it once more.
 *
 * Switches: `MEM_SOLUTION_ATTACH=0` and `MEM_SKILL_ACCOUNT_OFFER=0` turn one
 * attachment off each (emergency stop and the before state for measuring).
 *
 * Never throws: a failure here is an extra, never a reason to swallow the
 * showing.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as errorfixes from './errorfixes.mjs';
import * as experience from './experience.mjs';
import * as categories from './categories.mjs';
import * as bidi from './bidi.mjs';
import { maskText } from './outputguard.mjs';
import { mainText } from './bodyfields.mjs';

/** The arrow of an attachment (U+21B3). */
export const ARROW = '↳';
/** A solution line has at most this many bytes, indentation included. */
const SOLUTION_LINE_BYTES = 170;
/** A skill offer brings at most this many account lines … */
const ACCOUNT_LINES_MAX = 2;
/** … and at most this many bytes (line breaks included). */
export const ACCOUNT_BYTES_MAX = 400;
/** The types a subagent may be shown (shared with `subagenttask.mjs`). */
export const SUBAGENT_TYPES = Object.freeze(['error', 'learning', 'duty', 'procedure', 'skill']);

/** Retirement states after which an entry is no solution any more (a fix `done`/`obsolete` still is one). */
const GONE = new Set(['superseded', 'discarded', 'disputed']);
const COMMIT_FORM = new RegExp(`^${memory.COMMIT_EVIDENCE_PREFIX}([0-9a-f]{7,40})$`);
const ERROR_LANE = /(?:^|[\\/])errors\.jsonl$/;

const bytes = (s) => Buffer.byteLength(s, 'utf8');

function solutionOn(env = process.env) { return env.MEM_SOLUTION_ATTACH !== '0'; }
function accountOn(env = process.env) { return env.MEM_SKILL_ACCOUNT_OFFER !== '0'; }

/** One line out of text: masked, bidi visible, white space squeezed. */
function clean(text) {
  return bidi.visible(maskText(String(text ?? ''))).replace(/\s+/g, ' ').trim();
}

/** Cut to `max` bytes, on a word boundary where possible, with an ellipsis. */
export function capBytes(text, max) {
  const s = String(text);
  if (bytes(s) <= max) return s;
  let end = s.length;
  while (end > 0 && bytes(`${s.slice(0, end)}…`) > max) end -= 1;
  let part = s.slice(0, end);
  const blank = part.lastIndexOf(' ');
  if (blank > part.length * 0.5) part = part.slice(0, blank);
  return `${part.trimEnd()}…`;
}

function entryCore(e, type) {
  const title = typeof e.title === 'string' && e.title.trim() ? e.title : null;
  const raw = title ?? mainText(e, type);
  return clean(raw).replace(/ \[cut(?: - full text: mem show \S+)?\]$/, '');
}

/** Encrypted, or of the category `personal`: never shown by an attachment. In doubt: yes. */
export function isPrivate(ctx, e) {
  if (!e || typeof e !== 'object' || e.body_enc) return true;
  if (typeof e.topic === 'string' && e.topic) {
    try {
      if (!ctx.assignments) ctx.assignments = categories.readAssignments(ctx.root);
      if (ctx.assignments.get(e.topic)?.category === 'personal') return true;
    } catch { return true; }
  }
  return false;
}

// --- L3 -----------------------------------------------------------------

/**
 * The id of a hit: `mem find` hits carry the entry, `mem component --hook` rows
 * (before an edit) only `source` and `line` - then the entry is read from that
 * line of its drawer. Never leaves the memory root. `null` when it cannot be told.
 */
function hitId(root, h, cache) {
  const direct = h?.entry?.id ?? h?.id;
  if (direct) return direct;
  if (!root || !h?.source || !(Number(h.line) > 0)) return null;
  const key = `${h.source}:${h.line}`;
  if (cache.has(key)) return cache.get(key);
  let id = null;
  try {
    const base = path.resolve(root);
    const abs = path.resolve(base, String(h.source));
    if (abs.startsWith(base + path.sep)) {
      const line = memory.withoutBom(fs.readFileSync(abs, 'utf8')).split('\n')[Number(h.line) - 1];
      const e = JSON.parse(line);
      id = typeof e?.id === 'string' && e.id ? e.id : null;
    }
  } catch { id = null; }
  cache.set(key, id);
  return id;
}

/** The ids of the hits that are ERRORS (source `errors.jsonl`); only they get a solution. */
function errorIdsOf(hits, root = null, cache = new Map()) {
  const out = [];
  for (const h of Array.isArray(hits) ? hits : []) {
    const src = String(h?.source ?? h?._source ?? '');
    if (!ERROR_LANE.test(src)) continue;
    const id = hitId(root, h, cache);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The `resolves` links in force towards the given error ids: error id -> [link], newest first. */
function resolvesLinks(root, ids) {
  const per = new Map();
  let order = 0;
  for (const l of errorfixes.allLinks(root)) {
    order += 1;
    if (l.kind !== 'resolves' || !ids.has(l.to) || l.from === l.to) continue;
    if (!per.has(l.to)) per.set(l.to, []);
    per.get(l.to).push({ ...l, _order: order });
  }
  for (const list of per.values()) list.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')) || b._order - a._order);
  return per;
}

/**
 * The entry with this id unless it is gone (superseded, discarded, disputed): `{ e, type, state }`,
 * `state` being its retirement state (`done`, `obsolete`) or null. Else null. One lookup per id and
 * call (`ctx.entries` remembers).
 */
export function standingEntry(ctx, id) {
  if (!ctx.entries) ctx.entries = new Map();
  if (ctx.entries.has(id)) return ctx.entries.get(id);
  let found = null;
  try {
    const loc = memory.findEntryLocation(ctx.root, id);
    if (loc) {
      const { entries } = memory.readLog(ctx.root, loc.type, { project: loc.project });
      const retired = memory.retiredMap(entries);
      const e = entries.find((x) => x && x.id === id && !memory.isClosingLine(x));
      const state = retired.get(id)?.state ?? null;
      if (e && !GONE.has(state)) found = { e, type: loc.type, state };
    }
  } catch { found = null; }
  ctx.entries.set(id, found);
  return found;
}

/** The core of a commit proof: what follows the quoted trailer in the link's `why`. */
function commitCore(link) {
  const why = clean(link.why ?? '');
  const m = /^Commit [0-9a-f]+ (?:carries|says) "[^"]*":\s*(.*)$/.exec(why);
  return (m ? m[1] : why).trim();
}

function solutionLine(id, core) {
  const head = `  ${ARROW} Solution ${id}: `;
  const room = SOLUTION_LINE_BYTES - bytes(head);
  if (room < 12 || !core) return null;
  return `${head}${capBytes(core, room)}`;
}

/**
 * Solutions for error ids: `Map errorId -> { id, journalId, line, core }`.
 * `id` is the shown solution id (entry id or `commit:<hash>`), `journalId`
 * what belongs into the journal's `ids` (entry id or the bare hash).
 * Errors without a valid solution are absent. Never throws.
 */
export function solutionsFor(root, errorIds, { env = process.env, subagent = false } = {}) {
  const out = new Map();
  try {
    if (!solutionOn(env)) return out;
    const ids = new Set((errorIds ?? []).filter((i) => typeof i === 'string' && i));
    if (!ids.size) return out;
    const links = resolvesLinks(root, ids);
    if (!links.size) return out;
    const ctx = { root, entries: new Map(), assignments: null };
    for (const [errorId, list] of links) {
      for (const l of list) {
        let id = null; let journalId = null; let core = null;
        const commit = COMMIT_FORM.exec(l.from);
        const found = commit ? null : standingEntry(ctx, l.from);
        if (found) {
          if (subagent && !SUBAGENT_TYPES.includes(found.type)) continue;
          if (isPrivate(ctx, found.e)) continue;
          id = found.e.id; journalId = found.e.id; core = entryCore(found.e, found.type);
        } else if (commit) {
          if (isPrivate(ctx, { why: l.why })) continue;
          id = `${memory.COMMIT_EVIDENCE_PREFIX}${commit[1].slice(0, 12)}`; journalId = commit[1].slice(0, 12); core = commitCore(l);
        } else {
          continue; // the source is gone or replaced: the next older link counts
        }
        const line = solutionLine(id, core);
        if (!line) continue;
        out.set(errorId, { id, journalId, line, core });
        break;
      }
    }
  } catch { /* an extra */ }
  return out;
}

/**
 * For the renderers: `attach(hit) -> { line, id } | null`, solutions worked out
 * ONCE for the error hits among `hits`. No error with a solution: `null`
 * (the caller then renders exactly as before).
 */
export function attacher(root, hits, { env = process.env, subagent = false } = {}) {
  const cache = new Map();
  const sol = solutionsFor(root, errorIdsOf(hits, root, cache), { env, subagent });
  if (!sol.size) return null;
  return (hit) => {
    const s = ERROR_LANE.test(String(hit?.source ?? hit?._source ?? '')) ? sol.get(hitId(root, hit, cache)) : null;
    return s ? { line: s.line, id: s.journalId } : null;
  };
}

// --- L4 -----------------------------------------------------------------

/**
 * The account lines of a skill offer: at most {@link ACCOUNT_LINES_MAX}
 * lines, at most {@link ACCOUNT_BYTES_MAX} bytes with line breaks. `items`
 * are the offered registry items (`.name`, `.id`, `.entry`). With several
 * equally strong skills the skill name stands before the kind.
 * `{ lines: string[], ids: string[] }`; without an account empty.
 */
export function accountLines(root, items, { env = process.env, now = new Date() } = {}) {
  const none = { lines: [], ids: [] };
  try {
    if (!accountOn(env) || !Array.isArray(items) || !items.length) return none;
    // Without a declared scope there is no account: then the store is not read at all.
    const scoped = items.filter((i) => !experience.scopeOf(i.entry).empty);
    if (!scoped.length) return none;
    const s = experience.stock(root, { light: true });
    const candidates = [];
    for (const item of scoped) {
      let a;
      try { a = experience.account(item, s, { now }); } catch { continue; }
      if (!a || a.withoutScope) continue;
      const open = new Set(a.openTraps);
      const perClass = new Map();
      for (const t of a.traps) if (t.class) perClass.set(t.class, (perClass.get(t.class) ?? 0) + 1);
      for (const t of a.traps) {
        const isOpen = open.has(t.id);
        const repeated = Boolean(t.class) && (perClass.get(t.class) ?? 0) >= 2;
        if (!isOpen && !repeated) continue;
        candidates.push({ skill: item.name, kind: 'error', id: t.id, rank: (isOpen ? 2 : 0) + (repeated ? 1 : 0),
          ts: String(t.ts ?? ''), mark: isOpen && repeated ? 'open, repeated' : (isOpen ? 'open' : 'repeated') });
      }
      for (const l of a.learnings) {
        const e = s.byId.get(l.learning);
        if (!e) continue; // replaced or discarded learnings never
        candidates.push({ skill: item.name, kind: 'learning', id: l.learning, rank: -1, ts: String(e.ts ?? l.ts ?? ''), mark: null });
      }
    }
    if (!candidates.length) return none;
    // Errors (rank 3 > 2 > 1) before learnings (-1), then newest first, then id for stability.
    candidates.sort((x, y) => (y.rank - x.rank) || y.ts.localeCompare(x.ts) || x.id.localeCompare(y.id));

    const ctx = { root, entries: new Map(), assignments: null };
    const many = scoped.length > 1;
    const lines = []; const ids = []; const seen = new Set();
    let rest = ACCOUNT_BYTES_MAX;
    for (const c of candidates) {
      if (lines.length >= ACCOUNT_LINES_MAX) break;
      if (seen.has(c.id)) continue;
      const e = s.byId.get(c.id) ?? s.errorById.get(c.id);
      if (!e || isPrivate(ctx, e)) continue;
      const core = (c.kind === 'error' && e.class ? `[${clean(e.class)}] ` : '') + entryCore(e, c.kind);
      const kind = c.kind === 'error' ? `Error (${c.mark})` : 'Learning';
      const head = `  ${ARROW} ${many ? `${c.skill}: ` : ''}${kind} ${c.id}: `;
      const room = Math.min(rest - 1, 199) - bytes(head);
      if (room < 16 || !core.trim()) continue;
      const line = `${head}${capBytes(core, room)}`;
      rest -= bytes(line) + 1;
      seen.add(c.id);
      lines.push(line); ids.push(c.id);
    }
    return { lines, ids };
  } catch { return none; }
}
