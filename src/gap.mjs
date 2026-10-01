// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * gap.mjs — N18 parity: a retrieval miss later answered by a new entry
 * is a closed knowledge gap.
 *
 * Ported from the sibling house's `src/luecken.mjs` (BAUPLAN-mem-admin_02.md
 * Block R, R1) — narrowed to the smallest real equivalent this house's
 * own retrieval journal supports. See `src/goldlog.mjs`'s header for
 * why N18 was deliberately left unbuilt until now: cheap-mem's
 * `src/injection.mjs` journal, unlike the sibling's `einblendung.mjs`
 * journal, records no content words at all (no `worte_bekannt`) — only
 * the closed `REASON` enum, byte counts and hit sources. A MISS row
 * (reason `too-weak`/`empty`) therefore carries no text this module
 * could tokenize on its own.
 *
 * **Where the words come from.** The same privacy-checked path
 * `src/goldlog.mjs` already uses for its own candidates:
 * `userhabits.realMessages()`, correlated to a journal line by
 * timestamp + capture-path session (same `nearestMessage` shape as
 * goldlog). The real text is read ONLY to compute a stem overlap —
 * never stored. A gap candidate carries `question: null`, exactly like
 * the sibling's gold-from-gap candidates never carry `frage`.
 *
 * **The tokenizer.** `src/search.mjs: tokenize()` — the SAME function
 * `search()` itself uses to build and query the index, so a candidate's
 * stems and an entry's stems are never compared across two different
 * tokenizations.
 *
 * **The threshold.** `MIN_OVERLAP = 2` stems shared, capped at the
 * candidate's own stem count for a short question — identical shape to
 * the sibling's `mindestUeberlapp` (a single shared stem is too easily
 * coincidental; a gap with only one known stem at all can never demand
 * more than that one).
 *
 * **What counts as "closed".** The EARLIEST entry written strictly
 * AFTER the miss, whose content fields (via `memory.hasContent`'s own
 * field boundary, MACHINE_FIELDS excluded) share at least the required
 * number of stems with the miss's question. No model, no semantic
 * judgement — pure token overlap, same as the sibling.
 *
 * **Honest 'not measurable'.** No injection journal at all -> the
 * whole sweep reports `readable: false`. A miss row whose session
 * cannot be correlated to any real message (capture unreadable/rotated
 * away) is counted separately as `unknown`, never silently dropped as
 * "not a gap" — the same "not-measured-is-not-zero" rule the rest of
 * this house follows.
 *
 * **Nothing is written to the memory.** This module only PRODUCES gold
 * candidates (`kind: 'gap'`) for `src/goldlog.mjs`'s external file — a
 * human confirms them exactly like any other gold candidate (`mem gold
 * rate`); nothing here ever counts until that happens.
 *
 * invariant: not-measured-is-not-zero
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendLine } from './append.mjs';
import * as injection from './injection.mjs';
import * as memory from './memory.mjs';
import * as search from './search.mjs';
import * as userhabits from './userhabits.mjs';
import * as raw from './raw.mjs';
import * as goldlog from './goldlog.mjs';

/** Same shape as `goldlog.sessionFromPath` — kept local so this module
 *  has no hidden coupling beyond the two functions it actually reuses. */
export function sessionFromPath(p) {
  const m = /--([^/.]+)\.jsonl(?:\.gz)?$/.exec(String(p ?? ''));
  return m ? m[1] : null;
}

/** How many shared stems make two texts "the same topic" — never more
 *  than the candidate itself has stems to offer. */
const MIN_OVERLAP = 2;
export function minOverlap(n) {
  return Math.max(1, Math.min(MIN_OVERLAP, n));
}

/** Text -> a Set of stems, via the SAME tokenizer `search()` indexes with. */
export function stemsOf(text) {
  return new Set(search.tokenize(String(text ?? '')));
}

/** Is this journal line a MISS worth tracking (a real question that
 *  found nothing usable)? `null`/other reasons say nothing about a gap
 *  — `too-weak` means something was there but weak, `empty` means the
 *  index had nothing matching at all; both are candidates. */
export function isMiss(line) {
  if (!line || line.occasion !== injection.OCCASION.QUESTION) return false;
  return line.reason === injection.REASON.TOO_WEAK || line.reason === injection.REASON.EMPTY;
}

/** MISS rows from GIVEN journal lines, oldest first, `since` optional. */
export function missCandidates(lines, { since = null } = {}) {
  const out = [];
  for (const line of lines) {
    if (!isMiss(line)) continue;
    if (!line.ts) continue;
    if (since && String(line.ts) < String(since)) continue;
    out.push({ ts: line.ts, session: line.session ?? null, reason: line.reason });
  }
  return out;
}

/** Nearest real message to `ts`, same session if known — reused shape
 *  from `goldlog.nearestMessage`, own copy so this module never has to
 *  import goldlog's private helpers (goldlog exports it, but a
 *  same-named local keeps each module's own contract explicit). */
export function nearestMessage(messages, ts, session, { toleranceMs = 15000 } = {}) {
  const target = Date.parse(ts ?? '');
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const m of messages) {
    if (session && !goldlog.sameSession(m, session)) continue;
    const t = Date.parse(m.ts ?? '');
    if (!Number.isFinite(t)) continue;
    const gap = Math.abs(t - target);
    if (gap > toleranceMs) continue;
    if (gap < bestGap) { bestGap = gap; best = m; }
  }
  return best;
}

/** The text an entry is judged on — every content (non-machine) field,
 *  string or array-of-strings, joined. */
function entryText(e) {
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    if (memory.MACHINE_FIELDS.has(k) || k.startsWith('_')) continue;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
  }
  return parts.join(' ');
}

/**
 * The earliest entry written strictly after `ts` whose content shares
 * enough stems with `stems` — or `null`. `entries` is a Map as
 * `memory.entriesById()` returns, built once and shared across
 * candidates by the caller.
 */
export function closingEntry(stems, ts, entries) {
  let best = null;
  for (const [id, e] of entries) {
    if (!e?.ts || String(e.ts) <= String(ts)) continue;
    const entryStems = stemsOf(entryText(e));
    const overlap = [...stems].filter((s) => entryStems.has(s));
    if (overlap.length < minOverlap(stems.size)) continue;
    if (!best || String(e.ts) < String(best.ts)) best = { id, ts: e.ts, overlap };
  }
  return best;
}

/**
 * The whole sweep: open/closed/unknown MISS candidates. `unknown` holds
 * candidates whose question text could not be recovered from any real
 * capture (nothing to tokenize on) — never folded into "open".
 *
 * Rows carry `capture`/`line` (where the question was found) and never
 * the question text or its stems.
 */
export function sweep(root, opts = {}) {
  const d = sweepDetailed(root, opts);
  if (!d.readable) return d;
  const bare = (row) => { const { _stems, _msg, ...rest } = row; return rest; };
  return { ...d, open: d.open.map(bare), closed: d.closed.map(bare) };
}

/** Same as {@link sweep}, but open/closed rows still carry `_stems` and `_msg` (in memory only). */
function sweepDetailed(root, { since = null, entries = null, messages = null, toleranceMs = 15000 } = {}) {
  const j = injection.read(root);
  if (!j.present) return { readable: false, reason: 'no injection journal — nothing to sweep', open: [], closed: [], unknown: [] };

  const cands = missCandidates(j.lines, { since });
  const realMsgs = messages ?? userhabits.realMessages(root).messages;
  const allEntries = entries ?? memory.entriesById(root);

  const open = [];
  const closed = [];
  const unknown = [];
  for (const c of cands) {
    const msg = nearestMessage(realMsgs, c.ts, c.session, { toleranceMs });
    if (!msg) { unknown.push({ ts: c.ts, session: c.session, reason: c.reason }); continue; }
    const stems = stemsOf(msg.text);
    if (!stems.size) { unknown.push({ ts: c.ts, session: c.session, reason: c.reason }); continue; }
    const row = {
      ts: c.ts, session: c.session, reason: c.reason, stemCount: stems.size,
      capture: msg.path ?? null, line: msg.line ?? null, _stems: stems, _msg: msg,
    };
    const closes = closingEntry(stems, c.ts, allEntries);
    if (closes) closed.push({ ...row, entryId: closes.id, closedAt: closes.ts, overlap: closes.overlap.length });
    else open.push(row);
  }
  return { readable: true, reason: null, open, closed, unknown };
}

// -- Open gaps (parity with the sibling's R1, `luecken.mjs` 2b19ffd6) ------

/**
 * A miss alone is not yet a finding. It becomes an OPEN gap only when
 * the session itself, AFTER the miss, either worked out the same topic
 * (>= {@link minOverlap} shared stems with its own later text) or called
 * its answer unproven. Otherwise a bare miss is noise — without this,
 * every `too-weak` journal line would be a task and the list as long as
 * the journal itself. Wording mirrors the house rule "what is not
 * evidenced is TBD".
 */
const UNPROVEN_MARKERS = Object.freeze([
  /\btbd\b/i,
  /\bnot (?:documented|recorded|established|evidenced)\b/i,
  /\bi (?:do not|don't) know\b/i,
]);

function syntheticLine(o) {
  // The harness talking to itself (hooks, subagent handbacks, side
  // chains) is not the session working the topic out.
  if (!o || typeof o !== 'object') return true;
  if (o.isMeta || o.isSidechain) return true;
  if (o.type === 'user' && !userhabits.isRealUserMessage(o)) return true;
  return false;
}

/**
 * Evidence for ONE miss row: `{ state: 'measured', workedOut, unproven,
 * overlap }`, or `{ state: 'unknown' }` when the capture cannot be read
 * (archive not mounted) — never folded into "no evidence". Reads only;
 * the text is tokenized, never kept or quoted.
 */
export function evidence(root, row, { read = raw.readCapture } = {}) {
  if (!row?.capture || !row._stems) return { state: 'unknown' };
  let lines;
  try { ({ lines } = read(root, row.capture)); } catch { return { state: 'unknown' }; }
  const limit = Date.parse(String(row.ts ?? ''));
  if (!Number.isFinite(limit)) return { state: 'unknown' };
  const parts = [];
  for (const o of lines) {
    if (syntheticLine(o)) continue;
    const t = Date.parse(o.timestamp ?? o.ts ?? '');
    // No provable time -> not counted: better a gap wrongly left out
    // than evidence invented from a line that may predate the question.
    if (!Number.isFinite(t) || t <= limit) continue;
    const text = raw.textOf(o);
    // The question itself (its journal line may be a moment older than
    // the captured message) is not the answer.
    if (text && !(o.type === 'user' && row._msg && text === row._msg.text)) parts.push(text);
  }
  const text = parts.join(' ');
  if (!text) return { state: 'measured', workedOut: false, unproven: false, overlap: 0 };
  const later = stemsOf(text);
  const overlap = [...row._stems].filter((st) => later.has(st)).length;
  return {
    state: 'measured',
    workedOut: overlap >= minOverlap(row._stems.size),
    unproven: UNPROVEN_MARKERS.some((re) => re.test(text)),
    overlap,
  };
}

/**
 * Open and closed gaps. `open` holds only misses with evidence (see
 * above); `noise` counts misses without any, `unknown` those whose text
 * or capture could not be read. Nothing is written.
 */
export function gaps(root, opts = {}) {
  const d = sweepDetailed(root, opts);
  if (!d.readable) return { readable: false, reason: d.reason, open: [], closed: [], noise: 0, unknown: 0 };
  const strip = (row) => { const { _stems, _msg, ...rest } = row; return rest; };
  const open = [];
  let noise = 0;
  let unknown = d.unknown.length;
  for (const row of d.open) {
    const ev = evidence(root, row, { read: opts.read ?? raw.readCapture });
    if (ev.state === 'unknown') { unknown += 1; continue; }
    if (!ev.workedOut && !ev.unproven) { noise += 1; continue; }
    open.push({ ...strip(row), evidence: [ev.workedOut ? 'worked-out' : null, ev.unproven ? 'marked-unproven' : null].filter(Boolean) });
  }
  return { readable: true, reason: null, open, closed: d.closed.map(strip), noise, unknown };
}

/**
 * ISO week key (`YYYY-Www`) of a timestamp; `null` for an unreadable
 * one instead of a guessed week.
 */
export function weekKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - weekday + 3); // the Thursday of that week
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((day - yearStart) / 86400000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Open/closed per calendar week, oldest first. `rate` is open / (open +
 * closed) of that week; `null` when the week saw no gap at all — "no
 * information" is not "rate 0".
 */
export function ratePerWeek({ open = [], closed = [] } = {}) {
  const weeks = new Map();
  const add = (list, field) => {
    for (const e of list) {
      const w = weekKey(e.ts);
      if (!w) continue;
      if (!weeks.has(w)) weeks.set(w, { week: w, open: 0, closed: 0 });
      weeks.get(w)[field] += 1;
    }
  };
  add(open, 'open');
  add(closed, 'closed');
  return [...weeks.values()]
    .map((r) => ({ ...r, rate: (r.open + r.closed) ? r.open / (r.open + r.closed) : null }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

/** Plain-text report for `mem gaps`. Never prints question text or stems. */
export function asText(g, { top = 20 } = {}) {
  if (!g.readable) return `not measurable: ${g.reason}`;
  const line = (e) => `  ${e.ts}  session ${e.session ?? '?'}  [${e.evidence?.join(',') ?? 'closed'}]`;
  const out = [`OPEN KNOWLEDGE GAPS: ${g.open.length}`];
  for (const e of g.open.slice(0, top)) out.push(line(e));
  if (g.open.length > top) out.push(`  ... and ${g.open.length - top} more`);
  out.push('');
  out.push(`CLOSED KNOWLEDGE GAPS: ${g.closed.length}`);
  for (const e of g.closed.slice(0, top)) out.push(`${line(e)} -> ${e.entryId} (${e.closedAt})`);
  if (g.closed.length > top) out.push(`  ... and ${g.closed.length - top} more`);
  out.push('');
  out.push(`Misses without a follow-up (noise): ${g.noise}; not measurable: ${g.unknown}`);
  return out.join('\n');
}

// -- N18: gap -> gold candidate --------------------------------------------

/** One `kind: 'gap'` candidate per CLOSED gap in `closed` (from {@link
 *  sweep}). `source` is unique per session+ts, so a closed gap already
 *  drawn (judged or not) is never proposed twice — same idempotency key
 *  shape as `goldlog.draw()`'s own `source` dedup. */
export function goldCandidatesFromClosed(closed) {
  return closed.map((g) => goldlog.buildRow({
    ts: g.ts,
    question: null,
    share: 'no',
    expected: [g.entryId],
    occasion: injection.OCCASION.QUESTION,
    source: `gap-closed:${g.session ?? '?'}:${g.ts}`,
    kind: 'gap',
    verdict: null,
  }));
}

/**
 * Sweep `root` and append the NEW closed-gap candidates (by `source`,
 * idempotent) to the gold file — the append-only equivalent of the
 * sibling's `goldKandidaten()` feeding `heute.mjs`. Never writes inside
 * `root` (same boundary as `goldlog.append`/`draw`). Returns a report,
 * never throws outward.
 */
export function draw(root, {
  env = process.env, since = null, dryRun = false, entries = null, messages = null, toleranceMs = 15000,
} = {}) {
  const target = goldlog.targetPath(env);
  goldlog.checkTargetOutsideRoot(target, root);
  const result = sweep(root, {
    since, entries, messages, toleranceMs,
  });
  if (!result.readable) return { readable: false, reason: result.reason, drawn: 0, written: false };

  const already = new Set(goldlog.read(target).rows.map((r) => r.source).filter(Boolean));
  const candidates = goldCandidatesFromClosed(result.closed).filter((r) => !already.has(r.source));

  let written = false;
  if (!dryRun && candidates.length) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    appendLine(target, `${candidates.map((r) => JSON.stringify(r)).join('\n')}\n`);
    written = true;
  }
  return {
    readable: true, reason: null, target, drawn: candidates.length, written,
    open: result.open.length, closed: result.closed.length, unknown: result.unknown.length,
  };
}
