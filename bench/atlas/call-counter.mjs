// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/call-counter.mjs — a preload that counts HOW OFTEN a process
// touches the file system, which files of the memory it opens, and how many
// worker threads it starts.
//
// **Why a counter and not a clock.** A call that stats a file per mention, or
// opens the same log three times, gets slow on a loaded machine and on a big
// memory, and both slow-downs hide behind the noise of a stopwatch. The number
// of calls does not move with the load. The cost phase
// (bench/atlas/phase-cost.mjs) asks it of the doctor (stat-class calls, and the
// writer threads of the concurrent-append probe, which `--full` starts and the
// default does not) and of `mem retrieve` (opens per log file, the
// read-the-log-twice rule).
//
// Use it as `node --import=<this file's URL>?root=<root>&out=<file> ...`. The
// root and the output file travel in the URL's query string for the reason
// bench/atlas/io-counter.mjs gives: a measuring tool does not add an
// environment variable.
//
// At exit the process appends ONE JSON line to the output file:
//
//   { pid, calls: { existsSync, statSync, lstatSync, accessSync, readdirSync,
//                   realpathSync, openSync }, workers: n,
//     opens: { "<path under root>": n } }
//
// - `calls` counts the calls of the named functions with any path. A
//   `readFileSync` or `createReadStream` of a path counts as ONE `openSync`
//   (the open it makes inside is not counted twice).
// - `workers` is the number of `new Worker(...)` calls (worker threads are not
//   processes: bench/atlas/start-counter.mjs does not see them).
// - `opens` is the number of opens per file UNDER THE ROOT, keyed by the path
//   relative to the root with `/` (only files below `global/` or `projects/`,
//   the entry logs; nothing else is named, so no other path travels into a
//   record).
//
// What it does NOT see (named, because a counter that claims more than it
// sees is an empty green): the module loader's own reads (the code of the
// tool is not counted as file access), calls through `fs.promises`, calls made
// through a function reference taken before the preload ran, and anything a
// child process does that did not load the preload (NODE_OPTIONS carries it to
// node children of a shell script). The probe test plants a known file and
// checks every counted path.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import * as workerThreads from 'node:worker_threads';

const params = new URL(import.meta.url).searchParams;
const ROOT = params.get('root');
const OUT = params.get('out');

const NAMES = ['existsSync', 'statSync', 'lstatSync', 'accessSync', 'readdirSync', 'realpathSync', 'openSync'];

if (OUT) install(ROOT, OUT);

function install(root, out) {
  const roots = [];
  if (root) {
    roots.push(path.resolve(root));
    try { roots.push(fs.realpathSync(root)); } catch { /* may not exist yet */ }
  }
  const underRoot = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return null;
    let abs;
    try { abs = path.resolve(Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : p); } catch { return null; }
    for (const r of roots) {
      const rel = path.relative(r, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    }
    return null;
  };
  const counts = Object.fromEntries(NAMES.map((n) => [n, 0]));
  const opens = new Map();
  const book = (p) => {
    const rel = underRoot(p);
    if (rel && (rel.startsWith('global/') || rel.startsWith('projects/'))) opens.set(rel, (opens.get(rel) ?? 0) + 1);
  };
  // `readFileSync(path)` opens through `fs.openSync` (module object), so a naive pair of wrappers counts one read twice.
  let inside = 0;
  for (const name of NAMES) {
    const original = fs[name];
    const counted = function counted(...args) {
      if (inside === 0) {
        counts[name] += 1;
        if (name === 'openSync') book(args[0]);
      }
      return original.apply(this, args);
    };
    // `fs.realpathSync.native` and friends travel with the function: code that asks for them must still find them.
    fs[name] = Object.assign(counted, original);
  }
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function countedRead(p, ...rest) {
    if (typeof p !== 'number') { counts.openSync += 1; book(p); }
    inside += 1;
    try { return readFileSync.call(this, p, ...rest); } finally { inside -= 1; }
  };
  const createReadStream = fs.createReadStream;
  fs.createReadStream = function countedStream(p, ...rest) {
    counts.openSync += 1;
    book(p);
    inside += 1;
    try { return createReadStream.call(this, p, ...rest); } finally { inside -= 1; }
  };
  let workers = 0;
  const { Worker } = workerThreads;
  class CountedWorker extends Worker {
    constructor(...args) { super(...args); workers += 1; }
  }
  try { workerThreads.default.Worker = CountedWorker; } catch { /* a frozen export: workers stay uncounted, and the probe test says so */ }
  syncBuiltinESMExports();
  process.on('exit', () => {
    const row = {
      pid: process.pid, calls: counts, workers, opens: Object.fromEntries(opens),
    };
    // `inside` is back at 0 here; the append goes through the original function and is not counted
    try { fs.appendFileSync(out, `${JSON.stringify(row)}\n`); } catch { /* the run's own result is not ours to break */ }
  });
}

/** Read the lines a run left behind; a missing file is `null` (the preload never ran), never an empty list. */
export function readRows(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line is not a row */ }
  }
  return rows;
}

/** Add the rows of every process of a run: the call counts and the opens per file. */
export function total(rows) {
  const calls = Object.fromEntries(NAMES.map((n) => [n, 0]));
  const opens = {};
  for (const r of rows ?? []) {
    for (const n of NAMES) calls[n] += r.calls?.[n] ?? 0;
    for (const [f, k] of Object.entries(r.opens ?? {})) opens[f] = (opens[f] ?? 0) + k;
  }
  let workers = 0;
  for (const r of rows ?? []) workers += r.workers ?? 0;
  return { calls, opens, workers, rows: (rows ?? []).length };
}
