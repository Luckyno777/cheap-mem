// archive.mjs — the raw capture does NOT live in the repository.
//
// **Why this exists.** Reported on 2026-09-08 from a Windows install:
// 9.17 MB of git pack in 75 minutes, one capture 8.6 MB gzipped,
// extrapolated ~50 MB per working day. Looking at the sibling project
// afterwards, `raw/` there was already 46 MB out of a 45.74 MiB pack —
// the memory had become almost nothing but its own raw material.
//
// The drop filter halved the growth. Halved it only: ~22 MB a day is
// still a repository nobody can clone in a year.
//
// And an expiry date alone would have changed nothing. **Git deletes
// nothing.** A removed file is gone from the working tree and still in
// the pack; reclaiming it means rewriting history, which is the one
// operation you do not perform on a shared memory.
//
// Three compression routes were measured first, on real captures, and
// all three were single-digit: word codes 6.8%, a shared gzip
// dictionary 1.9%, exact duplicate lines 0.4%. After gzip there is
// nothing left to squeeze. So the capture goes elsewhere from the
// start, and what stays in the repository is a RECORD — one line
// instead of a megabyte.
//
// **What the record answers without touching the archive:** was there a
// capture, when, how big, what was dropped, where does it live, has it
// been digested. It does NOT answer what is in it — for that you need
// the archive. That is deliberate: a memory that knows its own raw
// material only as a summary can no longer check whether the summary is
// true.
//
// **Why a SHA and not a timestamp.** An archive outside git has no
// history. If someone overwrites a file on the NAS, nothing notices
// without a checksum — and that would be a memory that changes
// unobserved. The SHA sits in the repository, so it is under version
// control, so it is evidence.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * The default is the TRACKED `raw/`, not somewhere gitignored.
 *
 * **What this line got wrong for half a day (2026-09-08).** It read
 * `.mem/raw`, reasoning that `.mem/` is already gitignored so the
 * capture sits in the working tree but outside version history. That
 * holds on a machine with a disk. It is false wherever the repository
 * IS the disk.
 *
 * Measured in the sibling project's own cloud container the same
 * evening: the last capture that reached the repository was at 19:36;
 * eight captures after it sat untracked and would have gone with the
 * container. The session that built the archive would have lost its own
 * record of building it. `test/stop-persists.sh` had been reporting it
 * the whole time, and was on a list as an outdated shell test. It was
 * not outdated.
 *
 * So the order is: whoever has a disk says so (`mem raw archive --set`,
 * `CHEAP_MEM_ARCHIVE`). Whoever says nothing gets the place that
 * survives. Growth is what a migration on a machine that stays is for;
 * nothing is for captures that are gone.
 *
 * Still deliberately NOT an absolute path outside the repository: a
 * default naming a directory that does not exist on the next machine is
 * the bug found the same day — a baked-in path, dead and silent on the
 * second install.
 */
export const DEFAULT_LOCATION = 'raw';

/** The record. TRACKED and append-only — this is what stays in the repo. */
export const RECORD_FILE = 'raw-record.jsonl';

/**
 * What this file was called for half a day.
 *
 * The archive was ported from a German-language sibling project and the
 * record kept its German name — in a codebase whose every other
 * identifier is English. Nobody would have found it by guessing.
 *
 * It is not simply renamed away: a memory that already captured under
 * the old name would silently start a second, empty record, and the
 * first one would look like it had never existed. `records()` reads the
 * old file when the new one is absent, and `writeRecord()` moves it
 * across once, before appending.
 */
export const LEGACY_RECORD_FILE = 'raw-nachweis.jsonl';

/** The record file in use here, preferring the current name. */
function recordPath(root) {
  const now = path.join(root, RECORD_FILE);
  if (fs.existsSync(now)) return now;
  const old = path.join(root, LEGACY_RECORD_FILE);
  return fs.existsSync(old) ? old : now;
}

/** The old location. Stays READABLE so nothing already there vanishes. */
export const OLD_DIR = 'raw';

/**
 * Known archive kinds.
 *
 * A closed vocabulary rather than a free string: a location whose kind
 * nobody recognises would otherwise be treated as a file path and drop
 * the capture somewhere arbitrary. Adding a kind means editing this
 * list — which is visible in a diff.
 */
export const KINDS = Object.freeze(['file']);

/**
 * Where does the archive live?
 *
 * Forms: `/absolute/path`, `relative/path`, `file:///absolute/path`.
 * Cloud targets (a NAS share, an object store, a synced drive) are
 * attached by the operating system and are therefore `file:` as well.
 * That saves an adapter nobody could have tested; a real network
 * adapter arrives when there is a target to measure it against.
 */
export const LOCATION_FILE = path.join('.mem', 'archive.json');

/** Strip `file://` — otherwise the scheme becomes part of the path. */
function stripScheme(raw) {
  return raw.startsWith('file://') ? raw.slice('file://'.length) : raw;
}

export function readConfig(env = process.env, root = '.') {
  const fromEnv = String(env.CHEAP_MEM_ARCHIVE ?? '').trim();
  if (fromEnv) {
    return { kind: 'file', location: path.resolve(root, stripScheme(fromEnv)), source: 'env', explicit: true };
  }

  // The machine-local file. It sits under `.mem/`, so it is gitignored
  // and does NOT travel — exactly right for a path that exists on this
  // one machine only.
  //
  // **Why it exists at all.** Capturing happens in several places: a
  // session's stop hook, the watcher, the digest. Naming the archive in
  // each of them would rebuild the bug found the same day — a path in
  // five places, one of which gets forgotten at the next rebuild.
  //
  // Set once, read everywhere. The environment variable still wins, so
  // a single run can divert without reconfiguring the machine.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, LOCATION_FILE), 'utf8'));
    const loc = String(raw?.location ?? '').trim();
    if (loc) {
      return { kind: 'file', location: path.resolve(root, stripScheme(loc)), source: 'file', explicit: true };
    }
  } catch { /* no file, broken file — then the default */ }

  return { kind: 'file', location: path.resolve(root, DEFAULT_LOCATION), source: 'default', explicit: false };
}

/**
 * Set the location for THIS machine.
 *
 * Verifies it can be written BEFORE saving. An entry pointing at an
 * unwritable directory would make every future capture fail — and only
 * once somebody is in the middle of working. Better to refuse here.
 *
 * The write probe covers what `mkdirSync` waves through: a directory
 * that EXISTS but cannot be written to. That case is not covered by a
 * test, and the test file says why — it cannot be produced while the
 * suite runs as root, measured rather than assumed.
 */
export function setLocation(root, location) {
  const target = path.resolve(root, stripScheme(String(location).trim()));
  fs.mkdirSync(target, { recursive: true });
  const probe = path.join(target, `.writeprobe-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);

  const file = path.join(root, LOCATION_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ location: target }, null, 2)}\n`, 'utf8');
  return { location: target, file };
}

/**
 * The path INSIDE the archive.
 *
 * A capture's identifier stays `raw/YYYY/MM/…` — the record, the digest
 * ledger and every stored citation hang off it. It must NOT change
 * during the move, or the entire existing corpus points at nothing.
 *
 * Inside the archive that prefix would only nest pointlessly
 * (`.mem/raw/raw/2026/…`), so it is dropped here. The identifier stays,
 * the layout gets flatter — the same distinction as between a book's
 * catalogue number and the shelf it happens to stand on.
 */
export function pathInArchive(relPath) {
  const parts = String(relPath).split(/[/\\]/).filter(Boolean);
  if (parts[0] === OLD_DIR) parts.shift();
  return path.join(...parts);
}

/** Checksum. Not for security — for the question "is this still the same". */
export function checksum(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Puts a capture into the archive and returns the body of its record.
 *
 * Throws when the archive is not writable. The caller decides what to
 * do then — and must NOT quietly fall back to the repository, because
 * that would undo the entire exercise while looking like nothing
 * happened.
 */
export function put(archive, relPath, data) {
  const target = path.join(archive.location, pathInArchive(relPath));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return {
    location: `${archive.kind}://${target}`,
    bytes: data.length,
    sha256: checksum(data),
  };
}

/**
 * Fetches a capture.
 *
 * Looks in the archive FIRST, then at the old location in the repo. The
 * order matters: after the move the archive is the truth, and a leftover
 * copy must not be allowed to shadow it.
 *
 * Returns `null` rather than throwing — a capture that is unreachable
 * (NAS off, drive not mounted) is an ordinary operating condition, not a
 * programming error. The caller must SAY so, though, and never report it
 * as "nothing found".
 */
export function get(archive, root, relPath) {
  const inArchive = path.join(archive.location, pathInArchive(relPath));
  if (fs.existsSync(inArchive)) return fs.readFileSync(inArchive);
  const old = path.join(root, relPath);
  if (fs.existsSync(old)) return fs.readFileSync(old);
  return null;
}

/**
 * The actual file path of a capture — or `null`.
 *
 * Needed wherever the CONTENT is not what matters but the file itself:
 * size, line count, the tail hash the index cache compares against.
 *
 * Why this is a function and not a `path.join`: that exact
 * `path.join(root, relPath)` sat in five places in the sibling project's
 * search module, and after the move every one of them failed — with
 * `continue` and no message. New captures would never have entered the
 * index, the cache would never have gone stale, and the search would
 * have quietly served yesterday. An existing test caught it.
 */
export function filePath(archive, root, relPath) {
  const inArchive = path.join(archive.location, pathInArchive(relPath));
  if (fs.existsSync(inArchive)) return inArchive;
  const old = path.join(root, relPath);
  if (fs.existsSync(old)) return old;
  return null;
}

/** Is the capture anywhere at all? */
export function reachable(archive, root, relPath) {
  return fs.existsSync(path.join(archive.location, pathInArchive(relPath)))
    || fs.existsSync(path.join(root, relPath));
}

/**
 * Does a record belong to THIS machine's store at all?
 *
 * `location` — written by `put()` as `file:///abs/path` — is the truth;
 * `path` is only a shorthand for the case where the archive sits inside
 * the repository. Across machines the shorthand is misleading: two
 * checkouts of the same memory produce the same `path` and entirely
 * different files.
 *
 * The distinction is not polish. Missing bytes for a capture that
 * belongs here are a DEFECT; missing bytes for one recorded into
 * another machine's store are the normal case. Painting them the same
 * colour either hides the defect or turns the normal case into a
 * standing alarm — and a standing alarm gets clicked away, taking the
 * real defect with it.
 *
 * Returns `{target, here}`; `target` is the resolved absolute path.
 */
export function locationState(root, rec, archive = readConfig(process.env, root)) {
  const strip = (u) => String(u).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const fromLocation = rec?.location ? path.resolve(strip(rec.location)) : null;
  const fromPath = rec?.path ? path.resolve(root, String(rec.path)) : null;
  const target = fromLocation ?? fromPath;
  if (!target) return { target: null, here: false };
  const store = path.resolve(archive.location);
  const legacy = path.resolve(root, OLD_DIR);
  const here = target === store || target.startsWith(`${store}${path.sep}`)
    || target === legacy || target.startsWith(`${legacy}${path.sep}`);
  return { target, here };
}

/** Every record, oldest first. */
export function records(root) {
  const p = recordPath(root);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a broken line */ }
  }
  return out;
}

/** Append one record. Append-only — never rewrite a line. */
export function writeRecord(root, row) {
  const target = path.join(root, RECORD_FILE);
  // The one-time move. Rename, never copy: two files holding the same
  // append-only record is the two-truths class, and the second writer
  // would win silently.
  if (!fs.existsSync(target)) {
    const old = path.join(root, LEGACY_RECORD_FILE);
    if (fs.existsSync(old)) fs.renameSync(old, target);
  }
  fs.appendFileSync(target, `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * The mark that turns a register row into a tombstone.
 *
 * A capture row and a deletion row live in the same append-only file,
 * so they must be told apart by a field somebody WROTE — never by
 * guessing from which other fields happen to be present. Guessing is
 * how a broken line becomes an invisible one.
 */
export const DELETED_MARK = 'deleted';

/**
 * Delete the BYTES of a capture and leave a tombstone.
 *
 * **Why not just remove the file.** This file's own opening says it:
 * git deletes nothing. A capture taken out of the working tree is gone
 * from the checkout and still in every clone's history — which is
 * exactly why captures were moved OUT of the repository in the first
 * place. So a deletion that means anything has to happen where the
 * bytes really are: in the archive, outside git.
 *
 * **And why a tombstone rather than silence.** The register is
 * append-only. Removing the capture row would be a rewrite, and it
 * would also destroy the one thing worth keeping: that this capture
 * existed, and that somebody decided it should not any more. The row
 * stays, a second row says it was deleted, and the listing shows three
 * states instead of two — present, deleted with a reason, or
 * unreachable, which is a defect and not a decision.
 *
 * Refuses a path the register has never seen. Deleting something that
 * was never recorded means a typo, and a delete that shrugs at a typo
 * is one that eventually removes the wrong thing.
 */
export function remove(archive, root, relPath, {
  reason = '', by = 'unknown', now = new Date(),
} = {}) {
  const known = records(root).some((r) => r?.path === relPath && r?.record !== DELETED_MARK);
  if (!known) {
    throw new Error(`No capture '${relPath}' in the register. Nothing was deleted.`);
  }
  const already = deletions(root).get(relPath);
  if (already) {
    // Not an error: deleting twice is a person clicking twice. But it
    // must not append a second tombstone, or the register would say the
    // bytes were freed twice.
    return { path: relPath, state: 'already', freed: 0, at: already.at };
  }

  const file = filePath(archive, root, relPath);
  let freed = 0;
  if (file) {
    try { freed = fs.statSync(file).size; } catch { freed = 0; }
    fs.unlinkSync(file);
  }
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeRecord(root, {
    record: DELETED_MARK,
    path: relPath,
    deleted_at: at,
    // The reason is not decoration. A tombstone without one answers
    // "was this deliberate?" with a shrug.
    reason: String(reason ?? ''),
    by: String(by ?? 'unknown'),
    freed_bytes: freed,
    // Three states, again: the bytes were there and are now gone, or
    // they were already missing before anyone asked.
    bytes_were_there: Boolean(file),
  });
  return { path: relPath, state: file ? 'deleted' : 'tombstoned', freed, at };
}

/** Every tombstone, by path. The LAST one wins if there were several. */
export function deletions(root) {
  const out = new Map();
  for (const r of records(root)) {
    if (r?.record !== DELETED_MARK || !r?.path) continue;
    out.set(r.path, {
      at: r.deleted_at ?? null,
      reason: r.reason ?? '',
      by: r.by ?? 'unknown',
      freed: Number(r.freed_bytes ?? 0),
      bytesWereThere: r.bytes_were_there !== false,
    });
  }
  return out;
}

/**
 * Captures within a time range.
 *
 * `from`/`to` are ISO instants (a bare date is enough). `hourFrom` and
 * `hourTo` additionally clip EVERY day to a window — meant for "what
 * happened last week between 9 and 12", not for one continuous stretch.
 *
 * The instant comes from `ts_to` (the end of the span) and falls back to
 * `captured_at`. Using `ts_from` would be wrong: a capture starting at
 * 23:50 and ending at 00:10 belongs to both days, and the end is the
 * moment it enters the memory.
 */
export function inRange(rows, { from, to, hourFrom, hourTo } = {}) {
  const fromT = from ? Date.parse(from.length <= 10 ? `${from}T00:00:00Z` : from) : -Infinity;
  const toT = to ? Date.parse(to.length <= 10 ? `${to}T23:59:59Z` : to) : Infinity;
  return rows.filter((s) => {
    const when = s.ts_to ?? s.captured_at;
    if (!when) return false;
    const t = Date.parse(when);
    if (Number.isNaN(t) || t < fromT || t > toT) return false;
    if (hourFrom == null && hourTo == null) return true;
    const h = new Date(t).getUTCHours();
    if (hourFrom != null && h < hourFrom) return false;
    if (hourTo != null && h > hourTo) return false;
    return true;
  });
}

/**
 * Move what is already in the repository into the archive.
 *
 * **What it does NOT do: make the repository smaller.** Git keeps its
 * history; after `git rm` the file is gone from the working tree and
 * still in the pack. The move stops the GROWTH and reclaims nothing.
 * Actually reclaiming it means rewriting history — a decision for the
 * repository's owner, not for a script, and deliberately not automated
 * here.
 *
 * Copy, verify, and only THEN remove, in that order. A move that
 * deletes before it writes loses exactly what it was meant to save on
 * every interruption.
 */
export function migrate(archive, root, paths, { remove = false } = {}) {
  const done = [];
  const skipped = [];
  const known = new Set(records(root).map((n) => n.path));

  for (const relPath of paths) {
    const src = path.join(root, relPath);
    if (!fs.existsSync(src)) { skipped.push({ path: relPath, reason: 'not-there' }); continue; }
    if (known.has(relPath)) { skipped.push({ path: relPath, reason: 'already-recorded' }); continue; }

    const data = fs.readFileSync(src);
    const ablage = put(archive, relPath, data);

    // Read it back before anything disappears.
    // Comparing sizes would be cheaper and would wave a half-written
    // file straight through.
    const back = get(archive, root, relPath);
    if (!back || checksum(back) !== ablage.sha256) {
      skipped.push({ path: relPath, reason: 'checksum-mismatch' });
      continue;
    }

    // Take the time span from the header so the range export works for
    // migrated captures too.
    let header = null;
    try {
      const text = zlib.gunzipSync(data).toString('utf8');
      header = JSON.parse(text.split('\n')[0]);
    } catch { /* then without it */ }

    writeRecord(root, {
      stempel: header?.__stempel ?? null,
      path: relPath,
      captured_at: header?.__gefangen_am ?? null,
      ts_from: header?.__ts_von ?? null,
      ts_to: header?.__ts_bis ?? header?.__gefangen_am ?? null,
      lines: header?.__zeilen ?? null,
      ...ablage,
      migrated: true,
    });
    if (remove) fs.unlinkSync(src);
    done.push(relPath);
  }
  return { done, skipped };
}
