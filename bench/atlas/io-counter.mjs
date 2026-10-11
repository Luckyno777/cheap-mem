// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/io-counter.mjs — a preload that counts what a process READS.
//
// **Why a counter and not a clock.** How long a `mem find` takes on a
// shared machine depends on who else is running. How many lines and bytes
// it reads from the memory does not. The scale phase of the atlas
// (bench/atlas/phase-skala.mjs) therefore leads with this and keeps the
// time as a companion value.
//
// Use it as `node --import=<this file's URL>?root=<root>&out=<file> ...`
// or through NODE_OPTIONS (so the node children of a bash hook count too).
// The root and the output file travel in the URL's query string rather
// than in environment variables: a new variable would be one more name for
// users to meet (src/envregister.mjs), and this is a measuring tool.
//
// At exit the process appends ONE JSON line to the output file:
//
//   { pid, maxRssKb, linesRead, corpusBytesRead, indexBytesRead,
//     otherBytesRead, filesRead, corpusFiles }
//
// - `linesRead`       newline bytes seen in reads of files under
//                     `<root>/global` or `<root>/projects` (the entry logs)
// - `corpusBytesRead` bytes read from those files
// - `indexBytesRead`  bytes read from the search-index cache directory
// - `otherBytesRead`  bytes read from anything else under the root
//                     (config, journals, markers)
//
// What it does NOT see (named, because a counter that claims more than it
// sees is an empty green): reads through `fs.promises` file handles
// (`filehandle.read`), memory-mapped files, reads that happen in a child
// process which did not load this preload, and anything outside the root.
// The code under test uses `readFileSync`, `openSync`+`readSync` and
// `createReadStream` (checked 2026-10-11); the probe test plants a known
// file and checks all three paths are counted.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const params = new URL(import.meta.url).searchParams;
const ROOT = params.get('root');
const OUT = params.get('out');

if (ROOT && OUT) install(ROOT, OUT);

function install(root, out) {
  const roots = [path.resolve(root)];
  try { roots.push(fs.realpathSync(root)); } catch { /* may not exist yet */ }
  const underRoot = (p) => {
    const abs = path.resolve(p);
    for (const r of roots) {
      const rel = path.relative(r, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    }
    return null;
  };
  const c = {
    linesRead: 0, corpusBytesRead: 0, indexBytesRead: 0, otherBytesRead: 0, filesRead: new Set(), corpusFiles: new Set(),
  };
  const fdPath = new Map();
  const classify = (rel) => {
    if (rel.startsWith('.mem/search-index/') || rel.startsWith('.mem/search-index')) return 'index';
    if (rel.startsWith('global/') || rel.startsWith('projects/')) return 'corpus';
    return 'other';
  };
  const add = (rel, bytes, lines) => {
    if (!bytes) return;
    const kind = classify(rel);
    c.filesRead.add(rel);
    if (kind === 'corpus') { c.corpusBytesRead += bytes; c.linesRead += lines; c.corpusFiles.add(rel); } else if (kind === 'index') c.indexBytesRead += bytes;
    else c.otherBytesRead += bytes;
  };
  const newlines = (buf, n) => {
    let k = 0;
    for (let i = 0; i < n; i += 1) if (buf[i] === 10) k += 1;
    return k;
  };

  const openSync = fs.openSync;
  fs.openSync = function patchedOpenSync(p, flags, ...rest) {
    const fd = openSync.call(this, p, flags, ...rest);
    if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) {
      const rel = underRoot(Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : p);
      if (rel) fdPath.set(fd, rel);
    }
    return fd;
  };
  const open = fs.open;
  fs.open = function patchedOpen(p, ...args) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      args[args.length - 1] = function wrapped(err, fd) {
        if (!err && typeof p === 'string') { const rel = underRoot(p); if (rel) fdPath.set(fd, rel); }
        return cb.call(this, err, fd);
      };
    }
    return open.call(this, p, ...args);
  };
  const closeSync = fs.closeSync;
  fs.closeSync = function patchedCloseSync(fd) { fdPath.delete(fd); return closeSync.call(this, fd); };

  // `fs.readFileSync` calls `fs.readSync` through the module object, so a
  // naive pair of wrappers counts one read twice. While a wrapped call that
  // does its own counting is running, the inner calls are not counted.
  let inside = 0;
  const readSync = fs.readSync;
  fs.readSync = function patchedReadSync(fd, buffer, ...rest) {
    const n = readSync.call(this, fd, buffer, ...rest);
    const rel = fdPath.get(fd);
    if (rel && n > 0 && inside === 0) {
      // readSync(fd, buffer, offset, length, position) or (fd, buffer, {options}); the bytes land at `offset`.
      let offset = 0;
      if (typeof rest[0] === 'number') offset = rest[0];
      else if (rest[0] && typeof rest[0] === 'object' && rest[0].offset) offset = rest[0].offset;
      add(rel, n, newlines(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n), n));
    }
    return n;
  };
  const read = fs.read;
  fs.read = function patchedRead(fd, ...args) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function' && fdPath.has(fd)) {
      const rel = fdPath.get(fd);
      args[args.length - 1] = function wrapped(err, n, buf) {
        if (!err && n > 0 && buf) add(rel, n, newlines(buf, n));
        return cb.call(this, err, n, buf);
      };
    }
    return read.call(this, fd, ...args);
  };
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(p, ...rest) {
    let data;
    inside += 1;
    try { data = readFileSync.call(this, p, ...rest); } finally { inside -= 1; }
    const rel = typeof p === 'string' ? underRoot(p) : (p instanceof URL ? underRoot(p.pathname) : (typeof p === 'number' ? fdPath.get(p) : null));
    if (rel) {
      if (typeof data === 'string') {
        let k = 0;
        for (let i = data.indexOf('\n'); i !== -1; i = data.indexOf('\n', i + 1)) k += 1;
        add(rel, Buffer.byteLength(data), k);
      } else add(rel, data.length, newlines(data, data.length));
    }
    return data;
  };
  const pReadFile = fs.promises.readFile;
  fs.promises.readFile = async function patchedPromisesReadFile(p, ...rest) {
    const data = await pReadFile.call(this, p, ...rest);
    const rel = typeof p === 'string' ? underRoot(p) : null;
    if (rel) {
      if (typeof data === 'string') add(rel, Buffer.byteLength(data), data.split('\n').length - 1);
      else add(rel, data.length, newlines(data, data.length));
    }
    return data;
  };
  syncBuiltinESMExports();

  process.on('exit', () => {
    const row = {
      pid: process.pid,
      maxRssKb: process.resourceUsage().maxRSS,
      linesRead: c.linesRead,
      corpusBytesRead: c.corpusBytesRead,
      indexBytesRead: c.indexBytesRead,
      otherBytesRead: c.otherBytesRead,
      filesRead: c.filesRead.size,
      corpusFiles: c.corpusFiles.size,
    };
    try { fs.appendFileSync(out, `${JSON.stringify(row)}\n`); } catch { /* the run's own result is not ours to break */ }
  });
}
