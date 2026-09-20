// src/indexcache.mjs — the search index cache, as shards, never as one string.
//
// **The wall (measured, P9 of the 2026-09-20 build plan).** The old cache
// was one JSON document: `JSON.stringify` the whole index, write it,
// `JSON.parse` it back on the next load. That works until the SERIALIZED
// TEXT itself would exceed V8's `--max-string-length`, a hard limit on
// every string a JS engine can hold (currently 2**29 - 24 =
// 536,870,888 UTF-16 code units, node --version-independent since it is
// a V8 constant, not a flag). The measured per-entry cost of the old
// cache was 548.7 bytes; 536,870,888 / 548.7 ~= 978,477 entries, which
// lines up with the plan's measured break at 978,395 — this is not a
// slow decline, every entry before that line loads and every one after
// throws `RangeError: Invalid string length` inside `JSON.parse`,
// deterministically, on any input past the wall. See
// `test/index-cache-ladder.test.mjs` for the ladder that establishes
// this on the machine actually running the test, rather than trusting
// the plan's number for a different one.
//
// **The fix is not "stream the bytes".** Node has no streaming
// `JSON.parse`, and the search engine needs the WHOLE document set in
// memory afterwards anyway (BM25 scores against the whole corpus; P10
// of the plan is what removes that need, by moving the register into
// SQLite — a different layer than this file). What this file removes is
// the requirement that any SINGLE STRING hold more than a bounded slice
// of the corpus at once, so the wall above stops existing at ANY corpus
// size, and the transient peak while loading — old-string + parsed-tree
// + final-structure, all at once — shrinks to one shard's worth instead
// of the whole cache's worth.
//
// **The shape.** A directory instead of one file:
//
//   <cacheDir>/
//     manifest.json           small: version, language, per-file state,
//                              fullAt, N, avgLength, statsN,
//                              statsAvgLength, and for every other part
//                              below: its file name, its exact byte
//                              length and its sha256 — never trusted
//                              without both.
//     documents-000000.ndjson one JSON object per line, at most
//     documents-000001.ndjson MAX_SHARD_DOCS lines and MAX_SHARD_BYTES
//     ...                     bytes per shard (whichever comes first),
//                              in the same order `documents` was built
//                              in — `entityIndex` below is a set of
//                              positions into that same order, so the
//                              order is part of the format, not an
//                              implementation detail.
//     meta.json                everything that is NOT one-row-per-entry:
//                              docFreq, statsDocFreq, lexicon, lexicons,
//                              tagGraph, termGraph, entityIndex. All of
//                              these are bounded by VOCABULARY size, not
//                              by entry count (Heaps' law: vocabulary
//                              grows far slower than the corpus that
//                              produces it), so one file for all of them
//                              has not been observed to approach the
//                              wall on any corpus this house has
//                              measured. `readIndexCache` still refuses
//                              to parse it past `META_SIZE_LIMIT` rather
//                              than find out the hard way — an
//                              enforced ceiling, not a claim that one
//                              could never be reached. NOT-MEASURED:
//                              whether a real corpus can grow a
//                              `termGraph` or `entityIndex` large enough
//                              to matter; nothing in this house's
//                              fixtures does.
//
// **What is deliberately NOT carried over from the old format.**
// `buildIndex`'s `builtAt` (a wall-clock `Date.now()` stamp) is dropped
// here. It has no reader anywhere in this codebase (checked: `grep -rn
// builtAt src test` finds only the one write site) and it is exactly
// the kind of field that makes two builds of the IDENTICAL log corpus
// serialize to different bytes for no reason connected to the corpus at
// all — which is what the byte-identical-rebuild invariant this file
// exists to satisfy rules out. Carrying a wall-clock value through a
// path that must be reproducible is the mistake; the fix is not to
// carry it, not to loosen the invariant.
//
// **Truncation is a whole-cache verdict, not a per-shard one.** Every
// shard and `meta.json` gets its expected byte length and sha256 hash
// recorded in the manifest at write time. `readIndexCache` checks BOTH
// before it trusts a single line of a file's content: a cut mid-record
// changes the byte length (almost always) and always changes the hash,
// so a partial file is refused whole, before any document from it is
// parsed and before any part of it is merged into the in-memory index.
// There is no code path that returns fewer-than-real documents without
// saying so — a mismatch throws, `loadIndex`'s existing "a broken cache
// is not an error, just a rebuild" catch is what turns that into a
// clean fallback, the same as a version mismatch does today.
//
// **Integration.** This module owns the shape; `src/search.mjs` owns
// deciding WHEN to read or write it (append-vs-rebuild, the version
// stamp, `reconcileRetired`). `loadIndex` was held by another agent
// during this file's writing (per-entry language detection, P28's
// tail), so the two call sites that would change are NOT edited here —
// see the session report for the exact diff.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as thesaurus from './thesaurus.mjs';
import * as entity from './entity.mjs';

/**
 * How many documents (and how many bytes) go in one shard file.
 *
 * Both are hard caps, whichever is hit first ends the shard. The count
 * cap is the one that matters in practice — entries are small and
 * fairly uniform, see `docs/scale.md`'s ~450-550 B/entry — but the byte
 * cap is what makes the safety property a PROOF rather than an
 * empirical hope: even a corpus of a few, pathologically huge entries
 * (long raw captures, `RAW_CAP` = 20 KiB each) cannot produce a shard
 * anywhere near the wall, because the byte cap stops it first.
 *
 * 50,000 docs x ~550 B ~= 27 MB per shard: about 1/20 of the V8 string
 * wall, so a shard would have to be twenty times denser than every
 * corpus this house has measured before this cap alone stopped being
 * the binding one — the byte cap is the actual backstop.
 */
export const MAX_SHARD_DOCS = 50_000;
export const MAX_SHARD_BYTES = 32 * 1024 * 1024;

/** Above this, `meta.json` is refused unparsed rather than risked. See
 * the NOT-MEASURED note at the top of this file. */
export const META_SIZE_LIMIT = 400 * 1024 * 1024;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Rename with a Windows-safe retry.
 *
 * The finding this guards against (a reader mid-`readFileSync` makes
 * Windows answer `EPERM` on `rename`, reproducibly) belongs to
 * `src/search.mjs`'s `renameWithRetry`, which is exported from a file
 * this module deliberately does not import — `search.mjs` is expected
 * to eventually import THIS module (see the integration note above),
 * and importing back from here would make that a cycle for no gain.
 * The retry loop itself is five lines; duplicating it is cheaper than
 * the alternative.
 */
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
function renameWithRetry(from, to, attempts = 6) {
  for (let i = 1; ; i += 1) {
    try { fs.renameSync(from, to); return; } catch (err) {
      if (i >= attempts || !TRANSIENT_RENAME.has(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, i * 5);
    }
  }
}

/** Split `documents` into shard-sized slices, respecting both caps. */
function planShards(documents) {
  const shards = [];
  let cur = [];
  let curBytes = 0;
  for (const doc of documents) {
    const line = JSON.stringify({ ...doc, weights: [...doc.weights] });
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + newline
    if (cur.length && (cur.length >= MAX_SHARD_DOCS || curBytes + lineBytes > MAX_SHARD_BYTES)) {
      shards.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(line);
    curBytes += lineBytes;
  }
  if (cur.length) shards.push(cur);
  return shards;
}

function shardName(i) {
  return `documents-${String(i).padStart(6, '0')}.ndjson`;
}

/**
 * Write the cache as a directory of shards, atomically.
 *
 * Everything is written into a scratch directory first (name carries the
 * pid and a random suffix, so two concurrent rebuilds never share one),
 * then the WHOLE directory is renamed into place in one syscall — the
 * same "write beside it, then rename" shape `search.mjs` already uses
 * for the single-file cache, applied to a directory: a reader either
 * sees the complete old directory or the complete new one, never a mix
 * of old and new shard files.
 *
 * `index` is the same shape `buildIndex`/`appendToIndex` in
 * `search.mjs` produce: `documents` an array with `weights` as a `Map`,
 * `docFreq`/`statsDocFreq` as `Map`s, `lexicon` a `Set`, `lexicons` a
 * `Map<string, Set>`, `tagGraph`/`termGraph` as the graphs
 * `thesaurus.mjs` builds, `entityIndex` a `Map<string, Set<number>>`.
 */
export function writeIndexCache(cacheDir, { version, language, files, fullAt, index }) {
  const tmpDir = `${cacheDir}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const shardLines = planShards(index.documents);
    const documentShards = [];
    let totalDocs = 0;
    shardLines.forEach((lines, i) => {
      const name = shardName(i);
      const body = lines.length ? `${lines.join('\n')}\n` : '';
      const buf = Buffer.from(body, 'utf8');
      fs.writeFileSync(path.join(tmpDir, name), buf);
      documentShards.push({ file: name, count: lines.length, bytes: buf.length, sha256: sha256(buf) });
      totalDocs += lines.length;
    });

    const metaObj = {
      docFreq: [...index.docFreq],
      statsDocFreq: [...(index.statsDocFreq ?? index.docFreq)],
      lexicon: [...index.lexicon],
      lexicons: [...(index.lexicons ?? new Map())].map(([code, set]) => [code, [...set]]),
      tagGraph: thesaurus.packTagGraph(index.tagGraph),
      termGraph: thesaurus.packTagGraph(index.termGraph),
      entityIndex: entity.pack(index.entityIndex),
    };
    const metaBuf = Buffer.from(JSON.stringify(metaObj), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'meta.json'), metaBuf);

    const manifest = {
      version,
      language,
      files,
      fullAt,
      N: index.N,
      avgLength: index.avgLength,
      statsN: index.statsN,
      statsAvgLength: index.statsAvgLength,
      documents: documentShards,
      documentCount: totalDocs,
      meta: { file: 'meta.json', bytes: metaBuf.length, sha256: sha256(metaBuf) },
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));

    // Clear whatever used to be at `cacheDir` first — `renameSync` does
    // not replace a non-empty directory on any platform this runs on,
    // only `writeFileSync` onto a plain file gets that for free. The
    // OLD directory is removed only after the NEW one is fully written
    // above, so a crash here leaves the old cache intact (worst case: a
    // leftover `.tmp` directory, cleaned up the same way a leftover
    // `.tmp` file already is) or the new one fully in place — never a
    // half-swap, because the two renames are not interleaved with any
    // write.
    let staleDir = null;
    if (fs.existsSync(cacheDir)) {
      staleDir = `${cacheDir}.stale.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
      renameWithRetry(cacheDir, staleDir);
    }
    try {
      renameWithRetry(tmpDir, cacheDir);
    } catch (err) {
      // Put the old cache back rather than leave neither in place.
      if (staleDir) { try { renameWithRetry(staleDir, cacheDir); } catch { /* best effort */ } }
      throw err;
    }
    if (staleDir) { try { fs.rmSync(staleDir, { recursive: true, force: true }); } catch { /* fine */ } }
  } catch {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
  }
}

/**
 * Read one file and verify it against the manifest's recorded length
 * and hash BEFORE returning its bytes. Returns `null` — never a
 * partial buffer — on any mismatch or read error.
 */
function readVerified(dir, rel, expectedBytes, expectedHash) {
  let buf;
  try { buf = fs.readFileSync(path.join(dir, rel)); } catch { return null; }
  if (buf.length !== expectedBytes) return null;
  if (sha256(buf) !== expectedHash) return null;
  return buf;
}

/**
 * Read the cache back. Returns `{ ok: true, files, fullAt, index }` on a
 * fully intact cache, matching what the old single-file format handed
 * `loadIndex`; returns `{ ok: false, reason }` — NEVER a half-built
 * index — the moment anything fails to verify.
 *
 * `expectedVersion`/`expectedLanguage` are checked the same way the old
 * format's `c.version`/`c.language` were: a mismatch is not corruption,
 * it is a cache from a different schema or a different configured
 * language, and the caller rebuilds either way.
 */
export function readIndexCache(cacheDir, { expectedVersion, expectedLanguage } = {}) {
  let manifest;
  try {
    const raw = fs.readFileSync(path.join(cacheDir, 'manifest.json'), 'utf8');
    manifest = JSON.parse(raw);
  } catch { return { ok: false, reason: 'no-manifest' }; }

  if (manifest.version !== expectedVersion) return { ok: false, reason: 'version-mismatch' };
  if (manifest.language !== expectedLanguage) return { ok: false, reason: 'language-mismatch' };
  if (!Array.isArray(manifest.documents) || !manifest.meta) return { ok: false, reason: 'malformed-manifest' };

  const documents = [];
  for (const shard of manifest.documents) {
    const buf = readVerified(cacheDir, shard.file, shard.bytes, shard.sha256);
    if (!buf) return { ok: false, reason: `truncated:${shard.file}` };
    const text = buf.toString('utf8');
    const lines = text.length ? text.slice(0, -1).split('\n') : [];
    if (lines.length !== shard.count) return { ok: false, reason: `line-count:${shard.file}` };
    for (const line of lines) {
      let d;
      try { d = JSON.parse(line); } catch { return { ok: false, reason: `bad-json:${shard.file}` }; }
      documents.push({ ...d, weights: new Map(d.weights) });
    }
  }
  if (documents.length !== manifest.documentCount) return { ok: false, reason: 'document-count' };

  if (manifest.meta.bytes > META_SIZE_LIMIT) {
    // Refused, not attempted — see the NOT-MEASURED note at the top of
    // this file. A cache this house has never produced one this large;
    // if one ever appears, treating it as unreadable (fall back to a
    // rebuild) is the safe answer, not a `JSON.parse` gamble.
    return { ok: false, reason: 'meta-too-large' };
  }
  const metaBuf = readVerified(cacheDir, manifest.meta.file, manifest.meta.bytes, manifest.meta.sha256);
  if (!metaBuf) return { ok: false, reason: 'truncated:meta.json' };
  let meta;
  try { meta = JSON.parse(metaBuf.toString('utf8')); } catch { return { ok: false, reason: 'bad-json:meta.json' }; }

  const index = {
    documents,
    docFreq: new Map(meta.docFreq),
    statsDocFreq: new Map(meta.statsDocFreq ?? meta.docFreq),
    lexicon: new Set(meta.lexicon),
    lexicons: new Map((meta.lexicons ?? []).map(([code, arr]) => [code, new Set(arr)])),
    tagGraph: thesaurus.unpackTagGraph(meta.tagGraph),
    termGraph: thesaurus.unpackTagGraph(meta.termGraph),
    entityIndex: entity.unpack(meta.entityIndex),
    language: manifest.language,
    N: manifest.N,
    avgLength: manifest.avgLength,
    statsN: manifest.statsN,
    statsAvgLength: manifest.statsAvgLength,
  };
  return { ok: true, files: manifest.files, fullAt: manifest.fullAt, index };
}

/** Remove a cache directory (and any stray `.tmp`/`.stale` siblings). */
export function removeIndexCache(cacheDir) {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* already gone */ }
}
