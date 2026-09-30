// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * recallserver-place.mjs — WHERE the warm recall server listens, and
 * what a caller hands it (M10, 2026-09-30).
 *
 * **Its own file, Node built-ins only.** Two sides load it: the server
 * (src/recallserver.mjs, long-running, may load anything) and the client
 * (bin/mem-retrieve-client.mjs), which starts on EVERY turn. The whole
 * gain of the server is that the client does NOT load the search path;
 * importing it here would bring that cost straight back. And the place
 * is computed in ONE spot: a client that recomputed it would be a
 * second truth about one path.
 *
 * **Local only, no network.** A Unix socket inside a directory with mode
 * 0700 (Windows: a named pipe), plus a key (32 random bytes, hex) in a
 * mode-0600 file in the same directory. A process that may not enter the
 * directory reaches neither. The key is the second guard for platforms
 * that do not enforce permissions on socket files, and for the named
 * pipe, whose default ACL lets other accounts read. It never goes to a
 * log and never into the repo (`.pipeline/` is gitignored).
 */

import path from 'node:path';
import crypto from 'node:crypto';

export const DIR_NAME = 'recall';
export const SOCKET_NAME = 'recall.sock';
export const KEY_NAME = 'key';

/** Protocol version. Another version is refused, never guessed. */
export const VERSION = 1;

/** Largest request/answer in bytes. */
export const MAX_BYTES = 8 * 1024 * 1024;

/** `sun_path` holds 108 bytes on Linux, 104 on macOS: stay below both. */
export const MAX_SOCKET_PATH = 100;

/**
 * The client's exit codes; bin/mem-retrieve maps them to the journal's
 * `path_reason` (src/injection.mjs PATH_REASON). Closed list.
 */
export const CLIENT_RC = Object.freeze({
  OK: 0,
  NO_SERVER: 3, // no socket, nobody listening, or no permission
  TIMEOUT: 4, // no answer within the wait
  REFUSED: 5, // key, root or version mismatch
  STALE: 6, // the server runs old code
  ERROR: 7, // anything else
});

export function rootId(root) {
  return crypto.createHash('sha256').update(path.resolve(String(root))).digest('hex').slice(0, 16);
}

/**
 * Where the server for this memory root listens. `MEM_RECALL_SERVER_DIR`
 * moves the directory (tests, or a root whose path is too long for
 * `sun_path`); bin/mem-retrieve reads the same name with the same
 * default and only checks whether the file is a socket.
 */
export function place(root, env = process.env, platform = process.platform) {
  const dir = env.MEM_RECALL_SERVER_DIR
    ? path.resolve(env.MEM_RECALL_SERVER_DIR)
    : path.join(path.resolve(String(root)), '.pipeline', DIR_NAME);
  const socket = platform === 'win32'
    ? `\\\\.\\pipe\\cheap-mem-recall-${rootId(root)}`
    : path.join(dir, SOCKET_NAME);
  return { dir, socket, key: path.join(dir, KEY_NAME) };
}
