// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Child process of test/net-derive-bounded-cm.test.mjs: one derive run over a store, against a
// chosen source tree (old or new).
//   node [--max-old-space-size=N] netderive-run-child.mjs <src-dir> <root>
// Reads every drawer into ONE array, as `mem net --derived` did before the rebuild, when the
// tree has no stream support; the new tree gets the repeatable stream.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [src, root, mode] = process.argv.slice(2);
// A bare `node --test` (the CI form, see test/packaging.test.mjs) also runs
// every .mjs under test/. Called without its arguments this file is not a
// probe but a stray target: stand down with success instead of crashing.
if (!src) process.exit(0);
const url = (f) => pathToFileURL(path.join(src, f)).href;
const memory = await import(url('memory.mjs'));
const nd = await import(url('netderive.mjs'));
const drawers = [];
for (const project of [null, ...memory.listProjects(root)]) for (const type of Object.keys(memory.TYPES)) drawers.push({ project, type });
let rows;
if (mode === 'stream') {
  rows = {
    *[Symbol.iterator]() {
      for (const d of drawers) for (const e of memory.iterLog(root, d.type, { project: d.project })) if (!e.__broken) yield { project: d.project ?? 'global', drawer: d.type, entry: e, held: true };
    },
  };
} else {
  rows = [];
  for (const d of drawers) for (const e of memory.iterLog(root, d.type, { project: d.project })) if (!e.__broken) rows.push({ project: d.project ?? 'global', drawer: d.type, entry: e, held: true });
}
const d = nd.derive(rows);
console.log(JSON.stringify({ entries: d.entries, auto: d.auto.length, borderlineTotal: d.borderlineTotal, dropped: d.dropped, linked: d.linked, rssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
