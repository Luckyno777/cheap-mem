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
import * as goldlog from './goldlog.mjs';

/** Same shape as `goldlog.sessionFromPath` — kept local so this module
 *  has no hidden coupling beyond the two functions it actually reuses. */
export function sessionFromPath(p) {
  const m = /--([^/.]+)\.jsonl(?:\.gz)?$/.exec(String(p ?? ''));
  return m ? m[1] : null;
}

/** How many shared stems make two texts "the same topic" — never more
 *  than the candidate itself has stems to offer. */
export const MIN_OVERLAP = 2;
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
 */
export function sweep(root, { since = null, entries = null, messages = null, toleranceMs = 15000 } = {}) {
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
    const row = { ts: c.ts, session: c.session, reason: c.reason, stemCount: stems.size };
    const closes = closingEntry(stems, c.ts, allEntries);
    if (closes) closed.push({ ...row, entryId: closes.id, closedAt: closes.ts, overlap: closes.overlap.length });
    else open.push(row);
  }
  return { readable: true, reason: null, open, closed, unknown };
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
