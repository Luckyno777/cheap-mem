// shardarchive.mjs — P17: git does not carry a 4.8 GB body.
//
// **The number this was built against, and what re-measuring it found.**
// The build plan (messung/2026-09-20-bauplan.md, P17) cites 166.2 B/entry
// in `learnings.jsonl`, projecting ~792 MB per drawer type and ~4.8 GB
// body at 5,000,000 entries. Re-running the SAME generator
// (`bench/atlas/core.mjs`'s `buildCorpus`, seed 42, unmodified — this
// file does not touch bench/) on the current tree gives a different
// number: ~974 B/entry in `learnings.jsonl` at 40,000 entries, and
// ~962-1861 B/entry across the other ten drawer types (mean ~1253 B/entry
// counting every type together). That is roughly 6-7x the cited figure,
// not a rounding difference — and it lines up with the REAL corpus
// measurement in messung/2026-09-20-messreihe.md ("ganzer Eintrag p50
// 979 B, Mittel 1030 B" over 2,286 real entries), where the old
// synthetic 166.2 B figure does not. This matches a finding already on
// record in this house's own memory: "Ein synthetischer Korpus aus
// Kurzeintraegen misst Retrieval um eine Groessenordnung falsch" — the
// same order-of-magnitude gap. Something in the generator's entry-length
// shaping changed between the run that produced 166.2 and now (this repo
// is shared by several agents working in parallel; this file does not
// speculate which change did it). The honest number to design against is
// the higher one: a single drawer type projects to roughly 4.6-9.3 GB at
// 5,000,000 entries, not 792 MB — the problem this build point exists
// for is WORSE than the brief states, not smaller. See this module's
// tests for the exact reproduction.
//
// **The move.** Same shape as `archive.mjs`'s move for raw captures:
// nothing is deleted, only its address changes. There, a capture's
// bytes leave the repository and a one-line RECORD stays behind. Here,
// an entry's raw JSONL line leaves the tracked drawer file and a
// one-line MANIFEST row stays behind: id -> shard file -> byte offset
// -> length -> checksum. The manifest is small, append-only, and
// travels in every clone; the shard files do not.
//
// **What "a shard" means here, honestly.** P16 (writer x period shard
// files) does not exist in this tree yet — there is one JSONL file per
// TYPE, not per writer-period. So "a shard" in this module is a byte
// range carved out of that one file: `archiveOldest` moves the oldest
// `count` lines of a drawer into one archive file and shrinks the
// tracked file by exactly that many lines. Once P16 lands, archiving one
// whole young-shard file at a time is a smaller change to
// `archiveOldest`'s selection logic, not a redesign of the manifest or
// of `resolveEntry` below — the addressing scheme does not assume any
// particular shard shape.
//
// **What this module does NOT attempt, and why.** The build plan asks
// for id-to-location-to-offset addressing through "the register" — which
// does not exist as production code, only as a benchmark prototype at
// `bench/atlas/phase-register.mjs` (read for this build point, not
// extended: the brief is explicit that half a register is worse than no
// register). Full-text SEARCH over archived material at corpus scale
// needs that index — without it, the only honest way to search archived
// content is to read every archived shard byte for byte, which
// `findWithArchiveNotice` below does, plainly, and labels as what it is
// (a linear scan, fine at this build point's scale, not a substitute for
// the register at 5,000,000 entries). What IS fully built and tested
// here, independent of the register: the addressing scheme (id -> shard
// -> offset -> length -> checksum), the by-id redirect, and the third
// state — the parts the brief says to build even if the register is not
// there to build on.
//
// **The one property everything below is checked against:** a clone
// without the archive must answer every question a full clone answers —
// either with the answer, or with an honest "this lives in the archive,
// here is the way to it". Never a silent nothing. See resolveEntry's
// NOT_MEASURED branch and findWithArchiveNotice's `notice` field.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as memory from './memory.mjs';
import * as archive from './archive.mjs';
import * as capability from './capability.mjs';
import { LEVEL } from './doctor.mjs';
import { appendLine } from './append.mjs';

/** Four states, never two — reusing this house's own vocabulary. */
export const PASS = LEVEL.GOOD;
export const DEGRADED = LEVEL.WARN;
export const FAIL = LEVEL.ERROR;
export const NOT_MEASURED = LEVEL.UNKNOWN;

/** The register source: tracked, append-only, travels in every clone. */
export const MANIFEST_FILE = 'archive-manifest.jsonl';

/** Where shard files live inside whatever `archive.mjs` points at. */
export const SHARD_SUBDIR = 'shards';

function manifestPath(root) {
  return path.join(root, MANIFEST_FILE);
}

/** Every manifest row, oldest first. A broken line is marked, not dropped. */
export function readManifest(root) {
  const p = manifestPath(root);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ __broken: true, raw: line.slice(0, 120) }); }
  }
  return out;
}

function appendManifest(root, row) {
  appendLine(manifestPath(root), `${JSON.stringify(row)}\n`);
}

/** The most recent manifest row for an id, or null. Append-only: last wins. */
function manifestById(root, id) {
  let found = null;
  for (const row of readManifest(root)) {
    if (row && !row.__broken && row.id === id) found = row;
  }
  return found;
}

/**
 * Move the oldest `count` lines of one drawer into one archive shard
 * file, and shrink the tracked file by exactly those lines.
 *
 * Order of operations matters: the archive write happens FIRST and the
 * tracked file is only shrunk once it has succeeded. If the process
 * dies in between, the entries exist in BOTH places — recoverable by
 * re-running (the manifest write is what makes a line "archived", so a
 * duplicate that never got a manifest row is simply archived again,
 * harmlessly overwriting the same bytes at a fresh offset). The
 * opposite order — shrink first, archive after — can produce entries in
 * NEITHER place, which is the one outcome append-only memory exists to
 * rule out.
 */
export function archiveOldest(root, type, { project = null, count } = {}) {
  const { path: drawerFile, missing, entries } = memory.readLog(root, type, { project });
  if (missing || entries.length === 0) {
    return { archived: 0, reason: 'drawer is empty or missing' };
  }
  const n = Math.min(Number(count) || 0, entries.length);
  if (n <= 0) return { archived: 0, reason: 'count is 0 or not given' };

  const rawLines = fs.readFileSync(drawerFile, 'utf8').split('\n').filter((l) => l.trim());
  const moving = rawLines.slice(0, n);
  const staying = rawLines.slice(n);

  const cfg = archive.readConfig(process.env, root);
  const shardDir = path.join(cfg.location, SHARD_SUBDIR);
  fs.mkdirSync(shardDir, { recursive: true });
  // `Date.now()` + pid alone collide when two calls land in the same
  // process within the same millisecond (measured: this test suite's
  // own two-shard sabotage probe hit exactly that). A few random bytes
  // make the name unique regardless of timing.
  const shardName = `${type}${project ? `__${project}` : ''}-${Date.now()}-${process.pid}-`
    + `${randomBytes(4).toString('hex')}.jsonl`;
  const shardFile = path.join(shardDir, shardName);

  let offset = 0;
  const manifestRows = [];
  const out = [];
  for (const line of moving) {
    const bytes = Buffer.byteLength(line, 'utf8');
    let id = null;
    try { id = JSON.parse(line).id ?? null; } catch { /* keep null, still archived and addressable by offset */ }
    manifestRows.push({
      id, type, project, shard: shardName, offset, length: bytes,
      checksum: archive.checksum(Buffer.from(line, 'utf8')),
      archivedAt: new Date().toISOString(),
    });
    out.push(`${line}\n`);
    offset += bytes + 1; // the newline this format writes between lines
  }
  appendLine(shardFile, out.join(''));

  // The archive write above succeeded — only now shrink the tracked
  // file. See the doc comment above for why this order, not the other.
  fs.writeFileSync(drawerFile, staying.length ? `${staying.join('\n')}\n` : '', 'utf8');

  for (const row of manifestRows) appendManifest(root, row);

  return {
    archived: manifestRows.length, shard: shardName, location: cfg.location,
    drawerBytesBefore: Buffer.byteLength(rawLines.join('\n'), 'utf8'),
    drawerBytesAfter: Buffer.byteLength(staying.join('\n'), 'utf8'),
  };
}

/** Read exactly `row.length` bytes at `row.offset` from its shard. Throws when unreachable. */
function readArchivedBytes(cfg, row) {
  const shardFile = path.join(cfg.location, SHARD_SUBDIR, row.shard);
  const fd = fs.openSync(shardFile, 'r'); // ENOENT when the shard/dir/mount is absent
  try {
    const buf = Buffer.alloc(row.length);
    fs.readSync(fd, buf, 0, row.length, row.offset);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Resolve one entry by id — archive-aware `memory.getEntry`.
 *
 * Three outcomes, never a fourth silent one:
 *  - PASS, source 'live': found in the tracked corpus, exactly as
 *    `memory.getEntry` would return it. A full clone (or one where the
 *    entry was never archived) sees no difference at all.
 *  - PASS, source 'archive': not in the tracked corpus, but its manifest
 *    row points at reachable, checksum-verified bytes. The caller gets
 *    the real entry back, marked `_archived: true`.
 *  - NOT_MEASURED: the manifest KNOWS this id was archived, but its
 *    shard cannot be read right now (missing archive, unmounted disk,
 *    wrong `.mem/archive.json`). This is the state a silent "not found"
 *    would hide. The result carries a `redirect` naming exactly where
 *    the bytes live and how to reach them.
 *  - FAIL: genuinely no such id, live or archived — or the archived
 *    bytes were read but do not match their recorded checksum (the
 *    archive answered, but with the wrong thing, which is not "pass").
 */
export function resolveEntry(root, id) {
  const live = memory.getEntry(root, id);
  if (live) return { state: PASS, entry: live, source: 'live' };

  const row = manifestById(root, id);
  if (!row) {
    return { state: FAIL, reason: `no entry '${id}' — not in the live corpus, not in ${MANIFEST_FILE}` };
  }

  const cfg = archive.readConfig(process.env, root);
  let raw;
  try {
    raw = readArchivedBytes(cfg, row);
  } catch (e) {
    return {
      state: NOT_MEASURED,
      reason: `entry '${id}' is archived (see ${MANIFEST_FILE}) but its archive is unreachable `
        + `right now (${e.code || e.message})`,
      redirect: {
        id, type: row.type, project: row.project, shard: row.shard,
        offset: row.offset, length: row.length,
        expectedPath: path.join(cfg.location, SHARD_SUBDIR, row.shard),
        howTo: `point CHEAP_MEM_ARCHIVE (or .mem/archive.json, see archive.setLocation) at a `
          + `location that has ${SHARD_SUBDIR}/${row.shard}, then ask again — the entry sits at `
          + `byte offset ${row.offset}, length ${row.length}`,
      },
    };
  }

  const sum = archive.checksum(Buffer.from(raw, 'utf8'));
  if (sum !== row.checksum) {
    return {
      state: FAIL,
      reason: `entry '${id}' was read from the archive but its checksum does not match the `
        + `manifest — the archived bytes changed since they were moved`,
      redirect: {
        id, shard: row.shard, offset: row.offset, length: row.length,
        expectedChecksum: row.checksum, gotChecksum: sum,
      },
    };
  }

  let entry;
  try { entry = JSON.parse(raw); } catch { entry = { __broken: true, raw: raw.slice(0, 200) }; }
  return {
    state: PASS,
    source: 'archive',
    entry: { ...entry, _archived: true, _shard: row.shard, _type: row.type, _project: row.project },
  };
}

/**
 * The archive's overall state as seen from THIS clone: is every shard
 * the manifest names actually reachable right now?
 *
 * PASS with archivedCount 0 covers the ordinary case (nothing has ever
 * been archived) and the good case (everything archived is reachable)
 * identically — a caller checking `.state` alone cannot tell "nothing to
 * find" from "found everything", which is correct: neither one changes
 * what a search should report.
 */
export function archiveStatus(root) {
  const manifest = readManifest(root).filter((r) => !r.__broken);
  if (manifest.length === 0) {
    return { state: PASS, archivedCount: 0, reachableShards: 0, unreachableShards: 0, shards: [] };
  }
  const cfg = archive.readConfig(process.env, root);
  const shardNames = [...new Set(manifest.map((r) => r.shard))];
  const shards = shardNames.map((name) => ({
    name, reachable: fs.existsSync(path.join(cfg.location, SHARD_SUBDIR, name)),
  }));
  const unreachable = shards.filter((s) => !s.reachable);
  const state = unreachable.length === 0 ? PASS
    : unreachable.length === shards.length ? NOT_MEASURED
    : DEGRADED;
  return {
    state, archivedCount: manifest.length, location: cfg.location,
    reachableShards: shards.length - unreachable.length, unreachableShards: unreachable.length, shards,
  };
}

/**
 * `memory.find`, plus an honest word about what it could not see.
 *
 * This is the search-side sibling of `resolveEntry`: when nothing has
 * been archived, or the archive is fully reachable, behaviour matches a
 * full clone exactly (results include archived hits too, read straight
 * off disk — no index, so this is a linear scan of every archived shard,
 * fine at this build point's scale, NOT what should run at 5,000,000
 * entries; the register in P10 is what makes that fast, and it does not
 * exist yet, see this file's header). When a shard the manifest names is
 * unreachable, the live results still come back — never withheld — but
 * `notice` says plainly that the answer may be incomplete, how many
 * archived entries could not be checked, and where to look
 * (`archive-manifest.jsonl`) to find out which ones.
 *
 * **Not wired to any CLI or MCP entry point today** — confirmed by
 * grepping every caller of this file's exports; only its own test
 * suite calls it. Kept working rather than deleted, since the archive
 * feature it belongs to (P10-adjacent) is real, but that also means
 * nothing external has ever asked it for a narrower scope. `memory.find`
 * now requires a Capability (issue #136); this always-full-reach helper
 * mints its own full grant the same way `viewer.collect`/
 * `broadcast.recipients` do, rather than growing a parameter no caller
 * — real or in this file's own tests — has ever used.
 */
export function findWithArchiveNotice(root, pattern, opts = {}) {
  const liveHits = memory.find(root, pattern, capability.grantAll('shardarchive'), opts);
  const status = archiveStatus(root);

  if (status.archivedCount === 0) {
    return { hits: liveHits, state: PASS, notice: null, archiveStatus: status };
  }

  if (status.unreachableShards === 0) {
    const cfg = archive.readConfig(process.env, root);
    const needle = String(pattern).toLowerCase();
    const archiveHits = [];
    for (const row of readManifest(root)) {
      if (row.__broken) continue;
      try {
        const raw = readArchivedBytes(cfg, row);
        if (raw.toLowerCase().includes(needle)) {
          let entry;
          try { entry = JSON.parse(raw); } catch { entry = { __broken: true, raw: raw.slice(0, 200) }; }
          archiveHits.push({
            ...entry, _archived: true, _shard: row.shard,
            _source: `${row.type}${row.project ? `/${row.project}` : ''}`,
          });
        }
      } catch { /* a shard vanishing mid-scan is exactly what archiveStatus above already covers */ }
    }
    return { hits: [...liveHits, ...archiveHits], state: PASS, notice: null, archiveStatus: status };
  }

  return {
    hits: liveHits,
    state: status.state,
    notice: `${status.archivedCount} archived entr${status.archivedCount === 1 ? 'y' : 'ies'} in `
      + `${status.unreachableShards} of ${status.shards.length} shard(s) could not be searched — `
      + `the archive at ${status.location} is unreachable for them right now. This result may be `
      + `incomplete. See ${MANIFEST_FILE} for exactly what is archived and where it should be.`,
    archiveStatus: status,
  };
}
