// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * userhabits — a generic, code-only habit meter over the human user's
 * OWN captured transcripts.
 *
 * **Where the material comes from.** cheap-mem already captures every
 * transcript (see `raw.mjs`): redacted, gzipped, stored under
 * `raw/YYYY/MM/` (or wherever `CHEAP_MEM_ARCHIVE` points), one line per
 * turn, physically addressable by capture path + line number. This
 * module reads exactly that material — no second capture path, no new
 * storage format. If a root has no readable capture at all (a fresh
 * `mem init`, or an archive that is not mounted), every observation
 * reports `unknown` — never `0`, and nothing is invented to fill the
 * gap. See `analyze()`.
 *
 * **Patterns are data, not code.** Each habit is a regular expression
 * loaded from a JSON file: `{name, title, regex, flags, inverted,
 * action, examples: {positive, negative}}`. The four shipped defaults
 * (`src/user-patterns.default.json`) are deliberately generic — a
 * delegated decision, a correction of the assistant, pasted terminal
 * output merged with the prompt, and a message carrying no signal word
 * of the configured default language — with no name, phrase or
 * participant baked in. A deployment that wants its own vocabulary
 * points `CHEAP_MEM_USER_PATTERNS` at its own file, or sets
 * `userHabitPatterns` in `.mem/config.json`; nothing here hardcodes a
 * phrase belonging to any one person. Every pattern MUST ship at least
 * one positive and one negative example — `checkAllExamples()` proves
 * the regex actually agrees with its own examples, at load time and in
 * `test/userhabits.test.mjs`.
 *
 * **Three states, never two** (the same rule the rest of this house
 * follows — see CLAUDE.md, "Three states"):
 *
 *   measured             count >= the measurement threshold, with a
 *                         located first/last quote.
 *   too_little_evidence  0 up to the threshold — honestly little,
 *                         not an error. A rule with 0 hits is still a
 *                         valid rule; it has simply found nothing yet.
 *   unknown              NO capture on this machine is readable
 *                         (archive not mounted, fresh install). Applies
 *                         to every observation at once — not the
 *                         same statement as "0 hits among readable
 *                         captures", which is `too_little_evidence`.
 *
 * **Privacy.** Every quote in every output (CLI, MCP, test, log) is
 * capped at `QUOTE_MAX` characters and runs through
 * `redaction.redact()` first — even though the raw capture is
 * already redacted at write time. A second latch is cheaper than a
 * leak, and "the one guard checks the wrong thing" is a known failure
 * class in this house (see BUILDING.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as raw from './raw.mjs';
import * as archive from './archive.mjs';
import * as redaction from './redaction.mjs';
import * as cfgmod from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- How much is enough? A number to justify, not to guess. ----------

/** Threshold for `analyze()`: an observation counts as measured once
 *  it has this many hits, each with a location. */
export const MIN_EVIDENCE_MEASURE = 5;

/** Threshold for `sessionStartLines()`: deliberately higher than the
 *  measurement threshold — a line that lands on every session start
 *  is a stronger claim than a row in a measurement table, and earns
 *  more evidence before it is shown. */
export const MIN_EVIDENCE_DISPLAY = 8;

/** A calendar week counts toward stability only with at least this
 *  many real messages — otherwise "no hit this week" says nothing. */
export const MIN_MESSAGES_PER_WEEK = 5;

/** Every quote in every output is capped here (privacy requirement). */
export const QUOTE_MAX = 120;

/** `analyze()`/`realMessages()` never run longer than this — a
 *  growing archive must never block a session start. */
export const TIME_CAP_MS = 1500;

/** At most this many lines (including the header) leave through
 *  `sessionStartLines()`. */
export const SESSION_START_MAX_LINES = 5;

// --- What counts as a REAL user message? ------------------------------
//
// A transcript line with `type: 'user'` and string content LOOKS like
// something the person typed — often it is not. The harness feeds
// several kinds of synthetic content in as plain `user` lines: a
// background task reporting back, a Stop-hook or subagent handback
// (`isMeta: true`), a system reminder. Counted in without this filter,
// a "habit" would often be a habit of the CLIENT talking to itself, not
// of the person at the keyboard.
const SYNTHETIC_PREFIXES = Object.freeze([
  '<task-notification', '<system-reminder', '<command-message',
  '<command-name', '<local-command-stdout', '<local-command-stderr',
]);

export function isRealUserMessage(o) {
  if (!o || o.type !== 'user' || o.isMeta || o.isSidechain) return false;
  const c = o.message?.content;
  if (typeof c !== 'string' || !c.trim()) return false;
  const start = c.trimStart();
  return !SYNTHETIC_PREFIXES.some((p) => start.startsWith(p));
}

// --- Locating a hit: capture path + PHYSICAL line number --------------

/**
 * Read one capture, decompressed, with the PHYSICAL line number per
 * entry (header line counted) — the number `zcat <capture> | sed -n
 * 'Np'` would also find.
 *
 * `raw.readCapture()` does not return this (its job is parsing, not
 * locating), so a thin reader lives here instead of assuming "the
 * header is always line 1, there are never blank lines" — true over
 * every capture measured while building this, but a location built on
 * an assumption rather than a count is exactly the class of bug this
 * house tracks (see BUILDING.md, "two truths").
 */
function readCaptureWithLineNumbers(root, relPath) {
  const store = archive.readConfig(process.env, root);
  const data = archive.get(store, root, relPath);
  if (data === null) {
    const e = new Error(`capture unreachable: ${relPath} (archive: ${store.location})`);
    e.code = 'ARCHIVE_UNREACHABLE';
    throw e;
  }
  const text = zlib.gunzipSync(data).toString('utf8');
  const out = [];
  const rawLines = text.split('\n');
  for (let i = 0; i < rawLines.length; i += 1) {
    const lt = rawLines[i];
    if (!lt.trim()) continue;
    let o;
    try { o = JSON.parse(lt); } catch { continue; }
    if (o.__stamp) continue; // the provenance header, not a transcript line
    out.push({ o, line: i + 1 });
  }
  return out;
}

function quote(text) {
  const { text: safe } = redaction.redact(text);
  const oneLine = safe.replace(/\s+/g, ' ').trim();
  return oneLine.length > QUOTE_MAX ? `${oneLine.slice(0, QUOTE_MAX - 1)}…` : oneLine;
}

function location(message) {
  if (!message) return null;
  return { path: message.path, line: message.line, ts: message.ts, quote: quote(message.text) };
}

/**
 * Every REAL user message across every READABLE capture, with its
 * location, sorted oldest first.
 *
 * An unreadable capture (archive not mounted) is skipped, not treated
 * as an error — that is the normal case for a capture whose record
 * points at another machine's archive. `capped: true` means the time
 * cap cut the loop before the end of the list: the result is then a
 * REAL subset (older captures are missing), not wrong but incomplete,
 * and the caller says so rather than staying quiet about it.
 */
export function realMessages(root, { timeCapMs = TIME_CAP_MS } = {}) {
  const start = Date.now();
  const paths = raw.listCaptures(root);
  const messages = [];
  let capturesReadable = 0;
  let capturesUnreadable = 0;
  let capped = false;

  for (let i = 0; i < paths.length; i += 1) {
    // Not a clock check per capture (a syscall) — every 10 is close
    // enough to the cap without missing it by more than a handful.
    if (i % 10 === 0 && Date.now() - start > timeCapMs) { capped = true; break; }
    const p = paths[i];
    let lined;
    try { lined = readCaptureWithLineNumbers(root, p); }
    catch { capturesUnreadable += 1; continue; }
    capturesReadable += 1;
    for (const { o, line } of lined) {
      if (!isRealUserMessage(o)) continue;
      const text = raw.textOf(o);
      if (!text) continue;
      messages.push({ path: p, line, text, ts: o.timestamp ?? o.ts ?? null });
    }
  }

  messages.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? '') || a.path.localeCompare(b.path));
  return { messages, capturesReadable, capturesUnreadable, capped };
}

// --- Patterns: loaded from JSON, each proven against its own examples -

export const DEFAULT_PATTERNS_FILE = path.join(HERE, 'user-patterns.default.json');

function compilePattern(entry, index, sourceFile) {
  const where = `${sourceFile}[${index}]`;
  if (!entry || typeof entry !== 'object') throw new Error(`${where}: not an object`);
  const { name, regex, action } = entry;
  if (typeof name !== 'string' || !name.trim()) throw new Error(`${where}: missing 'name'`);
  if (typeof regex !== 'string' || !regex) throw new Error(`${where} (${name}): missing 'regex'`);
  if (typeof action !== 'string' || !action.trim()) {
    throw new Error(`${where} (${name}): missing 'action' (the line a session should take)`);
  }
  const examples = entry.examples ?? {};
  const positive = Array.isArray(examples.positive) ? examples.positive : [];
  const negative = Array.isArray(examples.negative) ? examples.negative : [];
  if (positive.length === 0) throw new Error(`${where} (${name}): needs at least one positive example`);
  if (negative.length === 0) throw new Error(`${where} (${name}): needs at least one negative example`);
  // 'g' would make the compiled RegExp stateful across calls
  // (lastIndex) — every use here is a one-shot .test(), so it is
  // stripped rather than trusted not to matter.
  const flags = (typeof entry.flags === 'string' ? entry.flags : 'i').replace(/g/g, '');
  let compiled;
  try { compiled = new RegExp(regex, flags); }
  catch (e) { throw new Error(`${where} (${name}): invalid regex: ${e.message}`); }
  return {
    name,
    title: typeof entry.title === 'string' && entry.title.trim() ? entry.title : name,
    regex: compiled,
    inverted: entry.inverted === true,
    action,
    examples: { positive, negative },
  };
}

/**
 * Where the pattern file for this root is — env wins, then
 * `.mem/config.json`'s `userHabitPatterns`, else `null` (the shipped
 * defaults). `null` is a real return value here, not "not found".
 */
export function resolvePatternsPath(root, { env = process.env } = {}) {
  if (env.CHEAP_MEM_USER_PATTERNS) return path.resolve(env.CHEAP_MEM_USER_PATTERNS);
  if (root) {
    try {
      const cfg = cfgmod.readConfig(root);
      if (typeof cfg.userHabitPatterns === 'string' && cfg.userHabitPatterns.trim()) {
        return path.resolve(root, cfg.userHabitPatterns);
      }
    } catch { /* no config yet — fall through to the shipped defaults */ }
  }
  return null;
}

/**
 * Load and compile the pattern file. Never silently falls back on a
 * broken CUSTOM file — a misconfigured override should say so loudly,
 * not quietly serve the defaults instead and look like it worked.
 */
export function loadPatterns(patternsPath = null) {
  const file = patternsPath ?? DEFAULT_PATTERNS_FILE;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    const err = new Error(`cannot read pattern file '${file}': ${e.message}`);
    err.code = 'PATTERNS_UNREADABLE';
    throw err;
  }
  let list;
  try { list = JSON.parse(text); }
  catch (e) {
    const err = new Error(`pattern file '${file}' is not valid JSON: ${e.message}`);
    err.code = 'PATTERNS_INVALID';
    throw err;
  }
  if (!Array.isArray(list) || list.length === 0) {
    const err = new Error(`pattern file '${file}' must be a non-empty JSON array`);
    err.code = 'PATTERNS_INVALID';
    throw err;
  }
  return list.map((entry, i) => compilePattern(entry, i, file));
}

/** Does `pattern` match `text`? Honors `inverted`. Used by `analyze()`
 *  and by `checkAllExamples()` — one rule, not two copies of it. */
export function matchesPattern(pattern, text) {
  const hit = pattern.regex.test(String(text ?? ''));
  return pattern.inverted ? !hit : hit;
}

/**
 * Every pattern against its OWN examples — the guarantee "each
 * pattern ships with a positive AND a negative example" as code that
 * actually runs, not only as a comment. `mem user --self-test` and
 * `test/userhabits.test.mjs` both call this.
 */
export function checkAllExamples(patterns) {
  const errors = [];
  for (const p of patterns) {
    for (const ex of p.examples.positive) {
      if (!matchesPattern(p, ex)) errors.push(`${p.name}: positive example did not match — '${ex.slice(0, 60)}'`);
    }
    for (const ex of p.examples.negative) {
      if (matchesPattern(p, ex)) errors.push(`${p.name}: negative example matched — '${ex.slice(0, 60)}'`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// --- Two metrics instead of a pattern: a distribution, not a yes/no ---

/** UTC-hour histogram (24 buckets, index = hour). */
export function hourDistribution(messages) {
  const hours = new Array(24).fill(0);
  for (const m of messages) {
    if (!m.ts) continue;
    const d = new Date(m.ts);
    if (Number.isNaN(d.getTime())) continue;
    hours[d.getUTCHours()] += 1;
  }
  return hours;
}

/**
 * The hours where something is really happening — not assumed
 * "office hours", measured off the histogram: at least half of the
 * strongest hour's count. Empty list on silence (no hit anywhere),
 * never a division by zero.
 */
export function mainHours(hours) {
  const max = Math.max(...hours);
  if (max <= 0) return [];
  const threshold = max / 2;
  const out = [];
  for (let h = 0; h < 24; h += 1) if (hours[h] >= threshold) out.push(h);
  return out;
}

/** Median character length. `null` with no messages. */
export function messageLengthMedian(messages) {
  const lengths = messages.map((m) => m.text.length).sort((a, b) => a - b);
  if (!lengths.length) return null;
  const mid = Math.floor(lengths.length / 2);
  return lengths.length % 2
    ? lengths[mid]
    : Math.round((lengths[mid - 1] + lengths[mid]) / 2);
}

// --- Stability: the share of weeks a pattern shows up in ---------------

function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThursday) / 86400000
    - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Share of QUALIFYING weeks (>= {@link MIN_MESSAGES_PER_WEEK} messages)
 * in which `matched` hit at least once.
 *
 * With only a few calendar weeks of capture history this is coarse
 * (0, 0.5, 1 with two qualifying weeks) — an honest limit of today's
 * data volume, not a calculation error. The caller states it as such.
 */
export function stabilityPerWeek(allMessages, matched) {
  const perWeek = new Map();
  for (const m of allMessages) {
    if (!m.ts) continue;
    const d = new Date(m.ts);
    if (Number.isNaN(d.getTime())) continue;
    const wk = isoWeek(d);
    if (!perWeek.has(wk)) perWeek.set(wk, { total: 0, hit: 0 });
    const e = perWeek.get(wk);
    e.total += 1;
    if (matched.has(m)) e.hit += 1;
  }
  const all = [...perWeek.values()];
  const qualifying = all.filter((e) => e.total >= MIN_MESSAGES_PER_WEEK);
  if (!qualifying.length) {
    return { stability: null, weeksQualifying: 0, weeksTotal: all.length };
  }
  const withHit = qualifying.filter((e) => e.hit > 0).length;
  return {
    stability: withHit / qualifying.length,
    weeksQualifying: qualifying.length,
    weeksTotal: all.length,
  };
}

// --- The measurement itself --------------------------------------------

export const STATE = Object.freeze({
  MEASURED: 'measured',
  TOO_LITTLE_EVIDENCE: 'too_little_evidence',
  UNKNOWN: 'unknown',
});

/**
 * Every observation — the loaded patterns plus the two metrics —
 * computed from the readable captures. No model, no network.
 *
 * `state: 'unknown'` applies to EVERY observation at once when NO
 * capture is readable ("empty source"), never the same thing as "0
 * hits among readable captures" (that is `too_little_evidence`, a
 * different statement).
 *
 * Every observation carries `actionable`: a pattern is always
 * actionable by construction (each one ships an action line); the
 * hour-of-day metric is not — "respond promptly in the busy hours" is
 * not something a SESSION decides, a session does not choose when it
 * is called. `sessionStartLines()` filters on this.
 */
export function analyze(root, {
  minEvidence = MIN_EVIDENCE_MEASURE, timeCapMs = TIME_CAP_MS, patternsPath = null,
} = {}) {
  const patterns = loadPatterns(patternsPath ?? resolvePatternsPath(root));
  const { messages, capturesReadable, capturesUnreadable, capped } = realMessages(root, { timeCapMs });
  const total = messages.length;

  if (capturesReadable === 0) {
    const observations = [
      ...patterns.map((p) => ({
        id: p.name, title: p.title, kind: 'pattern', state: STATE.UNKNOWN, actionable: true,
      })),
      { id: 'hour_of_day', title: 'UTC hour-of-day distribution', kind: 'metric', state: STATE.UNKNOWN, actionable: false },
      { id: 'message_length', title: 'Message length (median, characters)', kind: 'metric', state: STATE.UNKNOWN, actionable: true },
    ];
    return {
      total: 0, capturesReadable: 0, capturesUnreadable, capped, observations,
      reason: `${capturesUnreadable} capture(s) listed, none readable — archive not mounted?`,
    };
  }

  const observations = [];
  for (const p of patterns) {
    const matched = new Set();
    let first = null;
    let last = null;
    for (const m of messages) {
      if (!matchesPattern(p, m.text)) continue;
      matched.add(m);
      if (!first) first = m;
      last = m;
    }
    const count = matched.size;
    const { stability, weeksQualifying, weeksTotal } = stabilityPerWeek(messages, matched);
    observations.push({
      id: p.name, title: p.title, kind: 'pattern',
      state: count >= minEvidence ? STATE.MEASURED : STATE.TOO_LITTLE_EVIDENCE,
      count, total, share: total ? count / total : 0,
      first: location(first), last: location(last),
      stability, weeksQualifying, weeksTotal,
      action: p.action,
      actionable: true,
    });
  }

  const hours = hourDistribution(messages);
  const main = mainHours(hours);
  observations.push({
    id: 'hour_of_day', title: 'UTC hour-of-day distribution', kind: 'metric',
    state: total >= minEvidence ? STATE.MEASURED : STATE.TOO_LITTLE_EVIDENCE,
    count: total, total, histogram: hours, mainHours: main,
    first: location(messages[0]), last: location(messages[messages.length - 1]),
    stability: null, weeksQualifying: null, weeksTotal: null,
    // Not actionable, deliberately: see the module doc above.
    actionable: false,
    action: main.length
      ? `respond promptly in the main window(s) (${main.map((h) => `${h}h`).join(', ')} UTC), `
        + 'do not assume absence outside them'
      : 'no clear main window — do not use time of day as a signal',
  });

  const median = messageLengthMedian(messages);
  observations.push({
    id: 'message_length', title: 'Message length (median, characters)', kind: 'metric',
    state: total >= minEvidence ? STATE.MEASURED : STATE.TOO_LITTLE_EVIDENCE,
    count: total, total, median,
    first: location(messages[0]), last: location(messages[messages.length - 1]),
    stability: null, weeksQualifying: null, weeksTotal: null,
    actionable: true,
    action: `short messages (median ${median} characters) are normal — do not routinely `
      + 'ask for more context when the core question is already clear',
  });

  return { total, capturesReadable, capturesUnreadable, capped, observations };
}

// --- The optional SessionStart injection: at most 5 lines --------------

/**
 * At most `max` lines for a SessionStart hook to inject — only
 * patterns/metrics that are BOTH `state: 'measured'` (against the
 * higher {@link MIN_EVIDENCE_DISPLAY} threshold) AND `actionable`.
 * Empty capture source: empty lines, not a claim.
 *
 * cheap-mem's own SessionStart path is `install/hooks/session-start.sh`
 * (wired via `install/claude-code.sh`, see docs/mcp-setup.md). Calling
 * this from there needs exactly one added line —
 * `node "$CHEAP_MEM_ROOT/bin/mem" user --session-start` — which this
 * module does not add itself (that file belongs to a different part of
 * this change); `mem user --session-start` prints exactly what that
 * line would inject, so wiring it in is a one-line, reviewable change
 * whenever someone picks it up.
 */
export function sessionStartLines(root, {
  max = SESSION_START_MAX_LINES, minEvidence = MIN_EVIDENCE_DISPLAY,
  timeCapMs = TIME_CAP_MS, patternsPath = null,
} = {}) {
  const { total, capturesReadable, observations, capped } = analyze(root, {
    minEvidence, timeCapMs, patternsPath,
  });
  if (capturesReadable === 0) return { lines: [], sources: [] };

  const qualifying = observations
    .filter((o) => o.state === STATE.MEASURED && o.actionable)
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, max - 1));
  if (!qualifying.length) return { lines: [], sources: [] };

  const lines = [
    `User habits (measured over ${total} messages in ${capturesReadable} capture(s)`
    + `${capped ? ', time cap hit — incomplete' : ''}):`,
    ...qualifying.map((o) => `  - ${o.title} (${o.count}/${o.total}) -> ${o.action}`),
  ];

  // Same bookkeeping duty as everything else in this house that writes
  // into a session: what went out books its sources, so "something went
  // out" stays distinguishable from "what, exactly".
  const seen = new Set();
  const sources = [];
  for (const o of qualifying) {
    for (const f of [o.first, o.last]) {
      if (!f) continue;
      const key = `${f.path}:${f.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(key);
    }
  }
  return { lines, sources };
}
