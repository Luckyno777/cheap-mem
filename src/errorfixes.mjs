// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * errorfixes — link errors to what fixed them and to what was learned
 * from them, on the link drawer that already exists (`resolves`,
 * `generalizes` in `memory.LINK_KINDS`); no new graph. Port of lucky-mem's
 * L2a (`src/fehlerloesung.mjs`; its trailer is the German twin of `Fixes:`).
 *
 *   1. Commit trailer `Fixes: <error-id>[, ...]`: `mem error-fixes backfill`
 *      writes ONE `resolves` link per known id, from and `evidence:
 *      commit:<hash>`. An unknown id is a warning, never a link.
 *   2. `mem log learning --from <error-id>` writes `generalizes` links;
 *      without it a note names up to three fitting errors.
 *   3. `mem log error` names learnings, procedures and fixes for the same
 *      class or file (output only).
 *   4. Doctor finding `error-linked`.
 *
 * Idempotent (key: error id + evidence), append-only, evidence only.
 */

import { execFileSync } from 'node:child_process';
import * as memory from './memory.mjs';
import * as errorfile from './errorfile.mjs';
import * as neighbours from './neighbours.mjs';
import * as search from './search.mjs';
import * as procedure from './procedure.mjs';

/** How long a commit hash is in `evidence` (git-usual, unique enough). */
const HASH_LENGTH = 12;
/** Who writes the edges (field `agent`). */
export const AGENT = 'errorfixes';
/** At most this many errors/learnings/procedures/fixes per note. */
const NOTE_MAX = 3;
/** The window of the "last 30 days" metric. */
export const WINDOW_DAYS = 30;
/**
 * Targets of `error-linked`, taken over from the sibling house (measured
 * there 2026-09-30): not every error has a fix commit or a lesson, so
 * 100 % only guessing reaches. Targets, not a measurement of this house.
 */
export const TARGET_RESOLVES = 0.25;
export const TARGET_GENERALIZES = 0.10;
/** Below this many errors in the window a share says nothing (unknown). */
export const MIN_WINDOW_ERRORS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

// --- the trailer ---------------------------------------------------------

/** Ids on the `Fixes:` lines (any case); a token starting `(` or `-` ends the list. */
export function fixesIds(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/^[ \t]*Fixes:[ \t]*(.*)$/gim)) {
    for (const t of m[1].split(/[,;\s]+/).filter(Boolean)) {
      if (/^[(\-–—]/.test(t)) break;
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** `commit:<hash>` — the ONE spelling of a commit as evidence. */
function commitEvidence(hash) {
  return `${memory.COMMIT_EVIDENCE_PREFIX}${String(hash).slice(0, HASH_LENGTH)}`;
}

// --- reading the store ---------------------------------------------------

/** Errors that count, id -> entry: done/obsolete still do (a fix closes); superseded/discarded/disputed not. */
export function errorMap(root) {
  const map = new Map();
  for (const project of [null, ...memory.listProjects(root)]) {
    let entries;
    try { ({ entries } = memory.readLog(root, 'error', { project })); } catch { continue; }
    const retired = memory.retiredMap(entries);
    for (const e of entries) {
      if (!e || e.__broken || !e.id || memory.isClosingLine(e) || map.has(e.id)) continue;
      const state = retired.get(e.id)?.state;
      if (state === 'superseded' || state === 'discarded' || state === 'disputed') continue;
      map.set(e.id, { ...e, _project: project });
    }
  }
  return map;
}

/** Every link in force (withdrawn ones out), global and per project, with `from`/`to` normalised. */
export function allLinks(root) {
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    let res;
    try { res = memory.readLog(root, 'link', { project }); } catch { continue; }
    const withdrawn = memory.retiredMap(res.entries);
    for (const l of res.entries) {
      if (!l || l.__broken || memory.isClosingLine(l)) continue;
      if (l.id && withdrawn.has(l.id)) continue;
      const from = l.from ?? l.source ?? null;
      const to = l.to ?? l.target ?? null;
      if (from && to && l.kind) out.push({ ...l, from, to });
    }
  }
  return out;
}

/** Keys `<error-id>|<evidence>` of the `resolves` edges that carry evidence. */
function existingResolvesKeys(root) {
  const s = new Set();
  for (const l of allLinks(root)) {
    if (l.kind === 'resolves' && typeof l.evidence === 'string' && l.evidence) s.add(`${l.to}|${l.evidence}`);
  }
  return s;
}

// --- writing ----------------------------------------------------------------

/** ONE `resolves` link, unless the error is unknown, evidence missing or the key known. */
function writeResolves(root, { from, errorId, evidence, why }, { errors, known, checkOnly = false }) {
  const e = errors.get(errorId);
  if (!e) return { written: false, reason: 'unknown' };
  if (!evidence) return { written: false, reason: 'no-evidence' };
  const key = `${errorId}|${evidence}`;
  if (known.has(key)) return { written: false, reason: 'present' };
  known.add(key);
  if (checkOnly) return { written: false, would: true, reason: 'would-write' };
  const { entry } = memory.logEntry(root, 'link', {
    from, to: errorId, kind: 'resolves', evidence, why, agent: AGENT,
  }, { project: e._project ?? null });
  return { written: true, entry };
}

/** `Fixes:` trailers of `[{hash, body}]` -> links; `unknown` holds the warnings to show. */
function edgesFromCommits(root, commits, { checkOnly = false, errors = null, known = null } = {}) {
  const f = errors ?? errorMap(root);
  const k = known ?? existingResolvesKeys(root);
  const r = { written: [], would: [], present: [], unknown: [] };
  for (const c of commits) {
    for (const id of fixesIds(c.body)) {
      if (!f.has(id)) { r.unknown.push({ hash: c.hash, id }); continue; }
      const evidence = commitEvidence(c.hash);
      const res = writeResolves(root, {
        from: evidence, errorId: id, evidence,
        why: `Commit ${evidence.slice(memory.COMMIT_EVIDENCE_PREFIX.length)} carries "Fixes: ${id}": `
          + `${String(c.body).split('\n')[0].slice(0, 120)}`,
      }, { errors: f, known: k, checkOnly });
      if (res.written) r.written.push({ hash: c.hash, id });
      else if (res.would) r.would.push({ hash: c.hash, id });
      else if (res.reason === 'present') r.present.push({ hash: c.hash, id });
    }
  }
  return r;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
}

function parseLog(rawLog) {
  return rawLog.split('\x02').filter((x) => x.trim()).map((b) => {
    const [headPart, ...restParts] = b.split('\x1f');
    // eslint-disable-next-line no-control-regex -- the control characters are exactly what this pattern matches
    return { hash: headPart.trim(), body: restParts.join('\x1f').replace(/\x03\s*$/, '') };
  });
}

// --- history ------------------------------------------------------------------

const FIX_WORD = /\b(fix|fixes|fixed|resolve|resolves|resolved|close|closes|closed|repair|repaired|repairs)\b/i;
/** A fix verb DIRECTLY before the id ("fixes 0cr3js6abcde") — the narrow reading. */
const FIX_BEFORE_ID = new RegExp(
  '\\b(?:fix|fixes|fixed|resolves|resolved|closes|closed|repairs|repaired)\\s+(?:the\\s+)?'
  + `(?:error\\s+|entry\\s+)?(?:id\\s+)?([0-9a-z]{${memory.ID_LENGTH}})\\b`, 'gi');
const ID_TOKEN = new RegExp(`\\b[0-9a-z]{${memory.ID_LENGTH}}\\b`, 'g');
const TRAILER_LINE = /^[ \t]*Fixes:/i;

/**
 * Known ids after a fix verb ("fixes <id>") — the narrow reading, the only
 * evidence. The sibling house found the wide one (a fix word anywhere on
 * the line) right in about 4 of 13 cases; `textCandidates` only counts it.
 */
function textMentions(body, errors) {
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    if (TRAILER_LINE.test(line)) continue;
    for (const m of line.matchAll(FIX_BEFORE_ID)) {
      const id = m[1].toLowerCase();
      if (errors.has(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** The wide reading (a fix word anywhere on the line of the id) — ONLY counted, never written. */
function textCandidates(body, errors) {
  const narrow = new Set(textMentions(body, errors));
  const out = [];
  for (const line of String(body ?? '').split('\n')) {
    if (TRAILER_LINE.test(line) || !FIX_WORD.test(line)) continue;
    for (const t of line.match(ID_TOKEN) ?? []) {
      if (errors.has(t) && !narrow.has(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Evidenced links from history: `Fixes:` trailers (`git log --all` of
 * `repo`), the narrow "fixes <id>" text, and closed duties whose F4
 * evidence (`memory.dutyHasEvidence`) holds for the id. `since` limits
 * the commits; `checkOnly` writes nothing.
 */
export function backfill(root, { repo = root, since = null, checkOnly = false } = {}) {
  const errors = errorMap(root);
  const known = existingResolvesKeys(root);
  const args = ['log', '--all', '--format=\x02%H\x1f%B\x03'];
  if (since) args.push('--not', String(since));
  const commits = parseLog(git(repo, args));

  const trailer = edgesFromCommits(root, commits, { checkOnly, errors, known });

  const text = { written: [], would: [], present: [], candidates: 0 };
  for (const c of commits) {
    text.candidates += textCandidates(c.body, errors).length;
    for (const id of textMentions(c.body, errors)) {
      const evidence = commitEvidence(c.hash);
      const res = writeResolves(root, {
        from: evidence, errorId: id, evidence,
        why: `Commit ${evidence.slice(memory.COMMIT_EVIDENCE_PREFIX.length)} says "fixes ${id}": `
          + `${String(c.body).split('\n')[0].slice(0, 120)}`,
      }, { errors, known, checkOnly });
      if (res.written) text.written.push({ hash: c.hash, id });
      else if (res.would) text.would.push({ hash: c.hash, id });
      else if (res.reason === 'present') text.present.push({ hash: c.hash, id });
    }
  }

  const duties = { written: [], would: [], present: [], withoutEvidence: 0 };
  let done = [];
  try { ({ done } = memory.openDuties(root)); } catch { done = []; }
  for (const d of done) {
    if (String(d._closed?.state ?? 'done') !== 'done') continue;
    for (const id of Array.isArray(d.error_ids) ? d.error_ids : []) {
      if (!errors.has(id)) continue;
      const ev = memory.dutyHasEvidence(root, { error_ids: [id] });
      if (!ev.ok) { duties.withoutEvidence += 1; continue; }
      const res = writeResolves(root, {
        from: d.id, errorId: id, evidence: `duty:${d.id}`,
        why: `Duty ${d.id} closed as done, evidence: ${ev.why}`,
      }, { errors, known, checkOnly });
      if (res.written) duties.written.push({ duty: d.id, id });
      else if (res.would) duties.would.push({ duty: d.id, id });
      else if (res.reason === 'present') duties.present.push({ duty: d.id, id });
    }
  }
  return { checkOnly, commitsRead: commits.length, trailer, text, duties };
}

/** The numbers of `backfill()` as lines (CLI). */
export function backfillLines(r) {
  const n = (x) => (r.checkOnly ? x.would.length : x.written.length);
  const what = r.checkOnly ? 'would write' : 'written';
  const lines = [
    `${r.commitsRead} commits read${r.checkOnly ? ' (check only, nothing written)' : ''}.`,
    `  Trailer "Fixes:":     ${what} ${n(r.trailer)}, present ${r.trailer.present.length}, unknown id ${r.trailer.unknown.length}`,
    `  Text "fixes <id>":    ${what} ${n(r.text)}, present ${r.text.present.length} (another ${r.text.candidates} mention(s) with a fix word NOT evidenced, only counted)`,
    `  Closed duties:        ${what} ${n(r.duties)}, present ${r.duties.present.length}, without evidence for the id ${r.duties.withoutEvidence}`,
    `  Total ${what}: ${n(r.trailer) + n(r.text) + n(r.duties)}`,
  ];
  for (const u of r.trailer.unknown.slice(0, 10)) {
    lines.push(`  WARNING: commit ${String(u.hash).slice(0, HASH_LENGTH)} says "Fixes: ${u.id}" — `
      + 'no error with this id, no edge.');
  }
  return lines;
}

// --- --from (learning -> error) --------------------------------------------------

/** `--from a,b` -> list (commas/spaces), no duplicates. */
export function fromIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((x) => x.trim()).filter(Boolean))];
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean))];
}

/** The ids of `--from` against the store: `{ok, unknown}`. Writes nothing. */
export function checkFrom(root, ids) {
  const f = errorMap(root);
  return { ok: ids.filter((i) => f.has(i)), unknown: ids.filter((i) => !f.has(i)) };
}

/** One `generalizes` link per id (learning -> error), skipping existing ones. */
export function writeGeneralizes(root, learningId, ids, { project = null } = {}) {
  const f = errorMap(root);
  const have = new Set(allLinks(root).filter((l) => l.kind === 'generalizes').map((l) => `${l.from}|${l.to}`));
  const out = { written: [], skipped: [], unknown: [] };
  for (const id of ids) {
    if (!f.has(id)) { out.unknown.push(id); continue; }
    if (have.has(`${learningId}|${id}`)) { out.skipped.push(id); continue; }
    memory.logEntry(root, 'link', {
      from: learningId, to: id, kind: 'generalizes',
      why: `Learning ${learningId} is drawn from error ${id} (mem log learning --from).`,
      agent: AGENT,
    }, { project: f.get(id)._project ?? project ?? null });
    out.written.push(id);
  }
  return out;
}

// --- notes (output only) ------------------------------------------------------

function words(...parts) {
  return new Set(search.contentWords(parts.filter(Boolean).join(' ')));
}

function short(e) {
  const t = String(e.title ?? e.learning ?? e.rule ?? e.text ?? '').replace(/\s+/g, ' ').slice(0, 70);
  return `${String(e.ts ?? '').slice(0, 10)}  ${String(e.id).padEnd(12)} ${t}`;
}

function names(e, cls) {
  if (!cls) return false;
  if (Array.isArray(e?.tags) && e.tags.map(String).includes(cls)) return true;
  if (e?._type === 'procedure' && procedure.triggersOf(e).includes(cls)) return true;
  return [e?.title, e?.text, e?.learning, e?.rule].some((x) => typeof x === 'string' && x.includes(cls));
}

function share(a, b) {
  return a.some((x) => b.includes(x));
}

/** Learning without `--from`: up to NOTE_MAX errors by class, file or title words; display only. */
export function noteForLearning(root, learning, { max = NOTE_MAX, newId = '<new-id>', via = 'cli' } = {}) {
  let f;
  let links;
  try { f = errorMap(root); links = allLinks(root); } catch { return []; }
  const generalized = new Set(links.filter((l) => l.kind === 'generalizes').map((l) => l.to));
  const files = errorfile.files(learning);
  const mine = words(learning.title, learning.learning, learning.text);
  const scored = [];
  for (const e of f.values()) {
    const classHit = names(learning, e.class);
    const fileHit = files.length > 0 && share(files, errorfile.files(e));
    const o = neighbours.overlap(mine, words(e.title));
    const lexical = o.shared >= 3 && o.jaccard >= neighbours.SIMILAR_MIN_JACCARD;
    if (!classHit && !fileHit && !lexical) continue;
    const why = [classHit && `class ${e.class}`, fileHit && 'file', lexical && 'words'].filter(Boolean).join('+');
    const score = (classHit ? 2 : 0) + (fileHit ? 2 : 0) + o.jaccard;
    scored.push({ e, why, score, already: generalized.has(e.id) });
  }
  scored.sort((x, y) => (x.already - y.already) || (y.score - x.score)
    || String(y.e.ts ?? '').localeCompare(String(x.e.ts ?? '')));
  const top = scored.slice(0, max);
  if (!top.length) return [];
  const lines = ['', '  Fitting errors (class/file/word overlap; a note, nothing linked):'];
  for (const t of top) lines.push(`    ${short(t.e)} [${t.why}]${t.already ? ' (already generalized)' : ''}`);
  lines.push('    If this lesson follows from them, link it:');
  for (const t of top) {
    lines.push(via === 'mcp'
      ? `      mem_log type=link fields={"from":"${newId}","to":"${t.e.id}","kind":"generalizes","why":"..."}`
      : `      mem log link --from ${newId} --to ${t.e.id} --kind generalizes --why "..."`);
  }
  lines.push('    Next time right away: mem log learning ... --from <error-id[,...]>');
  return lines;
}

/** Logging an error: learnings, procedures and fixes for its class/file; display only. */
export function noteForError(root, errorEntry, { max = NOTE_MAX } = {}) {
  let all;
  let links;
  try { all = memory.entriesById(root); links = allLinks(root); } catch { return []; }
  const cls = typeof errorEntry.class === 'string' && errorEntry.class.trim() ? errorEntry.class.trim() : null;
  const files = errorfile.files(errorEntry);
  if (!cls && !files.length) return [];

  const related = new Set();
  for (const [id, e] of all) {
    if (e._type !== 'error' || id === errorEntry.id) continue;
    if ((cls && e.class === cls) || (files.length && share(files, errorfile.files(e)))) related.add(id);
  }

  const rank = (e, viaEdge) => (viaEdge ? 2 : 0)
    + (names(e, cls) ? 1 : 0) + (files.length && share(files, errorfile.files(e)) ? 1 : 0);
  const newestFirst = (x, y) => (y.r - x.r) || String(y.e.ts ?? '').localeCompare(String(x.e.ts ?? ''));

  const viaEdge = new Set(links.filter((l) => l.kind === 'generalizes' && related.has(l.to)).map((l) => l.from));
  const learn = [];
  const proc = [];
  for (const [id, e] of all) {
    if (e._type !== 'learning' && e._type !== 'procedure') continue;
    const k = viaEdge.has(id);
    const fits = k || names(e, cls) || (files.length && share(files, errorfile.files(e)));
    if (!fits) continue;
    (e._type === 'learning' ? learn : proc).push({ e, r: rank(e, k) });
  }
  learn.sort(newestFirst);
  proc.sort(newestFirst);

  const fixes = links.filter((l) => l.kind === 'resolves' && related.has(l.to) && l.evidence)
    .sort((x, y) => String(y.ts ?? '').localeCompare(String(x.ts ?? '')));

  if (!learn.length && !proc.length && !fixes.length) return [];
  const where = [cls && `class ${cls}`, files[0] && `file ${files[0]}`].filter(Boolean).join(', ');
  const lines = ['', `  Already there for this (${where}; a note, nothing injected, nothing written):`];
  for (const x of learn.slice(0, max)) lines.push(`    learning  ${short(x.e)}`);
  for (const x of proc.slice(0, max)) lines.push(`    procedure ${short(x.e)}`);
  for (const l of fixes.slice(0, max)) {
    lines.push(`    fix       ${l.evidence} fixed ${l.to}: ${String(all.get(l.to)?.title ?? '').replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  return lines;
}

// --- metric ----------------------------------------------------------------------

/** Errors with a `resolves`/`generalizes` link, overall and in the window. */
export function metric(root, { now = Date.now() } = {}) {
  const f = errorMap(root);
  const links = allLinks(root);
  const resolved = new Set(links.filter((l) => l.kind === 'resolves').map((l) => l.to));
  const generalized = new Set(links.filter((l) => l.kind === 'generalizes').map((l) => l.to));
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const count = (list) => ({
    n: list.length,
    resolves: list.filter((e) => resolved.has(e.id)).length,
    generalizes: list.filter((e) => generalized.has(e.id)).length,
  });
  const all = [...f.values()];
  const recent = all.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
  return { total: count(all), window: count(recent) };
}
