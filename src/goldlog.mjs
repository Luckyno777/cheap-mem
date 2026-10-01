// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// goldlog.mjs — N9 parity ("gold nebenbei" / "Rate today"): a human's
// verdict on a REAL retrieval question, appended OUTSIDE this memory.
//
// **Why this exists alongside verifylog.mjs.** `src/verifylog.mjs`
// already carries the "N9 parity" label, but its own header says so
// out loud: it grades timeline-fact staleness/conflict, never an
// actual retrieval question — because cheap-mem, until this file, had
// no counterpart to the sibling's `mem-gold-ziehen.mjs` (drawing real
// questions out of the retrieval journal + raw captures). That gap is
// closed HERE, narrowly: this module draws candidates from
// `src/injection.mjs`'s journal, correlates them with a real question
// text via `src/userhabits.realMessages()` (the SAME privacy-checked
// source `mem habits` already uses — no second path to raw captures),
// and stores a verdict in its own file, same boundary as verifylog.mjs
// (`checkTargetOutsideRoot`, checked before any append).
//
// **Deliberately narrower than the sibling in one place.** lucky-mem's
// `bin/mem-gold-ziehen.mjs` classifies a THIRD outcome
// ("fehltreffer-verdacht": a hit whose score sat only barely above the
// threshold) — that needs a per-line numeric score, which this house's
// `src/injection.mjs` journal does not record (only the closed `REASON`
// enum). Faking a score would be inventing data; instead this module
// uses only the outcomes the journal already, honestly, records:
//   hit        reason === null (something WAS injected) and sources.length>0
//   near-miss  reason === REASON.TOO_WEAK (searched, found something, all below threshold)
//   no-hit     reason === REASON.EMPTY (searched, nothing in the index matched)
// three real, recorded outcomes — not the sibling's exact three, but
// the honest equivalent this house's own journal supports.
//
// **N18 parity: built in `src/gap.mjs`.** The sibling's N18 promotes a
// closed knowledge gap (R1, `src/luecken.mjs`) into a gold candidate
// automatically. `src/gap.mjs` is the smallest real equivalent this
// house's own retrieval journal supports (see its own header for why
// it needs `userhabits.realMessages()` where the sibling reads
// `worte_bekannt` straight off its journal) — it produces `kind: 'gap'`
// rows into the SAME file this module owns, via its own `draw()`, kept
// separate on purpose (own module, own tests, own privacy reasoning)
// rather than folded into this file's `draw()`.
//
// invariant: not-measured-is-not-zero
// invariant: append-only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendLine } from './append.mjs';
import * as injection from './injection.mjs';
import * as userhabits from './userhabits.mjs';
import * as raw from './raw.mjs';

/** 12 base36 characters — same shape as verifylog.newId(), own namespace. */
export function newId() {
  let out = '';
  while (out.length < 12) out += BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36);
  return out.slice(0, 12);
}

/** Whether a real question text may sit in this row, in THIS repo. */
export const SHARE = Object.freeze(['synthetic', 'yes', 'no']);
/** A person's verdict on a candidate. */
export const VERDICT = Object.freeze(['correct', 'wrong', 'empty-correct']);
/** Where a candidate came from. `'gap'` rows come from `src/gap.mjs` (N18). */
export const KIND = Object.freeze(['drawn', 'gap']);

export function defaultTarget() {
  return path.join(os.homedir(), '.cheap-mem-gold', 'retrieval-gold.jsonl');
}
export function targetPath(env = process.env) {
  return env.CHEAP_MEM_GOLD_FILE ? path.resolve(env.CHEAP_MEM_GOLD_FILE) : defaultTarget();
}

/** Same boundary as verifylog.checkTargetOutsideRoot — refuses a target
 *  under the memory root outright. */
export function checkTargetOutsideRoot(target, root) {
  const t = path.resolve(target);
  const r = path.resolve(root);
  if (t === r || t.startsWith(`${r}${path.sep}`)) {
    throw new Error(`the gold target (${t}) sits inside the memory root (${r}) — `
      + 'it must be outside, or this route would write a human judgement into the repository it is about.');
  }
}

/** Build a canonical row. Writes nothing — the caller appends. */
export function buildRow({
  ts = new Date().toISOString(), question = null, share = 'no', expected = [],
  occasion, source, kind = 'drawn', verdict = null, replacesId = undefined, note = null,
} = {}) {
  const row = {
    id: newId(), ts, question, share, expected: Array.isArray(expected) ? expected : [],
    occasion, source, kind, verdict, note,
  };
  if (replacesId !== undefined) row.replaces_id = replacesId;
  return row;
}

/** What a row must have to be usable — mirrors the sibling's
 *  `goldLib.pruefeZeile` in spirit, own vocabulary. */
export function checkRow(row) {
  const defects = [];
  if (!row || typeof row !== 'object') return ['row is not an object'];
  if (!row.id) defects.push('id is missing');
  if (!row.ts || Number.isNaN(Date.parse(row.ts))) defects.push('ts is not a valid timestamp');
  if (row.question !== null && (typeof row.question !== 'string' || !row.question.trim())) {
    defects.push('question must be null or a non-empty string');
  }
  if (!SHARE.includes(row.share)) defects.push(`share must be one of ${SHARE.join(', ')}`);
  if (!Array.isArray(row.expected) || !row.expected.every((x) => typeof x === 'string' && x)) {
    defects.push('expected must be an array of non-empty strings');
  }
  if (!KIND.includes(row.kind)) defects.push(`kind must be one of ${KIND.join(', ')}`);
  if (row.verdict !== null && !VERDICT.includes(row.verdict)) {
    defects.push(`verdict must be null or one of ${VERDICT.join(', ')}`);
  }
  if (row.verdict === 'empty-correct' && row.expected.length > 0) {
    defects.push('verdict empty-correct requires an empty expected array');
  }
  if (row.verdict === 'wrong' && row.expected.length === 0) {
    defects.push('verdict wrong needs at least one expected id (the false hit)');
  }
  // The one privacy rule that matters: an un-shared row never carries a
  // real question — same rule as the sibling's goldLib.pruefeZeile.
  if (row.share === 'no' && row.question !== null) {
    defects.push("share:'no' must not carry a question text");
  }
  return defects;
}

/** Every row at `target`, oldest first. Broken lines are counted, not
 *  skipped (the same rule that holds inside the memory itself). */
export function read(target) {
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); } catch { return { rows: [], broken: 0, present: false }; }
  const rows = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && e.id) rows.push(e); else broken += 1;
    } catch { broken += 1; }
  }
  return { rows, broken, present: true };
}

/** A correction (`replaces_id`) resolves out of the active view — same
 *  append-only-correction rule as everywhere else in this house. */
export function resolved(rows) {
  const byId = new Map();
  const order = [];
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') continue;
    if (!byId.has(r.id)) order.push(r.id);
    byId.set(r.id, r);
  }
  const replaced = new Set();
  for (const id of order) {
    const r = byId.get(id);
    if (r.replaces_id) replaced.add(r.replaces_id);
  }
  return order.filter((id) => !replaced.has(id)).map((id) => byId.get(id));
}

/** Append one row to `target`, after the outside-root + form checks. */
export function append(target, root, row) {
  checkTargetOutsideRoot(target, root);
  const defects = checkRow(row);
  if (defects.length) return { written: false, defects };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  appendLine(target, `${JSON.stringify(row)}\n`);
  return { written: true, row };
}

// =========================================================================
// Drawing candidates from the injection journal (the smallest real
// equivalent of the sibling's mem-gold-ziehen.mjs)
// =========================================================================

/** Session id from a capture path `raw/YYYY/MM/<time>--<session>.jsonl.gz`
 *  — same convention the sibling reads from its own capture names. */
export function sessionFromPath(p) {
  const m = /--([^/.]+)\.jsonl(?:\.gz)?$/.exec(String(p ?? ''));
  return m ? m[1] : null;
}

/** Which of the three honestly-recorded outcomes a journal line is —
 *  `null` if it is none of them (not a QUESTION occasion, or a reason
 *  this module does not draw from, e.g. no-signal/off/already-shown/
 *  rebuild — none of those say anything about retrieval QUALITY). */
export function outcomeOf(line) {
  if (!line || line.occasion !== injection.OCCASION.QUESTION) return null;
  if (line.reason === null) return Array.isArray(line.sources) && line.sources.length ? 'hit' : null;
  if (line.reason === injection.REASON.TOO_WEAK) return 'near-miss';
  if (line.reason === injection.REASON.EMPTY) return 'no-hit';
  return null; // no-signal / off / already-shown / rebuild: not a quality signal
}

/**
 * Does this capture message belong to the journal's session?
 *
 * The journal books the REAL session id; the capture file name carries a
 * hash of the transcript path (a different quantity). A capture stamped
 * with the fingerprint of the real id is compared on that; an older
 * capture without it falls back to the file-name comparison (which only
 * matches when a caller passed the same id as the stamp).
 */
export function sameSession(m, session) {
  if (m.sessionFingerprint) return m.sessionFingerprint === raw.sessionFingerprint(session);
  return sessionFromPath(m.path) === session;
}

/** Nearest real message to a journal line's `ts`, within the same
 *  session (by capture path), within `toleranceMs`. `messages` must be
 *  sorted by `ts` (as `userhabits.realMessages()` returns them). */
export function nearestMessage(messages, ts, session, { toleranceMs = 15000 } = {}) {
  const target = Date.parse(ts ?? '');
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const m of messages) {
    if (session && !sameSession(m, session)) continue;
    const t = Date.parse(m.ts ?? '');
    if (!Number.isFinite(t)) continue;
    const gap = Math.abs(t - target);
    if (gap > toleranceMs) continue;
    if (gap < bestGap) { bestGap = gap; best = m; }
  }
  return best;
}

/**
 * Candidates from GIVEN journal lines + messages — pure, DI-friendly
 * (tests hand in synthetic lines/messages, no real capture needed; same
 * trick as the sibling's `kandidatenAus`).
 */
export function candidatesFrom(lines, messages, { toleranceMs = 15000, limitPerOutcome = null } = {}) {
  const out = { hit: [], 'near-miss': [], 'no-hit': [] };
  for (const line of lines) {
    const outcome = outcomeOf(line);
    if (!outcome) continue;
    if (limitPerOutcome != null && out[outcome].length >= limitPerOutcome) continue;
    const session = line.session || null;
    const message = nearestMessage(messages, line.ts, session, { toleranceMs });
    out[outcome].push(buildRow({
      ts: line.ts,
      question: message ? message.text : null,
      share: 'no',
      expected: Array.isArray(line.sources) ? line.sources.map(String) : [],
      occasion: line.occasion,
      source: `raw-capture:${outcome}:${session ?? '?'}:${message ? `${message.path}:${message.line}` : 'no-match'}`,
      kind: 'drawn',
      verdict: null,
    }));
  }
  return out;
}

/**
 * Draw new candidates from `root`'s injection journal + real messages,
 * append the ones not already drawn (by `source`, idempotent across
 * repeated runs — same rule as the sibling's `schonGezogen`), never
 * inside `root`. Returns a report, never throws outward.
 */
export function draw(root, {
  env = process.env, toleranceMs = 15000, limitPerOutcome = null, dryRun = false,
} = {}) {
  const target = path.resolve(env.CHEAP_MEM_GOLD_FILE ? targetPath(env) : targetPath(env));
  checkTargetOutsideRoot(target, root);
  const j = injection.read(root);
  if (!j.present) return { readable: false, reason: 'no injection journal to draw from', drawn: 0, written: false };
  const already = new Set(read(target).rows.map((r) => r.source).filter(Boolean));
  const { messages } = userhabits.realMessages(root);
  const grouped = candidatesFrom(j.lines, messages, { toleranceMs, limitPerOutcome });
  const fresh = [];
  for (const outcome of Object.keys(grouped)) {
    for (const row of grouped[outcome]) {
      if (already.has(row.source)) continue;
      fresh.push(row);
    }
  }
  let written = false;
  if (!dryRun && fresh.length) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    appendLine(target, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`);
    written = true;
  }
  return {
    readable: true, reason: null, target, journalLines: j.lines.length,
    drawn: fresh.length, withQuestion: fresh.filter((r) => r.question !== null).length, written,
  };
}
