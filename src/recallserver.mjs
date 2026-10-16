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
import { writeAtomic } from './atomicwrite.mjs';

const CODE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Has the parent of a keeper-run server gone? POSIX reparents an orphan, so `process.ppid` changes.
 * Windows does NOT: `ppid` keeps naming the dead parent forever, and a server that only compared it
 * outlived `mem serve` for good (the hard kill of `mem serve` there is TerminateProcess, no child is
 * taken down; a test file that spawned `mem serve` then never ended, cli-contract, CI 37860352636).
 * So also ask whether the parent pid still exists (signal 0; EPERM means it does).
 */
export function parentGone(parent, ppid = process.ppid, probe = process.kill) {
  if (ppid !== parent) return true;
  try { probe(parent, 0); return false; } catch (e) { return e?.code !== 'EPERM'; }
}

/** Exit code of the server child process on a detected code change (EX_TEMPFAIL). */
export const STALE_RC = 75;
/**
 * Exit code of the server child when another server already listens on
 * the socket (an orphan with old code, seen on the VM 2026-10-01). The
 * keeper then retries quietly after a pause instead of giving up as it
 * does for a real start failure (exit 1).
 */
export const BUSY_RC = 76;

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
 *
 * **Why the change time too (dashboard-tempo-cm, the sibling's R4, lever 7).**
 * A change of the same size with the mtime set back (`touch -d`, `cp -p`,
 * `rsync -t`, unpacking a tar) left count, newest mtime and total size
 * equal: the server went on with the old code. No user process sets the
 * ctime back; every write, rename or replace sets it to "now", so the
 * newest ctime only grows. The same `stat` answer, not one byte of code
 * read - a content hash would read the whole code on every question. The
 * price: a permission or link change also reads as `stale`, which costs a
 * restart of the server, never a wrong answer.
 */
export function codeState(codeRoot = CODE_ROOT) {
  let n = 0; let newest = 0; let newestChange = 0; let total = 0;
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
        if (st.ctimeMs > newestChange) newestChange = st.ctimeMs;
      } catch { /* vanished: shows up in n */ }
    }
  };
  walk(path.join(codeRoot, 'src'), 0);
  return `${n}|${newest}|${total}|${newestChange}`;
}

/** The per-user parent of a short fallback dir: ours, a real directory, 0700. */
function safeParent(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user (uid ${st.uid})`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
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

/**
 * Remove pinning links (`recall.sock.hold.<pid>.<hex>`) that a start left behind when it was killed during the probe.
 * Only names of exactly that shape, only files of our own uid, only those whose pid is not alive (a concurrent starter's
 * link is in use right now), in our own socket directory.
 */
function sweepHolds(socket) {
  const dir = path.dirname(socket);
  const prefix = `${path.basename(socket)}.hold.`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const m = /^(\d+)\.[0-9a-f]{8}$/.exec(name.slice(prefix.length));
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = e?.code === 'EPERM'; }
    if (alive) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (uid !== null && st.uid !== uid) continue;
      if (!st.isSocket()) continue;
      fs.rmSync(full, { force: true });
    } catch { /* gone, or not ours to remove */ }
  }
}

/** Device and inode of a path (`lstat`, follows no link), or null. */
function socketStand(p) {
  try {
    const st = fs.lstatSync(p, { bigint: true });
    return { dev: Number(st.dev), ino: Number(st.ino), socket: st.isSocket(), born: st.ctimeNs };
  } catch { return null; }
}

/**
 * Close the server without taking a FOREIGN socket away. `server.close()` unlinks the bound NAME in libuv, without
 * asking whose file stands there (measured on Node 22 by the sibling house, R3 lever 9). `mine` is device and inode
 * of this server's own socket from right after `listen`; when another file stands at the path now (a newer server
 * took the name), it is put aside for the duration of the (synchronous) call and put back after.
 */
function closeServer(server, socket, mine) {
  return new Promise((resolve) => {
    let aside = null;
    if (mine) {
      const now = socketStand(socket);
      if (now && (now.dev !== mine.dev || now.ino !== mine.ino)) {
        aside = `${socket}.foreign.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        try { fs.renameSync(socket, aside); } catch { aside = null; }
      }
    }
    try { server.close(() => resolve()); } catch { resolve(); }
    if (aside) {
      try {
        if (fs.existsSync(socket)) fs.rmSync(aside, { force: true }); // an even newer one took the name meanwhile: it counts
        else fs.renameSync(aside, socket);
      } catch { /* stays behind as a leftover */ }
    }
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
    const reason = `socket path too long (${Buffer.byteLength(where.socket)} bytes > ${place.MAX_SOCKET_PATH}); set MEM_RECALL_SERVER_DIR to a shorter place`;
    say(`not started: ${reason}`);
    return { running: false, reason };
  }
  try {
    if (where.fallback) safeParent(path.dirname(where.dir));
    safeDir(where.dir);
    if (where.fallback) {
      // The pointer for bin/mem-retrieve (bash): the default dir says where the server really is.
      writeAtomic(where.pointer, `${where.dir}\n`, { mode: 0o600 });
    }
  } catch (e) {
    say(`not started: ${e.message}`);
    return { running: false, reason: e.message };
  }
  // POSIX: a socket file may be there, live or dead. Windows: a pipe leaves no file, so ask the pipe
  // itself (a missing pipe answers at once with an error).
  const win = process.platform === 'win32';
  if (win || fs.existsSync(where.socket)) {
    // R3 lever 9b: take device and inode of what stands at the path BEFORE the probe. Only a SOCKET that nobody
    // listens on is "a dead server's leftover"; a regular file, a directory or a link belongs to somebody else: no
    // start over it, and it is not touched. (A check taken AFTER the probe would see a socket another starter has just
    // bound in the meantime and take it for the dead one.)
    const before = win ? null : socketStand(where.socket);
    if (before && !before.socket) {
      const reason = `${where.socket} exists and is not a socket - not touched`;
      say(`not started: ${reason}`);
      return { running: false, reason };
    }
    // A hard link in our own 0700 directory PINS the dead file's inode for the length of the probe: the number cannot be
    // handed out again, so a new socket bound meanwhile cannot look like the old one (a freed inode number is reused at
    // once on some file systems - measured here on ext). If the link cannot be made, device, inode and change time carry
    // the comparison (a new file has a new change time), a little weaker.
    sweepHolds(where.socket);
    let hold = null;
    let seen = before; // what the removal below is compared with (linking changes the change time: look again after it)
    if (!win && before) {
      const name = `${where.socket}.hold.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      try { fs.linkSync(where.socket, name); hold = name; } catch { /* not pinned: the change time stands in */ }
      if (hold) {
        const linked = socketStand(hold);
        // The file that got linked is not the one that was seen (swapped in between): leave it alone.
        seen = linked && linked.dev === before.dev && linked.ino === before.ino ? linked : null;
      }
    }
    try {
      if (await someoneListens(where.socket)) {
        say(`not started: a server already listens on ${where.socket}`);
        return { running: false, reason: 'busy' };
      }
      if (!win) {
        // Removed only if it is STILL the very file that was seen before the probe. Another one - bound by a server
        // that is starting right now - is left alone: `listen` below then says busy. With the pinning link device and
        // inode are enough - and the change time must NOT be compared then: every starter links and unlinks, each of
        // which changes the shared inode's change time, so with concurrent starters nobody would match and nobody would
        // clean up. Without the link (`hold` null) the change time is all that tells a new file from the old one.
        const after = socketStand(where.socket);
        if (seen && after && after.dev === seen.dev && after.ino === seen.ino
          && (hold !== null || after.born === seen.born)) {
          try { fs.rmSync(where.socket, { force: true }); } catch { /* listen will say */ }
        }
      }
    } finally {
      if (hold) { try { fs.rmSync(hold, { force: true }); } catch { /* a leftover link in our own directory */ } }
    }
  }

  const { COMMANDS } = await import('./cli/commands/search.mjs');
  const shell = await import('./cli/shell.mjs');
  const searchMod = await import('./search.mjs');
  const startState = codeState(codeRoot);
  const myRoot = realRoot(root);
  let close = null;

  // The key of THIS server. It goes to disk only AFTER a successful `listen` (R3 lever 8): two starts at the same
  // time used to write the key first, and the one that then lost the socket removed it - the winner was left
  // listening with no key file, deaf to every client. A start that does not get the socket touches no key.
  const key = crypto.randomBytes(32).toString('hex');

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
    // The caller's switches (place.FORWARDED_ENV), not the ones this server was started with. A request without
    // `env` (an older client) is answered under this process's environment, as before.
    let callEnv = process.env;
    if (req.env && typeof req.env === 'object') {
      callEnv = { ...process.env };
      for (const k of place.FORWARDED_ENV) {
        const v = req.env[k];
        if (v === null || v === undefined) delete callEnv[k]; else callEnv[k] = String(v);
      }
      // A switch that shapes the index in memory cannot be overridden for one call: refuse, the hook goes direct.
      for (const k of place.INDEX_ENV) {
        const v = req.env[k];
        if (v === undefined) continue;
        if ((v === null ? '' : String(v)) !== (process.env[k] ?? '')) return { ok: false, reason: 'refused' };
      }
    }
    // `recall`: the same flag the hook's direct path passes (`mem find --top N --recall --json`).
    const args = { json: true, recall: true, root };
    if (Number.isFinite(top) && top > 0) args.top = String(top);
    try {
      const stdout = await shell.captureOutput(() => COMMANDS.find({ rest: [query], args, env: callEnv }));
      return { ok: true, stdout };
    } catch {
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
    // Nothing on disk is ours yet: neither the key nor the socket belongs to this start (R3 lever 8).
    const busy = Boolean(e) && e.code === 'EADDRINUSE';
    say(`not started: ${busy ? `a server already listens on ${where.socket}` : e.message}`);
    return { running: false, reason: busy ? 'busy' : e.message };
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(where.socket, 0o600); } catch { /* the 0700 directory still guards */ }
  } else {
    // A pipe leaves no file: the marker is what bin/mem-retrieve looks for.
    try { writeAtomic(where.marker, `${where.socket}\n`, { mode: 0o600 }); } catch { /* the client then goes direct */ }
    say('NOTICE: on Windows the key file cannot be protected with POSIX modes (0600/0700 are meaningless); '
      + 'the random key is the guard, and the directory should be private to your account (NTFS ACLs, icacls). Unverified by the product.');
  }
  // Device and inode of OUR socket (R3 lever 9): `close` removes only that one.
  const mySocket = process.platform === 'win32' ? null : socketStand(where.socket);
  try {
    const tmp = `${where.key}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, key); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, where.key); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
  } catch (e) {
    // A server nobody can authenticate to is worse than none: take it down again.
    await closeServer(server, where.socket, mySocket);
    if (win) { try { fs.rmSync(where.marker, { force: true }); } catch { /* gone */ } }
    say(`not started: the key could not be stored: ${e.message}`);
    return { running: false, reason: e.message };
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
    // Only remove what is OURS: another key there belongs to a newer server, and the socket is told apart by
    // device and inode (`closeServer`), not by its name.
    try { if (fs.readFileSync(where.key, 'utf8') === key) fs.rmSync(where.key, { force: true }); } catch { /* gone */ }
    if (process.platform === 'win32') { try { fs.rmSync(where.marker, { force: true }); } catch { /* gone */ } }
    closeServer(server, where.socket, mySocket).then(resolve);
  });
  return { running: true, where, close, server };
}
