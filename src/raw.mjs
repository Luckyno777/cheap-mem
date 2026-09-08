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
function stripImages(o, zaehler) {
  const c = o?.message?.content;
  if (!Array.isArray(c)) return o;
  let getroffen = false;
  const neu = c.map((part) => {
    if (part?.type !== 'image') return part;
    getroffen = true;
    const bytes = Buffer.byteLength(JSON.stringify(part));
    return { type: 'text', text: `[image elided by cheap-mem: ${bytes} bytes]` };
  });
  if (!getroffen) return o;
  zaehler.set('image', (zaehler.get('image') ?? 0) + 1);
  return { ...o, message: { ...o.message, content: neu } };
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
  fs.appendFileSync(p, `${JSON.stringify(rec)}\n`, 'utf8');
}
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
  // Escape hatch, and the reason it exists: a filter you cannot switch
  // off cannot be measured against itself. Every claim about how much
  // it saves comes from running the same transcript both ways.
  drop = true,
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
  const dropped = new Map();
  let droppedBytes = 0;
  let tsFrom = null;
  let tsTo = null;

  for (const l of lines) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); }
    catch { o = { __unparsable: true, raw: l.slice(0, 2000) }; }

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
        : 'The default is .mem/raw inside the working tree.',
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
    source_bytes: fresh,
    ...stored,
    redacted: header.__redacted,
    dropped: header.__dropped,
    dropped_bytes: droppedBytes,
  });

  allOffsets[key] = { bytes: size, path: transcriptPath, last: header.__captured_at };
  saveJson(offsetPath, allOffsets);

  // Ring the bell. Only NOW, once the file is safely on disk — a bell
  // without material would mean a digest run over nothing.
  const bell = ring(root, now);

  return {
    status: 'captured',
    path: relPath,
    archive: stored.location,
    sha256: stored.sha256,
    lines: captured.length,
    bytes: fresh,
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
  // Two sources, in this order: the record in the repository (the truth
  // about what EXISTS) and the old directory (anything not migrated
  // yet). Merged, no duplicates.
  //
  // Why the record comes first: after the move no capture lives in the
  // repository, and a listing that only looks at the filesystem would
  // be empty from then on — the search would report "nothing found" and
  // hide a broken wiring. That is the most expensive failure this
  // project knows.
  const out = [];
  const seen = new Set();
  for (const rec of archive.records(root)) {
    if (!rec?.path || seen.has(rec.path)) continue;
    seen.add(rec.path);
    out.push(rec.path);
  }

  const base = path.join(root, RAW_DIR);
  if (!fs.existsSync(base)) return out.sort();
  for (const year of fs.readdirSync(base).sort()) {
    const yp = path.join(base, year);
    if (!fs.statSync(yp).isDirectory()) continue;
    for (const month of fs.readdirSync(yp).sort()) {
      const mp = path.join(yp, month);
      if (!fs.statSync(mp).isDirectory()) continue;
      for (const file of fs.readdirSync(mp).sort()) {
        if (!file.endsWith('.jsonl.gz')) continue;
        const p = path.join(RAW_DIR, year, month, file);
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out.sort();
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
  for (const rec of archive.records(root)) {
    if (rec?.path && typeof rec.bytes === 'number') fromRecord.set(rec.path, rec.bytes);
  }
  let bytes = 0;
  for (const f of open) {
    if (fromRecord.has(f)) { bytes += fromRecord.get(f); continue; }
    // Not migrated yet: then from the disk.
    try { bytes += fs.statSync(path.join(root, f)).size; } catch { /* gone */ }
  }
  return { open, bytes, done: done.size, last: wm.last ?? null };
}

/** Mark captures as digested. Union, never replacement. */
export function markDigested(root, paths) {
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
  appendLedger(root, added, { entries: added.length });

  wm.digested = [...new Set([...before, ...paths])].sort();
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
