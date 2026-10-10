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
// ## Known limits (as in lucky-mem)
//
//   - A window candidate that is NAMED by a state line (a retired or corrected
//     entry), or that is itself a correction line, needs lines from outside
//     the window: `find` then falls back to the full scan (`reason: 'state'`).
//     A closing line (tombstone) in the window is not a hit and does not.
//   - A drawer without a track, and the tail of one with, are read in full.
//   - Validity is judged by size and the two fingerprints, not by a hash of
//     the whole prefix: an in-place edit of a skipped block that keeps size,
//     head and tail identical is not noticed (the drawers are append-only).
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

const TRACK_VERSION = 1;
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

/** The ids a state line names (and its own id), empty if it does not parse. */
export function stateIdsOfLine(text) {
  let e;
  try { e = JSON.parse(text); } catch { return []; }
  const ids = [];
  for (const f of authority.STATE_FIELDS) if (e?.[f]) ids.push(String(e[f]));
  if (e?.by_id) ids.push(String(e.by_id));
  if (typeof e?.id === 'string' && e.id) ids.push(e.id);
  return ids;
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

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function validShape(d, rel) {
  if (!d || typeof d !== 'object' || d.version !== TRACK_VERSION || d.file !== rel) return false;
  if (!isNum(d.blockBytes) || !isNum(d.covered) || !isNum(d.lines) || typeof d.fp !== 'string') return false;
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

/**
 * Build or extend the track of ONE drawer file and write it atomically.
 * An existing valid track is extended (only the bytes after its prefix are
 * read); a missing, broken or stale one is rebuilt. Only CLOSED blocks are
 * recorded: the last block, which may still grow, stays in the tail.
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
    if (old.status === 'valid' && old.data.covered <= size && old.data.covered > 0
      && fingerprint(fd, old.data.covered) === old.data.fp) base = old.data;
    const bytes = base ? base.blockBytes : blockBytes;
    const blocks = base ? base.blocks.map((b) => [...b]) : [];
    const state = new Set(base ? base.state : []);
    const startOff = base ? base.covered : 0;
    const startLines = base ? base.lines : 0;

    let open = null;       // the block being filled: { off, n0, mn, mx, open, ids }
    let closedAny = false;
    const close = () => {
      blocks.push([open.off, open.n0, open.mn, open.mx, open.open]);
      for (const id of open.ids) state.add(id);
      closedAny = true;
    };
    for (const { text, nr, off } of linesFrom(fd, startOff, size, startLines)) {
      if (!open || off - open.off >= bytes) {
        if (open) close();
        open = { off, n0: nr - 1, mn: null, mx: null, open: 0, ids: [] };
      }
      const f = tsFindings(text);
      if (f.count > 0 && (f.found !== f.count || f.local)) open.open = 1;
      for (const t of f.ms) {
        if (Number.isNaN(t)) continue;
        if (open.mn === null || t < open.mn) open.mn = t;
        if (open.mx === null || t > open.mx) open.mx = t;
      }
      if (hasStateMark(text)) open.ids.push(...stateIdsOfLine(text));
    }
    if (!closedAny) return { action: 'kept', blocks: blocks.length };
    // The first block starts at byte 0 (a BOM and leading blank lines belong to it).
    if (!base) { blocks[0][0] = 0; blocks[0][1] = 0; }
    const covered = open.off;
    const lines = open.n0;
    writeAtomic(trackPath(root, drawerFile), JSON.stringify({
      version: TRACK_VERSION, file: rel, blockBytes: bytes, covered, lines,
      fp: fingerprint(fd, covered), blocks, state: [...state].sort(),
    }));
    return { action: base ? 'extended' : 'built', blocks: blocks.length };
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
    blocksRead: 0, blocksSkipped: 0, bytesRead: 0, buildNeeded: false,
  };
}

/**
 * The lines of ONE drawer file a window question has to look at. Everything
 * the track proves cannot be in the window is skipped; the tail and a drawer
 * without a usable track are read in full. `acc` = { stateIds: Set, report }:
 * the ids the track knows to be named by state lines are added to
 * `acc.stateIds`, the report counts what happened. `fail(file, cause,
 * partial)` builds the error to throw for an unreadable file (the caller's
 * `ReadError`). Throws `StaleTrack` when a block boundary does not hold.
 */
export function* windowLines(root, drawerFile, fromMs, toMs, acc, fail) {
  const report = acc.report;
  let fd;
  try { fd = fs.openSync(drawerFile, 'r'); } catch (e) { throw fail(drawerFile, e, false); }
  let delivered = false;
  try {
    const size = fs.fstatSync(fd).size;
    const tr = readTrack(root, drawerFile);
    let data = null;
    let status = tr.status;
    if (status === 'valid') {
      if (tr.data.covered > size || fingerprint(fd, tr.data.covered) !== tr.data.fp) status = 'stale';
      else data = tr.data;
    }
    if (status === 'missing' && size < MIN_TRACK_BYTES) status = 'small';
    report.drawers[status] += 1;
    if (size >= MIN_TRACK_BYTES && (!data || size - data.covered >= 2 * data.blockBytes)) report.buildNeeded = true;

    const runs = [];
    if (!data) {
      runs.push({ from: 0, to: Infinity, n0: 0 });
    } else {
      for (const id of data.state) acc.stateIds.add(id);
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
        for (const line of linesFrom(fd, r.from, r.to, r.n0, count)) { delivered = true; yield line; }
      }
    } catch (e) {
      if (e instanceof StaleTrack) throw e;
      throw fail(drawerFile, e, delivered);
    } finally { report.bytesRead += count.bytes; }
  } finally { fs.closeSync(fd); }
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

/**
 * Start the track build as a detached child, unless one is running (lock file,
 * the house's own `filelock` pieces). Never builds in the caller, never waits,
 * never throws. 'started' | 'running' | 'error'.
 */
export function kickBuild(root, env = process.env) {
  const lockPath = path.join(root, BUILD_LOCK_PATH);
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { return 'error'; }
  if (!tryLock(lockPath)) {
    if (!takeOverIfStale(lockPath, BUILD_LOCK_MAX_AGE_S)) return 'running';
    if (!tryLock(lockPath)) return 'running';
  }
  try {
    const url = pathToFileURL(path.join(MODULE_DIR, 'memory.mjs')).href;
    // `node -e` runs as CommonJS (so `require` exists); the lock and the root
    // arrive as arguments, not as environment variables.
    const script = `import(${JSON.stringify(url)}).then((m) => { m.buildTimeTracks(process.argv[1]); })
      .catch(() => {})
      .finally(() => { try { require('node:fs').rmSync(process.argv[2], { force: true }); } catch {} });`;
    const child = spawn(process.execPath, ['-e', script, root, lockPath], {
      cwd: root, env: { ...env }, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    return 'started';
  } catch {
    releaseLock(lockPath);
    return 'error';
  }
}
