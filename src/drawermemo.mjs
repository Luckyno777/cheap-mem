// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * drawermemo — read every drawer file ONCE per doctor run, parse it ONCE.
 *
 * **Why (doctor-parity-cm, 2026-10-10).** `mem doctor` is a list of
 * findings, and almost every finding about the entries walks the drawers
 * itself: the integrity scan, topic quality (three walks inside one
 * finding), categories, orphans, contested claims, entry form, repetition,
 * error links, skill sharpening, procedure effect, the rollback watermark,
 * the clock check. Measured on 2026-10-10 (synthetic Heaps corpus, 100 000
 * entries, 13 drawers): every drawer was opened 12 to 17 times per run and
 * parsed as often; the run took ~14 s, of which ~5 s was `readFileSync`,
 * ~3 s the garbage collector clearing the strings and objects the walks
 * left behind. The registers of the sibling house (lucky-mem) cut this
 * with a shared pass; this house has no register, so the same saving
 * comes from sharing what the walks produce: the file text and the
 * parsed lines.
 *
 * **What it is.** A memo that exists only inside {@link runWithMemo}
 * (the doctor wraps `checkAll` in it) and is gone when that returns.
 * Nothing is persisted; the JSONL stays the single source of truth. Outside
 * a run every function here falls straight through to the plain read it
 * replaces.
 *
 * **Safe by construction.**
 *  - A hit is validated against `stat` (size, mtime, inode): a file that
 *    changed during the run is read again, exactly as an unmemoized walk
 *    would have seen it.
 *  - Three states stay three: a missing file, an unreadable file (EISDIR,
 *    EACCES, EIO) and an empty file are never memoized — `rowsOf` and
 *    `textOf` answer `null` for the first two and the caller takes its own
 *    old path, which reports them as it always did.
 *  - Parsed values are handed out as shallow copies, so a consumer that
 *    sorts, annotates or pushes onto what it got cannot change what the
 *    next consumer sees. Test builds can deep-freeze the stored values
 *    (`freeze`) to prove no consumer reaches into nested objects.
 *  - Bounded: a file joins the memo only while the sum of memoized bytes
 *    stays under `maxBytes` (the doctor passes a tenth of the heap limit,
 *    text plus parsed lines need about four times the file size), and no
 *    single file over `MAX_FILE_BYTES` joins. What does not fit is read
 *    the old way, streaming.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A single file above this is never memoized (a V8 string tops out near 512 MiB anyway). */
const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** One value per non-blank line: the parse result, or this when the line is not JSON. */
export const NOT_JSON = Symbol('not-json');

let ACTIVE = null;

const BOM = 0xFEFF;
const withoutBom = (text) => (typeof text === 'string' && text.charCodeAt(0) === BOM ? text.slice(1) : text);

function stampOf(p) {
  const st = fs.statSync(p);
  if (!st.isFile()) return null;
  return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
}
const sameStamp = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/**
 * Run `fn` with the memo switched on. `maxBytes` bounds the memoized file
 * bytes; `freeze` deep-freezes stored values (probes). Re-entrant: inside a
 * run, a nested call just runs `fn`.
 */
export function runWithMemo({ maxBytes, freeze = false }, fn) {
  if (ACTIVE) return fn();
  ACTIVE = { maxBytes, freeze, used: 0, files: new Map() };
  try { return fn(); } finally { ACTIVE = null; }
}

/** Is a memo running right now? */
export function memoActive() { return ACTIVE !== null; }

function load(abs) {
  const memo = ACTIVE;
  if (!memo) return null;
  const key = path.resolve(abs);
  let stamp;
  try { stamp = stampOf(key); } catch { memo.files.delete(key); return null; }
  if (!stamp) { memo.files.delete(key); return null; }
  const have = memo.files.get(key);
  if (have && sameStamp(have.stamp, stamp)) return have;
  if (have) { memo.used -= have.stamp.size; memo.files.delete(key); }
  if (stamp.size > MAX_FILE_BYTES || memo.used + stamp.size > memo.maxBytes) return null;
  let text;
  try { text = fs.readFileSync(key, 'utf8'); } catch { return null; }
  const rec = { stamp, text, raw: null, rows: null };
  memo.used += stamp.size;
  memo.files.set(key, rec);
  return rec;
}

/** The file's text exactly as `fs.readFileSync(abs, 'utf8')` gives it, or `null` (not memoized: read it yourself). */
export function textOf(abs) {
  return load(abs)?.text ?? null;
}

/**
 * The parsed lines of a drawer, or `null` when the memo cannot answer
 * (no run, missing, unreadable, over budget): then read the file the old way.
 *
 * `{ raw, vals, nos, rawLine }`: `raw` is the text without a BOM;
 * `vals[i]` is the parse of the i-th non-blank line or {@link NOT_JSON};
 * `nos[i]` is its 1-based line number in `raw.split('\n')`; `rawLine(i)`
 * the line's text.
 */
export function rowsOf(abs) {
  const rec = load(abs);
  if (!rec) return null;
  if (!rec.rows) {
    const raw = withoutBom(rec.text);
    const lines = raw.split('\n');
    const vals = [];
    const nos = [];
    const failed = new Map();
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      let v;
      try { v = JSON.parse(line); } catch { v = NOT_JSON; failed.set(vals.length, line); }
      if (ACTIVE.freeze && v !== NOT_JSON) deepFreeze(v);
      vals.push(v);
      nos.push(i + 1);
    }
    rec.raw = raw;
    rec.rows = { raw, vals, nos, rawLine: (i) => failed.get(i) ?? lines[nos[i] - 1] };
  }
  return rec.rows;
}

/** A private shallow copy of a stored value (objects and arrays), so consumers cannot disturb each other. */
export function copyOf(v) {
  if (Array.isArray(v)) return v.slice();
  if (v && typeof v === 'object') return { ...v };
  return v;
}

/**
 * The lines as `readLog` and `iterLogFile` deliver them: the parse of each
 * non-blank line, or `{ __broken: true, raw }` for one that is not JSON.
 */
export function entriesOf(rows) {
  const out = new Array(rows.vals.length);
  for (let i = 0; i < out.length; i += 1) {
    const v = rows.vals[i];
    out[i] = v === NOT_JSON ? { __broken: true, raw: rows.rawLine(i) } : copyOf(v);
  }
  return out;
}
