// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Atomic write: the ONE way to write a state file (suggestion list item
 * 14, F5).
 *
 * A UNIQUE temp file in the same directory, then `rename`. A reader never
 * sees half a file, an abort leaves no half file at the target, and two
 * writers never share a temp file.
 *
 * **Why unique.** A fixed temp name (`<file>.tmp`, or `<file>.<pid>.tmp`
 * with several writes per process) lets two writers fill the same file and
 * rename a mixture (lucky-mem finding 2jaqvkqf537u, found on its search
 * index). Pid plus random bytes cannot collide. `test/f5-atomicwrite-guard`
 * freezes the old direct writers per file and lets them not grow.
 *
 * The rename retries on the transient Windows codes (a reader mid-read
 * makes `rename` answer EPERM). Same loop as `renameWithRetry` in
 * `indexcache.mjs`, kept apart on purpose: that module pulls in the
 * thesaurus and the entity code, and a writer of a ten-line state file
 * should not.
 *
 * Throws after cleaning up the temp file; whoever wants to fail quietly
 * catches at the call site, as before.
 *
 * **The reader's half (`readStateFile`).** The same swap that makes `rename`
 * answer EPERM to a writer makes the OPEN of a reader answer EPERM, EACCES or
 * EBUSY on Windows (NTFS refuses to open a file in the middle of a replace;
 * measured CI run 1141, `test/atomic-cache.test.mjs` D). A reader that reads
 * every failure as "no file" reports a mark that is there as missing, and the
 * caller starts over from nothing. So: ENOENT is `missing`; the three
 * transient codes on win32 are tried again a few times, with the writer's
 * pause; whatever still fails is `unreadable` - a third state, never folded
 * into `missing`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

const defaultPause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The temp name for `target`: unique per process and call. */
export function tempNameFor(target) {
  return `${target}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
}

/**
 * @param {string} target  file to write (its directory is created)
 * @param {string|Buffer} content
 * @param {{mode?: number, rename?: Function, pause?: Function}} [opt]
 *   `mode` is applied to the temp file before the rename (private keys).
 *   `rename`/`pause` are injectable so a test can drive the retry.
 */
export function writeAtomic(target, content, {
  mode,
  rename = fs.renameSync,
  pause = defaultPause,
} = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tempNameFor(target);
  try {
    if (mode === undefined) fs.writeFileSync(tmp, content);
    else { fs.writeFileSync(tmp, content, { mode }); fs.chmodSync(tmp, mode); }
    for (let i = 1; ; i += 1) {
      try { rename(tmp, target); break; } catch (err) {
        if (i >= 6 || !TRANSIENT.has(err.code)) throw err;
        pause(i * 5);
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* next time */ }
    throw e;
  }
}

/**
 * Read a state file as text, in three states.
 *
 *   `{ state: 'ok', text }`                       the file was read
 *   `{ state: 'missing' }`                        ENOENT: there is no such file (a gap everywhere)
 *   `{ state: 'unreadable', error, code }`        it is there and could not be read (directory, permission, a
 *                                                 refusal that did not let up) - NOT the same as missing
 *
 * On win32 (and only there) EPERM / EACCES / EBUSY mean "a writer is replacing it right now" and are tried again, up to
 * six opens with the writer's pauses (5, 10, 15, 20, 25 ms: 75 ms at most). Off Windows the same codes are real
 * permission errors and are reported at once.
 *
 * @param {string} file
 * @param {{platform?: string, read?: Function, pause?: Function}} [opt]
 *   `platform`/`read`/`pause` are injectable so a probe can play Windows on any machine.
 */
export function readStateFile(file, {
  platform = process.platform,
  read = fs.readFileSync,
  pause = defaultPause,
} = {}) {
  for (let i = 1; ; i += 1) {
    try { return { state: 'ok', text: read(file, 'utf8') }; } catch (err) {
      const code = err && err.code;
      if (code === 'ENOENT') return { state: 'missing' };
      if (platform === 'win32' && TRANSIENT.has(code) && i < 6) { pause(i * 5); continue; }
      return { state: 'unreadable', error: String((err && err.message) || err), code: code ?? null };
    }
  }
}
