// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/indexrebuild.mjs — the search index rebuilt in the BACKGROUND, one at a time.
//
// ## The finding (index-schwelle-cm, port of lucky-mem `abruf-nachtrag-schwelle-lm`, 2026-10-16)
//
// The recall hook (`mem find --recall`) loads the index from the cache and APPENDS the lines written since the
// last full build. Appending costs about 0.5 ms per new line in every hook process, and the rebuild came only at
// a fifth of the corpus (`REBUILD_AFTER_FRACTION`): at 7,000 entries that is 1,400 lines, a load that is seconds
// long on a busy machine, in every question, while the rebuild itself ran in the asking process, inside the hook's
// 5 s cap. The lucky-mem journal showed it: every recall at the stack, none ever reaching the rebuild.
//
// ## What this file does
//
// When the stack passes the absolute bound (`search.appendedTooMany`), the hook still answers from the appended
// index (the documents are exact, only the learned graphs lag) and calls `kickIndexRebuild` once. It starts a
// DETACHED child that does the full build and writes the cache (the atomic directory swap of `indexcache.mjs`), and
// returns at once. It never builds in the caller and never waits.
//
// * **One at a time.** The lock is a file created with link/O_EXCL (`filelock.tryLock`): of two processes that ask at the
//   same moment exactly one gets it and starts the child; the other gets `running`.
// * **No lock for ever.** The child removes the lock when it ends, whatever way. A child that is killed leaves the lock, and it
//   is taken over by AGE (`INDEX_REBUILD_LOCK_MAX_AGE_S`, through the takeover bar of `filelock.takeOverIfStale`); the owner PID in
//   the file is the PID of the asker, which is gone a moment later, so only the age can decide here. A rebuild that
//   outlives the age loses at worst a second, harmless build: both write through the atomic swap.
// * **After a failure, hold back.** A child that throws leaves a note; for `INDEX_REBUILD_BACKOFF_S` no new child is started
//   (`backoff`), the hook goes on answering from the appended index.
// * **No half index.** The child writes the cache the way every build does (new directory, then rename). A reader that
//   meets the cache between the two renames finds no manifest and builds in its own process: slower, never wrong.
//
// Lock and note live under `<root>/.mem/locks/` (git-ignored, outside the dashboard stamp).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tryLock, releaseLock, lockAgeS, takeOverIfStale } from './filelock.mjs';
import { writeAtomic } from './atomicwrite.mjs';

/** The lock of a running background rebuild. */
export const INDEX_REBUILD_LOCK_PATH = path.join('.mem', 'locks', 'search-index-rebuild.lock');
/** How the last background rebuild ended. */
export const INDEX_REBUILD_NOTE_PATH = path.join('.mem', 'locks', 'search-index-rebuild.note.json');
/** A lock older than this belongs to a dead child (seconds). A full build of 100,000 entries takes about a minute. */
export const INDEX_REBUILD_LOCK_MAX_AGE_S = 900;
/** After a failed rebuild no new child is started for this long (seconds). */
export const INDEX_REBUILD_BACKOFF_S = 600;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Is a background rebuild running (going by the lock file)? Never throws. */
export function indexRebuildRunning(root) {
  return lockAgeS(path.join(root, INDEX_REBUILD_LOCK_PATH)) <= INDEX_REBUILD_LOCK_MAX_AGE_S;
}

/**
 * Block (bounded) until no background rebuild holds the lock any more, then a short grace for the child to exit. For tests and
 * maintenance that must remove the tree: the child runs with the memory as its working directory, and on Windows an `rmdir`
 * under it fails with EBUSY/ENOTEMPTY. Returns true once idle, false on timeout. Never throws; production paths never call it.
 */
export function waitForIndexRebuildIdle(root, timeoutMs = 15000, graceMs = 150) {
  const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
  const deadline = Date.now() + timeoutMs;
  while (indexRebuildRunning(root)) {
    if (Date.now() >= deadline) return false;
    nap(25);
  }
  nap(graceMs);
  return true;
}

/** Did a rebuild end well since `sinceMs` (epoch ms) and is none running now? Never throws. */
export function rebuiltSince(root, sinceMs) {
  if (indexRebuildRunning(root)) return false;
  try {
    const note = JSON.parse(fs.readFileSync(path.join(root, INDEX_REBUILD_NOTE_PATH), 'utf8'));
    return note.ok === true && new Date(note.at).getTime() >= sinceMs;
  } catch { return false; }
}

/** Write down how the last rebuild ended. Never throws. */
export function noteRebuild(root, outcome) {
  try {
    writeAtomic(path.join(root, INDEX_REBUILD_NOTE_PATH), JSON.stringify({ at: new Date().toISOString(), ...outcome }));
  } catch { /* nothing more can be done about a note */ }
}

/**
 * What the child runs: `rebuild()` (the build AND the check that the cache landed, see `search.rebuildIndexCache`), then the note
 * of how it ended. A rebuild that throws leaves a failure note, which holds the next child back (`backoff`). Never throws.
 */
export function runRebuild(root, rebuild) {
  try {
    rebuild();
    noteRebuild(root, { ok: true });
    return true;
  } catch (e) {
    noteRebuild(root, { ok: false, error: String((e && e.message) || e) });
    return false;
  }
}

/** Did the last rebuild fail a moment ago? Never throws. */
export function failedRecently(root) {
  try {
    const note = JSON.parse(fs.readFileSync(path.join(root, INDEX_REBUILD_NOTE_PATH), 'utf8'));
    const age = (Date.now() - new Date(note.at).getTime()) / 1000;
    return note.ok === false && age >= 0 && age < INDEX_REBUILD_BACKOFF_S;
  } catch { return false; }
}

/**
 * Start the full rebuild of the search index as a detached child, unless one is running or the last one failed a moment
 * ago. Never builds in the caller, never waits, never throws. `childScript` replaces the child's program (probes only).
 * Returns `'started'` (this call got the lock and started the child), `'running'` (a fresh lock was there), `'backoff'`
 * (the last rebuild failed lately) or `'error'` (the lock or the spawn failed; no lock stays behind).
 */
export function kickIndexRebuild(root, { language = 'en', env = process.env, childScript = null } = {}) {
  if (failedRecently(root)) return 'backoff';
  const lockPath = path.join(root, INDEX_REBUILD_LOCK_PATH);
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { return 'error'; }
  if (!tryLock(lockPath)) {
    if (!takeOverIfStale(lockPath, INDEX_REBUILD_LOCK_MAX_AGE_S)) return 'running';
    if (!tryLock(lockPath)) return 'running'; // someone else was faster
  }
  try {
    const searchUrl = pathToFileURL(path.join(MODULE_DIR, 'search.mjs')).href;
    const selfUrl = pathToFileURL(path.join(MODULE_DIR, 'indexrebuild.mjs')).href;
    // `node -e` runs as CommonJS, so `require` exists; root, language and lock arrive as arguments, never through the
    // environment. The lock always goes away, the note says how it ended.
    // `childScript`: a stand-in for the child (probes only), run with the same arguments: root, language, lock path.
    // The lock is released only if it is still OUR lock (argv[4] is its content): one that was taken over meanwhile
    // belongs to somebody else by now.
    const script = childScript ?? `import(${JSON.stringify(searchUrl)}).then(async (s) => {
        const n = await import(${JSON.stringify(selfUrl)});
        n.runRebuild(process.argv[1], () => s.rebuildIndexCache(process.argv[1], { language: process.argv[2] }));
      }).catch(() => {}).finally(() => { try {
        const fs = require('node:fs');
        if (fs.readFileSync(process.argv[3], 'utf8').trim() === process.argv[4]) fs.rmSync(process.argv[3], { force: true });
      } catch {} });`;
    let ownerText = '';
    try { ownerText = fs.readFileSync(lockPath, 'utf8').trim(); } catch { /* unreadable: the child then leaves the lock to the age */ }
    const child = spawn(process.execPath, ['-e', script, root, String(language), lockPath, ownerText], {
      cwd: root, env: { ...env }, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', (e) => {
      noteRebuild(root, { ok: false, error: `spawn: ${e?.code ?? e?.message}` });
      releaseLock(lockPath);
    });
    child.unref();
    return 'started';
  } catch {
    releaseLock(lockPath);
    return 'error';
  }
}
