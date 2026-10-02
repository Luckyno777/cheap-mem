// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * raw — lane 1 of the memory: capture everything, decide nothing.
 *
 * The Stop hook calls `capture()` after every session. It copies the
 * new part of the transcript, redacts it, gzips it, and stores it under
 * `raw/YYYY/MM/`. **No model is started.** Cost: nothing. Runtime:
 * about 50 ms.
 *
 * The judgement — what matters, what belongs in which drawer — happens
 * later, once, in `mem digest`. Storing is cheap; thinking is
 * expensive. So store immediately and think rarely.
 *
 * Incremental: a byte offset per transcript means the second capture
 * only takes what is new.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as redaction from './redaction.mjs';
import * as archive from './archive.mjs';
import { appendLine } from './append.mjs';
import { writeAtomic } from './atomicwrite.mjs';

/**
 * What a capture DROPS before it stores anything — and why the memory
 * would otherwise eat itself.
 *
 * **The finding (2026-09-08, reported from a Windows install.)** After
 * 75 minutes of use the git pack was at 9.17 MB; a single capture was
 * 8.6 MB gzipped. Extrapolated: about 6 MB/h, ~50 MB per working day,
 * and git deletes nothing. Within a quarter the memory repository stops
 * being clonable — which breaks the one promise the whole thing is
 * built on.
 *
 * **What is actually in there.** Measured over 21 real Claude Code
 * transcripts, 41.30 MB in total:
 *
 * | part            | size     | share |
 * |-----------------|----------|-------|
 * | `attachment`    | 21.34 MB | 51.7% |
 * | `thinking`      |  2.60 MB |  6.3% |
 * | `image`         |  1.91 MB |  4.6% |
 * | housekeeping    |  1.52 MB |  3.7% |
 *
 * So over half the volume is `attachment` lines, and inside those the
 * biggest single item is `task_reminder` — the task list, re-dumped on
 * nearly every turn. Then the skill listing, the hook output, the token
 * reminder. None of it is conversation. All of it is the harness
 * talking to itself, repeated verbatim dozens of times.
 *
 * For a memory that is worse than merely large: identical text repeated
 * hundreds of times dominates any term ranking, so the noise does not
 * just cost space, it costs RECALL.
 *
 * **The rule, and why this direction.** `attachment` lines are dropped
 * unless their subtype carries user or file content (`KEEP_ATTACHMENT`).
 * A subtype the harness invents tomorrow is therefore dropped by
 * default. That is the right default for a size problem and the wrong
 * one for a content problem — so it is not silent: every capture header
 * carries `__dropped` with a count per reason, and `mem doctor` can
 * read it. A gap you can see is a decision; a gap you cannot see is a
 * bug.
 *
 * `thinking` is deliberately NOT dropped. It is 6.3%, it is the only
 * record of WHY something was done, and that is precisely what a
 * digest is for.
 */
const DROP_LINE_TYPES = new Set([
  'queue-operation', 'atis-latch', 'mode', 'last-prompt',
]);

/** Attachment subtypes that carry real content rather than harness chatter. */
const KEEP_ATTACHMENT = new Set([
  'file', 'edited_text_file', 'compact_file_reference',
  'new_file', 'selected_lines', 'diagnostics', 'todo',
]);

/**
 * Base64 image payloads. 4.6% of the volume and worth exactly nothing
 * to a text digest — but the FACT that an image was there is worth
 * something, so a marker stays behind.
 */
function stripImages(o, elidedCounter) {
  const c = o?.message?.content;
  if (!Array.isArray(c)) return o;
  let sawImage = false;
  const stripped = c.map((part) => {
    if (part?.type !== 'image') return part;
    sawImage = true;
    const bytes = Buffer.byteLength(JSON.stringify(part));
    return { type: 'text', text: `[image elided by cheap-mem: ${bytes} bytes]` };
  });
  if (!sawImage) return o;
  elidedCounter.set('image', (elidedCounter.get('image') ?? 0) + 1);
  return { ...o, message: { ...o.message, content: stripped } };
}

/**
 * Should this transcript line be stored at all?
 *
 * Returns the reason for dropping it, or `null` to keep it.
 */
export function dropReason(o) {
  if (!o || typeof o !== 'object') return null;
  if (DROP_LINE_TYPES.has(o.type)) return `line:${o.type}`;
  if (o.type === 'attachment') {
    const sub = o?.attachment?.type ?? 'unknown';
    if (!KEEP_ATTACHMENT.has(sub)) return `attachment:${sub}`;
  }
  return null;
}

export const RAW_DIR = 'raw';
export const OFFSET_FILE = path.join('.mem', 'raw-offsets.json');
export const WATERMARK_FILE = path.join('.mem', 'raw-watermark.json');

/**
 * The digest ledger — the record of what has been digested, in the repo.
 *
 * **Why this exists.** The watermark lives under `.mem/`, which is
 * gitignored, so it does not travel and does not survive a rebuilt
 * container. Two real failures came out of that: `mem doctor` in a fresh
 * clone saw every checked-in capture as pending and reported a backlog
 * that did not exist, and a container rebuild would have re-digested
 * everything, paying for every model call twice.
 *
 * The ledger is append-only and TRACKED — one line per digest run. Since
 * the digest already commits after it writes, the record travels with the
 * memory itself, and any clone can answer "what is still open" honestly.
 *
 * The watermark stays as a fast local cache. `pending()` takes the UNION
 * of both, which is the safe direction by construction: the union can only
 * ever mark MORE captures as done, so this change can prevent double
 * digestion but never cause it.
 */
export const LEDGER_FILE = 'digested.jsonl';

/** Everything the ledger says has been digested. */
export function ledgerDigested(root) {
  const p = path.join(root, LEDGER_FILE);
  const done = new Set();
  if (!fs.existsSync(p)) return done;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    for (const c of rec.captures ?? []) done.add(c);
  }
  return done;
}

/** Append one run to the ledger. Append-only: never rewrite a line. */
function appendLedger(root, captures, extra = {}) {
  if (captures.length === 0) return;
  const p = path.join(root, LEDGER_FILE);
  const rec = { ts: isoSeconds(new Date()), captures: [...captures].sort(), ...extra };
  appendLine(p, `${JSON.stringify(rec)}\n`);
}
export const BELL_FILE = path.join('.mem', 'digest-bell.json');

/** Short, stable hash — for identification only, not for security. */
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) & 0xffffffff;
  return (h >>> 0).toString(36).padStart(7, '0');
}

/**
 * Fingerprint of the REAL session id (the one every transcript line
 * carries and the injection journal books). `session_id` in the stamp is
 * a hash of the transcript PATH, a different quantity, so the two never
 * matched and the journal-to-capture correlation ran into the void.
 * The raw id itself is never stored in a capture, only this fingerprint.
 */
export function sessionFingerprint(id) {
  return id ? shortHash(`session:${String(id)}`) : null;
}

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (o && typeof o === 'object') ? o : fallback;
  } catch { return fallback; }
}

function saveJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`, 'utf8');
}

/**
 * Remember the offset of ONE transcript (audit B#18).
 *
 * The offset file belongs to all transcripts together. Reading it at the
 * START of a capture and writing it back whole at the END erased the
 * offset a parallel capture of another transcript had stored in between,
 * and that transcript was captured again from the top (duplicates). Now:
 * re-read right before writing, set ONLY this key, replace atomically
 * (`writeAtomic`), so the window shrinks from the capture's duration to a
 * few milliseconds.
 */
function rememberOffset(root, key, entry) {
  const offsetPath = path.join(root, OFFSET_FILE);
  const all = loadJson(offsetPath, {});
  all[key] = entry;
  writeAtomic(offsetPath, `${JSON.stringify(all, null, 2)}\n`);
}

function isoSeconds(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The provenance stamp. Every digested entry later carries one and can
 * be traced back to the line in the raw material.
 *
 * **What does NOT belong here:** paths containing a login name, machine
 * names, anything identifying the person. The stamp says WHERE FROM,
 * not WHO.
 */
export function buildStamp({
  sessionId = null, transcript = null, surface = null,
  tsFrom = null, tsTo = null, project = null, realSessionId = null,
} = {}) {
  return {
    session_id: sessionId ?? (transcript ? shortHash(transcript) : 'unknown'),
    // Fingerprint of the real session id; null for captures made before
    // this field existed. Never the raw id.
    session_fingerprint: sessionFingerprint(realSessionId),
    surface: surface ?? detectSurface(),
    ts_from: tsFrom,
    ts_to: tsTo,
    project: project ?? null,
  };
}

/** Where is this session running? Rough, but enough for provenance. */
export function detectSurface() {
  if (process.env.MEM_SURFACE) return process.env.MEM_SURFACE;
  if (process.env.CLAUDE_CODE_REMOTE) return 'cloud';
  if (process.env.MEM_HEADLESS) return `headless:${process.env.MEM_HEADLESS}`;
  if (process.env.SSH_CONNECTION) return 'ssh';
  return 'local';
}

/** Storage path for a capture: raw/YYYY/MM/<time>--<session>.jsonl.gz */
export function capturePath(root, stamp, now = new Date()) {
  const d = new Date(now);
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const time = isoSeconds(d).replace(/[:.]/g, '-');
  return path.join(root, RAW_DIR, year, month,
    `${time}--${stamp.session_id}.jsonl.gz`);
}

// ---------------------------------------------------------------------
// Excluding a session from raw capture (ported from the sibling house,
// 2026-10-02). A personal or interview session can be kept out of the
// raw archive: the capture is UNREDACTED-by-meaning plain text (the
// redaction removes secrets, not private talk).
//
// **Why a row in the record and not only an environment switch.** A
// switch in the environment only works when it is set BEFORE the session
// starts; in a cloud session nobody controls the start. The session can
// run a command itself (`mem raw exclude`), and the Stop hook (another
// process, later) reads the row. The record is append-only, tracked and
// committed by the Stop hook, so the mark survives a container change.
// `MEM_RAW_EXCLUDE=1` stays as the extra way for local starts.
//
// The row carries ONLY the fingerprint of the session id
// (`sessionFingerprint`), never the raw id, and NO `path`: it is not a
// capture and must not appear in any capture count (every reader of the
// record skips rows without `path`).
//
// Fail-safe: if the record cannot be read, nothing is captured.
// ---------------------------------------------------------------------
const EXCLUDED_MARK = 'excluded';
const EXCLUSION_STATE_FILE = path.join('.mem', 'raw-exclusion-state.json');

/** Exclusion rows of the record; throws when the record is unreadable. */
function exclusionRows(root) {
  return archive.records(root).filter((o) => o?.record === EXCLUDED_MARK);
}

/** Is one of these (raw) session ids excluded from raw capture? */
function isExcluded(root, ids) {
  const prints = [...new Set((ids ?? []).filter(Boolean).map(sessionFingerprint))];
  if (!prints.length) return { excluded: false, fingerprint: null };
  const marks = exclusionRows(root).filter((o) => o.event === 'mark');
  const hit = prints.find((f) => marks.some((o) => o.fingerprint === f));
  return { excluded: Boolean(hit), fingerprint: hit ?? prints[0] };
}

/** Exclude a session. Idempotent: a second mark is not appended. */
export function exclude(root, id, { now = new Date(), reason = 'personal session' } = {}) {
  if (!id) return { status: 'broken', reason: 'no-session-id' };
  const fingerprint = sessionFingerprint(id);
  if (isExcluded(root, [id]).excluded) return { status: 'already', fingerprint };
  archive.writeRecord(root, {
    record: EXCLUDED_MARK, event: 'mark', fingerprint, at: isoSeconds(now), reason,
  });
  return { status: 'excluded', fingerprint };
}

/**
 * A skipped capture: one row once the growth reaches the size that would
 * have triggered a capture. The count stays honest (a gap with a name)
 * and the record does not grow on every Stop.
 */
function noteSkipped(root, fingerprint, size, minBytes, now, cause) {
  const statePath = path.join(root, EXCLUSION_STATE_FILE);
  const state = loadJson(statePath, {});
  const last = Number.isFinite(state[fingerprint]) ? state[fingerprint] : null;
  if (last !== null && size - last < minBytes) return false;
  archive.writeRecord(root, {
    record: EXCLUDED_MARK, event: 'skipped', fingerprint, at: isoSeconds(now), transcript_bytes: size, cause,
  });
  try { writeAtomic(statePath, `${JSON.stringify({ ...state, [fingerprint]: size }, null, 2)}\n`); }
  catch { /* next time again */ }
  return true;
}

/** Counts for `mem raw archive`: excluded sessions and skipped captures. */
export function exclusionSummary(root) {
  const rows = exclusionRows(root);
  return {
    sessions: new Set(rows.map((o) => o.fingerprint)).size,
    skipped: rows.filter((o) => o.event === 'skipped').length,
  };
}

/**
 * Capture a transcript — incremental, redacted, gzipped.
 *
 * Returns four states, never two:
 *   `{status:'excluded'}`  the session is excluded (`mem raw exclude`,
 *                          or MEM_RAW_EXCLUDE=1) — nothing read
 *   `{status:'nothing'}`   nothing new since the last capture
 *   `{status:'captured'}`  new material stored
 *   `{status:'broken'}`    transcript unreadable — a finding, not a no
 *
 * `minBytes` stops every assistant turn from creating a file: below the
 * threshold we wait for more.
 */
export function capture(root, transcriptPath, {
  minBytes = 4096,
  now = new Date(),
  stampExtra = {},
  // Escape hatch, and the reason it exists: a filter you cannot switch
  // off cannot be measured against itself. Every claim about how much
  // it saves comes from running the same transcript both ways.
  drop = true,
  // The raw session id from the hook JSON (optional); else the file name
  // (Claude Code names the transcript after the session).
  sessionId = null,
  env = process.env,
} = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { status: 'broken', reason: 'no-transcript', detail: String(transcriptPath) };
  }

  // Exclusion BEFORE everything else (the redaction too): what must not
  // be captured is not even read. Not checkable = not captured.
  const fileId = path.basename(String(transcriptPath)).replace(/\.jsonl$/, '');
  const byEnv = env?.MEM_RAW_EXCLUDE === '1';
  let excl;
  try { excl = isExcluded(root, [sessionId, fileId]); }
  catch (e) { return { status: 'broken', reason: 'exclusion-unreadable', detail: e.message }; }
  if (excl.excluded || byEnv) {
    let size = 0;
    try { size = fs.statSync(transcriptPath).size; } catch { /* 0 */ }
    try { noteSkipped(root, excl.fingerprint, size, minBytes, now, excl.excluded ? 'mark' : 'MEM_RAW_EXCLUDE'); }
    catch (e) { return { status: 'broken', reason: 'exclusion-note', detail: e.message }; }
    return { status: 'excluded', fingerprint: excl.fingerprint };
  }

  // Canary BEFORE anything else. If the redaction no longer does what
  // it claims, we do NOT capture — better a gap in the memory than a
  // secret in the version history.
  const health = redaction.selfTest();
  if (!health.ok) {
    return {
      status: 'broken',
      reason: 'redaction-failed',
      detail: health.failed.map((a) => `${a.type}:${a.reason}`).join(', '),
      failed: health.failed,
    };
  }

  const offsetPath = path.join(root, OFFSET_FILE);
  const allOffsets = loadJson(offsetPath, {});
  const key = shortHash(transcriptPath);
  const alreadyRead = allOffsets[key]?.bytes ?? 0;

  let size;
  try { size = fs.statSync(transcriptPath).size; }
  catch (e) { return { status: 'broken', reason: 'stat', detail: e.message }; }

  // A transcript that shrank was rotated or replaced. Reading from the
  // old offset would slice into the middle of a line; start over.
  const from = size < alreadyRead ? 0 : alreadyRead;

  const fresh = size - from;
  if (fresh < minBytes) {
    return { status: 'nothing', fresh, threshold: minBytes };
  }

  let chunk;
  let cleanBoundary = true;
  // How many bytes this capture really covers (see the half-line rule below).
  let used = fresh;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // Did the previous capture stop exactly on a line break? If so,
      // this chunk starts at a line start and nothing is sliced.
      //
      // Getting this wrong is not a cosmetic bug: blindly dropping the
      // first line loses one whole line on EVERY capture whose boundary
      // was clean — and when the new chunk is a single line, it loses
      // all of it and reports 'nothing'.
      if (from > 0) {
        const probe = Buffer.alloc(1);
        fs.readSync(fd, probe, 0, 1, from - 1);
        cleanBoundary = probe.toString('utf8') === '\n';
      }
      const buf = Buffer.alloc(fresh);
      fs.readSync(fd, buf, 0, fresh, from);
      // Audit B#19: if the LAST line of the increment is still half
      // written it does not belong in this capture; it comes with the
      // next one, whole. Before, the offset jumped to `size`, the half
      // ended up as `__unparsable` and the rest was thrown away next time
      // as a "slice" of the previous line.
      const lastBreak = buf.lastIndexOf(0x0a);
      const lastLine = buf.subarray(lastBreak + 1).toString('utf8');
      if (lastLine.trim() !== '') {
        let whole = true;
        try { JSON.parse(lastLine); } catch { whole = false; }
        if (!whole) used = lastBreak + 1;
      }
      chunk = buf.subarray(0, used).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { status: 'broken', reason: 'read', detail: e.message };
  }

  if (used === 0) {
    // Only half a line is there: capture nothing, leave the offset alone.
    return { status: 'nothing', fresh, threshold: minBytes, reason: 'half-line' };
  }
  const toByte = from + used;

  // Drop the first line only if it really is a slice of the previous
  // one. On the very first capture (offset 0) and after a clean line
  // break there is nothing to drop.
  const lines = chunk.split('\n');
  if (from > 0 && !cleanBoundary && lines.length > 0) lines.shift();

  const captured = [];
  const allFound = new Map();
  const dropped = new Map();
  let droppedBytes = 0;
  let tsFrom = null;
  let tsTo = null;
  // The real session id, straight from the transcript: every line carries
  // it. First one wins; all lines of a capture belong to one session.
  let realSessionId = null;

  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); }
    catch { o = { __unparsable: true, raw: l.slice(0, 2000) }; }
    if (!realSessionId && typeof o.sessionId === 'string' && o.sessionId) realSessionId = o.sessionId;

    // Drop BEFORE redacting: redaction is the expensive part, and a
    // task_reminder that is thrown away should not be paid for.
    const weg = drop ? dropReason(o) : null;
    if (weg) {
      dropped.set(weg, (dropped.get(weg) ?? 0) + 1);
      droppedBytes += Buffer.byteLength(l);
      continue;
    }

    // The timestamp is read from the ORIGINAL line, before image
    // stripping rebuilds the object — a rebuilt object is a copy, and
    // reading a field off the copy would work today and break the day
    // someone moves the field.
    const ts = o.timestamp ?? o.ts ?? null;
    if (ts) {
      if (!tsFrom || ts < tsFrom) tsFrom = ts;
      if (!tsTo || ts > tsTo) tsTo = ts;
    }

    const { object, found } = redaction.redactEntry(drop ? stripImages(o, dropped) : o);
    for (const f of found) allFound.set(f.type, (allFound.get(f.type) ?? 0) + f.count);

    captured.push(object);
  }

  if (captured.length === 0) {
    rememberOffset(root, key, { bytes: toByte, path: transcriptPath });
    return { status: 'nothing', reason: 'blank-lines-only' };
  }

  const stamp = buildStamp({ transcript: transcriptPath, tsFrom, tsTo, realSessionId, ...stampExtra });

  // Header line: the provenance stamp itself, so the file can stand
  // on its own.
  const header = {
    __stamp: stamp,
    __captured_at: isoSeconds(now),
    __lines: captured.length,
    __offset_from: from,
    __offset_to: toByte,
    __redacted: [...allFound].map(([type, count]) => ({ type, count })),
    // Never silent: what was left out, why, and how much it weighed.
    __dropped: [...dropped].map(([reason, count]) => ({ reason, count })),
    __dropped_bytes: droppedBytes,
  };

  const body = [header, ...captured].map((o) => JSON.stringify(o)).join('\n') + '\n';
  // The name has second resolution, so two captures of the same session
  // inside one second land on the same path — and the second one used
  // to overwrite the first, silently losing everything it held. The
  // Stop hook can fire twice that fast.
  const store = archive.readConfig(process.env, root);
  let relPath = path.relative(root, capturePath(root, stamp, now));
  for (let n = 2; archive.reachable(store, root, relPath) && n < 1000; n += 1) {
    relPath = path.relative(root, capturePath(root, stamp, now))
      .replace(/\.jsonl\.gz$/, `-${n}.jsonl.gz`);
  }

  const packed = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });

  // **No silent fallback into the repository.** If the archive is not
  // writable (NAS off, drive not mounted), "then back to raw/" would be
  // the comfortable path — and would undo the whole exercise while
  // looking exactly like before. So the capture fails and says why, and
  // the offset is NOT advanced, so the same stretch is still there on
  // the next attempt.
  let stored;
  try {
    stored = archive.put(store, relPath, packed);
  } catch (e) {
    return {
      status: 'broken',
      reason: 'archive-not-writable',
      detail: `${store.location}: ${e.message}`,
      hint: store.explicit
        ? 'CHEAP_MEM_ARCHIVE points there. Is the target mounted?'
        : 'The default is the tracked raw/ inside the repository.',
    };
  }

  // The record is what stays in the repository: one line instead of a
  // megabyte. Written AFTER the file is safely down — a record pointing
  // at nothing would be worse than no record.
  archive.writeRecord(root, {
    stamp,
    path: relPath,
    captured_at: header.__captured_at,
    ts_from: tsFrom,
    ts_to: tsTo,
    lines: captured.length,
    source_bytes: used,
    ...stored,
    redacted: header.__redacted,
    dropped: header.__dropped,
    dropped_bytes: droppedBytes,
  });

  rememberOffset(root, key, { bytes: toByte, path: transcriptPath, last: header.__captured_at });

  // Ring the bell. Only NOW, once the file is safely on disk — a bell
  // without material would mean a digest run over nothing.
  const bell = ring(root, now);

  return {
    status: 'captured',
    path: relPath,
    archive: stored.location,
    sha256: stored.sha256,
    lines: captured.length,
    bytes: used,
    redacted: header.__redacted,
    dropped: header.__dropped,
    droppedBytes,
    stamp,
    bell,
  };
}

/**
 * A snippet around the hit.
 *
 * A capture is raw text; the preview should show WHERE the match sits,
 * not the first 400 characters of the session. We re-read the capture
 * (about a millisecond) rather than keep the full text in the index —
 * otherwise the index would not stay small.
 */
export function snippet(root, relPath, terms, { width = 260, accept = null } = {}) {
  let lines;
  try { ({ lines } = readCapture(root, relPath)); }
  catch { return ''; }

  const words = (Array.isArray(terms) ? terms : String(terms).split(/\s+/))
    .map((b) => String(b).toLowerCase())
    .filter((b) => b.length >= 3);

  for (const l of lines) {
    // `accept`: a role filter from the caller (see userhabits.userSnippet).
    // Without it every line counts, assistant and tool lines included.
    if (accept && !accept(l)) continue;
    const text = textOf(l);
    if (!text) continue;
    const low = text.toLowerCase();
    for (const w of words) {
      const i = low.indexOf(w);
      if (i < 0) continue;
      const from = Math.max(0, i - Math.floor(width / 3));
      const to = Math.min(text.length, from + width);
      return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ')
        + (to < text.length ? '…' : '');
    }
  }
  return '';
}

/** Readable text out of a transcript line, whatever the shape. */
export function textOf(l) {
  if (!l || typeof l !== 'object') return '';
  const content = l.message?.content ?? l.content ?? l.text ?? null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const piece of content) {
    if (typeof piece === 'string') { parts.push(piece); continue; }
    if (piece && piece.type === 'text' && typeof piece.text === 'string') {
      parts.push(piece.text);
    }
  }
  return parts.join(' ');
}

export function listCaptures(root, { withDeleted = false } = {}) {
  // Two sources, in this order: the record in the repository (the truth
  // about what EXISTS) and the old directory (anything not migrated
  // yet). Merged, no duplicates.
  //
  // Why the record comes first: after the move no capture lives in the
  // repository, and a listing that only looks at the filesystem would
  // be empty from then on — the search would report "nothing found" and
  // hide a broken wiring. That is the most expensive failure this
  // project knows.
  // A deleted capture stays in the register as a tombstone, and every
  // existing caller of this function — the index, `pending`, the
  // digest — means "captures there are still bytes for". Handing them
  // a deleted path makes each of them fail at the file read, and two
  // of them fail SILENTLY. So deleted ones are out by default, and the
  // review asks for them by name.
  const gone = withDeleted ? new Map() : archive.deletions(root);
  const out = [];
  const seen = new Set();
  for (const rec of archive.records(root)) {
    if (!rec?.path || seen.has(rec.path)) continue;
    if (rec.record === archive.DELETED_MARK) continue;
    seen.add(rec.path);
    if (gone.has(rec.path)) continue;
    out.push(rec.path);
  }

  const base = path.join(root, RAW_DIR);
  if (!fs.existsSync(base)) return out.sort();
  // A broken symlink (or an entry that vanishes between readdir and stat)
  // is NOT a directory and does not abort the whole listing (audit B#17).
  const isDir = (w) => { try { return fs.statSync(w).isDirectory(); } catch { return false; } };
  for (const year of fs.readdirSync(base).sort()) {
    const yp = path.join(base, year);
    if (!isDir(yp)) continue;
    for (const month of fs.readdirSync(yp).sort()) {
      const mp = path.join(yp, month);
      if (!isDir(mp)) continue;
      for (const file of fs.readdirSync(mp).sort()) {
        if (!file.endsWith('.jsonl.gz')) continue;
        const p = path.join(RAW_DIR, year, month, file);
        if (seen.has(p)) continue;
        seen.add(p);
        if (gone.has(p)) continue;
        out.push(p);
      }
    }
  }
  return out.sort();
}

/**
 * Every capture with its state — the review, not the work list.
 *
 * Four states (`CAPTURE_STATES`), and `unreachable` is the one worth
 * building for:
 *
 *   present      the register knows it and the bytes are there
 *   deleted      somebody removed it, and the tombstone says who and why
 *   unreachable  the register knows it, it belongs to THIS machine's
 *                store, the bytes are NOT there, and nobody said so.
 *                A defect, not a decision — collapsing it into
 *                "deleted" would hide a broken archive path behind a
 *                tidy word.
 *   elsewhere    the record points into ANOTHER machine's store. Not an
 *                error; just not readable from here.
 *
 * `project` comes from the capture's own stamp and is `null` when the
 * session never named one — which is most of them. `null` is not
 * "global": it means nobody wrote it down.
 */
/**
 * Every state a capture can be in — the list, in one place.
 *
 * Anything that counts or renders states reads it from here. Typing the
 * list out a second time is how a newly added state disappears from a
 * tile without anybody noticing.
 */
export const CAPTURE_STATES = Object.freeze(['present', 'deleted', 'unreachable', 'elsewhere']);

export function capturesWithState(root) {
  const store = archive.readConfig(process.env, root);
  const gone = archive.deletions(root);
  const byPath = new Map();
  for (const rec of archive.records(root)) {
    if (!rec?.path || rec.record === archive.DELETED_MARK) continue;
    if (!byPath.has(rec.path)) byPath.set(rec.path, rec);
  }
  // Anything on disk the register never heard of still belongs in the
  // review: an orphan file is exactly what a review is for.
  for (const p of listCaptures(root, { withDeleted: true })) {
    if (!byPath.has(p)) byPath.set(p, { path: p });
  }

  const out = [];
  for (const [p, rec] of byPath) {
    const tomb = gone.get(p) ?? null;
    const there = archive.reachable(store, root, p);
    // FOUR states, not three. A capture whose recorded location points
    // into ANOTHER machine's store is not a defect — its bytes are
    // missing here entirely correctly. The sibling house measured 15 of
    // 1238 captures in exactly that position on 2026-09-17; calling
    // them `unreachable` would have made the listing a standing alarm.
    const here = archive.locationState(root, rec, store).here;
    out.push({
      path: p,
      state: tomb ? 'deleted' : (there ? 'present' : (here ? 'unreachable' : 'elsewhere')),
      at: rec.captured_at ?? rec.ts_to ?? null,
      project: rec.stamp?.project ?? null,
      surface: rec.stamp?.surface ?? null,
      session: rec.stamp?.session_id ?? null,
      lines: typeof rec.lines === 'number' ? rec.lines : null,
      bytes: typeof rec.stored_bytes === 'number' ? rec.stored_bytes
        : (typeof rec.source_bytes === 'number' ? rec.source_bytes : null),
      inRegister: Boolean(rec.captured_at || rec.stamp || rec.lines),
      deleted: tomb,
    });
  }
  out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))
    || a.path.localeCompare(b.path));
  return out;
}

/** Read one capture (decompressed). Returns `{header, lines}`. */
export function readCapture(root, relPath) {
  const store = archive.readConfig(process.env, root);
  const data = archive.get(store, root, relPath);
  if (data === null) {
    // **Unreachable is not the same as empty.** A capture listed in the
    // record but missing from the archive (NAS off, drive not mounted)
    // must arrive as an error. Returning `{header: null, lines: []}`
    // here would let the search read it as "nothing in it" — and an
    // unreachable archive would look exactly like an empty memory.
    const e = new Error(`capture unreachable: ${relPath} (archive: ${store.location})`);
    e.code = 'ARCHIVE_UNREACHABLE';
    e.relPath = relPath;
    e.location = store.location;
    throw e;
  }
  const text = zlib.gunzipSync(data).toString('utf8');
  const lines = [];
  let header = null;
  // Broken lines are COUNTED, never skipped silently (B21, 2026-09-30):
  // a capture with one shot-up line used to look exactly like an intact
  // one — the digest read the rest and reported nothing. Three states:
  // 'ok' (no broken line), 'partial' (broken AND readable lines),
  // 'broken' (lines present, not one readable). Callers that only take
  // `{header, lines}` are unaffected; whoever wants to know reads
  // `state` / `broken`.
  let broken = 0;
  let readable = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch { broken += 1; continue; }
    readable += 1;
    if (o.__stamp && header === null) { header = o; continue; }
    lines.push(o);
  }
  const state = broken === 0 ? 'ok' : (readable > 0 ? 'partial' : 'broken');
  return { header, lines, broken, state };
}

/**
 * What the digest has not processed yet.
 * Returns the list of pending capture files plus their total size.
 */
export function pending(root) {
  const wm = loadJson(path.join(root, WATERMARK_FILE), { digested: [] });
  // Union of the tracked ledger and the local cache. Strictly additive, so
  // a clone that has only the ledger, and a machine that has only the
  // watermark, both answer correctly.
  const done = new Set([...(wm.digested ?? []), ...ledgerDigested(root)]);
  const open = listCaptures(root).filter((f) => !done.has(f));

  // Sizes come from the RECORD, not from the disk.
  //
  // This is where the archive earns its keep: the amount of open work
  // decides whether the digest runs, and that number has to be right
  // even while the NAS is off. `statSync` against an unreachable
  // archive returns nothing, which reads as "nothing to do" — a digest
  // that never fires again because a drive was unmounted is a silent
  // failure of the most expensive kind.
  const fromRecord = new Map();
  // B19 (2026-09-30): `bytes` are GZIPPED bytes. A capture with 50 MiB
  // of plain text weighs 50 KiB gzipped — as a budget for "how much can
  // one session read" it counted like a 50 KiB capture. The record also
  // knows `source_bytes` (the amount before packing); `rawSizes` comes
  // from that and is what the digest uses for its selection. Where it is
  // missing it is `null` — not measurable is not zero, and not the gzip
  // number as a stand-in.
  const rawFromRecord = new Map();
  for (const rec of archive.records(root)) {
    if (rec?.path && typeof rec.bytes === 'number') fromRecord.set(rec.path, rec.bytes);
    if (rec?.path && typeof rec.source_bytes === 'number') rawFromRecord.set(rec.path, rec.source_bytes);
  }
  let bytes = 0;
  const sizes = {};
  const rawSizes = {};
  let rawBytes = 0;
  let rawUnknown = 0;
  for (const f of open) {
    let gz = null;
    if (fromRecord.has(f)) gz = fromRecord.get(f);
    // Not migrated yet: then from the disk.
    else { try { gz = fs.statSync(path.join(root, f)).size; } catch { gz = null; /* gone */ } }
    sizes[f] = gz;
    if (gz !== null) bytes += gz;
    const rs = rawFromRecord.has(f) ? rawFromRecord.get(f) : null;
    rawSizes[f] = rs;
    if (rs !== null) rawBytes += rs; else rawUnknown += 1;
  }
  return { open, bytes, sizes, rawSizes, rawBytes, rawUnknown, done: done.size, last: wm.last ?? null };
}

/**
 * Mark captures as digested. Union, never replacement.
 *
 * B16 (2026-09-30, decision E6a): every path MUST exist (archive or
 * working tree). Before, a typo was accepted, written to the ledger and
 * the bell was cleared — real material stayed behind and nothing said
 * so. An unknown path throws `CAPTURE_MISSING` BEFORE anything is
 * written. And every marked capture carries its yield (entries naming
 * it) in the ledger — 0 allowed, but visible.
 *
 * B17: the bell is reset only when NOTHING is left open afterwards. If a
 * rest remains, the bell stays — otherwise the rest had no bell and
 * never became due.
 */
export function markDigestedWithYield(root, paths, { yield: yieldMap } = {}) {
  const store = archive.readConfig(process.env, root);
  const missing = paths.filter((f) => !archive.reachable(store, root, f));
  if (missing.length > 0) {
    const e = new Error(`capture does not exist: ${missing.join(', ')} — nothing marked`);
    e.code = 'CAPTURE_MISSING';
    e.missing = missing;
    throw e;
  }
  // The CALLER counts the yield (`mem raw digested` reads the logs; this
  // module deliberately does not import memory.mjs — the capture path
  // stays free of it, see test/entry-size-cap.test.mjs). If none is
  // passed it is UNKNOWN (null in the ledger), never 0. If one is passed
  // it must be a number >= 0 for every capture.
  const yields = {};
  for (const f of paths) {
    if (yieldMap === undefined) { yields[f] = null; continue; }
    if (!Number.isInteger(yieldMap[f]) || yieldMap[f] < 0) {
      const e = new Error(`yield for ${f} is missing or not a number >= 0 — nothing marked`);
      e.code = 'YIELD_MISSING';
      throw e;
    }
    yields[f] = yieldMap[f];
  }

  const p = path.join(root, WATERMARK_FILE);
  const wm = loadJson(p, { digested: [] });
  const before = new Set(wm.digested ?? []);

  // Migration, once: a memory that digested before the ledger existed has
  // its whole history only in the untracked watermark. Carry it over on the
  // first run so the record is complete rather than starting from today —
  // otherwise every capture from before this change would look pending in
  // any fresh clone, which is exactly the bug the ledger removes.
  if (!fs.existsSync(path.join(root, LEDGER_FILE)) && before.size > 0) {
    appendLedger(root, [...before], { note: 'seeded from the local watermark' });
  }

  const added = paths.filter((f) => !before.has(f));
  const yieldAdded = {};
  for (const f of added) yieldAdded[f] = yields[f];
  appendLedger(root, added, {
    entries: added.reduce((a, f) => a + (yields[f] ?? 0), 0),
    yield: yieldAdded,
  });

  wm.digested = [...new Set([...before, ...paths])].sort();
  wm.last = isoSeconds(new Date());
  saveJson(p, wm);
  // Pile cleared -> reset the bell. A rest keeps it (B17).
  let rest = 0;
  try { rest = pending(root).open.length; } catch { rest = 0; }
  if (rest === 0) clearBell(root);
  return {
    total: wm.digested.length,
    yield: yields,
    entries: paths.reduce((a, f) => a + (yields[f] ?? 0), 0),
    withoutEntry: paths.filter((f) => yields[f] === 0),
    unknown: paths.filter((f) => yields[f] === null),
    rest,
  };
}

/** Like {@link markDigestedWithYield}, returns only the total. */
export function markDigested(root, paths, opt = {}) {
  return markDigestedWithYield(root, paths, opt).total;
}

// --- The bell --------------------------------------------------------
//
// The digest does not run by the clock, it runs by the pile. Every
// successful capture rings; whether it is due follows from volume,
// quiet and a ceiling. **Without a bell nothing ever happens** — during
// a week away, not one model call fires.

/** Ring. Remembers the first and last bell since the last digest. */
export function ring(root, now = new Date()) {
  const p = path.join(root, BELL_FILE);
  const b = loadJson(p, {});
  const t = isoSeconds(now);
  const next = { first: b.first ?? t, last: t, count: (b.count ?? 0) + 1 };
  saveJson(p, next);
  return next;
}

/** Read the bell. `null` if nothing rang since the last digest. */
export function bellState(root) {
  const b = loadJson(path.join(root, BELL_FILE), null);
  return (b && b.last) ? b : null;
}

function clearBell(root) {
  const p = path.join(root, BELL_FILE);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* fine */ }
}

/** Defaults. Generous on purpose — every digest call has fixed costs
 *  (role text, tools, rules) regardless of how much material is
 *  waiting. Running more often means more fixed cost for the same
 *  volume; it buys freshness and thoroughness, not savings. */
export const DUE_DEFAULTS = Object.freeze({
  volumeNow: 500 * 1024,   // from here on, immediately — however fresh the bell
  volumeMin:  32 * 1024,   // below this a call is not worth it
  quietMs:    45 * 60 * 1000,
  ceilingMs:   8 * 60 * 60 * 1000,
});

/**
 * Is the digest due?
 *
 * Three states, never two:
 *   `{due:false, reason:'no-bell'}`            nothing happened, do nothing
 *   `{due:false, reason:'too-little'|'waiting'}` material there, not ripe
 *   `{due:true,  reason:'volume'|'quiet'|'ceiling'}`
 *
 * Takes `now` and the thresholds as arguments so it can be tested
 * without waiting and without a clock.
 */
export function due(root, { now = new Date(), thresholds = {} } = {}) {
  const s = { ...DUE_DEFAULTS, ...thresholds };
  const state = pending(root);

  if (state.open.length === 0) {
    return { due: false, reason: 'no-material', bytes: 0 };
  }

  const bell = bellState(root);
  if (!bell) {
    // Material without a bell can happen after a crash. We treat it as
    // due-by-volume so nothing is stranded — but report it, because it
    // is a finding.
    if (state.bytes >= s.volumeNow) {
      return { due: true, reason: 'volume-without-bell', bytes: state.bytes,
        captures: state.open.length };
    }
    return { due: false, reason: 'no-bell', bytes: state.bytes,
      captures: state.open.length };
  }

  const t = new Date(now).getTime();
  const quiet = t - Date.parse(bell.last);
  const waiting = t - Date.parse(bell.first);
  const common = {
    bytes: state.bytes,
    captures: state.open.length,
    quietMin: Math.round(quiet / 60000),
    waitingMin: Math.round(waiting / 60000),
    rings: bell.count ?? 0,
  };

  // 1. The pile is big enough — now, however fresh the bell. An
  //    oversized pile gets skimmed instead of read.
  if (state.bytes >= s.volumeNow) return { due: true, reason: 'volume', ...common };

  // 2. Ceiling: a long working day must not postpone digesting forever.
  //    Deliberately BEFORE the volume floor (B18, 2026-09-30; lm has had
  //    this since 2026-08-31, src/roh.mjs faelligkeit()). With
  //    'too-little' up here a pile under volumeMin was NEVER due, not
  //    even after a month: once the material stopped growing it lay
  //    there without limit. A capture only exists from a minimum size
  //    (minBytes), so a starvation pile cannot occur, and the ceiling
  //    fires at most once per bell cycle — the cost is capped by
  //    ceilingMs, not by the volume.
  if (waiting >= s.ceilingMs) return { due: true, reason: 'ceiling', ...common };

  if (state.bytes < s.volumeMin) return { due: false, reason: 'too-little', ...common };

  // 3. The burst is over — quiet since the LAST bell, not the first.
  //    Otherwise the digest fires in the middle of the working day.
  if (quiet >= s.quietMs) return { due: true, reason: 'quiet', ...common };

  return { due: false, reason: 'waiting', ...common };
}
