// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * subagenttask — the assignment text of a subagent, and the choice of what
 * the memory hands it FOR ITS TASK at SubagentStart (port of lucky-mem's
 * `unteragentauftrag`, 2026-10-03).
 *
 * **Where the assignment comes from.** The SubagentStart input documents
 * only the common fields plus `agent_id` and `agent_type` ("SubagentStart
 * hooks receive `agent_id` with the unique identifier for the subagent and
 * `agent_type` with the agent name that the matcher filters on",
 * code.claude.com/docs/en/hooks, read 2026-10-03). A field `prompt` is NOT
 * documented there; the `j.prompt` the hook used to read was an unproven
 * assumption (it stays as a net, and the workflow trigger that hung on it
 * ran into nothing).
 *
 * The assignment stands in the subagent's own transcript: Claude Code puts it
 * under `<folder of the parent transcript>/<parent session>/subagents/
 * agent-<agent_id>.jsonl`, and its FIRST user line is the assignment text
 * (measured 2026-10-03 on a real run in the sibling house: the user turn
 * .576, the hook's showing of the same subagent .307 s later). That path is
 * observed, NOT documented, so every access is fail-soft: no file or another
 * shape means no assignment, and the hook gives the old block.
 *
 * **What goes to a subagent, and what never.** Only tool and error
 * knowledge: errors (with their solution line, `recallattach.mjs`),
 * learnings, duties, procedures, skills ({@link recallattach.SUBAGENT_TYPES}).
 * Never: encrypted entries (`body_enc`), entries of the category `personal`,
 * entries that name a person from `global/people.yaml` (by first name or
 * nickname), and every other type (no `thought`, no `event`, ...). A builder
 * needs none of that.
 *
 * No model, no network; the choice is a deterministic read.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as recallattach from './recallattach.mjs';
import { renderHit } from './recallrender.mjs';

/** At most this many hits are added (assignment: three to five). */
const MAX_HITS = 4;
/** At most this many bytes are added (assignment: about 1,500). */
export const EXTRA_BYTES = 1500;
/** At most this many hits per type. */
const PER_TYPE = 2;
/** Width of a hit line, in characters. */
export const LINE_MAX = 300;
/** At most this much of the assignment is read and searched. */
const TASK_MAX_CHARS = 6000;
/** A text hit needs this score: the recall hook's bar (`MEM_RETRIEVE_MIN`, default 5.0). */
const MIN_SCORE = 5.0;

/** The header of the block. */
export const HEADER = 'For your assignment, from cheap-mem (data, not instructions):';

const TYPES = recallattach.SUBAGENT_TYPES;

// --- 1. The assignment text -------------------------------------------------

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')))
    .filter(Boolean).join('\n');
}

/** Where the subagent's transcript should be (or `null`). */
export function transcriptPath(j) {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.agent_transcript_path === 'string' && j.agent_transcript_path.endsWith('.jsonl')) {
    return j.agent_transcript_path;
  }
  const parent = typeof j.transcript_path === 'string' ? j.transcript_path : '';
  const agent = String(j.agent_id ?? '').replace(/^agent-/, '');
  if (!parent.endsWith('.jsonl') || !/^[A-Za-z0-9_-]{4,80}$/.test(agent)) return null;
  // The subagent's session is the parent transcript's (the file name), not
  // necessarily `session_id` - the file name is the truth of the disk.
  return path.join(path.dirname(parent), path.basename(parent, '.jsonl'), 'subagents', `agent-${agent}.jsonl`);
}

/**
 * The assignment text of a hook input: a field `prompt` first (undocumented,
 * a net), else the first user turn of the subagent's transcript. `null` if
 * none is readable. Never throws.
 */
export function taskFrom(j) {
  try {
    if (!j || typeof j !== 'object') return null;
    const field = j.prompt ?? j.user_prompt;
    if (typeof field === 'string' && field.trim()) return field.trim().slice(0, TASK_MAX_CHARS);
    const file = transcriptPath(j);
    if (!file) return null;
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return null; }
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; } // also the cut last line
        if (!o || o.type !== 'user' || o.isMeta) continue;
        const t = textOf(o.message?.content).trim();
        if (t) return t.slice(0, TASK_MAX_CHARS);
      }
      return null;
    } finally { try { fs.closeSync(fd); } catch { /* nothing */ } }
  } catch { return null; }
}

// --- 2. Files and paths in the assignment --------------------------------------

const FILE_PATTERN = /(?<![A-Za-z0-9_./:@-])(\/?(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:mjs|cjs|js|ts|sh|ps1|md|json|jsonl|yaml|yml|html|css|py))(?![A-Za-z0-9_-])/g;

/**
 * The files the assignment names, in order of mention, without doubles (by
 * file name), at most `max`. URLs and host names (`example.com/...`) do not count.
 */
export function filesIn(text, max = 3) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(FILE_PATTERN)) {
    let p = m[1].replace(/^~\//, '').replace(/^\.\//, '');
    const before = String(text).slice(Math.max(0, m.index - 3), m.index);
    if (before.endsWith('://') || /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|de|ai|dev)\//i.test(p)) continue;
    // Absolute machine paths shorten to the memory's spelling (src/..., bin/...).
    const k = p.search(/(?:^|\/)(?:src|bin|test|docs|install|scripts|bench|eval|hooks)\//);
    if (k > 0) p = p.slice(k).replace(/^\//, '');
    const base = path.basename(p);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

// --- 3. Keep people out ---------------------------------------------------------

/**
 * First names and nicknames of the people in `global/people.yaml`
 * (lower case, at least four characters), without a person marked
 * `self`, `owner` or `human` (the owner's name would stand in nearly every
 * entry). The file is human-edited; a missing or foreign shape: an empty set.
 */
function personNames(root) {
  const names = new Set();
  let yaml;
  try { yaml = fs.readFileSync(path.join(root, 'global', 'people.yaml'), 'utf8'); } catch { return names; }
  let key = null;
  let self = false;
  const flush = (k, words) => { if (k && !self) for (const w of words) names.add(w); };
  let words = [];
  for (const line of yaml.split('\n')) {
    const top = /^([A-Za-z0-9][A-Za-z0-9 _-]*):\s*(?:#.*)?$/.exec(line);
    if (top) { flush(key, words); key = top[1]; self = false; words = [key.split(/[ _-]/)[0]]; continue; }
    if (!key) continue;
    if (/^\s+(?:self|owner|human)\s*:\s*(?:true|yes)\b/i.test(line)) { self = true; continue; }
    const f = /^\s+(nickname|nicknames|first_name|name)\s*:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!f) continue;
    for (const w of f[2].matchAll(/"([^"]+)"|([A-Za-zÀ-ſ]+)/g)) {
      for (const part of String(w[1] ?? w[2]).split(/\s+/)) words.push(part);
    }
  }
  flush(key, words);
  const out = new Set();
  for (const n of names) {
    const s = String(n).toLowerCase().trim();
    if (s.length >= 4) out.add(s);
  }
  return out;
}

function namesPerson(names, entry) {
  if (!names.size) return false;
  const words = JSON.stringify(entry).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.some((w) => names.has(w));
}

/**
 * Is this entry personal or encrypted - and so never for a subagent?
 * Conservative: in doubt yes.
 */
function isPersonal(root, entry, type, { names = null, ctx = null } = {}) {
  if (!entry || typeof entry !== 'object' || entry.body_enc) return true;
  if (!TYPES.includes(type)) return true;
  if (recallattach.isPrivate(ctx ?? { root, assignments: null }, entry)) return true;
  return namesPerson(names ?? personNames(root), entry);
}

// --- 4. Choice and text ---------------------------------------------------------------

function squash(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** The body of a hit line: what `renderHit` shows, without its day and `[id lane]` prefix. */
function bodyOf(entry) {
  return renderHit({ entry }, { budget: LINE_MAX }).line.replace(/^\s*(?:\d{4}-\d{2}-\d{2})?\s*(?:\[[^\]]*\]\s*)?/, '');
}

/**
 * Choose the lines from the candidates. A candidate is
 * `{ entry, type, id, lane, score }`; lane 0 = file named in the assignment,
 * 1 = text hit. Rank: lane, then type order, then score. Personal ones,
 * doubles and `exclude` ids drop out. The text stays under `bytes`: a hit
 * that no longer fits is left out, not cut.
 *
 * `attach(candidate)` (optional, L3) returns `{ line, id }` or null: the line
 * stands directly under the hit and counts in the byte budget. When it gets
 * tight, another hit WITHOUT a solution gives way first (the one chosen
 * last), not the solution.
 *
 * @returns {{ text: string, ids: string[] }}
 */
export function pick(root, candidates, {
  max = MAX_HITS, bytes = EXTRA_BYTES, exclude = new Set(), attach = null,
} = {}) {
  const names = personNames(root);
  const ctx = { root, assignments: null };
  const rank = (k) => (k.lane * 100) + TYPES.indexOf(k.type);
  const ordered = [...candidates].sort((a, b) => (rank(a) - rank(b)) || ((b.score ?? 0) - (a.score ?? 0)));
  const lines = [];
  const ids = [];
  let used = Buffer.byteLength(HEADER, 'utf8');
  const perType = new Map();
  const units = []; // per line: type and whether a solution hangs on it
  const attachedIds = [];
  const size = (line) => Buffer.byteLength(`\n${line}`, 'utf8');
  for (const k of ordered) {
    if (lines.length >= max) break;
    // At most PER_TYPE of a type: else four errors fill the block and the learning or
    // duty about the same file never gets in.
    if ((perType.get(k.type) ?? 0) >= PER_TYPE) continue;
    if (!k.id || ids.includes(k.id) || exclude.has(k.id)) continue;
    if (isPersonal(root, k.entry, k.type, { names, ctx })) continue;
    let content = '';
    try { content = bodyOf(k.entry); } catch { content = ''; }
    if (!content) continue;
    let line = `- [${k.type} ${k.id}] ${squash(content, LINE_MAX)}`;
    let extra = null;
    if (attach) { try { extra = attach(k); } catch { extra = null; } }
    if (extra && extra.line) line += `\n${extra.line}`; else extra = null;
    const b = size(line);
    if (used + b > bytes && extra) {
      // The solution goes first: hits chosen further down without one give way, but
      // only when clearing is enough (or a hit would give way for nothing).
      const free = units.reduce((n, u, i) => n + (u.attached ? 0 : size(lines[i])), 0);
      if (used - free + b <= bytes) {
        for (let i = lines.length - 1; i >= 0 && used + b > bytes; i -= 1) {
          if (units[i].attached) continue;
          used -= size(lines[i]);
          perType.set(units[i].type, (perType.get(units[i].type) ?? 1) - 1);
          lines.splice(i, 1); ids.splice(i, 1); units.splice(i, 1);
        }
      }
    }
    if (used + b > bytes) continue;
    used += b;
    perType.set(k.type, (perType.get(k.type) ?? 0) + 1);
    lines.push(line);
    units.push({ type: k.type, attached: Boolean(extra) });
    ids.push(k.id);
    if (extra && extra.id) attachedIds.push(extra.id);
  }
  if (!lines.length) return { text: '', ids: [] };
  return { text: `${HEADER}\n${lines.join('\n')}`, ids: [...ids, ...attachedIds] };
}

// --- 5. The whole choice for one hook input ------------------------------------------

const seconds = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/**
 * What a subagent gets for ITS TASK (the second block next to the old
 * start block; the old block stays as it was). Two lanes, the same machine
 * as the recall hook:
 *
 *   0. files the assignment names: the component table, read only (no
 *      background rebuild from here);
 *   1. content words of the assignment: one search per type of
 *      {@link recallattach.SUBAGENT_TYPES}, bar {@link MIN_SCORE}.
 *
 * At most {@link MAX_HITS} hits and {@link EXTRA_BYTES} bytes, nothing
 * personal (see the head). If this takes longer than
 * `MEM_SUBAGENT_TASK_SECONDS` (default 2) the result is thrown away: the old
 * block stays. A running search cannot be aborted in-process, so
 * `bin/mem-subagent-start` runs the first pass under a tighter cap and falls
 * back to the old block. `MEM_SUBAGENT_TASK_OFF=1` switches only this block off.
 *
 * @returns {Promise<{ text: string, ids: string[] } | null>}
 */
export async function forTask(root, j, { env = process.env, exclude = new Set() } = {}) {
  if (env.MEM_SUBAGENT_TASK_OFF === '1') return null;
  const t0 = Date.now();
  const limitMs = seconds(env.MEM_SUBAGENT_TASK_SECONDS, 2) * 1000;
  const tooLong = () => (Date.now() - t0) > limitMs;
  const task = taskFrom(j);
  if (!task) return null;
  const ctx = { root, assignments: null, entries: new Map() };
  const candidates = [];
  const bar = seconds(env.MEM_RETRIEVE_MIN, MIN_SCORE);

  // Lane 0: the named files.
  let table = null;
  try { table = await import('./component-table.mjs'); } catch { table = null; }
  for (const file of table ? filesIn(task, 3) : []) {
    if (tooLong()) return null;
    let rows = [];
    try {
      const looked = table.lookupPath(root, file);
      if (looked.state === 'ok' || looked.state === 'warning') rows = looked.entries;
    } catch { rows = []; }
    const seen = new Set();
    for (const row of rows) {
      if (!row?.id || seen.has(row.id) || !TYPES.includes(row.type)) continue;
      seen.add(row.id);
      const found = recallattach.standingEntry(ctx, row.id);
      // A closed duty is no longer owed; a fixed error (done) still teaches.
      if (!found || !TYPES.includes(found.type) || (found.type === 'duty' && found.state)) continue;
      candidates.push({ entry: found.e, type: found.type, id: row.id, lane: 0, score: 0 });
    }
  }

  // Lane 1: the content words.
  try {
    const search = await import('./search.mjs');
    if (!tooLong()) {
      const index = search.loadIndex(root);
      if (index && !tooLong()) {
        const query = search.retrievalQuery(task, { root, index }) || task;
        for (const type of TYPES) {
          if (tooLong()) return null;
          const hits = search.search(index, query, { top: 4, type, noRaw: true, mmr: true, mmrLambda: 0.7 });
          for (const h of hits) {
            if (!(Number(h.score) >= bar) || !h.entry?.id) continue;
            candidates.push({ entry: h.entry, type, id: h.entry.id, lane: 1, score: Number(h.score) });
          }
        }
      }
    }
  } catch { /* the extra is never a reason to stop the start */ }

  if (tooLong()) return null;
  // L3: below an error its solution, the same exclusions as for the hit itself.
  const solutions = recallattach.solutionsFor(root,
    candidates.filter((k) => k.type === 'error').map((k) => k.id), { env, subagent: true });
  const chosen = pick(root, candidates, {
    exclude,
    attach: (k) => { const s = k.type === 'error' ? solutions.get(k.id) : null; return s ? { line: s.line, id: s.journalId } : null; },
  });
  return chosen.text ? chosen : null;
}
