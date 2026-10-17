// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/module-counter.mjs — a preload that counts the MODULES a process loads.
//
// **Why a counter and not a clock.** Starting `mem version` costs the compile
// of every module the start imports; that is what the lazy command groups
// (src/cli/command-index.mjs, cli-speed-cm TB4) took from 158 modules to 93.
// How long the compile takes depends on the machine; how many modules are
// loaded does not. The cost phase (bench/atlas/phase-cost.mjs) asks it of the
// CLI start: how many modules, and how many command groups.
//
// Use it as `node --import=<this file's URL>?out=<file> bin/mem ...`. The
// output file travels in the URL's query string for the reason
// bench/atlas/io-counter.mjs gives: a measuring tool does not add an
// environment variable.
//
// It registers a module hook (a loader thread) that appends the URL of every
// `file:` module the process loads to the output file, one per line. What it
// does NOT see (named, because a counter that claims more than it sees is an
// empty green): modules a CommonJS `require` loads (this tree is ESM), built-in
// modules (they cost no compile here), and any module of a child process that
// did not load the preload. The probe test starts a script with a known
// import and checks it is listed.
import fs from 'node:fs';
import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

let out = null;

/** The hook thread receives the output file here. */
export function initialize(data) {
  out = data?.out ?? null;
}

/** The hook: note the module, then let it load. */
export async function load(url, context, nextLoad) {
  if (out && url.startsWith('file:')) {
    try { fs.appendFileSync(out, `${url}\n`); } catch { /* the run's own result is not ours to break */ }
  }
  return nextLoad(url, context);
}

if (isMainThread) {
  const target = new URL(import.meta.url).searchParams.get('out');
  if (target) register(import.meta.url.split('?')[0], { data: { out: target } });
}

/** Read the module URLs a run listed; a missing file is `null` (the preload never ran), never an empty list. */
export function readModules(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return text.split('\n').filter(Boolean);
}

/** The command groups among the modules (`src/cli/commands/<group>.mjs`). */
export function groupsOf(urls) {
  return (urls ?? []).map((u) => /\/src\/cli\/commands\/([a-z]+)\.mjs$/.exec(u)?.[1]).filter(Boolean);
}
