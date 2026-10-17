// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/start-counter.mjs — a preload that counts node PROCESS STARTS.
//
// **Why a counter and not a clock.** What a hook, a timer tick or a CLI call
// costs is, to a first approximation, how many node processes it starts: each
// one pays the runtime start and the compile of the modules it imports, and a
// hook fires in the middle of somebody's work. How long that takes depends on
// who else is running; how many processes start does not. The cost phase
// (bench/atlas/phase-cost.mjs) and the digest phase lead with this number.
//
// Use it through NODE_OPTIONS (`--import=<this file's URL>?out=<file>`), so
// every node child of a shell script inherits it. The output file travels in
// the URL's query string for the reason bench/atlas/io-counter.mjs gives: a
// measuring tool does not add an environment variable.
//
// At START (not at exit: a process killed by a time cap is still a start) the
// process appends ONE JSON line to the output file:
//
//   { pid, ppid, script, args, tagged }
//
// - `script` is `process.argv[1]` reduced to its base name (empty for
//   `node -e`), `args` the next two arguments, each cut to 60 characters.
//   The path of a scratch root never travels into a record.
// - `tagged` is true when the environment variable named by the URL's `tag`
//   query parameter is set in the process (a child that a caller wants to label
//   rather than count, such as a detached rebuild); without a `tag` it is false.
//
// What it does NOT see (named, because a counter that claims more than it
// sees is an empty green): a node process started with its own NODE_OPTIONS
// (a script that replaces the variable), a process that is not node (a shell,
// `git`), and a node that was started with `--no-experimental-...` flags that
// refuse `--import` (none in this tree). The probe test starts a plain
// `node -e 0` and a bash script with two nodes and checks both are counted.
import fs from 'node:fs';
import path from 'node:path';

const OUT = new URL(import.meta.url).searchParams.get('out');
const TAG = new URL(import.meta.url).searchParams.get('tag');

if (OUT) {
  const cut = (s) => String(s ?? '').slice(0, 60);
  const row = {
    pid: process.pid,
    ppid: process.ppid,
    script: process.argv[1] ? cut(path.basename(process.argv[1])) : '',
    args: process.argv.slice(2, 4).map(cut),
    tagged: TAG ? Boolean(process.env[TAG]) : false,
  };
  try { fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`); } catch { /* the run's own result is not ours to break */ }
}

/** Read the lines a run of the counter left behind; a missing file is `null` (the preload never ran), never an empty list. */
export function readStarts(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line is not a start we can name */ }
  }
  return rows;
}
