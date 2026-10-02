// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard-head.mjs — the FIRST answer of `/dashboard.json`: small,
// independent of the store size, and kept on disk for the next cold start
// (task board-tempo-cm, 2026-10-02; the sibling's `src/dashboard-kopf.mjs`).
//
// **The finding (measured, bench/board-tempo.mjs, old state).** The first
// answer carried EVERY entry (`entries`) and arrived only after one whole
// `collectDashboard()`: 3.6 s at 10k entries, 35 s and 43 MB (5 MB packed)
// at 100k, and a server that never answered at 1M. After every server
// start the in-memory cache was empty, so the first page always waited for
// the whole build — and the browser parsed and prepared all of it.
//
// **What happens here.**
//   1. `headEntries()`: the first answer carries only the newest
//      `HEAD_ENTRIES` entries (plus the open duties/questions the start page
//      names) and a precomputed `overview` (counters per type and project).
//      The rest comes page by page through
//      `/dashboard/part.json?part=entries&from=<n>&n=<m>` (`page()`), from
//      THE SAME stored build — one truth, only portioned. Where the whole
//      store fits into the head (small stores, probes) the answer stays as
//      complete as before and there is no `entries` part.
//   2. `writeHead()` / `readHead()`: after every build the head lies on
//      disk (`.mem/dashboard-head.json`, 0600, atomic). A cold start answers
//      IMMEDIATELY with it — expressly as not fresh, with its build time —
//      and rebuilds in the background (stale-while-revalidate, see
//      dashboard-cache.mjs).
//   3. `lightHead()`: the quick first state of a store the full build still
//      handles but needs a while for (placeholder, then this head, then the
//      full build). ONE pass over the drawers, memory bounded to the newest
//      `HEAD_ENTRIES`: counters per type/project and the newest titles —
//      nothing else, and the answer says so as a reason (`state:'warning'`).
//      Above `FULL_BUILD_UP_TO_BYTES` (and when the full build fails at its
//      heap cap) the COMPACT build takes over instead
//      (src/dashboard-compact.mjs, task atlas-pass-cm): the same single pass
//      kept to counters plus the net, questions, agents and the condensed atlas.
//
// **What does NOT go to disk.** The entries in the head lose their free
// texts (`text`, `fact`, `why`) there: the dashboard decrypts locked
// entries in memory (decision 1fw996e7zo5c), and decrypted content never
// reaches the disk. Title and tags are clear even for locked entries.
//
// invariant: three-states-never-two

import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomicwrite.mjs';
import * as memory from './memory.mjs';
import { headline } from './viewer.mjs';

/** The newest entries the first answer carries; plus at most `HEAD_OPEN` open ones. */
export const HEAD_ENTRIES = 120;
const HEAD_OPEN = 150;

/** At most this many entries per page of the `entries` part. */
export const PAGE_MAX = 5000;

/** Version of the head on disk: another layout is not read. */
const HEAD_VERSION = 1;

/**
 * Above this size of the drawers (bytes) the full build is not even tried,
 * the compact build runs instead. Measured (bench/board-tempo.mjs, synthetic stores of
 * bench/scale.mjs, one build worker): 100,000 entries = 26 MB of drawers: 26 s
 * and 1.1 GB peak; 250,000 entries = 66 MB: 99 s and 2.9 GB peak; the old
 * state needed 494 s and 8.1 GB at 1M entries (263 MB). The worker's cap is
 * 4 GB (`WORKER_HEAP_MB`), so 64 MB keeps the full build inside it with room.
 */
export const FULL_BUILD_UP_TO_BYTES = 64 * 1024 * 1024;

/** Free text fields of an entry — they never go to disk (see above). */
const FREE_TEXT = ['text', 'fact', 'why'];

/** Newest first; without a time at the end, then by id (stable). */
const newestFirst = (a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')) || String(a.id).localeCompare(String(b.id));

const fresh = () => ({ count: 0, readable: 0, perType: {} });

/** Counters for the start page: total, readable, per type — whole and per project. */
export function overview(entries) {
  const all = { ...fresh(), perProject: {} };
  for (const e of entries) {
    const p = e.project || 'global';
    const tp = (all.perProject[p] ??= fresh());
    for (const z of [all, tp]) {
      z.count += 1;
      if (e.readable) z.readable += 1;
      z.perType[e.type] = (z.perType[e.type] ?? 0) + 1;
    }
  }
  return all;
}

/**
 * The entries of the first answer.
 *
 * @param entries the full list from `collectDashboard()`
 * @param open ids the start page always needs (open duties/questions)
 * @returns `{ sorted, entries, overview, part }` — `part` is null when
 *   everything fits into the head; `sorted` is the full list, newest first
 *   (for `page()`, computed once per build).
 */
export function headEntries(entries, { open = new Set(), max = HEAD_ENTRIES, maxOpen = HEAD_OPEN, route, overview: given = null } = {}) {
  const sorted = [...entries].sort(newestFirst);
  // A compact build brings its own counters (`given`): its list is only the
  // newest window of the store, so the counters cannot come from it.
  const ov = given ?? overview(sorted);
  const total = given ? given.count : sorted.length;
  if (sorted.length <= max && total <= sorted.length) return { sorted, entries: sorted, overview: ov, part: null };
  const chosen = sorted.slice(0, max);
  const inside = new Set(chosen.map((e) => e.id));
  // The open duties/questions the start page names under "next look" —
  // capped, so even a mountain of open work does not let the head grow
  // with the store.
  let extra = 0;
  for (const e of sorted) {
    if (extra >= maxOpen) break;
    if (open.has(e.id) && !inside.has(e.id)) { chosen.push(e); inside.add(e.id); extra += 1; }
  }
  return {
    sorted, entries: chosen, overview: ov,
    part: {
      path: route, count: total, in_head: chosen.length, page: PAGE_MAX,
      // The list is a window of the newest entries, not the whole store.
      ...(total > sorted.length ? { window: sorted.length } : {}),
    },
  };
}

/**
 * One page of the `entries` part (offset `from`, at most `n`). `total` is the
 * count of the whole store when `sorted` is only its newest window (the
 * compact build); the answer then says `window`.
 */
export function page(sorted, from, n, { total = sorted.length } = {}) {
  const start = Math.max(0, Math.floor(Number(from) || 0));
  const count = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(n) || PAGE_MAX)));
  const data = sorted.slice(start, start + count);
  return {
    data, from: start, n: data.length, total, next: start + data.length < sorted.length ? start + data.length : null,
    ...(total > sorted.length ? { window: sorted.length } : {}),
  };
}

/** Where the head lies on disk (machine-local, derived, not in git). */
export function headPath(root) {
  return path.join(root, '.mem', 'dashboard-head.json');
}

/**
 * Lay the head down. `head` is the first answer WITHOUT live fields; the
 * free texts of the entries and the deferred lists fall away here.
 */
export function writeHead(root, head, { stamp, builtMs, durationMs }) {
  const bare = (head.entries || []).map((e) => {
    const k = { ...e };
    for (const f of FREE_TEXT) delete k[f];
    return k;
  });
  const data = { ...head, entries: bare };
  delete data.cache;
  const content = JSON.stringify({ version: HEAD_VERSION, stamp, builtMs, durationMs, data });
  writeAtomic(headPath(root), content, { mode: 0o600 });
}

/** Read the stored head; `null` when there is none or it does not fit. */
export function readHead(root) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(headPath(root), 'utf8')); } catch { return null; }
  if (raw?.version !== HEAD_VERSION || !raw.data || typeof raw.stamp !== 'string' || !Number.isFinite(raw.builtMs)) return null;
  return { data: raw.data, stamp: raw.stamp, builtMs: raw.builtMs, durationMs: Number(raw.durationMs) || 0 };
}

/**
 * The head without the full build (header, point 3). Reads the drawers raw
 * (nothing is decrypted — the result goes to disk) in ONE pass; memory only
 * keeps the counters and at most 2·`max` entries.
 */
export function lightHead(root, { title = 'cheap-mem', writesAllowed = false, max = HEAD_ENTRIES, reason, types = [], route } = {}) {
  const reasons = [reason || 'Only counters and newest entries (the full build did not run).'];
  const ov = { ...fresh(), perProject: {} };
  let newest = [];
  let broken = 0;
  const trim = () => { newest.sort(newestFirst); newest = newest.slice(0, max); };
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let it;
      try { it = memory.iterLog(root, type, { project }); } catch (e) { reasons.push(`${project ?? 'global'}/${type} not readable: ${e?.message || e}`); continue; }
      const p = project ?? 'global';
      for (const e of it) {
        if (e.__broken) { broken += 1; continue; }
        if (!e.id || memory.isClosingLine(e)) continue;
        const tp = (ov.perProject[p] ??= fresh());
        for (const z of [ov, tp]) { z.count += 1; z.readable += 1; z.perType[type] = (z.perType[type] ?? 0) + 1; }
        newest.push({
          id: e.id, type, title: headline(e).slice(0, 240), project: p,
          tags: Array.isArray(e.tags) ? e.tags.slice(0, 12) : [], ts: e.ts ?? null, agent: e.agent ?? null,
          // Whether superseded is known to the full build only (tombstones over the whole drawer).
          state: 'unknown', readable: true,
        });
        if (newest.length >= 2 * max) trim();
      }
    }
  }
  trim();
  if (broken) reasons.push(`${broken} lines not readable`);
  const notBuilt = { readable: false, reason: reasons[0], error: reasons[0] };
  return {
    state: 'warning', light: true, reasons, at: new Date().toISOString(),
    meta: { title, writesAllowed, git: {}, inventory: null, entriesTotal: null },
    types, entries: newest, overview: ov,
    inbox: notBuilt, raw: notBuilt,
    parts: { entries: { path: route, count: ov.count, in_head: newest.length, page: PAGE_MAX, head_only: true } },
  };
}
