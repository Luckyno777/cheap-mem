// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * answercheck — check the LAST answer, in the Stop hook, against
 * patterns tied to a LOGGED error, before that answer ever reaches the
 * human.
 *
 * **The problem this answers.** A recall hook (`mem-before-edit`,
 * `mem-retrieve`) shows what the memory already knows — but only if
 * somebody reads it and acts on it. The gap it does not close: the
 * SAME mistake, already logged once, gets made again in the very turn
 * that is about to end, and by the time anyone notices it is the next
 * message, one turn too late to still be the SAME fix.
 *
 * The Stop hook sees the finished answer before it reaches the human.
 * If it recognises a pattern there, the correction can happen in THAT
 * SAME turn instead of waiting for someone to catch it.
 *
 * **Patterns are this memory's OWN data, never this codebase's.** Every
 * pattern must name an `error_id` that is actually logged in THIS
 * memory's own `errors.jsonl` (global or a project) — checked HERE, at
 * read time, not only by a test that happens to run against a fixed
 * built-in list. A memory with no error log yet, or no patterns file,
 * checks nothing: silence is the correct default, not a bug to route
 * around. `docs/answer-check-patterns.example.json` shows the shape;
 * copying it to `.mem/answer-patterns.json` and filling in real
 * `error_id`s is what arms it — no name from this codebase's own users
 * or incidents is baked in anywhere here.
 *
 * **Three rules, all enforced here, none of them a document:**
 *
 *   1. No pattern on suspicion. A pattern whose `error_id` is not
 *      found among this memory's own logged errors is dropped before
 *      it is ever matched — a guess would report an innocent answer.
 *   2. At most one report per session per pattern. A second report
 *      would repeat the same lecture, and `stop_hook_active` (this
 *      turn already continued once) reports nothing at all — no loop.
 *   3. Kill switch: once a pattern's OWN measured record shows fewer
 *      than 1 correct report in 5, it stops firing. `isActive()`
 *      computes this from the stored numbers, never from a flag
 *      somebody has to remember to flip.
 *
 * **Transcript content is data, never instruction.** This only reads
 * and compares against fixed patterns; nothing in a transcript is ever
 * executed, interpreted, or passed on as a command. What goes into the
 * continuation reason is at most one short, redacted line per hit, in
 * quotes, as evidence of what it hung on.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import { textOf } from './raw.mjs';

/** Kill switch: under this hit rate, a pattern stops firing. */
export const MIN_HIT_RATE = 1 / 5;
/** Below this many measured reports, the hit rate is `unknown`, not bad. */
export const MIN_REPORTS = 5;
/** Read only the tail of a transcript — the last answer lives there. */
export const READ_BYTES = 2 * 1024 * 1024;
/** Length of the quoted excerpt in a continuation reason. */
export const EXCERPT_CHARS = 120;
/** Per-session "already reported" state — per-machine, never committed. */
export const STATE_DIR = path.join('.pipeline', 'answer-check');
/** Where a memory's own patterns live, relative to its root. */
export const PATTERNS_FILE = path.join('.mem', 'answer-patterns.json');

function patternsPath(root, override = null) {
  if (override) return override;
  const fromEnv = process.env.MEM_ANSWER_CHECK_PATTERNS;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(root, fromEnv);
  return path.join(root, PATTERNS_FILE);
}

/** Every id ever logged under `error`, global plus every project. */
export function loggedErrorIds(root) {
  const ids = new Set();
  for (const project of [null, ...memory.listProjects(root)]) {
    let entries;
    try { ({ entries } = memory.readLog(root, 'error', { project })); }
    catch { continue; }
    for (const e of entries) if (e && e.id) ids.add(String(e.id));
  }
  return ids;
}

/**
 * Read and validate the patterns file. Never throws: a missing file, a
 * broken one, or one full of patterns with no logged error behind them
 * all come back as an empty, inert pattern list — the default this
 * mechanism ships with is OFF, not a crash.
 *
 * Returns `{ patterns, missing, broken, rejected }`. `rejected` names
 * every entry dropped and WHY (no `error_id` logged, no regex, no id) —
 * visible, not silently swallowed, for whoever is maintaining the file.
 */
export function loadPatterns(root, { path: override = null } = {}) {
  const p = patternsPath(root, override);
  if (!fs.existsSync(p)) return { patterns: [], missing: true, broken: false, rejected: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { patterns: [], missing: false, broken: true, rejected: [], error: e.message }; }
  if (!Array.isArray(raw)) {
    return { patterns: [], missing: false, broken: true, rejected: [], error: 'not a JSON array' };
  }

  const knownErrors = loggedErrorIds(root);
  const patterns = [];
  const rejected = [];
  const seenIds = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { rejected.push({ entry, why: 'not an object' }); continue; }
    const id = String(entry.id ?? '').trim();
    const errorId = String(entry.error_id ?? '').trim();
    const regexSource = typeof entry.pattern === 'string' ? entry.pattern : '';
    if (!id) { rejected.push({ entry, why: 'no id' }); continue; }
    if (seenIds.has(id)) { rejected.push({ entry, why: `duplicate id '${id}'` }); continue; }
    if (!errorId) { rejected.push({ entry, why: 'no error_id — a pattern on suspicion' }); continue; }
    if (!knownErrors.has(errorId)) {
      rejected.push({ entry, why: `error_id '${errorId}' is not logged in this memory` });
      continue;
    }
    if (!regexSource) { rejected.push({ entry, why: 'no pattern regex' }); continue; }
    let re;
    try { re = new RegExp(regexSource, entry.flags ?? 'i'); }
    catch (e) { rejected.push({ entry, why: `bad regex: ${e.message}` }); continue; }
    seenIds.add(id);
    patterns.push({
      id, error_id: errorId, reason: String(entry.reason ?? '').trim(),
      regex: re, disabled: entry.disabled === true,
      measured: (entry.measured && typeof entry.measured === 'object') ? entry.measured : null,
    });
  }
  return { patterns, missing: false, broken: false, rejected };
}

/** Active, solely from the pattern's OWN measured hit rate — never a flag someone forgets. */
export function isActive(pattern) {
  if (!pattern || !pattern.error_id || !pattern.regex) return false;
  if (pattern.disabled) return false;
  const m = pattern.measured;
  if (!m || !(Number(m.reports) >= MIN_REPORTS)) return true;
  return Number(m.correct) / Number(m.reports) >= MIN_HIT_RATE;
}

/** Redact a matched line to one safe, capped line for a continuation reason. */
export function redactExcerpt(s, max = EXCERPT_CHARS) {
  const one = String(s).replace(/\s+/g, ' ').replace(/["`]/g, "'").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The first line of `text` an active pattern's regex matches, or null. */
export function matchLine(text, pattern) {
  for (const line of String(text).split('\n')) {
    if (pattern.regex.test(line)) return line;
  }
  return null;
}

/** All active patterns against `text`; each hit carries a redacted excerpt. */
export function checkText(text, patterns) {
  if (!text) return [];
  const hits = [];
  for (const p of patterns) {
    if (!isActive(p)) continue;
    const line = matchLine(text, p);
    if (line) hits.push({ id: p.id, error_id: p.error_id, reason: p.reason, excerpt: redactExcerpt(line) });
  }
  return hits;
}

/**
 * The last answer out of already-parsed transcript lines: every
 * assistant text block AFTER the last user line (a question or a tool
 * result), skipping sidechains (a subagent's own thread never counts as
 * the main answer — see `src/gauges.mjs`).
 */
export function lastAssistantMessageFromLines(lines) {
  let parts = [];
  for (const o of lines) {
    if (!o || typeof o !== 'object' || o.isSidechain) continue;
    if (o.type === 'user') { parts = []; continue; }
    if (o.type !== 'assistant') continue;
    const t = textOf(o);
    if (t.trim()) parts.push(t);
  }
  const joined = parts.join('\n').trim();
  return joined || null;
}

/** JSONL text into objects; a broken or cut-off line (reading from the tail) is dropped. */
export function parseLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* cut off or malformed */ }
  }
  return out;
}

/** The last answer out of a transcript file — reads only its tail. */
export function lastAssistantMessage(transcriptPath, { readBytes = READ_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, readBytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return lastAssistantMessageFromLines(parseLines(buf.toString('utf8')));
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

function statePath(root, sessionId) {
  const safe = String(sessionId || 'no-session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(root, STATE_DIR, `${safe}.json`);
}

function readState(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && Array.isArray(j.reported)) ? j : { reported: [] };
  } catch { return { reported: [] }; }
}

/**
 * The Stop-hook core. Takes the hook JSON (already parsed), returns
 * either `null` (nothing to say) or the hook response
 * `{ decision: 'block', reason }`, which continues the SAME turn with
 * `reason` instead of ending it.
 */
export function checkStop(root, input, { env = process.env, patternsPath: override = null } = {}) {
  if (!input || typeof input !== 'object') return null;
  if (env.MEM_ANSWER_CHECK === '0') return null;
  // Already continued once this turn: never a second time.
  if (input.stop_hook_active === true) return null;

  const text = (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim())
    ? input.last_assistant_message
    : (input.transcript_path ? lastAssistantMessage(input.transcript_path) : null);
  if (!text) return null;

  const { patterns } = loadPatterns(root, { path: override });
  if (patterns.length === 0) return null; // no populated patterns: inert by design

  const all = checkText(text, patterns);
  if (all.length === 0) return null;

  const sp = statePath(root, input.session_id);
  const state = readState(sp);
  const fresh = all.filter((h) => !state.reported.includes(h.id));
  if (fresh.length === 0) return null;

  state.reported.push(...fresh.map((h) => h.id));
  try {
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(state));
  } catch {
    // Without recorded state every Stop would repeat the same report.
    return null;
  }

  const lines = fresh.map((h) =>
    `- Pattern ${h.id} (logged error ${h.error_id})${h.reason ? `: ${h.reason}` : ''} Excerpt: "${h.excerpt}"`);
  const reason = [
    'cheap-mem answer check: your last answer matches a pattern tied to a logged error.',
    ...lines,
    'Check this now, in the same turn, and fix the answer if it applies. If it is a false '
      + 'alarm, say so in one sentence and finish. This report comes at most once per '
      + 'session per pattern.',
  ].join('\n');
  return { decision: 'block', reason };
}
