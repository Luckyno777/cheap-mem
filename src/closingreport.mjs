// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/closingreport.mjs — X2b: the task-end occasion reports the open
// duties that concern the session.
//
// **The occasion (X2, 2026-09-30).** The integration contract listed
// `task-end` as partial: the Stop hook captured and persisted the
// session and checked the last answer, but nothing said, at the end, what
// was left open in the way of duties. This stage closes exactly that gap.
//
// **One count, no second one.** The duties come from
// `today.decisionsForHuman()` — the very function whose length is
// `today().counts.decisions` (the number on the session-start line and
// the dashboard's Today card), and which itself reads
// `memory.openDuties()`. This module only FILTERS: "concerns the session"
// means "written during this session and still open" (entry time from the
// session's start, taken from the transcript).
//
// **Report only, never block.** The answer is `{ systemMessage }`, never
// `decision: block`. Short (at most MAX_LINES lines, MAX_CHARS characters)
// and once per session per duty — a Stop hook fires at every end of a
// turn, and the same message three times is noise.
//
// **Better nothing than something false.** If the session's start cannot
// be determined, or the duties cannot be read, nothing is reported (no "0
// open" from a source that could not be read).

import fs from 'node:fs';
import path from 'node:path';
import * as today from './today.mjs';

/** At most this many lines and characters. */
export const MAX_LINES = 3;
export const MAX_CHARS = 400;
/** At most this many duties are named. */
export const NAMES_MAX = 3;
/** Only the beginning of the transcript is read — the first time stands there. */
export const READ_BYTES = 64 * 1024;
/** State per session (untracked, like the answer check's). */
export const STATE_DIR = path.join('.pipeline', 'closing-report');

/** The start of the session: the first timestamp in the transcript, or `null`. */
export function sessionStart(transcriptPath) {
  if (!transcriptPath) return null;
  let raw;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(READ_BYTES);
      const n = fs.readSync(fd, buf, 0, READ_BYTES, 0);
      raw = buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const t = Date.parse(JSON.parse(line).timestamp);
      if (Number.isFinite(t)) return t;
    } catch { /* a cut-off last line, or not JSON: next */ }
  }
  return null;
}

function statePath(root, session) {
  const safe = String(session || 'no-session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return path.join(root, STATE_DIR, `${safe}.json`);
}

function readState(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && Array.isArray(j.reported)) ? j : { reported: [] };
  } catch { return { reported: [] }; }
}

const short = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The open duties of this session: `{ readable, list }`. Only filtered
 * from the count of the day, never counted anew.
 */
export function dutiesOfSession(root, startMs) {
  const d = today.decisionsForHuman(root);
  if (!d.readable) return { readable: false, list: [] };
  const list = (d.list ?? []).filter((x) => {
    const t = Date.parse(x.since);
    return Number.isFinite(t) && t >= startMs;
  });
  return { readable: true, list };
}

/** The report text, capped. */
export function reportText(list) {
  const names = list.slice(0, NAMES_MAX).map((p) => `${p.id} ${short(p.title, 60)}`).join('; ');
  const rest = list.length - Math.min(list.length, NAMES_MAX);
  const head = `Open duties from this session (${list.length}): ${names}${rest > 0 ? ` (+${rest} more)` : ''}`;
  const lines = `${head}\nLook: mem duties`.split('\n').slice(0, MAX_LINES).join('\n');
  return lines.length > MAX_CHARS ? `${lines.slice(0, MAX_CHARS - 1)}…` : lines;
}

/**
 * The Stop report: `{ systemMessage }` or `null`. Never blocks.
 * `input` is the hook JSON (`session_id`, `transcript_path`).
 */
export function stopReport(root, input, { env = process.env } = {}) {
  if (!input || typeof input !== 'object') return null;
  if (env.MEM_CLOSING_REPORT === '0') return null;
  const start = sessionStart(input.transcript_path);
  if (start === null) return null;
  let p;
  try { p = dutiesOfSession(root, start); } catch { return null; }
  if (!p.readable || p.list.length === 0) return null;

  const sp = statePath(root, input.session_id);
  const state = readState(sp);
  const fresh = p.list.filter((x) => !state.reported.includes(x.id));
  if (fresh.length === 0) return null;
  state.reported.push(...fresh.map((x) => x.id));
  try {
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(state));
  } catch {
    // Without recorded state every Stop would repeat the same report.
    return null;
  }
  return { systemMessage: reportText(fresh) };
}
