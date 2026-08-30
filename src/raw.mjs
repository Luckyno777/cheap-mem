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

export const RAW_DIR = 'raw';
export const OFFSET_FILE = path.join('.mem', 'raw-offsets.json');
export const WATERMARK_FILE = path.join('.mem', 'raw-watermark.json');
export const BELL_FILE = path.join('.mem', 'digest-bell.json');

/** Short, stable hash — for identification only, not for security. */
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) & 0xffffffff;
  return (h >>> 0).toString(36).padStart(7, '0');
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
  tsFrom = null, tsTo = null, project = null,
} = {}) {
  return {
    session_id: sessionId ?? (transcript ? shortHash(transcript) : 'unknown'),
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

/**
 * Capture a transcript — incremental, redacted, gzipped.
 *
 * Returns three states, never two:
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
} = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { status: 'broken', reason: 'no-transcript', detail: String(transcriptPath) };
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
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (e) {
    return { status: 'broken', reason: 'read', detail: e.message };
  }

  // Drop the first line only if it really is a slice of the previous
  // one. On the very first capture (offset 0) and after a clean line
  // break there is nothing to drop.
  const lines = chunk.split('\n');
  if (from > 0 && !cleanBoundary && lines.length > 0) lines.shift();

  const captured = [];
  const allFound = new Map();
  let tsFrom = null;
  let tsTo = null;

  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); }
    catch { o = { __unparsable: true, raw: l.slice(0, 2000) }; }

    const { object, found } = redaction.redactEntry(o);
    for (const f of found) allFound.set(f.type, (allFound.get(f.type) ?? 0) + f.count);

    const ts = o.timestamp ?? o.ts ?? null;
    if (ts) {
      if (!tsFrom || ts < tsFrom) tsFrom = ts;
      if (!tsTo || ts > tsTo) tsTo = ts;
    }
    captured.push(object);
  }

  if (captured.length === 0) {
    allOffsets[key] = { bytes: size, path: transcriptPath };
    saveJson(offsetPath, allOffsets);
    return { status: 'nothing', reason: 'blank-lines-only' };
  }

  const stamp = buildStamp({ transcript: transcriptPath, tsFrom, tsTo, ...stampExtra });

  // Header line: the provenance stamp itself, so the file can stand
  // on its own.
  const header = {
    __stamp: stamp,
    __captured_at: isoSeconds(now),
    __lines: captured.length,
    __offset_from: from,
    __offset_to: size,
    __redacted: [...allFound].map(([type, count]) => ({ type, count })),
  };

  const body = [header, ...captured].map((o) => JSON.stringify(o)).join('\n') + '\n';
  const dest = capturePath(root, stamp, now);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 }));

  allOffsets[key] = { bytes: size, path: transcriptPath, last: header.__captured_at };
  saveJson(offsetPath, allOffsets);

  // Ring the bell. Only NOW, once the file is safely on disk — a bell
  // without material would mean a digest run over nothing.
  const bell = ring(root, now);

  return {
    status: 'captured',
    path: path.relative(root, dest),
    lines: captured.length,
    bytes: fresh,
    redacted: header.__redacted,
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
export function snippet(root, relPath, terms, { width = 260 } = {}) {
  let lines;
  try { ({ lines } = readCapture(root, relPath)); }
  catch { return ''; }

  const words = (Array.isArray(terms) ? terms : String(terms).split(/\s+/))
    .map((b) => String(b).toLowerCase())
    .filter((b) => b.length >= 3);

  for (const l of lines) {
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

export function listCaptures(root) {
  const base = path.join(root, RAW_DIR);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const year of fs.readdirSync(base).sort()) {
    const yp = path.join(base, year);
    if (!fs.statSync(yp).isDirectory()) continue;
    for (const month of fs.readdirSync(yp).sort()) {
      const mp = path.join(yp, month);
      if (!fs.statSync(mp).isDirectory()) continue;
      for (const file of fs.readdirSync(mp).sort()) {
        if (!file.endsWith('.jsonl.gz')) continue;
        out.push(path.join(RAW_DIR, year, month, file));
      }
    }
  }
  return out;
}

/** Read one capture (decompressed). Returns `{header, lines}`. */
export function readCapture(root, relPath) {
  const full = path.join(root, relPath);
  const text = zlib.gunzipSync(fs.readFileSync(full)).toString('utf8');
  const lines = [];
  let header = null;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.__stamp && header === null) { header = o; continue; }
    lines.push(o);
  }
  return { header, lines };
}

/**
 * What the digest has not processed yet.
 * Returns the list of pending capture files plus their total size.
 */
export function pending(root) {
  const wm = loadJson(path.join(root, WATERMARK_FILE), { digested: [] });
  const done = new Set(wm.digested ?? []);
  const open = listCaptures(root).filter((f) => !done.has(f));
  let bytes = 0;
  for (const f of open) {
    try { bytes += fs.statSync(path.join(root, f)).size; } catch { /* gone */ }
  }
  return { open, bytes, done: done.size, last: wm.last ?? null };
}

/** Mark captures as digested. Union, never replacement. */
export function markDigested(root, paths) {
  const p = path.join(root, WATERMARK_FILE);
  const wm = loadJson(p, { digested: [] });
  wm.digested = [...new Set([...(wm.digested ?? []), ...paths])].sort();
  wm.last = isoSeconds(new Date());
  saveJson(p, wm);
  clearBell(root);   // pile cleared, reset the bell
  return wm.digested.length;
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

  if (state.bytes < s.volumeMin) return { due: false, reason: 'too-little', ...common };

  // 2. The burst is over — quiet since the LAST bell, not the first.
  //    Otherwise the digest fires in the middle of the working day.
  if (quiet >= s.quietMs) return { due: true, reason: 'quiet', ...common };

  // 3. Ceiling: a long working day must not postpone digesting forever.
  if (waiting >= s.ceilingMs) return { due: true, reason: 'ceiling', ...common };

  return { due: false, reason: 'waiting', ...common };
}
