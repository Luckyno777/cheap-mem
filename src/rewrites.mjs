// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * rewrites — the learned rewrite table (question word -> entry word),
 * READ SIDE. No model, deterministic. Port of lucky-mem's
 * "Umschreibungstabelle" (`src/umschreibtabelle.mjs` there).
 *
 * **The gap it closes.** A person asks in their everyday words ("took
 * money twice"), the entry was written in the trade's words ("billed",
 * "charge"). The curated thesaurus (src/thesaurus.mjs) only knows
 * what someone wrote into it by hand; `mem asked-learn` (M18b) teaches
 * ONE entry the words it was asked with. This table generalises the
 * same evidence one step: from "word `a` was asked, and the entry that
 * was then fetched is characterised by `b`" it keeps the pair `a -> b`,
 * so the next question with `a` also reaches OTHER entries about `b`.
 *
 * **What it adds over a hand list.** Every pair names its evidence
 * (sessions, journal lines), is active only from
 * {@link MIN_SESSIONS} independent sessions on, rests after
 * {@link DECAY_DAYS} without new evidence, can be locked one by one
 * (`mem rewrites lock a b`), and the whole table switches off with
 * `MEM_REWRITES=off`. Shipped EMPTY: there is no generic base table.
 * One measured on the gold set would be fitted to the gold set (see
 * docs/value-report.md for what that set asks), and a hand-written
 * synonym list already exists — the thesaurus, with
 * `.mem/thesaurus.json` for a memory's own groups.
 *
 * **Leaf module.** search.mjs imports this file; it imports nothing of
 * the search machinery back. The write side is src/rewritecare.mjs.
 *
 * **Storage.** `.mem/rewrites.jsonl`, append-only. Line kinds:
 *   {kind:'pair',   ts, from, to, sessions:[id..], evidence:[{kind,place,ts,entry?}], last}
 *   {kind:'lock',   ts, from, to, reason}   — pair out of service
 *   {kind:'unlock', ts, from, to}           — lock lifted
 * Per pair the NEWEST `pair` line counts (it carries the union of all
 * evidence so far), and the latest lock/unlock line.
 *
 * **No self-reinforcement.** Evidence only comes from cases the write
 * side already vets (the memory did NOT show the fetched entry itself).
 * The table produces no evidence of its own: a pair that works causes
 * no more misses and therefore decays without new evidence — intended,
 * the long window keeps that cycle rare.
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendLine } from './append.mjs';

export const FILE = path.join('.mem', 'rewrites.jsonl');

/** The kill switch's environment variable. */
export const ENV = 'MEM_REWRITES';

/**
 * A pair counts from this many INDEPENDENT sessions on. A word one
 * person used once is a whim, not usage. Two is the smallest number
 * that says "not just once" — the same number lucky-mem takes.
 */
export const MIN_SESSIONS = 2;

/**
 * A pair without new evidence for this many days rests. A quarter:
 * long enough that a rarely asked subject does not lapse between two
 * questions, short enough that a word nobody says any more does not
 * shape search for ever.
 */
export const DECAY_DAYS = 90;

/**
 * Weight of a table term in the query: below the typed word (1.0), the
 * language bridge (0.8) and the curated thesaurus (0.6) — the table is
 * learned from few cases, not curated. lucky-mem measured 0.3 (rank 2)
 * against 0.5/0.7/1.0 (rank 1, a plateau) with decoys unchanged at
 * every step; 0.5 is the lowest value of the plateau.
 */
export const WEIGHT = 0.5;

/** At most this many entry words per question word — against bloat. */
export const TARGETS_MAX = 4;

export const STATE = Object.freeze({
  ACTIVE: 'active', WAITING: 'waiting', DECAYED: 'decayed', LOCKED: 'locked',
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** The kill switch. Default ON: without evidence (no file) the table does nothing. */
export function on(env = process.env) {
  const v = String(env?.[ENV] ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'no' || v === 'false');
}

const fileOf = (root) => path.join(root, FILE);

const CACHE = new Map(); // root -> { mtimeMs, size, folded }

/** Every line of the file. A broken line is skipped, never guessed. */
function readLines(root) {
  let text = '';
  try { text = fs.readFileSync(fileOf(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object') out.push(o); } catch { /* broken: skipped */ }
  }
  return out;
}

const keyOf = (from, to) => `${from}\u0000${to}`;

/** Lines -> Map `from\0to` -> `{ from, to, sessions, evidence, last, locked, lockReason }`. */
export function fold(lines) {
  const map = new Map();
  const take = (from, to) => {
    const k = keyOf(from, to);
    if (!map.has(k)) map.set(k, { from, to, sessions: [], evidence: [], last: null, locked: false, lockReason: null });
    return map.get(k);
  };
  for (const z of lines) {
    if (typeof z.from !== 'string' || typeof z.to !== 'string' || !z.from || !z.to) continue;
    if (z.kind === 'pair') {
      const e = take(z.from, z.to);
      e.sessions = [...new Set((z.sessions ?? []).filter((x) => typeof x === 'string'))].sort();
      e.evidence = Array.isArray(z.evidence) ? z.evidence : [];
      e.last = typeof z.last === 'string' ? z.last : e.last;
    } else if (z.kind === 'lock') {
      const e = take(z.from, z.to);
      e.locked = true;
      e.lockReason = typeof z.reason === 'string' ? z.reason : null;
    } else if (z.kind === 'unlock') {
      const e = take(z.from, z.to);
      e.locked = false;
      e.lockReason = null;
    }
  }
  return map;
}

/** The state of one folded pair at a point in time. */
export function stateOf(e, { now = Date.now() } = {}) {
  if (e.locked) return STATE.LOCKED;
  if (e.sessions.length < MIN_SESSIONS) return STATE.WAITING;
  const t = Date.parse(e.last ?? '');
  if (!Number.isFinite(t) || now - t > DECAY_DAYS * DAY_MS) return STATE.DECAYED;
  return STATE.ACTIVE;
}

/** The folded table of a root, stat-cached (mtime + size). */
export function folded(root) {
  if (!root) return new Map();
  let st;
  try { st = fs.statSync(fileOf(root)); } catch { CACHE.delete(root); return new Map(); }
  const c = CACHE.get(root);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.folded;
  const f = fold(readLines(root));
  CACHE.set(root, { mtimeMs: st.mtimeMs, size: st.size, folded: f });
  return f;
}

/** Every pair with its state — for `mem rewrites`. */
function all(root, { now = Date.now() } = {}) {
  return [...folded(root).values()]
    .map((e) => ({ ...e, state: stateOf(e, { now }) }))
    .sort((x, y) => y.sessions.length - x.sessions.length || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

/**
 * What search reads: Map question stem -> [{ to, weight }], ACTIVE pairs
 * only, at most {@link TARGETS_MAX} per question word (best evidenced
 * first). Empty when switched off, without a file, or nothing active.
 */
export function active(root, { now = Date.now(), env = process.env } = {}) {
  const out = new Map();
  if (!root || !on(env)) return out;
  const f = folded(root);
  if (!f.size) return out;
  const list = [];
  for (const e of f.values()) if (stateOf(e, { now }) === STATE.ACTIVE) list.push(e);
  list.sort((x, y) => y.sessions.length - x.sessions.length || x.to.localeCompare(y.to));
  for (const e of list) {
    if (!out.has(e.from)) out.set(e.from, []);
    const l = out.get(e.from);
    if (l.length < TARGETS_MAX) l.push({ to: e.to, weight: WEIGHT });
  }
  return out;
}

/** Append one line (append-only). */
export function append(root, line) {
  const p = fileOf(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  appendLine(p, `${JSON.stringify(line)}\n`);
  CACHE.delete(root);
}

/** Lock a pair — a new line, never a rewrite. */
export function lock(root, from, to, reason, { now = new Date() } = {}) {
  if (!folded(root).has(keyOf(from, to))) return { written: false, reason: 'unknown-pair' };
  append(root, { kind: 'lock', ts: now.toISOString(), from, to, reason: String(reason ?? '').slice(0, 200) });
  return { written: true };
}

/** Lift a lock — a new line, never a rewrite. */
export function unlock(root, from, to, { now = new Date() } = {}) {
  if (!folded(root).has(keyOf(from, to))) return { written: false, reason: 'unknown-pair' };
  append(root, { kind: 'unlock', ts: now.toISOString(), from, to });
  return { written: true };
}

/** Human text for `mem rewrites`. */
export function asText(root, { now = Date.now(), env = process.env } = {}) {
  const list = all(root, { now });
  const n = { active: 0, waiting: 0, decayed: 0, locked: 0 };
  for (const e of list) n[e.state] += 1;
  const lines = [
    `REWRITE TABLE: ${list.length} pair(s) — ${n.active} active, ${n.waiting} waiting for evidence `
      + `(< ${MIN_SESSIONS} sessions), ${n.decayed} decayed (> ${DECAY_DAYS} days), ${n.locked} locked. `
      + `Switch ${ENV}: ${on(env) ? 'on' : 'OFF'}.`,
  ];
  for (const e of list) {
    lines.push(`  ${e.state.padEnd(8)} ${e.from} -> ${e.to}  ${e.sessions.length} session(s), `
      + `last evidence ${e.last ?? '?'}${e.lockReason ? `, locked: ${e.lockReason}` : ''}`
      + `${e.evidence.length ? `  [${e.evidence.slice(0, 3).map((b) => b.entry ?? b.place).join('; ')}]` : ''}`);
  }
  if (!list.length) lines.push('  (empty — a statement about the evidence, not about the machinery: `mem rewrites care` collects it)');
  return lines.join('\n');
}

/** Tests only: drop the stat cache. */
export function _clearCache() { CACHE.clear(); }
