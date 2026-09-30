// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * recallserver.mjs — warm recall (M10, 2026-09-30).
 *
 * **The finding.** The recall hook starts a new `node` process for
 * `mem find` on every turn. Measured in the sibling house: 97 percent of
 * recall time is loading, not searching, and 40 percent of the hook's
 * time is process ping-pong. `mem serve` already runs as a long process
 * (when the owner chose to run it) and can answer the same question warm.
 *
 * **No second search path (O1).** The server runs the SAME `find`
 * handler (`src/cli/commands/search.mjs`) that `mem find <prompt> --top N
 * --json` runs in the direct path, with `out()` captured instead of
 * written to stdout (`shell.captureOutput`). The hook renders and books
 * exactly as before (`recallhook.mjs recall`); only the journal line
 * learns the path (`path: server`).
 *
 * **Freshness (O3).** `find` loads the index through `search.loadIndex()`
 * on every question. Since the cold-path work the server turns on the
 * in-process memo there (`search.setProcessMemo`): the index is loaded
 * once and kept, encrypted entries decrypted only on a COPY, and every
 * question compares the file state of every source (and the key state)
 * with what the memo was built from: new state -> top up in memory or
 * rebuild, a changed key state -> decrypt anew, same answers as the
 * direct path.
 * What a server must check on top is its OWN code: if `src/` holds
 * another state than at start, it answers `stale`, the client falls back
 * to the direct path (which loads the new code), and the server stops
 * listening; run as a child under src/recallserver-keeper.mjs (as
 * `mem serve` does) it is started again with a fresh import.
 *
 * **Read only, local only.** The endpoint can do exactly what the hook
 * can: answer one search. Unix socket in a 0700 directory, key file
 * 0600, both under `.pipeline/` (gitignored); no TCP, no port. The key
 * never appears in a log.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as place from './recallserver-place.mjs';

const CODE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Exit code of the server child process on a detected code change (EX_TEMPFAIL). */
export const STALE_RC = 75;

/**
 * The state of the code this process loaded: a print over `src/` (count,
 * newest mtime, total size, recursively).
 *
 * **Deliberately WITHOUT the commit.** A memory that carries its own
 * tool commits DATA into the same clone all the time (journal, captures);
 * a print that included HEAD would make the server `stale` after the
 * first such commit, forever, without a line of code having changed. The
 * server only loaded `src/`; a pull that changes something there changes
 * mtime and usually size.
 */
export function codeState(codeRoot = CODE_ROOT) {
  let n = 0; let newest = 0; let total = 0;
  const walk = (dir, depth) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!/\.(mjs|json|tsv)$/.test(d.name)) continue;
      try {
        const st = fs.statSync(p);
        n += 1; total += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* vanished: shows up in n */ }
    }
  };
  walk(path.join(codeRoot, 'src'), 0);
  return `${n}|${newest}|${total}`;
}

function safeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error(`${dir} belongs to another user (uid ${st.uid})`);
    }
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
}

function someoneListens(socket) {
  return new Promise((resolve) => {
    const c = net.connect(socket);
    const done = (yes) => { c.destroy(); resolve(yes); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    c.setTimeout(500, () => done(false));
  });
}

function same(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function realRoot(r) {
  try { return fs.realpathSync(path.resolve(String(r))); } catch { return path.resolve(String(r)); }
}

/**
 * Start the server for `root`. Resolves to `{ running: true, where,
 * close }` or `{ running: false, reason }` — a server that cannot start
 * is not an error of the process that hosts it (`mem serve` runs on,
 * the hook falls back to the direct path when there is no socket).
 */
export async function start(root, {
  env = process.env, codeRoot = CODE_ROOT, log = null, onStale = null,
} = {}) {
  const say = log ?? ((t) => process.stderr.write(`recall server: ${t}\n`));
  const where = place.place(root, env);
  if (process.platform !== 'win32' && Buffer.byteLength(where.socket) > place.MAX_SOCKET_PATH) {
    const reason = `socket path too long (${Buffer.byteLength(where.socket)} bytes > ${place.MAX_SOCKET_PATH}); set MEM_RECALL_SERVER_DIR`;
    say(`not started: ${reason}`);
    return { running: false, reason };
  }
  try { safeDir(where.dir); } catch (e) {
    say(`not started: ${e.message}`);
    return { running: false, reason: e.message };
  }
  if (process.platform !== 'win32' && fs.existsSync(where.socket)) {
    if (await someoneListens(where.socket)) {
      say(`not started: a server already listens on ${where.socket}`);
      return { running: false, reason: 'busy' };
    }
    try { fs.rmSync(where.socket, { force: true }); } catch { /* listen will say */ }
  }

  const { COMMANDS } = await import('./cli/commands/search.mjs');
  const shell = await import('./cli/shell.mjs');
  const searchMod = await import('./search.mjs');
  const startState = codeState(codeRoot);
  const myRoot = realRoot(root);
  let close = null;

  const key = crypto.randomBytes(32).toString('hex');
  const tmp = `${where.key}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, key); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, where.key);

  // One question after the other: `find` is synchronous at its core, and
  // two interleaved runs would be a state the direct path never has.
  let queue = Promise.resolve();

  const answer = async (req) => {
    if (!req || req.v !== place.VERSION) return { ok: false, reason: 'refused' };
    if (!same(req.key, key)) return { ok: false, reason: 'refused' };
    if (realRoot(req.root) !== myRoot) return { ok: false, reason: 'refused' };
    if (codeState(codeRoot) !== startState) {
      // New code on disk: this question goes to the direct path (which
      // loads the new code), and the server stops listening. Without a
      // socket every later turn runs with no server attempt at all,
      // instead of hearing `stale` once per turn. Restarting `mem serve`
      // brings it back with the new code.
      say('code under src/ changed since the start — recall server stopped (restart mem serve to bring it back)');
      // `onStale`: the child process under src/recallserver-keeper.mjs then
      // exits with STALE_RC, and the keeper starts it again with a fresh import.
      setImmediate(() => {
        if (!close) return;
        close().then(() => { if (onStale) onStale(); });
      });
      return { ok: false, reason: 'stale' };
    }
    // The client gives up at `deadline_ms`. A question still in the queue
    // after that has nobody waiting for it: skip it instead of spending
    // seconds on it (measured at 200k entries: one search ~5 s, so a
    // queue of abandoned questions would keep the server behind for good).
    const deadline = Number(req.deadline_ms);
    if (Number.isFinite(deadline) && Date.now() > deadline) return { ok: false, reason: 'timeout' };
    const query = String(req.query ?? '');
    const top = Number(req.top);
    const args = { json: true, root };
    if (Number.isFinite(top) && top > 0) args.top = String(top);
    try {
      const stdout = await shell.captureOutput(() => COMMANDS.find({ rest: [query], args }));
      return { ok: true, stdout };
    } catch (e) {
      // `die()` inside `find` (bad input): the direct path would exit 1
      // with nothing on stdout. Say `error`; the client falls back, and
      // the direct path fails the same way and books `error`.
      return { ok: false, reason: 'error' };
    }
  };

  const server = net.createServer((sock) => {
    let buf = '';
    let done = false;
    sock.setEncoding('utf8');
    sock.setTimeout(30000, () => sock.destroy());
    sock.on('error', () => { /* client gone */ });
    sock.on('data', (chunk) => {
      if (done) return;
      buf += chunk;
      if (Buffer.byteLength(buf) > place.MAX_BYTES) { done = true; sock.destroy(); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      done = true;
      let req = null;
      try { req = JSON.parse(buf.slice(0, nl)); } catch { req = null; }
      const run = queue.then(() => answer(req)).catch(() => ({ ok: false, reason: 'error' }));
      queue = run.catch(() => {});
      run.then((a) => { try { sock.end(`${JSON.stringify({ v: place.VERSION, ...a })}\n`); } catch { /* gone */ } });
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(where.socket, () => { server.off('error', reject); resolve(); });
    });
  } catch (e) {
    try { fs.rmSync(where.key, { force: true }); } catch { /* nothing */ }
    say(`not started: ${e.message}`);
    return { running: false, reason: e.message };
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(where.socket, 0o600); } catch { /* the 0700 directory still guards */ }
  }
  // The in-process index memo (search.mjs `setProcessMemo`): only a
  // long-lived process turns it on, and this is one. Off again on close.
  searchMod.setProcessMemo(true);
  say(`listening on ${where.socket}`);

  let closed = false;
  close = () => new Promise((resolve) => {
    if (closed) { resolve(); return; }
    closed = true;
    searchMod.setProcessMemo(false);
    server.close(() => resolve());
    // Only remove what is OURS: another key there belongs to a newer server.
    try { if (fs.readFileSync(where.key, 'utf8') === key) fs.rmSync(where.key, { force: true }); } catch { /* gone */ }
    if (process.platform !== 'win32') { try { fs.rmSync(where.socket, { force: true }); } catch { /* gone */ } }
  });
  return { running: true, where, close, server };
}
