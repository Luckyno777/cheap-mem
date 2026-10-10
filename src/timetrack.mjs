// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/timetrack.mjs — the time track: a time-window question without a linear
// full scan of every drawer.
//
// ## The finding
//
// `timesearch.entriesInWindow` ("what happened last week", the time lane of
// `mem find`, `mem when`, the recall hook) asks `memory.find` with a time
// window. `find` walks EVERY line of EVERY drawer file, and walks it twice
// (pass 1: the state lines; pass 2: the candidates). Measured on a synthetic
// memory (bench/timetrack-measure.mjs, one-day window, 24 hits): 100 ms at
// 10,000 entries (10 MB), 900 ms at 100,000 entries (112 MB). Port of
// lucky-mem's `src/zeitspur.mjs` (same finding, 1.15 s at 100k there).
//
// ## What the track is
//
// For every drawer file that is big enough to matter, a small DERIVED side
// structure under `<root>/.mem/timetrack/`:
//
//   - a block table: the file in blocks of ~128 KiB at line boundaries; per
//     block the byte offset, the number of lines before it, the smallest and
//     the largest READABLE `ts`, and an `open` mark. No order by `ts` is
//     assumed (a late entry with an old `ts` is legal): only min/max per block.
//   - the state ids: every id a state line (tombstone, closing, correction)
//     names, plus the state lines' own ids. They replace the state pass.
//   - a fingerprint of the covered prefix (hash of its first and last 4 KiB)
//     and its size, so a rewritten drawer (shard archiving, a union merge
//     that inserted lines) is recognised and never trusted.
//
// Unlike lucky-mem there are no sealed segments here: a drawer is ONE growing
// append-only file. So the track covers a PREFIX of it, in whole blocks; the
// bytes after the prefix (the "tail", under one block plus what has been
// appended since the last build) are always read in full. The track is
// extended by appending blocks, reading only the new bytes.
//
// The rule "can this line's ts lie in the window" exists once
// (`tsFindings`); `memory.find` and the track share it. A block is skipped
// only when NO line in it can be in the window; a block with an unreadable
// or time-zone-dependent `ts` is `open` and is always read.
//
// ## Three states, never collapsed
//
//   missing  no track file for the drawer: read it in full, say so (report)
//   broken   unreadable / wrong version / wrong shape: read in full, say so
//   stale    the drawer no longer matches the track (shrunk, rewritten):
//            read in full, say so
//   valid    skip what cannot be in the window
// A drawer smaller than `MIN_TRACK_BYTES` has no track (`small`): a full read
// is a few milliseconds. The track is derived and may be deleted at any time;
// the JSONL files stay the truth.
//
// ## Retired and corrected entries: exact, from a few extra blocks
//
// `find` marks a hit `_retired` when a state line names it, and the verdict
// needs the state lines naming it and the first line carrying its id. The
// track keeps, in a side file read only when such a candidate comes up, one
// record per state line (its block, own id, targets, `by_id`) and a 32-bit hash
// of every line id of the covered prefix. A candidate that a state line names
// is then settled by reading just the blocks of those state lines, and "the
// first line with this id is the candidate" is proved by counting: the hashes
// of all covered prefixes must contain the id exactly as often as the lines
// read. Whatever cannot be settled that way takes the full scan, `reason:
// 'state'`: a candidate that is itself a correction line, a state line with a
// `by_id` (the successor's line is needed), a state line sharing the id of a
// candidate, a duplicate id outside the lines read, a drawer that is big and has
// no usable track (a build is asked for), a missing or torn side file (a
// rebuild is asked for). A small drawer without a track is read in full, so
// everything in it is seen and it takes part in the proof. A line whose id
// cannot be read from the text (two "id" keys) is counted in the side file;
// one such line anywhere in the covered prefix, or among the lines read, turns
// the exact answer off for the question, because it could hide a duplicate id.
// A tombstone in the window is no hit and forces nothing.
//
// The side file grows linearly with the memory: about 5.3 bytes per line for
// the id hashes (base64 of 4 bytes) plus the state records, so roughly 5 MB per
// million lines; it is read and its hashes counted only when a named candidate
// is in the window.
//
// ## Known limits
//
//   - A drawer without a track, and the tail of one with, are read in full.
//   - Validity is judged by size and the two fingerprints, not by a hash of
//     the whole prefix: an in-place edit of a skipped block that keeps size,
//     head and tail identical is not noticed (the drawers are append-only).
//   - A tombstone carries the `ts` of the day it was written; the block that
//     holds it spans that time too, so it is read for windows before it.
//
// ## Building
//
// Never in the asking process: `kickBuild` starts a detached child (lock file;
// a note in the track directory after a failed build holds the next nudge back
// for ten minutes; orphaned temp files of a killed build are swept). A build
// that can close no block still writes the size it saw (`builtSize`), so the
// same bytes never ask twice; new bytes ask again once a block's worth has
// arrived.
//
// invariant: unknown-is-not-zero
// invariant: one-rule-one-place

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as authority from './authority.mjs';
import { writeAtomic } from './atomicwrite.mjs';
import { tryLock, releaseLock, lockAgeS, takeOverIfStale } from './filelock.mjs';

const TRACK_VERSION = 2;
const TRACK_DIR = path.join('.mem', 'timetrack');
/** Block size of the block table, in bytes (rounded up to a line boundary). */
const BLOCK_BYTES = 128 * 1024;
/** A drawer under this size gets no track: reading it whole costs a few ms (two blocks). */
const MIN_TRACK_BYTES = 256 * 1024;
const READ_BYTES = 256 * 1024;
const FP_BYTES = 4096;
export const BUILD_LOCK_PATH = path.join('.mem', 'timetrack-build.lock');
/** A build lock older than this belongs to a dead builder. */
const BUILD_LOCK_MAX_AGE_S = 1800;

/** The track no longer matches its drawer (shrunk, rewritten, moved blocks). */
export class StaleTrack extends Error {
  constructor(file, why) {
    super(`time track of '${file}' is stale: ${why}`);
    this.name = 'StaleTrack';
    this.file = file;
  }
}

// ---------------------------------------------------------------------------
// The ONE rule for "can the ts of this line lie in the window?"
// ---------------------------------------------------------------------------

/**
 * Does `new Date(value)` read the same in every time zone? Only a plain ISO
 * date (UTC) or a time with `Z` / an offset does; anything else (an ISO time
 * without a zone, foreign formats) is read in the zone of the PROCESS. The
 * process that builds the track and the one that asks can run in different
 * zones: a block holding such a value is never skippable (`open`).
 */
function zoneFixed(value) {
  return /^[+-]?\d{4,6}-\d{2}-\d{2}$/.test(value)
    || /^[+-]?\d{4,6}-\d{2}-\d{2}T[\d:.,]+(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
}

/**
 * Every `"ts"` occurrence of a line: `count` keys in the text, `found` of them
 * with a readable string value, `ms` the readable values as milliseconds (NaN
 * stays NaN), `local` = one of them depends on the process time zone.
 * `found !== count` means at least one value is not safely readable: the line
 * cannot be excluded.
 */
export function tsFindings(text) {
  const count = text.split('"ts"').length - 1;
  const ms = [];
  if (count === 0) return { count, found: 0, ms, local: false };
  let local = false;
  const re = /"ts"\s*:\s*"([^"\\]*)"/g;
  let found = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    found += 1;
    const t = new Date(m[1]).getTime();
    ms.push(t);
    if (!Number.isNaN(t) && !zoneFixed(m[1])) local = true;
  }
  return { count, found, ms, local };
}

/**
 * The id of a line, read from the text without parsing: a string = read
 * unambiguously, null = no id, undefined = ambiguous (then parse). The one
 * rule; `memory.find` uses it too.
 */
export function idOfLine(text) {
  const count = text.split('"id"').length - 1;
  if (count === 0) return null;
  const m = /"id"\s*:\s*"([^"\\]*)"/.exec(text);
  if (count === 1 && m) return m[1];
  return undefined;
}

/** A 32-bit FNV-1a hash of an id (the side file keeps these, not the ids). */
function hashId(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const STATE_MARKS = authority.STATE_FIELDS.map((f) => `"${f}"`);
/** Real keys always appear as "field" in JSON; a false hit costs one parse, a missed one is impossible. */
export function hasStateMark(text) {
  for (const m of STATE_MARKS) { if (text.includes(m)) return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Reading lines of a byte range, with their offsets
// ---------------------------------------------------------------------------

/**
 * Lines in the byte range [from, to) of an open file. `from` MUST be a line
 * start. `nr0` = lines before `from` (numbered like `memory.find`: over all
 * lines, empty ones too). Yields { text, nr, off } for non-empty lines. A BOM
 * is stripped only at the start of the file. `to` may be Infinity (read to the
 * end). `count.bytes` gets the bytes read.
 */
function* linesFrom(fd, from, to, nr0 = 0, count = null) {
  const buf = Buffer.alloc(READ_BYTES);
  let pos = from;
  let nr = nr0;
  let rest = Buffer.alloc(0);
  let restOff = from;
  for (;;) {
    let n = 0;
    if (pos < to) {
      n = fs.readSync(fd, buf, 0, Math.min(READ_BYTES, to - pos), pos);
      if (count) count.bytes += n;
    }
    if (n === 0) break;
    pos += n;
    rest = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
    let s = 0;
    let nl = rest.indexOf(10, s);
    while (nl !== -1) {
      nr += 1;
      let text = rest.toString('utf8', s, nl);
      if (restOff + s === 0 && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (text.trim()) yield { text, nr, off: restOff + s };
      s = nl + 1;
      nl = rest.indexOf(10, s);
    }
    restOff += s;
    rest = rest.subarray(s);
  }
  if (rest.length) {
    nr += 1;
    let text = rest.toString('utf8');
    if (restOff === 0 && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (text.trim()) yield { text, nr, off: restOff };
  }
}

// ---------------------------------------------------------------------------
// The track file: place, read, validate
// ---------------------------------------------------------------------------

function relPosix(root, p) {
  return path.relative(path.resolve(root), path.resolve(p)).split(path.sep).join('/');
}

/** Where the track of one drawer file lives. */
export function trackPath(root, drawerFile) {
  const rel = relPosix(root, drawerFile);
  const key = rel.replace(/[^a-zA-Z0-9._-]/g, '_');
  const short = crypto.createHash('sha256').update(rel).digest('hex').slice(0, 8);
  return path.join(root, TRACK_DIR, `${key}.${short}.json`);
}

/** The side file with the id hashes and the state records (read only when a state question comes up). */
function auxPath(root, drawerFile) {
  return trackPath(root, drawerFile).replace(/\.json$/, '.aux.json');
}

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function validShape(d, rel) {
  if (!d || typeof d !== 'object' || d.version !== TRACK_VERSION || d.file !== rel) return false;
  if (!isNum(d.blockBytes) || !isNum(d.covered) || !isNum(d.lines) || !isNum(d.builtSize) || typeof d.fp !== 'string') return false;
  if (!Array.isArray(d.blocks) || !Array.isArray(d.state)) return false;
  let lastOff = -1;
  let lastLines = 0;
  for (const b of d.blocks) {
    if (!Array.isArray(b) || b.length !== 5) return false;
    const [off, n0, mn, mx, open] = b;
    if (!isNum(off) || !isNum(n0) || off <= lastOff || off >= d.covered || n0 < lastLines) return false;
    if ((mn !== null && !isNum(mn)) || (mx !== null && !isNum(mx)) || (open !== 0 && open !== 1)) return false;
    lastOff = off;
    lastLines = n0;
  }
  if (d.covered > 0 && (d.blocks.length === 0 || d.blocks[0][0] !== 0 || d.blocks[0][1] !== 0)) return false;
  if (d.covered === 0 && d.blocks.length !== 0) return false;
  if (d.lines < lastLines) return false;
  for (const id of d.state) if (typeof id !== 'string') return false;
  return true;
}

/** Read a track. { status: 'missing' | 'broken' | 'valid', data?, why? } — never a quiet `{}`. */
export function readTrack(root, drawerFile) {
  const where = trackPath(root, drawerFile);
  let text;
  try { text = fs.readFileSync(where, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return { status: 'missing' };
    return { status: 'broken', why: `not readable: ${e?.code ?? e?.message}` };
  }
  let d;
  try { d = JSON.parse(text); } catch { return { status: 'broken', why: 'not JSON' }; }
  if (!validShape(d, relPosix(root, drawerFile))) return { status: 'broken', why: 'version or shape does not fit' };
  return { status: 'valid', data: d };
}

/**
 * The side file of a valid track: `ids` = the 32-bit hash of every line id in
 * the covered prefix (a Buffer of little-endian words), `st` = one record
 * [blockIndex, ownId|null, [targetIds], byId|null] per state line in a closed
 * block, `ambiguous` = lines whose id could not be read from the text. Returns
 * null unless it belongs to exactly this track (same prefix, same fingerprint).
 */
function readAux(root, drawerFile, data) {
  let d;
  try { d = JSON.parse(fs.readFileSync(auxPath(root, drawerFile), 'utf8')); } catch { return null; }
  if (!d || d.version !== TRACK_VERSION || d.file !== data.file || d.covered !== data.covered || d.fp !== data.fp) return null;
  if (!Array.isArray(d.st) || typeof d.ids !== 'string' || !isNum(d.ambiguous) || !isNum(d.idCount)) return null;
  const ids = Buffer.from(d.ids, 'base64');
  if (ids.length !== d.idCount * 4) return null;
  for (const r of d.st) {
    if (!Array.isArray(r) || r.length !== 4 || !isNum(r[0]) || r[0] < 0 || r[0] >= data.blocks.length) return null;
    if (!Array.isArray(r[2]) || (r[1] !== null && typeof r[1] !== 'string') || (r[3] !== null && typeof r[3] !== 'string')) return null;
  }
  return { ids, st: d.st, ambiguous: d.ambiguous };
}

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, pos + got);
    if (n === 0) break;
    got += n;
  }
  return b.subarray(0, got);
}

/** Hash of the first and the last 4 KiB of the first `covered` bytes. */
function fingerprint(fd, covered) {
  const n = Math.min(FP_BYTES, covered);
  const h = crypto.createHash('sha256');
  h.update(readAt(fd, 0, n));
  h.update('|');
  h.update(readAt(fd, covered - n, n));
  return h.digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// Building and extending a track
// ---------------------------------------------------------------------------

function wordsToBuffer(words) {
  const b = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i += 1) b.writeUInt32LE(words[i], i * 4);
  return b;
}

/**
 * Build or extend the track of ONE drawer file and write it atomically.
 * An existing valid track (with its side file) is extended: only the bytes
 * after its prefix are read. A missing, broken or stale one is rebuilt. Only
 * CLOSED blocks are recorded: the last block, which may still grow, stays in
 * the tail. A build that can close no block still writes a track (covered 0)
 * with the size it saw, so the same bytes do not ask for a build again.
 * Returns { action: 'built' | 'extended' | 'kept' | 'small', blocks }.
 */
export function buildFile(root, drawerFile, { blockBytes = BLOCK_BYTES, minBytes = MIN_TRACK_BYTES } = {}) {
  const rel = relPosix(root, drawerFile);
  const fd = fs.openSync(drawerFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < minBytes) return { action: 'small', blocks: 0 };
    const old = readTrack(root, drawerFile);
    let base = null;
    let baseAux = null;
    if (old.status === 'valid' && old.data.covered <= size && old.data.covered > 0
      && fingerprint(fd, old.data.covered) === old.data.fp) {
      baseAux = readAux(root, drawerFile, old.data);
      if (baseAux) base = old.data;
    }
    const bytes = base ? base.blockBytes : blockBytes;
    const blocks = base ? base.blocks.map((b) => [...b]) : [];
    const state = new Set(base ? base.state : []);
    const hashes = [];
    if (baseAux) for (let i = 0; i < baseAux.ids.length; i += 4) hashes.push(baseAux.ids.readUInt32LE(i));
    const records = base ? baseAux.st.map((r) => [...r]) : [];
    let ambiguous = base ? baseAux.ambiguous : 0;
    const startOff = base ? base.covered : 0;
    const startLines = base ? base.lines : 0;

    let open = null;       // the block being filled
    let closedAny = false;
    const close = () => {
      const bi = blocks.length;
      blocks.push([open.off, open.n0, open.mn, open.mx, open.open]);
      for (const id of open.ids) state.add(id);
      for (const h of open.hashes) hashes.push(h);
      for (const r of open.recs) records.push([bi, ...r]);
      ambiguous += open.ambiguous;
      closedAny = true;
    };
    for (const { text, nr, off } of linesFrom(fd, startOff, size, startLines)) {
      if (!open || off - open.off >= bytes) {
        if (open) close();
        open = { off, n0: nr - 1, mn: null, mx: null, open: 0, ids: [], hashes: [], recs: [], ambiguous: 0 };
      }
      const f = tsFindings(text);
      if (f.count > 0 && (f.found !== f.count || f.local)) open.open = 1;
      for (const t of f.ms) {
        if (Number.isNaN(t)) continue;
        if (open.mn === null || t < open.mn) open.mn = t;
        if (open.mx === null || t > open.mx) open.mx = t;
      }
      const id = idOfLine(text);
      if (typeof id === 'string') open.hashes.push(hashId(id));
      else if (id === undefined) open.ambiguous += 1;
      if (hasStateMark(text)) {
        const info = stateInfoOfLine(text);
        if (info) {
          open.ids.push(...info.ids);
          open.recs.push([info.own, info.targets, info.by]);
        }
      }
    }
    // The first block starts at byte 0 (a BOM and leading blank lines belong to it).
    if (closedAny && !base) { blocks[0][0] = 0; blocks[0][1] = 0; }
    const covered = closedAny ? open.off : (base ? base.covered : 0);
    const lines = closedAny ? open.n0 : (base ? base.lines : 0);
    const main = {
      version: TRACK_VERSION, file: rel, blockBytes: bytes, covered, lines, builtSize: size,
      fp: fingerprint(fd, covered), blocks, state: [...state].sort(),
    };
    if (closedAny || !base) {
      // The side file first, the track last: the track is the commit point and names the side file's prefix.
      writeAtomic(auxPath(root, drawerFile), JSON.stringify({
        version: TRACK_VERSION, file: rel, covered, fp: main.fp, ambiguous, idCount: hashes.length,
        ids: wordsToBuffer(hashes).toString('base64'), st: records,
      }));
    }
    writeAtomic(trackPath(root, drawerFile), JSON.stringify(main));
    return { action: closedAny ? (base ? 'extended' : 'built') : 'kept', blocks: blocks.length };
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------------------
// Reading a drawer for a window: only the blocks that can matter
// ---------------------------------------------------------------------------

/** A fresh report for `windowLines`: the counts that keep the answer honest. */
export function newReport() {
  return {
    way: null, reason: null,
    drawers: { valid: 0, missing: 0, broken: 0, stale: 0, small: 0 },
    blocksRead: 0, blocksSkipped: 0, bytesRead: 0, extraBlocks: 0, stateResolved: false, buildNeeded: false,
  };
}

/**
 * The state of one window question: the report, the ids the tracks (and the
 * lines read) know to be named by state lines, per drawer what was read, the
 * ids seen on the lines read (for the exact state answer) and the state lines
 * read.
 */
export function newScan(report = newReport()) {
  return {
    report, stateIds: new Set(),
    info: new Map(),        // drawer path -> { fi, data, readBlocks: Set }
    ids: new Map(),         // id -> { cov: lines read in a covered prefix, first: { fi, nr } }
    ambiguous: false,       // a line read whose id cannot be read from the text
    stateLines: [],         // { fi, nr, text, info } (info = stateInfoOfLine(text))
  };
}

function noteId(scan, fi, nr, text, covered) {
  const id = idOfLine(text);
  if (id === undefined) { scan.ambiguous = true; return; }
  if (id === null) return;
  let rec = scan.ids.get(id);
  if (!rec) { rec = { cov: 0, first: { fi, nr } }; scan.ids.set(id, rec); }
  else if (fi < rec.first.fi || (fi === rec.first.fi && nr < rec.first.nr)) rec.first = { fi, nr };
  if (covered) rec.cov += 1;
}

/**
 * The lines of ONE drawer file a window question has to look at. Everything
 * the track proves cannot be in the window is skipped; the tail and a drawer
 * without a usable track are read in full. `scan` (see `newScan`) collects
 * what the exact state answer needs and the report counts what happened.
 * `fail(file, cause, partial)` builds the error to throw for an unreadable
 * file (the caller's `ReadError`). Throws `StaleTrack` when a block boundary
 * does not hold. `fi` = the position of the drawer in the question's file list.
 */
export function* windowLines(root, drawerFile, fromMs, toMs, scan, fail, fi = 0) {
  const report = scan.report;
  let fd;
  try { fd = fs.openSync(drawerFile, 'r'); } catch (e) { throw fail(drawerFile, e, false); }
  let delivered = false;
  try {
    let size; let tr; let status; let data = null;
    try {
      size = fs.fstatSync(fd).size;
      tr = readTrack(root, drawerFile);
      status = tr.status;
      if (status === 'valid') {
        if (tr.data.covered > size || fingerprint(fd, tr.data.covered) !== tr.data.fp) status = 'stale';
        else data = tr.data;
      }
    } catch (e) { throw fail(drawerFile, e, false); }
    if (status === 'missing' && size < MIN_TRACK_BYTES) status = 'small';
    report.drawers[status] += 1;
    // A build is worth starting when there is no usable track, or a block's worth of new bytes
    // that could close a block arrived since the last build looked (a giant last line never asks twice).
    if (size >= MIN_TRACK_BYTES
      && (!data || (size - data.builtSize >= data.blockBytes && size - data.covered >= 2 * data.blockBytes))) report.buildNeeded = true;

    const readBlocks = new Set();
    // A small drawer without a track is read in full, so every id and state line in it is seen:
    // it takes part in the exact answer (`counted`). A big one without a usable track is not
    // counted (a build is asked for) and the question takes the full scan if it needs the exact answer.
    const counted = data !== null || status === 'small';
    scan.info.set(drawerFile, { fi, data, counted, readBlocks });
    const runs = [];
    if (!data) {
      runs.push({ from: 0, to: Infinity, n0: 0 });
    } else {
      for (const id of data.state) scan.stateIds.add(id);
      const bl = data.blocks;
      let run = null;
      bl.forEach((b, i) => {
        const [off, n0, mn, mx, open] = b;
        const end = i + 1 < bl.length ? bl[i + 1][0] : data.covered;
        if (open !== 1 && !(mn !== null && mx >= fromMs && mn < toMs)) {
          report.blocksSkipped += 1;
          run = null;
          return;
        }
        report.blocksRead += 1;
        readBlocks.add(i);
        if (run && run.to === off) { run.to = end; return; }
        run = { from: off, to: end, n0 };
        runs.push(run);
      });
      if (data.covered < size || runs.length === 0) runs.push({ from: data.covered, to: Infinity, n0: data.lines });
    }
    const rel = relPosix(root, drawerFile);
    const count = { bytes: 0 };
    try {
      for (const r of runs) {
        // A run must start on a line start; anything else means the drawer moved under the track.
        if (r.from > 0 && readAt(fd, r.from - 1, 1)[0] !== 10) throw new StaleTrack(rel, `offset ${r.from} is not a line start`);
        for (const line of linesFrom(fd, r.from, r.to, r.n0, count)) {
          delivered = true;
          if (counted) noteId(scan, fi, line.nr, line.text, data !== null && line.off < data.covered);
          yield line;
        }
      }
    } catch (e) {
      if (e instanceof StaleTrack) throw e;
      throw fail(drawerFile, e, delivered);
    } finally { report.bytesRead += count.bytes; }
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------------------
// The exact answer for a window candidate that a state line names
// ---------------------------------------------------------------------------

/** The ids and fields a state line names: { own, targets, by, ids } or null if it does not parse. */
export function stateInfoOfLine(text) {
  let e;
  try { e = JSON.parse(text); } catch { return null; }
  const targets = [];
  for (const f of authority.STATE_FIELDS) if (e?.[f]) targets.push(String(e[f]));
  const by = e?.by_id ? String(e.by_id) : null;
  const own = typeof e?.id === 'string' && e.id ? e.id : null;
  return { own, targets, by, ids: [...targets, ...(by ? [by] : []), ...(own ? [own] : [])] };
}

/**
 * Which retirements apply to the window candidates, WITHOUT reading the whole
 * memory: the same `retiredMap` over only what decides them. A candidate X that
 * a state line names needs (1) every state line naming X, (2) the first line
 * carrying X's id. (1) are the state lines already read, plus the blocks the
 * track records for them (those blocks are read now). (2) is proved by
 * counting: the ids hashed in every covered prefix must occur exactly as often
 * as the lines read with that id, and the first of them must be the candidate.
 * Anything else — a drawer without a track, an id that cannot be read from the
 * text, a candidate that is itself a correction line, a state line with a
 * `by_id` (the successor's line is needed), a state line sharing the id of a
 * candidate, a first line that is not the candidate — returns null: the full
 * scan answers. `candidates` = [{ entry, fi, line, marked }].
 */
export function resolveRetired(root, scan, candidates, { retiredMap, isClosing, fail }) {
  if (scan.ambiguous) return null;
  const named = new Map();            // id -> the candidate that is first in file order
  for (const c of candidates) {
    const e = c.entry;
    if (e.__broken || isClosing(e)) continue;
    if (c.marked) return null;
    if (e.id == null || !scan.stateIds.has(String(e.id))) continue;
    const id = String(e.id);
    const have = named.get(id);
    if (!have || c.fi < have.fi || (c.fi === have.fi && c.line < have.line)) named.set(id, c);
  }
  if (named.size === 0) return new Map();
  const aux = new Map();
  for (const [p, inf] of scan.info) {
    if (!inf.data) {
      if (inf.counted) continue;      // read in full: its ids and state lines are all in the scan
      return null;
    }
    const a = readAux(root, p, inf.data);
    if (!a) { scan.report.buildNeeded = true; return null; }   // a valid track without its side file: rebuild it
    if (a.ambiguous > 0) return null;
    aux.set(p, a);
  }
  // (1) the state lines naming a candidate: the ones already read, and the recorded blocks
  const infos = new Map();            // "fi:nr" -> { fi, nr, text, info }
  const take = (fi, nr, text, info = stateInfoOfLine(text)) => {
    const key = `${fi}:${nr}`;
    if (infos.has(key) || !info) return;
    infos.set(key, { fi, nr, text, info });
  };
  for (const l of scan.stateLines) take(l.fi, l.nr, l.text, l.info);
  const extra = [];                   // [p, blockIndex]
  for (const [p, a] of aux) {
    const inf = scan.info.get(p);
    const wanted = new Set();
    for (const [bi, own, targets, by] of a.st) {
      if (own !== null && named.has(own)) return null;
      if (!targets.some((t) => named.has(t))) continue;
      if (by !== null) return null;
      if (!inf.readBlocks.has(bi)) wanted.add(bi);
    }
    for (const bi of [...wanted].sort((x, y) => x - y)) extra.push([p, bi]);
  }
  for (const { info } of infos.values()) {
    if (info.own !== null && named.has(info.own)) return null;
    if (info.by !== null && info.targets.some((t) => named.has(t))) return null;
  }
  for (const [p, bi] of extra) {
    const inf = scan.info.get(p);
    const data = inf.data;
    const end = bi + 1 < data.blocks.length ? data.blocks[bi + 1][0] : data.covered;
    const [off, n0] = data.blocks[bi];
    let fd;
    try { fd = fs.openSync(p, 'r'); } catch (e) { throw fail(p, e, false); }
    try {
      if (off > 0 && readAt(fd, off - 1, 1)[0] !== 10) return null;
      const count = { bytes: 0 };
      try {
        for (const line of linesFrom(fd, off, end, n0, count)) {
          noteId(scan, inf.fi, line.nr, line.text, true);
          if (hasStateMark(line.text)) take(inf.fi, line.nr, line.text);
        }
      } catch (e) { throw fail(p, e, true); } finally { scan.report.bytesRead += count.bytes; }
    } finally { fs.closeSync(fd); }
    inf.readBlocks.add(bi);
    scan.report.extraBlocks += 1;
  }
  if (scan.ambiguous) return null;
  for (const { info } of infos.values()) {
    if (info.own !== null && named.has(info.own)) return null;
    if (info.by !== null && info.targets.some((t) => named.has(t))) return null;
  }
  // (2) the first line of each named id is the candidate: every covered occurrence was read
  const wantHash = new Map();         // hash -> sum of lines read with an id of that hash
  for (const id of named.keys()) {
    const h = hashId(id);
    wantHash.set(h, (wantHash.get(h) ?? 0) + (scan.ids.get(id)?.cov ?? 0));
  }
  const total = new Map();
  for (const a of aux.values()) {
    for (let i = 0; i < a.ids.length; i += 4) {
      const h = a.ids.readUInt32LE(i);
      if (wantHash.has(h)) total.set(h, (total.get(h) ?? 0) + 1);
    }
  }
  for (const [h, covRead] of wantHash) if ((total.get(h) ?? 0) !== covRead) return null;
  const forMap = [];
  for (const [id, c] of named) {
    const first = scan.ids.get(id)?.first;
    if (!first || first.fi !== c.fi || first.nr !== c.line) return null;
    forMap.push({ fi: c.fi, nr: c.line, entry: c.entry });
  }
  for (const { fi, nr, info, text } of infos.values()) {
    if (!info.targets.some((t) => named.has(t))) continue;
    let entry;
    try { entry = JSON.parse(text); } catch { continue; }
    forMap.push({ fi, nr, entry });
  }
  forMap.sort((x, y) => x.fi - y.fi || x.nr - y.nr);
  scan.report.stateResolved = true;
  return retiredMap(forMap.map((x) => x.entry));
}

// ---------------------------------------------------------------------------
// Building in the background (never in the asking process)
// ---------------------------------------------------------------------------

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Is a background build running (going by the lock file)? Never throws. */
function buildRunning(root) {
  return lockAgeS(path.join(root, BUILD_LOCK_PATH)) <= BUILD_LOCK_MAX_AGE_S;
}

/**
 * Block (bounded) until no background build holds the lock. For tests and
 * maintenance that must remove the tree: the child runs with the memory as
 * its working directory and writes into `.mem/`. Returns true once idle.
 */
export function waitForBuildIdle(root, timeoutMs = 15000, graceMs = 150) {
  const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
  const deadline = Date.now() + timeoutMs;
  while (buildRunning(root)) {
    if (Date.now() >= deadline) return false;
    nap(25);
  }
  nap(graceMs);
  return true;
}

const BUILD_NOTE = path.join(TRACK_DIR, 'build-note.json');
/** After a failed build, no new child is started for this long (seconds). */
const BUILD_BACKOFF_S = 600;
/** An orphaned temp file of the atomic writer is swept when it is this old (seconds). */
const TEMP_MAX_AGE_S = 600;

/** Write down how the last background build ended, so the next nudge can hold back after a failure. Never throws. */
export function noteBuild(root, outcome) {
  try {
    writeAtomic(path.join(root, BUILD_NOTE), JSON.stringify({ at: new Date().toISOString(), ...outcome }));
  } catch { /* nothing more can be done about a note */ }
}

/** Did the last build fail recently? Then the nudge waits. Never throws. */
function failedRecently(root) {
  try {
    const note = JSON.parse(fs.readFileSync(path.join(root, BUILD_NOTE), 'utf8'));
    const age = (Date.now() - new Date(note.at).getTime()) / 1000;
    return note.ok === false && age >= 0 && age < BUILD_BACKOFF_S;
  } catch { return false; }
}

/**
 * Remove the orphaned temp files of the atomic writer (`<file>.<pid>.<hex>.tmp`)
 * a killed build left in the track directory. Only that pattern, only in that
 * directory, only when old enough not to belong to a live writer. Returns the count.
 */
export function sweepTemps(root) {
  const dir = path.join(root, TRACK_DIR);
  let swept = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!/\.json\.\d+\.[0-9a-f]{10}\.tmp$/.test(name)) continue;
    try {
      const full = path.join(dir, name);
      if ((Date.now() - fs.statSync(full).mtimeMs) / 1000 < TEMP_MAX_AGE_S) continue;
      fs.unlinkSync(full);
      swept += 1;
    } catch { /* gone already, or not ours to remove */ }
  }
  return swept;
}

/**
 * Start the track build as a detached child, unless one is running (lock file,
 * the house's own `filelock` pieces) or the last one failed a moment ago (a
 * note in the track directory). Never builds in the caller, never waits,
 * never throws. 'started' | 'running' | 'backoff' | 'error'.
 */
export function kickBuild(root, env = process.env) {
  const lockPath = path.join(root, BUILD_LOCK_PATH);
  if (failedRecently(root)) return 'backoff';
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { return 'error'; }
  if (!tryLock(lockPath)) {
    if (!takeOverIfStale(lockPath, BUILD_LOCK_MAX_AGE_S)) return 'running';
    if (!tryLock(lockPath)) return 'running';
  }
  try {
    const url = pathToFileURL(path.join(MODULE_DIR, 'memory.mjs')).href;
    const selfUrl = pathToFileURL(path.join(MODULE_DIR, 'timetrack.mjs')).href;
    // `node -e` runs as CommonJS (so `require` exists); the root and the lock
    // arrive as arguments, not as environment variables. A build that throws
    // leaves a note (written by `noteBuild`); the lock always goes away.
    const script = `import(${JSON.stringify(url)}).then((m) => { m.buildTimeTracks(process.argv[1]); })
      .catch(async (e) => { try { (await import(${JSON.stringify(selfUrl)})).noteBuild(process.argv[1], { ok: false, error: String((e && e.message) || e) }); } catch {} })
      .finally(() => { try { require('node:fs').rmSync(process.argv[2], { force: true }); } catch {} });`;
    const child = spawn(process.execPath, ['-e', script, root, lockPath], {
      cwd: root, env: { ...env }, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', (e) => {
      noteBuild(root, { ok: false, error: `spawn: ${e?.code ?? e?.message}` });
      releaseLock(lockPath);
    });
    child.unref();
    return 'started';
  } catch {
    releaseLock(lockPath);
    return 'error';
  }
}
