// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/fixture/atlas-net-cm.mjs — memories for the uncapped atlas (main
// nodes, subtopics, loops, derived links); port of the sibling house's
// vernetz-hauptknoten fixture, 2026-10-01.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * topics x members entries (tag `topic-NNN`, with `sub` also `sub-NNN-k`),
 * `bundles` relation bundles (a hub and two neighbours pointing at it),
 * `ring`: 'ring' A->B->C->A or 'chain' A->B->C (stored `causes` links),
 * `derived`: one pair sharing rare terms and a file (needs ~500 entries for
 * a strong file IDF). Returns `{ root, ids }`.
 */
export async function netWorld(REPO, { topics = 0, members = 3, sub = 0, bundles = 0, ring = null, derived = false } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-atlas-net-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'atlas', participants: { alex: { human: true } }, language: 'en' }));
  const memory = await import(pathToFileURL(path.join(REPO, 'src/memory.mjs')).href);
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  let n = 0;
  // Projects are created on purpose since project-new (logEntry refuses unknown ones).
  for (const p of ['workshop', 'garden']) memory.projectInit(r, p);
  const log = (d, type = 'learning') => memory.logEntry(r, type, d, { project: type === 'link' ? null : ['workshop', 'garden'][n % 2], now: new Date(t0 + (n++) * 60e3) }).entry;
  const ids = { ring: [], derived: [] };
  for (let t = 0; t < topics; t++) {
    for (let m = 0; m < members; m++) {
      const tags = [`topic-${String(t).padStart(3, '0')}`, ...(sub ? [`sub-${String(t).padStart(3, '0')}-${m % sub}`] : [])];
      log({ title: `Topic ${t} note ${m}`, text: `Content ${t}/${m}`, tags });
    }
  }
  for (let b = 0; b < bundles; b++) {
    const hub = log({ title: `Hub ${b}`, text: `Hub ${b}`, tags: ['relation'] });
    for (let k = 0; k < 2; k++) log({ title: `Neighbour ${b}/${k}`, text: 'x', tags: ['relation'], origin: { derived_from: [hub.id] } });
  }
  if (ring) {
    for (const x of ['A', 'B', 'C']) ids.ring.push(log({ title: `Ring ${x}`, text: `Ring ${x}`, tags: ['ring'] }).id);
    const link = (from, to) => log({ from, to, kind: 'causes', why: 'probe' }, 'link');
    link(ids.ring[0], ids.ring[1]);
    link(ids.ring[1], ids.ring[2]);
    if (ring === 'ring') link(ids.ring[2], ids.ring[0]);
  }
  if (derived) {
    ids.derived.push(log({ title: 'Zebrafish quorum handshake fails', text: 'The barnacle lease is lost in src/quorum.mjs', tags: ['topic-000'] }, 'error').id);
    ids.derived.push(log({ title: 'Zebrafish quorum handshake retry', text: 'Renew the barnacle lease, src/quorum.mjs', tags: ['topic-001'] }).id);
  }
  return { root: r, ids };
}
