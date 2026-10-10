#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bench/timetrack-measure.mjs - how long a time-window question takes, and how
 * many bytes it reads (port of lucky-mem's `bench/zeitspur-messung.mjs`).
 *
 * The question: `timesearch.entriesInWindow` for a one-day window (the time
 * lane of `mem find` / `mem when` / the recall hook). Before the time track
 * (src/timetrack.mjs) it read every line of every drawer twice.
 *
 *   node bench/timetrack-measure.mjs build  <root> <count>      synthetic memory (bench/heaps-corpus.mjs)
 *   node bench/timetrack-measure.mjs measure <root> [--code <dir>] [--runs N] [--day YYYY-MM-DD] [--no-track]
 *
 * `--code <dir>` measures the code tree in <dir> (a checkout or an export of an
 * older commit: it needs `<dir>/src/timesearch.mjs`), so the old stand is
 * measurable with the same script. With the current code, the first
 * measurement builds the track once (reported) unless `--no-track`.
 *
 * Reported: median and range of the wall clock over N runs, the hit count, the
 * bytes the process read from the drawers (an `fs.readSync` spy: the same
 * number for old and new code), and how the track answered. Always run it on a
 * SCRATCH root (never the real memory): `mkdtemp`, then delete your own tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-track') args.noTrack = true;
    else if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i += 1; } else args._.push(a);
  }
  return args;
}

async function measure(root, args) {
  const code = path.resolve(args.code ?? REPO);
  const lib = (name) => import(pathToFileURL(path.join(code, 'src', name)).href);
  const timesearch = await lib('timesearch.mjs');
  const capability = await lib('capability.mjs');
  const memory = await lib('memory.mjs');
  const day = args.day ?? '2026-01-10';
  const from = new Date(`${day}T00:00:00Z`);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  const runs = Number(args.runs ?? 5);
  const cap = capability.grantAll('timetrack-measure');

  let buildMs = null;
  if (!args.noTrack && typeof memory.buildTimeTracks === 'function') {
    const t0 = performance.now();
    memory.buildTimeTracks(root);
    buildMs = Math.round(performance.now() - t0);
  }

  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = function spy(...a) { const n = original.apply(this, a); if (typeof n === 'number') bytes += n; return n; };
  const times = []; let hits = 0; let report = null; let bytesPerRun = 0;
  try {
    for (let i = 0; i < runs; i += 1) {
      bytes = 0;
      report = {};
      const t0 = performance.now();
      hits = timesearch.entriesInWindow(root, cap, { from, to, ...(args.noTrack ? { track: false } : {}), report }).length;
      times.push(Math.round(performance.now() - t0));
      bytesPerRun = bytes;
    }
  } finally { fs.readSync = original; }
  times.sort((a, b) => a - b);
  let total = 0;
  for (const f of ['global', 'projects']) {
    const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else if (e.name.endsWith('.jsonl')) total += fs.statSync(q).size; } };
    walk(path.join(root, f));
  }
  console.log(JSON.stringify({
    code, window: `${from.toISOString()} .. ${to.toISOString()}`, hits,
    medianMs: times[Math.floor(times.length / 2)], rangeMs: [times[0], times[times.length - 1]],
    bytesRead: bytesPerRun, drawerBytes: total, readFraction: Number((bytesPerRun / total).toFixed(3)),
    trackBuildMs: buildMs, way: report?.way ?? null, reason: report?.reason ?? null,
    blocksRead: report?.blocksRead ?? null, blocksSkipped: report?.blocksSkipped ?? null,
  }, null, 1));
}

async function main() {
  const args = parse(process.argv.slice(2));
  const [cmd, root, count] = args._;
  if (cmd === 'build' && root && count) {
    const r = spawnSync(process.execPath, [path.join(HERE, 'heaps-corpus.mjs'), 'build', root, count, '--budget', count], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (cmd === 'measure' && root) { await measure(path.resolve(root), args); return; }
  console.error('usage: timetrack-measure.mjs build <root> <count> | measure <root> [--code <dir>] [--runs N] [--day YYYY-MM-DD] [--no-track]');
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
